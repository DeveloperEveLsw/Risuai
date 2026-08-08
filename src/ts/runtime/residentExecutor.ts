import { get } from 'svelte/store'
import { installRuntimeAlertBridge, type alertData } from '../alert'
import { chatProcessStage } from '../process/index.svelte'
import { isServerResidentExecutor } from '../platform'
import {
    executeCanonicalAuto,
    executeCanonicalGenerate,
    executeCanonicalLuaButton,
    executeCanonicalManualTrigger,
    executeCanonicalReroll,
    executeCanonicalSend,
    executeCanonicalUnreroll,
    type CanonicalGenerationResult,
} from './canonicalGeneration.svelte'
import {
    RuntimeGenerationClient,
    RuntimeGenerationHttpError,
    type RuntimeExecutorLease,
    type RuntimeGenerationCommand,
} from './generationClient'
import {
    clearActiveRuntimeExecutionFence,
    setActiveRuntimeExecutionFence,
} from './executionContext'

export interface ResidentExecutorOptions {
    client?: RuntimeGenerationClient
    executorId?: string
    pollIntervalMs?: number
    leaseDurationMs?: number
    heartbeatIntervalMs?: number
    maxCommandRuntimeMs?: number
    waitForPersistence: (
        timeoutMs?: number,
        minimumRevision?: number,
    ) => Promise<{ revision: number } | null>
    onError?: (error: Error) => void
    onWatchdog?: (command: RuntimeGenerationCommand, error: Error) => void
    reload?: () => void
}

export interface ResidentExecutorHandle {
    stop: () => void
    readonly executorId: string
}

const EXECUTOR_SESSION_KEY = 'risu-resident-executor-id'
const DEFAULT_MAX_COMMAND_RUNTIME_MS = 30 * 60_000
let activeHandle: ResidentExecutorHandle | null = null

function delay(milliseconds: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
        if (signal?.aborted) {
            resolve()
            return
        }
        const timer = setTimeout(resolve, milliseconds)
        signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
        }, { once: true })
    })
}

function executorIdFromSession() {
    const existing = sessionStorage.getItem(EXECUTOR_SESSION_KEY)
    if (existing) {
        return existing
    }
    const created = `resident-${crypto.randomUUID()}`
    sessionStorage.setItem(EXECUTOR_SESSION_KEY, created)
    return created
}

function normalizeFiles(payload: Record<string, unknown>) {
    if (payload.files === undefined) {
        return []
    }
    if (!Array.isArray(payload.files) || !payload.files.every((file) => typeof file === 'string')) {
        throw new TypeError('Generation command files must be an array of asset references')
    }
    return payload.files
}

function optionalBoolean(payload: Record<string, unknown>, key: string) {
    const value = payload[key]
    if (value !== undefined && typeof value !== 'boolean') {
        throw new TypeError(`Generation command ${key} must be a boolean`)
    }
    return value as boolean | undefined
}

function optionalFiniteNumber(payload: Record<string, unknown>, key: string) {
    const value = payload[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new TypeError(`Generation command ${key} must be a finite number`)
    }
    return value as number | undefined
}

async function executeCommand(command: RuntimeGenerationCommand, signal: AbortSignal) {
    const payload = command.payload ?? {}
    const target = {
        characterId: command.characterId,
        chatId: command.chatId,
    }
    switch (command.action) {
        case 'send':
        case 'continue': {
            const messageInput = payload.input
            if (messageInput !== undefined && typeof messageInput !== 'string') {
                throw new TypeError('Generation command input must be a string')
            }
            const normalizedInput = typeof messageInput === 'string' ? messageInput : ''
            return await executeCanonicalSend({
                ...target,
                input: normalizedInput,
                files: normalizeFiles(payload),
                continueResponse: command.action === 'continue',
                signal,
            })
        }
        case 'reroll':
            return await executeCanonicalReroll({ ...target, signal })
        case 'unreroll':
            return executeCanonicalUnreroll(target)
        case 'auto':
            return await executeCanonicalAuto({ ...target, signal })
        case 'generate': {
            const chatProcessIndex = payload.chatProcessIndex ?? -1
            if (!Number.isSafeInteger(chatProcessIndex) || (chatProcessIndex as number) < -1) {
                throw new TypeError('Generation command chatProcessIndex must be an integer of at least -1')
            }
            return await executeCanonicalGenerate({
                ...target,
                chatProcessIndex: chatProcessIndex as number,
                chatAdditonalTokens: optionalFiniteNumber(payload, 'chatAdditonalTokens'),
                continue: optionalBoolean(payload, 'continue'),
                usedContinueTokens: optionalFiniteNumber(payload, 'usedContinueTokens'),
                signal,
            })
        }
        case 'manual-trigger': {
            const manualName = payload.manualName
            const triggerId = payload.triggerId
            if (typeof manualName !== 'string' || manualName === '') {
                throw new TypeError('Manual trigger command requires a non-empty manualName')
            }
            if (triggerId !== undefined && typeof triggerId !== 'string') {
                throw new TypeError('Manual trigger command triggerId must be a string')
            }
            return await executeCanonicalManualTrigger({
                ...target,
                manualName,
                triggerId: typeof triggerId === 'string' ? triggerId : undefined,
            })
        }
        case 'lua-button': {
            const data = payload.data
            if (typeof data !== 'string') {
                throw new TypeError('Lua button command data must be a string')
            }
            return await executeCanonicalLuaButton({ ...target, data })
        }
        default:
            throw new TypeError(`Unsupported generation command action: ${String(command.action)}`)
    }
}

function isFenceRejection(error: unknown) {
    return error instanceof RuntimeGenerationHttpError
        && error.status === 409
        && typeof error.body === 'object'
        && error.body !== null
        && (error.body as { code?: unknown }).code === 'STALE_EXECUTOR_FENCE'
}

function isCancellationStateConflict(error: unknown) {
    return error instanceof RuntimeGenerationHttpError
        && error.status === 409
        && typeof error.body === 'object'
        && error.body !== null
        && (error.body as { code?: unknown }).code === 'INVALID_COMMAND_STATE'
}

export function startResidentGenerationExecutor(options: ResidentExecutorOptions): ResidentExecutorHandle | null {
    if (!isServerResidentExecutor) {
        return null
    }
    if (activeHandle) {
        return activeHandle
    }

    const client = options.client ?? new RuntimeGenerationClient()
    const executorId = options.executorId ?? executorIdFromSession()
    const pollIntervalMs = options.pollIntervalMs ?? 1_000
    const leaseDurationMs = options.leaseDurationMs ?? 20_000
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000
    const maxCommandRuntimeMs = options.maxCommandRuntimeMs ?? DEFAULT_MAX_COMMAND_RUNTIME_MS
    if (!Number.isSafeInteger(maxCommandRuntimeMs) || maxCommandRuntimeMs <= 0) {
        throw new TypeError('maxCommandRuntimeMs must be a positive safe integer')
    }
    const reload = options.reload ?? (() => location.reload())
    const rootAbort = new AbortController()

    const reportError = (error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error))
        options.onError?.(normalized)
        console.error('[Resident Executor]', normalized)
    }

    const runClaimed = async (command: RuntimeGenerationCommand, initialLease: RuntimeExecutorLease) => {
        const commandAbort = new AbortController()
        let cleanupRunResources = () => {}
        const abortFromRoot = () => {
            commandAbort.abort(rootAbort.signal.reason)
            cleanupRunResources()
        }
        rootAbort.signal.addEventListener('abort', abortFromRoot, { once: true })
        let lease = initialLease
        let fenceRejected = false
        let cancelRequested = command.cancelRequestedAt !== null
        let executionStarted = false
        let stoppedHeartbeat = false
        const heartbeatAbort = new AbortController()
        let lastStage = get(chatProcessStage)
        const pendingPromptResponses = new Map<string, {
            resolve: (response: string) => void
            reject: (error: Error) => void
            consuming: boolean
        }>()
        let uninstallAlertBridge = () => {}
        let runtimeAlertsCleaned = false
        const rejectPendingPrompts = (reason: unknown) => {
            if (runtimeAlertsCleaned) {
                return
            }
            runtimeAlertsCleaned = true
            const error = reason instanceof Error
                ? reason
                : new Error(typeof reason === 'string' ? reason : 'Runtime UI prompt was aborted')
            for (const pending of pendingPromptResponses.values()) {
                pending.reject(error)
            }
            pendingPromptResponses.clear()
            uninstallAlertBridge()
        }
        setActiveRuntimeExecutionFence(command.commandId, lease)

        const stopWatching = client.watch(command.commandId, {
            onSnapshot: (snapshot) => {
                if (snapshot.state === 'running' && snapshot.cancelRequestedAt !== null) {
                    cancelRequested = true
                    commandAbort.abort('cancel_requested')
                }
            },
            onEvent: (event) => {
                if (event.eventType === 'ui_prompt_response') {
                    const promptId = event.payload.promptId
                    const pending = typeof promptId === 'string'
                        ? pendingPromptResponses.get(promptId)
                        : null
                    if (pending && !pending.consuming) {
                        pending.consuming = true
                        void client.getUiPromptResponse(
                            command.commandId,
                            promptId as string,
                            lease,
                            commandAbort.signal,
                        )
                            .then(pending.resolve)
                            .catch((error) => {
                                if (isFenceRejection(error)) {
                                    fenceRejected = true
                                    commandAbort.abort('stale executor fence')
                                    return
                                }
                                pending.reject(error instanceof Error ? error : new Error(String(error)))
                            })
                    }
                    return
                }
                if (event.eventType === 'cancel_requested') {
                    cancelRequested = true
                    commandAbort.abort('cancel_requested')
                    return
                }
                if (event.eventType === 'cancelled' || event.eventType === 'interrupted') {
                    fenceRejected = true
                    commandAbort.abort(event.eventType)
                }
            },
            onError: reportError,
        })
        const unsubscribeStage = chatProcessStage.subscribe((stage) => {
            if (stage === lastStage || commandAbort.signal.aborted) {
                return
            }
            lastStage = stage
            void client.progress(command.commandId, lease, 'chat_stage', { stage }).catch((error) => {
                if (isFenceRejection(error)) {
                    fenceRejected = true
                    commandAbort.abort('stale executor fence')
                }
                else {
                    reportError(error)
                }
            })
        })
        uninstallAlertBridge = installRuntimeAlertBridge({
            prompt: async (prompt: alertData) => {
                if (commandAbort.signal.aborted) {
                    throw new Error('Runtime generation was aborted before the UI prompt')
                }
                const promptId = crypto.randomUUID()
                let resolveResponse!: (response: string) => void
                let rejectResponse!: (error: Error) => void
                const responsePromise = new Promise<string>((resolve, reject) => {
                    resolveResponse = resolve
                    rejectResponse = reject
                })
                pendingPromptResponses.set(promptId, {
                    resolve: resolveResponse,
                    reject: rejectResponse,
                    consuming: false,
                })
                try {
                    await client.progress(command.commandId, lease, 'ui_prompt', {
                        promptId,
                        prompt,
                    }, commandAbort.signal)
                    return await responsePromise
                }
                finally {
                    pendingPromptResponses.delete(promptId)
                }
            },
            notice: async (notice: alertData) => {
                if (!commandAbort.signal.aborted) {
                    await client.progress(command.commandId, lease, 'ui_notice', { notice })
                }
            },
        })
        commandAbort.signal.addEventListener(
            'abort',
            () => rejectPendingPrompts(commandAbort.signal.reason),
            { once: true },
        )
        let resourcesCleaned = false
        cleanupRunResources = () => {
            if (resourcesCleaned) {
                return
            }
            resourcesCleaned = true
            stoppedHeartbeat = true
            heartbeatAbort.abort('command resources cleaned')
            rejectPendingPrompts(commandAbort.signal.reason)
            unsubscribeStage()
            stopWatching()
            clearActiveRuntimeExecutionFence(command.commandId, initialLease.fencingToken)
            rootAbort.signal.removeEventListener('abort', abortFromRoot)
        }
        const watchdogError = new Error(
            `Runtime generation exceeded the ${maxCommandRuntimeMs} ms wall-clock limit`,
        )
        let watchdogTermination: Promise<void> | null = null
        const watchdogTimer = setTimeout(() => {
            fenceRejected = true
            commandAbort.abort(watchdogError)
            cleanupRunResources()
            try {
                options.onWatchdog?.(command, watchdogError)
            }
            catch (error) {
                reportError(error)
            }
            let reloaded = false
            const reloadAfterWatchdog = () => {
                if (reloaded) {
                    return
                }
                reloaded = true
                try {
                    reload()
                }
                catch (error) {
                    reportError(error)
                }
            }
            // Mark the command terminal before reloading when the server is
            // reachable, otherwise the same session executor could reclaim
            // its still-live lease and repeat the hung plugin immediately.
            const reloadFallback = setTimeout(reloadAfterWatchdog, 1_000)
            watchdogTermination = client.fail(
                command.commandId,
                lease,
                watchdogError.message,
                { stage: lastStage, reason: 'wall_clock_watchdog' },
            ).catch((error) => {
                if (!isFenceRejection(error)) {
                    reportError(error)
                }
            }).finally(() => {
                clearTimeout(reloadFallback)
                reloadAfterWatchdog()
            }).then(() => {})
        }, maxCommandRuntimeMs)
        const heartbeat = (async () => {
            while (!stoppedHeartbeat) {
                await delay(heartbeatIntervalMs, heartbeatAbort.signal)
                if (stoppedHeartbeat) {
                    break
                }
                try {
                    lease = await client.heartbeat(command.commandId, lease, leaseDurationMs)
                    setActiveRuntimeExecutionFence(command.commandId, lease)
                }
                catch (error) {
                    if (isFenceRejection(error)) {
                        fenceRejected = true
                        commandAbort.abort('stale executor fence')
                        break
                    }
                    reportError(error)
                    if (Date.now() >= lease.expiresAt - 1_000) {
                        fenceRejected = true
                        commandAbort.abort('executor lease expired while offline')
                        break
                    }
                }
            }
        })()

        const requestedRevision = command.payload?.databaseRevision
        const waitForMutationPersistence = async () => {
            const persisted = await options.waitForPersistence()
            if (fenceRejected || rootAbort.signal.aborted) {
                return null
            }
            return persisted
        }
        const completeCancellationAfterPersistence = async (persisted: { revision: number } | null) => {
            if (!persisted || fenceRejected || rootAbort.signal.aborted) {
                return
            }
            lease = await client.heartbeat(command.commandId, lease, leaseDurationMs)
            setActiveRuntimeExecutionFence(command.commandId, lease)
            const canonicalMutationPersisted = executionStarted
                && typeof requestedRevision === 'number'
                && persisted.revision > requestedRevision
            await client.completeCancellation(command.commandId, lease, {
                databaseRevision: persisted.revision,
                canonicalMutationPersisted,
            })
        }
        const finishCancellation = async () => {
            await completeCancellationAfterPersistence(await waitForMutationPersistence())
        }
        const refreshCancellationState = async (error: unknown) => {
            if (!isCancellationStateConflict(error)) {
                return false
            }
            const latest = await client.get(command.commandId)
            if (latest.state !== 'running' || latest.cancelRequestedAt === null) {
                return false
            }
            cancelRequested = true
            commandAbort.abort('cancel_requested')
            return true
        }

        try {
            if (
                requestedRevision !== undefined
                && requestedRevision !== null
                && (!Number.isSafeInteger(requestedRevision) || (requestedRevision as number) < 0)
            ) {
                throw new TypeError('Generation command databaseRevision must be a non-negative integer')
            }
            const persistedBeforeExecution = await options.waitForPersistence(
                60_000,
                typeof requestedRevision === 'number' ? requestedRevision : undefined,
            )
            if (
                typeof requestedRevision === 'number'
                && (persistedBeforeExecution?.revision ?? -1) !== requestedRevision
            ) {
                throw new Error(
                    `Resident database revision ${persistedBeforeExecution?.revision ?? 'none'} `
                    + `does not match command revision ${requestedRevision}`,
                )
            }
            if (cancelRequested) {
                commandAbort.abort('cancel_requested')
                await finishCancellation()
                return
            }
            await client.progress(command.commandId, lease, 'execution_started', {
                databaseRevision: requestedRevision ?? null,
            })
            executionStarted = true
            const result: CanonicalGenerationResult = await executeCommand(command, commandAbort.signal)
            if (cancelRequested) {
                await finishCancellation()
                return
            }
            if (commandAbort.signal.aborted || fenceRejected) {
                return
            }
            const persisted = await options.waitForPersistence()
            if (cancelRequested) {
                await completeCancellationAfterPersistence(persisted)
                return
            }
            if (commandAbort.signal.aborted || fenceRejected) {
                return
            }
            lease = await client.heartbeat(command.commandId, lease, leaseDurationMs)
            setActiveRuntimeExecutionFence(command.commandId, lease)
            await client.complete(command.commandId, lease, {
                ...result,
                databaseRevision: persisted?.revision ?? null,
            })
        }
        catch (error) {
            if (isFenceRejection(error)) {
                fenceRejected = true
                return
            }
            if (!cancelRequested) {
                try {
                    await refreshCancellationState(error)
                }
                catch (refreshError) {
                    reportError(refreshError)
                }
            }
            if (cancelRequested) {
                try {
                    await finishCancellation()
                }
                catch (cancelError) {
                    if (!isFenceRejection(cancelError)) {
                        reportError(cancelError)
                    }
                }
                return
            }
            if (fenceRejected || commandAbort.signal.aborted) {
                return
            }
            try {
                const persisted = await waitForMutationPersistence()
                if (!persisted || fenceRejected || rootAbort.signal.aborted) {
                    return
                }
                if (cancelRequested) {
                    await completeCancellationAfterPersistence(persisted)
                    return
                }
                lease = await client.heartbeat(command.commandId, lease, leaseDurationMs)
                setActiveRuntimeExecutionFence(command.commandId, lease)
                await client.fail(
                    command.commandId,
                    lease,
                    error instanceof Error ? error.message : String(error),
                    {
                        stage: lastStage,
                        databaseRevision: persisted.revision,
                        canonicalMutationPersisted: executionStarted
                            && typeof requestedRevision === 'number'
                            && persisted.revision > requestedRevision,
                    },
                )
            }
            catch (failError) {
                if (isFenceRejection(failError)) {
                    fenceRejected = true
                    return
                }
                try {
                    if (await refreshCancellationState(failError)) {
                        await finishCancellation()
                        return
                    }
                }
                catch (cancelError) {
                    if (!isFenceRejection(cancelError)) {
                        reportError(cancelError)
                    }
                    return
                }
                reportError(failError)
            }
        }
        finally {
            clearTimeout(watchdogTimer)
            commandAbort.abort('command terminal')
            cleanupRunResources()
            await heartbeat
            await watchdogTermination
        }
    }

    const run = async () => {
        while (!rootAbort.signal.aborted) {
            try {
                await options.waitForPersistence()
                break
            }
            catch (error) {
                reportError(error)
                await delay(5_000, rootAbort.signal)
            }
        }
        while (!rootAbort.signal.aborted) {
            try {
                const claimed = await client.claimNext(executorId, leaseDurationMs)
                if (claimed) {
                    await runClaimed(claimed.command, claimed.lease)
                    continue
                }
            }
            catch (error) {
                reportError(error)
            }
            await delay(pollIntervalMs, rootAbort.signal)
        }
    }
    void run()

    activeHandle = {
        executorId,
        stop: () => {
            rootAbort.abort('resident executor stopped')
            activeHandle = null
        },
    }
    return activeHandle
}
