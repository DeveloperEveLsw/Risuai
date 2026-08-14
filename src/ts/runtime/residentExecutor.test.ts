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
    executeCanonicalSuggestion: vi.fn(),
    setFence: vi.fn(),
    clearFence: vi.fn(),
    alertBridge: null as null | {
        prompt: (data: Record<string, unknown>) => Promise<string>
        notice: (data: Record<string, unknown>) => void | Promise<void>
    },
    alertBridgeCleanup: vi.fn(),
    ttsBridge: null as null | ((action: {
        type: 'speak'
        characterId: string
        text: string
    }) => Promise<void> | void),
    ttsBridgeCleanup: vi.fn(),
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

vi.mock('../process/tts', () => ({
    installRuntimeTTSBridge: vi.fn((bridge) => {
        mocks.ttsBridge = bridge
        return mocks.ttsBridgeCleanup
    }),
}))

vi.mock('./canonicalGeneration.svelte', () => ({
    executeCanonicalSend: mocks.executeCanonicalSend,
    executeCanonicalReroll: mocks.executeCanonicalReroll,
    executeCanonicalUnreroll: mocks.executeCanonicalUnreroll,
    executeCanonicalAuto: mocks.executeCanonicalAuto,
    executeCanonicalGenerate: mocks.executeCanonicalGenerate,
    executeCanonicalManualTrigger: mocks.executeCanonicalManualTrigger,
    executeCanonicalLuaButton: mocks.executeCanonicalLuaButton,
    executeCanonicalSuggestion: mocks.executeCanonicalSuggestion,
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
import { emitRuntimeStreamingOutput } from './runtimeStreamingOutput.svelte'

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

function emitMessageOutput(
    messageId: string,
    messageIndex: number,
    data: string,
    optimizationMode: 'off' | 'balanced' | 'strong' = 'balanced',
) {
    emitRuntimeStreamingOutput({
        messageId,
        messageIndex,
        data,
        createdAt: 123,
        generationInfo: { generationId: messageId },
        optimizationMode,
    })
}

function emitOutput(data: string, optimizationMode: 'off' | 'balanced' | 'strong' = 'balanced') {
    emitMessageOutput('generation-1', 2, data, optimizationMode)
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
        publishOutput: vi.fn().mockResolvedValue(undefined),
        publishPresentationAction: vi.fn().mockResolvedValue({ accepted: true, reused: false }),
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
        mocks.executeCanonicalSuggestion.mockReset().mockResolvedValue({
            generated: false,
            suggestionsUpdated: true,
            suggestionCount: 2,
            previousLength: 2,
            currentLength: 2,
        })
        mocks.setFence.mockReset()
        mocks.clearFence.mockReset()
        mocks.alertBridge = null
        mocks.alertBridgeCleanup.mockReset()
        mocks.ttsBridge = null
        mocks.ttsBridgeCleanup.mockReset()
    })

    afterEach(() => {
        handle?.stop()
        handle = null
    })

    it('adopts the requested database revision before execution and completes only after persistence', async () => {
        const requestedRevision = deferred<{ revision: number } | null>()
        const inputPersistence = deferred<{ revision: number } | null>()
        const persistedResult = deferred<{ revision: number } | null>()
        mocks.executeCanonicalSend.mockImplementation(async (input) => {
            await input.onInputAppended({ messageIndex: 2, messageId: 'request-1' })
            return { generated: true, previousLength: 1, currentLength: 2 }
        })
        let persistenceCall = 0
        const waitForPersistence = vi.fn(() => {
            persistenceCall += 1
            if (persistenceCall === 1) {
                return Promise.resolve({ revision: 5 })
            }
            if (persistenceCall === 2) {
                return requestedRevision.promise
            }
            if (persistenceCall === 3) {
                return inputPersistence.promise
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

        await vi.waitFor(() => expect(waitForPersistence).toHaveBeenNthCalledWith(3, 60_000, 8))
        inputPersistence.resolve({ revision: 8 })
        await vi.waitFor(() => expect(client.progress).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 5 }),
            'input_committed',
            {
                databaseRevision: 8,
                messageIndex: 2,
                messageId: 'request-1',
            },
            expect.any(AbortSignal),
        ))
        expect(client.complete).not.toHaveBeenCalled()

        persistedResult.resolve({ revision: 9 })
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
                databaseRevision: 9,
                canonicalMutationPersisted: true,
            },
        )
        expect(mocks.setFence).toHaveBeenLastCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 5 }),
        )
    })

    it('publishes TTS through the command mailbox and never plays it in the resident', async () => {
        mocks.executeCanonicalSend.mockImplementation(async () => {
            expect(mocks.ttsBridge).not.toBeNull()
            await mocks.ttsBridge!({
                type: 'speak',
                characterId: 'character-1',
                text: 'resolved pipeline speech',
            })
            return { generated: false, previousLength: 0, currentLength: 0 }
        })
        const claimed = command('send', {
            input: '/pass resolved pipeline speech | /speak',
            databaseRevision: 4,
        })
        claimed.presentationChannel = true
        const { client } = makeClient(claimed)

        start(client, vi.fn(async () => ({ revision: 4 })))

        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())
        expect(client.publishPresentationAction).toHaveBeenCalledOnce()
        expect(client.publishPresentationAction).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ executorId: 'resident-1' }),
            expect.any(String),
            {
                type: 'speak',
                characterId: 'character-1',
                text: 'resolved pipeline speech',
            },
            expect.any(AbortSignal),
        )
        expect(client.publishPresentationAction.mock.invocationCallOrder[0])
            .toBeLessThan(client.complete.mock.invocationCallOrder[0])
        expect(mocks.ttsBridgeCleanup).toHaveBeenCalledOnce()
    })

    it('silences nested/automatic TTS when an ephemeral channel is unavailable', async () => {
        mocks.executeCanonicalSend.mockImplementation(async () => {
            // All sayTTS call sites, including nested trigger effects and
            // ttsAutoSpeech, enter this installed bridge while the command runs.
            await mocks.ttsBridge!({
                type: 'speak',
                characterId: 'character-1',
                text: 'must not play in hidden Chromium',
            })
            return { generated: true, previousLength: 1, currentLength: 2 }
        })
        const { client } = makeClient(command('send', {
            input: 'ordinary input',
            databaseRevision: 4,
        }))

        start(client, vi.fn(async () => ({ revision: 4 })))

        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())
        expect(client.publishPresentationAction).not.toHaveBeenCalled()
        expect(mocks.ttsBridgeCleanup).toHaveBeenCalledOnce()
    })

    it('drops a stalled presentation publish without blocking canonical completion', async () => {
        mocks.executeCanonicalSend.mockImplementation(async () => {
            await mocks.ttsBridge!({
                type: 'speak',
                characterId: 'character-1',
                text: 'drop after bounded timeout',
            })
            return { generated: false, previousLength: 0, currentLength: 0 }
        })
        const claimed = command('send', {
            input: '/speak drop after bounded timeout',
            databaseRevision: 4,
        })
        claimed.presentationChannel = true
        const { client } = makeClient(claimed)
        client.publishPresentationAction.mockImplementation(() => new Promise(() => {}))
        const onError = vi.fn()

        start(
            client,
            vi.fn(async () => ({ revision: 4 })),
            { presentationPublishTimeoutMs: 10, onError },
        )

        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ name: 'TimeoutError' }))
        expect(client.fail).not.toHaveBeenCalled()
    })

    it('publishes continuous strong-mode snapshots on a leading 125 ms cadence with the current lease', async () => {
        vi.useFakeTimers()
        try {
            const execution = deferred<{ generated: boolean, previousLength: number, currentLength: number }>()
            mocks.executeCanonicalSend.mockImplementation(async () => await execution.promise)
            const { client } = makeClient(command('send', { input: 'hello' }))

            start(
                client,
                vi.fn(async () => ({ revision: 4 })),
                { heartbeatIntervalMs: 100 },
            )
            await vi.advanceTimersByTimeAsync(0)
            expect(mocks.executeCanonicalSend).toHaveBeenCalledOnce()

            emitOutput('first', 'strong')
            expect(client.publishOutput).toHaveBeenCalledOnce()
            expect(client.publishOutput.mock.calls[0][2]).toEqual(expect.objectContaining({
                version: 1,
                messages: [expect.objectContaining({
                    data: 'first',
                    optimizationMode: 'strong',
                })],
            }))

            await vi.advanceTimersByTimeAsync(50)
            emitOutput('second', 'strong')
            await vi.advanceTimersByTimeAsync(50)
            emitOutput('third', 'strong')
            await vi.advanceTimersByTimeAsync(24)
            expect(client.publishOutput).toHaveBeenCalledOnce()

            await vi.advanceTimersByTimeAsync(1)
            expect(client.publishOutput).toHaveBeenCalledTimes(2)
            expect(client.publishOutput.mock.calls[1][1]).toEqual(expect.objectContaining({
                fencingToken: 5,
            }))
            expect(client.publishOutput.mock.calls[1][2]).toEqual(expect.objectContaining({
                version: 2,
                messages: [expect.objectContaining({
                    data: 'third',
                    optimizationMode: 'strong',
                })],
            }))

            emitOutput('fourth', 'strong')
            await vi.advanceTimersByTimeAsync(125)
            expect(client.publishOutput).toHaveBeenCalledTimes(3)
            expect(client.publishOutput.mock.calls[2][2]).toEqual(expect.objectContaining({
                version: 3,
                messages: [expect.objectContaining({ data: 'fourth' })],
            }))

            execution.resolve({ generated: true, previousLength: 1, currentLength: 2 })
            await vi.advanceTimersByTimeAsync(0)
            expect(client.complete).toHaveBeenCalledOnce()
        }
        finally {
            handle?.stop()
            handle = null
            vi.useRealTimers()
        }
    })

    it('coalesces while transport is slow and flushes the latest output before success', async () => {
        const firstPublish = deferred<unknown>()
        const execution = deferred<{ generated: boolean, previousLength: number, currentLength: number }>()
        mocks.executeCanonicalSend.mockImplementation(async () => await execution.promise)
        const { client } = makeClient(command('send', { input: 'hello' }))
        client.publishOutput
            .mockImplementationOnce(async () => await firstPublish.promise)
            .mockResolvedValue(undefined)

        start(client, vi.fn(async () => ({ revision: 4 })))
        await vi.waitFor(() => expect(mocks.executeCanonicalSend).toHaveBeenCalledOnce())

        emitOutput('first')
        emitOutput('superseded')
        emitOutput('latest')
        execution.resolve({ generated: true, previousLength: 1, currentLength: 2 })
        await Promise.resolve()
        expect(client.publishOutput).toHaveBeenCalledOnce()
        expect(client.complete).not.toHaveBeenCalled()

        firstPublish.resolve(undefined)
        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())

        expect(client.publishOutput).toHaveBeenCalledTimes(2)
        expect(client.publishOutput.mock.calls.map((call) => call[2])).toEqual([
            expect.objectContaining({
                version: 1,
                messages: [expect.objectContaining({ data: 'first' })],
            }),
            expect.objectContaining({
                version: 2,
                messages: [expect.objectContaining({ data: 'latest' })],
            }),
        ])
        expect(client.publishOutput.mock.invocationCallOrder[1]).toBeLessThan(
            client.complete.mock.invocationCallOrder[0],
        )
    })

    it('publishes an ordered latest snapshot for every assistant message in one command', async () => {
        const firstPublish = deferred<unknown>()
        const execution = deferred<{ generated: boolean, previousLength: number, currentLength: number }>()
        mocks.executeCanonicalSend.mockImplementation(async () => await execution.promise)
        const { client } = makeClient(command('send', { input: 'hello' }))
        client.publishOutput
            .mockImplementationOnce(async () => await firstPublish.promise)
            .mockResolvedValue(undefined)

        start(client, vi.fn(async () => ({ revision: 4 })))
        await vi.waitFor(() => expect(mocks.executeCanonicalSend).toHaveBeenCalledOnce())

        emitMessageOutput('generation-1', 2, 'first bubble partial')
        await vi.waitFor(() => expect(client.publishOutput).toHaveBeenCalledOnce())
        emitMessageOutput('generation-2', 3, 'second bubble partial')
        emitMessageOutput('generation-1', 2, 'first bubble final')
        emitMessageOutput('generation-2', 3, 'second bubble final')
        execution.resolve({ generated: true, previousLength: 1, currentLength: 3 })

        expect(client.complete).not.toHaveBeenCalled()
        firstPublish.resolve(undefined)
        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())

        expect(client.publishOutput).toHaveBeenCalledTimes(2)
        expect(client.publishOutput.mock.calls[0][2]).toEqual({
            version: 1,
            messages: [expect.objectContaining({
                messageId: 'generation-1',
                messageIndex: 2,
                data: 'first bubble partial',
            })],
        })
        expect(client.publishOutput.mock.calls[1][2]).toEqual({
            version: 2,
            messages: [
                expect.objectContaining({
                    messageId: 'generation-1',
                    messageIndex: 2,
                    data: 'first bubble final',
                }),
                expect.objectContaining({
                    messageId: 'generation-2',
                    messageIndex: 3,
                    data: 'second bubble final',
                }),
            ],
        })
        expect(client.publishOutput.mock.invocationCallOrder[1]).toBeLessThan(
            client.complete.mock.invocationCallOrder[0],
        )
    })

    it('removes the stale message suffix when a resend replaces an earlier index', async () => {
        const firstPublish = deferred<unknown>()
        const execution = deferred<{ generated: boolean, previousLength: number, currentLength: number }>()
        mocks.executeCanonicalSend.mockImplementation(async () => await execution.promise)
        const { client } = makeClient(command('send', { input: 'hello' }))
        client.publishOutput
            .mockImplementationOnce(async () => await firstPublish.promise)
            .mockResolvedValue(undefined)

        start(client, vi.fn(async () => ({ revision: 4 })))
        await vi.waitFor(() => expect(mocks.executeCanonicalSend).toHaveBeenCalledOnce())

        emitMessageOutput('generation-old', 2, 'old first bubble')
        await vi.waitFor(() => expect(client.publishOutput).toHaveBeenCalledOnce())
        emitMessageOutput('generation-old-suffix', 3, 'old later bubble')
        emitMessageOutput('generation-replacement', 2, 'replacement bubble')
        execution.resolve({ generated: true, previousLength: 1, currentLength: 2 })

        firstPublish.resolve(undefined)
        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())

        expect(client.publishOutput).toHaveBeenCalledTimes(2)
        expect(client.publishOutput.mock.calls[1][2]).toEqual({
            version: 2,
            messages: [expect.objectContaining({
                messageId: 'generation-replacement',
                messageIndex: 2,
                data: 'replacement bubble',
            })],
        })
    })

    it('flushes the post-IGP final message instead of leaving the pre-IGP overlay', async () => {
        mocks.executeCanonicalSend.mockImplementation(async () => {
            emitOutput('processed provider final')
            emitRuntimeStreamingOutput({
                messageId: 'generation-1',
                messageIndex: 2,
                data: 'processed provider final::IGP',
                createdAt: 123,
                generationInfo: {
                    generationId: 'generation-1',
                    stageTiming: { stage4: 25 },
                },
                optimizationMode: 'balanced',
            })
            return { generated: true, previousLength: 1, currentLength: 2 }
        })
        const { client } = makeClient(command('send', { input: 'hello' }))

        start(client, vi.fn(async () => ({ revision: 4 })))
        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())

        const finalPublish = client.publishOutput.mock.calls.at(-1)
        expect(finalPublish?.[2]).toEqual(expect.objectContaining({
            messages: [expect.objectContaining({
                data: 'processed provider final::IGP',
                generationInfo: expect.objectContaining({
                    stageTiming: { stage4: 25 },
                }),
            })],
        }))
        expect(client.publishOutput.mock.invocationCallOrder.at(-1)).toBeLessThan(
            client.complete.mock.invocationCallOrder[0],
        )
    })

    it('flushes the latest output before completing cancellation', async () => {
        const firstPublish = deferred<unknown>()
        const execution = deferred<{ generated: boolean, previousLength: number, currentLength: number }>()
        mocks.executeCanonicalSend.mockImplementation(async () => await execution.promise)
        const { client, watchHandlers } = makeClient(command('send', { input: 'hello' }))
        client.publishOutput
            .mockImplementationOnce(async () => await firstPublish.promise)
            .mockResolvedValue(undefined)

        start(client, vi.fn(async () => ({ revision: 4 })))
        await vi.waitFor(() => expect(mocks.executeCanonicalSend).toHaveBeenCalledOnce())
        emitOutput('first')
        emitOutput('cancelled latest')
        watchHandlers[0].onEvent?.({
            type: 'generation_event',
            commandId: 'command-1',
            sequence: 3,
            eventType: 'cancel_requested',
            timestamp: Date.now(),
            payload: { reason: 'user_cancel' },
        })
        execution.resolve({ generated: true, previousLength: 1, currentLength: 2 })
        await Promise.resolve()
        expect(client.completeCancellation).not.toHaveBeenCalled()

        firstPublish.resolve(undefined)
        await vi.waitFor(() => expect(client.completeCancellation).toHaveBeenCalledOnce())

        expect(client.publishOutput).toHaveBeenCalledTimes(2)
        expect(client.publishOutput.mock.calls[1][2]).toEqual(expect.objectContaining({
            version: 2,
            messages: [expect.objectContaining({ data: 'cancelled latest' })],
        }))
        expect(client.publishOutput.mock.invocationCallOrder[1]).toBeLessThan(
            client.completeCancellation.mock.invocationCallOrder[0],
        )
    })

    it('flushes the latest output before reporting canonical execution failure', async () => {
        const firstPublish = deferred<unknown>()
        const execution = deferred<never>()
        mocks.executeCanonicalSend.mockImplementation(async () => await execution.promise)
        const { client } = makeClient(command('send', { input: 'hello' }))
        client.publishOutput
            .mockImplementationOnce(async () => await firstPublish.promise)
            .mockResolvedValue(undefined)

        start(client, vi.fn(async () => ({ revision: 4 })))
        await vi.waitFor(() => expect(mocks.executeCanonicalSend).toHaveBeenCalledOnce())
        emitOutput('first')
        emitOutput('failed latest')
        execution.reject(new Error('provider failed'))
        await Promise.resolve()
        expect(client.fail).not.toHaveBeenCalled()

        firstPublish.resolve(undefined)
        await vi.waitFor(() => expect(client.fail).toHaveBeenCalledOnce())

        expect(client.publishOutput).toHaveBeenCalledTimes(2)
        expect(client.publishOutput.mock.calls[1][2]).toEqual(expect.objectContaining({
            version: 2,
            messages: [expect.objectContaining({ data: 'failed latest' })],
        }))
        expect(client.publishOutput.mock.invocationCallOrder[1]).toBeLessThan(
            client.fail.mock.invocationCallOrder[0],
        )
    })

    it('reports non-fence output rejection without aborting or failing canonical completion', async () => {
        const outputError = new RuntimeGenerationHttpError(413, {
            code: 'OUTPUT_TOO_LARGE',
        })
        let processSignalAborted = false
        mocks.executeCanonicalSend.mockImplementation(async ({ signal }) => {
            emitOutput('processed by plugin')
            await Promise.resolve()
            processSignalAborted = signal.aborted
            return { generated: true, previousLength: 1, currentLength: 2 }
        })
        const { client } = makeClient(command('send', { input: 'hello' }))
        client.publishOutput.mockRejectedValue(outputError)
        const onError = vi.fn()

        start(client, vi.fn(async () => ({ revision: 4 })), { onError })
        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())

        expect(processSignalAborted).toBe(false)
        expect(onError).toHaveBeenCalledWith(outputError)
        expect(client.fail).not.toHaveBeenCalled()
    })

    it('aborts canonical execution when output publishing loses the executor fence', async () => {
        let processSignalAborted = false
        mocks.executeCanonicalSend.mockImplementation(async ({ signal }) => {
            emitOutput('fenced output')
            if (!signal.aborted) {
                await new Promise<void>((resolve) => {
                    signal.addEventListener('abort', () => resolve(), { once: true })
                })
            }
            processSignalAborted = signal.aborted
            return { generated: true, previousLength: 1, currentLength: 2 }
        })
        const { client } = makeClient(command('send', { input: 'hello' }))
        client.publishOutput.mockRejectedValue(new RuntimeGenerationHttpError(409, {
            code: 'STALE_EXECUTOR_FENCE',
        }))
        const onError = vi.fn()

        start(client, vi.fn(async () => ({ revision: 4 })), { onError })
        await vi.waitFor(() => expect(client.claimNext).toHaveBeenCalledTimes(2))

        expect(processSignalAborted).toBe(true)
        expect(onError).not.toHaveBeenCalled()
        expect(client.complete).not.toHaveBeenCalled()
        expect(client.completeCancellation).not.toHaveBeenCalled()
        expect(client.fail).not.toHaveBeenCalled()
    })

    it('bounds a retrying output transport before canonical completion', async () => {
        vi.useFakeTimers()
        try {
            mocks.executeCanonicalSend.mockImplementation(async () => {
                emitOutput('processed output')
                return { generated: true, previousLength: 1, currentLength: 2 }
            })
            const { client } = makeClient(command('send', { input: 'hello' }))
            // Model a transport/auth step that ignores AbortSignal entirely;
            // the resident timeout must still keep terminal completion bounded.
            client.publishOutput.mockImplementation(async () => await new Promise(() => {}))
            const onError = vi.fn()

            start(client, vi.fn(async () => ({ revision: 4 })), { onError })
            await vi.advanceTimersByTimeAsync(0)
            expect(client.publishOutput).toHaveBeenCalledOnce()
            expect(client.complete).not.toHaveBeenCalled()

            await vi.advanceTimersByTimeAsync(4_999)
            expect(client.complete).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(1)
            expect(onError).toHaveBeenCalledWith(expect.objectContaining({
                name: 'TimeoutError',
            }))
            expect(client.complete).toHaveBeenCalledOnce()
            expect(client.fail).not.toHaveBeenCalled()
        }
        finally {
            handle?.stop()
            handle = null
            vi.useRealTimers()
        }
    })

    it('keeps the fence until cancellation persistence completes, then records cancelled', async () => {
        const execution = deferred<{ generated: boolean, previousLength: number, currentLength: number }>()
        const cancellationPersistence = deferred<{ revision: number } | null>()
        mocks.executeCanonicalSend.mockImplementation(async (input) => {
            await input.onInputAppended({ messageIndex: 0, messageId: 'request-1' })
            return await execution.promise
        })
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

    it('does not restore a slash draft after its earlier canonical mutation persists', async () => {
        const execution = deferred<{ generated: boolean, previousLength: number, currentLength: number }>()
        const cancellationPersistence = deferred<{ revision: number } | null>()
        mocks.executeCanonicalSend.mockImplementation(async (input) => {
            input.onCanonicalMutation()
            return await execution.promise
        })
        let persistenceCall = 0
        const waitForPersistence = vi.fn(() => {
            persistenceCall += 1
            return persistenceCall <= 2
                ? Promise.resolve({ revision: 4 })
                : cancellationPersistence.promise
        })
        const { client, watchHandlers } = makeClient(command('send', {
            input: '/send hello | /input wait',
            databaseRevision: 4,
        }))

        start(client, waitForPersistence)
        await vi.waitFor(() => expect(mocks.executeCanonicalSend).toHaveBeenCalledOnce())
        watchHandlers[0].onEvent?.({
            type: 'generation_event',
            commandId: 'command-1',
            sequence: 3,
            eventType: 'cancel_requested',
            timestamp: Date.now(),
            payload: { reason: 'user_cancel' },
        })
        execution.resolve({ generated: false, previousLength: 0, currentLength: 1 })

        await vi.waitFor(() => expect(waitForPersistence).toHaveBeenCalledTimes(3))
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
        mocks.executeCanonicalSend.mockImplementation(async (input) => {
            await input.onInputAppended({ messageIndex: 0, messageId: 'request-1' })
            throw new Error('provider failed')
        })
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

    it('does not claim an unrelated revision when send fails before appending canonical input', async () => {
        mocks.executeCanonicalSend.mockRejectedValue(new Error('input trigger failed'))
        const waitForPersistence = vi.fn()
            .mockResolvedValueOnce({ revision: 7 })
            .mockResolvedValueOnce({ revision: 7 })
            .mockResolvedValueOnce({ revision: 8 })
        const { client } = makeClient(command('send', {
            input: 'restore this draft',
            databaseRevision: 7,
        }))

        start(client, waitForPersistence)
        await vi.waitFor(() => expect(client.fail).toHaveBeenCalledOnce())

        expect(client.progress).not.toHaveBeenCalledWith(
            'command-1',
            expect.anything(),
            'input_committed',
            expect.anything(),
            expect.anything(),
        )
        expect(client.fail).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 5 }),
            'input trigger failed',
            {
                stage: 0,
                databaseRevision: 8,
                canonicalMutationPersisted: false,
            },
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

    it('dispatches suggestion generation without putting suggestion text in the result', async () => {
        const { client } = makeClient(command('suggest', {
            databaseRevision: 14,
            force: false,
        }))

        const waitForPersistence = vi.fn()
            .mockResolvedValueOnce({ revision: 14 })
            .mockResolvedValueOnce({ revision: 14 })
            .mockResolvedValue({ revision: 15 })
        start(client, waitForPersistence)
        await vi.waitFor(() => expect(client.complete).toHaveBeenCalledOnce())

        expect(mocks.executeCanonicalSuggestion).toHaveBeenCalledWith({
            characterId: 'character-1',
            chatId: 'chat-1',
            signal: expect.any(AbortSignal),
        })
        expect(client.complete).toHaveBeenCalledWith(
            'command-1',
            expect.objectContaining({ fencingToken: 5 }),
            expect.objectContaining({
                generated: false,
                suggestionsUpdated: true,
                suggestionCount: 2,
                databaseRevision: 15,
            }),
        )
        expect(JSON.stringify(client.complete.mock.calls[0][2])).not.toContain('suggestion text')
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
