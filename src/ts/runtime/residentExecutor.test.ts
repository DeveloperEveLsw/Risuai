import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
    RuntimeExecutorLease,
    RuntimeGenerationCommand,
    RuntimeGenerationWatchHandlers,
} from './generationClient'
import type { ResidentExecutorHandle } from './residentExecutor'

const mocks = vi.hoisted(() => ({
    executeCanonicalSend: vi.fn(),
    executeCanonicalReroll: vi.fn(),
    executeCanonicalUnreroll: vi.fn(),
    executeCanonicalAuto: vi.fn(),
    executeCanonicalGenerate: vi.fn(),
    executeCanonicalManualTrigger: vi.fn(),
    executeCanonicalLuaButton: vi.fn(),
    setFence: vi.fn(),
    clearFence: vi.fn(),
    alertBridge: null as null | {
        prompt: (data: Record<string, unknown>) => Promise<string>
        notice: (data: Record<string, unknown>) => void | Promise<void>
    },
    alertBridgeCleanup: vi.fn(),
    RuntimeGenerationHttpError: class RuntimeGenerationHttpError extends Error {
        readonly status: number
        readonly body: unknown

        constructor(status: number, body: unknown) {
            super('runtime generation request failed')
            this.status = status
            this.body = body
        }
    },
}))

vi.mock('../platform', () => ({ isServerResidentExecutor: true }))

vi.mock('../alert', () => ({
    installRuntimeAlertBridge: vi.fn((bridge) => {
        mocks.alertBridge = bridge
        return mocks.alertBridgeCleanup
    }),
}))

vi.mock('../process/index.svelte', async () => {
    const { writable } = await import('svelte/store')
    return { chatProcessStage: writable(0) }
})

vi.mock('./canonicalGeneration.svelte', () => ({
    executeCanonicalSend: mocks.executeCanonicalSend,
    executeCanonicalReroll: mocks.executeCanonicalReroll,
    executeCanonicalUnreroll: mocks.executeCanonicalUnreroll,
    executeCanonicalAuto: mocks.executeCanonicalAuto,
    executeCanonicalGenerate: mocks.executeCanonicalGenerate,
    executeCanonicalManualTrigger: mocks.executeCanonicalManualTrigger,
    executeCanonicalLuaButton: mocks.executeCanonicalLuaButton,
}))

vi.mock('./executionContext', () => ({
    setActiveRuntimeExecutionFence: mocks.setFence,
    clearActiveRuntimeExecutionFence: mocks.clearFence,
}))

vi.mock('./generationClient', () => ({
    RuntimeGenerationClient: vi.fn(),
    RuntimeGenerationHttpError: mocks.RuntimeGenerationHttpError,
}))

import { RuntimeGenerationHttpError } from './generationClient'
import { startResidentGenerationExecutor } from './residentExecutor'

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

function command(
    action: RuntimeGenerationCommand['action'],
    payload: Record<string, unknown> = {},
): RuntimeGenerationCommand {
    return {
        commandId: 'command-1',
        requestId: 'request-1',
        action,
        characterId: 'character-1',
        chatId: 'chat-1',
        state: 'running',
        createdAt: 1,
        updatedAt: 1,
        startedAt: 1,
        finishedAt: null,
        interruptedAt: null,
        cancelRequestedAt: null,
        executorId: null,
        fencingToken: null,
        leaseExpiresAt: null,
        result: null,
        error: null,
        lastSequence: 1,
        payload,
    }
}

function lease(overrides: Partial<RuntimeExecutorLease> = {}): RuntimeExecutorLease {
    return {
        executorId: 'resident-1',
        fencingToken: 4,
        expiresAt: Date.now() + 60_000,
        ...overrides,
    }
}

function makeClient(
    claimedCommand: RuntimeGenerationCommand,
    initialLease = lease(),
) {
    const watchHandlers: RuntimeGenerationWatchHandlers[] = []
    const client = {
        claimNext: vi.fn()
            .mockResolvedValueOnce({ command: claimedCommand, lease: initialLease })
            .mockResolvedValue(null),
        watch: vi.fn((_commandId: string, handlers: RuntimeGenerationWatchHandlers) => {
            watchHandlers.push(handlers)
            return vi.fn()
        }),
        progress: vi.fn().mockResolvedValue(undefined),
        getUiPromptResponse: vi.fn().mockResolvedValue('from phone'),
        heartbeat: vi.fn().mockResolvedValue(lease({ fencingToken: 5 })),
        get: vi.fn().mockResolvedValue(claimedCommand),
        complete: vi.fn().mockResolvedValue(undefined),
        completeCancellation: vi.fn().mockResolvedValue(undefined),
        fail: vi.fn().mockResolvedValue(undefined),
    }
    return { client, watchHandlers }
}

let handle: ResidentExecutorHandle | null = null

function start(
    client: ReturnType<typeof makeClient>['client'],
    waitForPersistence: (
        timeoutMs?: number,
        minimumRevision?: number,
    ) => Promise<{ revision: number } | null>,
    overrides: Record<string, unknown> = {},
) {
    handle = startResidentGenerationExecutor({
        client: client as any,
        executorId: 'resident-1',
        pollIntervalMs: 1_000_000,
        leaseDurationMs: 20_000,
        heartbeatIntervalMs: 1_000_000,
        waitForPersistence,
        ...overrides,
    })
    expect(handle).not.toBeNull()
}

describe('resident generation executor', () => {
    beforeEach(() => {
        mocks.executeCanonicalSend.mockReset().mockResolvedValue({
            generated: true,
            previousLength: 1,
            currentLength: 2,
        })
        mocks.executeCanonicalReroll.mockReset().mockResolvedValue({
            generated: true,
            previousLength: 2,
            currentLength: 2,
        })
        mocks.executeCanonicalUnreroll.mockReset().mockReturnValue({
            generated: false,
            previousLength: 2,
            currentLength: 2,
        })
        mocks.executeCanonicalAuto.mockReset().mockResolvedValue({
            generated: true,
            previousLength: 1,
            currentLength: 3,
        })
        mocks.executeCanonicalGenerate.mockReset().mockResolvedValue({
            generated: true,
            previousLength: 1,
            currentLength: 2,
        })
        mocks.executeCanonicalManualTrigger.mockReset().mockResolvedValue({
            generated: false,
            previousLength: 1,
            currentLength: 2,
        })
        mocks.executeCanonicalLuaButton.mockReset().mockResolvedValue({
            generated: false,
            previousLength: 2,
            currentLength: 3,
        })
        mocks.setFence.mockReset()
        mocks.clearFence.mockReset()
        mocks.alertBridge = null
        mocks.alertBridgeCleanup.mockReset()
    })

    afterEach(() => {
        handle?.stop()
        handle = null
    })

    it('adopts the requested database revision before execution and completes only after persistence', async () => {
        const requestedRevision = deferred<{ revision: number } | null>()
        const persistedResult = deferred<{ revision: number } | null>()
        let persistenceCall = 0
        const waitForPersistence = vi.fn(() => {
            persistenceCall += 1
            if (persistenceCall === 1) {
                return Promise.resolve({ revision: 5 })
            }
            if (persistenceCall === 2) {
                return requestedRevision.promise
            }
            return persistedResult.promise
        })
        const claimed = command('send', {
            input: 'hello',
            files: ['asset.png'],
            databaseRevision: 7,
        })
        const { client } = makeClient(claimed)

        start(client, waitForPersistence)
        await vi.waitFor(() => expect(waitForPersistence).toHaveBeenCalledTimes(2))

        expect(waitForPersistence).toHaveBeenNthCalledWith(2, 60_000, 7)
        expect(mocks.executeCanonicalSend).not.toHaveBeenCalled()
        requestedRevision.resolve({ revision: 7 })

        await vi.waitFor(() => expect(mocks.executeCanonicalSend).toHaveBeenCalledOnce())
        expect(client.progress).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 4 }),
            'execution_started',
            { databaseRevision: 7 },
        )
        expect(client.progress.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.executeCanonicalSend.mock.invocationCallOrder[0],
        )
        expect(client.complete).not.toHaveBeenCalled()

        persistedResult.resolve({ revision: 8 })
        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())

        expect(client.heartbeat).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 4 }),
            20_000,
        )
        expect(client.complete).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 5 }),
            {
                generated: true,
                previousLength: 1,
                currentLength: 2,
                databaseRevision: 8,
            },
        )
        expect(mocks.setFence).toHaveBeenLastCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 5 }),
        )
    })

    it('keeps the fence until cancellation persistence completes, then records cancelled', async () => {
        const execution = deferred<{ generated: boolean, previousLength: number, currentLength: number }>()
        const cancellationPersistence = deferred<{ revision: number } | null>()
        mocks.executeCanonicalSend.mockReturnValue(execution.promise)
        let persistenceCall = 0
        const waitForPersistence = vi.fn(() => {
            persistenceCall += 1
            return persistenceCall <= 2
                ? Promise.resolve({ revision: 4 })
                : cancellationPersistence.promise
        })
        const { client, watchHandlers } = makeClient(command('send', {
            input: 'hello',
            databaseRevision: 4,
        }))

        start(client, waitForPersistence)
        await vi.waitFor(() => expect(mocks.executeCanonicalSend).toHaveBeenCalledOnce())
        expect(watchHandlers).toHaveLength(1)
        const executionSignal = mocks.executeCanonicalSend.mock.calls[0][0].signal as AbortSignal

        watchHandlers[0].onEvent?.({
            type: 'generation_event',
            commandId: 'command-1',
            sequence: 3,
            eventType: 'cancel_requested',
            timestamp: Date.now(),
            payload: { reason: 'user_cancel' },
        })
        expect(executionSignal.aborted).toBe(true)
        execution.resolve({ generated: true, previousLength: 1, currentLength: 2 })

        await vi.waitFor(() => expect(waitForPersistence).toHaveBeenCalledTimes(3))
        expect(client.completeCancellation).not.toHaveBeenCalled()
        expect(client.complete).not.toHaveBeenCalled()
        expect(client.fail).not.toHaveBeenCalled()

        cancellationPersistence.resolve({ revision: 5 })
        await vi.waitFor(() => expect(client.completeCancellation).toHaveBeenCalledOnce())
        expect(client.completeCancellation).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 5 }),
            {
                databaseRevision: 5,
                canonicalMutationPersisted: true,
            },
        )
        expect(client.heartbeat.mock.invocationCallOrder[0]).toBeLessThan(
            client.completeCancellation.mock.invocationCallOrder[0],
        )
    })

    it('marks a cancellation before executeCommand as having no canonical mutation', async () => {
        const claimed = command('send', {
            input: 'restore this draft',
            databaseRevision: 7,
        })
        claimed.cancelRequestedAt = 2
        const waitForPersistence = vi.fn()
            .mockResolvedValueOnce({ revision: 7 })
            .mockResolvedValueOnce({ revision: 7 })
            // Even if the observed head is later, work that never entered
            // executeCommand cannot claim another mutation as its own.
            .mockResolvedValueOnce({ revision: 8 })
        const { client } = makeClient(claimed)

        start(client, waitForPersistence)
        await vi.waitFor(() => expect(client.completeCancellation).toHaveBeenCalledOnce())

        expect(mocks.executeCanonicalSend).not.toHaveBeenCalled()
        expect(client.completeCancellation).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 5 }),
            {
                databaseRevision: 8,
                canonicalMutationPersisted: false,
            },
        )
    })

    it('waits for the user-message mutation to persist before reporting execution failure', async () => {
        const failurePersistence = deferred<{ revision: number } | null>()
        mocks.executeCanonicalSend.mockRejectedValue(new Error('provider failed'))
        let persistenceCall = 0
        const waitForPersistence = vi.fn(() => {
            persistenceCall += 1
            return persistenceCall <= 2
                ? Promise.resolve({ revision: 7 })
                : failurePersistence.promise
        })
        const { client } = makeClient(command('send', {
            input: 'keep this user message',
            databaseRevision: 7,
        }))

        start(client, waitForPersistence)
        await vi.waitFor(() => expect(waitForPersistence).toHaveBeenCalledTimes(3))
        expect(client.fail).not.toHaveBeenCalled()

        failurePersistence.resolve({ revision: 8 })
        await vi.waitFor(() => expect(client.fail).toHaveBeenCalledOnce())
        expect(client.fail).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 5 }),
            'provider failed',
            {
                stage: 0,
                databaseRevision: 8,
                canonicalMutationPersisted: true,
            },
        )
        expect(client.heartbeat.mock.invocationCallOrder[0]).toBeLessThan(
            client.fail.mock.invocationCallOrder[0],
        )
    })

    it('does not execute or complete after the server rejects the executor fence', async () => {
        const { client } = makeClient(command('send', { input: 'hello' }))
        client.progress.mockRejectedValueOnce(new RuntimeGenerationHttpError(409, {
            code: 'STALE_EXECUTOR_FENCE',
            error: 'stale executor fence',
        }))

        start(client, vi.fn(async () => ({ revision: 4 })))

        await vi.waitFor(() => expect(client.claimNext).toHaveBeenCalledTimes(2))
        expect(mocks.executeCanonicalSend).not.toHaveBeenCalled()
        expect(client.complete).not.toHaveBeenCalled()
        expect(client.fail).not.toHaveBeenCalled()
    })

    it('fails a stale command instead of running it against a newer chat revision', async () => {
        const { client } = makeClient(command('send', {
            input: 'message from the older device snapshot',
            databaseRevision: 7,
        }))

        start(client, vi.fn(async () => ({ revision: 8 })))

        await vi.waitFor(() => expect(client.fail).toHaveBeenCalledOnce())
        expect(mocks.executeCanonicalSend).not.toHaveBeenCalled()
        expect(client.complete).not.toHaveBeenCalled()
        expect(client.fail).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 5 }),
            'Resident database revision 8 does not match command revision 7',
            {
                stage: 0,
                databaseRevision: 8,
                canonicalMutationPersisted: false,
            },
        )
    })

    it('dispatches unreroll through the canonical resident implementation', async () => {
        const { client } = makeClient(command('unreroll'))

        start(client, vi.fn(async () => ({ revision: 11 })))
        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())

        expect(mocks.executeCanonicalUnreroll).toHaveBeenCalledWith({
            characterId: 'character-1',
            chatId: 'chat-1',
        })
        expect(mocks.executeCanonicalSend).not.toHaveBeenCalled()
        expect(client.complete).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 5 }),
            expect.objectContaining({ generated: false, databaseRevision: 11 }),
        )
    })

    it('dispatches manual trigger identity through the fenced resident command', async () => {
        const { client } = makeClient(command('manual-trigger', {
            databaseRevision: 12,
            manualName: 'community-action',
            triggerId: 'trigger-7',
        }))

        start(client, vi.fn(async () => ({ revision: 12 })))
        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())

        expect(mocks.executeCanonicalManualTrigger).toHaveBeenCalledWith({
            characterId: 'character-1',
            chatId: 'chat-1',
            manualName: 'community-action',
            triggerId: 'trigger-7',
        })
        expect(client.progress).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 4 }),
            'execution_started',
            { databaseRevision: 12 },
        )
    })

    it('dispatches an opaque Lua button payload through the resident command', async () => {
        const { client } = makeClient(command('lua-button', {
            databaseRevision: 13,
            data: 'community-button-payload',
        }))

        start(client, vi.fn(async () => ({ revision: 13 })))
        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())

        expect(mocks.executeCanonicalLuaButton).toHaveBeenCalledWith({
            characterId: 'character-1',
            chatId: 'chat-1',
            data: 'community-button-payload',
        })
        expect(client.complete).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 5 }),
            expect.objectContaining({
                generated: false,
                previousLength: 2,
                currentLength: 3,
                databaseRevision: 13,
            }),
        )
    })

    it('relays a blocking alert and resumes canonical execution with the observer response', async () => {
        let received = ''
        mocks.executeCanonicalSend.mockImplementation(async () => {
            received = await mocks.alertBridge!.prompt({
                type: 'input',
                msg: 'Plugin input',
                defaultValue: 'seed',
            })
            return { generated: true, previousLength: 1, currentLength: 2 }
        })
        const { client, watchHandlers } = makeClient(command('send', { input: 'hello' }))

        start(client, vi.fn(async () => ({ revision: 4 })))
        await vi.waitFor(() => {
            expect(client.progress).toHaveBeenCalledWith(
                'command-1',
                expect.objectContaining({ fencingToken: 4 }),
                'ui_prompt',
                expect.objectContaining({
                    promptId: expect.any(String),
                    prompt: { type: 'input', msg: 'Plugin input', defaultValue: 'seed' },
                }),
                expect.any(AbortSignal),
            )
        })
        const promptCall = client.progress.mock.calls.find((call) => call[2] === 'ui_prompt')
        const promptId = (promptCall?.[3] as { promptId: string }).promptId
        watchHandlers[0].onEvent?.({
            type: 'generation_event',
            commandId: 'command-1',
            sequence: 4,
            eventType: 'ui_prompt_response',
            timestamp: Date.now(),
            payload: { promptId, responded: true },
        })

        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())
        expect(client.getUiPromptResponse).toHaveBeenCalledWith(
            'command-1',
            promptId,
            expect.objectContaining({ fencingToken: 4 }),
            expect.any(AbortSignal),
        )
        expect(received).toBe('from phone')
        expect(mocks.alertBridgeCleanup).toHaveBeenCalledOnce()
    })

    it('reloads after the wall watchdog even when canonical code ignores AbortSignal forever', async () => {
        vi.useFakeTimers()
        try {
            let promptRejection: unknown = null
            mocks.executeCanonicalSend.mockImplementation(async () => {
                try {
                    await mocks.alertBridge!.prompt({ type: 'ask', msg: 'Never answered' })
                }
                catch (error) {
                    promptRejection = error
                }
                return await new Promise(() => {})
            })
            const { client } = makeClient(command('send', { input: 'hang' }))
            const onWatchdog = vi.fn()
            const reload = vi.fn()

            start(
                client,
                vi.fn(async () => ({ revision: 4 })),
                { maxCommandRuntimeMs: 100, onWatchdog, reload },
            )
            await vi.advanceTimersByTimeAsync(0)
            expect(mocks.executeCanonicalSend).toHaveBeenCalledOnce()
            const executionSignal = mocks.executeCanonicalSend.mock.calls[0][0].signal as AbortSignal
            expect(executionSignal.aborted).toBe(false)

            await vi.advanceTimersByTimeAsync(100)
            expect(executionSignal.aborted).toBe(true)
            expect(promptRejection).toEqual(expect.objectContaining({
                message: expect.stringContaining('wall-clock limit'),
            }))
            expect(onWatchdog).toHaveBeenCalledWith(
                expect.objectContaining({ commandId: 'command-1' }),
                expect.objectContaining({ message: expect.stringContaining('wall-clock limit') }),
            )
            expect(reload).toHaveBeenCalledOnce()
            expect(mocks.alertBridgeCleanup).toHaveBeenCalledOnce()
            expect(client.complete).not.toHaveBeenCalled()
            expect(client.fail).toHaveBeenCalledWith(
                'command-1',
                expect.objectContaining({ fencingToken: 4 }),
                expect.stringContaining('wall-clock limit'),
                { stage: 0, reason: 'wall_clock_watchdog' },
            )
        }
        finally {
            vi.useRealTimers()
        }
    })
})
