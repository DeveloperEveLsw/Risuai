import type { customscript } from '../../ts/storage/database.svelte'
import type { simpleCharacterArgument } from '../../ts/parser/parser.svelte'
import {
    stableTranslationJson,
    type TranslationContext,
    type TranslationSourceFormat,
} from '../../ts/translator/translationPlan'

export type ChatTranslationCharacter = simpleCharacterArgument | string | null

export interface ManualTranslationPresentationHandoff {
    /** Full manual-editor identity, excluding this handoff revision. */
    identityKey: string
    scopeKey: string
    revision: number
    /** Stored core translation, before edittrans/post-translation display. */
    core: string
    /** Exact preparation used by the editor's durable cache write. */
    target: ManualTranslationPreparedTarget
}

export interface ManualTranslationPreparedTarget {
    /** Full UI identity that produced this exact Markdown preparation. */
    identityKey: string
    /** Canonical message/context identity shared by main and bookmark mounts. */
    scopeKey: string
    translationInput: string
    /** Stable raw message identity used for manual overrides. */
    manualSource: string
    sourceFormat: TranslationSourceFormat
    context: TranslationContext
    manualKey?: string
    planKey?: string
    legacyKey?: string
}

export interface ChatTranslationIdentityInput {
    source: string
    manualSource: string
    displayCharacter: ChatTranslationCharacter
    translationCharacter: ChatTranslationCharacter
    chatId: number
    firstMessage: boolean
    role: string | null
    context: TranslationContext
    settings: unknown
    cacheRevision: number
    presentationRevision?: number
}

/**
 * UI translation work spans Markdown preparation, durable cache reads, and
 * delayed Svelte state transitions. Keep one opaque identity for every input
 * that may change the selected cache record or its final presentation.
 */
export function createChatTranslationIdentityKey(input: ChatTranslationIdentityInput): string {
    return stableTranslationJson({
        source: input.source,
        manualSource: input.manualSource,
        displayCharacter: input.displayCharacter,
        translationCharacter: input.translationCharacter,
        chatId: input.chatId,
        firstMessage: input.firstMessage,
        role: input.role,
        context: input.context,
        settings: input.settings,
        cacheRevision: input.cacheRevision,
        presentationRevision: input.presentationRevision ?? 0,
    })
}

/** Canonical message scope deliberately excludes the display speaker. */
export function createChatTranslationScopeKey(input: ChatTranslationIdentityInput): string {
    return stableTranslationJson({
        source: input.source,
        manualSource: input.manualSource,
        translationCharacter: input.translationCharacter,
        chatId: input.chatId,
        firstMessage: input.firstMessage,
        role: input.role,
        context: input.context,
        settings: input.settings,
        cacheRevision: input.cacheRevision,
    })
}

/**
 * This intentionally mirrors the settings consumed by the translator and by
 * ChatBody's pre/post-formatting branches. It is a local stale-work fence, not
 * a persisted cache key, so credentials are deliberately omitted.
 */
export function snapshotChatTranslationSettings(
    db: Record<string, any>,
    effective: {
        userName?: string
        currentCharacterName?: string
    } = {},
): unknown {
    const model = db.seperateModelsForAxModels && db.seperateModels?.translate
        ? db.seperateModels.translate
        : db.subModel
    const preset = db.translatorPresets?.[db.translatorPresetId]
    return {
        autoTranslate: db.autoTranslate,
        autoTranslateCachedOnly: db.autoTranslateCachedOnly,
        translateBeforeHTMLFormatting: db.translateBeforeHTMLFormatting,
        legacyTranslation: db.legacyTranslation,
        translatorType: db.translatorType,
        translator: db.translator,
        translatorInputLanguage: db.translatorInputLanguage,
        translatorPresetId: db.translatorPresetId,
        translatorPreset: preset,
        translatorPrompt: db.translatorPrompt,
        translatorMaxResponse: db.translatorMaxResponse,
        model,
        fallbackModels: db.fallbackModels?.translate,
        temperature: db.temperature,
        topP: db.top_p,
        topK: db.top_k,
        minP: db.min_p,
        topA: db.top_a,
        repetitionPenalty: db.repetition_penalty,
        frequencyPenalty: db.frequencyPenalty,
        presencePenalty: db.PresensePenalty,
        reasoningEffort: db.reasoningEffort,
        thinkingTokens: db.thinkingTokens,
        verbosity: db.verbosity,
        generationSeed: db.generationSeed,
        seperateParametersEnabled: db.seperateParametersEnabled,
        seperateParametersByModel: db.seperateParametersByModel,
        seperateParameters: db.seperateParameters,
        additionalParams: db.additionalParams,
        applyAdditionalParamsToAll: db.applyAdditionalParamsToAll,
        systemContentReplacement: db.systemContentReplacement,
        systemRoleReplacement: db.systemRoleReplacement,
        extractJson: db.extractJson,
        banCharacterset: db.banCharacterset,
        fallbackWhenBlankResponse: db.fallbackWhenBlankResponse,
        enableCustomFlags: db.enableCustomFlags,
        customFlags: db.customFlags,
        jsonSchemaEnabled: db.jsonSchemaEnabled,
        jsonSchema: db.jsonSchema,
        strictJsonSchema: db.strictJsonSchema,
        oaiPrediction: db.OAIPrediction,
        thinkingType: db.thinkingType,
        adaptiveThinkingEffort: db.adaptiveThinkingEffort,
        deepseekReasoningEffort: db.deepseekReasoningEffort,
        deepseekThinkingType: db.deepseekThinkingType,
        openAIFlexProcessing: db.openAIFlexProcessing,
        openrouterRequestModel: db.openrouterRequestModel,
        openrouterProvider: db.openrouterProvider,
        useInstructPrompt: db.useInstructPrompt,
        openrouterFallback: db.openrouterFallback,
        openrouterMiddleOut: db.openrouterMiddleOut,
        nanogptRequestModel: db.nanogptRequestModel,
        nanogptProvider: db.nanogptProvider,
        nanogptUseSubscriptionEndpoint: db.nanogptUseSubscriptionEndpoint,
        ollamaModel: db.ollamaModel,
        ollamaCloudModel: db.ollamaCloudModel,
        ollamaRequestFormat: db.ollamaRequestFormat,
        ollamaThinkingMode: db.ollamaThinkingMode,
        ollamaModelSource: db.ollamaModelSource,
        ollamaURL: db.ollamaURL,
        identityNames: {
            username: db.username,
            selectedPersona: db.selectedPersona,
            personas: db.personas,
            effectiveUserName: effective.userName,
            currentCharacterName: effective.currentCharacterName,
        },
        reverseProxy: {
            autofillRequestUrl: db.autofillRequestUrl,
            customProxyRequestModel: db.customProxyRequestModel,
            customAPIFormat: db.customAPIFormat,
            forceReplaceUrl: db.forceReplaceUrl,
            reverseProxyOobaArgs: db.reverseProxyOobaArgs,
            reverseProxyOobaMode: db.reverseProxyOobaMode,
        },
        customModels: (db.customModels ?? []).map((entry: Record<string, unknown>) => {
            const { key: _credential, ...semantic } = entry
            return semantic
        }),
        currentPluginProvider: db.currentPluginProvider,
        legacy: {
            ainconfig: db.ainconfig,
            novelAISettings: db.NAIsettings,
            novelAIAdventure: db.NAIadventure,
            novelAIAppendName: db.NAIappendName,
            ooba: db.ooba,
            localStopStrings: db.localStopStrings,
            maxContext: db.maxContext,
            maxResponse: db.maxResponse,
            echoMessage: db.echoMessage,
            instructChatTemplate: db.instructChatTemplate,
            jinjaTemplate: db.JinjaTemplate,
            username: db.username,
            textgenEndpoint: db.textgenWebUIBlockingURL,
            koboldEndpoint: db.koboldURL,
        },
    }
}

export interface TranslationRunToken {
    identityKey: string
    generation: number
}

/** Guards asynchronous results and timers, including ABA identity changes. */
export class TranslationResultHandoff<T> {
    private identityKey = ''
    private generation = 0
    private completed: T | undefined

    begin(identityKey: string): TranslationRunToken {
        if (identityKey !== this.identityKey) {
            this.identityKey = identityKey
            this.completed = undefined
        }
        this.generation += 1
        return { identityKey, generation: this.generation }
    }

    isCurrent(token: TranslationRunToken): boolean {
        return token.identityKey === this.identityKey && token.generation === this.generation
    }

    publish(token: TranslationRunToken, value: T): boolean {
        if (!this.isCurrent(token)) return false
        this.completed = value
        return true
    }

    read(identityKey: string): T | undefined {
        return identityKey === this.identityKey ? this.completed : undefined
    }

    clear(identityKey: string): void {
        if (identityKey === this.identityKey) this.completed = undefined
    }
}

export function applyCachedTranslationEditScripts(
    text: string,
    translationCharacter: ChatTranslationCharacter,
    moduleScripts: readonly customscript[],
    resolveCharacter: (id: string) => { customscript?: customscript[] } | null | undefined,
): string {
    // Preserve translateHTML's historical empty-string opt-out.
    if (translationCharacter === '') return text
    const owner = typeof translationCharacter === 'string'
        ? resolveCharacter(translationCharacter)
        : translationCharacter
    const scripts = [...moduleScripts, ...(owner?.customscript ?? [])]
    let result = text
    for (const script of scripts) {
        if (script.type !== 'edittrans') continue
        const expression = new RegExp(script.in, script.ableFlag ? script.flag : 'g')
        result = result.replace(expression, script.out.replaceAll('$n', '\n'))
    }
    return result
}
