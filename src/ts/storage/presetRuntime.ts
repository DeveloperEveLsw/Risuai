import type { Database, botPreset } from "./database.svelte";
export interface PresetRuntimeHost {
  readResourceValue: <T>(value: T) => T;
  DBState: { db: Database };
  safeStructuredClone: <T>(value: T) => T;
  normalizePromptTemplate: (value: any) => any;
  LLMFormat: Pick<
    typeof import("../model/types").LLMFormat,
    "OpenAICompatible"
  >;
}
/** Upstream preset capture/application with explicit state and normalization ports. */
export function createPresetRuntime(host: PresetRuntimeHost) {
  function saveCurrentPreset() {
    let db = host.DBState.db;
    let pres = db.botPresets;

    if (db.botPresetsId === -1) {
      return;
    }
    const savedPreset: botPreset = {
      name: host.readResourceValue(pres[db.botPresetsId]).name,
      apiType: db.apiType,
      openAIKey: db.openAIKey,
      localNetworkMode: db.localNetworkMode,
      localNetworkTimeoutSec: db.localNetworkTimeoutSec,
      mainPrompt: db.mainPrompt,
      jailbreak: db.jailbreak,
      globalNote: db.globalNote,
      temperature: db.temperature,
      maxContext: db.maxContext,
      maxResponse: db.maxResponse,
      frequencyPenalty: db.frequencyPenalty,
      PresensePenalty: db.PresensePenalty,
      formatingOrder: db.formatingOrder,
      aiModel: db.aiModel,
      subModel: db.subModel,
      currentPluginProvider: db.currentPluginProvider,
      textgenWebUIStreamURL: db.textgenWebUIStreamURL,
      textgenWebUIBlockingURL: db.textgenWebUIBlockingURL,
      forceReplaceUrl: db.forceReplaceUrl,
      promptPreprocess: db.promptPreprocess,
      bias: db.bias,
      koboldURL: db.koboldURL,
      proxyKey: db.proxyKey,
      ooba: host.safeStructuredClone(db.ooba),
      ainconfig: host.safeStructuredClone(db.ainconfig),
      proxyRequestModel: db.proxyRequestModel,
      openrouterRequestModel: db.openrouterRequestModel,
      NAISettings: host.safeStructuredClone(db.NAIsettings),
      promptTemplate: host.normalizePromptTemplate(db.promptTemplate) ?? null,
      NAIadventure: db.NAIadventure ?? false,
      NAIappendName: db.NAIappendName ?? false,
      localStopStrings: db.localStopStrings,
      autoSuggestPrompt: db.autoSuggestPrompt,
      customProxyRequestModel: db.customProxyRequestModel,
      reverseProxyOobaArgs:
        host.safeStructuredClone(db.reverseProxyOobaArgs) ?? null,
      top_p: db.top_p ?? 1,
      promptSettings: host.safeStructuredClone(db.promptSettings) ?? null,
      repetition_penalty: db.repetition_penalty,
      min_p: db.min_p,
      top_a: db.top_a,
      openrouterProvider: db.openrouterProvider,
      useInstructPrompt: db.useInstructPrompt,
      customPromptTemplateToggle: db.customPromptTemplateToggle ?? "",
      templateDefaultVariables: db.templateDefaultVariables ?? "",
      moduleIntergration: db.moduleIntergration ?? "",
      top_k: db.top_k,
      instructChatTemplate: db.instructChatTemplate,
      JinjaTemplate: db.JinjaTemplate ?? "",
      jsonSchemaEnabled: db.jsonSchemaEnabled ?? false,
      jsonSchema: db.jsonSchema ?? "",
      strictJsonSchema: db.strictJsonSchema ?? true,
      extractJson: db.extractJson ?? "",
      groupOtherBotRole: db.groupOtherBotRole ?? "user",
      groupTemplate: db.groupTemplate ?? "",
      seperateParametersEnabled: db.seperateParametersEnabled ?? false,
      seperateParameters: host.safeStructuredClone(db.seperateParameters),
      customAPIFormat: host.safeStructuredClone(db.customAPIFormat),
      systemContentReplacement: db.systemContentReplacement,
      systemRoleReplacement: db.systemRoleReplacement,
      customFlags: host.safeStructuredClone(db.customFlags),
      enableCustomFlags: db.enableCustomFlags,
      regex: db.presetRegex,
      image: pres?.[db.botPresetsId]?.image ?? "",
      reasonEffort: db.reasoningEffort ?? 0,
      thinkingTokens: db.thinkingTokens ?? null,
      thinkingType: db.thinkingType ?? "budget",
      deepseekThinkingType: db.deepseekThinkingType ?? "off",
      adaptiveThinkingEffort: db.adaptiveThinkingEffort ?? "high",
      deepseekReasoningEffort: db.deepseekReasoningEffort ?? "high",
      outputImageModal: db.outputImageModal ?? false,
      seperateModelsForAxModels: db.doNotChangeSeperateModels
        ? false
        : (db.seperateModelsForAxModels ?? false),
      seperateModels: db.doNotChangeSeperateModels
        ? null
        : host.safeStructuredClone(db.seperateModels),
      modelTools: host.safeStructuredClone(db.modelTools),
      fallbackModels: host.safeStructuredClone(db.fallbackModels),
      fallbackWhenBlankResponse: db.fallbackWhenBlankResponse ?? false,
      verbosity: db.verbosity ?? 1,
      dynamicOutput: db.dynamicOutput ?? null,
    };

    if (!Array.isArray(pres)) {
      pres = [];
    }
    //if out of bounds, create a new preset
    if (db.botPresetsId >= pres.length) {
      pres.push(savedPreset);
    } else {
      pres[db.botPresetsId] = savedPreset;
    }
    db.botPresets = pres;
  }

  function setPreset(db: Database, newPres: botPreset) {
    db.apiType = newPres.apiType ?? db.apiType;
    db.localNetworkMode = newPres.localNetworkMode ?? db.localNetworkMode;
    db.localNetworkTimeoutSec =
      newPres.localNetworkTimeoutSec ?? db.localNetworkTimeoutSec;
    db.mainPrompt = newPres.mainPrompt ?? db.mainPrompt;
    db.jailbreak = newPres.jailbreak ?? db.jailbreak;
    db.globalNote = newPres.globalNote ?? db.globalNote;
    db.temperature = newPres.temperature ?? db.temperature;
    db.maxContext = newPres.maxContext ?? db.maxContext;
    db.maxResponse = newPres.maxResponse ?? db.maxResponse;
    db.frequencyPenalty = newPres.frequencyPenalty ?? db.frequencyPenalty;
    db.PresensePenalty = newPres.PresensePenalty ?? db.PresensePenalty;
    db.formatingOrder = newPres.formatingOrder ?? db.formatingOrder;
    db.aiModel = newPres.aiModel ?? db.aiModel;
    db.subModel = newPres.subModel ?? db.subModel;
    db.currentPluginProvider =
      newPres.currentPluginProvider ?? db.currentPluginProvider;
    db.textgenWebUIStreamURL =
      newPres.textgenWebUIStreamURL ?? db.textgenWebUIStreamURL;
    db.textgenWebUIBlockingURL =
      newPres.textgenWebUIBlockingURL ?? db.textgenWebUIBlockingURL;
    db.forceReplaceUrl = newPres.forceReplaceUrl ?? db.forceReplaceUrl;
    db.promptPreprocess = newPres.promptPreprocess ?? db.promptPreprocess;
    db.bias = newPres.bias ?? db.bias;
    db.koboldURL = newPres.koboldURL ?? db.koboldURL;
    db.proxyKey = newPres.proxyKey ?? db.proxyKey;
    db.ooba = host.safeStructuredClone(newPres.ooba ?? db.ooba);
    db.ainconfig = host.safeStructuredClone(newPres.ainconfig ?? db.ainconfig);
    db.openrouterRequestModel =
      newPres.openrouterRequestModel ?? db.openrouterRequestModel;
    db.proxyRequestModel = newPres.proxyRequestModel ?? db.proxyRequestModel;
    db.NAIsettings = newPres.NAISettings ?? db.NAIsettings;
    db.autoSuggestPrompt = newPres.autoSuggestPrompt ?? db.autoSuggestPrompt;
    db.autoSuggestPrefix = newPres.autoSuggestPrefix ?? db.autoSuggestPrefix;
    db.autoSuggestClean = newPres.autoSuggestClean ?? db.autoSuggestClean;
    db.promptTemplate = host.normalizePromptTemplate(newPres.promptTemplate);
    db.NAIadventure = newPres.NAIadventure;
    db.NAIappendName = newPres.NAIappendName;
    db.NAIsettings.cfg_scale ??= 1;
    db.NAIsettings.mirostat_tau ??= 0;
    db.NAIsettings.mirostat_lr ??= 1;
    db.localStopStrings = newPres.localStopStrings;
    db.customProxyRequestModel = newPres.customProxyRequestModel ?? "";
    db.reverseProxyOobaArgs = host.safeStructuredClone(
      newPres.reverseProxyOobaArgs,
    ) ?? {
      mode: "instruct",
    };
    db.top_p = newPres.top_p ?? 1;
    db.promptSettings = host.safeStructuredClone(newPres.promptSettings) ?? {
      assistantPrefill: "",
      postEndInnerFormat: "",
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
    };
    db.promptSettings.maxThoughtTagDepth ??= -1;
    db.repetition_penalty = newPres.repetition_penalty;
    db.min_p = newPres.min_p;
    db.top_a = newPres.top_a;
    db.openrouterProvider = newPres.openrouterProvider;
    db.useInstructPrompt = newPres.useInstructPrompt ?? false;
    db.customPromptTemplateToggle = newPres.customPromptTemplateToggle ?? "";
    db.templateDefaultVariables = newPres.templateDefaultVariables ?? "";
    db.moduleIntergration = newPres.moduleIntergration ?? "";
    db.top_k = newPres.top_k ?? db.top_k;
    db.instructChatTemplate =
      newPres.instructChatTemplate ?? db.instructChatTemplate;
    db.JinjaTemplate = newPres.JinjaTemplate ?? db.JinjaTemplate;
    db.jsonSchemaEnabled = newPres.jsonSchemaEnabled ?? false;
    db.jsonSchema = newPres.jsonSchema ?? "";
    db.strictJsonSchema = newPres.strictJsonSchema ?? true;
    db.extractJson = newPres.extractJson ?? "";
    db.groupOtherBotRole = newPres.groupOtherBotRole ?? "user";
    db.groupTemplate = newPres.groupTemplate ?? "";
    db.seperateParametersEnabled = newPres.seperateParametersEnabled ?? false;
    db.customAPIFormat =
      host.safeStructuredClone(newPres.customAPIFormat) ??
      host.LLMFormat.OpenAICompatible;
    db.systemContentReplacement = newPres.systemContentReplacement ?? "";
    db.systemRoleReplacement = newPres.systemRoleReplacement ?? "user";
    db.customFlags = host.safeStructuredClone(newPres.customFlags) ?? [];
    db.enableCustomFlags = newPres.enableCustomFlags ?? false;
    db.presetRegex = newPres.regex ?? [];
    db.reasoningEffort = newPres.reasonEffort ?? 0;
    db.thinkingTokens = newPres.thinkingTokens ?? null;
    db.thinkingType = newPres.thinkingType ?? "budget";
    db.deepseekThinkingType = newPres.deepseekThinkingType ?? "off";
    db.adaptiveThinkingEffort = newPres.adaptiveThinkingEffort ?? "high";
    db.deepseekReasoningEffort = newPres.deepseekReasoningEffort ?? "high";
    db.outputImageModal = newPres.outputImageModal ?? false;
    if (!db.doNotChangeSeperateModels) {
      db.seperateModelsForAxModels = newPres.seperateModelsForAxModels ?? false;
      db.seperateModels = host.safeStructuredClone(newPres.seperateModels) ?? {
        memory: "",
        emotion: "",
        translate: "",
        otherAx: "",
      };
    }
    if (!db.doNotChangeFallbackModels) {
      db.fallbackModels = host.safeStructuredClone(newPres.fallbackModels) ?? {
        memory: [],
        emotion: [],
        translate: [],
        otherAx: [],
        model: [],
      };
      db.fallbackWhenBlankResponse = newPres.fallbackWhenBlankResponse ?? false;
    }
    if (db.disableSeperateParameterChangeOnPresetChange) {
      db.seperateParameters = host.safeStructuredClone(db.seperateParameters);
    } else {
      db.seperateParameters = newPres.seperateParameters
        ? host.safeStructuredClone(newPres.seperateParameters)
        : {
            memory: {},
            emotion: {},
            translate: {},
            otherAx: {},
            overrides: {},
          };
    }
    db.modelTools = host.safeStructuredClone(newPres.modelTools ?? []);
    db.verbosity = newPres.verbosity ?? 1;
    db.dynamicOutput = newPres.dynamicOutput;

    return db;
  }
  function changeToPreset(id = 0, savecurrent = true) {
    if (savecurrent) {
      saveCurrentPreset();
    }
    let db = host.DBState.db;
    let pres = db.botPresets;
    const newPres = host.readResourceValue(pres[id]);
    db.botPresetsId = id;
    setPreset(db, newPres);
  }
  return { saveCurrentPreset, setPreset, changeToPreset };
}
