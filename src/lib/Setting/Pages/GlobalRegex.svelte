<script lang="ts">
  import { DownloadIcon, HardDriveUploadIcon, PlusIcon } from "@lucide/svelte";
  import { language } from "src/lang";
  import Help from "src/lib/Others/Help.svelte";

  import { DBState } from "src/ts/stores.svelte";
  import { exportRegex, importRegex } from "src/ts/process/scripts";
  import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
  import RuntimeObjectField from "../Wrappers/RuntimeObjectField.svelte";
  import {
    entityRuntimeEnabled,
    reportRuntimeError,
  } from "src/ts/runtime/browserRuntimeState.svelte";
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">
  {language.globalRegexScript}
  <Help key="regexScript" />
</h2>
{#if entityRuntimeEnabled}
  <RuntimeObjectField
    target={{
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "globalscript",
    }}
    value={DBState.db.globalscript}
  >
    {#snippet children(draft)}
      <RegexList
        bind:value={draft.value}
        buttons
        onImport={async () => {
          try {
            const captured = draft.capture();
            captured.commit(await importRegex(captured.value));
          } catch (error) {
            reportRuntimeError(error);
          }
        }}
      />
    {/snippet}
  </RuntimeObjectField>
{:else}
  <RegexList bind:value={DBState.db.globalscript} />
  <div class="text-textcolor2 mt-2 flex gap-2">
    <button
      class="font-medium cursor-pointer hover:text-green-500"
      onclick={() => {
        let script = DBState.db.globalscript;
        script.push({
          comment: "",
          in: "",
          out: "",
          type: "editinput",
        });
        DBState.db.globalscript = script;
      }}><PlusIcon /></button
    >
    <button
      class="font-medium cursor-pointer hover:text-green-500"
      onclick={() => {
        exportRegex();
      }}><DownloadIcon /></button
    >
    <button
      class="font-medium cursor-pointer hover:text-green-500"
      onclick={() => {
        importRegex();
      }}><HardDriveUploadIcon /></button
    >
  </div>
{/if}
