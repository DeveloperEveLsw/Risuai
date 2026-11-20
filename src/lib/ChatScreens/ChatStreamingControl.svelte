<script lang="ts">
  import { language } from "src/lang";
  import { doingChat } from "src/ts/process/index.svelte";
  import { getModelInfo } from "src/ts/model/modellist";
  import { supportsModelStreaming } from "src/ts/model/modelCatalog";
  import { DBState } from "src/ts/stores.svelte";
  import {
    entityRuntimeEnabled,
    RuntimeUIState,
    reportRuntimeError,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import {
    getSettingDatabase,
    setSettingChanges,
  } from "src/ts/runtime/fieldControls";

  const settings = $derived(getSettingDatabase(DBState.db));
  const supportsStreaming = $derived(
    supportsModelStreaming(getModelInfo(settings.aiModel)),
  );

  function change(event: Event) {
    try {
      setSettingChanges(DBState.db, [
        {
          path: ["useStreaming"],
          value: (event.currentTarget as HTMLInputElement).checked,
        },
      ]);
    } catch (error) {
      reportRuntimeError(error);
    }
  }
</script>

{#if entityRuntimeEnabled && supportsStreaming}
  <label class="mx-4 my-1 flex items-center gap-2 text-sm text-textcolor">
    <input
      type="checkbox"
      data-runtime-streaming
      checked={!!settings.useStreaming}
      disabled={!RuntimeUIState.scopeReady || $doingChat}
      onchange={change}
    />
    {language.streaming}
  </label>
{/if}
