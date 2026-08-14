import { get, writable } from "svelte/store"
import { parseChatML } from "../parser/chatML";
import {
    getCurrentCharacter,
    getCurrentChat,
    getDatabase,
    type character,
    type customscript,
    type groupChat,
} from "../storage/database.svelte"
import { onDatabaseUpdate } from "../storage/databaseState.svelte"
import {
    defaultTranslatorPrompt,
    getCurrentTranslatorPresetFromState,
    type TranslatorPreset,
} from "./presets";
import { globalFetch } from "../globalApi.svelte"
import { isTauri, isNodeServer } from "src/ts/platform"
import { alertError } from "../alert"
import {
    requestChatData,
    translationRequestPipelineIsStateful,
} from "../process/request/request"
import { doingChat, type OpenAIChat } from "../process/index.svelte"
import { onSelectedCharacterChanged } from "../selectionEvents"
import { applyMarkdownToNode, type simpleCharacterArgument } from "../parser/parser.svelte"
import { getModuleRegexScripts } from "../process/modules"
import { findCharacterbyId, getNodetextToSentence, getUserName, sleep } from "../util"
import localforage from "localforage"
import sendSound from '../../etc/send.mp3'
import { safeStructuredClone } from "../polyfill"
import { getModelInfo, LLMFormat } from "../model/modellist"
import {
    createTranslationAbortError,
    createManualTranslationCacheKey,
    finalizeTranslation,
    isAbortError,
    prepareTranslationPlan,
    throwIfTranslationAborted,
    type TranslationContext,
    type TranslationPlanV1,
    type TranslationSourceFormat,
} from "./translationPlan"

let bergamotTranslate: (text: string, from: string, to: string, html?: boolean) => Promise<string>|null = null

const persistentLLMCacheStorage = localforage.createInstance({
    name: "LLMTranslateCache"
})

interface LLMCacheLike {
    getItem<T>(key: string): Promise<T | null>
    setItem<T>(key: string, value: T): Promise<T>
    removeItem(key: string): Promise<void>
    iterate<T, U>(iterator: (value: T, key: string, iterationNumber: number) => U): Promise<U | undefined>
    clear(): Promise<void>
}

export interface TranslationOptions {
    signal?: AbortSignal
    force?: boolean
    context?: TranslationContext
    sourceFormat?: TranslationSourceFormat
    /** Stable canonical source used only for manual-override identity. A
     * stateful display parser may produce a different prepared string on each
     * render, while the user's correction still belongs to one message. */
    manualSource?: string
    /** Preserve the caller's last good presentation when an explicit
     * retranslation fails instead of treating the source fallback as success. */
    throwOnFailure?: boolean
}

export class TranslationProviderError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'TranslationProviderError'
    }
}

export interface TranslationCacheMutationScope {
    characterId?: string
    chatId?: string
    messageId?: string
}

export interface TranslationCacheMutationEvent {
    revision: number
    reason: 'manual' | 'force' | 'import' | 'clear'
    touchedKeys: string[]
    scope: TranslationCacheMutationScope | null
    /** Ephemeral core result for stateful force operations that intentionally
     * are not persisted in the generated cache. */
    result?: string
}

export interface TranslationCacheRecord {
    schemaVersion: 1
    version: number
    result: string
    origin?: 'generated' | 'manual' | 'imported'
    updatedAt?: number
    /** Local-only compatibility metadata. The legacy cache already persisted
     * source text as its key; semantic keys remain opaque exact handles. */
    sourceSearchText?: string
}

interface TranslationFlight {
    key: string
    version: number
    controller: AbortController
    promise: Promise<string>
    waiters: Set<symbol>
    settled: boolean
}

class VolatileLLMCache implements LLMCacheLike {
    private readonly values = new Map<string, unknown>()
    private readonly maxEntries = 256

    async getItem<T>(key: string) {
        if (!this.values.has(key)) {
            return null
        }
        const value = this.values.get(key) as T
        // Refresh insertion order for a small in-memory LRU. Nothing is left
        // in a PC/phone IndexedDB after the page closes.
        this.values.delete(key)
        this.values.set(key, value)
        return value
    }

    async setItem<T>(key: string, value: T) {
        this.values.delete(key)
        this.values.set(key, value)
        while (this.values.size > this.maxEntries) {
            const oldest = this.values.keys().next().value
            if (typeof oldest !== 'string') {
                break
            }
            this.values.delete(oldest)
        }
        return value
    }

    async removeItem(key: string) {
        this.values.delete(key)
    }

    async iterate<T, U>(iterator: (value: T, key: string, iterationNumber: number) => U) {
        let iteration = 1
        for (const [key, value] of this.values) {
            const result = iterator(value as T, key, iteration++)
            if (result !== undefined) {
                return result
            }
        }
        return undefined
    }

    async clear() {
        this.values.clear()
    }
}

export const LLMCacheStorage: LLMCacheLike = isNodeServer
    ? new VolatileLLMCache()
    : persistentLLMCacheStorage

export async function clearNodeLegacyLLMCache() {
    if (isNodeServer) {
        await persistentLLMCacheStorage.clear()
    }
}

let waitTrans = 0

const translationFlights = new Map<string, TranslationFlight>()
// Operation versions fence superseded in-flight work. Committed versions are
// advanced only after storage accepts a result, so a failed/aborted force
// attempt never makes the last good record unreadable.
const translationVersions = new Map<string, number>()
const translationCommittedVersions = new Map<string, number>()
const translationWriteChains = new Map<string, Promise<void>>()
const translationKeyEpochs = new Map<string, number>()
const translationExplicitWriteRevisions = new Map<string, number>()
const translationForceMutationRevisions = new Map<string, number>()
let lastTranslationUpdatedAt = 0
let translationCacheEpoch = 0
let translationCacheBarrier: Promise<void> = Promise.resolve()
let translationDatabaseEpoch = 0
let translationCacheRevision = 0
let translationCacheMutationReason: 'clear' | 'import' | null = null
export const TranslationCacheRevisionStore = writable(0)
let translationCacheMutationRevision = 0
const translationCacheMutationListeners = new Set<(
    event: TranslationCacheMutationEvent,
) => void>()
export const TranslationCacheMutationStore = writable<TranslationCacheMutationEvent>({
    revision: 0,
    reason: 'clear',
    touchedKeys: [],
    scope: null,
})

/** Future-only mutation stream. Unlike a Svelte readable, subscribe does not
 * replay the last stateful result to a ChatBody mounted after publication. */
export function subscribeTranslationCacheMutations(
    listener: (event: TranslationCacheMutationEvent) => void,
): () => void {
    translationCacheMutationListeners.add(listener)
    return () => translationCacheMutationListeners.delete(listener)
}

export function getTranslationCacheRevision(): number {
    return translationCacheRevision
}

export function getTranslationCacheMutationReason(): 'clear' | 'import' | null {
    return translationCacheMutationReason
}

function bumpTranslationCacheRevision(reason: 'clear' | 'import'): void {
    translationCacheMutationReason = reason
    translationCacheRevision++
    TranslationCacheRevisionStore.set(translationCacheRevision)
}

function publishTranslationCacheMutation(
    reason: TranslationCacheMutationEvent['reason'],
    touchedKeys: Iterable<string>,
    context: TranslationContext | null = null,
    result?: string,
): number {
    const scope = context ? {
        characterId: context.characterId,
        chatId: context.chatId,
        messageId: context.messageId,
    } : null
    const revision = ++translationCacheMutationRevision
    const event: TranslationCacheMutationEvent = {
        revision,
        reason,
        touchedKeys: [...new Set(touchedKeys)],
        scope,
        ...(result === undefined ? {} : { result }),
    }
    TranslationCacheMutationStore.set(event)
    for (const listener of translationCacheMutationListeners) {
        try {
            listener(event)
        } catch (error) {
            console.error(error)
        }
    }
    return revision
}

// A semantic hash detects A -> B changes, but not A -> B -> A while the
// provider is building its request from live settings. Fence only fields that
// influence the effective translation request; chat/script state is excluded
// because stateful request hooks are allowed to mutate it during execution.
const translationSemanticDatabaseKeys = new Set([
    'translatorType', 'translator', 'translatorInputLanguage',
    'translatorPresetId', 'translatorPresets', 'translatorPrompt',
    'translatorMaxResponse', 'subModel', 'fallbackModels',
    'seperateModelsForAxModels', 'seperateModels', 'temperature', 'top_p',
    'top_k', 'min_p', 'top_a', 'repetition_penalty', 'frequencyPenalty',
    'PresensePenalty', 'reasoningEffort', 'thinkingTokens', 'verbosity',
    'generationSeed', 'seperateParametersEnabled', 'seperateParametersByModel',
    'seperateParameters', 'additionalParams', 'applyAdditionalParamsToAll',
    'systemContentReplacement', 'systemRoleReplacement', 'extractJson',
    'banCharacterset', 'fallbackWhenBlankResponse', 'ainconfig', 'NAIsettings',
    'NAIadventure', 'NAIappendName', 'ooba', 'localStopStrings', 'maxContext',
    'maxResponse', 'echoMessage', 'instructChatTemplate', 'JinjaTemplate',
    'openrouterRequestModel', 'openrouterProvider', 'useInstructPrompt',
    'openrouterFallback', 'openrouterMiddleOut', 'nanogptRequestModel',
    'nanogptProvider', 'nanogptUseSubscriptionEndpoint', 'ollamaModel',
    'ollamaCloudModel', 'ollamaRequestFormat', 'ollamaThinkingMode',
    'ollamaModelSource', 'ollamaURL', 'autofillRequestUrl',
    'customProxyRequestModel', 'customAPIFormat', 'forceReplaceUrl',
    'reverseProxyOobaArgs', 'reverseProxyOobaMode', 'customModels',
    'currentPluginProvider', 'jsonSchemaEnabled', 'jsonSchema',
    'strictJsonSchema', 'OAIPrediction', 'thinkingType',
    'adaptiveThinkingEffort', 'deepseekReasoningEffort',
    'deepseekThinkingType', 'openAIFlexProcessing', 'enableCustomFlags', 'customFlags',
    'textgenWebUIBlockingURL', 'koboldURL', 'username', 'selectedPersona',
    'personas',
])

onDatabaseUpdate((update) => {
    const root = update.path[0]
    if (typeof root !== 'string') {
        translationDatabaseEpoch++
        return
    }
    if (translationSemanticDatabaseKeys.has(root)) {
        translationDatabaseEpoch++
        return
    }
    if (root === 'characters') {
        const characterIndex = update.path[1]
        if (typeof characterIndex === 'number') {
            const updatedCharacter = getDatabase().characters?.[characterIndex]
            const currentCharacter = getCurrentCharacter()
            if (
                updatedCharacter
                && currentCharacter
                && updatedCharacter !== currentCharacter
                && updatedCharacter.chaId !== currentCharacter.chaId
            ) {
                return
            }
        }
        const characterField = update.path[2]
        if (
            update.path.length <= 2
            || characterField === 'name'
            || characterField === 'nickname'
            || characterField === 'translatorNote'
        ) {
            translationDatabaseEpoch++
        }
    }
})

onSelectedCharacterChanged(() => {
    translationDatabaseEpoch++
})

function bumpTranslationKeyEpoch(key: string): void {
    translationKeyEpochs.set(key, (translationKeyEpochs.get(key) ?? 0) + 1)
}

function bumpTranslationExplicitWriteRevision(key: string): void {
    translationExplicitWriteRevisions.set(
        key,
        (translationExplicitWriteRevisions.get(key) ?? 0) + 1,
    )
}

type TranslationExplicitWriteRevisionSnapshot = ReadonlyMap<string, number>

function getTranslationExplicitKeys(prepared: PreparedLLMTranslation): string[] {
    return [...new Set([
        prepared.manualKey,
        prepared.plan.key,
        prepared.plan.source,
    ])]
}

function captureTranslationExplicitWriteRevisions(
    prepared: PreparedLLMTranslation,
): TranslationExplicitWriteRevisionSnapshot {
    return new Map(getTranslationExplicitKeys(prepared).map((key) => [
        key,
        translationExplicitWriteRevisions.get(key) ?? 0,
    ]))
}

function translationExplicitWriteRevisionsAreCurrent(
    snapshot: TranslationExplicitWriteRevisionSnapshot,
): boolean {
    for (const [key, revision] of snapshot) {
        if ((translationExplicitWriteRevisions.get(key) ?? 0) !== revision) {
            return false
        }
    }
    return true
}

async function readExplicitTranslationWrittenAfter(
    prepared: PreparedLLMTranslation,
    baseline: TranslationExplicitWriteRevisionSnapshot,
    signal: AbortSignal,
): Promise<TranslationCacheRecord | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
        const current = captureTranslationExplicitWriteRevisions(prepared)
        const changedKeys = getTranslationExplicitKeys(prepared)
            .filter((key) => (current.get(key) ?? 0) !== (baseline.get(key) ?? 0))
        if (changedKeys.length === 0) return null

        const records = new Map<string, TranslationCacheRecord | null>()
        for (const key of changedKeys) {
            records.set(key, await readTranslationCacheRecord(key))
            throwIfTranslationAborted(signal)
        }
        if (!translationExplicitWriteRevisionsAreCurrent(current)) continue

        for (const key of getTranslationExplicitKeys(prepared)) {
            const record = records.get(key)
            if (record && isExplicitTranslationCacheRecord(record)) return record
        }
        return null
    }
    throw createTranslationAbortError()
}

function nextTranslationUpdatedAt(): number {
    lastTranslationUpdatedAt = Math.max(Date.now(), lastTranslationUpdatedAt + 1)
    return lastTranslationUpdatedAt
}

function isTranslationCacheRecord(value: unknown): value is TranslationCacheRecord {
    return typeof value === 'object' && value !== null
        && (value as TranslationCacheRecord).schemaVersion === 1
        && Number.isInteger((value as TranslationCacheRecord).version)
        && (value as TranslationCacheRecord).version > 0
        && typeof (value as TranslationCacheRecord).result === 'string'
        && (
            (value as TranslationCacheRecord).origin === undefined
            || (value as TranslationCacheRecord).origin === 'generated'
            || (value as TranslationCacheRecord).origin === 'manual'
            || (value as TranslationCacheRecord).origin === 'imported'
        )
        && (
            (value as TranslationCacheRecord).updatedAt === undefined
            || Number.isFinite((value as TranslationCacheRecord).updatedAt)
        )
}

function isExplicitTranslationCacheRecord(record: TranslationCacheRecord): boolean {
    return record.origin === 'manual' || record.origin === 'imported'
}

async function readTranslationCacheRecord(key: string): Promise<TranslationCacheRecord | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const barrier = translationCacheBarrier
        const epoch = translationCacheEpoch
        await barrier
        if (barrier !== translationCacheBarrier || epoch !== translationCacheEpoch) continue
        const pendingWrite = translationWriteChains.get(key)
        if (pendingWrite) {
            await pendingWrite.catch(() => {})
            continue
        }
        const keyEpoch = translationKeyEpochs.get(key) ?? 0
        const stored = await LLMCacheStorage.getItem<unknown>(key)
        if (
            epoch !== translationCacheEpoch
            || keyEpoch !== (translationKeyEpochs.get(key) ?? 0)
            || translationWriteChains.has(key)
        ) continue
        if (!isTranslationCacheRecord(stored)) {
            return null
        }
        const knownVersion = translationCommittedVersions.get(key) ?? 0
        if (stored.version < knownVersion) continue
        translationCommittedVersions.set(key, Math.max(knownVersion, stored.version))
        translationVersions.set(key, Math.max(translationVersions.get(key) ?? 0, stored.version))
        lastTranslationUpdatedAt = Math.max(lastTranslationUpdatedAt, stored.updatedAt ?? 0)
        return stored
    }
    return null
}

function reserveTranslationVersion(key: string, cachedVersion = 0): number {
    const version = Math.max(
        translationVersions.get(key) ?? 0,
        translationCommittedVersions.get(key) ?? 0,
        cachedVersion,
    ) + 1
    translationVersions.set(key, version)
    return version
}

async function writeTranslationRecordIfCurrent(
    key: string,
    record: TranslationCacheRecord,
    canWrite: () => boolean | Promise<boolean> = () => true,
): Promise<boolean> {
    const barrierAtStart = translationCacheBarrier
    const previous = translationWriteChains.get(key) ?? Promise.resolve()
    let wrote = false
    const write = previous.catch(() => {}).then(async () => {
        await barrierAtStart
        if ((translationVersions.get(key) ?? 0) !== record.version || !(await canWrite())) {
            return
        }
        const previousStored = await LLMCacheStorage.getItem<unknown>(key)
        if ((translationVersions.get(key) ?? 0) !== record.version || !(await canWrite())) {
            return
        }
        await LLMCacheStorage.setItem<TranslationCacheRecord>(key, record)
        if ((translationVersions.get(key) ?? 0) !== record.version || !(await canWrite())) {
            const current = await LLMCacheStorage.getItem<unknown>(key)
            if (isTranslationCacheRecord(current) && current.version === record.version) {
                if (previousStored === null) {
                    await LLMCacheStorage.removeItem(key)
                } else {
                    await LLMCacheStorage.setItem(key, previousStored)
                }
            }
            return
        }
        translationCommittedVersions.set(
            key,
            Math.max(translationCommittedVersions.get(key) ?? 0, record.version),
        )
        wrote = true
    })
    translationWriteChains.set(key, write)
    bumpTranslationKeyEpoch(key)
    try {
        await write
    } finally {
        if (translationWriteChains.get(key) === write) {
            translationWriteChains.delete(key)
            bumpTranslationKeyEpoch(key)
        }
    }
    return wrote
}

async function removeTranslationRecordIfOperationCurrent(
    key: string,
    operationVersion: number | null,
    expectedCommittedVersion: number,
    canRemove: () => boolean = () => true,
): Promise<boolean> {
    if (operationVersion === null) return false
    const barrierAtStart = translationCacheBarrier
    const previous = translationWriteChains.get(key) ?? Promise.resolve()
    let removed = false
    const removal = previous.catch(() => {}).then(async () => {
        await barrierAtStart
        if ((translationVersions.get(key) ?? 0) !== operationVersion || !canRemove()) return
        const current = await LLMCacheStorage.getItem<unknown>(key)
        if (
            !isTranslationCacheRecord(current)
            || current.version !== expectedCommittedVersion
            || (translationVersions.get(key) ?? 0) !== operationVersion
            || !canRemove()
        ) {
            return
        }
        await LLMCacheStorage.removeItem(key)
        if ((translationVersions.get(key) ?? 0) !== operationVersion || !canRemove()) {
            const afterRemoval = await LLMCacheStorage.getItem<unknown>(key)
            if (afterRemoval === null) {
                await LLMCacheStorage.setItem(key, current)
            }
            return
        }
        // A successful removal is a committed tombstone. Delayed readers that
        // captured the old record must not resurrect it after a force result
        // has explicitly superseded the manual/imported override.
        translationCommittedVersions.set(
            key,
            Math.max(translationCommittedVersions.get(key) ?? 0, operationVersion),
        )
        removed = true
    })
    translationWriteChains.set(key, removal)
    bumpTranslationKeyEpoch(key)
    try {
        await removal
    } finally {
        if (translationWriteChains.get(key) === removal) {
            translationWriteChains.delete(key)
            bumpTranslationKeyEpoch(key)
        }
    }
    return removed
}

function invalidateTranslationFlight(flight: TranslationFlight): void {
    if (translationFlights.get(flight.key) === flight) {
        translationFlights.delete(flight.key)
    }
    if ((translationVersions.get(flight.key) ?? 0) === flight.version) {
        translationVersions.set(flight.key, flight.version + 1)
    }
    if (!flight.controller.signal.aborted) {
        flight.controller.abort(createTranslationAbortError())
    }
}

function joinTranslationFlight(flight: TranslationFlight, signal?: AbortSignal): Promise<string> {
    throwIfTranslationAborted(signal)
    const waiter = Symbol('translation-waiter')
    flight.waiters.add(waiter)

    return new Promise<string>((resolve, reject) => {
        let done = false
        const finish = (callback: () => void) => {
            if (done) return
            done = true
            signal?.removeEventListener('abort', onAbort)
            flight.controller.signal.removeEventListener('abort', onFlightAbort)
            flight.waiters.delete(waiter)
            callback()
        }
        const onAbort = () => {
            finish(() => reject(createTranslationAbortError(signal)))
            if (!flight.settled && flight.waiters.size === 0) {
                invalidateTranslationFlight(flight)
            }
        }
        const onFlightAbort = () => {
            finish(() => reject(createTranslationAbortError(flight.controller.signal)))
        }

        signal?.addEventListener('abort', onAbort, { once: true })
        flight.controller.signal.addEventListener('abort', onFlightAbort, { once: true })
        flight.promise.then(
            (result) => finish(() => resolve(result)),
            (error) => finish(() => reject(error))
        )
    })
}

async function awaitWithTranslationSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfTranslationAborted(signal)
    if (!signal) return promise
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(createTranslationAbortError(signal))
        signal.addEventListener('abort', onAbort, { once: true })
        promise.then(
            (result) => {
                signal.removeEventListener('abort', onAbort)
                resolve(result)
            },
            (error) => {
                signal.removeEventListener('abort', onAbort)
                reject(error)
            }
        )
    })
}

async function translationSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
        await sleep(ms)
        return
    }
    await new Promise<void>((resolve, reject) => {
        throwIfTranslationAborted(signal)
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(createTranslationAbortError(signal))
        }
        signal.addEventListener('abort', onAbort, { once: true })
    })
}

function detectTranslationSourceFormat(text: string): TranslationSourceFormat {
    return /<\/?[A-Za-z][^>]*>|<risu-style>/i.test(text)
        ? 'html-segments-v1'
        : 'plain'
}

export function resolveTranslationContext(
    charArg: simpleCharacterArgument | string = '',
    messageIndex = -1,
    explicit?: TranslationContext
): TranslationContext {
    if (explicit) {
        return {
            characterId: explicit.characterId,
            chatId: explicit.chatId,
            messageId: explicit.messageId,
            translatorNote: explicit.translatorNote ?? '',
        }
    }

    const db = getDatabase()
    const requestedCharacterId = typeof charArg === 'string' ? charArg : charArg?.chaId
    // A mounted Chat may hold an old simple-character snapshot after its note
    // is edited. Re-resolve by the explicit id, without borrowing another
    // selected character, and freeze the live note for this invocation.
    const liveCharacter = requestedCharacterId
        ? db.characters.find((entry) => entry.chaId === requestedCharacterId)
        : getCurrentCharacter()
    const snapshotCharacter = typeof charArg === 'string' ? null : charArg
    const characterId = liveCharacter?.chaId ?? requestedCharacterId ?? snapshotCharacter?.chaId
    const translatorNote = liveCharacter?.type === 'character'
        ? liveCharacter.translatorNote ?? ''
        : snapshotCharacter?.translatorNote ?? ''

    let chat = liveCharacter?.chats?.[liveCharacter.chatPage]
    if (!requestedCharacterId && !chat) {
        chat = getCurrentChat()
    }
    return {
        characterId,
        chatId: chat?.id,
        messageId: messageIndex >= 0
            ? chat?.message?.[messageIndex]?.chatId ?? String(messageIndex)
            : undefined,
        translatorNote,
    }
}

export function getCurrentTranslatorPreset(): TranslatorPreset {
    return getCurrentTranslatorPresetFromState(getDatabase())
}

export async function translate(text:string, reverse:boolean, options: TranslationOptions = {}) {
    const db = getDatabase()
    return runTranslator(
        text,
        reverse,
        db.translator,
        db.aiModel.startsWith('novellist') ? 'ja' : 'en',
        options
    )
}

export async function runTranslator(
    text:string,
    reverse:boolean,
    from:string,
    target:string,
    exarg: TranslationOptions & { translatorNote?: string } = {}
) {
    const operationCacheEpoch = translationCacheEpoch
    throwIfTranslationAborted(exarg.signal)
    const context: TranslationContext = exarg.context
        ?? (exarg.translatorNote
            ? { translatorNote: exarg.translatorNote }
            : resolveTranslationContext())
    const arg = {
        from: reverse ? from : target,
        to: reverse ? target : from,
        host: 'translate.googleapis.com',
        context,
        force: exarg.force ?? false,
        sourceFormat: exarg.sourceFormat ?? 'plain' as TranslationSourceFormat,
        manualSource: exarg.manualSource,
        signal: exarg.signal,
        cacheEpoch: operationCacheEpoch,
        throwOnFailure: exarg.throwOnFailure,
    }
    const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [text]
    const results: string[] = []
    let pending = ''
    let translationFailed = false

    const flush = async () => {
        if (!pending) return
        throwIfTranslationAborted(exarg.signal)
        const leading = pending.match(/^\s*/)?.[0] ?? ''
        const trailing = pending.match(/\s*$/)?.[0] ?? ''
        const bodyEnd = Math.max(leading.length, pending.length - trailing.length)
        const body = pending.slice(leading.length, bodyEnd)
        if (!body) {
            results.push(pending)
            pending = ''
            return
        }
        const translated = await translateMain(body, arg)
        throwIfTranslationAborted(exarg.signal)
        if (translated.startsWith('ERR::')) {
            alertError(translated)
            translationFailed = true
            pending = ''
            return
        }
        results.push(leading + translated.trim() + trailing)
        pending = ''
    }

    for (const lineWithEnding of lines) {
        if (translationFailed) break
        const line = lineWithEnding.endsWith('\n') ? lineWithEnding.slice(0, -1) : lineWithEnding
        const trimmed = line.trim()
        const protectedDirective = /^\{\{(?:img|raw|video|audio)(?=[\s:}|]).*\}\}$/i.test(trimmed)
        if (!trimmed || protectedDirective) {
            await flush()
            results.push(lineWithEnding)
        } else {
            pending += lineWithEnding
        }
    }
    await flush()
    if (translationFailed) return text
    return results.join('')
}

async function translateMain(text:string, arg:{
    from:string,
    to:string,
    host:string,
    context: TranslationContext,
    force: boolean,
    sourceFormat: TranslationSourceFormat,
    manualSource?: string,
    signal?: AbortSignal,
    cacheEpoch: number,
    throwOnFailure?: boolean,
}){
    throwIfTranslationAborted(arg.signal)
    const db = getDatabase()
    if(db.translatorType === 'llm'){
        const tr = arg.to || 'en'
        return translateLLM(text, {
            to: tr,
            from: arg.from,
            force: arg.force,
            context: arg.context,
            sourceFormat: arg.sourceFormat,
            manualSource: arg.manualSource,
            signal: arg.signal,
            cacheEpoch: arg.cacheEpoch,
            throwOnFailure: arg.throwOnFailure,
        })
    }
    if(db.translatorType === 'deepl'){
        const body = {
            text: [text],
            target_lang: arg.to.toLocaleUpperCase(),
        }
        let url = db.deeplOptions.freeApi ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate"
        const f = await globalFetch(url, {
            headers: {
                "Authorization": "DeepL-Auth-Key " + db.deeplOptions.key,
                "Content-Type": "application/json"
            },
            body: body,
            abortSignal: arg.signal,
            logFetch: false,
        })

        throwIfTranslationAborted(arg.signal)

        if(!f.ok){
            return 'ERR::DeepL API Error' + (await f.data)
        }
        return f.data.translations[0].text

    }
    if(db.translatorType === 'deeplX'){
        if(!db.noWaitForTranslate){
            if(waitTrans - Date.now() > 0){
                const waitTime = waitTrans - Date.now()
                waitTrans = Date.now() + 3000
                await translationSleep(waitTime, arg.signal)
            }
        }

        let url = db.deeplXOptions.url ?? 'http://localhost:1188'

        if(url.endsWith('/')){
            url = url.slice(0, -1)
        }

        if(!url.endsWith('/translate')){
            url += '/translate'
        }

        let headers = { "Content-Type": "application/json" }

        const body = {text: text, target_lang: arg.to.toLocaleUpperCase(), source_lang: arg.from.toLocaleUpperCase()}

    
        if(db.deeplXOptions.token.trim() !== '') { headers["Authorization"] = "Bearer " + db.deeplXOptions.token}
        
        //Since the DeepLX API is non-CORS restricted, we can use the plain fetch function
        const f = await globalFetch(url, {
            method: "POST",
            headers: headers,
            body: body,
            plainFetchForce:true,
            abortSignal: arg.signal,
            logFetch: false,
        })

        throwIfTranslationAborted(arg.signal)

        if(!f.ok){ return 'ERR::DeepLX API Error' + (await f.data) }

        return f.data.data;
    }
    if(db.translatorType == "bergamot") {
        if(!bergamotTranslate){
            const bergamotTranslator = await import('./bergamotTranslator')
            bergamotTranslate = bergamotTranslator.bergamotTranslate
        }

        return awaitWithTranslationSignal(bergamotTranslate(text, arg.from, arg.to, false), arg.signal);
    }
    if(db.useExperimentalGoogleTranslator){

        const hqAvailable = isTauri || isNodeServer || userScriptFetch

        if(hqAvailable){
            try {
                const ua = navigator.userAgent
                const d = await globalFetch(`https://translate.google.com/m?tl=${arg.to}&sl=${arg.from}&q=${encodeURIComponent(text)}`, {
                    headers: {
                        "User-Agent": ua,
                        "Accept": "*/*",
                    },
                    method: "GET",
                    abortSignal: arg.signal,
                    logFetch: false,
                })
                throwIfTranslationAborted(arg.signal)
                const parser = new DOMParser()
                const dom = parser.parseFromString(d.data, 'text/html')
                const result = dom.querySelector('.result-container')?.textContent?.trim()
                if(result){
                    return result
                }
            } catch (error) {
                if (isAbortError(error) || arg.signal?.aborted) {
                    throw createTranslationAbortError(arg.signal)
                }
            }
        }
    }


    const url = `https://${arg.host}/translate_a/single?client=gtx&dt=t&sl=${db.translatorInputLanguage}&tl=${arg.to}&q=` + encodeURIComponent(text)



    const f = await fetch(url, {

        method: "GET",

        signal: arg.signal,

    })

    const res = await f.json()

    throwIfTranslationAborted(arg.signal)

    

    if(typeof(res) === 'string'){

        return res as unknown as string

    }

    if((!res[0]) || res[0].length === 0){
        return text
    }

    const result = (res[0].map((s) => s[0]).filter(Boolean).join('') as string).replace(/\* ([^*]+)\*/g, '*$1*').replace(/\*([^*]+) \*/g, '*$1*');
    return result
}

export async function translateVox(text:string) {    
    return jaTrans(text)
}


async function jaTrans(text:string) {
    return await runTranslator(text, true, 'en','ja')
}

export function isExpTranslator(){
    const db = getDatabase()
    return db.translatorType === 'llm' || db.translatorType === 'deepl' || db.translatorType === 'deeplX'
}

export async function translateHTML(
    html: string,
    reverse:boolean,
    charArg:simpleCharacterArgument|string = '',
    chatID:number,
    regenerate = false,
    options: TranslationOptions = {}
): Promise<string> {
    const operationCacheEpoch = translationCacheEpoch
    throwIfTranslationAborted(options.signal)
    let alwaysExistChar: character | groupChat | simpleCharacterArgument;
    if(charArg !== ''){
        if(typeof(charArg) === 'string'){
            alwaysExistChar = getDatabase().characters.find((entry) => entry.chaId === charArg)
                ?? findCharacterbyId(charArg)
        }
        else{
            alwaysExistChar=charArg
        }
    } else {
        alwaysExistChar = {
            type: 'simple',
            customscript: [],
            virtualscript: null,
            emotionImages: [],
            chaId: 'simple',
            translatorNote: '',
        }
    }
    const context = resolveTranslationContext(charArg, chatID, options.context)
    const sourceFormat = options.sourceFormat ?? detectTranslationSourceFormat(html)
    const translationOptions: TranslationOptions = {
        signal: options.signal,
        force: options.force ?? regenerate,
        context,
        sourceFormat,
        manualSource: options.manualSource,
        throwOnFailure: options.throwOnFailure,
    }
    const db = getDatabase()
    const DoingChat = get(doingChat)
    if(DoingChat){
        if(isExpTranslator()){
            if(!(db.translatorType === 'llm' && await getLLMCache(html, translationOptions) !== null)){
                return html
            }
        }
    }
    if(db.translatorType === 'llm'){
        const tr = db.translator || 'en'
        const from = db.translatorInputLanguage
        const r = await translateLLM(html, {
            to: tr,
            from: from,
            force: translationOptions.force,
            context,
            sourceFormat,
            manualSource: options.manualSource,
            signal: options.signal,
            cacheEpoch: operationCacheEpoch,
            throwOnFailure: options.throwOnFailure,
        })
        throwIfTranslationAborted(options.signal)
        if(db.playMessageOnTranslateEnd && !options.signal?.aborted){
            const audio = new Audio(sendSound);
            audio.play().catch(() => {});
        }

        return applyEdittransRegex(r, charArg, alwaysExistChar)
    }
    if(db.translatorType == "bergamot" && db.htmlTranslation) {
        const from = db.aiModel.startsWith('novellist') ? 'ja' : 'en'
        const to = db.translator || 'en'

        if(!bergamotTranslate){
            const bergamotTranslator = await import('./bergamotTranslator')
            bergamotTranslate = bergamotTranslator.bergamotTranslate
        }
 
        const translated = await awaitWithTranslationSignal(
            bergamotTranslate(html, from, to, true),
            options.signal
        )
        throwIfTranslationAborted(options.signal)
        return applyEdittransRegex(translated, charArg, alwaysExistChar)
    }
    const dom = new DOMParser().parseFromString(html, 'text/html');

    let promises: Promise<void>[] = [];
    let translationChunks: {
        chunks: string[],
        resolvers: ((text:string) => void)[]
    }[] = [{
        chunks: [],
        resolvers: []
    }]
    

    async function translateTranslationChunks(force:boolean = false, additionalChunkLength = 0){
        throwIfTranslationAborted(options.signal)
        if(translationChunks.length === 0 || !needSuperChunkedTranslate()){
            return
        }

        const currentChunk = translationChunks[translationChunks.length-1]
        const text: string = currentChunk.chunks.join('\n■\n')

        if(!force && text.length + additionalChunkLength < 5000){
            return
        }

        translationChunks.push({
            chunks: [],
            resolvers: []
        })

        if(!text){
            return
        }

        const translated = await translate(text, reverse, translationOptions)

        const split = translated.split('■')

        if(split.length !== currentChunk.chunks.length){
            //try translating one by one
            for(let i = 0; i < currentChunk.chunks.length; i++){
                currentChunk.resolvers[i](
                    await translate(currentChunk.chunks[i]
                , reverse, translationOptions))
            }
            return
        }
        
        for(let i = 0; i < split.length; i++){
            currentChunk.resolvers[i](split[i])
        }


    }

    async function translateNodeText(node:Node, reprocessDisplayScript:boolean = false) {
        throwIfTranslationAborted(options.signal)
        if(node.textContent.trim().length !== 0){
            if(needSuperChunkedTranslate()){
                const prm = new Promise<string>((resolve) => {
                    translateTranslationChunks(false, node.textContent.length)
                    translationChunks[translationChunks.length-1].resolvers.push(resolve)
                    translationChunks[translationChunks.length-1].chunks.push(node.textContent)
                })
    
                node.textContent = await prm
                return
            }

            const translateChunks = (node.textContent || '').split(/\n\n+/g);
            let translatedChunksPromises: Promise<string>[] = [];
            for (const chunk of translateChunks) {
                const translatedPromise = translate(chunk, reverse, translationOptions);
                translatedChunksPromises.push(translatedPromise);
            }

            const translatedChunks = await Promise.all(translatedChunksPromises);
            let translated = translatedChunks.join("\n\n");
            if (!reprocessDisplayScript) {
                node.textContent = translated;
                return;
            }
            
            node.textContent = translated;
            if (reprocessDisplayScript) {
                applyMarkdownToNode(node)
            }
        }
    }

    // Recursive function to translate all text nodes
    async function translateNode(node: Node, parent?: Node): Promise<void> {
        throwIfTranslationAborted(options.signal)
        if (node.nodeType === Node.TEXT_NODE) {
            // Translate the text content of the node
            if(node.textContent && parent){
                const parentName = parent.nodeName.toLowerCase();
                if(parentName === 'script' || parentName === 'style'){
                    return
                }
                if(promises.length > 10){
                    await Promise.all(promises)
                    promises = []
                }
                promises.push(translateNodeText(node))
            }
        } else if(node.nodeType === Node.ELEMENT_NODE) {
            // Translate child nodes
            //skip if it's a script or style tag
            if(node.nodeName.toLowerCase() === 'script' || node.nodeName.toLowerCase() === 'style'){
                return
            }
            // combineTranslation feature
            if (
                db.combineTranslation &&
                node.nodeName.toLowerCase() === "p" &&
                node instanceof HTMLElement
            ) {
                const children = Array.from(node.childNodes);
                const blacklist = ["img", "iframe", "script", "style", "div", "button", "audio", "video"];
                const hasBlacklistChild = children.some((child) =>
                    blacklist.includes(child.nodeName.toLowerCase())
                );
                if (!hasBlacklistChild && (node as Element)?.getAttribute('translate') !== 'no'){
                    const text = getNodetextToSentence(node);
                    const sentences = text.split("\n");
                    if (sentences.length > 1) {
                        // Multiple sentences seperated by <br> tags
                        // reconstruct the p tag
                        node.innerHTML = "";
                        for (const sentence of sentences) {
                            const newNode = document.createElement("span");
                            newNode.textContent = sentence;
                            node.appendChild(newNode);
                            await translateNodeText(newNode, true);
                            node.appendChild(document.createElement("br"));
                        }
                    } else {
                        // Single sentence
                        node.innerHTML = sentences[0];
                        await translateNodeText(node, true);
                    }
                    return;
                }
            }

            for (const child of Array.from(node.childNodes)) {
                if(node.nodeType === Node.ELEMENT_NODE && (node as Element)?.getAttribute('translate') === 'no'){
                    continue
                }
                await translateNode(child, node);
            }
        }
    }
    

    // Start translation from the body element
    await translateNode(dom.body);

    await translateTranslationChunks(true, 0)

    await Promise.all(promises)
    throwIfTranslationAborted(options.signal)
    // Serialize the DOM back to HTML
    const serializer = new XMLSerializer();
    let translatedHTML = serializer.serializeToString(dom);
    // Remove the outer <html|body|head> tags
    translatedHTML = translatedHTML.replace(/<\/?(html|body|head)[^>]*>/g, '');

    translatedHTML = applyEdittransRegex(translatedHTML, charArg, alwaysExistChar);

    // Return the translated HTML, excluding the outer <body> tags if needed
    return translatedHTML
}

function needSuperChunkedTranslate(){
    return getDatabase().translatorType === 'deeplX'
}

interface LLMTranslationArguments {
    to: string
    from: string
    force?: boolean
    context: TranslationContext
    sourceFormat: TranslationSourceFormat
    manualSource?: string
    signal?: AbortSignal
    cacheEpoch: number
    throwOnFailure?: boolean
}

interface PreparedLLMTranslation {
    plan: TranslationPlanV1
    manualKey: string
    prompt: string
    maxTokens: number
    pipelineStateful: boolean
    databaseEpoch: number
}

function getEffectiveTranslationRouteSnapshot(
    route: string,
    db: ReturnType<typeof getDatabase>,
): unknown {
    const modelInfo = getModelInfo(route)
    const effectiveModelInfo = {
        id: modelInfo.id,
        internalID: modelInfo.internalID,
        provider: modelInfo.provider,
        format: modelInfo.format,
        flags: modelInfo.flags,
        parameters: modelInfo.parameters,
        endpoint: modelInfo.endpoint,
    }
    const routeParameters = db.seperateParametersByModel
        ? db.seperateParameters?.overrides?.[route]
        : db.seperateParameters?.translate
    if (route === 'openrouter') {
        return {
            route,
            modelInfo: effectiveModelInfo,
            routeParameters,
            requestModel: db.openrouterRequestModel,
            provider: db.openrouterProvider,
            useInstructPrompt: db.useInstructPrompt,
            fallback: db.openrouterFallback,
            middleOut: db.openrouterMiddleOut,
        }
    }
    if (route === 'nanogpt') {
        return {
            route,
            modelInfo: effectiveModelInfo,
            routeParameters,
            requestModel: db.nanogptRequestModel,
            provider: db.nanogptProvider,
            useSubscriptionEndpoint: db.nanogptUseSubscriptionEndpoint,
        }
    }
    if (route === 'ollama-hosted' || route === 'ollama-cloud') {
        return {
            route,
            modelInfo: effectiveModelInfo,
            routeParameters,
            requestModel: route === 'ollama-cloud' ? db.ollamaCloudModel : db.ollamaModel,
            requestFormat: db.ollamaRequestFormat,
            thinkingMode: db.ollamaThinkingMode,
            modelSource: db.ollamaModelSource,
            localUrl: route === 'ollama-hosted' ? db.ollamaURL : null,
        }
    }
    if (route === 'reverse_proxy') {
        return {
            route,
            modelInfo: effectiveModelInfo,
            routeParameters,
            autofillRequestUrl: db.autofillRequestUrl,
            customProxyRequestModel: db.customProxyRequestModel,
            customAPIFormat: db.customAPIFormat,
            forceReplaceUrl: db.forceReplaceUrl,
            reverseProxyOobaArgs: db.reverseProxyOobaArgs,
            reverseProxyOobaMode: db.reverseProxyOobaMode,
        }
    }
    if (route === 'custom' || route.startsWith('pluginmodel:::')) {
        return {
            route,
            modelInfo: effectiveModelInfo,
            routeParameters,
            pluginProvider: route === 'custom' ? db.currentPluginProvider : route,
        }
    }
    return {
        route,
        modelInfo: effectiveModelInfo,
        routeParameters,
        localEndpoint: modelInfo.format === LLMFormat.Ooba
            || modelInfo.format === LLMFormat.OobaLegacy
            ? db.textgenWebUIBlockingURL
            : modelInfo.format === LLMFormat.Kobold
                ? db.koboldURL
                : null,
        customModel: db.customModels?.find((entry) => entry.id === route) ?? null,
    }
}

function getTranslationModelSnapshot() {
    const db = getDatabase()
    const model = db.seperateModelsForAxModels && db.seperateModels?.translate
        ? db.seperateModels.translate
        : db.subModel
    const fallbackModels = [...(db.fallbackModels?.translate ?? [])]
    const currentCharacter = getCurrentCharacter()
    return {
        model,
        fallbackModels,
        engineOptions: safeStructuredClone({
            temperature: db.temperature,
            top_p: db.top_p,
            top_k: db.top_k,
            min_p: db.min_p,
            top_a: db.top_a,
            repetition_penalty: db.repetition_penalty,
            frequencyPenalty: db.frequencyPenalty,
            presencePenalty: db.PresensePenalty,
            reasoningEffort: db.reasoningEffort,
            thinkingTokens: db.thinkingTokens,
            verbosity: db.verbosity,
            generationSeed: db.generationSeed,
            seperateParametersEnabled: db.seperateParametersEnabled,
            seperateParametersByModel: db.seperateParametersByModel,
            seperateParameters: db.seperateParameters?.translate,
            modelOverrideParameters: db.seperateParameters?.overrides?.[model],
            additionalParams: db.additionalParams,
            applyAdditionalParamsToAll: db.applyAdditionalParamsToAll,
            systemContentReplacement: db.systemContentReplacement,
            systemRoleReplacement: db.systemRoleReplacement,
            extractJson: db.extractJson,
            banCharacterset: db.banCharacterset,
            fallbackWhenBlankResponse: db.fallbackWhenBlankResponse,
            effectiveRoutes: [model, ...fallbackModels]
                .map((route) => getEffectiveTranslationRouteSnapshot(route, db)),
            customFlags: {
                enabled: db.enableCustomFlags,
                flags: db.customFlags,
            },
            structuredOutput: {
                enabled: db.jsonSchemaEnabled,
                schema: db.jsonSchema,
                strict: db.strictJsonSchema,
                prediction: db.OAIPrediction,
            },
            thinking: {
                type: db.thinkingType,
                adaptiveEffort: db.adaptiveThinkingEffort,
                deepseekEffort: db.deepseekReasoningEffort,
                deepseekThinkingType: db.deepseekThinkingType,
            },
            legacyRequestSemantics: {
                ainConfig: db.ainconfig,
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
                effectiveUserName: getUserName(),
                currentCharacterName: currentCharacter?.nickname || currentCharacter?.name,
            },
            openRouter: model === 'openrouter' ? {
                requestModel: db.openrouterRequestModel,
                provider: db.openrouterProvider,
                useInstructPrompt: db.useInstructPrompt,
                fallback: db.openrouterFallback,
                middleOut: db.openrouterMiddleOut,
            } : null,
            nanoGpt: model === 'nanogpt' ? {
                requestModel: db.nanogptRequestModel,
                provider: db.nanogptProvider,
                useSubscriptionEndpoint: db.nanogptUseSubscriptionEndpoint,
            } : null,
            ollama: model === 'ollama-hosted' || model === 'ollama-cloud' ? {
                requestModel: model === 'ollama-cloud' ? db.ollamaCloudModel : db.ollamaModel,
                requestFormat: db.ollamaRequestFormat,
                thinkingMode: db.ollamaThinkingMode,
                modelSource: db.ollamaModelSource,
                localUrl: model === 'ollama-hosted' ? db.ollamaURL : null,
            } : null,
            jsonSchemaEnabled: db.jsonSchemaEnabled,
            oaiPrediction: db.OAIPrediction,
            deepseekThinkingType: db.deepseekThinkingType,
            openAIFlexProcessing: db.openAIFlexProcessing,
            reverseProxy: model === 'reverse_proxy' ? {
                autofillRequestUrl: db.autofillRequestUrl,
                customProxyRequestModel: db.customProxyRequestModel,
                customAPIFormat: db.customAPIFormat,
                forceReplaceUrl: db.forceReplaceUrl,
                reverseProxyOobaArgs: db.reverseProxyOobaArgs,
                reverseProxyOobaMode: db.reverseProxyOobaMode,
            } : null,
            customModel: db.customModels?.find((entry) => entry.id === model),
            fallbackCustomModels: fallbackModels.map((fallback) =>
                db.customModels?.find((entry) => entry.id === fallback) ?? null),
        }),
    }
}

async function buildLLMTranslationPlan(
    text: string,
    arg: Pick<LLMTranslationArguments, 'to' | 'from' | 'context' | 'sourceFormat' | 'manualSource'>
): Promise<PreparedLLMTranslation> {
    const databaseEpoch = translationDatabaseEpoch
    const db = getDatabase()
    const preset = getCurrentTranslatorPreset()
    const modelSnapshot = getTranslationModelSnapshot()
    const prompt = preset.prompt || defaultTranslatorPrompt
    // ChatML content is passed through ambient CBS evaluation (current
    // character/chat vars, date/random, plugins). Until final formatted
    // messages become the cache input, it is intentionally cache-unsafe.
    const pipelineStateful = translationRequestPipelineIsStateful()
        || prompt.trim().startsWith('<|im_start|>')
    const plan = await prepareTranslationPlan({
        source: text,
        sourceFormat: arg.sourceFormat,
        sourceLanguage: arg.from,
        targetLanguage: arg.to,
        engine: 'llm',
        presetId: db.translatorPresetId,
        presetName: preset.name,
        prompt,
        maxTokens: preset.maxResponse,
        model: modelSnapshot.model,
        fallbackModels: modelSnapshot.fallbackModels,
        context: arg.context,
        engineOptions: modelSnapshot.engineOptions,
    })
    const manualKey = await createManualTranslationCacheKey({
        source: arg.manualSource ?? text,
        sourceFormat: arg.sourceFormat,
        targetLanguage: arg.to,
        context: arg.context,
    })
    return {
        plan,
        manualKey,
        prompt,
        maxTokens: preset.maxResponse,
        pipelineStateful,
        databaseEpoch,
    }
}

function formatLLMTranslationPrompt(
    prepared: PreparedLLMTranslation,
    from: string,
    to: string
) {
    const { plan } = prepared
    const translatorNote = plan.context.translatorNote
    let prompt = prepared.prompt
    const substituted = prompt
        .replaceAll('{{slot::from}}', from)
        .replaceAll('{{slot}}', to)
        .replaceAll('{{solt::content}}', plan.protectedSource)
        .replaceAll('{{slot::content}}', plan.protectedSource)
        .replaceAll('{{slot::tnote}}', translatorNote)
    const parsedPrompt = parseChatML(substituted)
    if (parsedPrompt) {
        return {
            formated: parsedPrompt,
            maxTokens: prepared.maxTokens,
        }
    }

    prompt = prompt
        .replaceAll('{{slot}}', to)
        .replaceAll('{{slot::tnote}}', translatorNote)
        .replaceAll('{{slot::from}}', from)
    return {
        formated: [
            {
                'role': 'system',
                'content': prompt
            },
            {
                'role': 'user',
                'content': plan.protectedSource
            }
        ] satisfies OpenAIChat[],
        maxTokens: prepared.maxTokens,
    }
}

async function assertLLMTranslationPlanCurrent(
    prepared: PreparedLLMTranslation,
    arg: Pick<LLMTranslationArguments, 'to' | 'from' | 'cacheEpoch'>,
    signal: AbortSignal,
): Promise<void> {
    throwIfTranslationAborted(signal)
    if (
        prepared.databaseEpoch !== translationDatabaseEpoch
        || arg.cacheEpoch !== translationCacheEpoch
    ) {
        throw createTranslationAbortError()
    }
    const current = await buildLLMTranslationPlan(prepared.plan.source, {
        to: arg.to,
        from: arg.from,
        context: prepared.plan.context as TranslationContext,
        sourceFormat: prepared.plan.descriptor.sourceFormat,
    })
    throwIfTranslationAborted(signal)
    if (
        current.plan.key !== prepared.plan.key
        || current.pipelineStateful !== prepared.pipelineStateful
        || current.databaseEpoch !== prepared.databaseEpoch
        || translationDatabaseEpoch !== prepared.databaseEpoch
        || arg.cacheEpoch !== translationCacheEpoch
    ) {
        throw createTranslationAbortError()
    }
}

async function executeLLMTranslation(
    prepared: PreparedLLMTranslation,
    arg: Pick<LLMTranslationArguments, 'to' | 'from' | 'force' | 'cacheEpoch' | 'throwOnFailure'>,
    version: number,
    signal: AbortSignal,
    explicitWriteRevisions: TranslationExplicitWriteRevisionSnapshot,
    forceMutationRevision: number,
    explicitSupersessions: Array<{
        key: string
        operationVersion: number
        committedVersion: number
    }> = [],
): Promise<string> {
    const { plan } = prepared
    await assertLLMTranslationPlanCurrent(prepared, arg, signal)
    const { formated, maxTokens } = formatLLMTranslationPrompt(prepared, arg.from, arg.to)
    const rq = await requestChatData({
        formated,
        bias: {},
        useStreaming: false,
        noMultiGen: true,
        maxTokens,
        // Translation must never expose unrelated MCP tools or permit tool
        // side effects through the generic request path.
        tools: [],
        blockModelTools: true,
        blockBatching: true,
    }, 'translate', signal)

    throwIfTranslationAborted(signal)
    if (prepared.pipelineStateful) {
        if (
            arg.cacheEpoch !== translationCacheEpoch
            || prepared.databaseEpoch !== translationDatabaseEpoch
        ) {
            throw createTranslationAbortError()
        }
    } else {
        await assertLLMTranslationPlanCurrent(prepared, arg, signal)
    }
    if (rq.pipelineStateful && !prepared.pipelineStateful) {
        // A hook appeared after the pre-request fence. A shared/stateless
        // execution cannot safely publish that result.
        throw createTranslationAbortError()
    }

    if(rq.type === 'fail'){
        if (signal.aborted || rq.result === 'Aborted') {
            throw createTranslationAbortError(signal)
        }
        alertError(rq.result)
        if (arg.throwOnFailure) throw new TranslationProviderError(rq.result)
        return plan.source
    }
    if(rq.type === 'streaming' || rq.type === 'multiline'){
        alertError('Unexpected response type')
        if (arg.throwOnFailure) throw new TranslationProviderError('Unexpected response type')
        return plan.source
    }
    const result = finalizeTranslation(plan, rq.result)
    throwIfTranslationAborted(signal)
    const newerExplicit = await readExplicitTranslationWrittenAfter(
        prepared,
        explicitWriteRevisions,
        signal,
    )
    if (newerExplicit) {
        return newerExplicit.result
    }
    let generatedCommitted = prepared.pipelineStateful || !!rq.pipelineStateful
    if (!prepared.pipelineStateful && !rq.pipelineStateful) {
        generatedCommitted = await writeTranslationRecordIfCurrent(plan.key, {
            schemaVersion: 1,
            version,
            result,
            origin: 'generated',
            updatedAt: nextTranslationUpdatedAt(),
            sourceSearchText: plan.source,
        }, async () => {
            if (signal.aborted || translationRequestPipelineIsStateful()) return false
            try {
                await assertLLMTranslationPlanCurrent(prepared, arg, signal)
                return true
            } catch {
                return false
            }
        })
        if (generatedCommitted) {
            throwIfTranslationAborted(signal)
        }
    }
    const explicitAfterGeneratedWrite = await readExplicitTranslationWrittenAfter(
        prepared,
        explicitWriteRevisions,
        signal,
    )
    if (explicitAfterGeneratedWrite) {
        return explicitAfterGeneratedWrite.result
    }
    if (arg.force && generatedCommitted) {
        for (const supersession of explicitSupersessions) {
            await removeTranslationRecordIfOperationCurrent(
                supersession.key,
                supersession.operationVersion,
                supersession.committedVersion,
                () => !signal.aborted,
            )
            throwIfTranslationAborted(signal)
        }
        const explicitAfterSupersession = await readExplicitTranslationWrittenAfter(
            prepared,
            explicitWriteRevisions,
            signal,
        )
        if (explicitAfterSupersession) {
            return explicitAfterSupersession.result
        }
        if ((translationForceMutationRevisions.get(plan.key) ?? 0) !== forceMutationRevision) {
            throw createTranslationAbortError()
        }
        setTimeout(() => {
            if (
                arg.cacheEpoch !== translationCacheEpoch
                || prepared.databaseEpoch !== translationDatabaseEpoch
                || !translationExplicitWriteRevisionsAreCurrent(explicitWriteRevisions)
                || (translationForceMutationRevisions.get(plan.key) ?? 0) !== forceMutationRevision
            ) return
            const mutationRevision = publishTranslationCacheMutation(
                'force',
                [prepared.manualKey, plan.key, plan.source],
                plan.context as TranslationContext,
                prepared.pipelineStateful || !!rq.pipelineStateful ? result : undefined,
            )
            if (prepared.pipelineStateful || !!rq.pipelineStateful) {
                setTimeout(() => TranslationCacheMutationStore.update((event) =>
                    event.revision === mutationRevision && event.result !== undefined
                        ? { ...event, result: undefined }
                        : event
                ), 5000)
            }
        }, 0)
    }
    if (
        arg.force
        && (translationForceMutationRevisions.get(plan.key) ?? 0) !== forceMutationRevision
    ) {
        throw createTranslationAbortError()
    }
    return result
}

interface StableTranslationCacheSnapshot {
    prepared: PreparedLLMTranslation
    manual: TranslationCacheRecord | null
    generated: TranslationCacheRecord | null
    legacyImported: TranslationCacheRecord | null
    manualOperationVersion: number
    manualCommittedVersion: number
    generatedOperationVersion: number
    generatedCommittedVersion: number
    legacyOperationVersion: number
    legacyCommittedVersion: number
}

function stableTranslationCacheSnapshotIsCurrent(
    snapshot: StableTranslationCacheSnapshot,
): boolean {
    return snapshot.manualOperationVersion === (translationVersions.get(snapshot.prepared.manualKey) ?? 0)
        && snapshot.manualCommittedVersion === (translationCommittedVersions.get(snapshot.prepared.manualKey) ?? 0)
        && snapshot.generatedOperationVersion === (translationVersions.get(snapshot.prepared.plan.key) ?? 0)
        && snapshot.generatedCommittedVersion === (translationCommittedVersions.get(snapshot.prepared.plan.key) ?? 0)
        && snapshot.legacyOperationVersion === (translationVersions.get(snapshot.prepared.plan.source) ?? 0)
        && snapshot.legacyCommittedVersion === (translationCommittedVersions.get(snapshot.prepared.plan.source) ?? 0)
}

function samePreparedTranslationPlan(
    left: PreparedLLMTranslation,
    right: PreparedLLMTranslation,
): boolean {
    return left.plan.key === right.plan.key
        && left.manualKey === right.manualKey
        && left.pipelineStateful === right.pipelineStateful
        && left.databaseEpoch === right.databaseEpoch
}

async function readStableTranslationCacheSnapshot(
    text: string,
    arg: LLMTranslationArguments,
): Promise<StableTranslationCacheSnapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
        if (arg.cacheEpoch !== translationCacheEpoch) throw createTranslationAbortError()
        const prepared = await buildLLMTranslationPlan(text, arg)
        throwIfTranslationAborted(arg.signal)
        const manualOperationVersion = translationVersions.get(prepared.manualKey) ?? 0
        const manualCommittedVersion = translationCommittedVersions.get(prepared.manualKey) ?? 0
        const generatedOperationVersion = translationVersions.get(prepared.plan.key) ?? 0
        const generatedCommittedVersion = translationCommittedVersions.get(prepared.plan.key) ?? 0
        const legacyOperationVersion = translationVersions.get(prepared.plan.source) ?? 0
        const legacyCommittedVersion = translationCommittedVersions.get(prepared.plan.source) ?? 0
        const manual = await readTranslationCacheRecord(prepared.manualKey)
        throwIfTranslationAborted(arg.signal)
        const generated = await readTranslationCacheRecord(prepared.plan.key)
        throwIfTranslationAborted(arg.signal)
        const legacyRecord = await readTranslationCacheRecord(prepared.plan.source)
        const legacyImported = legacyRecord?.origin === 'imported' ? legacyRecord : null
        throwIfTranslationAborted(arg.signal)
        const current = await buildLLMTranslationPlan(text, arg)
        throwIfTranslationAborted(arg.signal)
        const manualIsCurrent = !manual
            || manual.version >= (translationCommittedVersions.get(prepared.manualKey) ?? 0)
        const generatedIsCurrent = !generated
            || generated.version >= (translationCommittedVersions.get(prepared.plan.key) ?? 0)
        const legacyIsCurrent = !legacyImported
            || legacyImported.version >= (translationCommittedVersions.get(prepared.plan.source) ?? 0)
        if (
            samePreparedTranslationPlan(prepared, current)
            && manualIsCurrent
            && generatedIsCurrent
            && legacyIsCurrent
            && manualOperationVersion === (translationVersions.get(prepared.manualKey) ?? 0)
            && manualCommittedVersion === (translationCommittedVersions.get(prepared.manualKey) ?? 0)
            && generatedOperationVersion === (translationVersions.get(prepared.plan.key) ?? 0)
            && generatedCommittedVersion === (translationCommittedVersions.get(prepared.plan.key) ?? 0)
            && legacyOperationVersion === (translationVersions.get(prepared.plan.source) ?? 0)
            && legacyCommittedVersion === (translationCommittedVersions.get(prepared.plan.source) ?? 0)
        ) {
            return {
                prepared: current,
                manual,
                generated,
                legacyImported,
                manualOperationVersion,
                manualCommittedVersion,
                generatedOperationVersion,
                generatedCommittedVersion,
                legacyOperationVersion,
                legacyCommittedVersion,
            }
        }
    }
    throw createTranslationAbortError()
}

async function translateLLM(
    text:string,
    arg:LLMTranslationArguments,
    cacheReadAttempt = 0,
):Promise<string>{
    throwIfTranslationAborted(arg.signal)
    if (arg.cacheEpoch !== translationCacheEpoch) {
        throw createTranslationAbortError()
    }
    const cacheSnapshot = arg.force
        ? null
        : await readStableTranslationCacheSnapshot(text, arg)
    if (arg.cacheEpoch !== translationCacheEpoch) {
        throw createTranslationAbortError()
    }
    if (cacheSnapshot && !stableTranslationCacheSnapshotIsCurrent(cacheSnapshot)) {
        if (cacheReadAttempt >= 2) throw createTranslationAbortError()
        return translateLLM(text, arg, cacheReadAttempt + 1)
    }
    const prepared = cacheSnapshot?.prepared ?? await buildLLMTranslationPlan(text, arg)
    const { plan } = prepared
    // Capture before force reads can yield. Any explicit manual/imported write
    // completed after this point must win over the provider result.
    const explicitWriteRevisions = captureTranslationExplicitWriteRevisions(prepared)
    const forceManualRecord = arg.force
        ? await readTranslationCacheRecord(prepared.manualKey)
        : null
    throwIfTranslationAborted(arg.signal)
    if (arg.cacheEpoch !== translationCacheEpoch) throw createTranslationAbortError()
    // Force bypasses the cached value, but it still has to seed the operation
    // version from durable storage. Otherwise a fresh page can overwrite a
    // persisted vN record with v1 and make delayed readers treat the old value
    // as newer than the actual replacement.
    const forceGeneratedRecord = arg.force
        ? await readTranslationCacheRecord(prepared.plan.key)
        : null
    throwIfTranslationAborted(arg.signal)
    if (arg.cacheEpoch !== translationCacheEpoch) throw createTranslationAbortError()
    const forceLegacyRecord = arg.force
        ? await readTranslationCacheRecord(prepared.plan.source)
        : null
    throwIfTranslationAborted(arg.signal)
    if (arg.cacheEpoch !== translationCacheEpoch) throw createTranslationAbortError()
    const manualSupersession = arg.force && forceManualRecord
        ? {
            key: prepared.manualKey,
            operationVersion: reserveTranslationVersion(
                prepared.manualKey,
                forceManualRecord.version,
            ),
            committedVersion: forceManualRecord.version,
        }
        : null
    const importedPlanSupersession = arg.force
        && prepared.pipelineStateful
        && forceGeneratedRecord
        && isExplicitTranslationCacheRecord(forceGeneratedRecord)
        ? {
            key: prepared.plan.key,
            operationVersion: reserveTranslationVersion(
                prepared.plan.key,
                forceGeneratedRecord.version,
            ),
            committedVersion: forceGeneratedRecord.version,
        }
        : null
    const importedLegacySupersession = arg.force
        && forceLegacyRecord?.origin === 'imported'
        ? {
            key: prepared.plan.source,
            operationVersion: reserveTranslationVersion(
                prepared.plan.source,
                forceLegacyRecord.version,
            ),
            committedVersion: forceLegacyRecord.version,
        }
        : null
    const explicitSupersessions = [
        manualSupersession,
        importedPlanSupersession,
        importedLegacySupersession,
    ]
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    throwIfTranslationAborted(arg.signal)
    if (arg.cacheEpoch !== translationCacheEpoch) throw createTranslationAbortError()
    const manualCached = cacheSnapshot?.manual ?? null
    let cached = cacheSnapshot?.generated ?? forceGeneratedRecord
    const legacyImported = cacheSnapshot?.legacyImported
        ?? (forceLegacyRecord?.origin === 'imported' ? forceLegacyRecord : null)
    if (!arg.force && manualCached && isExplicitTranslationCacheRecord(manualCached)) {
        if (manualCached.version < (translationCommittedVersions.get(prepared.manualKey) ?? 0)) {
            if (cacheReadAttempt >= 2) throw createTranslationAbortError()
            return translateLLM(text, arg, cacheReadAttempt + 1)
        }
        return manualCached.result
    }

    if (prepared.pipelineStateful && cached && !isExplicitTranslationCacheRecord(cached)) {
        cached = null
    }

    if (!arg.force && cached && isExplicitTranslationCacheRecord(cached)) {
        if (cached.version < (translationCommittedVersions.get(plan.key) ?? 0)) {
            if (cacheReadAttempt >= 2) throw createTranslationAbortError()
            return translateLLM(text, arg, cacheReadAttempt + 1)
        }
        return cached.result
    }

    if (!arg.force && legacyImported) {
        if (legacyImported.version < (translationCommittedVersions.get(plan.source) ?? 0)) {
            if (cacheReadAttempt >= 2) throw createTranslationAbortError()
            return translateLLM(text, arg, cacheReadAttempt + 1)
        }
        return legacyImported.result
    }

    const forceMutationRevision = arg.force
        ? (translationForceMutationRevisions.get(plan.key) ?? 0) + 1
        : (translationForceMutationRevisions.get(plan.key) ?? 0)
    if (arg.force) {
        translationForceMutationRevisions.set(plan.key, forceMutationRevision)
    }
    if (prepared.pipelineStateful) {
        const directSignal = arg.signal ?? new AbortController().signal
        return executeLLMTranslation(
            prepared,
            arg,
            0,
            directSignal,
            explicitWriteRevisions,
            forceMutationRevision,
            explicitSupersessions,
        )
    }

    const existing = translationFlights.get(plan.key)
    if (!arg.force && existing) {
        return joinTranslationFlight(existing, arg.signal)
    }
    if (!arg.force && cached) {
        if (cached.version < (translationCommittedVersions.get(plan.key) ?? 0)) {
            if (cacheReadAttempt >= 2) throw createTranslationAbortError()
            return translateLLM(text, arg, cacheReadAttempt + 1)
        }
        return cached.result
    }
    if (arg.force && existing) {
        invalidateTranslationFlight(existing)
    }

    throwIfTranslationAborted(arg.signal)
    const version = reserveTranslationVersion(plan.key, cached?.version ?? 0)
    throwIfTranslationAborted(arg.signal)
    const controller = new AbortController()
    let flight: TranslationFlight
    const promise = executeLLMTranslation(
        prepared,
        arg,
        version,
        controller.signal,
        explicitWriteRevisions,
        forceMutationRevision,
        explicitSupersessions,
    ).finally(() => {
        flight.settled = true
        if (translationFlights.get(plan.key) === flight) {
            translationFlights.delete(plan.key)
        }
    })
    flight = {
        key: plan.key,
        version,
        controller,
        promise,
        waiters: new Set(),
        settled: false,
    }
    translationFlights.set(plan.key, flight)
    void promise.catch(() => {})
    try {
        return joinTranslationFlight(flight, arg.signal)
    } catch (error) {
        // An already-aborted caller can fail before joinTranslationFlight adds
        // its waiter. Do not leave a zero-waiter provider/cache operation alive.
        if (!flight.settled && flight.waiters.size === 0) {
            invalidateTranslationFlight(flight)
        }
        throw error
    }
}

function getDefaultLLMPlanArguments(
    text: string,
    options: TranslationOptions = {},
    cacheEpoch = translationCacheEpoch,
) {
    const db = getDatabase()
    return {
        from: db.translatorInputLanguage ?? 'auto',
        to: db.translator || 'en',
        context: options.context ?? resolveTranslationContext(),
        sourceFormat: options.sourceFormat ?? detectTranslationSourceFormat(text),
        manualSource: options.manualSource,
        cacheEpoch,
    }
}

export interface TranslationCacheIdentity {
    manualKey: string
    planKey: string
    legacyKey: string
    pipelineStateful: boolean
}

/** Resolve the exact cache identities used by translateLLM without reading a
 * cache entry or invoking a provider. UI surfaces use this to share one
 * prepared target and to filter cache mutation events precisely. */
export async function getLLMCacheIdentity(
    text: string,
    options: TranslationOptions = {},
): Promise<TranslationCacheIdentity> {
    const operationCacheEpoch = translationCacheEpoch
    throwIfTranslationAborted(options.signal)
    const prepared = await buildLLMTranslationPlan(
        text,
        getDefaultLLMPlanArguments(text, options, operationCacheEpoch),
    )
    throwIfTranslationAborted(options.signal)
    if (
        operationCacheEpoch !== translationCacheEpoch
        || prepared.databaseEpoch !== translationDatabaseEpoch
    ) {
        throw createTranslationAbortError()
    }
    return {
        manualKey: prepared.manualKey,
        planKey: prepared.plan.key,
        legacyKey: text,
        pipelineStateful: prepared.pipelineStateful,
    }
}

export async function getLLMCache(text:string, options: TranslationOptions = {}):Promise<string | null>{
    const operationCacheEpoch = translationCacheEpoch
    throwIfTranslationAborted(options.signal)
    const snapshot = await readStableTranslationCacheSnapshot(
        text,
        {
            ...getDefaultLLMPlanArguments(text, options, operationCacheEpoch),
            signal: options.signal,
        }
    )
    if (
        operationCacheEpoch !== translationCacheEpoch
        || !stableTranslationCacheSnapshotIsCurrent(snapshot)
    ) {
        throw createTranslationAbortError()
    }
    const manualRecord = snapshot.manual
    if (manualRecord && isExplicitTranslationCacheRecord(manualRecord)) {
        return manualRecord.result
    }
    const record = snapshot.generated
    if (
        snapshot.prepared.pipelineStateful
        && record
        && !isExplicitTranslationCacheRecord(record)
    ) {
        return snapshot.legacyImported?.result ?? null
    }
    return record?.result ?? snapshot.legacyImported?.result ?? null
}

/** Exact opaque-key accessor with a legacy raw-source fallback. When several
 * semantic variants share a source, raw lookup returns the latest local write,
 * matching the old source-key overwrite behavior. */
export async function getLLMCacheByStorageKey(key: string): Promise<string | null> {
    const stored = await LLMCacheStorage.getItem<unknown>(key)
    const isOpaqueSemanticKey = key.startsWith('translation:v1:')
        || key.startsWith('translation:manual:v1:')
    if (isOpaqueSemanticKey) {
        if (isTranslationCacheRecord(stored)) return stored.result
        if (typeof stored === 'string') return stored
    }

    let latest: { result: string, updatedAt: number, iteration: number } | null = null
    await LLMCacheStorage.iterate<unknown, void>((value, _storedKey, iteration) => {
        if (!isTranslationCacheRecord(value) || value.sourceSearchText !== key) return
        const updatedAt = value.updatedAt ?? 0
        if (
            !latest
            || updatedAt > latest.updatedAt
            || (updatedAt === latest.updatedAt && iteration > latest.iteration)
        ) {
            latest = { result: value.result, updatedAt, iteration }
        }
    })
    if (latest) return latest.result
    if (isTranslationCacheRecord(stored)) return stored.result
    return typeof stored === 'string' ? stored : null
}

export async function searchLLMCache(partialKey:string):Promise<{key: string, value: string}[]>{
    const results:{key: string, value: string}[] = []
    await LLMCacheStorage.iterate<unknown, void>((value, key) => {
        const sourceMatches = isTranslationCacheRecord(value)
            && value.sourceSearchText?.includes(partialKey)
        if(key.includes(partialKey) || sourceMatches){
            if (isTranslationCacheRecord(value)) {
                results.push({key, value: value.result})
            } else if (typeof value === 'string') {
                results.push({key, value})
            }
        }
    })
    return results
}

export async function setLLMCache(text:string, value:string, options: TranslationOptions = {}):Promise<void>{
    const operationCacheEpoch = translationCacheEpoch
    throwIfTranslationAborted(options.signal)
    const prepared = await buildLLMTranslationPlan(
        text,
        getDefaultLLMPlanArguments(text, options, operationCacheEpoch),
    )
    const { plan } = prepared
    throwIfTranslationAborted(options.signal)
    if (operationCacheEpoch !== translationCacheEpoch) throw createTranslationAbortError()
    const cached = await readTranslationCacheRecord(prepared.manualKey)
    throwIfTranslationAborted(options.signal)
    if (operationCacheEpoch !== translationCacheEpoch) throw createTranslationAbortError()
    const version = reserveTranslationVersion(prepared.manualKey, cached?.version ?? 0)
    const onAbort = () => {
        if ((translationVersions.get(prepared.manualKey) ?? 0) === version) {
            translationVersions.set(prepared.manualKey, version + 1)
        }
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
        const wrote = await writeTranslationRecordIfCurrent(prepared.manualKey, {
            schemaVersion: 1,
            version,
            result: value,
            origin: 'manual',
            updatedAt: nextTranslationUpdatedAt(),
            sourceSearchText: plan.source,
        }, () => operationCacheEpoch === translationCacheEpoch && !options.signal?.aborted)
        throwIfTranslationAborted(options.signal)
        if (!wrote || operationCacheEpoch !== translationCacheEpoch) {
            throw createTranslationAbortError()
        }
        bumpTranslationExplicitWriteRevision(prepared.manualKey)
        publishTranslationCacheMutation(
            'manual',
            [prepared.manualKey],
            plan.context as TranslationContext,
        )
        const existing = translationFlights.get(plan.key)
        if (existing) invalidateTranslationFlight(existing)
    } finally {
        options.signal?.removeEventListener('abort', onAbort)
    }
}

export interface TranslationCacheExportEntryV2 {
    result: string
    sourceSearchText?: string
    origin?: 'generated' | 'manual' | 'imported'
    updatedAt?: number
}

export interface TranslationCacheExportV2 {
    translationCacheExportVersion: 2
    entries: Record<string, TranslationCacheExportEntryV2>
}

export async function exportLLMCacheAsJSON():Promise<TranslationCacheExportV2>{
    const entries:Record<string, TranslationCacheExportEntryV2> = {}
    await LLMCacheStorage.iterate<unknown, void>((value, key) => {
        if (isTranslationCacheRecord(value)) {
            entries[key] = {
                result: value.result,
                sourceSearchText: value.sourceSearchText,
                origin: value.origin,
                updatedAt: value.updatedAt,
            }
        } else if (typeof value === 'string') {
            entries[key] = { result: value }
        }
    })
    return {
        translationCacheExportVersion: 2,
        entries,
    }
}

function isTranslationCacheExportEntryV2(value: unknown): value is TranslationCacheExportEntryV2 {
    if (!value || typeof value !== 'object' || typeof (value as TranslationCacheExportEntryV2).result !== 'string') {
        return false
    }
    const entry = value as TranslationCacheExportEntryV2
    return (entry.sourceSearchText === undefined || typeof entry.sourceSearchText === 'string')
        && (entry.updatedAt === undefined || Number.isFinite(entry.updatedAt))
        && (
            entry.origin === undefined
            || entry.origin === 'generated'
            || entry.origin === 'manual'
            || entry.origin === 'imported'
        )
}

export function isTranslationCacheExportV2(value: unknown): value is TranslationCacheExportV2 {
    if (
        !value
        || typeof value !== 'object'
        || (value as TranslationCacheExportV2).translationCacheExportVersion !== 2
        || !(value as TranslationCacheExportV2).entries
        || typeof (value as TranslationCacheExportV2).entries !== 'object'
        || Array.isArray((value as TranslationCacheExportV2).entries)
    ) {
        return false
    }
    return Object.values((value as TranslationCacheExportV2).entries)
        .every(isTranslationCacheExportEntryV2)
}

export async function importLLMCacheFromJSON(data:unknown):Promise<{count: number, failed: number}>{
    const operationCacheEpoch = translationCacheEpoch
    let importEntries: Array<[string, TranslationCacheExportEntryV2]>
    if (isTranslationCacheExportV2(data)) {
        importEntries = Object.entries(data.entries)
    } else if (
        data
        && typeof data === 'object'
        && !Array.isArray(data)
        && Object.values(data).every((value) => typeof value === 'string')
    ) {
        // Legacy v1 backup: raw key -> translated string.
        importEntries = Object.entries(data as Record<string, string>)
            .map(([key, result]) => [key, { result, origin: 'imported' }])
    } else {
        throw new Error('Invalid translation cache format')
    }

    let count = 0
    let failed = 0
    const touchedKeys: string[] = []
    for(const [key, entry] of importEntries){
        try{
            if (operationCacheEpoch !== translationCacheEpoch) {
                throw createTranslationAbortError()
            }
            if (
                key.startsWith('translation:v1:')
                || key.startsWith('translation:manual:v1:')
            ) {
                const cached = await readTranslationCacheRecord(key)
                const existing = translationFlights.get(key)
                if (existing) {
                    invalidateTranslationFlight(existing)
                }
                const version = reserveTranslationVersion(key, cached?.version ?? 0)
                const origin = entry.origin ?? 'imported'
                const wrote = await writeTranslationRecordIfCurrent(key, {
                    schemaVersion: 1,
                    version,
                    result: entry.result,
                    origin,
                    sourceSearchText: entry.sourceSearchText,
                    updatedAt: entry.updatedAt ?? nextTranslationUpdatedAt(),
                }, () => operationCacheEpoch === translationCacheEpoch)
                if (!wrote) throw createTranslationAbortError()
                if (origin === 'manual' || origin === 'imported') {
                    bumpTranslationExplicitWriteRevision(key)
                }
            } else {
                // An explicitly imported legacy backup remains available by
                // exact source, but is marked as imported so ambient old raw
                // cache strings are never mistaken for a semantic hit.
                const cached = await readTranslationCacheRecord(key)
                const version = reserveTranslationVersion(key, cached?.version ?? 0)
                const wrote = await writeTranslationRecordIfCurrent(key, {
                    schemaVersion: 1,
                    version,
                    result: entry.result,
                    origin: 'imported',
                    sourceSearchText: key,
                    updatedAt: entry.updatedAt ?? nextTranslationUpdatedAt(),
                }, () => operationCacheEpoch === translationCacheEpoch)
                if (!wrote) throw createTranslationAbortError()
                bumpTranslationExplicitWriteRevision(key)
            }
            count++
            touchedKeys.push(key)
        }catch{
            failed++
        }
    }
    if (count > 0 && operationCacheEpoch === translationCacheEpoch) {
        bumpTranslationCacheRevision('import')
        publishTranslationCacheMutation('import', touchedKeys)
    }
    return {count, failed}
}

export async function clearLLMCache():Promise<void>{
    for (const flight of translationFlights.values()) {
        invalidateTranslationFlight(flight)
    }
    translationFlights.clear()
    translationCacheEpoch++
    const previousBarrier = translationCacheBarrier
    const pendingWrites = [...translationWriteChains.values()]
    const clearOperation = (async () => {
        await previousBarrier
        await Promise.allSettled(pendingWrites)
        await LLMCacheStorage.clear()
    })()
    translationCacheBarrier = clearOperation.then(() => {})
    await translationCacheBarrier
    bumpTranslationCacheRevision('clear')
    publishTranslationCacheMutation('clear', [])
}


function applyEdittransRegex(
      text: string, 
      charArg: simpleCharacterArgument | string, 
      alwaysExistChar: character | groupChat | simpleCharacterArgument
  ): string {
      if (charArg === '') return text

      let scripts: customscript[] = []
      scripts = (getModuleRegexScripts() ?? []).concat(alwaysExistChar?.customscript ?? [])

      for (const script of scripts) {
          if (script.type === 'edittrans') {
              const reg = new RegExp(script.in, script.ableFlag ? script.flag : 'g')
              let outScript = script.out.replaceAll("$n", "\n")
              text = text.replace(reg, outScript)
          }
      }
      return text
  }
