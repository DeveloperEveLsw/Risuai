<script lang="ts">
  import {
    RuntimeUIState,
    entityRuntimeEnabled,
    browserRuntime,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import isEqual from "lodash/isEqual";
  import { onDestroy, tick } from "svelte";
  import { DisplayRenderCache } from "src/ts/runtime/displayRenderCache";
  import { DisplayPreparationQueue } from "src/ts/runtime/displayPreparationQueue";
  import { language } from "src/lang";
  import { StableDisplayDom } from "src/ts/runtime/stableDisplayDom";
  import { DBState } from "src/ts/stores.svelte";
  import { sleep } from "src/ts/util";
  import { alertError } from "../../ts/alert";
  import {
    addMetadataToElement,
    getDistance,
    ParseMarkdown as parseMarkdownBase,
    postTranslationParse,
    trimMarkdown,
    type CbsConditions,
    type simpleCharacterArgument,
    type MarkdownPresentation,
  } from "../../ts/parser/parser.svelte";
  import { getLLMCache, translateHTML } from "../../ts/translator/translator";
  import { getModuleAssets } from "src/ts/process/modules";
  import { getCurrentCharacter } from "src/ts/storage/database.svelte";
  import { getFileSrc } from "src/ts/globalApi.svelte";

  interface Props {
    character?: simpleCharacterArgument | string | null;
    firstMessage?: boolean;
    messageId?: string;
    bookmarkSession?: string;
    idx?: number;
    msgDisplay?: string;
    sourcePresentation?: MarkdownPresentation;
    name?: string;
    role: string | null;
    translated: boolean;
    translating: boolean;
    retranslate: boolean;
    renderRevision?: number;
    displayRevision?: string;
    bodyRoot?: HTMLElement | null;
    modelShortName: string;
    renderRawStreaming?: boolean;
    rawStreamingText?: string;
  }

  let {
    character = null,
    idx = 0,
    firstMessage = false,
    messageId,
    bookmarkSession,
    msgDisplay,
    sourcePresentation,
    role,
    translated = $bindable(false),
    translating = $bindable(false),
    retranslate = $bindable(false),
    renderRevision = 0,
    displayRevision = "",
    bodyRoot,
    modelShortName = "",
    renderRawStreaming = false,
    rawStreamingText = "",
  }: Props = $props();

  // svelte-ignore non_reactive_update
  let lastParsed = "";
  let lastCharArg: string | simpleCharacterArgument = null;
  let lastChatId = -10;
  let lastRenderedRevision: number | null = null;
  let parsingEpoch = 0;
  let displayHtml = $state("");
  // An empty successful script result is distinct from an unfinished first body.
  // Keep this Svelte-owned status outside StableDisplayDom's sibling range.
  let firstDisplayComplete = $state(false);
  let firstDisplayFailed = $state(false);
  let streamingHandoffText = $state<string | undefined>();
  const renderCache = entityRuntimeEnabled
    ? new DisplayRenderCache()
    : undefined;
  const preparations = entityRuntimeEnabled
    ? new DisplayPreparationQueue()
    : undefined;
  let disposed = false;
  onDestroy(() => {
    disposed = true;
    preparations?.close();
    renderCache?.close();
  });
  let presentationDom = $state.raw<StableDisplayDom | undefined>();
  $effect(() => {
    if (!entityRuntimeEnabled || !bodyRoot) return;
    const owner = new StableDisplayDom(bodyRoot);
    presentationDom = owner;
    return () => {
      owner.close();
      if (presentationDom === owner) presentationDom = undefined;
    };
  });
  $effect(() => {
    presentationDom?.update(showRawStreaming ? "" : displayHtml);
  });
  type ParsedBody = {
    html: string;
    finalize?: MarkdownPresentation["finalize"];
  };

  function getCbsCondition() {
    try {
      const cbsConditions: CbsConditions = {
        firstmsg: firstMessage ?? false,
        messageId,
        bookmarkSession,
        chatRole: role,
      };
      return cbsConditions;
    } catch (e) {
      return {
        firstmsg: firstMessage ?? false,
        messageId,
        chatRole: null,
      };
    }
  }

  let shouldRenderRawStreaming = $derived(
    renderRawStreaming && !translated && !retranslate,
  );
  // The canonical job can finish before final Markdown/assets are prepared.
  // Keep this owner's last streamed text until a current finalizer succeeds.
  $effect.pre(() => {
    if (entityRuntimeEnabled && shouldRenderRawStreaming)
      streamingHandoffText = rawStreamingText;
  });
  let showRawStreaming = $derived(
    shouldRenderRawStreaming ||
      (entityRuntimeEnabled && streamingHandoffText !== undefined),
  );

  const markParsing = async (
    data: string,
    charArg: string | simpleCharacterArgument,
    chatID: number,
    requestedRevision: number,
    tries = 0,
    epoch = parsingEpoch,
  ): Promise<ParsedBody | undefined> => {
    const viewGeneration = RuntimeUIState.historyViewGeneration;
    const previewToken = bookmarkSession;
    const previewId = messageId;
    const previewRevision = sourcePresentation?.capture?.message?.revision;
    const presentation: MarkdownPresentation = {
      capture: sourcePresentation?.capture,
      renderCache,
      current: () =>
        !disposed &&
        epoch === parsingEpoch &&
        viewGeneration === RuntimeUIState.historyViewGeneration &&
        (!previewToken ||
          browserRuntime().bookmarkPreviewCurrent(
            previewToken,
            previewId,
            previewRevision,
          )),
    };
    const ParseMarkdown = (...args: Parameters<typeof parseMarkdownBase>) =>
      parseMarkdownBase(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        entityRuntimeEnabled ? presentation : args[5],
      );
    const prepared = (html: string): ParsedBody => ({
      html,
      finalize: presentation.finalize,
    });
    // track 'translated' and 'retranslate' state
    translated;
    retranslate;
    const preservePendingContent =
      lastRenderedRevision !== null &&
      requestedRevision !== lastRenderedRevision;
    let lastParsedQueue = "";
    let mode = "notrim" as const;
    let releasePreparation: (() => void) | undefined;
    try {
      // Capture and track reactive inputs above before waiting. Keep only the
      // latest successor for this row when original Lua is still executing.
      // Retries belong to the same running preparation and cannot reacquire it.
      if (preparations && tries === 0) {
        releasePreparation = await preparations.enter();
        if (!releasePreparation || !presentation.current()) return;
      }
      if (!isEqual(lastCharArg, charArg) || chatID !== lastChatId) {
        lastParsedQueue = "";
        lastCharArg = charArg;
        lastChatId = chatID;
        let translateText = false;
        try {
          if (DBState.db.autoTranslate) {
            if (
              DBState.db.autoTranslateCachedOnly &&
              DBState.db.translatorType === "llm"
            ) {
              const cache = DBState.db.translateBeforeHTMLFormatting
                ? await getLLMCache(data)
                : !DBState.db.legacyTranslation
                  ? await getLLMCache(
                      await ParseMarkdown(
                        data,
                        charArg,
                        "pretranslate",
                        chatID,
                        getCbsCondition(),
                      ),
                    )
                  : await getLLMCache(
                      await ParseMarkdown(
                        data,
                        charArg,
                        mode,
                        chatID,
                        getCbsCondition(),
                      ),
                    );

              translateText = cache !== null;
            } else {
              translateText = true;
            }
          }

          const lastTranslated = translated;

          setTimeout(() => {
            translated = translateText;
          }, 10);

          // State change of `translated` triggers markParsing again,
          // causing redundant translation attempts
          if (lastTranslated !== translateText) {
            return;
          }
        } catch (error) {
          console.error(error);
        }
      }
      if (retranslate || translated) {
        if (DBState.db.showTranslationLoading && !preservePendingContent) {
          lastParsed = `<div style="display:flex;justify-content:center;align-items:center;height:48px;"><div style="animation: spin 1s linear infinite; border-radius: 50%; height: 32px; width: 32px; border: 2px solid #3b82f6; border-top: 2px solid transparent;"></div></div><style>@keyframes spin { to { transform: rotate(360deg); } }</style>`;
        }

        let transResult;

        if (
          DBState.db.translatorType === "llm" &&
          DBState.db.translateBeforeHTMLFormatting
        ) {
          await sleep(100);
          translating = true;
          data = await translateHTML(data, false, charArg, chatID, retranslate);
          translating = false;
          const marked = await ParseMarkdown(
            data,
            charArg,
            mode,
            chatID,
            getCbsCondition(),
          );
          lastParsedQueue = marked;
          lastCharArg = charArg;
          transResult = marked;
        } else if (!DBState.db.legacyTranslation) {
          const marked = await ParseMarkdown(
            data,
            charArg,
            "pretranslate",
            chatID,
            getCbsCondition(),
          );
          translating = true;
          const translated = await postTranslationParse(
            await translateHTML(marked, false, charArg, chatID, retranslate),
          );
          translating = false;
          lastParsedQueue = translated;
          lastCharArg = charArg;
          transResult = translated;
        } else {
          const marked = await ParseMarkdown(
            data,
            charArg,
            mode,
            chatID,
            getCbsCondition(),
          );
          translating = true;
          const translated = await translateHTML(
            marked,
            false,
            charArg,
            chatID,
            retranslate,
          );
          translating = false;
          lastParsedQueue = translated;
          lastCharArg = charArg;
          transResult = translated;
        }

        setTimeout(() => {
          retranslate = false;
        }, 10);

        return prepared(transResult);
      } else {
        const marked = await ParseMarkdown(
          data,
          charArg,
          mode,
          chatID,
          getCbsCondition(),
        );
        lastParsedQueue = marked;
        lastCharArg = charArg;
        return prepared(marked);
      }
    } catch (error) {
      if (entityRuntimeEnabled && !presentation.current()) return;
      //retry
      if (tries > 2) {
        // A native entity owner must not publish unprocessed source after a
        // failed display script. Keep the existing body or first-body failure
        // status; the ordinary browser path retains its original fallback.
        if (entityRuntimeEnabled) throw error;
        alertError(
          `Error while parsing chat message: ${translated}, ${error.message}, ${error.stack}`,
        );
        return prepared(data);
      }
      const retried = await markParsing(
        data,
        charArg,
        chatID,
        requestedRevision,
        tries + 1,
        epoch,
      );
      if (retried !== undefined) {
        lastParsedQueue = retried.html;
      }
      return retried;
    } finally {
      releasePreparation?.();
      // The entity presentation finalizer may reuse pure formatting, while
      // retaining fresh CSS CBS and persistent-effect admission for this owner.
      if (epoch === parsingEpoch) {
        lastParsed = lastParsedQueue;
        lastRenderedRevision = requestedRevision;
      }
    }
  };

  const checkImg = () => {
    if (!DBState.db.newImageHandlingBeta || !bodyRoot) {
      return;
    }
    const imgs = bodyRoot.querySelectorAll(
      'img:not([src^="data:"]):not([src^="http:"]):not([src^="https:"]):not([src^="blob:"]):not([src^="file:"]):not([src^="tauri:"]):not([src^="/api/runtime/assets/"]):not([noimage])',
    ) as NodeListOf<HTMLImageElement>;

    if (imgs.length > 0) {
      const currentCharacter = getCurrentCharacter();
      const styl = currentCharacter.prebuiltAssetStyle;
      const assets = getModuleAssets().concat(
        currentCharacter.additionalAssets ?? [],
      );
      const normalizedAssets = assets.map((asset) => {
        return {
          name: asset[0].toLocaleLowerCase(),
          path: asset[1],
        };
      });
      const exactAssets = new Map(
        normalizedAssets.map((asset) => [asset.name, asset.path]),
      );

      imgs.forEach(async (img) => {
        const name = img.getAttribute("src")?.toLocaleLowerCase() || "";
        const root = bodyRoot,
          epoch = parsingEpoch;
        const current = () =>
          !disposed &&
          bodyRoot === root &&
          parsingEpoch === epoch &&
          img.isConnected &&
          root.contains(img) &&
          (img.getAttribute("src")?.toLocaleLowerCase() || "") === name;
        console.log(name);

        if (name.length > 200 || name.includes(":")) {
          img.setAttribute("noimage", "true");
          return;
        }

        const foundAsset = exactAssets.get(name);
        console.log("Checking image:", name, "Assets:", assets);
        if (foundAsset) {
          const got = await getFileSrc(foundAsset);
          if (!current()) return;
          img.classList.add("root-loaded-image");
          img.classList.add("root-loaded-image-" + styl);
          img.src = got;
          return;
        }

        if (name.length < 3) {
          img.setAttribute("noimage", "true");
          return;
        }
        const prefixLoc = name.lastIndexOf(".");
        const prefix = prefixLoc > 0 ? name.substring(0, prefixLoc) : "";
        let currentDistance = 1000;
        let currentFound = "";
        for (const asset of normalizedAssets) {
          if (!asset.name.startsWith(prefix)) {
            continue;
          }
          const distance = getDistance(name, asset.name);
          if (distance < currentDistance) {
            currentDistance = distance;
            currentFound = asset.path;
          }
        }
        if (currentFound) {
          const got = await getFileSrc(currentFound);
          if (!current()) return;
          const name2 = img.getAttribute("src")?.toLocaleLowerCase() || "";
          if (name === name2) {
            img.setAttribute("src", got);
          }

          if (img.classList.length === 0) {
            img.classList.add("root-loaded-image");
            img.classList.add("root-loaded-image-" + styl);
          }
          img.removeAttribute("noimage");
        } else {
          img.setAttribute("noimage", "true");
        }
      });
    }
  };

  let markParsingResult = $derived.by(() => {
    displayRevision;
    // Chat's first CBS owner already follows these revisions. Tracking them
    // again here can start work before the new token arrives, then repeat it.
    if (entityRuntimeEnabled && !sourcePresentation) {
      RuntimeUIState.displayRevision;
      RuntimeUIState.scopeReady;
    }
    return markParsing(
      msgDisplay,
      character,
      idx,
      renderRevision,
      0,
      ++parsingEpoch,
    );
  });

  $effect(() => {
    if (shouldRenderRawStreaming) {
      return;
    }
    const parsing = markParsingResult;
    const shortName = modelShortName;
    let cancelled = false;
    firstDisplayFailed = false;
    checkImg();
    void parsing
      .then(async (md) => {
        if (cancelled || md === undefined) return;
        const html = md.finalize
          ? await md.finalize(md.html, () => !cancelled)
          : trimMarkdown(md.html);
        if (cancelled || html === undefined) return;
        displayHtml = addMetadataToElement(html, shortName);
        firstDisplayComplete = true;
        streamingHandoffText = undefined;
        await tick();
        if (!cancelled) checkImg();
      })
      .catch((error) => {
        if (!cancelled && !firstDisplayComplete) firstDisplayFailed = true;
        alertError(error);
      });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if entityRuntimeEnabled && !showRawStreaming && !firstDisplayComplete}
  <span
    data-display-preparation={firstDisplayFailed ? "failed" : "pending"}
    role="status"
    aria-live="polite"
    aria-busy={!firstDisplayFailed}
    class="text-textcolor2 text-sm"
    >{firstDisplayFailed
      ? language.messageDisplayFailed
      : language.preparingMessageDisplay}</span
  >
{/if}

{#if showRawStreaming}
  <span class="whitespace-pre-wrap"
    >{shouldRenderRawStreaming ? rawStreamingText : streamingHandoffText}</span
  >
{:else if !entityRuntimeEnabled}
  {@html displayHtml}
{/if}
