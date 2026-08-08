import { get } from 'svelte/store'
import { ConnectionOpenStore } from '../sync/multiuser'
import { DBState, selectedCharID } from '../stores.svelte'
import type { Message, character, groupChat } from '../storage/database.svelte'
import { processMultiCommand } from '../process/command'
import { doingChat, sendChat, type SendChatOptions } from '../process/index.svelte'
import { Prereroll, PreUnreroll } from '../process/prereroll'
import { processScript } from '../process/scripts'
import { runTrigger } from '../process/triggers'
import { safeStructuredClone } from '../polyfill'
import { sleep } from '../util'

export type CanonicalGenerationAction = 'send' | 'continue' | 'reroll' | 'unreroll' | 'auto' | 'generate'

export interface CanonicalGenerationTarget {
    characterId: string
    chatId: string
}

export interface CanonicalSendInput extends CanonicalGenerationTarget {
    input: string
    files?: string[]
    continueResponse?: boolean
    signal?: AbortSignal
}

export interface CanonicalGenerationResult {
    generated: boolean
    commandProcessed?: boolean
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
        history = { entries: [], index: -1 }
        canonicalRerollHistories.set(key, history)
    }
    return history
}

function clearRerollHistory(target: CanonicalGenerationTarget) {
    canonicalRerollHistories.delete(rerollHistoryKey(target))
}

function applyRerollEntry(messages: Message[], entry: Message[]) {
    const replacement = safeStructuredClone(entry)
    for (let index = 0; index < replacement.length; index += 1) {
        messages[messages.length - replacement.length + index] = replacement[index]
    }
}

function resolveTarget(target: CanonicalGenerationTarget): ResolvedGenerationTarget {
    const characterIndex = DBState.db.characters.findIndex((candidate) => candidate.chaId === target.characterId)
    if (characterIndex < 0) {
        throw new CanonicalGenerationTargetError(`Character not found: ${target.characterId}`)
    }
    const character = DBState.db.characters[characterIndex]
    const chatIndex = character.chats.findIndex((candidate) => candidate.id === target.chatId)
    if (chatIndex < 0) {
        throw new CanonicalGenerationTargetError(`Chat not found: ${target.chatId}`)
    }

    selectedCharID.set(characterIndex)
    character.chatPage = chatIndex
    return { characterIndex, chatIndex, character }
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
    const target = resolveTarget(input)
    clearRerollHistory(input)
    const previousLength = currentLength(target)
    if (get(doingChat)) {
        return { generated: false, previousLength, currentLength: previousLength }
    }

    let messageInput = input.input ?? ''
    if (messageInput.startsWith('/')) {
        const commandProcessed = await processMultiCommand(messageInput)
        if (commandProcessed !== false) {
            return {
                generated: false,
                commandProcessed: true,
                previousLength,
                currentLength: currentLength(target),
            }
        }
    }

    for (const file of input.files ?? []) {
        messageInput += `{{inlayed::${file}}}`
    }

    let messages = target.character.chats[target.chatIndex].message
    if (messageInput === '') {
        if (target.character.type !== 'group') {
            const lastMessage = messages.at(-1)
            if ((!lastMessage || lastMessage.role !== 'user') && DBState.db.useSayNothing) {
                messages.push({
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
        if (triggerResult) {
            messages = triggerResult.chat.message
        }
        messages.push({
            role: 'user',
            data: await processScript(target.character, messageInput, 'editinput'),
            time: Date.now(),
            name: get(ConnectionOpenStore) ? DBState.db.username : null,
        })
    }
    else {
        messages.push({
            role: 'user',
            data: messageInput,
            time: Date.now(),
            name: get(ConnectionOpenStore) ? DBState.db.username : null,
        })
    }

    target.character.chats[target.chatIndex].message = messages
    await sleep(10)
    return await runGenerationOnly(target, {
        continue: input.continueResponse,
        signal: input.signal,
    })
}

/** Runs sendChat against an already-mutated canonical chat. This is the
 * compatibility fallback for plugin APIs, hotkeys and upstream call sites
 * that invoke sendChat below DefaultChatScreen's input boundary. */
export async function executeCanonicalGenerate(
    input: CanonicalGenerationTarget & SendChatOptions & { chatProcessIndex?: number },
): Promise<CanonicalGenerationResult> {
    const target = resolveTarget(input)
    clearRerollHistory(input)
    return await runGenerationOnly(target, input)
}

export async function executeCanonicalReroll(
    input: CanonicalGenerationTarget & { signal?: AbortSignal },
): Promise<CanonicalGenerationResult> {
    const target = resolveTarget(input)
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

    const history = getRerollHistory(input)
    if (history.index < history.entries.length - 1) {
        const nextEntry = history.entries[history.index + 1]
        if (Array.isArray(nextEntry)) {
            history.index += 1
            applyRerollEntry(messages, nextEntry)
        }
        return { generated: false, previousLength, currentLength: messages.length }
    }
    if (history.entries.length === 0) {
        history.entries.push(safeStructuredClone([messages.at(-1)!]))
        history.index = history.entries.length - 1
    }

    const saying = messages.at(-1)?.saying
    let sameSpeakerBoundary = 2
    while (messages.at(-1)?.role !== 'user') {
        if (messages.at(-1)?.saying === saying) {
            sameSpeakerBoundary -= 1
            if (sameSpeakerBoundary === 0) {
                break
            }
        }
        if (!messages.pop()) {
            return { generated: false, previousLength, currentLength: 0 }
        }
    }
    target.character.chats[target.chatIndex].message = messages
    const generationBaseLength = messages.length
    const result = await runGenerationOnly(target, { signal: input.signal })
    const generatedMessages = target.character.chats[target.chatIndex].message
    if (generationBaseLength < generatedMessages.length) {
        history.entries.push(safeStructuredClone(generatedMessages.slice(generationBaseLength)))
        history.index = history.entries.length - 1
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
            history.index -= 1
            applyRerollEntry(messages, previousEntry)
        }
    }
    return { generated: false, previousLength, currentLength: messages.length }
}

export async function executeCanonicalAuto(
    input: CanonicalGenerationTarget & { signal: AbortSignal, onIteration?: (iteration: number) => void },
): Promise<CanonicalGenerationResult> {
    const target = resolveTarget(input)
    clearRerollHistory(input)
    const initialLength = currentLength(target)
    let iteration = 0
    while (!input.signal.aborted) {
        const result = await runGenerationOnly(target, { signal: input.signal })
        if (!result.generated || input.signal.aborted) {
            break
        }
        iteration += 1
        input.onIteration?.(iteration)
    }
    return {
        generated: currentLength(target) > initialLength,
        previousLength: initialLength,
        currentLength: currentLength(target),
    }
}
