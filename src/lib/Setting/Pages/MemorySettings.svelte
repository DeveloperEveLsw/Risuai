<script lang="ts">
  import { DBState } from "src/ts/stores.svelte";
  import { entityRuntimeEnabled } from "src/ts/runtime/browserRuntimeState.svelte";
  import RuntimeObjectFields from "../Wrappers/RuntimeObjectFields.svelte";
  import MemorySettingsControls from "./MemorySettingsControls.svelte";
  import type { FieldTarget } from "src/ts/runtime/fieldCommands";
  const keys = [
    "hanuraiEnable",
    "hanuraiSplit",
    "hanuraiTokens",
    "hypaAllocatedTokens",
    "hypaChunkSize",
    "hypaCustomSettings",
    "hypaMemory",
    "hypaModel",
    "hypaV3",
    "hypaV3PresetId",
    "hypaV3Presets",
    "hypav2",
    "maxSupaChunkSize",
    "memoryAlgorithmType",
    "supaMemoryKey",
    "supaMemoryPrompt",
    "supaModelType",
    "voyageApiKey",
  ];
  const targets = Object.fromEntries(
    keys.map((key) => [
      key,
      {
        scope: "resource",
        resourceKind: "settings",
        entityId: "global",
        key,
      } as FieldTarget,
    ]),
  );
</script>

{#if entityRuntimeEnabled}
  <RuntimeObjectFields
    {targets}
    values={Object.fromEntries(keys.map((key) => [key, DBState.db[key]]))}
    dependencyGroups={[
      [
        "supaModelType",
        "memoryAlgorithmType",
        "hypav2",
        "hanuraiEnable",
        "hypaV3",
      ],
      ["hypaV3Presets", "hypaV3PresetId"],
    ]}
  >
    {#snippet children(draft)}<MemorySettingsControls
        values={draft.values}
        capture={draft.capture}
      />{/snippet}
  </RuntimeObjectFields>
{:else}<MemorySettingsControls values={DBState.db} />{/if}
