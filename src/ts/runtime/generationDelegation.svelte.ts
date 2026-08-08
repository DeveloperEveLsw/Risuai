import { get, writable } from 'svelte/store'
import {
    alertError,
    dismissRuntimeAlertPrompt,
    dismissRuntimeAlertPromptsForCommand,
    presentRuntimeAlertNotice,
    presentRuntimeAlertPrompt,
    type alertData,
} from '../alert'
import { isNodeServer, isServerResidentExecutor } from '../platform'
import {
    chatProcessStage,
    doingChat,
    setSendChatDelegate,
    type SendChatOptions,
} from '../process/index.svelte'
import { DBState, selectedCharID } from '../stores.svelte'
import {
    RuntimeGenerationClient,
    type RuntimeGenerationCommand,
    type RuntimeGenerationCreateInput,
} from './generationClient'

const runtimeClient = new RuntimeGenerationClient()
const observedCommands = new Map<string, {
    command: RuntimeGenerationCommand
    stop: () => void
    createdHere: boolean
    finishing: boolean
}>()
let discoveryStarted = false
let discoveryStopped = false
let delegateInstalled = false
type WaitForPersistence = (
    timeoutMs?: number,
    minimumRevision?: number,
) => Promise<{ revision: number } | null>
let waitForRuntimePersistence: WaitForPersistence | null = null
const seenTerminalCommandIds = new Set<string>()
let terminalDiscoveryWatermark = Date.now() - 10 * 60_000

export const runtimeGenerationCommands = writable<RuntimeGenerationCommand[]>([])

export function shouldDelegateGeneration() {
    return isNodeServer && !isServerResidentExecutor
}

function publishCommands() {
    const commands = [...observedCommands.values()]
        .map((entry) => entry.command)
        .sort((left, right) => left.createdAt - right.createdAt)
    runtimeGenerationCommands.set(commands)
    doingChat.set(commands.some((command) => command.state === 'queued' || command.state === 'running'))
}

function completedDatabaseRevision(command: RuntimeGenerationCommand) {
    const revision = command.result?.databaseRevision
    if (revision === null || revision === undefined) {
        return null
    }
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
        throw new Error('Server generation returned an invalid database revision')
    }
    return revision as number
}

async function waitForCompletedRevision(command: RuntimeGenerationCommand) {
    if (
        command.state !== 'completed'
        && command.state !== 'failed'
        && command.state !== 'cancelled'
    ) {
        return
    }
    const revision = completedDatabaseRevision(command)
    if (revision === null || !waitForRuntimePersistence) {
        return
    }
    const persisted = await waitForRuntimePersistence(60_000, revision)
    if ((persisted?.revision ?? -1) < revision) {
        throw new Error(
            `Client database revision ${persisted?.revision ?? 'none'} is behind completed revision ${revision}`,
        )
    }
}

async function finishObservedCommand(command: RuntimeGenerationCommand) {
    const existing = observedCommands.get(command.commandId)
    if (!existing || existing.finishing) {
        return
    }
    existing.finishing = true
    try {
        await waitForCompletedRevision(command)
    }
    catch (error) {
        existing.finishing = false
        console.error('[Runtime Generation Revision Barrier]', error)
        setTimeout(() => void finishObservedCommand(command), 1_000)
        return
    }
    existing.stop()
    seenTerminalCommandIds.add(command.commandId)
    observedCommands.delete(command.commandId)
    dismissRuntimeAlertPromptsForCommand(command.commandId)
    publishCommands()
    const selectedCharacter = DBState.db.characters[get(selectedCharID)]
    const selectedChat = selectedCharacter?.chats?.[selectedCharacter.chatPage]
    const isVisibleHere = selectedCharacter?.chaId === command.characterId
        && selectedChat?.id === command.chatId
    if (
        (existing.createdHere || isVisibleHere)
        && (command.state === 'failed' || command.state === 'interrupted')
    ) {
        alertError(
            command.error
                ? `Server generation ${command.state}: ${command.error}`
                : `Server generation ${command.state}. It was not reported as complete.`,
        )
    }
}

function runtimeAlertData(value: unknown): alertData | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    const candidate = value as Record<string, unknown>
    if (typeof candidate.type !== 'string' || typeof candidate.msg !== 'string') {
        return null
    }
    return candidate as unknown as alertData
}

function handleRuntimeUiEvent(commandId: string, eventType: string, payload: Record<string, unknown>) {
    if (eventType === 'cancel_requested') {
        dismissRuntimeAlertPromptsForCommand(commandId)
        return
    }
    if (eventType === 'ui_prompt') {
        const promptId = payload.promptId
        const prompt = runtimeAlertData(payload.prompt)
        if (typeof promptId !== 'string' || !prompt) {
            console.error('[Runtime Generation UI] Malformed UI prompt event')
            return
        }
        void presentRuntimeAlertPrompt({ commandId, promptId, prompt })
            .then(async (response) => {
                if (response === null) {
                    return
                }
                await runtimeClient.respondToUiPrompt(commandId, promptId, response)
                dismissRuntimeAlertPrompt(promptId)
            })
            .catch((error) => console.error('[Runtime Generation UI Response]', error))
        return
    }
    if (eventType === 'ui_prompt_response') {
        if (typeof payload.promptId === 'string') {
            dismissRuntimeAlertPrompt(payload.promptId)
        }
        return
    }
    if (eventType === 'ui_notice') {
        const notice = runtimeAlertData(payload.notice)
        if (notice) {
            void presentRuntimeAlertNotice(notice)
        }
    }
}

function observeCommand(command: RuntimeGenerationCommand, createdHere = false) {
    const existing = observedCommands.get(command.commandId)
    if (existing) {
        existing.command = command
        existing.createdHere ||= createdHere
        publishCommands()
        return
    }
    const entry = {
        command,
        createdHere,
        finishing: false,
        stop: () => {},
    }
    observedCommands.set(command.commandId, entry)
    entry.stop = runtimeClient.watch(command.commandId, {
        onSnapshot: (snapshot) => {
            if (isTerminal(snapshot)) {
                void finishObservedCommand(snapshot)
                return
            }
            entry.command = snapshot
            publishCommands()
        },
        onEvent: (event) => {
            if (event.eventType === 'chat_stage') {
                const stage = event.payload.stage
                if (typeof stage === 'number' && Number.isFinite(stage)) {
                    chatProcessStage.set(stage)
                }
            }
            handleRuntimeUiEvent(command.commandId, event.eventType, event.payload)
        },
        onTerminal: (terminal) => void finishObservedCommand(terminal),
        onError: (error) => console.error('[Runtime Generation Observer]', error),
    })
    publishCommands()
    if (isTerminal(command)) {
        void finishObservedCommand(command)
    }
}

async function discoverCommands() {
    while (!discoveryStopped) {
        try {
            const [running, queued, recent] = await Promise.all([
                runtimeClient.list({ state: 'running' }),
                runtimeClient.list({ state: 'queued' }),
                runtimeClient.list({
                    updatedAfter: terminalDiscoveryWatermark,
                    limit: 100,
                }),
            ])
            for (const command of [...running, ...queued]) {
                observeCommand(command)
            }
            for (const command of recent) {
                terminalDiscoveryWatermark = Math.max(
                    terminalDiscoveryWatermark,
                    command.updatedAt,
                )
                if (isTerminal(command) && !seenTerminalCommandIds.has(command.commandId)) {
                    observeCommand(command)
                }
            }
        }
        catch (error) {
            console.error('[Runtime Generation Discovery]', error)
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000))
    }
}

export function startRuntimeGenerationFollower() {
    if (!shouldDelegateGeneration() || discoveryStarted) {
        return
    }
    discoveryStarted = true
    discoveryStopped = false
    void discoverCommands()
}

export async function queueRuntimeGeneration(
    input: RuntimeGenerationCreateInput,
    signal?: AbortSignal,
) {
    if (!shouldDelegateGeneration()) {
        throw new Error('Runtime generation delegation is not active in this browser')
    }
    startRuntimeGenerationFollower()
    doingChat.set(true)
    try {
        const command = signal
            ? await runtimeClient.create(input, signal)
            : await runtimeClient.create(input)
        observeCommand(command, true)
        return command
    }
    catch (error) {
        publishCommands()
        throw error
    }
}

function isTerminal(command: RuntimeGenerationCommand) {
    return command.state === 'completed'
        || command.state === 'failed'
        || command.state === 'cancelled'
        || command.state === 'interrupted'
}

export function waitForRuntimeGenerationTerminal(
    command: RuntimeGenerationCommand,
    signal?: AbortSignal,
): Promise<RuntimeGenerationCommand> {
    if (isTerminal(command)) {
        return Promise.resolve(command)
    }
    return new Promise((resolve) => {
        let settled = false
        let stop = () => {}
        const finish = (terminal: RuntimeGenerationCommand) => {
            if (settled) {
                return
            }
            settled = true
            signal?.removeEventListener('abort', abort)
            stop()
            resolve(terminal)
        }
        const abort = () => {
            void runtimeClient.cancel(command.commandId)
                .then((cancelled) => {
                    if (isTerminal(cancelled)) {
                        finish(cancelled)
                    }
                })
                .catch((error) => console.error('[Runtime Generation Cancel]', error))
        }
        stop = runtimeClient.watch(command.commandId, {
            onTerminal: finish,
            // Socket errors are transient; RuntimeGenerationClient reconnects
            // from its durable event cursor.
            onError: (error) => console.error('[Runtime Generation Wait]', error),
        })
        if (signal?.aborted) {
            abort()
        }
        else {
            signal?.addEventListener('abort', abort, { once: true })
        }
    })
}

async function delegateUpstreamSendChat(
    waitForPersistence: WaitForPersistence,
    chatProcessIndex: number,
    options: SendChatOptions,
): Promise<boolean | null> {
    if (!shouldDelegateGeneration() || options.preview || options.previewPrompt) {
        return null
    }
    if (options.signal?.aborted) {
        return false
    }
    const character = DBState.db.characters[get(selectedCharID)]
    const chat = character?.chats?.[character.chatPage]
    if (!character || !chat) {
        throw new Error('No active chat is available for resident generation')
    }

    doingChat.set(true)
    try {
        const persisted = await waitForPersistence()
        const command = await queueRuntimeGeneration({
            action: 'generate',
            characterId: character.chaId,
            chatId: chat.id,
            payload: {
                chatProcessIndex,
                chatAdditonalTokens: options.chatAdditonalTokens,
                continue: options.continue,
                usedContinueTokens: options.usedContinueTokens,
                databaseRevision: persisted?.revision ?? null,
            },
        })
        const terminal = await waitForRuntimeGenerationTerminal(command, options.signal)
        await waitForCompletedRevision(terminal)
        if (terminal.state === 'completed') {
            return terminal.result?.generated === true
        }
        if (terminal.state === 'cancelled') {
            return false
        }
        throw new Error(
            terminal.error
                ? `Server generation ${terminal.state}: ${terminal.error}`
                : `Server generation ended as ${terminal.state}`,
        )
    }
    catch (error) {
        doingChat.set(false)
        throw error
    }
}

export function installRuntimeGenerationDelegation(
    waitForPersistence: WaitForPersistence,
) {
    if (!shouldDelegateGeneration() || delegateInstalled) {
        return
    }
    waitForRuntimePersistence = waitForPersistence
    delegateInstalled = true
    setSendChatDelegate((chatProcessIndex, options) =>
        delegateUpstreamSendChat(waitForPersistence, chatProcessIndex, options))
}

export interface RuntimeGenerationTargetFilter {
    characterId?: string
    chatId?: string
}

export function shouldRestoreCancelledRuntimeDraft(command: RuntimeGenerationCommand) {
    return command.state === 'cancelled'
        && shouldRestoreRuntimeDraft(command)
}

export function shouldRestoreRuntimeDraft(command: RuntimeGenerationCommand) {
    return command.result?.canonicalMutationPersisted !== true
}

export async function cancelActiveRuntimeGeneration(
    target: RuntimeGenerationTargetFilter = {},
) {
    const active = [...observedCommands.values()]
        .map((entry) => entry.command)
        .filter((command) => (
            (command.state === 'running' || command.state === 'queued')
            && (!target.characterId || command.characterId === target.characterId)
            && (!target.chatId || command.chatId === target.chatId)
        ))
        .sort((left, right) => {
            if (left.state === right.state) {
                return left.createdAt - right.createdAt
            }
            return left.state === 'running' ? -1 : 1
        })[0]
    if (!active) {
        return null
    }
    const cancelled = await runtimeClient.cancel(active.commandId)
    const existing = observedCommands.get(cancelled.commandId)
    if (existing) {
        existing.command = cancelled
    }
    if (isTerminal(cancelled)) {
        await finishObservedCommand(cancelled)
    }
    else {
        publishCommands()
    }
    return cancelled
}
