import { get } from 'svelte/store'
import { ConnectionOpenStore } from '../sync/multiuser'
import { CurrentTriggerIdStore, DBState, selectedCharID } from '../stores.svelte'
import type { Message, character, groupChat } from '../storage/database.svelte'
import { processMultiCommand } from '../process/command'
import { doingChat, sendChat, type OpenAIChat, type SendChatOptions } from '../process/index.svelte'
import { Prereroll, PreUnreroll } from '../process/prereroll'
import { requestChatData } from '../process/request/request'
import { processScript } from '../process/scripts'
import { runLuaButtonTrigger } from '../process/scriptings'
import { runTrigger } from '../process/triggers'
import { safeStructuredClone } from '../polyfill'
import { defaultAutoSuggestPrompt } from '../storage/defaultPrompts'
import { getUserName, replacePlaceholders, sleep } from '../util'
import { v4 } from 'uuid'
import isEqual from 'lodash/isEqual'

export type CanonicalGenerationAction =
    | 'send'
    | 'continue'
    | 'reroll'
    | 'unreroll'
    | 'auto'
    | 'generate'
    | 'manual-trigger'
    | 'lua-button'
    | 'suggest'

export interface CanonicalGenerationTarget {
    characterId: string
    chatId: string
}

export interface CanonicalSendInput extends CanonicalGenerationTarget {
    input: string
    files?: string[]
    continueResponse?: boolean
    signal?: AbortSignal
    canonicalInputMessageId?: string
    onInputAppended?: (reference: CanonicalInputMessageReference) => Promise<void> | void
    onCanonicalMutation?: () => void
}

export interface CanonicalInputMessageReference {
    messageIndex: number
    messageId: string
}

export interface CanonicalGenerationResult {
    generated: boolean
    commandProcessed?: boolean
    suggestionCount?: number
    suggestionsUpdated?: boolean
    previousLength: number
    currentLength: number
}

export class CanonicalGenerationTargetError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CanonicalGenerationTargetError'
    }
}

interface ResolvedGenerationTarget {
    characterIndex: number
    chatIndex: number
    character: character | groupChat
}

interface CanonicalRerollHistory {
    entries: Message[][]
    index: number
    appliedLength: number
    baseMessages: Message[]
}

// Upstream keeps normal reroll history in DefaultChatScreen component memory.
// Delegated clients do not execute that component's sendChatMain, so the
// authoritative resident browser owns the equivalent ephemeral history. It is
// intentionally not persisted: upstream also loses this navigation history on
// a page reload, while keeping it here makes PC and phone controls consistent.
const canonicalRerollHistories = new Map<string, CanonicalRerollHistory>()

function rerollHistoryKey(target: CanonicalGenerationTarget) {
    return `${target.characterId}\u0000${target.chatId}`
}

function getRerollHistory(target: CanonicalGenerationTarget) {
    const key = rerollHistoryKey(target)
    let history = canonicalRerollHistories.get(key)
    if (!history) {
        history = { entries: [], index: -1, appliedLength: 0, baseMessages: [] }
        canonicalRerollHistories.set(key, history)
    }
    return history
}

function clearRerollHistory(target: CanonicalGenerationTarget) {
    canonicalRerollHistories.delete(rerollHistoryKey(target))
}

function ensureCanonicalMessageIds(messages: Message[]) {
    const seen = new Set<string>()
    for (const message of messages) {
        if (typeof message.chatId !== 'string' || message.chatId === '' || seen.has(message.chatId)) {
            let nextId = v4()
            while (seen.has(nextId)) {
                nextId = v4()
            }
            message.chatId = nextId
        }
        seen.add(message.chatId)
    }
}

interface CanonicalMessageAnchor {
    message: Message
    chatId: string
    role: Message['role']
    saying: string | null
}

function captureGenerationBase(target: ResolvedGenerationTarget): CanonicalMessageAnchor[] {
    const messages = target.character.chats[target.chatIndex].message
    ensureCanonicalMessageIds(messages)
    return messages.map(message => ({
        message,
        chatId: message.chatId!,
        role: message.role,
        saying: message.saying ?? null,
    }))
}

function matchesGenerationAnchor(message: Message, anchor: CanonicalMessageAnchor) {
    return message === anchor.message || (
        message.chatId === anchor.chatId
        && message.role === anchor.role
        && (message.saying ?? null) === anchor.saying
    )
}

function resolveGenerationBoundary(
    currentMessages: Message[],
    anchors: CanonicalMessageAnchor[],
) {
    let boundary = 0
    for (const anchor of anchors) {
        const anchorIndex = currentMessages.findIndex((message, index) => (
            index >= boundary
            && matchesGenerationAnchor(message, anchor)
        ))
        if (anchorIndex < 0) {
            return null
        }
        boundary = anchorIndex + 1
    }
    return boundary
}

function recordGeneratedSlice(
    target: ResolvedGenerationTarget,
    generationBaseLength: number,
    options: { reset?: boolean } = {},
) {
    const messages = target.character.chats[target.chatIndex].message
    // Stable IDs make the resident reroll boundary survive the clone/replace
    // behavior of community start triggers and module trigger pipelines.
    ensureCanonicalMessageIds(messages)
    if (generationBaseLength >= messages.length) {
        return false
    }
    const generatedSlice = safeStructuredClone(messages.slice(generationBaseLength))
    // A user message appended concurrently is not a model alternative. Keep
    // the transcript, but do not let a later reroll delete that user turn.
    if (generatedSlice.some(message => message.role === 'user')) {
        clearRerollHistory({
            characterId: target.character.chaId,
            chatId: target.character.chats[target.chatIndex].id,
        })
        return false
    }
    if (options.reset) {
        clearRerollHistory({
            characterId: target.character.chaId,
            chatId: target.character.chats[target.chatIndex].id,
        })
    }
    const history = getRerollHistory({
        characterId: target.character.chaId,
        chatId: target.character.chats[target.chatIndex].id,
    })
    const baseMessages = safeStructuredClone(messages.slice(0, generationBaseLength))
    if (history.entries.length === 0) {
        history.baseMessages = baseMessages
    }
    else if (!isEqual(history.baseMessages, baseMessages)) {
        // The same resident history must never cross a changed canonical
        // prefix (remote reload, edit, or unrelated mutation).
        history.entries = []
        history.index = -1
        history.appliedLength = 0
        history.baseMessages = baseMessages
    }
    history.entries.push(generatedSlice)
    history.index = history.entries.length - 1
    history.appliedLength = generatedSlice.length
    return true
}

function reconcileLiveGeneratedSlice(
    input: CanonicalGenerationTarget,
    generationBase: CanonicalMessageAnchor[],
    options: { reset?: boolean } = {},
) {
    const liveTarget = findTarget(input)
    if (!liveTarget) {
        clearRerollHistory(input)
        return null
    }
    const boundary = resolveGenerationBoundary(
        liveTarget.character.chats[liveTarget.chatIndex].message,
        generationBase,
    )
    if (boundary === null) {
        clearRerollHistory(input)
    }
    else {
        recordGeneratedSlice(liveTarget, boundary, options)
    }
    return liveTarget
}

function currentRerollEntryStart(messages: Message[], history: CanonicalRerollHistory) {
    const appliedEntry = history.entries[history.index]
    if (
        !Array.isArray(appliedEntry)
        || history.appliedLength !== appliedEntry.length
        || history.appliedLength > messages.length
    ) {
        return null
    }
    const appliedStart = messages.length - history.appliedLength
    if (
        history.baseMessages.length !== appliedStart
        || !isEqual(messages.slice(0, appliedStart), history.baseMessages)
        || !isEqual(messages.slice(appliedStart), appliedEntry)
    ) {
        return null
    }
    return appliedStart
}

function applyRerollEntry(
    messages: Message[],
    history: CanonicalRerollHistory,
    entry: Message[],
) {
    const appliedStart = currentRerollEntryStart(messages, history)
    if (appliedStart === null) {
        return false
    }
    const replacement = safeStructuredClone(entry)
    messages.splice(
        appliedStart,
        history.appliedLength,
        ...replacement,
    )
    history.appliedLength = replacement.length
    return true
}

function findTarget(target: CanonicalGenerationTarget): ResolvedGenerationTarget | null {
    const characterIndex = DBState.db.characters.findIndex((candidate) => candidate.chaId === target.characterId)
    if (characterIndex < 0) {
        return null
    }
    const character = DBState.db.characters[characterIndex]
    const chatIndex = character.chats.findIndex((candidate) => candidate.id === target.chatId)
    if (chatIndex < 0) {
        return null
    }

    return { characterIndex, chatIndex, character }
}

function resolveTarget(target: CanonicalGenerationTarget): ResolvedGenerationTarget {
    const resolved = findTarget(target)
    if (!resolved) {
        const characterExists = DBState.db.characters.some(
            candidate => candidate.chaId === target.characterId,
        )
        throw new CanonicalGenerationTargetError(characterExists
            ? `Chat not found: ${target.chatId}`
            : `Character not found: ${target.characterId}`)
    }

    selectedCharID.set(resolved.characterIndex)
    resolved.character.chatPage = resolved.chatIndex
    return resolved
}

function currentLength(target: ResolvedGenerationTarget) {
    return target.character.chats[target.chatIndex]?.message?.length ?? 0
}

async function runGenerationOnly(
    target: ResolvedGenerationTarget,
    options: SendChatOptions & { chatProcessIndex?: number } = {},
): Promise<CanonicalGenerationResult> {
    const previousLength = currentLength(target)
    if (get(doingChat)) {
        return { generated: false, previousLength, currentLength: previousLength }
    }

    try {
        const sendOptions: SendChatOptions = {
            signal: options.signal,
            continue: options.continue,
        }
        if (options.chatAdditonalTokens !== undefined) {
            sendOptions.chatAdditonalTokens = options.chatAdditonalTokens
        }
        if (options.usedContinueTokens !== undefined) {
            sendOptions.usedContinueTokens = options.usedContinueTokens
        }
        const generated = await sendChat(options.chatProcessIndex ?? -1, sendOptions)
        return {
            generated,
            previousLength,
            currentLength: currentLength(target),
        }
    }
    finally {
        doingChat.set(false)
    }
}

/**
 * Execute the same input, trigger, script, prompt, provider and post-processing
 * path used by DefaultChatScreen. The resident browser calls this function so
 * community content still runs inside the upstream browser runtime.
 */
export async function executeCanonicalSend(input: CanonicalSendInput): Promise<CanonicalGenerationResult> {
    let target = resolveTarget(input)
    const previousLength = currentLength(target)
    if (get(doingChat)) {
        return { generated: false, previousLength, currentLength: previousLength }
    }

    let messageInput = input.input ?? ''
    if (messageInput.startsWith('/')) {
        const chatBeforeCommand = safeStructuredClone(
            target.character.chats[target.chatIndex],
        )
        let commandProcessed: false | string
        try {
            commandProcessed = await processMultiCommand(messageInput)
        }
        finally {
            const liveTarget = findTarget(input)
            const chatAfterCommand = liveTarget
                ? safeStructuredClone(liveTarget.character.chats[liveTarget.chatIndex])
                : null
            if (!isEqual(chatBeforeCommand, chatAfterCommand)) {
                input.onCanonicalMutation?.()
            }
            if (liveTarget) {
                target = liveTarget
            }
        }
        if (commandProcessed !== false) {
            const commandTarget = findTarget(input)
            return {
                generated: false,
                commandProcessed: true,
                previousLength,
                currentLength: commandTarget ? currentLength(commandTarget) : 0,
            }
        }
        const liveTarget = findTarget(input)
        if (!liveTarget) {
            throw new CanonicalGenerationTargetError('Command removed its canonical target')
        }
        target = liveTarget
    }

    clearRerollHistory(input)

    for (const file of input.files ?? []) {
        messageInput += `{{inlayed::${file}}}`
    }

    let messages = target.character.chats[target.chatIndex].message
    let inputReference: CanonicalInputMessageReference | null = null
    const appendInputMessage = (message: Message) => {
        // chatId is the existing upstream per-message identity. Assigning it
        // before the proxy append and persistence gives observers a stable
        // canonical reference without adding a runtime command identifier to
        // the database schema.
        message.chatId ??= input.canonicalInputMessageId ?? v4()
        inputReference = {
            messageIndex: messages.length,
            messageId: message.chatId,
        }
        messages.push(message)
    }
    if (messageInput === '') {
        if (target.character.type !== 'group') {
            const lastMessage = messages.at(-1)
            if ((!lastMessage || lastMessage.role !== 'user') && DBState.db.useSayNothing) {
            appendInputMessage({
                role: 'user',
                data: '*says nothing*',
                name: get(ConnectionOpenStore) ? DBState.db.username : null,
            })
            }
        }
    }
    else if (target.character.type === 'character') {
        const triggerResult = await runTrigger(target.character, 'input', {
            chat: target.character.chats[target.chatIndex],
        })
        const liveAfterTrigger = findTarget(input)
        if (!liveAfterTrigger) {
            throw new CanonicalGenerationTargetError('Input trigger removed its canonical target')
        }
        target = liveAfterTrigger
        if (triggerResult) {
            target.character.chats[target.chatIndex] = triggerResult.chat
            messages = target.character.chats[target.chatIndex].message
        }
        else {
            messages = target.character.chats[target.chatIndex].message
        }
        const processedInput = await processScript(target.character, messageInput, 'editinput')
        const liveAfterScript = findTarget(input)
        if (!liveAfterScript) {
            throw new CanonicalGenerationTargetError('Input script removed its canonical target')
        }
        target = liveAfterScript
        messages = target.character.chats[target.chatIndex].message
        appendInputMessage({
            role: 'user',
            data: processedInput,
            time: Date.now(),
            name: get(ConnectionOpenStore) ? DBState.db.username : null,
        })
    }
    else {
        appendInputMessage({
            role: 'user',
            data: messageInput,
            time: Date.now(),
            name: get(ConnectionOpenStore) ? DBState.db.username : null,
        })
    }

    target.character.chats[target.chatIndex].message = messages
    await sleep(10)
    if (inputReference) {
        await input.onInputAppended?.(inputReference)
    }
    const liveBeforeGeneration = findTarget(input)
    if (!liveBeforeGeneration) {
        throw new CanonicalGenerationTargetError('Input persistence removed its canonical target')
    }
    target = liveBeforeGeneration
    const generationBase = captureGenerationBase(target)
    let result: CanonicalGenerationResult
    try {
        result = await runGenerationOnly(target, {
            continue: input.continueResponse,
            signal: input.signal,
        })
    }
    catch (error) {
        reconcileLiveGeneratedSlice(input, generationBase)
        throw error
    }
    const liveAfterGeneration = reconcileLiveGeneratedSlice(input, generationBase)
    if (!liveAfterGeneration) {
        return { ...result, currentLength: 0 }
    }
    target = liveAfterGeneration
    return { ...result, currentLength: currentLength(target) }
}

/** Runs sendChat against an already-mutated canonical chat. This is the
 * compatibility fallback for plugin APIs, hotkeys and upstream call sites
 * that invoke sendChat below DefaultChatScreen's input boundary. */
export async function executeCanonicalGenerate(
    input: CanonicalGenerationTarget & SendChatOptions & { chatProcessIndex?: number },
): Promise<CanonicalGenerationResult> {
    let target = resolveTarget(input)
    clearRerollHistory(input)
    const generationBase = captureGenerationBase(target)
    let result: CanonicalGenerationResult
    try {
        result = await runGenerationOnly(target, input)
    }
    catch (error) {
        reconcileLiveGeneratedSlice(input, generationBase)
        throw error
    }
    const liveTarget = reconcileLiveGeneratedSlice(input, generationBase)
    if (!liveTarget) {
        return { ...result, currentLength: 0 }
    }
    target = liveTarget
    return { ...result, currentLength: currentLength(target) }
}

/** Generate chat suggestions inside the resident so multiple viewers share
 * one provider request and only the fenced canonical database is mutated. */
export async function executeCanonicalSuggestion(
    input: CanonicalGenerationTarget & { signal?: AbortSignal },
): Promise<CanonicalGenerationResult> {
    let target = resolveTarget(input)
    let chat = target.character.chats[target.chatIndex]
    const previousLength = chat.message.length
    const lastMessages = chat.message.slice(Math.max(chat.message.length - 10, 0))
    const unchanged = (): CanonicalGenerationResult => {
        const liveTarget = findTarget(input)
        const liveChat = liveTarget?.character.chats[liveTarget.chatIndex]
        return {
            generated: false,
            suggestionsUpdated: false,
            suggestionCount: liveChat?.suggestMessages?.length ?? 0,
            previousLength,
            currentLength: liveChat?.message.length ?? 0,
        }
    }
    if (lastMessages.length === 0 || input.signal?.aborted) {
        return unchanged()
    }

    const prompt = DBState.db.autoSuggestPrompt?.length
        ? DBState.db.autoSuggestPrompt
        : defaultAutoSuggestPrompt
    let promptbody: OpenAIChat[] = [
        {
            role: 'system',
            content: replacePlaceholders(prompt, target.character.name),
        },
        {
            role: 'user',
            content: lastMessages
                .map((message) => (
                    `${message.role === 'char' ? target.character.name : getUserName()}:${message.data}`
                ))
                .reduce((left, right) => left + ',' + right),
        },
    ]

    if (
        DBState.db.subModel === 'textgen_webui'
        || DBState.db.subModel === 'mancer'
        || DBState.db.subModel.startsWith('local_')
    ) {
        // Preserve upstream's local-submodel prompt behavior exactly: unlike
        // the normal branch, it intentionally does not substitute the default
        // when autoSuggestPrompt is blank.
        promptbody = [
            {
                role: 'system',
                content: replacePlaceholders(DBState.db.autoSuggestPrompt, target.character.name),
            },
            ...lastMessages.map(({ role, data }) => ({
                role: role === 'user' ? 'user' as const : 'assistant' as const,
                content: data,
            })),
        ]
    }

    const response = await requestChatData({
        formated: promptbody,
        bias: {},
        currentChar: target.character as character,
    }, 'submodel', input.signal ?? null)
    if (
        input.signal?.aborted
        || response.type === 'fail'
        || response.type === 'streaming'
        || response.type === 'multiline'
    ) {
        return unchanged()
    }

    const suggestions = response.result
        .split('\n')
        .filter((message) => message.startsWith('-'))
        .map((message) => message.replace('-', '').trim())
    const liveTarget = findTarget(input)
    if (!liveTarget) {
        return unchanged()
    }
    target = liveTarget
    chat = target.character.chats[target.chatIndex]
    chat.suggestMessages = suggestions
    return {
        generated: false,
        suggestionsUpdated: true,
        suggestionCount: suggestions.length,
        previousLength,
        currentLength: chat.message.length,
    }
}

/** Runs a chat HTML manual trigger in the resident browser. Keeping the whole
 * trigger on this side ensures low-level runLLM effects use the same provider
 * pipeline and survive the direct browser closing after command acceptance. */
export async function executeCanonicalManualTrigger(input: CanonicalGenerationTarget & {
    manualName: string
    triggerId?: string
}): Promise<CanonicalGenerationResult> {
    let target = resolveTarget(input)
    const previousLength = currentLength(target)
    if (target.character.type !== 'character') {
        throw new CanonicalGenerationTargetError('Manual triggers require a character target')
    }
    const result = await runTrigger(target.character, 'manual', {
        chat: target.character.chats[target.chatIndex],
        manualName: input.manualName,
        triggerId: input.triggerId,
    })
    const liveTarget = findTarget(input)
    if (!liveTarget) {
        clearRerollHistory(input)
        return { generated: false, previousLength, currentLength: 0 }
    }
    target = liveTarget
    if (result) {
        target.character.chats[target.chatIndex] = result.chat
    }
    if (input.triggerId) {
        setTimeout(() => CurrentTriggerIdStore.set(null), 100)
    }
    return {
        generated: false,
        previousLength,
        currentLength: currentLength(target),
    }
}

/** Runs a Lua `risu-btn` callback in the resident for the same reason as a
 * manual trigger: its LLM helpers and state mutations must not live in the
 * disposable PC/phone tab. */
export async function executeCanonicalLuaButton(input: CanonicalGenerationTarget & {
    data: string
}): Promise<CanonicalGenerationResult> {
    let target = resolveTarget(input)
    const previousLength = currentLength(target)
    const result = await runLuaButtonTrigger(target.character, input.data)
    const liveTarget = findTarget(input)
    if (!liveTarget) {
        clearRerollHistory(input)
        return { generated: false, previousLength, currentLength: 0 }
    }
    target = liveTarget
    if (result?.chat) {
        target.character.chats[target.chatIndex] = result.chat
    }
    return {
        generated: false,
        previousLength,
        currentLength: currentLength(target),
    }
}

export async function executeCanonicalReroll(
    input: CanonicalGenerationTarget & { signal?: AbortSignal },
): Promise<CanonicalGenerationResult> {
    let target = resolveTarget(input)
    const messages = target.character.chats[target.chatIndex].message
    const previousLength = messages.length
    if (get(doingChat) || messages.length === 0) {
        return { generated: false, previousLength, currentLength: messages.length }
    }

    const generationId = messages.at(-1)?.generationInfo?.generationId
    if (generationId) {
        const cached = Prereroll(generationId)
        if (cached) {
            messages[messages.length - 1].data = cached
            return { generated: false, previousLength, currentLength: messages.length }
        }
    }

    let history = getRerollHistory(input)
    if (history.index < history.entries.length - 1) {
        const nextEntry = history.entries[history.index + 1]
        if (Array.isArray(nextEntry)) {
            if (applyRerollEntry(messages, history, nextEntry)) {
                history.index += 1
            }
            else {
                // A canonical reload or another mutation can invalidate this
                // resident-only history. Discard it instead of guessing which
                // tail messages belong to the old generated slice.
                clearRerollHistory(input)
            }
        }
        return { generated: false, previousLength, currentLength: messages.length }
    }

    let rerollBase: Message[] | null = null
    if (history.entries.length > 0) {
        const appliedStart = currentRerollEntryStart(messages, history)
        if (appliedStart !== null) {
            // A recorded generation slice is a stronger boundary than role or
            // group-speaker heuristics, especially for multi-message outputs.
            rerollBase = safeStructuredClone(messages.slice(0, appliedStart))
        }
        else {
            clearRerollHistory(input)
            history = getRerollHistory(input)
        }
    }

    if (!rerollBase) {
        // With no usable resident history, preserve upstream's role/speaker
        // fallback. Work on a clone so an assistant-only chat stays intact
        // when no safe boundary exists.
        rerollBase = safeStructuredClone(messages)
        const saying = rerollBase.at(-1)?.saying
        let sameSpeakerBoundary = 2
        while (rerollBase.at(-1)?.role !== 'user') {
            const lastMessage = rerollBase.at(-1)
            if (!lastMessage) {
                return { generated: false, previousLength, currentLength: messages.length }
            }
            if (lastMessage.saying === saying) {
                sameSpeakerBoundary -= 1
                if (sameSpeakerBoundary === 0) {
                    break
                }
            }
            rerollBase.pop()
        }
        const rerollBaseLength = rerollBase.length
        ensureCanonicalMessageIds(messages)
        rerollBase = safeStructuredClone(messages.slice(0, rerollBaseLength))
        const initialSlice = safeStructuredClone(messages.slice(rerollBase.length))
        if (initialSlice.length > 0) {
            history.entries.push(initialSlice)
            history.index = history.entries.length - 1
            history.appliedLength = initialSlice.length
            history.baseMessages = safeStructuredClone(rerollBase)
        }
    }
    else {
        const rerollBaseLength = rerollBase.length
        ensureCanonicalMessageIds(messages)
        rerollBase = safeStructuredClone(messages.slice(0, rerollBaseLength))
    }
    const originalTail = safeStructuredClone(messages.slice(rerollBase.length))
    const generationBaseSnapshot = safeStructuredClone(rerollBase)
    const sameOriginalMessage = (left: Message, right: Message) => (
        typeof left.chatId === 'string'
        && typeof right.chatId === 'string'
            ? left.chatId === right.chatId
                && isEqual(left, right)
            : isEqual(left, right)
    )
    const restoreOriginalTailAt = (
        currentMessages: Message[],
        requestedIndex = Math.min(generationBaseSnapshot.length, currentMessages.length),
    ) => {
        const restored = safeStructuredClone(currentMessages)
        let insertionIndex = Math.min(requestedIndex, restored.length)
        // A compatibility hook may have moved all or part of the removed
        // response instead of leaving it at the original boundary. Relocate
        // every recognizable old message before inserting the exact tail so
        // discontiguous group fragments cannot be duplicated. Stable chatIds
        // can be found globally; legacy id-less equality is deliberately
        // restricted to the discarded suffix so a same-looking retained
        // prefix message can never be deleted.
        for (const originalMessage of originalTail) {
            const hasStableId = typeof originalMessage.chatId === 'string'
            const searchStart = hasStableId ? 0 : insertionIndex
            const matchedIndex = restored.findIndex((message, index) => (
                index >= searchStart && sameOriginalMessage(message, originalMessage)
            ))
            if (matchedIndex >= 0) {
                restored.splice(matchedIndex, 1)
                if (matchedIndex < insertionIndex) {
                    insertionIndex -= 1
                }
            }
        }
        if (originalTail.length > 0) {
            restored.splice(insertionIndex, 0, ...safeStructuredClone(originalTail))
        }
        ensureCanonicalMessageIds(restored)
        return restored
    }
    // Keep object identity as an ephemeral boundary marker. In-place prefix
    // edits and insertions preserve these anchors, whereas a DB replacement or
    // destructive hook loses them and therefore fails closed instead of
    // guessing by length.
    target.character.chats[target.chatIndex].message = rerollBase
    const generationBaseAnchors = captureGenerationBase(target)
    const resolveRecoveryBoundary = (currentMessages: Message[]) => {
        const isBaseAnchor = (message: Message) => generationBaseAnchors.some(
            anchor => matchesGenerationAnchor(message, anchor),
        )
        let lastSurvivingAnchor = -1
        for (let index = 0; index < currentMessages.length; index += 1) {
            if (isBaseAnchor(currentMessages[index])) {
                lastSurvivingAnchor = index
            }
        }
        const searchStart = lastSurvivingAnchor + 1
        const concurrentUserIndex = currentMessages.findIndex((message, index) => (
            index >= searchStart
            && message.role === 'user'
            && !isBaseAnchor(message)
        ))
        if (concurrentUserIndex >= 0) {
            return concurrentUserIndex
        }
        return lastSurvivingAnchor >= 0
            ? lastSurvivingAnchor + 1
            : Math.min(generationBaseAnchors.length, currentMessages.length)
    }
    const recordRerollReplacement = (
        currentMessages: Message[],
        boundary: number,
    ) => {
        const replacement = currentMessages.slice(boundary)
        if (replacement.length === 0 || replacement.some(message => message.role === 'user')) {
            return false
        }
        const currentBase = safeStructuredClone(currentMessages.slice(0, boundary))
        const currentHistory = getRerollHistory(input)
        if (isEqual(currentHistory.baseMessages, currentBase)) {
            return recordGeneratedSlice(target, boundary)
        }
        // In-place prefix edits/insertions are valid compatibility-hook output.
        // Rebase both alternatives atomically at the identity-proven boundary.
        const rebasedHistory = currentHistory
        rebasedHistory.baseMessages = currentBase
        rebasedHistory.entries = isEqual(originalTail, replacement)
            ? [safeStructuredClone(originalTail)]
            : [safeStructuredClone(originalTail), safeStructuredClone(replacement)]
        rebasedHistory.index = rebasedHistory.entries.length - 1
        rebasedHistory.appliedLength = replacement.length
        return true
    }
    let result: CanonicalGenerationResult
    try {
        result = await runGenerationOnly(target, { signal: input.signal })
    }
    catch (error) {
        const liveTarget = findTarget(input)
        if (!liveTarget) {
            clearRerollHistory(input)
            throw error
        }
        target = liveTarget
        const failedMessages = target.character.chats[target.chatIndex].message
        const failedBoundary = resolveGenerationBoundary(failedMessages, generationBaseAnchors)
        const failedSuffix = failedBoundary === null
            ? []
            : failedMessages.slice(failedBoundary)
        if (
            failedBoundary !== null
            && failedBoundary < failedMessages.length
            && !failedSuffix.some(message => message.role === 'user')
        ) {
            recordRerollReplacement(failedMessages, failedBoundary)
        }
        else {
            // Preserve any plugin/trigger edits made to the retained prefix,
            // and any concurrent user suffix, while restoring the response
            // that this failed attempt removed at its original boundary.
            target.character.chats[target.chatIndex].message =
                restoreOriginalTailAt(
                    failedMessages,
                    failedBoundary ?? resolveRecoveryBoundary(failedMessages),
                )
            clearRerollHistory(input)
        }
        throw error
    }
    const liveTarget = findTarget(input)
    if (!liveTarget) {
        clearRerollHistory(input)
        return { ...result, currentLength: 0 }
    }
    target = liveTarget
    result = { ...result, currentLength: currentLength(target) }
    const generatedMessages = target.character.chats[target.chatIndex].message
    const generatedBoundary = resolveGenerationBoundary(generatedMessages, generationBaseAnchors)
    const generatedSuffix = generatedBoundary === null
        ? []
        : generatedMessages.slice(generatedBoundary)
    if (
        generatedBoundary !== null
        && generatedBoundary < generatedMessages.length
        && (result.generated || !generatedSuffix.some(message => message.role === 'user'))
    ) {
        recordRerollReplacement(generatedMessages, generatedBoundary)
    }
    else if (
        !result.generated
        || isEqual(generatedMessages, generationBaseSnapshot)
    ) {
        // A failed/aborted reroll that produced no replacement must not turn
        // the temporary generation base into a durable deletion. Retain any
        // prefix edits or concurrent user suffix made by compatibility hooks
        // and restore only the old response tail at its original boundary.
        const restoredMessages = restoreOriginalTailAt(
            generatedMessages,
            generatedBoundary ?? resolveRecoveryBoundary(generatedMessages),
        )
        target.character.chats[target.chatIndex].message = restoredMessages
        result = { ...result, currentLength: restoredMessages.length }
        clearRerollHistory(input)
    }
    else {
        // A successful output hook may intentionally replace or truncate the
        // entire transcript, leaving no append-only slice to navigate.
        clearRerollHistory(input)
    }
    return result
}

export function executeCanonicalUnreroll(input: CanonicalGenerationTarget): CanonicalGenerationResult {
    const target = resolveTarget(input)
    const messages = target.character.chats[target.chatIndex].message
    const previousLength = messages.length
    const lastMessage: Message | undefined = messages.at(-1)
    const generationId = lastMessage?.generationInfo?.generationId
    if (lastMessage && generationId) {
        const cached = PreUnreroll(generationId)
        if (cached) {
            lastMessage.data = cached
            return { generated: false, previousLength, currentLength: messages.length }
        }
    }
    const history = getRerollHistory(input)
    if (history.index > 0) {
        const previousEntry = history.entries[history.index - 1]
        if (Array.isArray(previousEntry)) {
            if (applyRerollEntry(messages, history, previousEntry)) {
                history.index -= 1
            }
            else {
                clearRerollHistory(input)
            }
        }
    }
    return { generated: false, previousLength, currentLength: messages.length }
}

export async function executeCanonicalAuto(
    input: CanonicalGenerationTarget & { signal: AbortSignal, onIteration?: (iteration: number) => void },
): Promise<CanonicalGenerationResult> {
    let target = resolveTarget(input)
    clearRerollHistory(input)
    const initialLength = currentLength(target)
    let iteration = 0
    while (!input.signal.aborted) {
        const liveBeforeIteration = findTarget(input)
        if (!liveBeforeIteration) {
            clearRerollHistory(input)
            break
        }
        target = liveBeforeIteration
        const generationBase = captureGenerationBase(target)
        let result: CanonicalGenerationResult
        try {
            result = await runGenerationOnly(target, { signal: input.signal })
        }
        catch (error) {
            reconcileLiveGeneratedSlice(input, generationBase, { reset: true })
            throw error
        }
        const liveAfterIteration = reconcileLiveGeneratedSlice(
            input,
            generationBase,
            { reset: true },
        )
        if (!liveAfterIteration) {
            break
        }
        target = liveAfterIteration
        // Auto iterations are consecutive turns, not alternatives for one
        // base. Preserve earlier turns and make only the latest slice rerollable.
        if (!result.generated || input.signal.aborted) {
            break
        }
        iteration += 1
        input.onIteration?.(iteration)
    }
    const finalTarget = findTarget(input)
    const finalLength = finalTarget ? currentLength(finalTarget) : 0
    return {
        generated: finalLength > initialLength,
        previousLength: initialLength,
        currentLength: finalLength,
    }
}
