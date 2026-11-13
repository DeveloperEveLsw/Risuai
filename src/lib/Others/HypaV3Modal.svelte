<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import {
    DBState,
    selectedCharID,
    hypaV3ModalOpen,
  } from "src/ts/stores.svelte";
  import {
    browserRuntime,
    RuntimeUIState,
    entityRuntimeEnabled,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import RuntimeObjectFields from "src/lib/Setting/Wrappers/RuntimeObjectFields.svelte";
  import Controls from "./HypaV3Modal/controls.svelte";
  import { getFirstMessage, processRegexScript } from "./HypaV3Modal/utils";
  import type {
    CapturedMemoryEdit,
    HypaModalContext,
  } from "./HypaV3Modal/context";
  import { createMemorySourceReader } from "src/ts/runtime/memorySourceReader";
  import { getCurrentHypaV3Preset } from "src/ts/process/memory/hypav3";

  const selected = $derived(DBState.db.characters[$selectedCharID]);
  const selectedChat = $derived(selected?.chats?.[selected.chatPage]);
  const owner = untrack(() => ({
    characterId: selected?.chaId,
    chatId: selectedChat?.id,
  }));
  const epoch = untrack(() =>
    entityRuntimeEnabled && owner.chatId
      ? browserRuntime().fieldHeader({
          scope: "chat",
          entityId: owner.chatId,
          key: "hypaV3Data",
        }).epoch
      : 0,
  );
  let closed = false;
  function sourceClock() {
    RuntimeUIState.displayScopeRevision;
    if (
      closed ||
      selected?.chaId !== owner.characterId ||
      selectedChat?.id !== owner.chatId
    )
      return "conversation-changed";
    if (
      browserRuntime().fieldHeader({
        scope: "chat",
        entityId: owner.chatId,
        key: "hypaV3Data",
      }).epoch !== epoch
    )
      return "conversation-replaced";
    return browserRuntime().memorySourceClock(owner.chatId);
  }
  function requireOwner() {
    if (sourceClock().startsWith("conversation-"))
      throw new Error("The memory view's conversation changed; reopen it");
  }
  const reader = entityRuntimeEnabled
    ? createMemorySourceReader({
        clock: sourceClock,
        read: (request) => {
          requireOwner();
          return browserRuntime().readMemorySource(owner.chatId, {
            ...request,
            expectedEpoch: epoch,
          });
        },
      })
    : null;
  const contexts = new WeakMap<object, HypaModalContext>();
  function context(draft: { capture(names: string[]): CapturedMemoryEdit }) {
    if (contexts.has(draft)) return contexts.get(draft);
    const value: HypaModalContext = {
      capture(names = ["hypaV3Data"]) {
        requireOwner();
        const held = draft.capture(names);
        return {
          ...held,
          commit(values, guardAll = false) {
            requireOwner();
            held.commit(values, guardAll);
          },
        };
      },
      async summarize(mode, indices) {
        requireOwner();
        const held = draft.capture(["hypaV3Data"]);
        return browserRuntime().summarizeMemory(
          mode,
          indices,
          owner.chatId,
          held.headers.hypaV3Data,
        );
      },
      sourceClock,
      contains: (memos) => reader.contains(memos),
      firstMessage: () =>
        sourceClock().startsWith("conversation-")
          ? null
          : getFirstMessage(selected, selectedChat),
      async message(memo, next = false) {
        const source = (await reader.source(next ? "next" : "message", memo))
          .source;
        requireOwner();
        if (!source) return null;
        return getCurrentHypaV3Preset().settings.processRegexScript
          ? processRegexScript(source.message, source.index, selected)
          : source.message;
      },
    };
    contexts.set(draft, value);
    return value;
  }
  $effect(() => {
    if (!entityRuntimeEnabled) return;
    RuntimeUIState.displayScopeRevision;
    if (
      selected?.chaId !== owner.characterId ||
      selectedChat?.id !== owner.chatId ||
      browserRuntime().fieldHeader({
        scope: "chat",
        entityId: owner.chatId,
        key: "hypaV3Data",
      }).epoch !== epoch
    )
      $hypaV3ModalOpen = false;
  });
  onDestroy(() => {
    closed = true;
    reader?.close();
  });
</script>

{#if entityRuntimeEnabled}
  {#if owner.chatId && selectedChat}
    <RuntimeObjectFields
      targets={{
        hypaV3Data: {
          scope: "chat",
          entityId: owner.chatId,
          key: "hypaV3Data",
        },
        hypaV2Data: {
          scope: "chat",
          entityId: owner.chatId,
          key: "hypaV2Data",
        },
      }}
      values={{
        hypaV3Data: selectedChat.hypaV3Data,
        hypaV2Data: selectedChat.hypaV2Data,
      }}
    >
      {#snippet children(draft)}
        <Controls
          bind:data={draft.values.hypaV3Data}
          hypaV2Data={draft.values.hypaV2Data}
          context={context(draft)}
        />
      {/snippet}
    </RuntimeObjectFields>
  {/if}
{:else if selectedChat}
  <Controls
    bind:data={selectedChat.hypaV3Data}
    hypaV2Data={selectedChat.hypaV2Data}
  />
{/if}
