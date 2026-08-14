import { get, writable } from 'svelte/store'
import type {
    RuntimeGenerationOutput,
    RuntimeGenerationOutputMessage,
} from './generationClient'

export type RuntimeAssistantOutputSnapshot = RuntimeGenerationOutput

export interface RuntimeAssistantOutputTarget {
    readonly commandId: string
    readonly requestId: string
    readonly characterId: string
    readonly chatId: string
}

/**
 * One presentation-only assistant message from a command-wide cumulative
 * snapshot. It deliberately lives outside the canonical Risu database.
 */
export interface RuntimeAssistantOutputPresentation
    extends RuntimeGenerationOutputMessage, RuntimeAssistantOutputTarget {
    readonly type: 'generation_output'
    readonly version: number
    readonly timestamp: number
}

const outputs = writable<readonly RuntimeAssistantOutputPresentation[]>([])

export const runtimeAssistantOutputPresentations = {
    subscribe: outputs.subscribe,
}

function requireIdentifier(value: string, name: string) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${name} must be a non-empty string`)
    }
}

function requireSafeInteger(value: number, name: string, minimum = 0) {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new TypeError(`${name} must be a safe integer >= ${minimum}`)
    }
}

function validateMessage(
    message: RuntimeGenerationOutputMessage,
    messageIds: Set<string>,
    previousMessageIndex: number,
) {
    requireIdentifier(message.messageId, 'messageId')
    if (messageIds.has(message.messageId)) {
        throw new TypeError('Runtime assistant output messageId values must be unique')
    }
    messageIds.add(message.messageId)
    requireSafeInteger(message.messageIndex, 'messageIndex')
    if (message.messageIndex <= previousMessageIndex) {
        throw new TypeError('Runtime assistant output messages must be ordered by messageIndex')
    }
    if (typeof message.data !== 'string') {
        throw new TypeError('Runtime assistant output data must be a string')
    }
    if (!Number.isFinite(message.createdAt) || message.createdAt < 0) {
        throw new TypeError('Runtime assistant output createdAt must be non-negative')
    }
    if (
        message.generationInfo !== null
        && (
            typeof message.generationInfo !== 'object'
            || Array.isArray(message.generationInfo)
        )
    ) {
        throw new TypeError('Runtime assistant output generationInfo must be an object or null')
    }
    if (!['off', 'balanced', 'strong'].includes(message.optimizationMode)) {
        throw new TypeError('Runtime assistant output optimizationMode is invalid')
    }
}

function validateSnapshot(snapshot: RuntimeAssistantOutputSnapshot) {
    if (snapshot.type !== 'generation_output') {
        throw new TypeError('Runtime assistant output type must be generation_output')
    }
    requireIdentifier(snapshot.commandId, 'commandId')
    requireSafeInteger(snapshot.version, 'version', 1)
    if (!Array.isArray(snapshot.messages) || snapshot.messages.length === 0) {
        throw new TypeError('Runtime assistant output must contain at least one message')
    }
    const messageIds = new Set<string>()
    let previousMessageIndex = -1
    for (const message of snapshot.messages) {
        validateMessage(message, messageIds, previousMessageIndex)
        previousMessageIndex = message.messageIndex
    }
    if (!Number.isFinite(snapshot.timestamp) || snapshot.timestamp < 0) {
        throw new TypeError('Runtime assistant output timestamp must be non-negative')
    }
}

function snapshotFromPresentations(
    presentations: readonly RuntimeAssistantOutputPresentation[],
): RuntimeGenerationOutput | null {
    const first = presentations[0]
    if (!first) {
        return null
    }
    return {
        type: 'generation_output',
        commandId: first.commandId,
        version: first.version,
        messages: presentations.map((presentation) => ({
            messageId: presentation.messageId,
            messageIndex: presentation.messageIndex,
            data: presentation.data,
            createdAt: presentation.createdAt,
            generationInfo: presentation.generationInfo,
            optimizationMode: presentation.optimizationMode,
        })),
        timestamp: first.timestamp,
    }
}

/** Atomically replaces this command's ordered message set with a strictly
 * newer cumulative snapshot. Gaps are intentional: a slow viewer needs only
 * the newest normalized state of every message produced by the command. */
export function upsertRuntimeAssistantOutputPresentation(
    target: RuntimeAssistantOutputTarget,
    snapshot: RuntimeAssistantOutputSnapshot,
) {
    requireIdentifier(target.commandId, 'target.commandId')
    requireIdentifier(target.requestId, 'target.requestId')
    requireIdentifier(target.characterId, 'target.characterId')
    requireIdentifier(target.chatId, 'target.chatId')
    validateSnapshot(snapshot)
    if (snapshot.commandId !== target.commandId) {
        throw new Error('Runtime assistant output command identity disagrees with its target')
    }

    const current = get(outputs)
    const existing = current.filter((output) => output.commandId === target.commandId)
    const firstExisting = existing[0]
    if (firstExisting) {
        if (
            firstExisting.requestId !== target.requestId
            || firstExisting.characterId !== target.characterId
            || firstExisting.chatId !== target.chatId
        ) {
            throw new Error('Runtime assistant output identity changed between versions')
        }
        if (snapshot.version < firstExisting.version) {
            return existing
        }
        if (snapshot.version === firstExisting.version) {
            if (JSON.stringify(snapshotFromPresentations(existing)) !== JSON.stringify(snapshot)) {
                throw new Error('Runtime assistant output version was reused with different data')
            }
            return existing
        }
    }

    const next = snapshot.messages.map((message) => Object.freeze({
        ...target,
        type: snapshot.type,
        version: snapshot.version,
        timestamp: snapshot.timestamp,
        ...message,
    }) satisfies RuntimeAssistantOutputPresentation)
    outputs.update((all) => {
        const insertionIndex = all.findIndex((output) => output.commandId === target.commandId)
        const remaining = all.filter((output) => output.commandId !== target.commandId)
        if (insertionIndex < 0) {
            return [...remaining, ...next]
        }
        remaining.splice(Math.min(insertionIndex, remaining.length), 0, ...next)
        return remaining
    })
    return next
}

export function getRuntimeAssistantOutputPresentation(commandId: string) {
    return get(outputs).find((output) => output.commandId === commandId) ?? null
}

export function getRuntimeAssistantOutputPresentations(commandId: string) {
    return get(outputs).filter((output) => output.commandId === commandId)
}

export function removeRuntimeAssistantOutputPresentation(commandId: string) {
    outputs.update((all) => all.filter((output) => output.commandId !== commandId))
}

export function clearRuntimeAssistantOutputPresentations() {
    outputs.set([])
}
