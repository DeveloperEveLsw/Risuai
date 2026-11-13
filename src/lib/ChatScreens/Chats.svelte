<script lang="ts">
  import type {
    character,
    groupChat,
    Message,
  } from "src/ts/storage/database.svelte";
  import { onDestroy, tick } from "svelte";
  import Chat from "./Chat.svelte";
  import { getCharImage } from "src/ts/characters";
  import {
    createSimpleCharacter,
    DBState,
    selectedCharID,
    ReloadChatPointer,
  } from "src/ts/stores.svelte";
  import { chatFoldedStateMessageIndex } from "src/ts/globalApi.svelte";

  let {
    messages,
    currentCharacter,
    onReroll,
    unReroll,
    currentUsername,
    userIcon,
    loadPages,
    userIconPortrait,
    hasNewUnreadMessage = $bindable(false),
  }: {
    messages: Message[];
    currentCharacter: character | groupChat;
    onReroll: () => void;
    unReroll: () => void;
    currentUsername: string;
    userIcon: string;
    loadPages: number;
    userIconPortrait?: boolean;
    hasNewUnreadMessage?: boolean;
  } = $props();

  let chatBody: HTMLDivElement;
  const fallbackIds = new WeakMap<Message, number>();
  let nextFallback = 0;
  function messageKey(message: Message) {
    if (message.chatId) return message.chatId;
    if (!fallbackIds.has(message)) fallbackIds.set(message, ++nextFallback);
    return "legacy-" + fallbackIds.get(message);
  }
  let chatRoomId = $derived(
    DBState.db.characters[$selectedCharID]?.chats?.[currentCharacter.chatPage]
      ?.id ?? null,
  );
  let charImage = $derived(getCharImage(currentCharacter.image, "css"));
  let userImage = $derived(getCharImage(userIcon, "css"));
  let simpleChar = $derived(createSimpleCharacter(currentCharacter));
  let currentChat = $derived(
    currentCharacter.chats?.[currentCharacter.chatPage],
  );
  let performanceMode = $derived(
    currentChat?.isStreaming
      ? (currentChat.activeStreamingDisplayOptimizationMode ??
          DBState.db.streamingDisplayOptimizationMode ??
          "off")
      : (DBState.db.streamingDisplayOptimizationMode ?? "off"),
  );
  let activeStreamingIndex = $derived(
    performanceMode !== "off" && currentChat?.isStreaming
      ? messages.length - 1
      : -1,
  );
  let rows = $derived.by(() => {
    const start =
      chatFoldedStateMessageIndex.index !== -1
        ? chatFoldedStateMessageIndex.index
        : messages.length - 1;
    const end = Math.max(0, start - loadPages);
    const visible: { message: Message; index: number; key: string }[] = [];
    for (
      let index = Math.min(start, messages.length - 1);
      index >= end;
      index--
    ) {
      const message = messages[index];
      visible.push({
        message,
        index,
        key: String(chatRoomId) + ":" + messageKey(message),
      });
    }
    return visible;
  });
  function checkIfAtBottom() {
    if (!chatBody?.parentElement || !chatBody.firstElementChild) return true;
    return (
      chatBody.firstElementChild.getBoundingClientRect().top <=
      chatBody.parentElement.getBoundingClientRect().bottom + 100
    );
  }
  export function scrollToLatestMessage() {
    hasNewUnreadMessage = false;
    chatBody?.firstElementChild?.scrollIntoView({
      behavior: "instant",
      block: "start",
    });
  }
  let previousChatRoomId: string | null = null;
  let previousLastKey: string | null = null;
  let scrollTimer: ReturnType<typeof setTimeout>;
  let destroyed = false;
  $effect.pre(() => {
    const room = chatRoomId;
    const last = messages.at(-1);
    const key = last ? messageKey(last) : null;
    const wasAtBottom = checkIfAtBottom();
    if (
      room === previousChatRoomId &&
      previousLastKey !== null &&
      key !== previousLastKey &&
      last?.role === "char" &&
      DBState.db.autoScrollToNewMessage
    ) {
      if (wasAtBottom || DBState.db.alwaysScrollToNewMessage) {
        clearTimeout(scrollTimer);
        void tick().then(() => {
          if (destroyed) return;
          scrollTimer = setTimeout(() => {
            if (chatRoomId === room) scrollToLatestMessage();
          }, 700);
        });
      } else hasNewUnreadMessage = true;
    }
    previousChatRoomId = room;
    previousLastKey = key;
  });
  onDestroy(() => {
    destroyed = true;
    clearTimeout(scrollTimer);
  });
</script>

<div class="flex flex-col-reverse" bind:this={chatBody}>
  {#each rows as row (row.key)}
    <div
      class="chat-message-container"
      data-message-id={row.message.chatId ?? row.key}
    >
      <Chat
        message={row.message.data}
        messageId={row.message.chatId}
        idx={row.index}
        isLastMemory={false}
        totalLength={messages.length}
        img={row.message.role === "user" ? userImage : charImage}
        {onReroll}
        {unReroll}
        rerollIcon="dynamic"
        character={simpleChar}
        largePortrait={row.message.role === "user"
          ? (userIconPortrait ?? false)
          : ((currentCharacter as character).largePortrait ?? false)}
        messageGenerationInfo={row.message.generationInfo}
        role={row.message.role}
        name={row.message.role === "user"
          ? currentUsername
          : currentCharacter.name}
        isComment={row.message.isComment ?? false}
        disabled={row.message.disabled ?? false}
        isOptimizedStreamingMessage={row.index === activeStreamingIndex &&
          row.message.role === "char"}
        streamingOptimizationMode={performanceMode}
        rawStreamingText={row.message.data}
        displayRevision={$ReloadChatPointer[row.index] ?? 0}
      />
    </div>
  {/each}
</div>
