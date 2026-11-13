<script lang="ts">
  import { language } from "src/lang";
  import { DBState, selectedCharID } from "src/ts/stores.svelte";
  import {
    alertError,
    alertInput,
    alertConfirm,
    alertNormal,
  } from "src/ts/alert";
  import { createHypaV3Preset } from "src/ts/process/memory/hypav3";
  import { downloadFile } from "src/ts/globalApi.svelte";
  import { selectSingleFile } from "src/ts/util";
  import { tokenizePreset } from "src/ts/process/prompt";
  import { getCharToken } from "src/ts/tokenizer";
  import {
    PlusIcon,
    PencilIcon,
    TrashIcon,
    DownloadIcon,
    HardDriveUploadIcon,
  } from "@lucide/svelte";
  import Help from "src/lib/Others/Help.svelte";
  import Accordion from "src/lib/UI/Accordion.svelte";
  import Check from "src/lib/UI/GUI/CheckInput.svelte";
  import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
  import TextInput from "src/lib/UI/GUI/TextInput.svelte";
  import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
  import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
  import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
  import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
  let {
    values,
    capture,
  }: {
    values: any;
    capture?: (names: string[]) => {
      values: any;
      commit: (next: Record<string, unknown>) => void;
    };
  } = $props();
  function read(key: string, path: string[], fallback: any) {
    let value = values[key];
    for (const part of path) value = value?.[part];
    return value ?? fallback;
  }
  function write(key: string, path: string[], value: any, fallback: any) {
    if (Object.is(read(key, path, fallback), value)) return;
    if (!path.length) {
      values[key] = value;
      return;
    }
    const next = { ...values[key] };
    next[path[0]] = value;
    values[key] = next;
  }
  function changeMode(value: string) {
    Object.assign(values, {
      supaModelType:
        value === "supaMemory" || value === "hypaV2" ? "distilbart" : "none",
      memoryAlgorithmType:
        {
          supaMemory: "supaMemory",
          hypaV2: "hypaMemoryV2",
          hypaV3: "hypaMemoryV3",
          hanuraiMemory: "hanuraiMemory",
        }[value] ?? "none",
      hypav2: value === "hypaV2",
      hanuraiEnable: value === "hanuraiMemory",
      hypaV3: value === "hypaV3",
    });
  }
  function captured() {
    const names = ["hypaV3Presets", "hypaV3PresetId"];
    if (capture) return capture(names);
    const owner = values;
    return {
      values: JSON.parse(
        JSON.stringify({
          hypaV3Presets: owner.hypaV3Presets ?? [],
          hypaV3PresetId: owner.hypaV3PresetId ?? 0,
        }),
      ),
      commit(next: Record<string, unknown>) {
        Object.assign(owner, next);
      },
    };
  }
  function addPreset() {
    try {
      const before = captured();
      const presets = [
        ...(before.values.hypaV3Presets ?? []),
        createHypaV3Preset(),
      ];
      before.commit({
        ...before.values,
        hypaV3Presets: presets,
        hypaV3PresetId: presets.length - 1,
      });
    } catch (e) {
      alertError(String(e));
    }
  }
  async function renamePreset() {
    try {
      const before = captured();
      const presets = before.values.hypaV3Presets ?? [];
      const preset = presets[before.values.hypaV3PresetId ?? 0];
      if (!preset) {
        alertError("There must be least one preset.");
        return;
      }
      const name = await alertInput(
        `Enter new name for ${preset.name}`,
        [],
        preset.name,
      );
      if (!name?.trim()) return;
      preset.name = name;
      before.commit({ ...before.values, hypaV3Presets: presets });
    } catch (e) {
      alertError(String(e));
    }
  }
  async function removePreset() {
    try {
      const before = captured();
      const presets = before.values.hypaV3Presets ?? [];
      if (presets.length <= 1) {
        alertError("There must be least one preset.");
        return;
      }
      const id = before.values.hypaV3PresetId ?? 0;
      const preset = presets[id];
      if (!(await alertConfirm(`${language.removeConfirm}${preset.name}`)))
        return;
      presets.splice(id, 1);
      before.commit({
        ...before.values,
        hypaV3Presets: presets,
        hypaV3PresetId: 0,
      });
    } catch (e) {
      alertError(String(e));
    }
  }
  async function exportPreset() {
    try {
      const preset = (values.hypaV3Presets ?? [])[values.hypaV3PresetId ?? 0];
      if (!preset) {
        alertError("There must be least one preset.");
        return;
      }
      const bytes = Buffer.from(
        JSON.stringify({ type: "risu", ver: 1, data: preset }),
        "utf-8",
      );
      await downloadFile(`hypaV3_export_${preset.name}.json`, bytes);
      alertNormal(language.successExport);
    } catch (e) {
      alertError(String(e));
    }
  }
  async function importPreset() {
    try {
      const before = captured();
      const selected = await selectSingleFile(["json"]);
      if (!selected?.data) return;
      const obj = JSON.parse(Buffer.from(selected.data).toString("utf-8"));
      if (obj.type !== "risu" || !obj.data) return;
      const preset = createHypaV3Preset(
        obj.data.name || "Imported Preset",
        obj.data.settings || {},
      );
      const presets = [...(before.values.hypaV3Presets ?? []), preset];
      before.commit({
        ...before.values,
        hypaV3Presets: presets,
        hypaV3PresetId: presets.length - 1,
      });
      alertNormal(language.successImport);
    } catch (e) {
      alertError(String(e));
    }
  }
  function writeRatio(
    key: "recentMemoryRatio" | "similarMemoryRatio",
    value: number,
  ) {
    const id = values.hypaV3PresetId ?? 0,
      preset = values.hypaV3Presets[id];
    const settings = { ...preset.settings };
    const next = Math.min(value, 1);
    settings[key] = next;
    const other =
      key === "recentMemoryRatio" ? "similarMemoryRatio" : "recentMemoryRatio";
    if (next + settings[other] > 1) settings[other] = 1 - next;
    values.hypaV3Presets = values.hypaV3Presets.map((p: any, i: number) =>
      i === id ? { ...p, settings } : p,
    );
  }
  async function getMaxMemoryRatio(): Promise<number> {
    const db = DBState.db;
    const promptTemplate = db.promptTemplate;
    const char = db.characters[$selectedCharID];
    const loreBudget = char?.loreSettings?.tokenBudget ?? db.loreBookToken;
    const maxResponse = db.maxResponse,
      maxContext = db.maxContext;
    const promptTemplateToken = await tokenizePreset(promptTemplate);
    const charToken = await getCharToken(char);
    const requiredToken =
      promptTemplateToken +
      charToken.persistant +
      Math.min(charToken.dynamic, loreBudget) +
      maxResponse * 3;
    return maxContext === 0
      ? 0
      : parseFloat(
          Math.max((maxContext - requiredToken) / maxContext, 0).toFixed(2),
        );
  }
</script>

<div data-runtime-memory-settings class="contents">
  <span class="text-textcolor mt-4">{language.type}</span>

  <div class="contents" data-memory-field="mode">
    <SelectInput
      className="mb-4"
      value={values.hypaV3
        ? "hypaV3"
        : values.hypav2
          ? "hypaV2"
          : values.supaModelType !== "none"
            ? "supaMemory"
            : values.hanuraiEnable
              ? "hanuraiMemory"
              : "none"}
      onchange={(v) => {
        changeMode(v.currentTarget.value);
      }}
    >
      <OptionInput value="none">None</OptionInput>
      <OptionInput value="supaMemory">{language.SuperMemory}</OptionInput>
      <OptionInput value="hypaV2">{language.HypaMemory} V2</OptionInput>
      <OptionInput value="hanuraiMemory">{language.hanuraiMemory}</OptionInput>
      <OptionInput value="hypaV3">{language.HypaMemory} V3</OptionInput>
    </SelectInput>
  </div>

  {#if values.hanuraiEnable}
    <span
      class="mb-2 text-textcolor2 text-sm text-wrap wrap-break-word max-w-full"
      >{language.hanuraiDesc}</span
    >
    <span>Chunk Size</span>
    <NumberInput
      size="sm"
      marginBottom
      id="runtime-memory-hanuraiTokens"
      bind:value={
        () => read("hanuraiTokens", [], 100),
        (value) => write("hanuraiTokens", [], value, 100)
      }
      min={100}
    />
    <div class="flex mb-4">
      <div class="contents" data-memory-field="hanuraiSplit">
        <Check
          bind:check={
            () => read("hanuraiSplit", [], false),
            (value) => write("hanuraiSplit", [], value, false)
          }
          name="Text Spliting"
        />
      </div>
    </div>
  {:else if values.hypav2}
    <span
      class="mb-2 text-textcolor2 text-sm text-wrap wrap-break-word max-w-full"
      >{language.hypaV2Desc}</span
    >
    <span class="text-textcolor mt-4"
      >{language.SuperMemory} {language.model}</span
    >
    <div class="contents" data-memory-field="supaModelType">
      <SelectInput
        className="mt-2 mb-2"
        bind:value={
          () => read("supaModelType", [], "none"),
          (value) => write("supaModelType", [], value, "none")
        }
      >
        <OptionInput value="distilbart"
          >distilbart-cnn-6-6 (Free/Local)</OptionInput
        >
        <OptionInput value="instruct35">OpenAI 3.5 Turbo Instruct</OptionInput>
        <OptionInput value="subModel">{language.submodel}</OptionInput>
      </SelectInput>
    </div>
    {#if values.supaModelType === "davinci" || values.supaModelType === "curie" || values.supaModelType === "instruct35"}
      <span class="text-textcolor">{language.SuperMemory} OpenAI Key</span>
      <TextInput
        size="sm"
        marginBottom
        id="runtime-memory-supaMemoryKey"
        bind:value={
          () => read("supaMemoryKey", [], ""),
          (value) => write("supaMemoryKey", [], value, "")
        }
      />
    {/if}
    <span class="text-textcolor"
      >{language.summarizationPrompt} <Help key="summarizationPrompt" /></span
    >
    <TextAreaInput
      size="sm"
      id="runtime-memory-supaMemoryPrompt"
      bind:value={
        () => read("supaMemoryPrompt", [], ""),
        (value) => write("supaMemoryPrompt", [], value, "")
      }
      placeholder="Leave it blank to use default"
    />
    <span class="text-textcolor">{language.hypaChunkSize}</span>
    <NumberInput
      size="sm"
      marginBottom
      id="runtime-memory-hypaChunkSize"
      bind:value={
        () => read("hypaChunkSize", [], 100),
        (value) => write("hypaChunkSize", [], value, 100)
      }
      min={100}
    />
    <span class="text-textcolor">{language.hypaAllocatedTokens}</span>
    <NumberInput
      size="sm"
      marginBottom
      id="runtime-memory-hypaAllocatedTokens"
      bind:value={
        () => read("hypaAllocatedTokens", [], 100),
        (value) => write("hypaAllocatedTokens", [], value, 100)
      }
      min={100}
    />
  {:else if values.hypaV3}
    <span
      class="max-w-full mb-6 text-sm text-wrap wrap-break-word text-textcolor2"
      >{language.hypaV3Settings.descriptionLabel}</span
    >
    <span class="text-textcolor">Preset</span>
    <select
      data-memory-preset-selector
      class={"border border-darkborderc focus:border-borderc rounded-md shadow-xs text-textcolor bg-transparent focus:ring-borderc focus:ring-2 focus:outline-hidden transition-colors duration-200 text-md px-4 py-2 mb-1"}
      bind:value={
        () => read("hypaV3PresetId", [], 0),
        (value) => write("hypaV3PresetId", [], value, 0)
      }
    >
      {#each values.hypaV3Presets ?? [] as preset, i}
        <option class="bg-darkbg appearance-none" value={i}
          >{preset.name}</option
        >
      {/each}
    </select>

    <div class="flex items-center mb-8">
      <button
        data-memory-preset-action="add"
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={addPreset}><PlusIcon size={24} /></button
      >
      <button
        data-memory-preset-action="rename"
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={renamePreset}><PencilIcon size={24} /></button
      >
      <button
        data-memory-preset-action="remove"
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={removePreset}><TrashIcon size={24} /></button
      >
      <div class="ml-2 mr-4 w-px h-full bg-darkborderc"></div>
      <button
        data-memory-preset-action="export"
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={exportPreset}><DownloadIcon size={24} /></button
      >
      <button
        data-memory-preset-action="import"
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={importPreset}><HardDriveUploadIcon size={24} /></button
      >
    </div>

    {#if values.hypaV3Presets?.[values.hypaV3PresetId]?.settings}
      {@const settings = values.hypaV3Presets[values.hypaV3PresetId].settings}

      <span class="text-textcolor">{language.SuperMemory} {language.model}</span
      >
      <div class="contents" data-memory-preset-setting="summarizationModel">
        <SelectInput className="mb-4" bind:value={settings.summarizationModel}>
          <OptionInput value="subModel">{language.submodel}</OptionInput>
          {#if "gpu" in navigator}
            <OptionInput value="Qwen3-1.7B-q4f32_1-MLC"
              >Qwen3 1.7B (GPU)</OptionInput
            >
            <OptionInput value="Qwen3-4B-q4f32_1-MLC"
              >Qwen3 4B (GPU)</OptionInput
            >
            <OptionInput value="Qwen3-8B-q4f32_1-MLC"
              >Qwen3 8B (GPU)</OptionInput
            >
          {/if}
        </SelectInput>
      </div>
      <span class="text-textcolor"
        >{language.summarizationPrompt} <Help key="summarizationPrompt" /></span
      >
      <div class="mb-4">
        <div class="contents" data-memory-preset-setting="summarizationPrompt">
          <TextAreaInput
            size="sm"
            placeholder={language.hypaV3Settings.supaMemoryPromptPlaceHolder}
            bind:value={settings.summarizationPrompt}
          />
        </div>
      </div>
      <span class="text-textcolor"
        >{language.reSummarizationPrompt}
        <Help key="reSummarizationPrompt" /></span
      >
      <div class="mb-4">
        <div
          class="contents"
          data-memory-preset-setting="reSummarizationPrompt"
        >
          <TextAreaInput
            size="sm"
            placeholder={language.hypaV3Settings.supaMemoryPromptPlaceHolder}
            bind:value={settings.reSummarizationPrompt}
          />
        </div>
      </div>
      {#await getMaxMemoryRatio() then maxMemoryRatio}
        <span class="text-textcolor"
          >{language.hypaV3Settings.maxMemoryTokensRatioLabel}</span
        >
        <NumberInput marginBottom disabled size="sm" value={maxMemoryRatio} />
      {:catch error}
        <span class="mb-4 text-red-400"
          >{language.hypaV3Settings.maxMemoryTokensRatioError}</span
        >
      {/await}
      <span class="text-textcolor"
        >{language.hypaV3Settings.memoryTokensRatioLabel}
        <Help key="hypaV3MemoryTokensRatio" /></span
      >
      <div class="contents" data-memory-preset-setting="memoryTokensRatio">
        <SliderInput
          marginBottom
          min={0}
          max={1}
          step={0.01}
          fixed={2}
          bind:value={settings.memoryTokensRatio}
        />
      </div>
      <span class="text-textcolor"
        >{language.hypaV3Settings.extraSummarizationRatioLabel}
        <Help key="hypaV3ExtraSummarizationRatio" /></span
      >
      <div
        class="contents"
        data-memory-preset-setting="extraSummarizationRatio"
      >
        <SliderInput
          marginBottom
          min={0}
          max={1 - settings.memoryTokensRatio}
          step={0.01}
          fixed={2}
          bind:value={settings.extraSummarizationRatio}
        />
      </div>
      <span class="text-textcolor"
        >{language.hypaV3Settings.maxChatsPerSummaryLabel}
        <Help key="hypaV3MaxChatsPerSummary" /></span
      >
      <div class="contents" data-memory-preset-setting="maxChatsPerSummary">
        <NumberInput
          marginBottom
          size="sm"
          min={1}
          bind:value={settings.maxChatsPerSummary}
        />
      </div>
      <span class="text-textcolor"
        >{language.hypaV3Settings.queryChatCountLabel}
        <Help key="hypaV3QueryChatCount" /></span
      >
      <div class="contents" data-memory-preset-setting="queryChatCount">
        <NumberInput
          marginBottom
          size="sm"
          min={1}
          max={20}
          bind:value={settings.queryChatCount}
        />
      </div>
      <span class="text-textcolor"
        >{language.hypaV3Settings.summaryChunkSeparatorLabel}
        <Help key="hypaV3SummaryChunkSeparator" /></span
      >
      <div class="contents" data-memory-preset-setting="summaryChunkSeparator">
        <TextInput
          marginBottom
          size="sm"
          bind:value={settings.summaryChunkSeparator}
        />
      </div>
      <span class="text-textcolor"
        >{language.hypaV3Settings.recentMemoryRatioLabel}
        <Help key="hypaV3RecentMemoryRatio" /></span
      >
      <div class="contents" data-memory-preset-setting="recentMemoryRatio">
        <SliderInput
          marginBottom
          min={0}
          max={1}
          step={0.01}
          fixed={2}
          bind:value={
            () => settings.recentMemoryRatio,
            (value) => writeRatio("recentMemoryRatio", value)
          }
        />
      </div>
      <span class="text-textcolor"
        >{language.hypaV3Settings.similarMemoryRatioLabel}
        <Help key="hypaV3SimilarMemoryRatio" /></span
      >
      <div class="contents" data-memory-preset-setting="similarMemoryRatio">
        <SliderInput
          marginBottom
          min={0}
          max={1}
          step={0.01}
          fixed={2}
          bind:value={
            () => settings.similarMemoryRatio,
            (value) => writeRatio("similarMemoryRatio", value)
          }
        />
      </div>
      <span class="text-textcolor"
        >{language.hypaV3Settings.randomMemoryRatioLabel}
        <Help key="hypaV3RandomMemoryRatio" /></span
      >
      <NumberInput
        marginBottom
        disabled
        size="sm"
        value={parseFloat(
          (
            1 -
            settings.recentMemoryRatio -
            settings.similarMemoryRatio
          ).toFixed(2),
        )}
      />
      <div class="mb-2 flex items-center">
        <div
          class="contents"
          data-memory-preset-setting="preserveOrphanedMemory"
        >
          <Check
            name={language.hypaV3Settings.preserveOrphanedMemoryLabel}
            bind:check={settings.preserveOrphanedMemory}
          />
        </div>
        <Help key="hypaV3PreserveOrphanedMemory" />
      </div>
      <div class="mb-2 flex items-center">
        <div class="contents" data-memory-preset-setting="processRegexScript">
          <Check
            name={language.hypaV3Settings.applyRegexScriptWhenRerollingLabel}
            bind:check={settings.processRegexScript}
          />
        </div>
        <Help key="hypaV3ProcessRegexScript" />
      </div>
      <div class="mb-2 flex items-center">
        <div
          class="contents"
          data-memory-preset-setting="doNotSummarizeUserMessage"
        >
          <Check
            name={language.hypaV3Settings.doNotSummarizeUserMessageLabel}
            bind:check={settings.doNotSummarizeUserMessage}
          />
        </div>
        <Help key="hypaV3DoNotSummarizeUserMessage" />
      </div>
      <Accordion name="Advanced Settings" styled>
        <div class="mb-2 flex items-center">
          <div
            class="contents"
            data-memory-preset-setting="useExperimentalImpl"
          >
            <Check
              name="Use Experimental Implementation"
              bind:check={settings.useExperimentalImpl}
            />
          </div>
          <Help key="hypaV3UseExperimentalImpl" />
        </div>
        <div class="mb-2 flex items-center">
          <div class="contents" data-memory-preset-setting="alwaysToggleOn">
            <Check
              name="Always Toggle On"
              bind:check={settings.alwaysToggleOn}
            />
          </div>
          <Help key="hypaV3AlwaysToggleOn" />
        </div>
        {#if settings.useExperimentalImpl}
          <span class="text-textcolor"
            >Summarization Requests Per Minute <Help
              key="hypaV3SummarizationRequestsPerMinute"
            /></span
          >
          <div
            class="contents"
            data-memory-preset-setting="summarizationRequestsPerMinute"
          >
            <NumberInput
              marginBottom
              size="sm"
              min={1}
              bind:value={settings.summarizationRequestsPerMinute}
            />
          </div>
          <span class="text-textcolor"
            >Summarization Max Concurrent <Help
              key="hypaV3SummarizationMaxConcurrent"
            /></span
          >
          <div
            class="contents"
            data-memory-preset-setting="summarizationMaxConcurrent"
          >
            <NumberInput
              marginBottom
              size="sm"
              min={1}
              max={10}
              bind:value={settings.summarizationMaxConcurrent}
            />
          </div>
          <span class="text-textcolor"
            >Embedding Requests Per Minute <Help
              key="hypaV3EmbeddingRequestsPerMinute"
            /></span
          >
          <div
            class="contents"
            data-memory-preset-setting="embeddingRequestsPerMinute"
          >
            <NumberInput
              marginBottom
              size="sm"
              min={1}
              bind:value={settings.embeddingRequestsPerMinute}
            />
          </div>
          <span class="text-textcolor"
            >Embedding Max Concurrent <Help
              key="hypaV3EmbeddingMaxConcurrent"
            /></span
          >
          <div
            class="contents"
            data-memory-preset-setting="embeddingMaxConcurrent"
          >
            <NumberInput
              marginBottom
              size="sm"
              min={1}
              max={10}
              bind:value={settings.embeddingMaxConcurrent}
            />
          </div>
        {:else}
          <div class="mb-2 flex items-center">
            <div
              class="contents"
              data-memory-preset-setting="enableSimilarityCorrection"
            >
              <Check
                name={language.hypaV3Settings.enableSimilarityCorrectionLabel}
                bind:check={settings.enableSimilarityCorrection}
              />
            </div>
            <Help key="hypaV3EnableSimilarityCorrection" />
          </div>
        {/if}
      </Accordion>
    {/if}

    <div class="mb-8"></div>
  {:else if values.supaModelType !== "none" && values.hypav2 === false && values.hypaV3 === false}
    <span
      class="mb-2 text-textcolor2 text-sm text-wrap wrap-break-word max-w-full"
      >{language.supaDesc}</span
    >
    <span class="text-textcolor mt-4"
      >{language.SuperMemory} {language.model}</span
    >
    <div class="contents" data-memory-field="supaModelType">
      <SelectInput
        className="mt-2 mb-2"
        bind:value={
          () => read("supaModelType", [], "none"),
          (value) => write("supaModelType", [], value, "none")
        }
      >
        <OptionInput value="distilbart"
          >distilbart-cnn-6-6 (Free/Local)</OptionInput
        >
        <OptionInput value="instruct35">OpenAI 3.5 Turbo Instruct</OptionInput>
        <OptionInput value="subModel">{language.submodel}</OptionInput>
      </SelectInput>
    </div>
    <span class="text-textcolor">{language.maxSupaChunkSize}</span>
    <NumberInput
      size="sm"
      marginBottom
      id="runtime-memory-maxSupaChunkSize"
      bind:value={
        () => read("maxSupaChunkSize", [], 100),
        (value) => write("maxSupaChunkSize", [], value, 100)
      }
      min={100}
    />
    {#if values.supaModelType === "davinci" || values.supaModelType === "curie" || values.supaModelType === "instruct35"}
      <span class="text-textcolor">{language.SuperMemory} OpenAI Key</span>
      <TextInput
        size="sm"
        marginBottom
        id="runtime-memory-supaMemoryKey"
        bind:value={
          () => read("supaMemoryKey", [], ""),
          (value) => write("supaMemoryKey", [], value, "")
        }
      />
    {/if}
    {#if values.supaModelType !== "none"}
      <span class="text-textcolor">{language.SuperMemory} Prompt</span>
      <TextInput
        size="sm"
        marginBottom
        id="runtime-memory-supaMemoryPrompt"
        bind:value={
          () => read("supaMemoryPrompt", [], ""),
          (value) => write("supaMemoryPrompt", [], value, "")
        }
        placeholder="Leave it blank to use default"
      />
    {/if}
    <div class="flex mb-4">
      <div class="contents" data-memory-field="hypaMemory">
        <Check
          bind:check={
            () => read("hypaMemory", [], false),
            (value) => write("hypaMemory", [], value, false)
          }
          name={language.enable + " " + language.HypaMemory}
        />
      </div>
    </div>
  {/if}

  <span class="text-textcolor"
    >{language.embedding} <Help key="embedding" /></span
  >
  <div class="contents" data-memory-field="hypaModel">
    <SelectInput
      className="mb-4"
      bind:value={
        () => read("hypaModel", [], "MiniLM"),
        (value) => write("hypaModel", [], value, "MiniLM")
      }
    >
      {#if "gpu" in navigator}
        <OptionInput value="MiniLMGPU">MiniLM L6 v2 (GPU)</OptionInput>
        <OptionInput value="nomicGPU">Nomic Embed Text v1.5 (GPU)</OptionInput>
        <OptionInput value="bgeSmallEnGPU">BGE Small English (GPU)</OptionInput>
        <OptionInput value="bgem3GPU">BGE Medium 3 (GPU)</OptionInput>
        <OptionInput value="multiMiniLMGPU"
          >Multilingual MiniLM L12 v2 (GPU)</OptionInput
        >
        <OptionInput value="bgeM3KoGPU">BGE Medium 3 Korean (GPU)</OptionInput>
      {/if}
      <OptionInput value="MiniLM">MiniLM L6 v2 (CPU)</OptionInput>
      <OptionInput value="nomic">Nomic Embed Text v1.5 (CPU)</OptionInput>
      <OptionInput value="bgeSmallEn">BGE Small English (CPU)</OptionInput>
      <OptionInput value="bgem3">BGE Medium 3 (CPU)</OptionInput>
      <OptionInput value="multiMiniLM"
        >Multilingual MiniLM L12 v2 (CPU)</OptionInput
      >
      <OptionInput value="bgeM3Ko">BGE Medium 3 Korean (CPU)</OptionInput>
      <OptionInput value="openai3small"
        >OpenAI text-embedding-3-small</OptionInput
      >
      <OptionInput value="openai3large"
        >OpenAI text-embedding-3-large</OptionInput
      >
      <OptionInput value="ada">OpenAI Ada</OptionInput>
      <OptionInput value="voyageContext3">Voyage Context 3</OptionInput>
      <OptionInput value="custom">Custom (OpenAI-compatible)</OptionInput>
    </SelectInput>
  </div>

  {#if values.hypaModel === "openai3small" || values.hypaModel === "openai3large" || values.hypaModel === "ada"}
    <span class="text-textcolor">OpenAI API Key</span>
    <TextInput
      size="sm"
      marginBottom
      id="runtime-memory-supaMemoryKey"
      bind:value={
        () => read("supaMemoryKey", [], ""),
        (value) => write("supaMemoryKey", [], value, "")
      }
    />
  {/if}

  {#if values.hypaModel === "custom"}
    <span class="text-textcolor">URL</span>
    <TextInput
      size="sm"
      marginBottom
      id="runtime-memory-hypaCustomSettings.url"
      bind:value={
        () => read("hypaCustomSettings", ["url"], ""),
        (value) => write("hypaCustomSettings", ["url"], value, "")
      }
    />
    <span class="text-textcolor">Key/Password</span>
    <TextInput
      size="sm"
      marginBottom
      id="runtime-memory-hypaCustomSettings.key"
      bind:value={
        () => read("hypaCustomSettings", ["key"], ""),
        (value) => write("hypaCustomSettings", ["key"], value, "")
      }
    />
    <span class="text-textcolor">Request Model</span>
    <TextInput
      size="sm"
      marginBottom
      id="runtime-memory-hypaCustomSettings.model"
      bind:value={
        () => read("hypaCustomSettings", ["model"], ""),
        (value) => write("hypaCustomSettings", ["model"], value, "")
      }
    />
  {/if}

  {#if values.hypaModel === "voyageContext3"}
    <span class="text-textcolor">Voyage API Key</span>
    <TextInput
      size="sm"
      marginBottom
      hideText={DBState.db.hideApiKey}
      id="runtime-memory-voyageApiKey"
      bind:value={
        () => read("voyageApiKey", [], ""),
        (value) => write("voyageApiKey", [], value, "")
      }
    />
  {/if}
</div>
