<script lang="ts">
  import { untrack } from "svelte";
  import Check from "src/lib/UI/GUI/CheckInput.svelte";
  import { language } from "src/lang";
  import Help from "src/lib/Others/Help.svelte";

  import { DBState } from "src/ts/stores.svelte";
  import { customProviderStore } from "src/ts/plugins/plugins.svelte";
  import { downloadFile } from "src/ts/globalApi.svelte";
  import { isTauri } from "src/ts/platform";
  import { tokenizeAccurate, tokenizerList } from "src/ts/tokenizer";
  import ModelList from "src/lib/UI/ModelList.svelte";
  import DropList from "src/lib/SideBars/DropList.svelte";
  import {
    PlusIcon,
    TrashIcon,
    HardDriveUploadIcon,
    DownloadIcon,
    UploadIcon,
  } from "@lucide/svelte";
  import TextInput from "src/lib/UI/GUI/TextInput.svelte";
  import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
  import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
  import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
  import Button from "src/lib/UI/GUI/Button.svelte";
  import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
  import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
  import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
  import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
  import {
    getOpenRouterModels,
    toModelGridItem as orToGridItem,
  } from "src/ts/model/openrouter";
  import {
    getNanoGPTModels,
    getNanoGPTSubscriptionModels,
    toModelGridItem as ngToGridItem,
  } from "src/ts/model/nanogpt";
  import { getOllamaModels } from "src/ts/model/ollama";
  import ModelGrid from "src/lib/UI/ModelGrid.svelte";
  import NanoGPTDashboard from "src/lib/UI/NanoGPTDashboard.svelte";
  import NanoGPTProviderPicker from "src/lib/UI/NanoGPTProviderPicker.svelte";
  import type { ModelGridPinnedItem } from "src/ts/model/modelGrid";
  import OobaSettings from "./OobaSettings.svelte";
  import Accordion from "src/lib/UI/Accordion.svelte";
  import OpenrouterSettings from "./OpenrouterSettings.svelte";
  import ChatFormatSettings from "./ChatFormatSettings.svelte";
  import PromptSettings from "./PromptSettings.svelte";
  import { openPresetList } from "src/ts/stores.svelte";
  import { selectSingleFile } from "src/ts/util";
  import {
    getModelInfo,
    LLMFlags,
    LLMFormat,
    LLMProvider,
  } from "src/ts/model/modellist";
  import { resolveClaudeThinkingType } from "src/ts/model/types";
  import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
  import SettingRenderer from "../SettingRenderer.svelte";
  import { allBasicParameterItems } from "src/ts/setting/botSettingsParamsData";
  import SeparateParametersSection from "./SeparateParametersSection.svelte";
  import AuxModelSelectors from "./Model/AuxModelSelectors.svelte";

  import {
    getSettingDatabase,
    setSettingValues,
    setFieldValue,
  } from "src/ts/runtime/fieldControls";
  import { entityRuntimeEnabled } from "src/ts/runtime/browserRuntimeState.svelte";
  import { botSettingValues } from "src/ts/runtime/botSettingIntents";
  import SettingObjectDraft from "../Wrappers/SettingObjectDraft.svelte";
  import type {
    SettingPath,
    SettingChange,
  } from "src/ts/runtime/settingIntents";

  const settings = $derived(getSettingDatabase(DBState.db));
  function writeMany(changes: SettingChange[]) {
    const values = botSettingValues(
      settings,
      changes,
      (id) => getModelInfo(id).flags,
    );
    setSettingValues(DBState.db, values);
  }
  function write(path: SettingPath, value: unknown) {
    writeMany([{ path, value }]);
  }

  const openrouterPinnedItems: ModelGridPinnedItem[] = [
    { id: "risu/free", displayName: "Free Auto", providerName: "Risu" },
    {
      id: "openrouter/auto",
      displayName: "OpenRouter Auto",
      providerName: "OpenRouter",
    },
  ];

  // Reset model selection and display name when subscription mode toggles
  let _nanogptSubModeInitialized = false;
  $effect(() => {
    if (entityRuntimeEnabled) return;
    const _sub = settings.nanogptUseSubscriptionEndpoint;
    if (!_nanogptSubModeInitialized) {
      _nanogptSubModeInitialized = true;
      return;
    }
    write(["nanogptRequestModel"], "");
    write(["nanogptRequestModelName"], "");
  });

  // Reset provider selection to Auto when the model or subscription mode changes
  let _nanogptProviderResetInitialized = false;
  $effect(() => {
    if (entityRuntimeEnabled) return;
    const _model = settings.nanogptRequestModel;
    const _sub = settings.nanogptUseSubscriptionEndpoint;
    if (!_nanogptProviderResetInitialized) {
      _nanogptProviderResetInitialized = true;
      return;
    }
    write(["nanogptProvider"], "");
  });

  // Reset subscription mode (and related state) when API key is cleared
  let _nanogptKeyInitialized = false;
  $effect(() => {
    if (entityRuntimeEnabled) return;
    const _key = settings.nanogptKey;
    if (!_nanogptKeyInitialized) {
      _nanogptKeyInitialized = true;
      return;
    }
    if (!_key) {
      write(["nanogptUseSubscriptionEndpoint"], false);
      write(["nanogptSubscriptionState"], "");
      write(["nanogptRequestModel"], "");
      write(["nanogptRequestModelName"], "");
      write(["nanogptProvider"], "");
    }
  });

  let tokens = $state({
    mainPrompt: 0,
    jailbreak: 0,
    globalNote: 0,
  });

  interface Props {
    goPromptTemplate?: any;
  }

  let { goPromptTemplate = () => {} }: Props = $props();

  async function loadTokenize() {
    tokens.mainPrompt = await tokenizeAccurate(settings.mainPrompt, true);
    tokens.jailbreak = await tokenizeAccurate(settings.jailbreak, true);
    tokens.globalNote = await tokenizeAccurate(settings.globalNote, true);
  }

  $effect.pre(() => {
    if (entityRuntimeEnabled) return;
    if (
      settings.aiModel === "textgen_webui" ||
      settings.subModel === "mancer"
    ) {
      write(
        ["useStreaming"],
        settings.textgenWebUIStreamURL.startsWith("wss://"),
      );
    }
  });

  let subscription = $state(
    untrack(() => ({
      key: settings.nanogptKey,
      state: settings.nanogptSubscriptionState,
    })),
  );
  const subscriptionAvailable = $derived(
    entityRuntimeEnabled
      ? subscription.key === settings.nanogptKey
        ? subscription.state
        : ""
      : settings.nanogptSubscriptionState,
  );
  let submenu = $state(untrack(() => (settings.useLegacyGUI ? -1 : 0)));
  let modelInfo = $derived(getModelInfo(settings.aiModel));
  let subModelInfo = $derived(getModelInfo(settings.subModel));
  let nanogptInputMode = $state<"list" | "manual">(
    untrack(() =>
      settings.nanogptRequestModel && !settings.nanogptRequestModelName
        ? "manual"
        : "list",
    ),
  );
  // svelte-ignore state_referenced_locally
  let prevNanogptInputMode = nanogptInputMode;
  $effect(() => {
    if (!entityRuntimeEnabled && nanogptInputMode !== prevNanogptInputMode) {
      write(["nanogptRequestModel"], "");
      write(["nanogptRequestModelName"], "");
      prevNanogptInputMode = nanogptInputMode;
    }
  });

  $effect(() => {
    if (entityRuntimeEnabled) return;
    const resolved = resolveClaudeThinkingType(
      modelInfo.flags,
      settings.thinkingType,
    );
    if (resolved !== settings.thinkingType) {
      write(["thinkingType"], resolved);
    }
  });

  let usesOllamaLocal = $derived(
    settings.aiModel === "ollama-hosted" ||
      settings.subModel === "ollama-hosted",
  );
  let usesOllamaCloud = $derived(
    settings.aiModel === "ollama-cloud" || settings.subModel === "ollama-cloud",
  );
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.chatBot}</h2>

{#if submenu !== -1}
  <div class="flex w-full rounded-md border border-darkborderc mb-4">
    <button
      onclick={() => {
        submenu = 0;
      }}
      class="p-2 flex-1 border-r border-darkborderc"
      class:bg-darkbutton={submenu === 0}
    >
      <span>{language.model}</span>
    </button>
    <button
      onclick={() => {
        submenu = 1;
      }}
      class="p2 flex-1 border-r border-darkborderc"
      class:bg-darkbutton={submenu === 1}
    >
      <span>{language.parameters}</span>
    </button>
    <button
      onclick={() => {
        submenu = 2;
      }}
      class="p-2 flex-1 border-r border-darkborderc"
      class:bg-darkbutton={submenu === 2}
    >
      <span>{language.prompt}</span>
    </button>
    <button
      onclick={() => {
        submenu = 3;
      }}
      class="p-2 flex-1"
      class:bg-darkbutton={submenu === 3}
    >
      <span>{language.others}</span>
    </button>
  </div>
{/if}

{#if submenu === 0 || submenu === -1}
  <span class="text-textcolor mt-4">{language.model} <Help key="model" /></span>
  <ModelList
    ariaLabel={language.model}
    bind:value={() => settings.aiModel, (value) => write(["aiModel"], value)}
  />

  <span class="text-textcolor mt-2"
    >{language.submodel} <Help key="submodel" /></span
  >
  <ModelList
    ariaLabel={language.submodel}
    bind:value={() => settings.subModel, (value) => write(["subModel"], value)}
  />

  {#if modelInfo.provider === LLMProvider.GoogleCloud || subModelInfo.provider === LLMProvider.GoogleCloud}
    <span class="text-textcolor">GoogleAI API Key</span>
    <TextInput
      marginBottom={true}
      size={"sm"}
      placeholder="..."
      hideText={settings.hideApiKey}
      bind:value={
        () => settings.google.accessToken,
        (value) => write(["google", "accessToken"], value)
      }
    />
  {/if}
  {#if modelInfo.provider === LLMProvider.VertexAI || subModelInfo.provider === LLMProvider.VertexAI}
    <span class="text-textcolor">Project ID</span>
    <TextInput
      marginBottom={true}
      size={"sm"}
      placeholder="..."
      bind:value={
        () => settings.google.projectId,
        (value) => write(["google", "projectId"], value)
      }
    />
    <span class="text-textcolor">Vertex Client Email</span>
    <TextInput
      marginBottom={true}
      size={"sm"}
      placeholder="..."
      bind:value={
        () => settings.vertexClientEmail,
        (value) => write(["vertexClientEmail"], value)
      }
    />
    <span class="text-textcolor">Vertex Private Key</span>
    <TextInput
      marginBottom={true}
      size={"sm"}
      placeholder="..."
      hideText={settings.hideApiKey}
      bind:value={
        () => settings.vertexPrivateKey,
        (value) => write(["vertexPrivateKey"], value)
      }
    />
    <span class="text-textcolor">Region</span>
    <SelectInput
      value={settings.vertexRegion}
      onchange={(e) => {
        write(["vertexRegion"], e.currentTarget.value);
      }}
    >
      <OptionInput value={"global"}>global</OptionInput>
      <OptionInput value={"us-central1"}>us-central1</OptionInput>
      <OptionInput value={"us-west1"}>us-west1</OptionInput>
    </SelectInput>
  {/if}
  {#if modelInfo.provider === LLMProvider.NovelList || subModelInfo.provider === LLMProvider.NovelList}
    <span class="text-textcolor">NovelList {language.apiKey}</span>
    <TextInput
      hideText={settings.hideApiKey}
      marginBottom={true}
      size={"sm"}
      placeholder="..."
      bind:value={
        () => settings.novellistAPI, (value) => write(["novellistAPI"], value)
      }
    />
  {/if}
  {#if settings.aiModel.startsWith("mancer") || settings.subModel.startsWith("mancer")}
    <span class="text-textcolor">Mancer {language.apiKey}</span>
    <TextInput
      hideText={settings.hideApiKey}
      marginBottom={true}
      size={"sm"}
      placeholder="..."
      bind:value={
        () => settings.mancerHeader, (value) => write(["mancerHeader"], value)
      }
    />
  {/if}
  {#if modelInfo.provider === LLMProvider.Anthropic || subModelInfo.provider === LLMProvider.Anthropic || modelInfo.provider === LLMProvider.AWS || subModelInfo.provider === LLMProvider.AWS}
    <span class="text-textcolor">Claude {language.apiKey}</span>
    <TextInput
      hideText={settings.hideApiKey}
      marginBottom={true}
      size={"sm"}
      placeholder="..."
      bind:value={
        () => settings.claudeAPIKey, (value) => write(["claudeAPIKey"], value)
      }
    />
  {/if}
  {#if modelInfo.provider === LLMProvider.Mistral || subModelInfo.provider === LLMProvider.Mistral}
    <span class="text-textcolor">Mistral {language.apiKey}</span>
    <TextInput
      hideText={settings.hideApiKey}
      marginBottom={true}
      size={"sm"}
      placeholder="..."
      bind:value={
        () => settings.mistralKey, (value) => write(["mistralKey"], value)
      }
    />
  {/if}
  {#if modelInfo.provider === LLMProvider.NovelAI || subModelInfo.provider === LLMProvider.NovelAI}
    <span class="text-textcolor">NovelAI Bearer Token</span>
    <TextInput
      bind:value={
        () => settings.novelai.token,
        (value) => write(["novelai", "token"], value)
      }
    />
  {/if}
  {#if settings.aiModel === "reverse_proxy" || settings.subModel === "reverse_proxy"}
    <span class="text-textcolor mt-2">URL <Help key="forceUrl" /></span>
    <TextInput
      id="risu-proxy-url"
      marginBottom={false}
      size={"sm"}
      bind:value={
        () => settings.forceReplaceUrl,
        (value) => write(["forceReplaceUrl"], value)
      }
      placeholder="https//..."
    />
    <span class="text-textcolor mt-4"> {language.proxyAPIKey}</span>
    <TextInput
      id="risu-proxy-key"
      hideText={settings.hideApiKey}
      marginBottom={false}
      size={"sm"}
      placeholder="leave it blank if it hasn't password"
      bind:value={
        () => settings.proxyKey, (value) => write(["proxyKey"], value)
      }
    />
    <span class="text-textcolor mt-4"> {language.proxyRequestModel}</span>
    <TextInput
      id="risu-proxy-model"
      marginBottom={false}
      size={"sm"}
      bind:value={
        () => settings.customProxyRequestModel,
        (value) => write(["customProxyRequestModel"], value)
      }
      placeholder="Name"
    />
    <span class="text-textcolor mt-4"> {language.format}</span>
    <SelectInput
      value={settings.customAPIFormat.toString()}
      onchange={(e) => {
        write(
          ["customAPIFormat"],
          parseInt(e.currentTarget.value) as LLMFormat,
        );
      }}
    >
      <OptionInput value={LLMFormat.OpenAICompatible.toString()}>
        OpenAI Compatible
      </OptionInput>
      <OptionInput value={LLMFormat.OpenAIResponseAPI.toString()}>
        OpenAI Response API
      </OptionInput>
      <OptionInput value={LLMFormat.Anthropic.toString()}>
        Anthropic Claude
      </OptionInput>
      <OptionInput value={LLMFormat.Mistral.toString()}>Mistral</OptionInput>
      <OptionInput value={LLMFormat.GoogleCloud.toString()}>
        Google Cloud
      </OptionInput>
      <OptionInput value={LLMFormat.Cohere.toString()}>Cohere</OptionInput>
    </SelectInput>
  {/if}
  {#if modelInfo.provider === LLMProvider.Cohere || subModelInfo.provider === LLMProvider.Cohere}
    <span class="text-textcolor mt-4">Cohere {language.apiKey}</span>
    <TextInput
      hideText={settings.hideApiKey}
      marginBottom={false}
      size={"sm"}
      bind:value={
        () => settings.cohereAPIKey, (value) => write(["cohereAPIKey"], value)
      }
    />
  {/if}
  {#if usesOllamaLocal || usesOllamaCloud}
    {#if usesOllamaLocal}
      <span class="text-textcolor mt-4">Ollama URL</span>
      <TextInput
        marginBottom={false}
        size={"sm"}
        bind:value={
          () => settings.ollamaURL, (value) => write(["ollamaURL"], value)
        }
      />
    {/if}

    {#if usesOllamaCloud}
      <span class="text-textcolor mt-4">Ollama {language.model}</span>
      <SegmentedControl
        bind:value={
          () => settings.ollamaInputMode,
          (value) => write(["ollamaInputMode"], value)
        }
        options={[
          {
            value: "list",
            label:
              (language as any).nanoGPTSelectFromList || "Select from List",
          },
          {
            value: "manual",
            label: (language as any).nanoGPTManualInput || "Manual Input",
          },
        ]}
        size="md"
      />

      {#if settings.ollamaInputMode === "manual"}
        <TextInput
          marginBottom={false}
          size={"sm"}
          bind:value={
            () => settings.ollamaCloudModel,
            (value) => write(["ollamaCloudModel"], value)
          }
          placeholder="Model"
        />
      {:else}
        {#await getOllamaModels(settings.ollamaURL, "cloud", settings.ollamaApiKey)}
          <ModelGrid
            bind:value={
              () => settings.ollamaCloudModel,
              (value) => write(["ollamaCloudModel"], value)
            }
            loading={true}
          />
        {:then cloudModels}
          <ModelGrid
            bind:value={
              () => settings.ollamaCloudModel,
              (value) => {
                if (!entityRuntimeEnabled) write(["ollamaCloudModel"], value);
              }
            }
            items={cloudModels ?? []}
            selectedLabelOverride={settings.ollamaCloudModel
              ? `Cloud / ${settings.ollamaCloudModelName || settings.ollamaCloudModel}`
              : undefined}
            onselect={(_id, name) => {
              writeMany([
                { path: ["ollamaCloudModel"], value: _id },
                { path: ["ollamaModelSource"], value: "cloud" },
                { path: ["ollamaCloudModelName"], value: name },
              ]);
            }}
          />
        {/await}
      {/if}

      <span class="text-textcolor mt-4">Ollama {language.apiKey}</span>
      <TextInput
        hideText={settings.hideApiKey}
        marginBottom={false}
        size={"sm"}
        bind:value={
          () => settings.ollamaApiKey, (value) => write(["ollamaApiKey"], value)
        }
      />

      <span class="text-textcolor mt-4">Ollama {language.format}</span>
      <SelectInput
        value={settings.ollamaRequestFormat.toString()}
        onchange={(e) => {
          write(
            ["ollamaRequestFormat"],
            parseInt(e.currentTarget.value) as LLMFormat,
          );
        }}
      >
        <OptionInput value={LLMFormat.Ollama.toString()}>
          Ollama SDK
        </OptionInput>
        <OptionInput value={LLMFormat.OpenAICompatible.toString()}>
          OpenAI Compatible
        </OptionInput>
        <OptionInput value={LLMFormat.OpenAIResponseAPI.toString()}>
          OpenAI Response API
        </OptionInput>
        <OptionInput value={LLMFormat.Anthropic.toString()}>
          Anthropic Claude
        </OptionInput>
      </SelectInput>

      <div class="mt-2">
        <CheckInput
          bind:check={
            () => !!settings.useStreaming,
            (value) => write(["useStreaming"], value)
          }
          name={`Response ${language.streaming}`}
        />
      </div>
    {/if}

    {#if usesOllamaLocal}
      <span class="text-textcolor mt-4">Ollama Model</span>
      <TextInput
        marginBottom={false}
        size={"sm"}
        bind:value={
          () => settings.ollamaModel, (value) => write(["ollamaModel"], value)
        }
        placeholder="Model"
      />
    {/if}

    {#if usesOllamaLocal || (usesOllamaCloud && settings.ollamaRequestFormat === LLMFormat.Ollama)}
      <span class="text-textcolor mt-4">Ollama Thinking</span>
      <SelectInput
        bind:value={
          () => settings.ollamaThinkingMode,
          (value) => write(["ollamaThinkingMode"], value)
        }
      >
        <OptionInput value="auto">Auto</OptionInput>
        <OptionInput value="off">Off</OptionInput>
        <OptionInput value="on">On</OptionInput>
        <OptionInput value="low">Low</OptionInput>
        <OptionInput value="medium">Medium</OptionInput>
        <OptionInput value="high">High</OptionInput>
      </SelectInput>
    {/if}
  {/if}
  {#if settings.aiModel === "nanogpt" || settings.subModel === "nanogpt"}
    <span class="text-textcolor mt-4">NanoGPT {language.apiKey}</span>
    <TextInput
      id="risu-nanogpt-key"
      hideText={settings.hideApiKey}
      marginBottom={false}
      size={"sm"}
      bind:value={
        () => settings.nanogptKey, (value) => write(["nanogptKey"], value)
      }
    />

    <NanoGPTDashboard
      apiKey={settings.nanogptKey}
      onSubscription={(state, key) => {
        if (key === settings.nanogptKey) subscription = { key, state };
      }}
    />

    {#if subscriptionAvailable === "active" || subscriptionAvailable === "grace"}
      <div class="flex items-center mt-3">
        <CheckInput
          bind:check={
            () => !!settings.nanogptUseSubscriptionEndpoint,
            (value) => write(["nanogptUseSubscriptionEndpoint"], value)
          }
          name={language.nanoGPTUseSubscriptionEndpoint}
        />
      </div>
    {/if}

    <span class="text-textcolor mt-4">NanoGPT {language.model}</span>
    <SegmentedControl
      bind:value={
        () => nanogptInputMode,
        (value) => {
          if (entityRuntimeEnabled && value !== nanogptInputMode)
            writeMany([
              { path: ["nanogptRequestModel"], value: "" },
              { path: ["nanogptRequestModelName"], value: "" },
            ]);
          nanogptInputMode = value;
        }
      }
      options={[
        {
          value: "list",
          label: (language as any).nanoGPTSelectFromList || "Select from List",
        },
        {
          value: "manual",
          label: (language as any).nanoGPTManualInput || "Manual Input",
        },
      ]}
      size="md"
    />

    {#if nanogptInputMode === "manual"}
      <TextInput
        marginBottom={false}
        size={"sm"}
        bind:value={
          () => settings.nanogptRequestModel,
          (value) => write(["nanogptRequestModel"], value)
        }
        placeholder={(language as any).nanoGPTManualModelSelect ||
          "Manual Model Select"}
      />
    {:else}
      {#await Promise.all( [getNanoGPTModels(), getNanoGPTSubscriptionModels(settings.nanogptKey)], )}
        <ModelGrid
          bind:value={
            () => settings.nanogptRequestModel,
            (value) => write(["nanogptRequestModel"], value)
          }
          loading={true}
        />
      {:then [regular, sub]}
        <ModelGrid
          bind:value={
            () => settings.nanogptRequestModel,
            (value) => {
              if (!entityRuntimeEnabled) write(["nanogptRequestModel"], value);
            }
          }
          items={settings.nanogptUseSubscriptionEndpoint
            ? (sub ?? []).map(ngToGridItem)
            : (regular ?? []).map(ngToGridItem)}
          showSubBadge={settings.nanogptUseSubscriptionEndpoint}
          selectedLabelOverride={settings.nanogptRequestModel &&
          !settings.nanogptRequestModelName
            ? settings.nanogptRequestModel
            : undefined}
          onselect={(_id, name) => {
            writeMany([
              { path: ["nanogptRequestModel"], value: _id },
              { path: ["nanogptRequestModelName"], value: name },
            ]);
          }}
        />
        {#if !settings.nanogptUseSubscriptionEndpoint}
          <NanoGPTProviderPicker
            apiKey={settings.nanogptKey}
            modelId={settings.nanogptRequestModel}
            bind:value={
              () => settings.nanogptProvider,
              (value) => write(["nanogptProvider"], value)
            }
          />
        {/if}
      {/await}
    {/if}
  {/if}
  {#if settings.aiModel === "openrouter" || settings.subModel === "openrouter"}
    <span class="text-textcolor mt-4">OpenRouter {language.apiKey}</span>
    <TextInput
      hideText={settings.hideApiKey}
      marginBottom={false}
      size={"sm"}
      bind:value={
        () => settings.openrouterKey, (value) => write(["openrouterKey"], value)
      }
    />

    <span class="text-textcolor mt-4">OpenRouter {language.model}</span>
    {#await getOpenRouterModels()}
      <ModelGrid
        bind:value={
          () => settings.openrouterRequestModel,
          (value) => write(["openrouterRequestModel"], value)
        }
        pinnedItems={openrouterPinnedItems}
        loading={true}
      />
    {:then m}
      <ModelGrid
        bind:value={
          () => settings.openrouterRequestModel,
          (value) => write(["openrouterRequestModel"], value)
        }
        items={(m ?? []).map(orToGridItem)}
        pinnedItems={openrouterPinnedItems}
      />
    {/await}
  {/if}
  {#if settings.aiModel === "openrouter" || settings.aiModel === "reverse_proxy"}
    <span class="text-textcolor">{language.tokenizer}</span>
    <SelectInput
      bind:value={
        () => settings.customTokenizer,
        (value) => write(["customTokenizer"], value)
      }
    >
      {#each tokenizerList as entry}
        <OptionInput value={entry[0]}>{entry[1]}</OptionInput>
      {/each}
    </SelectInput>
  {/if}
  {#if modelInfo.provider === LLMProvider.OpenAI || subModelInfo.provider === LLMProvider.OpenAI}
    <span class="text-textcolor"
      >OpenAI {language.apiKey} <Help key="oaiapikey" /></span
    >
    <TextInput
      hideText={settings.hideApiKey}
      marginBottom={false}
      size={"sm"}
      bind:value={
        () => settings.openAIKey, (value) => write(["openAIKey"], value)
      }
      placeholder="sk-XXXXXXXXXXXXXXXXXXXX"
    />
  {/if}

  {#if modelInfo.keyIdentifier}
    <span class="text-textcolor">{modelInfo.name} {language.apiKey}</span>
    <TextInput
      hideText={settings.hideApiKey}
      marginBottom={false}
      size={"sm"}
      bind:value={
        () => settings.OaiCompAPIKeys[modelInfo.keyIdentifier],
        (value) => write(["OaiCompAPIKeys", modelInfo.keyIdentifier], value)
      }
      placeholder="..."
    />
  {/if}

  {#if subModelInfo.keyIdentifier && subModelInfo.keyIdentifier !== modelInfo.keyIdentifier}
    <span class="text-textcolor">{subModelInfo.name} {language.apiKey}</span>
    <TextInput
      hideText={settings.hideApiKey}
      marginBottom={false}
      size={"sm"}
      bind:value={
        () => settings.OaiCompAPIKeys[subModelInfo.keyIdentifier],
        (value) => write(["OaiCompAPIKeys", subModelInfo.keyIdentifier], value)
      }
      placeholder="..."
    />
  {/if}

  <div class="py-2 flex flex-col gap-2 mb-4">
    {#if !usesOllamaCloud && (modelInfo.flags.includes(LLMFlags.hasStreaming) || subModelInfo.flags.includes(LLMFlags.hasStreaming))}
      <Check
        bind:check={
          () => !!settings.useStreaming,
          (value) => write(["useStreaming"], value)
        }
        name={`Response ${language.streaming}`}
      />

      {#if settings.useStreaming && (modelInfo.flags.includes(LLMFlags.geminiThinking) || subModelInfo.flags.includes(LLMFlags.geminiThinking))}
        <Check
          bind:check={
            () => !!settings.streamGeminiThoughts,
            (value) => write(["streamGeminiThoughts"], value)
          }
          name={`Stream Gemini Thoughts`}
        />
      {/if}
    {/if}

    {#if settings.aiModel === "reverse_proxy" || settings.subModel === "reverse_proxy"}
      <Check
        bind:check={
          () => !!settings.reverseProxyOobaMode,
          (value) => write(["reverseProxyOobaMode"], value)
        }
        name={`${language.reverseProxyOobaMode}`}
      />
    {/if}
    {#if modelInfo.provider === LLMProvider.NovelAI || subModelInfo.provider === LLMProvider.NovelAI}
      <Check
        bind:check={
          () => !!settings.NAIadventure,
          (value) => write(["NAIadventure"], value)
        }
        name={language.textAdventureNAI}
      />

      <Check
        bind:check={
          () => !!settings.NAIappendName,
          (value) => write(["NAIappendName"], value)
        }
        name={language.appendNameNAI}
      />
    {/if}
  </div>

  {#if settings.aiModel === "custom" || settings.subModel === "custom"}
    <span class="text-textcolor mt-2">{language.plugin}</span>
    <SelectInput
      className="mt-2 mb-4"
      bind:value={
        () => settings.currentPluginProvider,
        (value) => write(["currentPluginProvider"], value)
      }
    >
      <OptionInput value="">None</OptionInput>
      {#each $customProviderStore as plugin}
        <OptionInput value={plugin}>{plugin}</OptionInput>
      {/each}
    </SelectInput>
  {/if}

  {#if settings.aiModel === "kobold" || settings.subModel === "kobold"}
    <span class="text-textcolor">Kobold URL</span>
    <TextInput
      marginBottom={true}
      bind:value={
        () => settings.koboldURL, (value) => write(["koboldURL"], value)
      }
    />
  {/if}

  {#if settings.aiModel === "echo_model" || settings.subModel === "echo_model"}
    <span class="text-textcolor mt-2">Echo Message</span>
    <TextAreaInput
      margin="bottom"
      bind:value={
        () => settings.echoMessage, (value) => write(["echoMessage"], value)
      }
      placeholder={"The message you want to receive as the bot's response\n(e.g., Lumi tilts her head, her white hair sliding down as her pretty green and aqua eyes sparkle…)"}
    />
    <span class="text-textcolor mt-2">Echo Delay (Seconds)</span>
    <NumberInput
      marginBottom={true}
      bind:value={
        () => settings.echoDelay, (value) => write(["echoDelay"], value)
      }
      min={0}
    />
  {/if}

  {#if settings.aiModel.startsWith("horde") || settings.subModel.startsWith("horde")}
    <span class="text-textcolor">Horde {language.apiKey}</span>
    <TextInput
      hideText={settings.hideApiKey}
      marginBottom={true}
      bind:value={
        () => settings.hordeConfig.apiKey,
        (value) => write(["hordeConfig", "apiKey"], value)
      }
    />
  {/if}
  {#if settings.aiModel === "textgen_webui" || settings.subModel === "textgen_webui" || settings.aiModel === "mancer" || settings.subModel === "mancer"}
    <span class="text-textcolor mt-2">Blocking {language.providerURL}</span>
    <TextInput
      marginBottom={true}
      bind:value={
        () => settings.textgenWebUIBlockingURL,
        (value) => write(["textgenWebUIBlockingURL"], value)
      }
      placeholder="https://..."
    />
    <span class="text-draculared text-xs mb-2"
      >You must use textgen webui with --public-api</span
    >
    <span class="text-textcolor mt-2">Stream {language.providerURL}</span>
    <TextInput
      marginBottom={true}
      bind:value={
        () => settings.textgenWebUIStreamURL,
        (value) => write(["textgenWebUIStreamURL"], value)
      }
      placeholder="wss://..."
    />
    {#if !isTauri}
      <span class="text-draculared text-xs mb-2"
        >You are using web version. you must use ngrok or other tunnels to use
        your local webui.</span
      >
    {/if}
    <span class="text-draculared text-xs mb-2"
      >Warning: For Ooba version over 1.7, use "Ooba" as model, and use url like
      http://127.0.0.1:5000/v1/chat/completions</span
    >
  {/if}
  {#if settings.aiModel === "ooba" || settings.subModel === "ooba"}
    <span class="text-textcolor mt-2">Ooba {language.providerURL}</span>
    <TextInput
      marginBottom={true}
      bind:value={
        () => settings.textgenWebUIBlockingURL,
        (value) => write(["textgenWebUIBlockingURL"], value)
      }
      placeholder="https://..."
    />
  {/if}
  {#if settings.aiModel.startsWith("horde") || settings.aiModel === "kobold"}
    <ChatFormatSettings />
  {/if}

  {#if settings.auxModelUnderModelSettings}
    <AuxModelSelectors />
  {/if}
{/if}

{#if submenu === 1 || submenu === -1}
  <!-- Data-driven basic parameters -->
  <SettingRenderer items={allBasicParameterItems} {modelInfo} {subModelInfo} />
  {#if settings.aiModel === "textgen_webui" || settings.aiModel === "mancer" || settings.aiModel.startsWith("local_") || settings.aiModel.startsWith("hf:::")}
    <span class="text-textcolor">Repetition Penalty</span>
    <SliderInput
      min={1}
      max={1.5}
      step={0.01}
      fixed={2}
      marginBottom
      bind:value={
        () => settings.ooba.repetition_penalty,
        (value) => write(["ooba", "repetition_penalty"], value)
      }
    />
    <span class="text-textcolor">Length Penalty</span>
    <SliderInput
      min={-5}
      max={5}
      step={0.05}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.ooba.length_penalty,
        (value) => write(["ooba", "length_penalty"], value)
      }
    />
    <span class="text-textcolor">Top K</span>
    <SliderInput
      min={0}
      max={100}
      step={1}
      marginBottom
      bind:value={
        () => settings.ooba.top_k, (value) => write(["ooba", "top_k"], value)
      }
    />
    <span class="text-textcolor">Top P</span>
    <SliderInput
      min={0}
      max={1}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.ooba.top_p, (value) => write(["ooba", "top_p"], value)
      }
    />
    <span class="text-textcolor">Typical P</span>
    <SliderInput
      min={0}
      max={1}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.ooba.typical_p,
        (value) => write(["ooba", "typical_p"], value)
      }
    />
    <span class="text-textcolor">Top A</span>
    <SliderInput
      min={0}
      max={1}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.ooba.top_a, (value) => write(["ooba", "top_a"], value)
      }
    />
    <span class="text-textcolor">No Repeat n-gram Size</span>
    <SliderInput
      min={0}
      max={20}
      step={1}
      marginBottom
      bind:value={
        () => settings.ooba.no_repeat_ngram_size,
        (value) => write(["ooba", "no_repeat_ngram_size"], value)
      }
    />
    <div class="flex items-center mt-4">
      <Check
        bind:check={
          () => !!settings.ooba.do_sample,
          (value) => write(["ooba", "do_sample"], value)
        }
        name={"Do Sample"}
      />
    </div>
    <div class="flex items-center mt-4">
      <Check
        bind:check={
          () => !!settings.ooba.add_bos_token,
          (value) => write(["ooba", "add_bos_token"], value)
        }
        name={"Add BOS Token"}
      />
    </div>
    <div class="flex items-center mt-4">
      <Check
        bind:check={
          () => !!settings.ooba.ban_eos_token,
          (value) => write(["ooba", "ban_eos_token"], value)
        }
        name={"Ban EOS Token"}
      />
    </div>
    <div class="flex items-center mt-4">
      <Check
        bind:check={
          () => !!settings.ooba.skip_special_tokens,
          (value) => write(["ooba", "skip_special_tokens"], value)
        }
        name={"Skip Special Tokens"}
      />
    </div>
    <div class="flex items-center mt-4">
      <Check
        check={!!settings.localStopStrings}
        name={language.customStopWords}
        onChange={() => {
          if (!settings.localStopStrings) {
            write(["localStopStrings"], []);
          } else {
            write(["localStopStrings"], null);
          }
        }}
      />
    </div>
    {#if settings.localStopStrings}
      <div
        class="flex flex-col p-2 rounded-sm border border-selected mt-2 gap-1"
      >
        <div class="p-2">
          <button
            class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full"
            onclick={() => {
              let localStopStrings = [...settings.localStopStrings];
              localStopStrings.push("");
              write(["localStopStrings"], localStopStrings);
            }}><PlusIcon /></button
          >
        </div>
        {#each settings.localStopStrings as stopString, i}
          <div class="flex w-full">
            <div class="grow">
              <TextInput
                marginBottom
                bind:value={
                  () => settings.localStopStrings[i],
                  (value) => write(["localStopStrings", i], value)
                }
                fullwidth
                fullh
              />
            </div>
            <div>
              <button
                class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full"
                onclick={() => {
                  let localStopStrings = [...settings.localStopStrings];
                  localStopStrings.splice(i, 1);
                  write(["localStopStrings"], localStopStrings);
                }}><TrashIcon /></button
              >
            </div>
          </div>
        {/each}
      </div>
    {/if}
    <div class="flex flex-col p-3 rounded-md border-selected border mt-4">
      <ChatFormatSettings />
    </div>
    <Check
      bind:check={
        () => !!settings.ooba.formating.useName,
        (value) => write(["ooba", "formating", "useName"], value)
      }
      name={language.useNamePrefix}
    />
  {:else if modelInfo.format === LLMFormat.NovelAI}
    <div class="flex flex-col p-3 bg-darkbg mt-4">
      <span class="text-textcolor">Starter</span>
      <TextInput
        bind:value={
          () => settings.NAIsettings.starter,
          (value) => write(["NAIsettings", "starter"], value)
        }
        placeholder={"⁂"}
      />
      <span class="text-textcolor">Seperator</span>
      <TextInput
        bind:value={
          () => settings.NAIsettings.seperator,
          (value) => write(["NAIsettings", "seperator"], value)
        }
        placeholder={"\\n"}
      />
    </div>
    <span class="text-textcolor">Top P</span>
    <SliderInput
      min={0}
      max={1}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.NAIsettings.topP,
        (value) => write(["NAIsettings", "topP"], value)
      }
    />
    <span class="text-textcolor">Top K</span>
    <SliderInput
      min={0}
      max={100}
      step={1}
      marginBottom
      bind:value={
        () => settings.NAIsettings.topK,
        (value) => write(["NAIsettings", "topK"], value)
      }
    />
    <span class="text-textcolor">Top A</span>
    <SliderInput
      min={0}
      max={1}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.NAIsettings.topA,
        (value) => write(["NAIsettings", "topA"], value)
      }
    />
    <span class="text-textcolor">Tailfree Sampling</span>
    <SliderInput
      min={0}
      max={1}
      step={0.001}
      marginBottom
      fixed={3}
      bind:value={
        () => settings.NAIsettings.tailFreeSampling,
        (value) => write(["NAIsettings", "tailFreeSampling"], value)
      }
    />
    <span class="text-textcolor">Typical P</span>
    <SliderInput
      min={0}
      max={1}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.NAIsettings.typicalp,
        (value) => write(["NAIsettings", "typicalp"], value)
      }
    />
    <span class="text-textcolor">Repetition Penalty</span>
    <SliderInput
      min={0}
      max={3}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.NAIsettings.repetitionPenalty,
        (value) => write(["NAIsettings", "repetitionPenalty"], value)
      }
    />
    <span class="text-textcolor">Repetition Penalty Range</span>
    <SliderInput
      min={0}
      max={8192}
      step={1}
      marginBottom
      fixed={0}
      bind:value={
        () => settings.NAIsettings.repetitionPenaltyRange,
        (value) => write(["NAIsettings", "repetitionPenaltyRange"], value)
      }
    />
    <span class="text-textcolor">Repetition Penalty Slope</span>
    <SliderInput
      min={0}
      max={10}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.NAIsettings.repetitionPenaltySlope,
        (value) => write(["NAIsettings", "repetitionPenaltySlope"], value)
      }
    />
    <span class="text-textcolor">Frequency Penalty</span>
    <SliderInput
      min={-2}
      max={2}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.NAIsettings.frequencyPenalty,
        (value) => write(["NAIsettings", "frequencyPenalty"], value)
      }
    />
    <span class="text-textcolor">Presence Penalty</span>
    <SliderInput
      min={-2}
      max={2}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.NAIsettings.presencePenalty,
        (value) => write(["NAIsettings", "presencePenalty"], value)
      }
    />
    <span class="text-textcolor">Mirostat LR</span>
    <SliderInput
      min={0}
      max={1}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.NAIsettings.mirostat_lr,
        (value) => write(["NAIsettings", "mirostat_lr"], value)
      }
    />
    <span class="text-textcolor">Mirostat Tau</span>
    <SliderInput
      min={0}
      max={6}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.NAIsettings.mirostat_tau,
        (value) => write(["NAIsettings", "mirostat_tau"], value)
      }
    />
    <span class="text-textcolor">Cfg Scale</span>
    <SliderInput
      min={1}
      max={3}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.NAIsettings.cfg_scale,
        (value) => write(["NAIsettings", "cfg_scale"], value)
      }
    />
  {:else if modelInfo.format === LLMFormat.NovelList}
    <span class="text-textcolor">Top P</span>
    <SliderInput
      min={0}
      max={2}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.ainconfig.top_p,
        (value) => write(["ainconfig", "top_p"], value)
      }
    />
    <span class="text-textcolor">Reputation Penalty</span>
    <SliderInput
      min={0}
      max={2}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.ainconfig.rep_pen,
        (value) => write(["ainconfig", "rep_pen"], value)
      }
    />
    <span class="text-textcolor">Reputation Penalty Range</span>
    <SliderInput
      min={0}
      max={2048}
      step={1}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.ainconfig.rep_pen_range,
        (value) => write(["ainconfig", "rep_pen_range"], value)
      }
    />
    <span class="text-textcolor">Reputation Penalty Slope</span>
    <SliderInput
      min={0}
      max={10}
      step={0.1}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.ainconfig.rep_pen_slope,
        (value) => write(["ainconfig", "rep_pen_slope"], value)
      }
    />
    <span class="text-textcolor">Top K</span>
    <SliderInput
      min={1}
      max={500}
      step={1}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.ainconfig.top_k,
        (value) => write(["ainconfig", "top_k"], value)
      }
    />
    <span class="text-textcolor">Top A</span>
    <SliderInput
      min={0}
      max={1}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.ainconfig.top_a,
        (value) => write(["ainconfig", "top_a"], value)
      }
    />
    <span class="text-textcolor">Typical P</span>
    <SliderInput
      min={0}
      max={1}
      step={0.01}
      marginBottom
      fixed={2}
      bind:value={
        () => settings.ainconfig.typical_p,
        (value) => write(["ainconfig", "typical_p"], value)
      }
    />
  {:else}
    <!-- Standard parameters now handled by SettingRenderer above -->
  {/if}

  {#if (settings.reverseProxyOobaMode && settings.aiModel === "reverse_proxy") || settings.aiModel === "ooba"}
    <OobaSettings instructionMode={settings.aiModel === "ooba"} />
  {/if}

  {#if settings.aiModel.startsWith("openrouter")}
    <OpenrouterSettings />
  {/if}

  <!-- Separate Parameters - handled by custom component -->
  <SeparateParametersSection />
{/if}

{#if submenu === 3 || submenu === -1}
  <Accordion styled name="Bias " help="bias">
    <table class="contain w-full max-w-full tabler">
      <tbody>
        <tr>
          <th class="font-medium">Bias</th>
          <th class="font-medium">{language.value}</th>
          <th>
            <button
              class="font-medium cursor-pointer hover:text-green-500 w-full flex justify-center items-center"
              onclick={() => {
                let bia = [...settings.bias];
                bia.push(["", 0]);
                write(["bias"], bia);
              }}><PlusIcon /></button
            >
          </th>
        </tr>
        {#if settings.bias.length === 0}
          <tr>
            <td colspan="3" class="text-textcolor2">{language.noBias}</td>
          </tr>
        {/if}
        {#each settings.bias as bias, i}
          <tr>
            <td class="font-medium truncate">
              <TextInput
                bind:value={
                  () => settings.bias[i][0],
                  (value) => write(["bias", i, 0], value)
                }
                size="lg"
                fullwidth
              />
            </td>
            <td class="font-medium truncate">
              <NumberInput
                bind:value={
                  () => settings.bias[i][1],
                  (value) => write(["bias", i, 1], value)
                }
                max={100}
                min={-101}
                size="lg"
                fullwidth
              />
            </td>
            <td>
              <button
                class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full"
                onclick={() => {
                  let bia = [...settings.bias];
                  bia.splice(i, 1);
                  write(["bias"], bia);
                }}><TrashIcon /></button
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <div class="text-textcolor2 mt-2 flex items-center gap-2">
      <button
        class="font-medium cursor-pointer hover:text-textcolor gap-2"
        onclick={() => {
          const data = JSON.stringify(settings.bias, null, 2);
          downloadFile("bias.json", data);
        }}><DownloadIcon /></button
      >
      <button
        class="font-medium cursor-pointer hover:text-textcolor"
        onclick={async () => {
          const sel = await selectSingleFile(["json"]);
          const utf8 = new TextDecoder().decode(sel.data);
          if (Array.isArray(JSON.parse(utf8))) {
            write(["bias"], JSON.parse(utf8));
          }
        }}><HardDriveUploadIcon /></button
      >
    </div>
  </Accordion>

  <Accordion styled name="{language.additionalParams} " help="additionalParams">
    <table class="contain w-full max-w-full tabler">
      <tbody>
        <tr>
          <th class="font-medium">{language.key}</th>
          <th class="font-medium">{language.value}</th>
          <th>
            <button
              class="font-medium cursor-pointer hover:text-green-500 w-full flex justify-center items-center"
              onclick={() => {
                write(
                  ["additionalParams"],
                  [...settings.additionalParams, ["", ""]],
                );
              }}><PlusIcon /></button
            >
          </th>
        </tr>
        {#if settings.additionalParams.length === 0}
          <tr class="text-textcolor2">
            <td colspan="3">{language.noData}</td>
          </tr>
        {/if}
        {#each settings.additionalParams as additionalParams, i}
          <tr>
            <td class="font-medium truncate">
              <TextInput
                bind:value={
                  () => settings.additionalParams[i][0],
                  (value) => write(["additionalParams", i, 0], value)
                }
                size="lg"
                fullwidth
              />
            </td>
            <td class="font-medium truncate">
              <TextInput
                bind:value={
                  () => settings.additionalParams[i][1],
                  (value) => write(["additionalParams", i, 1], value)
                }
                size="lg"
                fullwidth
              />
            </td>
            <td>
              <button
                class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full"
                onclick={() => {
                  let additionalParams = [...settings.additionalParams];
                  additionalParams.splice(i, 1);
                  write(["additionalParams"], additionalParams);
                }}><TrashIcon /></button
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </Accordion>

  <Accordion styled name={language.promptTemplate}>
    {#if settings.promptTemplate}
      {#if submenu !== -1}
        <PromptSettings mode="inline" subMenu={1} />
      {/if}
    {:else}
      <Check
        check={false}
        name={language.usePromptTemplate}
        onChange={() => {
          write(["promptTemplate"], []);
        }}
      />
    {/if}
  </Accordion>

  {#snippet CustomFlagButton(name: string, flag: number)}
    <Button
      className="mt-2"
      onclick={(e) => {
        if (settings.customFlags.includes(flag as LLMFlags)) {
          write(
            ["customFlags"],
            settings.customFlags.filter((f) => f !== flag),
          );
        } else {
          write(["customFlags"], [...settings.customFlags, flag as LLMFlags]);
        }
      }}
      styled={settings.customFlags.includes(flag as LLMFlags)
        ? "primary"
        : "outlined"}
    >
      {name}
    </Button>
  {/snippet}

  <Accordion styled name={language.customFlags}>
    <Check
      bind:check={
        () => !!settings.enableCustomFlags,
        (value) => write(["enableCustomFlags"], value)
      }
      name={language.enableCustomFlags}
    />

    {#if settings.enableCustomFlags}
      {@render CustomFlagButton("hasImageInput", 0)}
      {@render CustomFlagButton("hasImageOutput", 1)}
      {@render CustomFlagButton("hasAudioInput", 2)}
      {@render CustomFlagButton("hasAudioOutput", 3)}
      {@render CustomFlagButton("hasPrefill", 4)}
      {@render CustomFlagButton("hasCache", 5)}
      {@render CustomFlagButton("hasFullSystemPrompt", 6)}
      {@render CustomFlagButton("hasFirstSystemPrompt", 7)}
      {@render CustomFlagButton("hasStreaming", 8)}
      {@render CustomFlagButton("requiresAlternateRole", 9)}
      {@render CustomFlagButton("mustStartWithUserInput", 10)}
      {@render CustomFlagButton("hasVideoInput", 12)}
      {@render CustomFlagButton("OAICompletionTokens", 13)}
      {@render CustomFlagButton("DeveloperRole", 14)}
      {@render CustomFlagButton("geminiThinking", 15)}
      {@render CustomFlagButton("geminiBlockOff", 16)}
      {@render CustomFlagButton("deepSeekPrefix", 17)}
      {@render CustomFlagButton("deepSeekThinkingInput", 18)}
      {@render CustomFlagButton("deepSeekThinkingOutput", 19)}
      {@render CustomFlagButton("noCivilIntegrity", 20)}
      {@render CustomFlagButton("claudeThinking", 21)}
      {@render CustomFlagButton("claudeAdaptiveThinking", 22)}
      {@render CustomFlagButton("claudeXHighEffort", 23)}
      {@render CustomFlagButton("deepSeekThinkingToggle", 24)}
    {/if}
  </Accordion>

  <Accordion
    styled
    name={language.moduleIntergration}
    help="moduleIntergration"
  >
    <TextAreaInput
      bind:value={
        () => settings.moduleIntergration,
        (value) => write(["moduleIntergration"], value)
      }
      fullwidth
      height={"32"}
      autocomplete="off"
    />
  </Accordion>

  <Accordion styled name={language.tools}>
    <Check
      name={language.search}
      check={settings.modelTools.includes("search")}
      onChange={() => {
        if (settings.modelTools.includes("search")) {
          write(
            ["modelTools"],
            settings.modelTools.filter((tool) => tool !== "search"),
          );
        } else {
          write(["modelTools"], [...settings.modelTools, "search"]);
        }
      }}
    />
  </Accordion>

  <Accordion styled name={language.regexScript}>
    <SettingObjectDraft
      value={settings.presetRegex}
      onchange={(value) => write(["presetRegex"], value)}
    >
      {#snippet children(draft)}<RegexList
          bind:value={draft.value}
          buttons
        />{/snippet}
    </SettingObjectDraft>
  </Accordion>

  <Accordion styled name={language.icon}>
    <div
      class="p-2 rounded-md border border-darkborderc flex flex-col items-center gap-2"
    >
      <span>
        {language.preview}
      </span>
      <div class="flex items-center justify-center gap-2">
        {#if settings.botPresets[settings.botPresetsId]?.image}
          <img
            src={settings.botPresets[settings.botPresetsId]?.image}
            alt="icon"
            class="w-6 h-6 rounded-md"
            decoding="async"
          />
          <span class="text-textcolor2"
            >{settings.botPresets[settings.botPresetsId]?.name}</span
          >
        {:else}
          <span class="text-textcolor2">{language.noImages}</span>
        {/if}
      </div>
    </div>
    <button
      class="mt-2 text-textcolor2 hover:text-textcolor focus-within:text-textcolor"
      onclick={async () => {
        const sel = await selectSingleFile(["png", "jpg", "jpeg", "webp"]);
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const img = new Image();
        //@ts-expect-error Uint8Array buffer type (ArrayBufferLike) is incompatible with BlobPart's ArrayBuffer
        const blob = new Blob([sel.data], { type: "image/png" });
        img.src = URL.createObjectURL(blob);
        await img.decode();
        canvas.width = 48;
        canvas.height = 48;
        ctx.drawImage(img, 0, 0, 48, 48);
        const data = canvas.toDataURL("image/jpeg", 0.7);
        const preset = settings.botPresets[settings.botPresetsId];
        setFieldValue(
          {
            scope: "resource",
            resourceKind: "preset",
            entityId: (preset as typeof preset & { id: string }).id,
            key: "image",
          },
          data,
          () => {
            preset.image = data;
          },
        );
        URL.revokeObjectURL(img.src);
      }}
    >
      <UploadIcon />
    </button>
  </Accordion>
  {#if submenu !== -1}
    <Button
      onclick={() => {
        $openPresetList = true;
      }}
      className="mt-4">{language.presets}</Button
    >
  {/if}
{/if}

{#if submenu === 2 || submenu === -1}
  {#if !settings.promptTemplate}
    <span class="text-textcolor"
      >{language.mainPrompt} <Help key="mainprompt" /></span
    >
    <TextAreaInput
      fullwidth
      autocomplete="off"
      height={"32"}
      bind:value={
        () => settings.mainPrompt, (value) => write(["mainPrompt"], value)
      }
    ></TextAreaInput>
    <span class="text-textcolor2 mb-6 text-sm mt-2"
      >{tokens.mainPrompt} {language.tokens}</span
    >
    <span class="text-textcolor"
      >{language.jailbreakPrompt} <Help key="jailbreak" /></span
    >
    <TextAreaInput
      fullwidth
      autocomplete="off"
      height={"32"}
      bind:value={
        () => settings.jailbreak, (value) => write(["jailbreak"], value)
      }
    ></TextAreaInput>
    <span class="text-textcolor2 mb-6 text-sm mt-2"
      >{tokens.jailbreak} {language.tokens}</span
    >
    <span class="text-textcolor"
      >{language.globalNote} <Help key="globalNote" /></span
    >
    <TextAreaInput
      fullwidth
      autocomplete="off"
      height={"32"}
      bind:value={
        () => settings.globalNote, (value) => write(["globalNote"], value)
      }
    ></TextAreaInput>
    <span class="text-textcolor2 mb-6 text-sm mt-2"
      >{tokens.globalNote} {language.tokens}</span
    >
    <span class="text-textcolor mb-2 mt-4"
      >{language.formatingOrder} <Help key="formatOrder" /></span
    >
    <SettingObjectDraft
      value={settings.formatingOrder}
      onchange={(value) => write(["formatingOrder"], value)}
    >
      {#snippet children(draft)}<DropList bind:list={draft.value} />{/snippet}
    </SettingObjectDraft>
    <div class="flex items-center mt-4">
      <Check
        bind:check={
          () => !!settings.promptPreprocess,
          (value) => write(["promptPreprocess"], value)
        }
        name={language.promptPreprocess}
      />
    </div>
  {:else if submenu === 2}
    <PromptSettings mode="inline" />
  {/if}
{/if}

{#if settings.promptTemplate && submenu === -1}
  <div class="mt-2">
    <Button onclick={goPromptTemplate} size="sm"
      >{language.promptTemplate}</Button
    >
  </div>
{/if}
{#if submenu === -1}
  <Button
    onclick={() => {
      $openPresetList = true;
    }}
    className="mt-4">{language.presets}</Button
  >
{/if}
