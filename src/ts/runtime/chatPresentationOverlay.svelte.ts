import { derived, get, writable } from 'svelte/store'
import type { RuntimeGenerationState } from './generationClient'

export type RuntimeChatPresentationPhase =
    | 'submitting'
    | 'queued'
    | 'running'
    | 'terminal'

export interface RuntimeChatPresentationOverlay {
    readonly requestId: string
    readonly commandId: string | null
    readonly characterId: string
    readonly chatId: string
    readonly input: string
    readonly files: readonly string[]
    readonly displayText: string
    readonly createdAt: number
    readonly baseRevision: number
    readonly phase: RuntimeChatPresentationPhase
    readonly canonicalRevision: number | null
    readonly canonicalMessageId: string | null
    readonly terminalState: RuntimeGenerationState | null
    readonly terminalRevision: number | null
    readonly canonicalMutationPersisted: boolean | null
}

export interface CreateRuntimeChatPresentationOverlay {
    requestId: string
    characterId: string
    chatId: string
    input: string
    files?: readonly string[]
    displayText?: string
    createdAt?: number
    baseRevision: number
}

export interface ResolveRuntimeChatPresentationTextInput {
    input: string
    files?: readonly string[]
    useSayNothing: boolean
    isGroup: boolean
    lastRole?: string | null
    /** Kept in the presentation contract to make the canonical continue-send
     * equivalence explicit. The upstream pipeline applies says-nothing to both
     * send and continue commands. */
    continueResponse?: boolean
}

export interface EnsureRuntimeChatPresentationOverlay
    extends CreateRuntimeChatPresentationOverlay {
    commandId: string
    state: 'queued' | 'running'
}

export interface RuntimeChatOverlayCanonicalMarker {
    requestId?: string
    canonicalRevision: number
    messageId?: string | null
}

export interface RuntimeChatOverlayTerminalResult {
    requestId?: string
    state: RuntimeGenerationState
    terminalRevision?: number | null
    canonicalMutationPersisted?: boolean | null
}

const overlays = writable<readonly RuntimeChatPresentationOverlay[]>([])
const pendingCanonicalMarkers = new Map<string, RuntimeChatOverlayCanonicalMarker>()
const pendingTerminalResults = new Map<string, RuntimeChatOverlayTerminalResult>()
const reservedRequestIds = new Set<string>()

export const runtimeChatPresentationOverlays = {
    subscribe: overlays.subscribe,
}

/** Overlays disappear from presentation as soon as the command's canonical
 * user mutation is known to be durable. The record remains until terminal
 * reconciliation so cancellation/failure logic can still inspect it. */
export const visibleRuntimeChatPresentationOverlays = derived(
    overlays,
    ($overlays) => $overlays.filter((overlay) => overlay.canonicalRevision === null),
)

function requireIdentifier(value: string, name: string) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${name} must be a non-empty string`)
    }
}

function requireRevision(value: number, name: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative safe integer`)
    }
}

function replaceOverlay(
    matches: (overlay: RuntimeChatPresentationOverlay) => boolean,
    update: (overlay: RuntimeChatPresentationOverlay) => RuntimeChatPresentationOverlay,
) {
    overlays.update((current) => current.map((overlay) => matches(overlay) ? update(overlay) : overlay))
}

function matchesOverlay(identifier: string) {
    return (overlay: RuntimeChatPresentationOverlay) => (
        overlay.requestId === identifier || overlay.commandId === identifier
    )
}

/** Mirrors the raw-input placeholder produced by the canonical send pipeline.
 * In particular, continue and ordinary send have identical empty-input
 * semantics. */
export function resolveRuntimeChatPresentationText(
    input: ResolveRuntimeChatPresentationTextInput,
) {
    const displayText = input.input + (input.files ?? [])
        .map((file) => `{{inlayed::${file}}}`)
        .join('')
    if (displayText !== '') {
        return displayText
    }
    return !input.isGroup && input.lastRole !== 'user' && input.useSayNothing
        ? '*says nothing*'
        : ''
}

/** Reserves an exact local request without making it visible. Large command
 * bodies use this before admission so an input_committed event can be matched
 * safely even though their overlay must not appear until the create ACK. */
export function reserveRuntimeChatPresentationRequest(requestId: string) {
    requireIdentifier(requestId, 'requestId')
    reservedRequestIds.add(requestId)
}

export function createRuntimeChatPresentationOverlay(
    input: CreateRuntimeChatPresentationOverlay,
) {
    requireIdentifier(input.requestId, 'requestId')
    requireIdentifier(input.characterId, 'characterId')
    requireIdentifier(input.chatId, 'chatId')
    requireRevision(input.baseRevision, 'baseRevision')
    reserveRuntimeChatPresentationRequest(input.requestId)
    if (get(overlays).some((overlay) => overlay.requestId === input.requestId)) {
        throw new Error(`Runtime chat overlay already exists for request ${input.requestId}`)
    }
    const files = Object.freeze([...(input.files ?? [])])
    const overlay: RuntimeChatPresentationOverlay = Object.freeze({
        requestId: input.requestId,
        commandId: null,
        characterId: input.characterId,
        chatId: input.chatId,
        input: input.input,
        files,
        displayText: input.displayText ?? (
            input.input + files.map((file) => `{{inlayed::${file}}}`).join('')
        ),
        createdAt: input.createdAt ?? Date.now(),
        baseRevision: input.baseRevision,
        phase: 'submitting',
        canonicalRevision: null,
        canonicalMessageId: null,
        terminalState: null,
        terminalRevision: null,
        canonicalMutationPersisted: null,
    })
    overlays.update((current) => [...current, overlay])
    return overlay
}

export function bindRuntimeChatPresentationCommand(
    requestId: string,
    command: { commandId: string; state?: RuntimeGenerationState },
) {
    requireIdentifier(requestId, 'requestId')
    requireIdentifier(command.commandId, 'commandId')
    const pendingCanonicalMarker = pendingCanonicalMarkers.get(command.commandId)
    const pendingTerminalResult = pendingTerminalResults.get(command.commandId)
    const canonicalMarker = pendingCanonicalMarker?.requestId === requestId
        ? pendingCanonicalMarker
        : undefined
    const terminalResult = pendingTerminalResult?.requestId === requestId
        ? pendingTerminalResult
        : undefined
    replaceOverlay(
        (overlay) => overlay.requestId === requestId,
        (overlay) => Object.freeze({
            ...overlay,
            commandId: command.commandId,
            phase: terminalResult
                ? 'terminal'
                : (command.state === 'running' ? 'running' : 'queued'),
            canonicalRevision: canonicalMarker?.canonicalRevision ?? overlay.canonicalRevision,
            canonicalMessageId: canonicalMarker?.messageId ?? overlay.canonicalMessageId,
            terminalState: terminalResult?.state ?? overlay.terminalState,
            terminalRevision: terminalResult?.terminalRevision ?? overlay.terminalRevision,
            canonicalMutationPersisted:
                terminalResult?.canonicalMutationPersisted
                ?? overlay.canonicalMutationPersisted,
        }),
    )
    pendingCanonicalMarkers.delete(command.commandId)
    pendingTerminalResults.delete(command.commandId)
    reservedRequestIds.delete(requestId)
}

/** Idempotently reconstructs a durable queued/running command on another
 * browser (or after reload) without duplicating an overlay already created by
 * the initiating page. Call before starting command event replay. */
export function ensureRuntimeChatPresentationOverlay(
    input: EnsureRuntimeChatPresentationOverlay,
) {
    requireIdentifier(input.commandId, 'commandId')
    const existing = get(overlays).find((overlay) => (
        overlay.requestId === input.requestId || overlay.commandId === input.commandId
    ))
    if (existing) {
        if (
            (existing.commandId && existing.commandId !== input.commandId)
            || existing.requestId !== input.requestId
        ) {
            throw new Error('Runtime chat overlay command identity disagrees with requestId')
        }
        bindRuntimeChatPresentationCommand(input.requestId, input)
        return getRuntimeChatPresentationOverlay(input.commandId)
    }

    const displayText = input.displayText ?? (
        input.input + (input.files ?? []).map((file) => `{{inlayed::${file}}}`).join('')
    )
    if (displayText === '') {
        return null
    }
    createRuntimeChatPresentationOverlay({ ...input, displayText })
    bindRuntimeChatPresentationCommand(input.requestId, input)
    return getRuntimeChatPresentationOverlay(input.commandId)
}

export function updateRuntimeChatPresentationCommand(
    identifier: string,
    state: RuntimeGenerationState,
) {
    requireIdentifier(identifier, 'overlay identifier')
    replaceOverlay(
        matchesOverlay(identifier),
        (overlay) => Object.freeze({
            ...overlay,
            phase: state === 'queued' || state === 'running' ? state : 'terminal',
            terminalState: state === 'queued' || state === 'running' ? null : state,
        }),
    )
}

/** Protocol hook: call when `input_committed` proves which canonical revision
 * contains this command's real user message. */
export function markRuntimeChatOverlayCanonical(
    commandId: string,
    marker: RuntimeChatOverlayCanonicalMarker,
) {
    requireIdentifier(commandId, 'commandId')
    requireRevision(marker.canonicalRevision, 'canonicalRevision')
    const boundOverlay = get(overlays).find((overlay) => overlay.commandId === commandId)
    if (boundOverlay && marker.requestId && marker.requestId !== boundOverlay.requestId) {
        return
    }
    if (!boundOverlay) {
        // queueRuntimeGeneration starts replay observation before returning its
        // create ACK, so input_committed can legitimately win the bind race.
        // The durable command requestId prevents another device's command from
        // being attached to whichever local request happens to be unbound.
        if (marker.requestId && reservedRequestIds.has(marker.requestId)) {
            pendingCanonicalMarkers.set(commandId, Object.freeze({ ...marker }))
        }
        return
    }
    replaceOverlay(
        (overlay) => overlay.commandId === commandId,
        (overlay) => Object.freeze({
            ...overlay,
            canonicalRevision: marker.canonicalRevision,
            canonicalMessageId: marker.messageId ?? null,
        }),
    )
}

export function settleRuntimeChatOverlay(
    identifier: string,
    result: RuntimeChatOverlayTerminalResult,
) {
    requireIdentifier(identifier, 'overlay identifier')
    if (result.terminalRevision !== undefined && result.terminalRevision !== null) {
        requireRevision(result.terminalRevision, 'terminalRevision')
    }
    const boundOverlay = get(overlays).find(matchesOverlay(identifier))
    if (boundOverlay && result.requestId && result.requestId !== boundOverlay.requestId) {
        return
    }
    if (!boundOverlay) {
        if (result.requestId && reservedRequestIds.has(result.requestId)) {
            pendingTerminalResults.set(identifier, Object.freeze({ ...result }))
        }
        return
    }
    replaceOverlay(
        matchesOverlay(identifier),
        (overlay) => Object.freeze({
            ...overlay,
            phase: 'terminal',
            terminalState: result.state,
            terminalRevision: result.terminalRevision ?? null,
            canonicalMutationPersisted: result.canonicalMutationPersisted ?? null,
        }),
    )
}

export function removeRuntimeChatPresentationOverlay(identifier: string) {
    requireIdentifier(identifier, 'overlay identifier')
    const removedRequestIds = get(overlays)
        .filter(matchesOverlay(identifier))
        .map((overlay) => overlay.requestId)
    overlays.update((current) => current.filter((overlay) => !matchesOverlay(identifier)(overlay)))
    reservedRequestIds.delete(identifier)
    for (const requestId of removedRequestIds) {
        reservedRequestIds.delete(requestId)
    }
    pendingCanonicalMarkers.delete(identifier)
    pendingTerminalResults.delete(identifier)
    for (const [commandId, marker] of pendingCanonicalMarkers) {
        if (marker.requestId === identifier || removedRequestIds.includes(marker.requestId ?? '')) {
            pendingCanonicalMarkers.delete(commandId)
        }
    }
    for (const [commandId, result] of pendingTerminalResults) {
        if (result.requestId === identifier || removedRequestIds.includes(result.requestId ?? '')) {
            pendingTerminalResults.delete(commandId)
        }
    }
}

export function getRuntimeChatPresentationOverlay(identifier: string) {
    return get(overlays).find(matchesOverlay(identifier)) ?? null
}

/** Test/bootstrap helper. Browser reloads naturally start with an empty
 * presentation layer; durable command discovery may rebuild it later. */
export function clearRuntimeChatPresentationOverlays() {
    overlays.set([])
    pendingCanonicalMarkers.clear()
    pendingTerminalResults.clear()
    reservedRequestIds.clear()
}
