import { derived, writable } from 'svelte/store'
import type { RuntimeGenerationCommand } from './generationClient'

export interface RuntimeGenerationTargetFilter {
    characterId?: string
    chatId?: string
}

function isActiveRuntimeGeneration(command: RuntimeGenerationCommand) {
    return command.state === 'queued' || command.state === 'running'
}

function compareActiveRuntimeGenerations(
    left: RuntimeGenerationCommand,
    right: RuntimeGenerationCommand,
) {
    if (left.state !== right.state) {
        return left.state === 'running' ? -1 : 1
    }
    if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt
    }
    return left.commandId.localeCompare(right.commandId)
}

const commandState = writable<readonly RuntimeGenerationCommand[]>([])
const pendingIntentState = writable<readonly RuntimeGenerationPendingIntent[]>([])

export interface RuntimeGenerationPendingIntent {
    readonly requestId: string
    readonly characterId: string
    readonly chatId: string
    readonly controller: AbortController
    readonly input: string
    readonly files: readonly string[]
    readonly createdAt: number
}

/** All commands currently followed by this browser, including commands that
 * are waiting for their terminal database-revision barrier. */
export const runtimeGenerationCommands = {
    subscribe: commandState.subscribe,
}

/** Durable queued/running commands. This neutral module deliberately has no
 * dependency on DBState, characters, or the generation orchestration module,
 * so navigation code can consume it without creating an import cycle. */
export const activeRuntimeGenerationCommands = derived(
    commandState,
    ($commands) => $commands
        .filter(isActiveRuntimeGeneration)
        .sort(compareActiveRuntimeGenerations),
)

export const runtimeGenerationActive = derived(
    activeRuntimeGenerationCommands,
    ($commands) => $commands.length > 0,
)

/** Browser-memory-only admissions that have not received their durable
 * command response yet. This survives ChatScreen teardown/recreation on the
 * mobile UI, but is never written to local storage or the canonical DB. */
export const runtimeGenerationPendingIntents = {
    subscribe: pendingIntentState.subscribe,
}

export function registerRuntimeGenerationPendingIntent(
    intent: RuntimeGenerationPendingIntent,
) {
    if (!intent.requestId || !intent.characterId || !intent.chatId) {
        throw new TypeError('Runtime generation pending intent IDs must be non-empty')
    }
    pendingIntentState.update((current) => {
        if (current.some((candidate) => candidate.requestId === intent.requestId)) {
            throw new Error(`Runtime generation intent ${intent.requestId} already exists`)
        }
        return [...current, Object.freeze({
            ...intent,
            files: Object.freeze([...intent.files]),
        })]
    })
}

export function clearRuntimeGenerationPendingIntent(requestId: string) {
    pendingIntentState.update((current) => current.filter(
        (intent) => intent.requestId !== requestId,
    ))
}

export interface RuntimeGenerationTargetActivity {
    activeCommand: RuntimeGenerationCommand | null
    anyActive: boolean
    activeElsewhere: boolean
}

/** Select activity for one exact character/chat pair. Missing target IDs do
 * not fall back to a global command; this is important for Stop buttons while
 * the user is navigating between chats. */
export function getRuntimeGenerationTargetActivity(
    commands: readonly RuntimeGenerationCommand[],
    target: RuntimeGenerationTargetFilter,
): RuntimeGenerationTargetActivity {
    const anyActive = commands.some(isActiveRuntimeGeneration)
    const activeCommand = target.characterId && target.chatId
        ? commands
            .filter((command) => (
                isActiveRuntimeGeneration(command)
                && command.characterId === target.characterId
                && command.chatId === target.chatId
            ))
            .sort(compareActiveRuntimeGenerations)[0] ?? null
        : null
    return {
        activeCommand,
        anyActive,
        activeElsewhere: anyActive && activeCommand === null,
    }
}

/** Orchestration-only publication hook. Consumers should subscribe to one of
 * the read-only stores above. */
export function publishRuntimeGenerationCommands(
    commands: readonly RuntimeGenerationCommand[],
) {
    commandState.set(commands)
}

export { isActiveRuntimeGeneration, compareActiveRuntimeGenerations }
