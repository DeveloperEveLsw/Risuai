<script lang="ts">
  import { onDestroy } from "svelte";
  import { language } from "src/lang";
  import { DBState } from "src/ts/stores.svelte";
  import { getCharImage } from "src/ts/characters";
  import { getFileSrc } from "src/ts/globalApi.svelte";
  import { saveImage } from "src/ts/storage/database.svelte";
  import { selectSingleFile, selectMultipleFile } from "src/ts/util";
  import { getImageType } from "src/ts/media";
  import { PngChunk } from "src/ts/pngChunk";
  import { AppendableBuffer } from "src/ts/globalApi.svelte";
  import { commandJson } from "src/ts/runtime/clientProtocol";
  import type {
    DerivedFieldOptions,
    FieldTarget,
  } from "src/ts/runtime/fieldCommands";
  import { composeGroupImage } from "src/ts/runtime/groupImageControls";
  import {
    browserRuntime,
    reportRuntimeError,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import {
    replaceCharacterIcon,
    switchCharacterIcon,
    changeCharacterView,
  } from "src/ts/runtime/characterAssetControls";
  import { PlusIcon, TrashIcon, ImageIcon, ImageOffIcon } from "@lucide/svelte";
  import TextInput from "../UI/GUI/TextInput.svelte";
  import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
  import SelectInput from "../UI/GUI/SelectInput.svelte";
  import OptionInput from "../UI/GUI/OptionInput.svelte";
  import CheckInput from "../UI/GUI/CheckInput.svelte";
  import Help from "../Others/Help.svelte";

  let {
    values,
    capture,
    view = $bindable(0),
    groupId,
  }: {
    values: any;
    view?: number;
    groupId?: string;
    capture: (names: string[]) => {
      values: any;
      headers: Record<string, { revision: number; epoch: number }>;
      commit: (
        next: Record<string, unknown>,
        guardAll?: boolean,
        dependencies?: DerivedFieldOptions,
      ) => void;
    };
  } = $props();
  const spareAssets = $derived(groupId ? [] : (values.ccAssets ?? []));
  let removeMode = $state(false);
  let loading = $state(false);
  let alive = true;
  const lifetime = new AbortController();
  onDestroy(() => {
    alive = false;
    lifetime.abort();
  });
  function captured(names: string[]) {
    const before = capture(names);
    return {
      values: before.values,
      headers: before.headers,
      commit(
        next: Record<string, unknown>,
        dependencies?: DerivedFieldOptions,
      ) {
        if (!alive)
          throw Error("The asset editor was closed while waiting; try again");
        before.commit(next, !dependencies, dependencies);
      },
    };
  }
  async function selectIcon() {
    if (loading) return;
    loading = true;
    try {
      const before = captured(
        groupId ? ["image", "ccAssets"] : ["image", "ccAssets", "extentions"],
      );
      const selected = await selectSingleFile([
        "png",
        "webp",
        "gif",
        "jpg",
        "jpeg",
      ]);
      if (!selected || !alive) return;
      const next = before.values;
      // Keep the original permitted PNG metadata and limits. Image admission
      // precedes the guarded attachment; a rejected attachment leaves a safe,
      // unreferenced immutable blob rather than partially changing a character.
      if (!groupId && getImageType(selected.data) === "PNG") {
        try {
          const allowed = [
            "parameters",
            "Comment",
            "Title",
            "Description",
            "Author",
            "Software",
            "Source",
            "Disclaimer",
            "Warning",
            "Copyright",
          ];
          for await (const chunk of PngChunk.readGenerator(selected.data)) {
            if (
              !chunk ||
              chunk instanceof AppendableBuffer ||
              chunk.value.length > 20000 ||
              !allowed.includes(chunk.key)
            )
              continue;
            next.extentions ??= {};
            next.extentions.pngExif ??= {};
            next.extentions.pngExif[chunk.key] = chunk.value;
          }
        } catch (error) {
          console.error(error);
        }
      }
      const image = await saveImage(selected.data);
      replaceCharacterIcon(next, image);
      before.commit(next);
    } catch (error) {
      reportRuntimeError(error);
    } finally {
      loading = false;
    }
  }
  async function makeImage() {
    if (!groupId || loading) return;
    loading = true;
    try {
      const owner = groupId;
      const before = captured(["image", "ccAssets"]);
      const targets: FieldTarget[] = [
        { scope: "character", entityId: owner, key: "image" },
        { scope: "character", entityId: owner, key: "ccAssets" },
        {
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key: "hideAllImages",
        },
      ];
      const fields = await browserRuntime().readFields(targets);
      if (!alive) return;
      for (const field of fields.slice(0, 2)) {
        const header = before.headers[field.key];
        if (
          !header ||
          field.revision !== header.revision ||
          field.entityEpoch !== header.epoch ||
          (field.value === undefined ? "absent" : commandJson(field.value)) !==
            (before.values[field.key] === undefined
              ? "absent"
              : commandJson(before.values[field.key]))
        )
          throw new Error(
            "The group image changed while waiting; try again after saving",
          );
      }
      const result = await composeGroupImage({
        groupId: owner,
        signal: lifetime.signal,
        hideImages: fields[2].value === true,
        read: (offset, guard) =>
          browserRuntime().groupImageSources(owner, offset, guard),
        source: getFileSrc,
      });
      if (!alive) return;
      before.values.image = await saveImage(result.data);
      // Composition replaces the icon without dumping it into the spare list,
      // matching the original group button. Reads participate without rewriting.
      before.commit(before.values, {
        groupImageSources: result.guard,
        checks: fields.map((field) => ({
          ...targets.find((target) => target.key === field.key)!,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
        })),
      });
    } catch (error) {
      if (alive) reportRuntimeError(error);
    } finally {
      loading = false;
    }
  }
  async function addImages(emotion: boolean) {
    if (loading) return;
    loading = true;
    try {
      const key = emotion ? "emotionImages" : "additionalAssets";
      const before = captured([key]);
      const files = await selectMultipleFile(
        emotion
          ? ["png", "webp", "gif"]
          : [
              "png",
              "webp",
              "mp4",
              "mp3",
              "gif",
              "jpeg",
              "jpg",
              "ttf",
              "otf",
              "css",
              "webm",
              "woff",
              "woff2",
              "svg",
              "avif",
            ],
      );
      if (!files || !alive) return;
      const next = before.values;
      next[key] ??= [];
      for (const file of files) {
        if (!alive) return;
        const extension = file.name.split(".").pop().toLowerCase();
        const path = await saveImage(
          file.data,
          "",
          emotion ? undefined : extension,
        );
        next[key].push(
          emotion
            ? [file.name.replace(".png", "").replace(".webp", ""), path]
            : [file.name, path, extension],
        );
      }
      before.commit(next);
    } catch (error) {
      reportRuntimeError(error);
    } finally {
      loading = false;
    }
  }
  function removeAsset(index: number) {
    try {
      const before = captured(["additionalAssets", "fmIndex"]);
      before.values.additionalAssets.splice(index, 1);
      before.values.fmIndex = -1;
      before.commit(before.values);
    } catch (error) {
      reportRuntimeError(error);
    }
  }
  const gen = (key: string) => values.newGenData?.[key] ?? "";
  function changeView(viewScreen: string, inlay?: boolean) {
    try {
      const before = captured([
        "viewScreen",
        "inlayViewScreen",
        "newGenData",
        ...(inlay !== undefined && viewScreen === "emotion"
          ? ["additionalAssets"]
          : []),
      ]);
      changeCharacterView(before.values, viewScreen, inlay);
      before.commit(before.values);
    } catch (error) {
      reportRuntimeError(error);
    }
  }
  function writeGen(key: string, value: string) {
    if (gen(key) === value) return;
    values.newGenData = {
      prompt: "",
      negative: "",
      instructions: "",
      emotionInstructions: "",
      ...values.newGenData,
      [key]: value,
    };
  }
</script>

<div
  data-runtime-character-assets
  data-runtime-group-assets={groupId}
  class="contents"
>
  <div class="flex w-full rounded-md border border-selected mb-4">
    <button
      data-runtime-asset-tab="icon"
      onclick={() => (view = 0)}
      class="p-2 flex-1"
      class:bg-selected={view === 0}>{language.charIcon}</button
    >
    <button
      data-runtime-asset-tab="view"
      onclick={() => (view = 1)}
      class="p-2 flex-1 border-r border-l border-selected"
      class:bg-selected={view === 1}>{language.viewScreen}</button
    >
    <button
      data-runtime-asset-tab="additional"
      onclick={() => (view = 2)}
      class="p-2 flex-1"
      class:bg-selected={view === 2}>{language.additionalAssets}</button
    >
  </div>
  {#if view === 0}
    <div class="p-2 border-darkborderc border rounded-md flex flex-wrap gap-2">
      {#if values.image}
        <button
          data-runtime-asset-icon="current"
          onclick={() => {
            if (groupId) {
              void selectIcon();
              return;
            }
            if (!removeMode) return;
            values.image = "";
            if (values.ccAssets?.length) switchCharacterIcon(values, 0);
            removeMode = false;
          }}
        >
          {#await getCharImage(values.image, values.largePortrait ? "lgcss" : "css") then image}
            <div
              class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3 transition-shadow"
              class:ring-draculared={removeMode}
              style={image}
            ></div>
          {/await}
        </button>
      {/if}
      {#each spareAssets as asset, index}
        <button
          data-runtime-asset-icon={index}
          onclick={() => {
            if (removeMode) values.ccAssets.splice(index, 1);
            else switchCharacterIcon(values, index);
            removeMode = false;
          }}
        >
          {#await getCharImage(asset.uri, values.largePortrait ? "lgcss" : "css") then image}
            <div
              class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer hover:ring-3 transition-shadow"
              class:ring-draculared={removeMode}
              class:ring-3={removeMode}
              style={image}
            ></div>
          {/await}
        </button>
      {/each}
      <button
        data-runtime-asset-action="upload-icon"
        onclick={selectIcon}
        disabled={loading}
      >
        <div
          class="rounded-md h-24 w-24 border-darkborderc border border-dashed flex justify-center items-center"
          style={values.largePortrait ? "height: 10.66rem" : ""}
        >
          <PlusIcon />
        </div>
      </button>
    </div>
    {#if !groupId}<div class="flex justify-end mt-2">
        <button
          data-runtime-asset-action="remove-mode"
          onclick={() => (removeMode = !removeMode)}
          class:text-draculared={removeMode}
          class="text-textcolor2 hover:text-textcolor"
          ><TrashIcon size="18" /></button
        >
      </div>
    {/if}
    {#if groupId}<button
        data-runtime-group-image
        disabled={loading}
        onclick={makeImage}
        class="w-full p-2 mt-2 rounded-md border border-selected"
        >{language.createGroupImg}</button
      >{/if}
    {#if !groupId && values.image}
      <div
        data-runtime-asset-field="largePortrait"
        class="flex items-center mt-4"
      >
        <CheckInput
          bind:check={
            () => values.largePortrait ?? false,
            (value) => {
              if (value !== (values.largePortrait ?? false))
                values.largePortrait = value;
            }
          }
          name={language.largePortrait}
        />
      </div>
    {/if}
  {:else if view === 1}
    <div data-runtime-asset-field="viewScreen" class="contents">
      <SelectInput
        className="mb-2"
        bind:value={
          () => values.viewScreen ?? "none",
          (value) => {
            if (value !== (values.viewScreen ?? "none")) {
              if (groupId) values.viewScreen = value;
              else changeView(value);
            }
          }
        }
      >
        {#if groupId}<OptionInput value="none">{language.none}</OptionInput
          ><OptionInput value="single">{language.singleView}</OptionInput
          ><OptionInput value="multiple">{language.SpacedView}</OptionInput
          ><OptionInput value="emp">{language.emphasizedView}</OptionInput
          >{:else}<OptionInput value="none">{language.none}</OptionInput
          ><OptionInput value="emotion">{language.emotionImage}</OptionInput
          ><OptionInput value="imggen">{language.imageGeneration}</OptionInput
          >{/if}
      </SelectInput>
    </div>
    {#if !groupId && values.viewScreen === "emotion"}
      <span class="text-textcolor mt-6"
        >{language.emotionImage} <Help key="emotion" /></span
      ><span class="text-textcolor2 text-xs">{language.emotionWarn}</span>
      <div class="w-full max-w-full border border-selected p-2 rounded-md">
        <table class="w-full max-w-full tabler">
          <tbody>
            <tr
              ><th class="font-medium w-1/3">{language.image}</th><th
                class="font-medium w-1/2">{language.emotion}</th
              ><th></th></tr
            >
            {#each values.emotionImages ?? [] as emo, index}
              <tr data-runtime-asset-emotion={index}>
                <td
                  >{#await getCharImage(emo[1], "plain") then image}<img
                      src={image}
                      alt="img"
                      class="w-full"
                    />{/await}</td
                >
                <td
                  ><TextInput
                    marginBottom
                    size="lg"
                    bind:value={values.emotionImages[index][0]}
                  /></td
                >
                <td
                  ><button
                    onclick={() => values.emotionImages.splice(index, 1)}
                    class="text-textcolor2 hover:text-textcolor"
                    ><TrashIcon /></button
                  ></td
                >
              </tr>
            {:else}<tr><td colspan="3">{language.noImages}</td></tr>{/each}
          </tbody>
        </table>
      </div>
      <button
        data-runtime-asset-action="upload-emotion"
        disabled={loading}
        onclick={() => addImages(true)}
        class="text-textcolor2 hover:text-textcolor mt-2"><PlusIcon /></button
      >
      {#if values.inlayViewScreen}
        <span class="text-textcolor mt-2">{language.imgGenInstructions}</span>
        <div data-runtime-asset-gen="emotionInstructions" class="contents">
          <TextAreaInput
            highlight
            bind:value={
              () => gen("emotionInstructions"),
              (value) => writeGen("emotionInstructions", value)
            }
          />
        </div>
      {/if}
    {/if}
    {#if !groupId && values.viewScreen === "imggen"}
      <span class="text-textcolor mt-6"
        >{language.imageGeneration} <Help key="imggen" /></span
      ><span class="text-textcolor2 text-xs">{language.emotionWarn}</span>
      {#each ["prompt", "negative", "instructions"] as key}
        <span class="text-textcolor mt-2"
          >{key === "prompt"
            ? language.imgGenPrompt
            : key === "negative"
              ? language.imgGenNegatives
              : language.imgGenInstructions}</span
        >
        <div data-runtime-asset-gen={key} class="contents">
          <TextAreaInput
            highlight
            bind:value={() => gen(key), (value) => writeGen(key, value)}
          />
        </div>
      {/each}
    {/if}
    {#if !groupId && (values.viewScreen === "emotion" || values.viewScreen === "imggen")}
      <div data-runtime-asset-field="inlayViewScreen" class="contents">
        <CheckInput
          bind:check={
            () => values.inlayViewScreen ?? false,
            (value) => {
              if (value !== (values.inlayViewScreen ?? false))
                changeView(values.viewScreen, value);
            }
          }
          name={language.inlayViewScreen}
        />
      </div>
    {/if}
  {:else}
    {#if DBState.db.newImageHandlingBeta}
      <div data-runtime-asset-field="prebuiltAssetCommand" class="contents">
        <CheckInput
          bind:check={
            () => values.prebuiltAssetCommand ?? false,
            (value) => {
              if (value !== (values.prebuiltAssetCommand ?? false))
                values.prebuiltAssetCommand = value;
            }
          }
          name={language.insertAssetPrompt}
        />
      </div>
      <span class="text-textcolor mt-2">{language.assetStyle}</span>
      <div data-runtime-asset-field="prebuiltAssetStyle" class="contents">
        <SelectInput
          className="mb-2"
          bind:value={
            () => values.prebuiltAssetStyle ?? "",
            (value) => {
              if (value !== (values.prebuiltAssetStyle ?? ""))
                values.prebuiltAssetStyle = value;
            }
          }
          ><OptionInput value="">{language.static}</OptionInput><OptionInput
            value="dynamic">{language.dynamic}</OptionInput
          ></SelectInput
        >
      </div>
    {/if}
    <div class="w-full max-w-full border border-selected rounded-md p-2 mt-2">
      <table class="contain w-full max-w-full tabler mt-2">
        <tbody>
          <tr
            ><th class="font-medium">{language.value}</th><th
              ><button
                data-runtime-asset-action="upload-additional"
                disabled={loading}
                onclick={() => addImages(false)}
                class="text-textcolor2 hover:text-textcolor"
                ><PlusIcon /></button
              ></th
            ></tr
          >
          {#each values.additionalAssets ?? [] as asset, index}
            <tr data-runtime-asset-additional={index}>
              <td>
                {#if DBState.db.useAdditionalAssetsPreview}
                  {@const extension = asset[2] || asset[1].split(".").pop()}
                  {#await getFileSrc(asset[1]) then path}
                    {#if extension === "mp4"}<!-- svelte-ignore a11y_media_has_caption --><video
                        controls
                        class="mt-2 px-2 w-full m-1 rounded-md"
                        ><source src={path} type="video/mp4" /></video
                      >
                    {:else if extension === "mp3"}<audio
                        controls
                        class="mt-2 px-2 w-full h-16 m-1 rounded-md"
                        loop><source src={path} type="audio/mpeg" /></audio
                      >
                    {:else if ["png", "webp", "jpeg", "jpg", "gif"].includes(extension)}<img
                        src={path}
                        class="w-16 h-16 m-1 rounded-md"
                        alt={asset[0]}
                      />{/if}
                  {/await}
                {/if}
                <TextInput
                  size="sm"
                  marginBottom
                  bind:value={values.additionalAssets[index][0]}
                  placeholder="..."
                />
              </td>
              <td
                ><button
                  data-runtime-asset-remove={index}
                  onclick={() => removeAsset(index)}
                  class="text-textcolor2 hover:text-textcolor"
                  ><TrashIcon /></button
                >
                {#if DBState.db.useAdditionalAssetsPreview}<button
                    data-runtime-asset-exclude={index}
                    onclick={() => {
                      values.prebuiltAssetExclude ??= [];
                      values.prebuiltAssetExclude =
                        values.prebuiltAssetExclude.includes(asset[1])
                          ? values.prebuiltAssetExclude.filter(
                              (path) => path !== asset[1],
                            )
                          : [...values.prebuiltAssetExclude, asset[1]];
                    }}
                    class="text-textcolor2 hover:text-textcolor"
                    >{#if values.prebuiltAssetExclude?.includes(asset[1])}<ImageOffIcon
                      />{:else}<ImageIcon />{/if}</button
                  >{/if}
              </td>
            </tr>
          {:else}<tr><td class="text-textcolor2">No Assets</td></tr>{/each}
        </tbody>
      </table>
    </div>
  {/if}
  {#if loading}<span class="text-textcolor2">Loading...</span>{/if}
</div>
