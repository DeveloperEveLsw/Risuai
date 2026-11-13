<script lang="ts">
  import type { Chat } from "src/ts/storage/database.svelte";
  import { entityRuntimeEnabled } from "src/ts/runtime/browserRuntimeState.svelte";
  import RuntimeObjectFields from "src/lib/Setting/Wrappers/RuntimeObjectFields.svelte";
  import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
  let { chat }: { chat: Chat } = $props();
</script>

{#if entityRuntimeEnabled}
  {#key chat.id}
    <RuntimeObjectFields
      targets={{
        supaMemoryData: {
          scope: "chat",
          entityId: chat.id,
          key: "supaMemoryData",
        },
      }}
      values={{ supaMemoryData: chat.supaMemoryData }}
    >
      {#snippet children(draft)}
        <TextAreaInput
          id="runtime-supa-memory"
          margin="both"
          autocomplete="off"
          bind:value={
            () => draft.values.supaMemoryData ?? "",
            (value) => {
              draft.values.supaMemoryData = value;
            }
          }
        />
      {/snippet}
    </RuntimeObjectFields>
  {/key}
{:else}
  <TextAreaInput
    margin="both"
    autocomplete="off"
    bind:value={chat.supaMemoryData}
  />
{/if}
