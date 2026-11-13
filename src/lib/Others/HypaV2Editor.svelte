<script lang="ts">
  import { untrack } from "svelte";
  import { DBState, selectedCharID, alertStore } from "src/ts/stores.svelte";
  import { entityRuntimeEnabled } from "src/ts/runtime/browserRuntimeState.svelte";
  import RuntimeObjectFields from "src/lib/Setting/Wrappers/RuntimeObjectFields.svelte";
  import Button from "../UI/GUI/Button.svelte";
  import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
  let { menu = $bindable(0) }: { menu?: number } = $props();
  // An open modal belongs to the chat that opened it, including after navigation.
  const owner = untrack(() => {
    const character = DBState.db.characters[$selectedCharID];
    return {
      characterId: character.chaId,
      chatId: character.chats[character.chatPage].id,
    };
  });
  const chat = () =>
    entityRuntimeEnabled
      ? DBState.db.characters
          .find((c) => c.chaId === owner.characterId)
          ?.chats.find((c) => c.id === owner.chatId)
      : DBState.db.characters[$selectedCharID].chats[
          DBState.db.characters[$selectedCharID].chatPage
        ];
  const empty = { lastMainChunkID: 0, mainChunks: [], chunks: [] };
</script>

<div data-runtime-memory-editor="hypa-v2">
  <div class="flex flex-wrap gap-2 mb-4 max-w-full w-124">
    <Button
      selected={menu === 0}
      size="sm"
      onclick={() => {
        menu = 0;
      }}>Chunks</Button
    >
    <Button
      selected={menu === 1}
      size="sm"
      onclick={() => {
        menu = 1;
      }}>Summarized</Button
    >
    <button
      class="ml-auto"
      onclick={() => {
        alertStore.set({ type: "none", msg: "" });
      }}>✖</button
    >
  </div>
  {#if entityRuntimeEnabled}
    <RuntimeObjectFields
      targets={{
        hypaV2Data: {
          scope: "chat",
          entityId: owner.chatId,
          key: "hypaV2Data",
        },
      }}
      values={{ hypaV2Data: chat()?.hypaV2Data }}
    >
      {#snippet children(draft)}{@render fields(
          draft.values.hypaV2Data ?? empty,
        )}{/snippet}
    </RuntimeObjectFields>
  {:else}{@render fields(chat().hypaV2Data)}{/if}
</div>

{#snippet fields(data)}
  {#if menu === 0}
    <div class="flex flex-col gap-2 w-full">
      {#each data.chunks as chunk, i}
        <div data-memory-chunk={i}>
          <TextAreaInput bind:value={chunk.text} />
        </div>
      {/each}
      <!-- Original editing changes existing chunks only. -->
    </div>
  {:else}
    {#each data.mainChunks as chunk, i}
      <div
        data-memory-main-chunk={i}
        class="flex flex-col p-2 rounded-md border-darkborderc border"
      >
        {#if i === 0}<span class="text-green-500">Active</span>{:else}<span
            >Inactive</span
          >{/if}
        <!-- Original main-chunk editing does not change its related chunks. -->
        <TextAreaInput bind:value={chunk.text} />
      </div>
    {/each}
  {/if}
{/snippet}
