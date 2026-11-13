<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    XIcon,
    TrashIcon,
    PencilIcon,
    BookOpenCheckIcon,
    BookLockIcon,
    ArrowRightIcon,
  } from "@lucide/svelte";
  import Chat from "../ChatScreens/Chat.svelte";
  import { getCharImage } from "src/ts/characters";
  import { findCharacterbyId, getUserName, getUserIcon } from "src/ts/util";
  import {
    createSimpleCharacter,
    bookmarkListOpen,
    DBState,
    selectedCharID,
    ScrollToMessageStore,
  } from "src/ts/stores.svelte";
  import { language } from "src/lang";
  import { alertInput } from "src/ts/alert";
  import {
    browserRuntime,
    entityRuntimeEnabled,
    RuntimeUIState,
    reportRuntimeError,
    type BookmarkTarget,
  } from "src/ts/runtime/browserRuntimeState.svelte";

  const close = () => ($bookmarkListOpen = false);
  let listClosed = false;
  let session = "";
  onDestroy(() => {
    listClosed = true;
    if (entityRuntimeEnabled && session)
      browserRuntime().closeBookmarkList(session);
  });
  let chara = $derived(DBState.db.characters[$selectedCharID]);
  const simpleChar = $derived(createSimpleCharacter(chara));
  $effect(() => {
    if (!entityRuntimeEnabled || !chara || !RuntimeUIState.scopeReady) return;
    chara.chatPage;
    if (RuntimeUIState.bookmarkList.session) return;
    session = browserRuntime().openBookmarkList();
    void browserRuntime().loadBookmarkPage(session).catch(reportRuntimeError);
  });

  const messageMap = $derived.by(() => {
    if (!chara) return new Map();

    const chat = chara.chats[chara.chatPage];
    const allMessages = chat.message;
    const map = new Map();

    allMessages.forEach((m, index) => {
      map.set(m.chatId, { ...m, originalIndex: index, saying: m.saying ?? "" });
    });

    return map;
  });

  const bookmarkedMessages = $derived.by(() => {
    if (!chara) return [];
    if (entityRuntimeEnabled)
      return RuntimeUIState.bookmarkList.items.map((item) => ({
        ...item.message,
        originalIndex: item.ordinal,
        saying: item.message.saying ?? "",
        speaker:
          chara.type === "group" && item.message.saying
            ? findCharacterbyId(item.message.saying)
            : null,
      }));

    const chat = chara.chats[chara.chatPage];
    const bookmarkIds = chat.bookmarks ?? [];
    const map = messageMap;

    const messages = bookmarkIds
      .map((id) => {
        const message = map.get(id);
        if (!message) return null;

        let speaker = null;
        if (chara.type === "group" && message.saying) {
          speaker = findCharacterbyId(message.saying);
        }

        return { ...message, speaker };
      })
      .filter(Boolean);

    return messages;
  });

  let expandedBookmarks = $state(new Set<string>());
  let expandAll = $state(false);

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  });

  function toggleExpand(chatId: string) {
    if (expandAll) {
      expandAll = false;
      const allIds = bookmarkedMessages.map((m) => m.chatId);
      const newSet = new Set(allIds);
      newSet.delete(chatId);
      expandedBookmarks = newSet;
    } else {
      const newSet = new Set(expandedBookmarks);
      if (newSet.has(chatId)) {
        newSet.delete(chatId);
      } else {
        newSet.add(chatId);
      }
      expandedBookmarks = newSet;
    }
  }

  function toggleExpandAll() {
    expandAll = !expandAll;
    if (expandAll) {
      expandedBookmarks.clear();
    }
  }

  async function editName(chatId: string) {
    if (entityRuntimeEnabled) {
      if (bookmarkBusy(chatId)) return;
      const bridge = browserRuntime();
      let target: Readonly<BookmarkTarget>;
      try {
        target = await bridge.captureBookmark(chatId, "rename");
        if (listClosed) return;
        const input = await alertInput(
          language.bookmarkAskNameOrCancel,
          [],
          typeof target.name === "string" ? target.name : "",
        );
        if (input && input.trim() !== "")
          await bridge.setBookmark(target, input);
      } catch (error) {
        reportRuntimeError(error);
      } finally {
        if (target) bridge.releaseBookmark(target);
      }
      return;
    }
    const chat = chara.chats[chara.chatPage];
    const newName = await alertInput(
      language.bookmarkAskNameOrCancel,
      [],
      chat.bookmarkNames?.[chatId] || "",
    );
    if (newName && newName.trim() !== "") {
      chat.bookmarkNames[chatId] = newName;
    }
  }

  async function removeBookmark(chatId: string) {
    if (entityRuntimeEnabled) {
      if (bookmarkBusy(chatId)) return;
      const bridge = browserRuntime();
      let target: Readonly<BookmarkTarget>;
      try {
        target = await bridge.captureBookmark(chatId, "remove");
        await bridge.setBookmark(target);
      } catch (error) {
        reportRuntimeError(error);
      } finally {
        if (target) bridge.releaseBookmark(target);
      }
      return;
    }
    const chat = chara.chats[chara.chatPage];
    const index = chat.bookmarks.indexOf(chatId);
    if (index > -1) {
      chat.bookmarks.splice(index, 1);
      delete chat.bookmarkNames[chatId];
    }
  }

  function bookmarkBusy(id: string) {
    return (
      entityRuntimeEnabled &&
      (!RuntimeUIState.scopeReady || !!browserRuntime().pendingBookmark(id))
    );
  }

  function bookmarkName(id: string, fallback: string) {
    const pending = entityRuntimeEnabled
      ? browserRuntime().pendingBookmark(id)
      : undefined;
    return (
      pending?.name ||
      (entityRuntimeEnabled
        ? (RuntimeUIState.bookmarkList.items.find(
            (item) => item.messageId === id,
          )?.name as string)
        : undefined) ||
      chara.chats[chara.chatPage].bookmarkNames?.[id] ||
      fallback
    );
  }

  let navigating = $state(false);
  async function goToChat(id: string, index: number) {
    if (entityRuntimeEnabled) {
      if (navigating) return;
      navigating = true;
      try {
        const target = await browserRuntime().jumpToMessage(id);
        if (target < 0 || listClosed) return;
        ScrollToMessageStore.value = target;
        close();
      } catch (error) {
        reportRuntimeError(error);
      } finally {
        navigating = false;
      }
      return;
    }
    ScrollToMessageStore.value = index;
    close();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed top-0 left-0 w-full h-full z-30 bg-black/50 flex justify-center items-center"
  onclick={(event) => {
    if (event.target === event.currentTarget) {
      close();
    }
  }}
  onkeydown={(event) => {
    if (
      event.target === event.currentTarget &&
      (event.key === "Enter" || event.key === " ")
    ) {
      close();
    }
  }}
>
  <div
    class="bg-darkbg p-3 rounded-md flex flex-col max-w-4xl w-full max-h-[90%] overflow-y-auto"
  >
    <div class="flex items-center text-textcolor mb-4">
      <h2 class="text-xl font-bold">{language.bookmarks}</h2>
      <div class="ml-auto flex items-center gap-2">
        <button
          class="text-textcolor2 hover:text-green-500"
          onclick={toggleExpandAll}
          title={expandAll ? language.collapseAll : language.expandAll}
        >
          {#if expandAll}
            <BookLockIcon size={20} />
          {:else}
            <BookOpenCheckIcon size={20} />
          {/if}
        </button>
        <button
          class="text-textcolor2 hover:text-green-500 bookmark-close"
          title={language.close}
          onclick={close}
        >
          <XIcon size={24} />
        </button>
      </div>
    </div>

    {#if entityRuntimeEnabled}
      <div
        class="flex items-center gap-3 mb-3 text-textcolor"
        aria-busy={RuntimeUIState.bookmarkList.loading}
      >
        <span>{RuntimeUIState.bookmarkList.count}</span>
        <button
          class="bookmark-first"
          disabled={RuntimeUIState.bookmarkList.loading ||
            RuntimeUIState.bookmarkList.first}
          onclick={() =>
            browserRuntime()
              .loadBookmarkPage(session)
              .catch(reportRuntimeError)}>처음</button
        >
        <button
          class="bookmark-next"
          disabled={RuntimeUIState.bookmarkList.loading ||
            !RuntimeUIState.bookmarkList.next}
          onclick={() =>
            browserRuntime()
              .loadBookmarkPage(session, RuntimeUIState.bookmarkList.next)
              .catch(reportRuntimeError)}>다음</button
        >
        {#if RuntimeUIState.bookmarkList.loading}<span>불러오는 중…</span>{/if}
      </div>
    {/if}
    {#if bookmarkedMessages.length === 0 && !(entityRuntimeEnabled && RuntimeUIState.bookmarkList.loading)}
      <p class="text-textcolor2">{language.noBookmarks}</p>
    {:else}
      <div class="flex flex-col gap-2">
        {#each bookmarkedMessages as msg (msg.chatId)}
          <div
            class="border border-darkborderc rounded-lg"
            data-runtime-bookmark-id={msg.chatId}
          >
            <div
              class="flex items-center p-3 cursor-pointer hover:bg-selected transition-colors"
              onclick={() => toggleExpand(msg.chatId)}
              onkeydown={(e) => e.key === "Enter" && toggleExpand(msg.chatId)}
              role="button"
              tabindex="0"
            >
              <span class="grow text-left truncate"
                >{bookmarkName(
                  msg.chatId,
                  msg.data.substring(0, 30) + "...",
                )}</span
              >
              <div class="shrink-0 flex items-center gap-2 ml-2">
                <button
                  class="text-textcolor2 hover:text-blue-500 bookmark-jump"
                  disabled={navigating}
                  aria-busy={navigating}
                  title={language.goToChat}
                  onclick={(e) => {
                    e.stopPropagation();
                    goToChat(msg.chatId, msg.originalIndex);
                  }}
                >
                  <ArrowRightIcon size={20} />
                </button>
                <button
                  class="text-textcolor2 hover:text-green-500 bookmark-name"
                  disabled={bookmarkBusy(msg.chatId)}
                  aria-busy={bookmarkBusy(msg.chatId)}
                  onclick={(e) => {
                    e.stopPropagation();
                    editName(msg.chatId);
                  }}
                >
                  <PencilIcon size={16} />
                </button>
                <button
                  class="text-textcolor2 hover:text-red-500 bookmark-remove"
                  disabled={bookmarkBusy(msg.chatId)}
                  aria-busy={bookmarkBusy(msg.chatId)}
                  onclick={(e) => {
                    e.stopPropagation();
                    removeBookmark(msg.chatId);
                  }}
                >
                  <TrashIcon size={16} />
                </button>
              </div>
            </div>

            {#if expandAll || expandedBookmarks.has(msg.chatId)}
              <div class="p-1 border-t border-darkborderc">
                {#if chara.type === "group"}
                  <Chat
                    messageId={msg.chatId}
                    bookmarkSession={entityRuntimeEnabled
                      ? RuntimeUIState.bookmarkList.presentationToken
                      : undefined}
                    idx={msg.originalIndex}
                    message={msg.data}
                    name={msg.speaker?.name}
                    img={getCharImage(msg.speaker?.image, "css")}
                    role={msg.role}
                    messageGenerationInfo={msg.generationInfo}
                    rerollIcon={false}
                    largePortrait={msg.speaker?.largePortrait}
                    character={msg.saying}
                    isLastMemory={false}
                  />
                {:else}
                  <Chat
                    messageId={msg.chatId}
                    bookmarkSession={entityRuntimeEnabled
                      ? RuntimeUIState.bookmarkList.presentationToken
                      : undefined}
                    idx={msg.originalIndex}
                    message={msg.data}
                    name={msg.role === "user" ? getUserName() : chara.name}
                    img={msg.role === "user"
                      ? getCharImage(getUserIcon(), "css")
                      : getCharImage(chara.image, "css")}
                    role={msg.role}
                    messageGenerationInfo={msg.generationInfo}
                    rerollIcon={false}
                    largePortrait={chara.largePortrait}
                    character={simpleChar}
                    isLastMemory={false}
                  />
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
