import { createPromptTemplateRuntime } from "./promptTemplateRuntime";
import type { AINsettings } from "./database.svelte";
import type { get } from "svelte/store";
import type {
  checkNullish,
  decryptBuffer,
  encryptBuffer,
  selectSingleFile,
} from "../util";
import type { changeLanguage, language } from "../../lang";
import type { RisuPlugin } from "../plugins/plugins.svelte";
import type { triggerscript as triggerscriptMain } from "../process/triggers";
import type {
  downloadFile,
  saveAsset as saveImageGlobal,
} from "../globalApi.svelte";
import type {
  defaultAutoSuggestPrompt,
  defaultJailbreak,
  defaultMainPrompt,
} from "./defaultPrompts";
import type { alertNormal } from "../alert";
import type { NAISettings } from "../process/models/nai";
import type {
  prebuiltNAIpresets,
  prebuiltPresets,
} from "../process/templates/templates";
import type { defaultColorScheme, ColorScheme } from "../gui/colorscheme";
import type { PromptItem, PromptSettings } from "../process/prompt";
import type { OobaChatCompletionRequestParams } from "../model/ooba";
import type {
  HypaV3Settings,
  HypaV3Preset,
  createHypaV3Preset,
} from "../process/memory/hypav3";
import type {
  normalizeTranslatorPresetState,
  TranslatorPreset,
} from "../translator/presets";
import type { isTauri, isNodeServer } from "src/ts/platform";
import type { safeStructuredClone } from "../polyfill";
import type {
  DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
  DEFAULT_CHAT_LOAD_INITIAL_PAGES,
  normalizeChatLoadPages,
} from "../chatLoadPages";
import type {
  encode as encodeMsgpack,
  decode as decodeMsgpack,
} from "msgpackr/index-no-eval";
import type * as fflate from "fflate";
import type { OnnxModelFiles } from "../process/transformers";
import type { RisuModule } from "../process/modules";
import type { SerializableHypaV2Data } from "../process/memory/hypav2";
import type { decodeRPack, encodeRPack } from "../rpack/rpack_js";
import type { DBState, selectedCharID } from "../stores.svelte";
import type { LLMFlags, LLMFormat, LLMTokenizer } from "../model/modellist";
import type { HypaModel } from "../process/memory/hypamemory";
import type { SerializableHypaV3Data } from "../process/memory/hypav3";
import type { defaultHotkeys, Hotkey } from "../defaulthotkeys";
import type { OpenAIChat } from "../process/index.svelte";
import type { Loadout } from "../loadout";
import type { getDefaultSdData } from "./defaultCharacterData";
import type {
  StreamingDisplayOptimizationMode,
  DynamicOutput,
  RisuPersona,
  Database,
  CustomSideBarItem,
  SeparateParameters,
  customscript,
  triggerscript,
  loreBook,
  character,
  loreSettings,
  groupChat,
  botPreset,
  folder,
  NAIImgConfig,
  FormatingOrderItem,
  Chat,
  ChatFolder,
  Message,
  MessageGenerationInfo,
  MessagePresetInfo,
  PromptDiffPrefs,
  OobaSettings,
} from "./database.svelte";
/** Original upstream algorithms, with private state and explicit host capabilities. */
export interface SettingsRuntimeHost {
  checkNullish: (typeof import("../util"))["checkNullish"];
  defaultMainPrompt: (typeof import("./defaultPrompts"))["defaultMainPrompt"];
  defaultJailbreak: (typeof import("./defaultPrompts"))["defaultJailbreak"];
  defaultAutoSuggestPrompt: (typeof import("./defaultPrompts"))["defaultAutoSuggestPrompt"];
  safeStructuredClone: (typeof import("../polyfill"))["safeStructuredClone"];
  prebuiltNAIpresets: (typeof import("../process/templates/templates"))["prebuiltNAIpresets"];
  defaultColorScheme: (typeof import("../gui/colorscheme"))["defaultColorScheme"];
  LLMFormat: (typeof import("../model/modellist"))["LLMFormat"];
  createHypaV3Preset: (typeof import("../process/memory/hypav3"))["createHypaV3Preset"];
  normalizeTranslatorPresetState: (typeof import("../translator/presets"))["normalizeTranslatorPresetState"];
  defaultHotkeys: (typeof import("../defaulthotkeys"))["defaultHotkeys"];
  normalizeChatLoadPages: (typeof import("../chatLoadPages"))["normalizeChatLoadPages"];
  DEFAULT_CHAT_LOAD_INITIAL_PAGES: (typeof import("../chatLoadPages"))["DEFAULT_CHAT_LOAD_INITIAL_PAGES"];
  DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES: (typeof import("../chatLoadPages"))["DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES"];
  isNodeServer: (typeof import("src/ts/platform"))["isNodeServer"];
  isTauri: (typeof import("src/ts/platform"))["isTauri"];
  changeLanguage: (typeof import("../../lang"))["changeLanguage"];
  setDatabaseLite: (typeof import("./database.svelte"))["setDatabaseLite"];
}
export function createSettingsRuntime(host: SettingsRuntimeHost) {
  const { normalizePromptRole, normalizeCacheRole, normalizePromptTemplate } =
    createPromptTemplateRuntime(host);
  function setDatabase(data: Database) {
    if (host.checkNullish(data.characters)) {
      data.characters = [];
    }
    if (host.checkNullish(data.apiType)) {
      data.apiType = "gemini-3-flash-preview";
    }
    if (host.checkNullish(data.openAIKey)) {
      data.openAIKey = "";
    }
    if (host.checkNullish(data.mainPrompt)) {
      data.mainPrompt = host.defaultMainPrompt;
    }
    if (host.checkNullish(data.jailbreak)) {
      data.jailbreak = host.defaultJailbreak;
    }
    if (host.checkNullish(data.globalNote)) {
      data.globalNote = ``;
    }
    if (host.checkNullish(data.temperature)) {
      data.temperature = 80;
    }
    if (host.checkNullish(data.maxContext)) {
      data.maxContext = 4000;
    }
    if (host.checkNullish(data.maxResponse)) {
      data.maxResponse = 500;
    }
    if (host.checkNullish(data.frequencyPenalty)) {
      data.frequencyPenalty = 70;
    }
    if (host.checkNullish(data.PresensePenalty)) {
      data.PresensePenalty = 70;
    }
    if (host.checkNullish(data.aiModel)) {
      data.aiModel = "gemini-3-flash-preview";
    }
    if (host.checkNullish(data.jailbreakToggle)) {
      data.jailbreakToggle = false;
    }
    if (host.checkNullish(data.formatingOrder)) {
      data.formatingOrder = [
        "main",
        "description",
        "personaPrompt",
        "chats",
        "lastChat",
        "jailbreak",
        "lorebook",
        "globalNote",
        "authorNote",
      ];
    }
    if (host.checkNullish(data.loreBookDepth)) {
      data.loreBookDepth = 5;
    }
    if (host.checkNullish(data.loreBookToken)) {
      data.loreBookToken = 800;
    }
    if (host.checkNullish(data.username)) {
      data.username = "User";
    }
    if (host.checkNullish(data.userIcon)) {
      data.userIcon = "";
    }
    if (host.checkNullish(data.userNote)) {
      data.userNote = "";
    }
    if (host.checkNullish(data.additionalPrompt)) {
      data.additionalPrompt =
        "The assistant must act as {{char}}. user is {{user}}.";
    }
    if (host.checkNullish(data.descriptionPrefix)) {
      data.descriptionPrefix = "description of {{char}}: ";
    }
    if (host.checkNullish(data.forceReplaceUrl)) {
      data.forceReplaceUrl = "";
    }
    if (host.checkNullish(data.language)) {
      data.language = "en";
    }
    if (host.checkNullish(data.swipe)) {
      data.swipe = true;
    }
    if (host.checkNullish(data.translator)) {
      data.translator = "";
    }
    if (host.checkNullish(data.translatorMaxResponse)) {
      data.translatorMaxResponse = 1000;
    }
    if (host.checkNullish(data.currentPluginProvider)) {
      data.currentPluginProvider = "";
    }
    if (host.checkNullish(data.plugins)) {
      data.plugins = [];
    }
    if (host.checkNullish(data.zoomsize)) {
      data.zoomsize = 100;
    }
    if (host.checkNullish(data.customBackground)) {
      data.customBackground = "";
    }
    if (host.checkNullish(data.textgenWebUIStreamURL)) {
      data.textgenWebUIStreamURL = "wss://localhost/api/";
    }
    if (host.checkNullish(data.textgenWebUIBlockingURL)) {
      data.textgenWebUIBlockingURL = "https://localhost/api/";
    }
    if (host.checkNullish(data.autoTranslate)) {
      data.autoTranslate = false;
    }
    if (host.checkNullish(data.fullScreen)) {
      data.fullScreen = false;
    }
    if (host.checkNullish(data.playMessage)) {
      data.playMessage = false;
    }
    if (host.checkNullish(data.iconsize)) {
      data.iconsize = 100;
    }
    if (host.checkNullish(data.theme)) {
      data.theme = "";
    }
    if (host.checkNullish(data.subModel)) {
      data.subModel = "gemini-3-flash-preview";
    }
    if (host.checkNullish(data.waifuWidth)) {
      data.waifuWidth = 100;
    }
    if (host.checkNullish(data.waifuWidth2)) {
      data.waifuWidth2 = 100;
    }
    if (host.checkNullish(data.emotionPrompt)) {
      data.emotionPrompt = "";
    }
    if (host.checkNullish(data.proxyKey)) {
      data.proxyKey = "";
    }
    if (host.checkNullish(data.botPresets)) {
      let defaultPreset = presetTemplate;
      defaultPreset.name = "Default";
      data.botPresets = [defaultPreset];
    }
    if (host.checkNullish(data.botPresetsId)) {
      data.botPresetsId = 0;
    }
    if (Array.isArray(data.promptTemplate)) {
      data.promptTemplate = normalizePromptTemplate(data.promptTemplate);
    }
    if (host.checkNullish(data.sdProvider)) {
      data.sdProvider = "";
    }
    if (host.checkNullish(data.webUiUrl)) {
      data.webUiUrl = "http://127.0.0.1:7860/";
    }
    if (host.checkNullish(data.sdSteps)) {
      data.sdSteps = 30;
    }
    if (host.checkNullish(data.sdCFG)) {
      data.sdCFG = 7;
    }
    if (host.checkNullish(data.NAIImgUrl)) {
      data.NAIImgUrl = "https://image.novelai.net/ai/generate-image";
    }
    if (host.checkNullish(data.NAIApiKey)) {
      data.NAIApiKey = "";
    }
    if (host.checkNullish(data.NAIImgModel)) {
      data.NAIImgModel = "nai-diffusion-4-5-full";
    }
    if (host.checkNullish(data.NAII2I)) {
      data.NAII2I = false;
    }
    if (host.checkNullish(data.NAIREF)) {
      data.NAIREF = false;
    }
    if (host.checkNullish(data.textTheme)) {
      data.textTheme = "standard";
    }
    if (host.checkNullish(data.emotionPrompt2)) {
      data.emotionPrompt2 = "";
    }
    if (host.checkNullish(data.requestRetrys)) {
      data.requestRetrys = 2;
    }
    if (host.checkNullish(data.useSayNothing)) {
      data.useSayNothing = true;
    }
    if (host.checkNullish(data.bias)) {
      data.bias = [];
    }
    if (host.checkNullish(data.showUnrecommended)) {
      data.showUnrecommended = false;
    }
    if (host.checkNullish(data.elevenLabKey)) {
      data.elevenLabKey = "";
    }
    if (host.checkNullish(data.voicevoxUrl)) {
      data.voicevoxUrl = "";
    }
    if (host.checkNullish(data.supaMemoryPrompt)) {
      data.supaMemoryPrompt = "";
    }
    if (host.checkNullish(data.showMemoryLimit)) {
      data.showMemoryLimit = false;
    }
    if (host.checkNullish(data.showFirstMessagePages)) {
      data.showFirstMessagePages = false;
    }
    if (host.checkNullish(data.supaMemoryKey)) {
      data.supaMemoryKey = "";
    }
    if (host.checkNullish(data.hypaMemoryKey)) {
      data.hypaMemoryKey = "";
    }
    if (host.checkNullish(data.voyageApiKey)) {
      data.voyageApiKey = "";
    }
    if (host.checkNullish(data.supaModelType)) {
      data.supaModelType = "none";
    }
    if (host.checkNullish(data.askRemoval)) {
      data.askRemoval = true;
    }
    if (host.checkNullish(data.sdConfig)) {
      data.sdConfig = {
        width: 512,
        height: 512,
        sampler_name: "Euler a",
        script_name: "",
        denoising_strength: 0.7,
        enable_hr: false,
        hr_scale: 1.25,
        hr_upscaler: "Latent",
      };
    }
    if (host.checkNullish(data.NAIImgConfig)) {
      data.NAIImgConfig = {
        width: 1024,
        height: 1024,
        sampler: "k_euler_ancestral",
        noise_schedule: "karras",
        steps: 28,
        scale: 5,
        cfg_rescale: 0,
        sm: true,
        sm_dyn: false,
        noise: 0.0,
        strength: 0.6,
        image: "",
        base64image: "",
        InfoExtracted: 1,
        //add 4
        autoSmea: false,
        legacy_uc: false,
        use_coords: false,
        v4_prompt: {
          caption: {
            base_caption: "",
            char_captions: [],
          },
          use_coords: false,
          use_order: true,
        },
        v4_negative_prompt: {
          caption: {
            base_caption: "",
            char_captions: [],
          },
          legacy_uc: false,
        },
        variety_plus: false,
        decrisp: false,
        reference_mode: "",
        character_image: "",
        character_base64image: "",
        style_aware: false,
      };
    }
    //add NAI v4 (사용중인 사람용 추가 DB Init)
    if (host.checkNullish(data.NAIImgConfig.v4_prompt)) {
      data.NAIImgConfig.autoSmea = false;
      data.NAIImgConfig.use_coords = false;
      data.NAIImgConfig.legacy_uc = false;
      data.NAIImgConfig.v4_prompt = {
        caption: {
          base_caption: "",
          char_captions: [],
        },
        use_coords: false,
        use_order: true,
      };
      data.NAIImgConfig.v4_negative_prompt = {
        caption: {
          base_caption: "",
          char_captions: [],
        },
        legacy_uc: false,
      };
    }
    if (host.checkNullish(data.customTextTheme)) {
      data.customTextTheme = {
        FontColorStandard: "#f8f8f2",
        FontColorBold: "#f8f8f2",
        FontColorItalic: "#8C8D93",
        FontColorItalicBold: "#8C8D93",
        FontColorQuote1: "#8BE9FD",
        FontColorQuote2: "#FFB86C",
      };
    }
    if (host.checkNullish(data.hordeConfig)) {
      data.hordeConfig = {
        apiKey: "",
        model: "",
        softPrompt: "",
      };
    }
    if (host.checkNullish(data.novelai)) {
      data.novelai = {
        token: "",
        model: "clio-v1",
      };
    }
    if (host.checkNullish(data.loreBook)) {
      data.loreBookPage = 0;
      data.loreBook = [
        {
          name: "My First LoreBook",
          data: [],
        },
      ];
    }
    if (
      host.checkNullish(data.loreBookPage) ||
      data.loreBook.length < data.loreBookPage
    ) {
      data.loreBookPage = 0;
    }
    data.globalscript ??= [];
    data.sendWithEnter ??= true;
    data.autoSuggestPrompt ??= host.defaultAutoSuggestPrompt;
    data.autoSuggestPrefix ??= "";
    data.OAIPrediction ??= "";
    data.autoSuggestClean ??= true;
    data.imageCompression ??= true;
    data.enableBlockPartialEdit ??= false;
    data.enableDragPartialEdit ??= false;
    if (!data.formatingOrder.includes("personaPrompt")) {
      data.formatingOrder.splice(
        data.formatingOrder.indexOf("main"),
        0,
        "personaPrompt",
      );
    }
    data.selectedPersona ??= 0;
    data.personaPrompt ??= "";
    data.personas ??= [
      {
        name: data.username,
        personaPrompt: "",
        icon: data.userIcon,
        note: data.userNote,
        largePortrait: false,
      },
    ];
    data.classicMaxWidth ??= false;
    data.ooba ??= host.safeStructuredClone(defaultOoba);
    data.ainconfig ??= host.safeStructuredClone(defaultAIN);
    data.openrouterKey ??= "";
    data.openrouterRequestModel ??= "openai/gpt-3.5-turbo";
    data.nanogptKey ??= "";
    data.nanogptRequestModel ??= "";
    data.nanogptRequestModelName ??= "";
    data.nanogptProvider ??= "";
    data.nanogptSubscriptionState ??= "";
    data.nanogptUseSubscriptionEndpoint ??= false;
    data.NAIsettings ??= host.safeStructuredClone(host.prebuiltNAIpresets);
    data.assetWidth ??= -1;
    data.animationSpeed ??= 0.4;
    data.colorScheme ??= host.safeStructuredClone(host.defaultColorScheme);
    data.colorSchemeName ??= "default";
    data.customColorScheme ??= host.safeStructuredClone(
      data.colorSchemeName === "custom"
        ? data.colorScheme
        : host.defaultColorScheme,
    );
    data.NAIsettings.starter ??= "";
    data.hypaModel ??= "MiniLM";
    data.mancerHeader ??= "";
    data.emotionProcesser ??= "submodel";
    data.translatorType ??= "google";
    data.htmlTranslation ??= false;
    data.deeplOptions ??= {
      key: "",
      freeApi: false,
    };
    data.deeplXOptions ??= {
      url: "",
      token: "",
    };
    data.NAIadventure ??= false;
    data.NAIappendName ??= true;
    data.NAIsettings.cfg_scale ??= 1;
    data.NAIsettings.mirostat_tau ??= 0;
    data.NAIsettings.mirostat_lr ??= 1;
    data.autofillRequestUrl ??= true;
    data.customProxyRequestModel ??= "";
    data.generationSeed ??= -1;
    data.newOAIHandle ??= true;
    data.localNetworkMode ??= false;
    if (typeof data.localNetworkMode !== "boolean") {
      data.localNetworkMode = false;
    }
    data.localNetworkTimeoutSec ??= 600;
    if (
      typeof data.localNetworkTimeoutSec !== "number" ||
      Number.isNaN(data.localNetworkTimeoutSec)
    ) {
      data.localNetworkTimeoutSec = 600;
    }
    data.gptVisionQuality ??= "low";
    data.huggingfaceKey ??= "";
    data.fishSpeechKey ??= "";
    data.presetRegex ??= [];
    data.reverseProxyOobaArgs ??= {
      mode: "instruct",
    };
    data.top_p ??= 1;
    if (typeof data.top_p !== "number") {
      //idk why type changes, but it does so this is a fix
      data.top_p = 1;
    }
    //@ts-expect-error data.google has required fields (accessToken, projectId), but we use empty object as default and populate below
    data.google ??= {};
    data.google.accessToken ??= "";
    data.google.projectId ??= "";
    data.genTime ??= 1;
    data.promptSettings ??= {
      assistantPrefill: "",
      postEndInnerFormat: "",
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
      customChainOfThought: false,
      maxThoughtTagDepth: -1,
    };
    data.keiServerURL ??= "";
    data.top_k ??= 0;
    data.promptSettings.maxThoughtTagDepth ??= -1;
    data.openrouterFallback ??= true;
    data.openrouterMiddleOut ??= false;
    data.removePunctuationHypa ??= true;
    data.memoryLimitThickness ??= 1;
    data.modules ??= [];
    data.enabledModules ??= [];
    data.additionalParams ??= [];
    data.heightMode ??= "normal";
    data.antiClaudeOverload ??= false;
    data.maxSupaChunkSize ??= 1200;
    data.ollamaURL ??= "";
    data.ollamaModel ??= "";
    data.ollamaModelSource ??=
      data.aiModel === "ollama-cloud" || data.subModel === "ollama-cloud"
        ? "cloud"
        : "local";
    data.ollamaInputMode ??= "manual";
    data.ollamaRequestFormat ??= host.LLMFormat.Ollama;
    data.ollamaApiKey ??= "";
    data.ollamaModelName ??= "";
    data.ollamaCloudModel ??= "";
    data.ollamaCloudModelName ??= "";
    data.ollamaThinkingMode ??= "auto";
    if (
      (data.aiModel === "ollama-cloud" || data.subModel === "ollama-cloud") &&
      !data.ollamaCloudModel
    ) {
      data.ollamaCloudModel = data.ollamaModel;
      data.ollamaCloudModelName = data.ollamaModelName;
    }
    data.autoContinueChat ??= false;
    data.autoContinueMinTokens ??= 0;
    data.repetition_penalty ??= 1;
    data.min_p ??= 0;
    data.top_a ??= 0;
    data.customTokenizer ??= "tik";
    data.instructChatTemplate ??= "chatml";
    // Migration: convert old string type into new provider object
    if (typeof data.openrouterProvider === "string") {
      const oldProvider = data.openrouterProvider as unknown as string;
      data.openrouterProvider = {
        order: oldProvider ? [oldProvider] : [],
        only: [],
        ignore: [],
      };
    }
    if (data.botPresets) {
      for (const preset of data.botPresets) {
        if (Array.isArray(preset.promptTemplate)) {
          preset.promptTemplate = normalizePromptTemplate(
            preset.promptTemplate,
          );
        }
        preset.localNetworkMode ??= false;
        preset.localNetworkTimeoutSec ??= 600;
        if (typeof preset.localNetworkMode !== "boolean") {
          preset.localNetworkMode = false;
        }
        if (
          typeof preset.localNetworkTimeoutSec !== "number" ||
          Number.isNaN(preset.localNetworkTimeoutSec)
        ) {
          preset.localNetworkTimeoutSec = 600;
        }
        if (typeof preset.openrouterProvider === "string") {
          const oldProvider = preset.openrouterProvider as unknown as string;
          preset.openrouterProvider = {
            order: oldProvider ? [oldProvider] : [],
            only: [],
            ignore: [],
          };
        }
      }
    }
    data.openrouterProvider ??= {
      order: [],
      only: [],
      ignore: [],
    };
    data.useInstructPrompt ??= false;
    data.hanuraiEnable ??= false;
    data.hanuraiSplit ??= false;
    data.hanuraiTokens ??= 1000;
    data.textAreaSize ??= 0;
    data.sideBarSize ??= 0;
    data.textAreaTextSize ??= 0;
    data.combineTranslation ??= false;
    data.customPromptTemplateToggle ??= "";
    data.globalChatVariables ??= {};
    data.templateDefaultVariables ??= "";
    data.hypaAllocatedTokens ??= 3000;
    data.hypaChunkSize ??= 3000;
    data.dallEQuality ??= "standard";
    data.customTextTheme.FontColorQuote1 ??= "#8BE9FD";
    data.customTextTheme.FontColorQuote2 ??= "#FFB86C";
    data.font ??= "default";
    data.customFont ??= "";
    data.lineHeight ??= 1.25;
    data.stabilityModel ??= "sd3-large";
    data.stabllityStyle ??= "";
    data.legacyTranslation ??= false;
    data.comfyUiUrl ??= "http://localhost:8188";
    data.comfyConfig ??= {
      workflow: "",
      posNodeID: "",
      posInputName: "text",
      negNodeID: "",
      negInputName: "text",
      timeout: 30,
    };
    data.hideApiKey ??= true;
    data.unformatQuotes ??= false;
    data.ttsAutoSpeech ??= false;
    data.translatorInputLanguage ??= "auto";
    data.falModel ??= "fal-ai/flux/dev";
    data.falLoraScale ??= 1;
    data.customCSS ??= "";
    data.strictJsonSchema ??= true;
    data.statics ??= {
      messages: 0,
      imports: 0,
    };
    data.customQuotes ??= false;
    data.customQuotesData ??= ["“", "”", "‘", "’"];
    data.groupOtherBotRole ??= "user";
    data.customGUI ??= "";
    data.customAPIFormat ??= host.LLMFormat.OpenAICompatible;
    data.systemContentReplacement ??= `system: {{slot}}`;
    data.systemRoleReplacement ??= "user";
    data.vertexAccessToken ??= "";
    data.vertexAccessTokenExpires ??= 0;
    data.vertexClientEmail ??= "";
    data.vertexPrivateKey ??= "";
    data.vertexRegion ??= "global";
    data.seperateParametersEnabled ??= false;
    data.seperateParameters ??= {
      memory: {},
      emotion: {},
      translate: {},
      otherAx: {},
      overrides: {},
    };
    data.seperateParameters.overrides ??= {};
    data.customFlags ??= [];
    data.enableCustomFlags ??= false;
    data.assetMaxDifference ??= 4;
    data.showSavingIcon ??= false;
    data.banCharacterset ??= [];
    data.showPromptComparison ??= false;
    data.OaiCompAPIKeys ??= {};
    data.reasoningEffort ??= 0;
    data.verbosity ??= 1;
    data.hypaV3Presets ??= [
      host.createHypaV3Preset("Default", {
        summarizationPrompt: data.supaMemoryPrompt ? data.supaMemoryPrompt : "",
        ...data.hypaV3Settings,
      }),
    ];
    if (data.hypaV3Presets.length > 0) {
      data.hypaV3Presets = data.hypaV3Presets.map((preset, i) =>
        host.createHypaV3Preset(
          preset.name || `Preset ${i + 1}`,
          preset.settings || {},
        ),
      );
    }
    data.hypaV3PresetId ??= 0;
    host.normalizeTranslatorPresetState(data);
    data.showDeprecatedTriggerV2 ??= false;
    data.returnCSSError ??= true;
    data.realmDirectOpen ??= false;
    data.checkCorruption ??= false;
    data.toggleConfirmRecommendedPreset ??= false;
    data.useExperimentalGoogleTranslator ??= false;
    data.thinkingType ??= "budget";
    data.deepseekThinkingType ??= "off";
    data.adaptiveThinkingEffort ??= "high";
    data.deepseekReasoningEffort ??= "high";
    if (data.antiClaudeOverload) {
      //migration
      data.antiClaudeOverload = false;
      data.antiServerOverloads = true;
    }
    data.hypaCustomSettings = {
      url: data.hypaCustomSettings?.url ?? "",
      key: data.hypaCustomSettings?.key ?? "",
      model: data.hypaCustomSettings?.model ?? "",
    };
    data.doNotChangeSeperateModels ??= false;
    data.modelTools ??= [];
    data.enableScrollToActiveChar ??= true;
    // Merge existing hotkeys with new default hotkeys
    if (!data.hotkeys) {
      data.hotkeys = host.safeStructuredClone(host.defaultHotkeys);
    } else {
      const existingActions = new Set(data.hotkeys.map((h) => h.action));
      const newHotkeys = host.defaultHotkeys.filter(
        (h) => !existingActions.has(h.action),
      );
      if (newHotkeys.length > 0) {
        data.hotkeys.push(...host.safeStructuredClone(newHotkeys));
      }
    }
    // Remove scrollToActiveChar hotkey if feature is disabled
    if (data.enableScrollToActiveChar === false) {
      data.hotkeys = data.hotkeys.filter(
        (h) => h.action !== "scrollToActiveChar",
      );
    }
    data.fallbackModels ??= {
      memory: [],
      emotion: [],
      translate: [],
      otherAx: [],
      model: [],
    };
    data.fallbackModels = {
      model: data.fallbackModels.model.filter((v) => v !== ""),
      memory: data.fallbackModels.memory.filter((v) => v !== ""),
      emotion: data.fallbackModels.emotion.filter((v) => v !== ""),
      translate: data.fallbackModels.translate.filter((v) => v !== ""),
      otherAx: data.fallbackModels.otherAx.filter((v) => v !== ""),
    };
    data.customModels ??= [];
    data.authRefreshes ??= [];
    data.openAIFlexProcessing ??= false;
    data.rememberToolUsage ??= true;
    data.simplifiedToolUse ??= false;
    data.streamGeminiThoughts ??= false;
    data.settingsCloseButtonSize ??= 24;
    data.hideAllImages ??= false;
    data.ImagenModel ??= "imagen-4.0-generate-001";
    data.ImagenImageSize ??= "1K";
    data.ImagenAspectRatio ??= "1:1";
    data.ImagenPersonGeneration ??= "allow_all";
    data.openaiCompatImage ??= {
      url: "",
      key: "",
      model: "",
      size: "1024x1024",
      quality: "auto",
    };
    data.wavespeedImage ??= {
      key: "",
      model: "",
      loras: [],
      reference_mode: "",
      reference_image: "",
      reference_base64image: "",
    };
    data.autoScrollToNewMessage ??= true;
    data.alwaysScrollToNewMessage ??= false;
    data.newMessageButtonStyle ??= "bottom-center";
    data.chatLoadInitialPages = host.normalizeChatLoadPages(
      data.chatLoadInitialPages,
      host.DEFAULT_CHAT_LOAD_INITIAL_PAGES,
    );
    data.chatLoadAdditionalPages = host.normalizeChatLoadPages(
      data.chatLoadAdditionalPages,
      host.DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
    );
    data.streamingDisplayOptimizationMode ??=
      (
        data as {
          largeChatPerformanceMode?: StreamingDisplayOptimizationMode;
        }
      ).largeChatPerformanceMode ?? "off";
    delete (
      data as {
        largeChatPerformanceMode?: unknown;
      }
    ).largeChatPerformanceMode;
    data.echoMessage ??= "Echo Message";
    data.echoDelay ??= 0;
    if (!host.isNodeServer && !host.isTauri) {
      //this is intended to forcely reduce the size of the database in web
      data.promptInfoInsideChat = false;
    }
    data.createFolderOnBranch ??= true;
    data.hamburgerButtonBottom ??= false;
    data.dynamicModelRegistry ??= true;
    data.saveSignatures ??= false;
    // If the user uses plugins, its probably better to enable RisuAI Pro Tools by default
    // Because its likely they are power users who would benefit from the features
    data.enableRisuaiProTools ??= data.plugins.length > 0;
    data.keepSessionAlive ??= "off";
    data.loadouts ??= [];
    data.loadoutApplyOptions ??= {
      modules: true,
      globalVariables: true,
      preset: true,
      persona: true,
    };
    data.longPressToPopupEditor ??= false;
    data.customSidebarItems ??= [];
    data.moveInsteadOfCopyOnCMPConvert ??= false;
    data.skipSavingAssetsOnWebSync ??= true;
    data.coldstorage ??= data?.plugins?.length === 0;
    for (const char of data.characters) {
      for (const chat of char.chats ?? []) {
        chat.isStreaming = false;
        chat.activeStreamingDisplayOptimizationMode = undefined;
      }
    }
    host.changeLanguage(data.language);
    host.setDatabaseLite(data);
  }

  const defaultAIN: AINsettings = {
    top_p: 0.7,
    rep_pen: 1.0625,
    top_a: 0.08,
    rep_pen_slope: 1.7,
    rep_pen_range: 1024,
    typical_p: 1.0,
    badwords: "",
    stoptokens: "",
    top_k: 140,
  };

  const defaultOoba: OobaSettings = {
    max_new_tokens: 180,
    do_sample: true,
    temperature: 0.7,
    top_p: 0.9,
    typical_p: 1,
    repetition_penalty: 1.15,
    encoder_repetition_penalty: 1,
    top_k: 20,
    min_length: 0,
    no_repeat_ngram_size: 0,
    num_beams: 1,
    penalty_alpha: 0,
    length_penalty: 1,
    early_stopping: false,
    seed: -1,
    add_bos_token: true,
    truncation_length: 4096,
    ban_eos_token: false,
    skip_special_tokens: true,
    top_a: 0,
    tfs: 1,
    epsilon_cutoff: 0,
    eta_cutoff: 0,
    formating: {
      header:
        "Below is an instruction that describes a task. Write a response that appropriately completes the request.",
      systemPrefix: "### Instruction:",
      userPrefix: "### Input:",
      assistantPrefix: "### Response:",
      seperator: "",
      useName: false,
    },
  };

  const presetTemplate: botPreset = {
    name: "New Preset",
    apiType: "gemini-3-flash-preview",
    openAIKey: "",
    localNetworkMode: false,
    localNetworkTimeoutSec: 600,
    mainPrompt: host.defaultMainPrompt,
    jailbreak: host.defaultJailbreak,
    globalNote: "",
    temperature: 80,
    maxContext: 4000,
    maxResponse: 300,
    frequencyPenalty: 70,
    PresensePenalty: 70,
    formatingOrder: [
      "main",
      "description",
      "personaPrompt",
      "chats",
      "lastChat",
      "jailbreak",
      "lorebook",
      "globalNote",
      "authorNote",
    ],
    aiModel: "gemini-3-flash-preview",
    subModel: "gemini-3-flash-preview",
    currentPluginProvider: "",
    textgenWebUIStreamURL: "",
    textgenWebUIBlockingURL: "",
    forceReplaceUrl: "",
    forceReplaceUrl2: "",
    promptPreprocess: false,
    proxyKey: "",
    bias: [],
    ooba: host.safeStructuredClone(defaultOoba),
    ainconfig: host.safeStructuredClone(defaultAIN),
    reverseProxyOobaArgs: {
      mode: "instruct",
    },
    top_p: 1,
    useInstructPrompt: false,
    verbosity: 1,
  };

  return {
    setDatabase,
    normalizePromptRole,
    normalizeCacheRole,
    normalizePromptTemplate,
    defaultAIN,
    defaultOoba,
    presetTemplate,
  };
}
