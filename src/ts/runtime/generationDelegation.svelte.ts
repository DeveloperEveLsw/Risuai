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
    canonicalInputCommitFromEvent,
    RuntimeGenerationClient,
    type RuntimeCanonicalInputCommit,
    type RuntimeGenerationCommand,
    type RuntimeGenerationCreateInput,
} from './generationClient'
import {
    ensureRuntimeChatPresentationOverlay,
    markRuntimeChatOverlayCanonical,
    removeRuntimeChatPresentationOverlay,
    resolveRuntimeChatPresentationText,
    settleRuntimeChatOverlay,
} from './chatPresentationOverlay.svelte'

const runtimeClient = new RuntimeGenerationClient()
interface ObservedRuntimeCommand {
    command: RuntimeGenerationCommand
    stop: () => void
    createdHere: boolean
    finishing: boolean
    inputCommit: RuntimeCanonicalInputCommit | null
    inputCommitAppliedRevision: number | null
    inputCommitApplying: Promise<void> | null
    terminalWaiters: Set<(command: RuntimeGenerationCommand) => void>
}
const observedCommands = new Map<string, ObservedRuntimeCommand>()
const cancellationRequests = new Map<string, Promise<RuntimeGenerationCommand>>()
let discoveryStarted = false
let discoveryStopped = false
let delegateInstalled = false
type WaitForPersistence = (
    timeoutMs?: number,
    minimumRevision?: number,
) => Promise<{ revision: number } | null>
let waitForRuntimePersistence: WaitForPersistence | null = null
const seenTerminalCommandIds = new Set<string>()
const resolvedTerminalCommands = new Map<string, RuntimeGenerationCommand>()
let terminalDiscoveryWatermark = Date.now() - 10 * 60_000
const INTERRUPTED_CANONICAL_INPUT_GRACE_MS = 10_000
const RESOLVED_TERMINAL_COMMAND_LIMIT = 256

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

function preserveCommandPayload(
    command: RuntimeGenerationCommand,
    previous: RuntimeGenerationCommand,
) {
    if (command.payload !== undefined || previous.payload === undefined) {
        return command
    }
    return {
        ...command,
        payload: previous.payload,
    }
}

async function waitForInterruptedCanonicalInput(command: RuntimeGenerationCommand) {
    if (
        command.state !== 'interrupted'
        || (command.action !== 'send' && command.action !== 'continue')
        || (
            command.result?.databaseRevision !== undefined
            && command.result?.databaseRevision !== null
        )
        || !waitForRuntimePersistence
    ) {
        return null
    }
    const baseRevision = command.payload?.databaseRevision
    if (!Number.isSafeInteger(baseRevision) || (baseRevision as number) < 0) {
        return null
    }
    const hasCanonicalInput = () => {
        const character = DBState.db.characters.find(
            (candidate) => candidate.chaId === command.characterId,
        )
        const chat = character?.chats.find((candidate) => candidate.id === command.chatId)
        return chat?.message.some((message) => message.chatId === command.requestId) === true
    }
    try {
        const deadline = Date.now() + INTERRUPTED_CANONICAL_INPUT_GRACE_MS
        let remainingMs = INTERRUPTED_CANONICAL_INPUT_GRACE_MS
        let minimumRevision = (baseRevision as number) + 1
        while (remainingMs > 0) {
            const persisted = await waitForRuntimePersistence(remainingMs, minimumRevision)
            if ((persisted?.revision ?? -1) < minimumRevision) {
                return null
            }
            if (hasCanonicalInput()) {
                return persisted
            }
            if (persisted!.revision >= Number.MAX_SAFE_INTEGER) {
                return null
            }
            minimumRevision = persisted!.revision + 1
            remainingMs = deadline - Date.now()
        }
        return null
    }
    catch (error) {
        // An interrupted lease may have ended before canonical input was
        // appended. Give an already-committed snapshot a bounded adoption
        // window, then let the caller restore the still-uncommitted draft.
        console.warn('[Runtime Generation Interrupted Input Grace]', error)
        return null
    }
}

async function waitForCompletedRevision(command: RuntimeGenerationCommand) {
    if (
        command.state !== 'completed'
        && command.state !== 'failed'
        && command.state !== 'cancelled'
        && command.state !== 'interrupted'
    ) {
        return null
    }
    const revision = completedDatabaseRevision(command)
    if (revision === null || !waitForRuntimePersistence) {
        return null
    }
    const persisted = await waitForRuntimePersistence(60_000, revision)
    if ((persisted?.revision ?? -1) < revision) {
        throw new Error(
            `Client database revision ${persisted?.revision ?? 'none'} is behind completed revision ${revision}`,
        )
    }
    return persisted
}

function reconcileCanonicalInput(entry: ObservedRuntimeCommand) {
    const commit = entry.inputCommit
    if (!commit || entry.inputCommitAppliedRevision === commit.databaseRevision) {
        return Promise.resolve()
    }
    if (entry.inputCommitApplying) {
        return entry.inputCommitApplying
    }
    const applying = (async () => {
        if (!waitForRuntimePersistence) {
            throw new Error('Runtime generation delegation has not been installed')
        }
        const persisted = await waitForRuntimePersistence(60_000, commit.databaseRevision)
        if ((persisted?.revision ?? -1) < commit.databaseRevision) {
            throw new Error(
                `Client database revision ${persisted?.revision ?? 'none'} is behind canonical input `
                + `revision ${commit.databaseRevision}`,
            )
        }
        const character = DBState.db.characters.find(
            (candidate) => candidate.chaId === entry.command.characterId,
        )
        const chat = character?.chats.find((candidate) => candidate.id === entry.command.chatId)
        const indexedMessage = chat?.message[commit.messageIndex]
        const referencedMessage = indexedMessage?.chatId === commit.messageId
            ? indexedMessage
            : chat?.message.find((message) => message.chatId === commit.messageId)
        if (!referencedMessage && persisted.revision === commit.databaseRevision) {
            throw new Error(
                'Canonical input message reference does not match the adopted database revision',
            )
        }
        markRuntimeChatOverlayCanonical(entry.command.commandId, {
            requestId: entry.command.requestId,
            canonicalRevision: commit.databaseRevision,
            messageId: commit.messageId,
        })
        entry.inputCommitAppliedRevision = commit.databaseRevision
    })()
    entry.inputCommitApplying = applying
    void applying.finally(() => {
        if (entry.inputCommitApplying === applying) {
            entry.inputCommitApplying = null
        }
    }).catch(() => {})
    return applying
}

function observeCanonicalInputCommit(
    entry: ObservedRuntimeCommand,
    commit: RuntimeCanonicalInputCommit,
) {
    const existing = entry.inputCommit
    if (existing && (
        existing.databaseRevision !== commit.databaseRevision
        || existing.messageIndex !== commit.messageIndex
        || existing.messageId !== commit.messageId
    )) {
        throw new Error('Runtime generation emitted conflicting input_committed events')
    }
    entry.inputCommit = commit
    void reconcileCanonicalInput(entry).catch((error) => {
        console.error('[Runtime Generation Input Revision Barrier]', error)
    })
}

async function reconcileDeterministicCanonicalInput(
    entry: ObservedRuntimeCommand,
    adoptedTerminal: { revision: number } | null,
) {
    if (
        entry.inputCommitAppliedRevision !== null
        || (entry.command.action !== 'send' && entry.command.action !== 'continue')
        || !waitForRuntimePersistence
    ) {
        return
    }
    if (!adoptedTerminal) {
        return
    }
    const character = DBState.db.characters.find(
        (candidate) => candidate.chaId === entry.command.characterId,
    )
    const chat = character?.chats.find((candidate) => candidate.id === entry.command.chatId)
    if (!chat?.message.some((message) => message.chatId === entry.command.requestId)) {
        return
    }
    markRuntimeChatOverlayCanonical(entry.command.commandId, {
        requestId: entry.command.requestId,
        canonicalRevision: adoptedTerminal.revision,
        messageId: entry.command.requestId,
    })
    entry.inputCommitAppliedRevision = adoptedTerminal.revision
}

async function finishObservedCommand(command: RuntimeGenerationCommand) {
    const existing = observedCommands.get(command.commandId)
    if (!existing || existing.finishing) {
        return
    }
    command = preserveCommandPayload(command, existing.command)
    existing.command = command
    existing.finishing = true
    try {
        await reconcileCanonicalInput(existing)
        const adoptedTerminal = await waitForCompletedRevision(command)
            ?? await waitForInterruptedCanonicalInput(command)
        await reconcileDeterministicCanonicalInput(existing, adoptedTerminal)
    }
    catch (error) {
        existing.finishing = false
        console.error('[Runtime Generation Revision Barrier]', error)
        setTimeout(() => void finishObservedCommand(command), 1_000)
        return
    }
    const terminalRevision = completedDatabaseRevision(command)
    const canonicalMutationPersisted = typeof command.result?.canonicalMutationPersisted === 'boolean'
        ? command.result.canonicalMutationPersisted
        : null
    settleRuntimeChatOverlay(command.commandId, {
        requestId: command.requestId,
        state: command.state,
        terminalRevision,
        canonicalMutationPersisted,
    })
    removeRuntimeChatPresentationOverlay(command.commandId)
    removeRuntimeChatPresentationOverlay(command.requestId)
    resolvedTerminalCommands.set(command.commandId, command)
    while (resolvedTerminalCommands.size > RESOLVED_TERMINAL_COMMAND_LIMIT) {
        const oldestCommandId = resolvedTerminalCommands.keys().next().value
        if (oldestCommandId === undefined) {
            break
        }
        resolvedTerminalCommands.delete(oldestCommandId)
    }
    for (const resolveTerminal of existing.terminalWaiters) {
        resolveTerminal(command)
    }
    existing.terminalWaiters.clear()
    existing.stop()
    seenTerminalCommandIds.add(command.commandId)
    observedCommands.delete(command.commandId)
    cancellationRequests.delete(command.commandId)
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
    if (
        (command.state === 'queued' || command.state === 'running')
        && (command.action === 'send' || command.action === 'continue')
        && command.payload
    ) {
        const baseRevision = command.payload.databaseRevision
        const rawInput = command.payload.input
        const rawFiles = command.payload.files
        if (
            Number.isSafeInteger(baseRevision)
            && (baseRevision as number) >= 0
            && (rawInput === undefined || typeof rawInput === 'string')
            && (rawFiles === undefined || (
                Array.isArray(rawFiles)
                && rawFiles.every((file) => typeof file === 'string')
            ))
        ) {
            const character = DBState.db.characters.find(
                (candidate) => candidate.chaId === command.characterId,
            )
            const chat = character?.chats.find((candidate) => candidate.id === command.chatId)
            const input = typeof rawInput === 'string' ? rawInput : ''
            const files = Array.isArray(rawFiles) ? rawFiles as string[] : []
            ensureRuntimeChatPresentationOverlay({
                requestId: command.requestId,
                commandId: command.commandId,
                characterId: command.characterId,
                chatId: command.chatId,
                input,
                files,
                displayText: resolveRuntimeChatPresentationText({
                    input,
                    files,
                    useSayNothing: DBState.db.useSayNothing,
                    isGroup: character?.type === 'group',
                    lastRole: chat?.message.at(-1)?.role,
                    continueResponse: command.action === 'continue',
                }),
                createdAt: command.createdAt,
                baseRevision: baseRevision as number,
                state: command.state,
            })
        }
    }
    const existing = observedCommands.get(command.commandId)
    if (existing) {
        existing.command = preserveCommandPayload(command, existing.command)
        existing.createdHere ||= createdHere
        if (!isTerminal(command)) {
            publishCommands()
        }
        return
    }
    const entry: ObservedRuntimeCommand = {
        command,
        createdHere,
        finishing: false,
        stop: () => {},
        inputCommit: null,
        inputCommitAppliedRevision: null,
        inputCommitApplying: null,
        terminalWaiters: new Set(),
    }
    observedCommands.set(command.commandId, entry)
    entry.stop = runtimeClient.watch(command.commandId, {
        onSnapshot: (snapshot) => {
            entry.command = preserveCommandPayload(snapshot, entry.command)
            if (isTerminal(snapshot)) {
                return
            }
            publishCommands()
        },
        onEvent: (event) => {
            try {
                const inputCommit = canonicalInputCommitFromEvent(event)
                if (inputCommit) {
                    observeCanonicalInputCommit(entry, inputCommit)
                }
            }
            catch (error) {
                console.error('[Runtime Generation Input Commit]', error)
            }
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
    if (!isTerminal(command)) {
        publishCommands()
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
            for (const discovered of [...running, ...queued]) {
                const command = (
                    !observedCommands.has(discovered.commandId)
                    &&
                    (discovered.action === 'send' || discovered.action === 'continue')
                    && !discovered.payload
                )
                    ? await runtimeClient.get(discovered.commandId)
                    : discovered
                observeCommand(command)
            }
            for (const discovered of recent) {
                const command = (
                    !observedCommands.has(discovered.commandId)
                    && (discovered.action === 'send' || discovered.action === 'continue')
                    && !discovered.payload
                )
                    ? await runtimeClient.get(discovered.commandId)
                    : discovered
                terminalDiscoveryWatermark = Math.max(
                    terminalDiscoveryWatermark,
                    command.updatedAt,
                )
                if (isTerminal(command) && !seenTerminalCommandIds.has(command.commandId)) {
                    observeCommand(command)
                    // HTTP discovery is the durable fallback when the socket
                    // cannot deliver its replay/terminal callback. The
                    // finishing guard makes a concurrent socket terminal
                    // idempotent, while finishObservedCommand still enforces
                    // canonical input and terminal revision barriers.
                    void finishObservedCommand(command)
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

export type RuntimeChatInteractionInput = RuntimeGenerationTargetFilter & {
    characterId: string
    chatId: string
} & (
    | { action: 'manual-trigger', manualName: string, triggerId?: string }
    | { action: 'lua-button', data: string }
)

/** Delegate an interaction originating from rendered chat HTML. The complete
 * trigger/Lua callback runs under the resident command fence, including any
 * low-level LLM calls and the resulting canonical chat mutation. */
export async function delegateRuntimeChatInteraction(
    input: RuntimeChatInteractionInput,
): Promise<boolean | null> {
    if (!shouldDelegateGeneration()) {
        return null
    }
    if (!waitForRuntimePersistence) {
        throw new Error('Runtime generation delegation has not been installed')
    }

    const persisted = await waitForRuntimePersistence()
    const payload: Record<string, unknown> = {
        databaseRevision: persisted?.revision ?? null,
    }
    if (input.action === 'manual-trigger') {
        payload.manualName = input.manualName
        if (input.triggerId !== undefined) {
            payload.triggerId = input.triggerId
        }
    }
    else {
        payload.data = input.data
    }

    const command = await queueRuntimeGeneration({
        action: input.action,
        characterId: input.characterId,
        chatId: input.chatId,
        payload,
    })
    const terminal = await waitForRuntimeGenerationTerminal(command)
    await waitForCompletedRevision(terminal)
    if (terminal.state === 'completed') {
        return true
    }
    if (terminal.state === 'cancelled') {
        return false
    }
    throw new Error(
        terminal.error
            ? `Server chat interaction ${terminal.state}: ${terminal.error}`
            : `Server chat interaction ended as ${terminal.state}`,
    )
}

function isTerminal(command: RuntimeGenerationCommand) {
    return command.state === 'completed'
        || command.state === 'failed'
        || command.state === 'cancelled'
        || command.state === 'interrupted'
}

function requestRuntimeGenerationCancellation(commandId: string) {
    const existing = cancellationRequests.get(commandId)
    if (existing) {
        return existing
    }
    const pending = runtimeClient.cancel(commandId)
    cancellationRequests.set(commandId, pending)
    void pending.catch(() => {
        if (cancellationRequests.get(commandId) === pending) {
            cancellationRequests.delete(commandId)
        }
    })
    return pending
}

export function waitForRuntimeGenerationTerminal(
    command: RuntimeGenerationCommand,
    signal?: AbortSignal,
): Promise<RuntimeGenerationCommand> {
    const observed = observedCommands.get(command.commandId)
    if (observed) {
        return new Promise((resolve) => {
            let settled = false
            const finish = (terminal: RuntimeGenerationCommand) => {
                if (settled) {
                    return
                }
                settled = true
                signal?.removeEventListener('abort', abort)
                observed.terminalWaiters.delete(finish)
                resolve(preserveCommandPayload(terminal, command))
            }
            const abort = () => {
                if (observed.command.cancelRequestedAt !== null) {
                    return
                }
                void requestRuntimeGenerationCancellation(command.commandId)
                    .then((cancelled) => {
                        observed.command = preserveCommandPayload(cancelled, observed.command)
                        if (isTerminal(cancelled)) {
                            void finishObservedCommand(cancelled)
                        }
                        else {
                            publishCommands()
                        }
                    })
                    .catch((error) => console.error('[Runtime Generation Cancel]', error))
            }
            observed.terminalWaiters.add(finish)
            if (isTerminal(observed.command)) {
                void finishObservedCommand(observed.command)
            }
            else if (signal?.aborted) {
                abort()
            }
            else {
                signal?.addEventListener('abort', abort, { once: true })
            }
        })
    }
    const resolvedTerminal = resolvedTerminalCommands.get(command.commandId)
    if (resolvedTerminal) {
        return Promise.resolve(preserveCommandPayload(resolvedTerminal, command))
    }
    if (isTerminal(command)) {
        return waitForInterruptedCanonicalInput(command).then(() => command)
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
            const merged = preserveCommandPayload(terminal, command)
            void waitForInterruptedCanonicalInput(merged).then(() => resolve(merged))
        }
        const abort = () => {
            if (command.cancelRequestedAt !== null) {
                return
            }
            void requestRuntimeGenerationCancellation(command.commandId)
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
    if (command.action === 'send' || command.action === 'continue') {
        const character = DBState.db.characters.find(
            (candidate) => candidate.chaId === command.characterId,
        )
        const chat = character?.chats.find((candidate) => candidate.id === command.chatId)
        if (chat?.message.some((message) => message.chatId === command.requestId)) {
            return false
        }
    }
    return command.state !== 'completed'
        && command.result?.canonicalMutationPersisted !== true
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
    if (active.cancelRequestedAt !== null) {
        return active
    }
    const cancelled = await requestRuntimeGenerationCancellation(active.commandId)
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
