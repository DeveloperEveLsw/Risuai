import { createPresetRuntime } from "./presetRuntime";
import {
  normalizePresetImportJson,
  PresetImportError,
  presetImportNumber,
} from "./presetImportJson";
import {
  entityRuntimeEnabled,
  browserRuntime as serverBrowserRuntime,
  reportRuntimeError,
} from "../runtime/browserRuntimeState.svelte";
function getPresetRuntime() {
  return createPresetRuntime({
    readResourceValue: (value) => value,
    DBState,
    safeStructuredClone,
    normalizePromptTemplate,
    LLMFormat,
  });
}
let browserRuntime: ReturnType<typeof createSettingsRuntime>;
import { get } from 'svelte/store';

import { checkNullish, decryptBuffer, encryptBuffer, selectSingleFile } from '../util';

import { changeLanguage, language } from '../../lang';

import type { RisuPlugin } from '../plugins/plugins.svelte';

import type {triggerscript as triggerscriptMain} from '../process/triggers';

import { downloadFile, saveAsset as saveImageGlobal } from '../globalApi.svelte';

import { defaultAutoSuggestPrompt, defaultJailbreak, defaultMainPrompt } from './defaultPrompts';

import { alertNormal } from '../alert';

import type { NAISettings } from '../process/models/nai';

import { prebuiltNAIpresets, prebuiltPresets } from '../process/templates/templates';

import { defaultColorScheme, type ColorScheme } from '../gui/colorscheme';

import type { PromptItem, PromptSettings } from '../process/prompt';

import type { OobaChatCompletionRequestParams } from '../model/ooba';

import { type HypaV3Settings, type HypaV3Preset, createHypaV3Preset } from '../process/memory/hypav3'

import { normalizeTranslatorPresetState, type TranslatorPreset } from '../translator/presets'

import { isTauri, isNodeServer } from "src/ts/platform"

import { safeStructuredClone } from '../polyfill';

import {
    DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
    DEFAULT_CHAT_LOAD_INITIAL_PAGES,
    normalizeChatLoadPages,
} from '../chatLoadPages';

export let appVer = "2026.8.250" //<APP_VERSION_POINT>

export let appSubVer = ''

export type StreamingDisplayOptimizationMode = 'off'|'balanced'|'strong'

export function setDatabase(data: Database) {
  return getBrowserRuntime().setDatabase(data);
}

export function setDatabaseLite(data:Database){
    DBState.db = data
}

interface getDatabaseOptions{
    snapshot?:boolean
}

export function getDatabase(options:getDatabaseOptions = {}):Database{
    if(options.snapshot){
        return $state.snapshot(DBState.db) as Database
    }
    return DBState.db as Database
}

export function getCurrentCharacter(options:getDatabaseOptions = {}):character|groupChat{
    const db = getDatabase(options)
    if(!db.characters){
        db.characters = []
    }
    const char = db.characters?.[get(selectedCharID)]
    return char
}

export function setCurrentCharacter(char:character|groupChat){
    if(!DBState.db.characters){
        DBState.db.characters = []
    }
    DBState.db.characters[get(selectedCharID)] = char
}

export function getCharacterByIndex(index:number,options:getDatabaseOptions = {}):character|groupChat{
    const db = getDatabase(options)
    if(!db.characters){
        db.characters = []
    }
    const char = db.characters?.[index]
    return char
}

export function setCharacterByIndex(index:number,char:character|groupChat){
    if(!DBState.db.characters){
        DBState.db.characters = []
    }
    DBState.db.characters[index] = char
}

export function getCurrentChat(){
    const char = getCurrentCharacter()
    return char?.chats?.[char.chatPage]
}

export function setCurrentChat(chat:Chat){
    const char = getCurrentCharacter()
    char.chats[char.chatPage] = chat
    setCurrentCharacter(char)
}

export interface DynamicOutput {
    autoAdjustSchema: boolean
    dynamicMessages: boolean
    dynamicMemory: boolean
    dynamicResponseTiming: boolean
    dynamicOutputPrompt: boolean
    showTypingEffect: boolean
    dynamicRequest: boolean
}

export interface RisuPersona {
    personaPrompt:string
    name:string
    icon:string
    largePortrait?:boolean
    id?:string
    note?:string
    embeddedModule?:RisuModule
}

export interface Database{
    characters: (character|groupChat)[],
    apiType: string
    openAIKey: string
    proxyKey:string
    mainPrompt: string
    jailbreak: string
    globalNote:string
    temperature: number
    askRemoval:boolean
    maxContext: number
    maxResponse: number
    frequencyPenalty: number
    PresensePenalty: number
    formatingOrder: FormatingOrderItem[]
    aiModel: string
    jailbreakToggle:boolean
    loreBookDepth: number
    loreBookToken: number,
    cipherChat: boolean,
    loreBook: {
        name:string
        data:loreBook[]
    }[]
    loreBookPage: number
    supaMemoryPrompt: string
    username: string
    userIcon: string
    userNote: string
    additionalPrompt: string
    descriptionPrefix: string
    forceReplaceUrl: string
    language: string
    translator: string
    plugins: RisuPlugin[]
    currentPluginProvider: string
    zoomsize:number
    customBackground:string
    textgenWebUIStreamURL:string
    textgenWebUIBlockingURL:string
    autoTranslate: boolean
    fullScreen:boolean
    playMessage:boolean
    iconsize:number
    theme: string
    subModel:string
    emotionPrompt: string,
    formatversion:number
    waifuWidth:number
    waifuWidth2:number
    botPresets:botPreset[]
    botPresetsId:number
    sdProvider: string
    webUiUrl:string
    sdSteps:number
    sdCFG:number
    sdConfig:sdConfig
    NAIImgUrl:string
    NAIApiKey:string
    NAIImgModel:string
    NAII2I:boolean
    NAIREF:boolean
    NAIImgConfig:NAIImgConfig
    ttsAutoSpeech?:boolean
    promptPreprocess:boolean
    bias: [string, number][]
    swipe:boolean
    instantRemove:boolean
    textTheme: string
    customTextTheme: {
        FontColorStandard: string,
        FontColorBold : string,
        FontColorItalic : string,
        FontColorItalicBold : string,
        FontColorQuote1 : string,
        FontColorQuote2 : string
    }
    requestRetrys:number
    localNetworkMode:boolean
    localNetworkTimeoutSec:number
    emotionPrompt2:string
    useSayNothing:boolean
    didFirstSetup: boolean
    showUnrecommended:boolean
    elevenLabKey:string
    voicevoxUrl:string
    useExperimental:boolean
    showMemoryLimit:boolean
    roundIcons:boolean
    useStreaming:boolean
    supaMemoryKey:string
    hypaMemoryKey:string
    voyageApiKey:string
    supaModelType:string
    textScreenColor?:string
    textBorder?:boolean
    textScreenRounded?:boolean
    textScreenBorder?:string
    characterOrder:(string|folder)[]
    hordeConfig:hordeConfig,
    novelai:{
        token:string,
        model:string
    }
    globalscript: customscript[],
    sendWithEnter:boolean
    fixedChatTextarea:boolean
    clickToEdit: boolean
    enableBlockPartialEdit: boolean
    enableDragPartialEdit: boolean
    koboldURL:string
    useAutoSuggestions:boolean
    autoSuggestPrompt:string
    autoSuggestPrefix:string
    autoSuggestClean:boolean
    claudeAPIKey:string,
    useChatCopy:boolean,
    novellistAPI:string,
    useAutoTranslateInput:boolean
    imageCompression:boolean
    account?:{
        token:string
        id:string,
        data: {
            refresh_token?:string,
            access_token?:string
            expires_in?: number
        }
        useSync?:boolean
        kei?:boolean
    },
    classicMaxWidth: boolean,
    useChatSticker:boolean,
    useAdditionalAssetsPreview:boolean,
    usePlainFetch:boolean
    hypaMemory:boolean
    hypav2:boolean
    memoryAlgorithmType:string // To enable new memory module/algorithms 
    proxyRequestModel:string
    ooba:OobaSettings
    ainconfig: AINsettings
    personaPrompt:string
    openrouterRequestModel:string
    openrouterKey:string
    openrouterMiddleOut:boolean
    nanogptKey:string
    nanogptRequestModel:string
    nanogptRequestModelName:string
    nanogptProvider:string
    nanogptSubscriptionState:string
    nanogptUseSubscriptionEndpoint:boolean
    openrouterFallback:boolean
    selectedPersona:number
    personas:RisuPersona[]
    personaNote:boolean
    assetWidth:number
    animationSpeed:number
    botSettingAtStart:false
    NAIsettings:NAISettings
    hideRealm:boolean
    colorScheme:ColorScheme
    colorSchemeName:string
    customColorScheme:ColorScheme
    promptTemplate?:PromptItem[]
    forceProxyAsOpenAI?:boolean
    hypaModel:HypaModel
    saveTime?:number
    mancerHeader:string
    emotionProcesser:'submodel'|'embedding',
    showMenuChatList?:boolean,
    translatorType:'google'|'deepl'|'none'|'llm'|'deeplX'|'bergamot',
    translatorInputLanguage?:string
    htmlTranslation?:boolean,
    NAIadventure?:boolean,
    NAIappendName?:boolean,
    deeplOptions:{
        key:string,
        freeApi:boolean
    }
    deeplXOptions:{
        url:string,
        token:string    
    }
    localStopStrings?:string[]
    autofillRequestUrl:boolean
    customProxyRequestModel:string
    generationSeed:number
    newOAIHandle:boolean
    gptVisionQuality:string
    reverseProxyOobaMode:boolean
    reverseProxyOobaArgs: OobaChatCompletionRequestParams
    huggingfaceKey:string
    fishSpeechKey:string
    allowAllExtentionFiles?:boolean
    translatorPrompt:string
    translatorMaxResponse:number
    translatorPresets: TranslatorPreset[]
    translatorPresetId: number
    top_p: number,
    google: {
        accessToken: string
        projectId: string
    }
    mistralKey?:string
    chainOfThought?:boolean
    genTime:number
    promptSettings: PromptSettings
    keiServerURL:string
    top_k:number
    repetition_penalty:number
    min_p:number
    top_a:number
    claudeAws:boolean
    lastPatchNoteCheckVersion?:string,
    removePunctuationHypa?:boolean
    memoryLimitThickness?:number
    modules: RisuModule[]
    enabledModules: string[]
    sideMenuRerollButton?:boolean
    requestInfoInsideChat?:boolean
    additionalParams:[string, string][]
    applyAdditionalParamsToAll:boolean
    heightMode:string
    noWaitForTranslate:boolean
    antiClaudeOverload:boolean
    maxSupaChunkSize:number
    ollamaURL:string
    ollamaModel:string
    ollamaModelSource:'local'|'cloud'
    ollamaInputMode:'list'|'manual'
    ollamaRequestFormat:LLMFormat
    ollamaApiKey:string
    ollamaModelName:string
    ollamaCloudModel:string
    ollamaCloudModelName:string
    ollamaThinkingMode:'auto'|'off'|'on'|'low'|'medium'|'high'
    autoContinueChat:boolean
    autoContinueMinTokens:number
    removeIncompleteResponse:boolean
    customTokenizer:string
    instructChatTemplate:string
    JinjaTemplate:string
    openrouterProvider: {
        order: string[]
        only: string[]
        ignore: string[]
    }
    useInstructPrompt:boolean
    hanuraiTokens:number
    hanuraiSplit:boolean
    hanuraiEnable:boolean
    textAreaSize:number
    sideBarSize:number
    textAreaTextSize:number
    combineTranslation:boolean
    dynamicAssets:boolean
    dynamicAssetsEditDisplay:boolean
    customPromptTemplateToggle:string
    globalChatVariables:{[key:string]:string}
    templateDefaultVariables:string
    hypaAllocatedTokens:number
    hypaChunkSize:number
    cohereAPIKey:string
    goCharacterOnImport:boolean
    dallEQuality:string
    font: string
    customFont: string
    lineHeight: number
    stabilityModel: string
    stabilityKey: string
    stabllityStyle: string
    legacyTranslation: boolean
    comfyConfig: ComfyConfig
    comfyUiUrl: string
    useLegacyGUI: boolean
    claudeCachingExperimental: boolean
    hideApiKey: boolean
    unformatQuotes: boolean
    enableDevTools: boolean
    falToken: string
    falModel: string
    falLora: string
    falLoraName: string
    falLoraScale: number
    moduleIntergration: string
    customCSS: string
    betaMobileGUI:boolean
    jsonSchemaEnabled:boolean
    jsonSchema:string
    strictJsonSchema:boolean
    extractJson:string
    statics: {
        messages: number
        imports: number
    }
    customQuotes:boolean
    customQuotesData?:[string, string, string, string]
    groupTemplate?:string
    groupOtherBotRole?:string
    customGUI:string
    guiHTML:string
    OAIPrediction:string
    customAPIFormat:LLMFormat
    systemContentReplacement:string
    systemRoleReplacement:'user'|'assistant'
    vertexPrivateKey: string
    vertexClientEmail: string
    vertexAccessToken: string
    vertexAccessTokenExpires: number
    vertexRegion: string
    seperateParametersEnabled:boolean
    seperateParameters:{
        memory: SeparateParameters,
        emotion: SeparateParameters,
        translate: SeparateParameters,
        otherAx: SeparateParameters
        overrides: Record<string, SeparateParameters>
    }
    translateBeforeHTMLFormatting:boolean
    autoTranslateCachedOnly:boolean
    lightningRealmImport:boolean
    notification: boolean
    customFlags: LLMFlags[]
    enableCustomFlags: boolean
    googleClaudeTokenizing: boolean
    presetChain: string
    legacyMediaFindings?:boolean
    geminiStream?:boolean
    assetMaxDifference:number
    auxModelUnderModelSettings:boolean
    menuSideBar:boolean
    pluginV2: RisuPlugin[]
    showSavingIcon:boolean
    presetRegex: customscript[]
    banCharacterset:string[]
    showPromptComparison:boolean
    hypaV3:boolean
    hypaV3Settings: HypaV3Settings // legacy
    hypaV3Presets: HypaV3Preset[]
    hypaV3PresetId: number
    realmDirectOpen:boolean
    OaiCompAPIKeys: {[key:string]:string}
    inlayErrorResponse:boolean
    reasoningEffort:number
    bulkEnabling:boolean
    showTranslationLoading: boolean
    showDeprecatedTriggerV1:boolean
    showDeprecatedTriggerV2:boolean
    returnCSSError:boolean
    checkCorruption?: boolean
    toggleConfirmRecommendedPreset?: boolean
    useExperimentalGoogleTranslator:boolean
    thinkingTokens: number
    thinkingType: 'off' | 'budget' | 'adaptive'
    deepseekThinkingType: 'off' | 'enabled'
    adaptiveThinkingEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    deepseekReasoningEffort: 'high' | 'max'
    antiServerOverloads: boolean
    hypaCustomSettings: {
        url: string,
        key: string,
        model: string,       
    },
    localActivationInGlobalLorebook: boolean
    showFolderName: boolean
    automaticCachePoint: boolean
    coldstorage: boolean
    claudeRetrivalCaching: boolean
    outputImageModal: boolean
    playMessageOnTranslateEnd:boolean
    seperateModelsForAxModels:boolean
    seperateModels:{
        memory: string
        emotion: string
        translate: string
        otherAx: string
    }
    doNotChangeSeperateModels:boolean
    modelTools: string[]
    hotkeys:Hotkey[]
    fallbackModels: {
        memory: string[],
        emotion: string[],
        translate: string[],
        otherAx: string[]
        model: string[]
    }
    doNotChangeFallbackModels: boolean
    fallbackWhenBlankResponse: boolean
    customModels: {
        id: string
        internalId: string
        url: string
        format: LLMFormat
        tokenizer: LLMTokenizer
        key: string
        name: string
        params: string
        flags: LLMFlags[]
    }[]
    igpPrompt:string
    useTokenizerCaching:boolean
    showMenuHypaMemoryModal:boolean
    authRefreshes:{
        url:string
        tokenUrl:string
        refreshToken:string
        clientId:string
        clientSecret:string
    }[]
    promptInfoInsideChat:boolean
    promptTextInfoInsideChat:boolean
    openAIFlexProcessing:boolean
    claudeBatching:boolean
    claude1HourCaching:boolean
    rememberToolUsage:boolean
    simplifiedToolUse:boolean
    requestLocation:string
    newImageHandlingBeta?: boolean
    showFirstMessagePages:boolean
    streamGeminiThoughts:boolean
    verbosity:number
    dynamicOutput?:DynamicOutput
    hubServerType?:string
    pluginCustomStorage:{[key:string]:any}
    ImagenModel:string
    ImagenImageSize:string
    ImagenAspectRatio:string
    ImagenPersonGeneration:string,
    enableScrollToActiveChar:boolean
    openaiCompatImage: {
        url: string
        key: string
        model: string
        size: string
        quality: string
    }
    wavespeedImage: {
        key: string
        model: string
        loras: Array<{path: string, scale: number}>,
        reference_mode: string
        reference_image: string
        reference_base64image: string
    }
    settingsCloseButtonSize:number
    promptDiffPrefs:PromptDiffPrefs
    enableBookmark?: boolean
    hideAllImages?: boolean
    autoScrollToNewMessage?: boolean
    alwaysScrollToNewMessage?: boolean
    newMessageButtonStyle?: string
    chatLoadInitialPages?: number
    chatLoadAdditionalPages?: number
    streamingDisplayOptimizationMode?: StreamingDisplayOptimizationMode
    pluginDevelopMode?: boolean
    echoMessage?:string
    echoDelay?:number
    createFolderOnBranch?:boolean
    hamburgerButtonBottom?:boolean
    enableRemoteSaving?:boolean
    blockquoteStyling?:boolean
    dynamicModelRegistry?:boolean
    enableRisuaiProTools?:boolean
    epEnabled?:boolean
    seperateParametersByModel?:boolean
    disableSeperateParameterChangeOnPresetChange?:boolean
    saveSignatures?:boolean
    keepSessionAlive: 'off' | 'pip' | 'sound'
    longPressToPopupEditor?: boolean
    loadouts: Loadout[]
    loadoutApplyOptions: {
        modules: boolean
        globalVariables: boolean
        preset: boolean
        persona: boolean
    }
    disableAprilFools?:boolean
    customSidebarItems: CustomSideBarItem[]
    lastLoadedLoadoutName: string
    moveInsteadOfCopyOnCMPConvert?:boolean
    skipSavingAssetsOnWebSync?:boolean
}

export interface CustomSideBarItem{
    id: string
    type: 'model'|'databaseKey'|'loadout'|'persona'|'preset'|'setting'
    subType: string
    label: string
}

export interface SeparateParameters{
    temperature?:number
    top_k?:number
    repetition_penalty?:number
    min_p?:number
    top_a?:number
    top_p?:number
    frequency_penalty?:number
    presence_penalty?:number
    reasoning_effort?:number
    thinking_tokens?:number
    thinking_type?: 'off' | 'budget' | 'adaptive'
    deepseek_thinking_type?: 'off' | 'enabled'
    adaptive_thinking_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    deepseek_reasoning_effort?: 'high' | 'max'
    outputImageModal?:boolean
    verbosity?:number
}

type OutputModal = 'image'|'audio'|'video'

export interface customscript{
    comment: string;
    in:string
    out:string
    type:string
    flag?:string
    ableFlag?:boolean

}

export type triggerscript = triggerscriptMain

export interface loreBook{
    key:string
    secondkey:string
    insertorder: number
    comment: string
    content: string
    mode: 'multiple'|'constant'|'normal'|'child'|'folder',
    alwaysActive: boolean
    selective:boolean
    extentions?:{
        risu_case_sensitive:boolean
    }
    activationPercent?:number
    loreCache?:{
        key:string
        data:string[]
    },
    useRegex?:boolean
    bookVersion?:number
    id?:string
    folder?:string
}

export interface character{
    type?:"character"
    name:string
    image?:string
    firstMessage:string
    desc:string
    notes:string
    chats:Chat[]
    chatFolders: ChatFolder[]
    chatPage: number
    viewScreen: 'emotion'|'none'|'imggen',
    bias: [string, number][]
    emotionImages: [string, string][]
    globalLore: loreBook[]
    chaId: string
    sdData: [string, string][]
    newGenData?: {
        prompt: string,
        negative: string,
        instructions: string,
        emotionInstructions: string,
    }
    customscript: customscript[]
    triggerscript: triggerscript[]
    utilityBot: boolean
    exampleMessage:string
    removedQuotes?:boolean
    creatorNotes:string
    systemPrompt:string
    postHistoryInstructions:string
    alternateGreetings:string[]
    tags:string[]
    creator:string
    characterVersion: string
    personality:string
    scenario:string
    firstMsgIndex:number
    loreSettings?:loreSettings
    loreExt?:any
    additionalData?: {
        tag?:string[]
        creator?:string
        character_version?:string
    }
    ttsMode?:string
    ttsSpeech?:string
    voicevoxConfig?:{
        speaker?: string
        SPEED_SCALE?: number
        PITCH_SCALE?: number
        INTONATION_SCALE?: number
        VOLUME_SCALE?: number
    }
    naittsConfig?:{
        customvoice?: boolean
        voice?: string
        version?: string
    }
    gptSoVitsConfig?:{
        url?:string
        use_auto_path?:boolean
        ref_audio_path?:string
        use_long_audio?:boolean
        ref_audio_data?: {
            fileName:string
            assetId:string
        }
        volume?:number
        text_lang?: "auto" | "auto_yue" | "en" | "zh" | "ja" | "yue" | "ko" | "all_zh" | "all_ja" | "all_yue" | "all_ko"
        text?:string
        use_prompt?:boolean
        prompt?:string | null
        prompt_lang?: "auto" | "auto_yue" | "en" | "zh" | "ja" | "yue" | "ko" | "all_zh" | "all_ja" | "all_yue" | "all_ko"
        top_p?:number
        temperature?:number
        speed?:number
        top_k?:number
        text_split_method?: "cut0" | "cut1" | "cut2" | "cut3" | "cut4" | "cut5"
    }
    fishSpeechConfig?:{
        model?: {
            _id:string
            title:string
            description:string
        },
        chunk_length:number,
        normalize:boolean,

    }
    supaMemory?:boolean
    additionalAssets?:[string, string, string][]
    ttsReadOnlyQuoted?:boolean
    replaceGlobalNote:string
    backgroundHTML?:string
    reloadKeys?:number
    backgroundCSS?:string
    license?:string
    private?:boolean
    additionalText:string
    oaiVoice?:string
    oaiTTSConfig?:{
        /** User opted into advanced OpenAI-compatible settings. When false/absent,
         *  tts.ts ignores the other fields and uses the legacy oaiVoice + db.openAIKey path. */
        enabled?: boolean
        /** Base URL, trailing slash trimmed at runtime. Falls back to 'https://api.openai.com/v1'. */
        baseURL?: string
        /** Per-character API key. Falls back to db.openAIKey; the Authorization header is omitted entirely when both are empty. */
        apiKey?: string
        /** Model ID. Falls back to 'tts-1'. */
        model?: string
        /** Freeform voice ID for custom endpoints. Falls back to character.oaiVoice, then to 'alloy'. */
        voice?: string
        /** Response format. Falls back to 'mp3'. */
        format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'
    }
    virtualscript?:string
    scriptstate?:{[key:string]:string|number|boolean}
    depth_prompt?: { depth: number, prompt: string }
    extentions?:{[key:string]:any}
    largePortrait?:boolean
    lorePlus?:boolean
    inlayViewScreen?:boolean
    hfTTS?: {
        model: string
        language: string
    },
    vits?: OnnxModelFiles
    realmId?:string
    imported?:boolean
    trashTime?:number
    nickname?:string
    source?:string[]
    group_only_greetings?:string[]
    creation_date?:number
    modification_date?:number
    ccAssets?: Array<{
        type: string
        uri: string
        name: string
        ext: string
    }>
    defaultVariables?:string
    lowLevelAccess?:boolean
    hideChatIcon?:boolean
    lastInteraction?:number
    translatorNote?:string
    doNotChangeSeperateModels?:boolean
    escapeOutput?:boolean
    prebuiltAssetCommand?:boolean
    prebuiltAssetStyle?:string
    prebuiltAssetExclude?:string[]
    modules?:string[]
    moduleNamespace?:string
    coldstorage?:string
    coldStoragedChats?:string[]
    customModuleToggle?:string
}

export interface loreSettings{
    tokenBudget: number
    scanDepth:number
    recursiveScanning: boolean
    fullWordMatching?: boolean
}

export interface groupChat{ 
    type: 'group'
    image?:string
    firstMessage:string
    chats:Chat[]
    chatFolders: ChatFolder[]
    chatPage: number
    name:string
    viewScreen: 'single'|'multiple'|'none'|'emp',
    characters:string[]
    characterTalks:number[]
    characterActive:boolean[]
    globalLore: loreBook[]
    autoMode: boolean
    useCharacterLore :boolean
    emotionImages: [string, string][]
    customscript: customscript[],
    chaId: string
    alternateGreetings?: string[]
    creatorNotes?:string,
    removedQuotes?:boolean
    firstMsgIndex?:number,
    loreSettings?:loreSettings
    supaMemory?:boolean
    ttsMode?:string
    suggestMessages?:string[]
    orderByOrder?:boolean
    backgroundHTML?:string,
    reloadKeys?:number
    backgroundCSS?:string
    oneAtTime?:boolean
    virtualscript?:string
    lorePlus?:boolean
    trashTime?:number
    nickname?:string
    defaultVariables?:string
    lowLevelAccess?:boolean
    hideChatIcon?:boolean
    lastInteraction?:number

    //lazy hack for typechecking
    voicevoxConfig?:any
    ttsSpeech?:string
    naittsConfig?:any
    oaiVoice?:string
    oaiTTSConfig?:any
    hfTTS?: any
    vits?: OnnxModelFiles
    gptSoVitsConfig?:any
    fishSpeechConfig?:any
    ttsReadOnlyQuoted?:boolean
    exampleMessage?:string
    systemPrompt?:string
    replaceGlobalNote?:string
    additionalText?:string
    personality?:string
    scenario?:string
    translatorNote?:string
    additionalData?: any
    depth_prompt?: { depth: number, prompt: string }
    additionalAssets?:[string, string, string][]
    utilityBot?:boolean
    license?:string
    realmId:string
    prebuiltAssetCommand?:boolean
    prebuiltAssetStyle?:string
    prebuiltAssetExclude?:string[]
    modules?:string[]
    coldstorage?:string
    coldStoragedChats?:string[]
}

export interface botPreset{
    id?: string
    name?:string
    apiType?: string
    openAIKey?: string
    localNetworkMode?: boolean
    localNetworkTimeoutSec?: number
    mainPrompt: string
    jailbreak: string
    globalNote:string
    temperature: number
    maxContext: number
    maxResponse: number
    frequencyPenalty: number
    PresensePenalty: number
    formatingOrder: FormatingOrderItem[]
    aiModel?: string
    subModel?:string
    currentPluginProvider?:string
    textgenWebUIStreamURL?:string
    textgenWebUIBlockingURL?:string
    forceReplaceUrl?:string
    forceReplaceUrl2?:string
    promptPreprocess: boolean,
    bias: [string, number][]
    proxyRequestModel?:string
    openrouterRequestModel?:string
    proxyKey?:string
    ooba: OobaSettings
    ainconfig: AINsettings
    koboldURL?: string
    NAISettings?: NAISettings
    autoSuggestPrompt?: string
    autoSuggestPrefix?: string
    autoSuggestClean?: boolean
    promptTemplate?:PromptItem[]
    NAIadventure?: boolean
    NAIappendName?: boolean
    localStopStrings?: string[]
    customProxyRequestModel?: string
    reverseProxyOobaArgs?: OobaChatCompletionRequestParams
    top_p?: number
    promptSettings?: PromptSettings
    repetition_penalty?:number
    min_p?:number
    top_a?:number
    openrouterProvider?: {
        order: string[]
        only: string[]
        ignore: string[]
    }
    useInstructPrompt?:boolean
    customPromptTemplateToggle?:string
    templateDefaultVariables?:string
    moduleIntergration?:string
    top_k?:number
    instructChatTemplate?:string
    JinjaTemplate?:string
    jsonSchemaEnabled?:boolean
    jsonSchema?:string
    strictJsonSchema?:boolean
    extractJson?:string
    groupTemplate?:string
    groupOtherBotRole?:string
    seperateParametersEnabled?:boolean
    seperateParameters?:{
        memory: SeparateParameters,
        emotion: SeparateParameters,
        translate: SeparateParameters,
        otherAx: SeparateParameters
        overrides: Record<string, SeparateParameters>
    }
    customAPIFormat?:LLMFormat
    systemContentReplacement?: string
    systemRoleReplacement?: 'user'|'assistant'
    enableCustomFlags?: boolean
    customFlags?: LLMFlags[]
    image?:string
    regex?:customscript[]
    reasonEffort?:number
    thinkingTokens?:number
    thinkingType?: 'off' | 'budget' | 'adaptive'
    deepseekThinkingType?: 'off' | 'enabled'
    adaptiveThinkingEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    deepseekReasoningEffort?: 'high' | 'max'
    outputImageModal?:boolean
    seperateModelsForAxModels?:boolean
    seperateModels?:{
        memory: string
        emotion: string
        translate: string
        otherAx: string
    }
    modelTools?:string[]
    fallbackModels?: {
        memory: string[],
        emotion: string[],
        translate: string[],
        otherAx: string[]
        model: string[]
    }
    fallbackWhenBlankResponse?: boolean
    verbosity?:number
    dynamicOutput?:DynamicOutput
}

interface hordeConfig{
    apiKey:string
    model:string
    softPrompt:string
}

export interface folder{
    name:string
    data:string[]
    color:string
    id:string
    imgFile?:string
    img?:string
}

interface sdConfig{
    width:number
    height:number
    sampler_name:string
    script_name:string
    denoising_strength:number
    enable_hr:boolean
    hr_scale: number
    hr_upscaler:string
}

export interface NAIImgConfig{
    width:number,
    height:number,
    sampler:string,
    noise_schedule:string,
    steps:number,
    scale:number,
    cfg_rescale:number,
    sm:boolean,
    sm_dyn:boolean,
    noise:number,
    strength:number,
    image:string,
    base64image:string,
    InfoExtracted:number,
    //add 4
    autoSmea:boolean,
    use_coords:boolean,
    legacy_uc: boolean,
    v4_prompt:NAIImgConfigV4Prompt,
    v4_negative_prompt:NAIImgConfigV4NegativePrompt,
    //add vibe
    reference_image_multiple?:string[],
    reference_strength_multiple?:number[],
    vibe_data?:NAIVibeData,
    vibe_model_selection?:string
    //add variety+ and decrisp options
    variety_plus:boolean,
    decrisp:boolean,
    //add character reference
    reference_mode:string,
    character_image:string,
    character_base64image:string,
    style_aware:boolean,
}

interface NAIImgConfigV4Prompt{
    caption: NAIImgConfigV4Caption,
    use_coords: boolean,
    use_order: boolean
}

interface NAIImgConfigV4NegativePrompt{
    caption: NAIImgConfigV4Caption,
    legacy_uc: boolean
}

interface NAIImgConfigV4Caption{
    base_caption: string,
    char_captions: NAIImgConfigV4CharCaption[]
}

interface NAIImgConfigV4CharCaption{
    char_caption: string,
    centers:
        {
            x: number,
            y: number
        }[]
}

interface NAIVibeData {
    identifier: string;
    version: number;
    type: string;
    image: string;
    id: string;
    encodings: {
        [key: string]: {
            [key: string]: NAIVibeEncoding;
        }
    };
    name: string;
    thumbnail: string;
    createdAt: number;
    importInfo: {
        model: string;
        information_extracted: number;
        strength: number;
    };
}

interface NAIVibeEncoding {
    encoding: string;
    params: {
        information_extracted: number;
    };
}

interface ComfyConfig{
    workflow:string,
    posNodeID: string,
    posInputName:string,
    negNodeID: string,
    negInputName:string,
    timeout: number
}

export type FormatingOrderItem = 'main'|'jailbreak'|'chats'|'lorebook'|'globalNote'|'authorNote'|'lastChat'|'description'|'postEverything'|'personaPrompt'

export interface Chat{
    message: Message[]
    note:string
    name:string
    localLore: loreBook[]
    sdData?:string
    supaMemoryData?:string
    hypaV2Data?:SerializableHypaV2Data
    lastMemory?:string
    suggestMessages?:string[]
    isStreaming?:boolean
    activeStreamingDisplayOptimizationMode?:StreamingDisplayOptimizationMode
    scriptstate?:{[key:string]:string|number|boolean}
    modules?:string[]
    id?:string
    bindedPersona?:string
    fmIndex?:number
    hypaV3Data?:SerializableHypaV3Data
    folderId?:string
    lastDate?:number
    bookmarks?: string[];
    bookmarkNames?: { [chatId: string]: string };
    useLocallySetGlobalVariables?: boolean
    GLGlobalVariables?: { [key: string]: string }
}

export interface ChatFolder{
    id:string
    name?:string
    color?:string
    folded:boolean
}

export interface Message{
    role: 'user'|'char'
    data: string
    saying?: string
    chatId?:string
    time?: number
    generationInfo?: MessageGenerationInfo
    promptInfo?: MessagePresetInfo
    name?:string
    otherUser?:boolean
    disabled?:false|true|'allBefore'
    isComment?:boolean
}

export interface MessageGenerationInfo{
    model?: string
    generationId?: string
    inputTokens?: number
    outputTokens?: number
    maxContext?: number
    stageTiming?: {
        stage1?: number
        stage2?: number
        stage3?: number
        stage4?: number
    }
}

export interface MessagePresetInfo{
    promptName?: string,
    promptToggles?: {key: string, value: string}[],
    promptText?: OpenAIChat[],
}

export interface PromptDiffPrefs {
    diffStyle: 'line' | 'intraline'
    formatStyle: 'raw' | 'card'
    viewStyle: 'unified' | 'split'
    isGrouped: boolean
    showOnlyChanges: boolean
    contextRadius: number
}

export interface AINsettings{
    top_p: number,
    rep_pen: number,
    top_a: number,
    rep_pen_slope:number,
    rep_pen_range: number,
    typical_p:number
    badwords:string
    stoptokens:string
    top_k:number
}

export interface OobaSettings{
    max_new_tokens: number,
    do_sample: boolean,
    temperature: number,
    top_p: number,
    typical_p: number,
    repetition_penalty: number,
    encoder_repetition_penalty: number,
    top_k: number,
    min_length: number,
    no_repeat_ngram_size: number,
    num_beams: number,
    penalty_alpha: number,
    length_penalty: number,
    early_stopping: boolean,
    seed: number,
    add_bos_token: boolean,
    truncation_length: number,
    ban_eos_token: boolean,
    skip_special_tokens: boolean,
    top_a: number,
    tfs: number,
    epsilon_cutoff: number,
    eta_cutoff: number,
    formating:{
        header:string,
        systemPrefix:string,
        userPrefix:string,
        assistantPrefix:string
        seperator:string
        useName:boolean
    }
}

export const saveImage = saveImageGlobal;

export const defaultAIN: AINsettings = getBrowserRuntime().defaultAIN;

export const defaultOoba: OobaSettings = getBrowserRuntime().defaultOoba;

export const presetTemplate: botPreset = getBrowserRuntime().presetTemplate;

export const defaultSdDataFunc = () => getDefaultSdData(safeStructuredClone);

export function saveCurrentPreset() {
  if (entityRuntimeEnabled) {
    void serverBrowserRuntime()
      .saveActiveLibrary("preset")
      .catch(reportRuntimeError);
    return;
  }
  return getPresetRuntime().saveCurrentPreset();
}

export function copyPreset(id: number) {
  if (entityRuntimeEnabled) {
    const stableId = DBState.db.botPresets[id]?.id;
    if (!stableId) return;
    return (async () => {
      await serverBrowserRuntime().saveActiveLibrary("preset");
      const resource = await serverBrowserRuntime().getLibraryResource(
        "preset",
        stableId,
      );
      await serverBrowserRuntime().saveLibraryResource("preset", {
        ...resource.payload,
        id: crypto.randomUUID(),
        name: String(resource.payload.name ?? "") + " Copy",
      });
    })().catch(reportRuntimeError);
  }
  saveCurrentPreset();
  let db = DBState.db;
  let pres = db.botPresets;
  const newPres = safeStructuredClone(pres[id]);
  newPres.name += " Copy";
  db.botPresets.push(newPres);
}

export function changeToPreset(id = 0, savecurrent = true) {
  if (entityRuntimeEnabled) {
    const stableId = DBState.db.botPresets[id]?.id;
    if (stableId)
      void serverBrowserRuntime()
        .activateLibrary("preset", stableId, savecurrent)
        .catch(reportRuntimeError);
    return;
  }
  if (savecurrent) {
    saveCurrentPreset();
  }
  let db = DBState.db;
  let pres = db.botPresets;
  const newPres = pres[id];
  db.botPresetsId = id;
  setPreset(db, newPres);
}

export function setPreset(db: Database, newPres: botPreset) {
  return getPresetRuntime().setPreset(db, newPres);
}

import { encode as encodeMsgpack, decode as decodeMsgpack } from "msgpackr/index-no-eval";

import * as fflate from "fflate";

import type { OnnxModelFiles } from '../process/transformers';

import type { RisuModule } from '../process/modules';

import type { SerializableHypaV2Data } from '../process/memory/hypav2';

import { decodeRPack, encodeRPack } from '../rpack/rpack_js';

import { DBState, selectedCharID } from '../stores.svelte';

import { LLMFlags, LLMFormat, LLMTokenizer } from '../model/modellist';

import type { HypaModel } from '../process/memory/hypamemory';

import type { SerializableHypaV3Data } from '../process/memory/hypav3';

import { defaultHotkeys, type Hotkey } from '../defaulthotkeys';

import type { OpenAIChat } from '../process/index.svelte';

import type { Loadout } from '../loadout';

export async function downloadPreset(
  id: number,
  type: "json" | "risupreset" | "return" = "json",
) {
  const stableId = DBState.db.botPresets[id]?.id;
  let pres: botPreset;
  if (entityRuntimeEnabled) {
    await serverBrowserRuntime().saveActiveLibrary("preset");
    pres = (await serverBrowserRuntime().getLibraryResource("preset", stableId))
      .payload as unknown as botPreset;
  } else {
    saveCurrentPreset();
    pres = safeStructuredClone(getDatabase().botPresets[id]);
  }
  pres.openAIKey = "";
  pres.forceReplaceUrl = "";
  pres.forceReplaceUrl2 = "";
  pres.proxyKey = "";
  pres.textgenWebUIStreamURL = "";
  pres.textgenWebUIBlockingURL = "";

  if (type === "json") {
    downloadFile(
      pres.name + "_preset.json",
      Buffer.from(JSON.stringify(pres, null, 2)),
    );
  } else if (type === "risupreset" || type === "return") {
    const buf = fflate.compressSync(
      encodeMsgpack({
        presetVersion: 2,
        type: "preset",
        preset: await encryptBuffer(encodeMsgpack(pres), "risupreset"),
      }),
    );

    const buf2 = await encodeRPack(buf);

    if (type === "risupreset") {
      downloadFile(pres.name + "_preset.risup", buf2);
    } else {
      return {
        data: pres,
        buf: buf2,
      };
    }
  }

  alertNormal(language.successExport);

  return {
    data: pres,
    buf: null,
  };
}

export async function importPreset(
  f: {
    name: string;
    data: Uint8Array;
  } | null = null,
) {
  if (!f) {
    f = await selectSingleFile(["json", "preset", "risupreset", "risup"]);
  }
  if (!f) {
    return;
  }
  let sourcePreset: Record<string, unknown>;
  if (f.name.endsWith(".risupreset") || f.name.endsWith(".risup")) {
    let data = f.data;
    if (f.name.endsWith(".risup")) {
      data = await decodeRPack(data);
    }
    const decoded = await decodeMsgpack(fflate.decompressSync(data));
    if (
      (decoded?.presetVersion === 0 || decoded?.presetVersion === 2) &&
      decoded.type === "preset"
    ) {
      sourcePreset = normalizePresetImportJson(
        decodeMsgpack(
          Buffer.from(
            await decryptBuffer(decoded.preset ?? decoded.pres, "risupreset"),
          ),
        ),
      );
    } else {
      throw new PresetImportError("$", "unsupported packed preset format");
    }
  } else {
    sourcePreset = normalizePresetImportJson(
      JSON.parse(Buffer.from(f.data).toString("utf-8")),
    );
  }
  const pre: any = { ...presetTemplate, ...sourcePreset };
  if (pre?.promptTemplate !== undefined) {
    pre.promptTemplate = normalizePromptTemplate(pre.promptTemplate);
  }
  let db = DBState.db;
  async function saveImportedPreset(preset: botPreset) {
    const payload = normalizePresetImportJson(
      entityRuntimeEnabled ? { ...preset, id: crypto.randomUUID() } : preset,
    );
    if (entityRuntimeEnabled)
      await serverBrowserRuntime().saveLibraryResource("preset", payload);
    else {
      if (!Array.isArray(db.botPresets)) db.botPresets = [];
      db.botPresets.push(payload as unknown as botPreset);
    }
  }
  if (pre.presetVersion && pre.presetVersion >= 3) {
    //NAI preset
    const pr = safeStructuredClone(prebuiltPresets.NAI);
    const parameters = pre.parameters;
    if (
      !parameters ||
      typeof parameters !== "object" ||
      Array.isArray(parameters)
    ) {
      throw new PresetImportError(
        "$.parameters",
        "expected a parameter object",
      );
    }
    pr.temperature = presetImportNumber(
      parameters.temperature,
      pr.temperature,
      "$.parameters.temperature",
      100,
    );
    pr.maxResponse = presetImportNumber(
      parameters.max_length,
      pr.maxResponse,
      "$.parameters.max_length",
    );
    pr.NAISettings.topK = presetImportNumber(
      parameters.top_k,
      pr.NAISettings.topK,
      "$.parameters.top_k",
    );
    pr.NAISettings.topP = presetImportNumber(
      parameters.top_p,
      pr.NAISettings.topP,
      "$.parameters.top_p",
    );
    pr.NAISettings.topA = presetImportNumber(
      parameters.top_a,
      pr.NAISettings.topA,
      "$.parameters.top_a",
    );
    pr.NAISettings.typicalp = presetImportNumber(
      parameters.typical_p,
      pr.NAISettings.typicalp,
      "$.parameters.typical_p",
    );
    pr.NAISettings.tailFreeSampling = presetImportNumber(
      parameters.tail_free_sampling,
      pr.NAISettings.tailFreeSampling,
      "$.parameters.tail_free_sampling",
    );
    pr.NAISettings.repetitionPenalty = presetImportNumber(
      parameters.repetition_penalty,
      pr.NAISettings.repetitionPenalty,
      "$.parameters.repetition_penalty",
    );
    pr.NAISettings.repetitionPenaltyRange = presetImportNumber(
      parameters.repetition_penalty_range,
      pr.NAISettings.repetitionPenaltyRange,
      "$.parameters.repetition_penalty_range",
    );
    pr.NAISettings.repetitionPenaltySlope = presetImportNumber(
      parameters.repetition_penalty_slope,
      pr.NAISettings.repetitionPenaltySlope,
      "$.parameters.repetition_penalty_slope",
    );
    pr.NAISettings.frequencyPenalty = presetImportNumber(
      parameters.repetition_penalty_frequency,
      pr.NAISettings.frequencyPenalty,
      "$.parameters.repetition_penalty_frequency",
    );
    pr.NAISettings.repostitionPenaltyPresence = presetImportNumber(
      parameters.repetition_penalty_presence,
      pr.NAISettings.repostitionPenaltyPresence,
      "$.parameters.repetition_penalty_presence",
    );
    pr.PresensePenalty = presetImportNumber(
      parameters.repetition_penalty_presence,
      pr.PresensePenalty,
      "$.parameters.repetition_penalty_presence",
      100,
    );
    pr.NAISettings.cfg_scale = presetImportNumber(
      parameters.cfg_scale,
      pr.NAISettings.cfg_scale,
      "$.parameters.cfg_scale",
    );
    pr.NAISettings.mirostat_lr = presetImportNumber(
      parameters.mirostat_lr,
      pr.NAISettings.mirostat_lr,
      "$.parameters.mirostat_lr",
    );
    pr.NAISettings.mirostat_tau = presetImportNumber(
      parameters.mirostat_tau,
      pr.NAISettings.mirostat_tau,
      "$.parameters.mirostat_tau",
    );
    pr.name = pre.name ?? "Imported";
    await saveImportedPreset(pr);
    return;
  }

  if (
    Array.isArray(pre?.prompt_order?.[0]?.order) &&
    Array.isArray(pre?.prompts)
  ) {
    //ST preset
    const pr = safeStructuredClone(presetTemplate);
    pr.promptTemplate = [];

    function findPrompt(identifier: number) {
      return pre.prompts.find((p: any) => p.identifier === identifier);
    }
    pr.temperature = presetImportNumber(
      sourcePreset.temperature,
      pr.temperature,
      "$.temperature",
      100,
    );
    pr.frequencyPenalty = presetImportNumber(
      sourcePreset.frequency_penalty,
      pr.frequencyPenalty,
      "$.frequency_penalty",
      100,
    );
    pr.PresensePenalty = presetImportNumber(
      sourcePreset.presence_penalty,
      pr.PresensePenalty,
      "$.presence_penalty",
      70,
    );
    pr.top_p = presetImportNumber(sourcePreset.top_p, pr.top_p, "$.top_p");

    for (const prompt of pre.prompt_order[0].order) {
      if (!prompt?.enabled) {
        continue;
      }
      const p = findPrompt(prompt?.identifier ?? "");
      if (p) {
        switch (p.identifier) {
          case "main": {
            pr.promptTemplate.push({
              type: "plain",
              type2: "main",
              text: p.content ?? "",
              role: p.role ?? "system",
            });
            break;
          }
          case "jailbreak":
          case "nsfw": {
            pr.promptTemplate.push({
              type: "jailbreak",
              type2: "normal",
              text: p.content ?? "",
              role: p.role ?? "system",
            });
            break;
          }
          case "dialogueExamples":
          case "charPersonality":
          case "scenario": {
            break; //ignore
          }
          case "chatHistory": {
            pr.promptTemplate.push({
              type: "chat",
              rangeEnd: "end",
              rangeStart: 0,
            });
            break;
          }
          case "worldInfoBefore": {
            pr.promptTemplate.push({
              type: "lorebook",
            });
            break;
          }
          case "worldInfoAfter": {
            break;
          }
          case "charDescription": {
            pr.promptTemplate.push({
              type: "description",
            });
            break;
          }
          case "personaDescription": {
            pr.promptTemplate.push({
              type: "persona",
            });
            break;
          }
          default: {
            console.log(p);
            pr.promptTemplate.push({
              type: "plain",
              type2: "normal",
              text: p.content ?? "",
              role: p.role ?? "system",
            });
          }
        }
      } else {
        console.log("Prompt not found", prompt);
      }
    }
    if (pre?.assistant_prefill) {
      pr.promptTemplate.push({
        type: "postEverything",
      });
      pr.promptTemplate.push({
        type: "plain",
        type2: "main",
        text: `{{#if {{prefill_supported}}}}${pre?.assistant_prefill}{{/if}}`,
        role: "bot",
      });
    }
    pr.promptTemplate = normalizePromptTemplate(pr.promptTemplate);
    pr.name = "Imported ST Preset";
    await saveImportedPreset(pr);
    return;
  }
  pre.name ??= "Imported";
  await saveImportedPreset(pre);
}

function normalizePromptRole(role: unknown): "user" | "bot" | "system" | null {
  return getBrowserRuntime().normalizePromptRole(role);
}

function normalizeCacheRole(
  role: unknown,
): "user" | "assistant" | "system" | "all" {
  return getBrowserRuntime().normalizeCacheRole(role);
}

function normalizePromptTemplate(
  template: PromptItem[] | null | undefined,
): PromptItem[] | null {
  return getBrowserRuntime().normalizePromptTemplate(template);
}

import { getDefaultSdData } from "./defaultCharacterData";
import { createSettingsRuntime } from "./settingsRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createSettingsRuntime({
    get checkNullish(): typeof checkNullish {
      return checkNullish;
    },
    get defaultMainPrompt(): typeof defaultMainPrompt {
      return defaultMainPrompt;
    },
    get defaultJailbreak(): typeof defaultJailbreak {
      return defaultJailbreak;
    },
    get defaultAutoSuggestPrompt(): typeof defaultAutoSuggestPrompt {
      return defaultAutoSuggestPrompt;
    },
    get safeStructuredClone(): typeof safeStructuredClone {
      return safeStructuredClone;
    },
    get prebuiltNAIpresets(): typeof prebuiltNAIpresets {
      return prebuiltNAIpresets;
    },
    get defaultColorScheme(): typeof defaultColorScheme {
      return defaultColorScheme;
    },
    get LLMFormat(): typeof LLMFormat {
      return LLMFormat;
    },
    get createHypaV3Preset(): typeof createHypaV3Preset {
      return createHypaV3Preset;
    },
    get normalizeTranslatorPresetState(): typeof normalizeTranslatorPresetState {
      return normalizeTranslatorPresetState;
    },
    get defaultHotkeys(): typeof defaultHotkeys {
      return defaultHotkeys;
    },
    get normalizeChatLoadPages(): typeof normalizeChatLoadPages {
      return normalizeChatLoadPages;
    },
    get DEFAULT_CHAT_LOAD_INITIAL_PAGES(): typeof DEFAULT_CHAT_LOAD_INITIAL_PAGES {
      return DEFAULT_CHAT_LOAD_INITIAL_PAGES;
    },
    get DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES(): typeof DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES {
      return DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES;
    },
    get isNodeServer(): typeof isNodeServer {
      return isNodeServer;
    },
    get isTauri(): typeof isTauri {
      return isTauri;
    },
    get changeLanguage(): typeof changeLanguage {
      return changeLanguage;
    },
    get setDatabaseLite(): typeof setDatabaseLite {
      return setDatabaseLite;
    },
  }));
}
