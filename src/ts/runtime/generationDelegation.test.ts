import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type {
    RuntimeGenerationCommand,
    RuntimeGenerationWatchHandlers,
} from './generationClient'

interface CapturedWatcher {
    handlers: RuntimeGenerationWatchHandlers
    stop: ReturnType<typeof vi.fn>
}

type CapturedDelegate = (
    chatProcessIndex: number,
    options: {
        preview?: boolean
        previewPrompt?: boolean
        signal?: AbortSignal
        chatAdditonalTokens?: number
        continue?: boolean
        usedContinueTokens?: number
    },
) => Promise<boolean | null>

const mocks = vi.hoisted(() => ({
    dbState: { db: {} as any },
    delegate: null as CapturedDelegate | null,
    watchers: [] as CapturedWatcher[],
    alertError: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    cancel: vi.fn(),
    respondToUiPrompt: vi.fn(),
    presentRuntimeAlertPrompt: vi.fn(),
    dismissRuntimeAlertPrompt: vi.fn(),
    dismissRuntimeAlertPromptsForCommand: vi.fn(),
    presentRuntimeAlertNotice: vi.fn(),
}))

vi.mock('../platform', () => ({
    isNodeServer: true,
    isServerResidentExecutor: false,
}))

vi.mock('../alert', () => ({
    alertError: mocks.alertError,
    presentRuntimeAlertPrompt: mocks.presentRuntimeAlertPrompt,
    dismissRuntimeAlertPrompt: mocks.dismissRuntimeAlertPrompt,
    dismissRuntimeAlertPromptsForCommand: mocks.dismissRuntimeAlertPromptsForCommand,
    presentRuntimeAlertNotice: mocks.presentRuntimeAlertNotice,
}))

vi.mock('../stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        DBState: mocks.dbState,
        selectedCharID: writable(-1),
    }
})

vi.mock('../process/index.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        chatProcessStage: writable(0),
        doingChat: writable(false),
        setSendChatDelegate: vi.fn((delegate: CapturedDelegate) => {
            mocks.delegate = delegate
        }),
    }
})

vi.mock('./generationClient', () => ({
    canonicalInputCommitFromEvent: (event: { eventType: string, payload: Record<string, unknown> }) => (
        event.eventType === 'input_committed' ? event.payload : null
    ),
    RuntimeGenerationClient: function MockRuntimeGenerationClient() {
        return {
            create: mocks.create,
            get: mocks.get,
            list: mocks.list,
            cancel: mocks.cancel,
            respondToUiPrompt: mocks.respondToUiPrompt,
            watch: vi.fn((_commandId: string, handlers: RuntimeGenerationWatchHandlers) => {
                const stop = vi.fn()
                mocks.watchers.push({ handlers, stop })
                return stop
            }),
        }
    },
}))

function command(
    state: RuntimeGenerationCommand['state'],
    overrides: Partial<RuntimeGenerationCommand> = {},
): RuntimeGenerationCommand {
    return {
        commandId: 'command-1',
        requestId: 'request-1',
        action: 'generate',
        characterId: 'character-1',
        chatId: 'chat-1',
        state,
        createdAt: 1,
        updatedAt: 1,
        startedAt: state === 'queued' ? null : 1,
        finishedAt: null,
        interruptedAt: null,
        cancelRequestedAt: null,
        executorId: null,
        fencingToken: null,
        leaseExpiresAt: null,
        result: null,
        error: null,
        lastSequence: 1,
        payload: {},
        ...overrides,
    }
}

async function finishDelegate(
    pending: Promise<boolean | null>,
    terminal: RuntimeGenerationCommand,
) {
    await vi.waitFor(() => expect(mocks.watchers).toHaveLength(1))
    mocks.watchers[0].handlers.onTerminal?.(terminal)
    return await pending
}

describe('public low-level sendChat delegation', () => {
    let installRuntimeGenerationDelegation:
        typeof import('./generationDelegation.svelte').installRuntimeGenerationDelegation
    let delegateRuntimeChatInteraction:
        typeof import('./generationDelegation.svelte').delegateRuntimeChatInteraction
    let queueRuntimeGeneration:
        typeof import('./generationDelegation.svelte').queueRuntimeGeneration
    let waitForRuntimeGenerationTerminal:
        typeof import('./generationDelegation.svelte').waitForRuntimeGenerationTerminal
    let cancelActiveRuntimeGeneration:
        typeof import('./generationDelegation.svelte').cancelActiveRuntimeGeneration
    let shouldRestoreCancelledRuntimeDraft:
        typeof import('./generationDelegation.svelte').shouldRestoreCancelledRuntimeDraft
    let shouldRestoreRuntimeDraft:
        typeof import('./generationDelegation.svelte').shouldRestoreRuntimeDraft
    let startRuntimeGenerationFollower:
        typeof import('./generationDelegation.svelte').startRuntimeGenerationFollower

    beforeEach(async () => {
        vi.resetModules()
        mocks.dbState.db = {
            characters: [{
                type: 'character',
                chaId: 'character-1',
                chatPage: 0,
                chats: [{
                    id: 'chat-1',
                    message: [{ role: 'user', data: 'already mutated by plugin' }],
                }],
            }],
        }
        mocks.delegate = null
        mocks.watchers.length = 0
        mocks.alertError.mockReset()
        mocks.create.mockReset()
        mocks.get.mockReset()
        mocks.list.mockReset().mockImplementation(() => new Promise(() => {}))
        mocks.cancel.mockReset()
        mocks.respondToUiPrompt.mockReset().mockResolvedValue({})
        mocks.presentRuntimeAlertPrompt.mockReset()
        mocks.dismissRuntimeAlertPrompt.mockReset()
        mocks.dismissRuntimeAlertPromptsForCommand.mockReset()
        mocks.presentRuntimeAlertNotice.mockReset().mockResolvedValue(undefined)

        const delegation = await import('./generationDelegation.svelte')
        const { selectedCharID } = await import('../stores.svelte')
        selectedCharID.set(0)
        installRuntimeGenerationDelegation = delegation.installRuntimeGenerationDelegation
        delegateRuntimeChatInteraction = delegation.delegateRuntimeChatInteraction
        queueRuntimeGeneration = delegation.queueRuntimeGeneration
        waitForRuntimeGenerationTerminal = delegation.waitForRuntimeGenerationTerminal
        cancelActiveRuntimeGeneration = delegation.cancelActiveRuntimeGeneration
        shouldRestoreCancelledRuntimeDraft = delegation.shouldRestoreCancelledRuntimeDraft
        shouldRestoreRuntimeDraft = delegation.shouldRestoreRuntimeDraft
        startRuntimeGenerationFollower = delegation.startRuntimeGenerationFollower
    })

    it('persists the already-mutated database, then enqueues generate with every upstream argument', async () => {
        const waitForPersistence = vi.fn(async () => {
            expect(mocks.dbState.db.characters[0].chats[0].message).toEqual([
                { role: 'user', data: 'already mutated by plugin' },
            ])
            return { revision: 23 }
        })
        mocks.create.mockResolvedValue(command('queued'))
        installRuntimeGenerationDelegation(waitForPersistence)
        expect(mocks.delegate).not.toBeNull()

        const pending = mocks.delegate!(3, {
            chatAdditonalTokens: 42,
            continue: true,
            usedContinueTokens: 7,
        })
        await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())

        expect(waitForPersistence).toHaveBeenCalledOnce()
        expect(waitForPersistence.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.create.mock.invocationCallOrder[0],
        )
        expect(mocks.create).toHaveBeenCalledWith({
            action: 'generate',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: {
                chatProcessIndex: 3,
                chatAdditonalTokens: 42,
                continue: true,
                usedContinueTokens: 7,
                databaseRevision: 23,
            },
        })

        await expect(finishDelegate(pending, command('completed', {
            finishedAt: 2,
            result: { generated: true },
        }))).resolves.toBe(true)
    })

    it('queues a manual chat trigger only after the follower revision is durable', async () => {
        const waitForPersistence = vi.fn()
            .mockResolvedValueOnce({ revision: 51 })
            .mockResolvedValue({ revision: 52 })
        mocks.create.mockResolvedValue(command('queued', { action: 'manual-trigger' }))
        installRuntimeGenerationDelegation(waitForPersistence)

        const pending = delegateRuntimeChatInteraction({
            action: 'manual-trigger',
            characterId: 'character-1',
            chatId: 'chat-1',
            manualName: 'community-action',
            triggerId: 'trigger-7',
        })
        await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
        expect(mocks.create).toHaveBeenCalledWith({
            action: 'manual-trigger',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: {
                databaseRevision: 51,
                manualName: 'community-action',
                triggerId: 'trigger-7',
            },
        })

        await expect(finishDelegate(pending, command('completed', {
            action: 'manual-trigger',
            finishedAt: 2,
            result: { generated: false, databaseRevision: 52 },
        }))).resolves.toBe(true)
        expect(waitForPersistence).toHaveBeenCalledWith(60_000, 52)
    })

    it('queues a Lua chat button with its opaque community payload', async () => {
        const waitForPersistence = vi.fn()
            .mockResolvedValueOnce({ revision: 61 })
            .mockResolvedValue({ revision: 62 })
        mocks.create.mockResolvedValue(command('queued', { action: 'lua-button' }))
        installRuntimeGenerationDelegation(waitForPersistence)

        const pending = delegateRuntimeChatInteraction({
            action: 'lua-button',
            characterId: 'character-1',
            chatId: 'chat-1',
            data: 'community-button-payload',
        })
        await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
        expect(mocks.create).toHaveBeenCalledWith({
            action: 'lua-button',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: {
                databaseRevision: 61,
                data: 'community-button-payload',
            },
        })

        await expect(finishDelegate(pending, command('completed', {
            action: 'lua-button',
            finishedAt: 2,
            result: { generated: false, databaseRevision: 62 },
        }))).resolves.toBe(true)
        expect(waitForPersistence).toHaveBeenCalledWith(60_000, 62)
    })

    it('maps a cancelled resident command to the upstream false result', async () => {
        mocks.create.mockResolvedValue(command('queued'))
        installRuntimeGenerationDelegation(vi.fn(async () => ({ revision: 24 })))

        const pending = mocks.delegate!(-1, {})

        await expect(finishDelegate(pending, command('cancelled', {
            finishedAt: 2,
            cancelRequestedAt: 2,
        }))).resolves.toBe(false)
    })

    it('lets Stop abort a pending create without consuming its draft payload', async () => {
        mocks.create.mockImplementation((_input, signal?: AbortSignal) => (
            new Promise((_resolve, reject) => {
                const abort = () => reject(signal?.reason)
                if(signal?.aborted){
                    abort()
                }
                else{
                    signal?.addEventListener('abort', abort, { once: true })
                }
            })
        ))
        const input = {
            action: 'send' as const,
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: {
                input: 'keep this pending draft',
                files: ['asset://keep-this-file'],
                databaseRevision: 7,
            },
        }
        const controller = new AbortController()
        const pending = queueRuntimeGeneration(input, controller.signal)
        await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
        const { doingChat } = await import('../process/index.svelte')
        expect(get(doingChat)).toBe(true)

        controller.abort(new Error('generation cancelled by user'))

        await expect(pending).rejects.toThrow('generation cancelled by user')
        expect(mocks.create).toHaveBeenCalledWith(input, controller.signal)
        expect(input.payload).toEqual({
            input: 'keep this pending draft',
            files: ['asset://keep-this-file'],
            databaseRevision: 7,
        })
        expect(mocks.watchers).toHaveLength(0)
        expect(get(doingChat)).toBe(false)
    })

    it('cancels a late admitted create exactly once after Stop', async () => {
        let admit!: (command: RuntimeGenerationCommand) => void
        mocks.create.mockImplementation(() => new Promise<RuntimeGenerationCommand>((resolve) => {
            admit = resolve
        }))
        const input = {
            requestId: 'request-1',
            action: 'send' as const,
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: {
                input: 'restore if cancellation wins',
                files: ['asset://keep-this-file'],
                databaseRevision: 7,
            },
        }
        const controller = new AbortController()
        const admission = queueRuntimeGeneration(input, controller.signal)
        await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())

        controller.abort(new Error('generation cancelled by user'))
        await expect(cancelActiveRuntimeGeneration({
            characterId: 'character-1',
            chatId: 'chat-1',
        })).resolves.toBeNull()

        admit(command('queued', {
            action: 'send',
            payload: input.payload,
        }))
        const admitted = await admission
        let finishCancellation!: (command: RuntimeGenerationCommand) => void
        mocks.cancel.mockImplementation(() => new Promise<RuntimeGenerationCommand>((resolve) => {
            finishCancellation = resolve
        }))

        const terminalPending = waitForRuntimeGenerationTerminal(admitted, controller.signal)
        const duplicateStop = cancelActiveRuntimeGeneration({
            characterId: 'character-1',
            chatId: 'chat-1',
        })
        await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledOnce())
        expect(mocks.cancel).toHaveBeenCalledWith('command-1')

        const terminal = command('cancelled', {
            action: 'send',
            cancelRequestedAt: 2,
            finishedAt: 3,
            payload: input.payload,
            result: { databaseRevision: 7, canonicalMutationPersisted: false },
        })
        finishCancellation(terminal)

        await expect(terminalPending).resolves.toEqual(terminal)
        await expect(duplicateStop).resolves.toEqual(terminal)
        expect(mocks.create).toHaveBeenCalledOnce()
        expect(mocks.cancel).toHaveBeenCalledOnce()
        expect(shouldRestoreCancelledRuntimeDraft(terminal)).toBe(true)
        expect(input.payload).toEqual({
            input: 'restore if cancellation wins',
            files: ['asset://keep-this-file'],
            databaseRevision: 7,
        })
    })

    it('accepts a terminal command resolved after Stop without issuing cancellation', async () => {
        const controller = new AbortController()
        controller.abort(new Error('generation cancelled by user'))
        const terminal = command('completed', {
            action: 'send',
            finishedAt: 3,
            result: {
                generated: true,
                databaseRevision: 8,
                canonicalMutationPersisted: true,
            },
        })
        mocks.create.mockResolvedValue(terminal)

        const admitted = await queueRuntimeGeneration({
            requestId: 'request-1',
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'already completed', databaseRevision: 7 },
        }, controller.signal)

        await expect(waitForRuntimeGenerationTerminal(admitted, controller.signal))
            .resolves.toEqual(terminal)
        expect(mocks.cancel).not.toHaveBeenCalled()
        expect(shouldRestoreRuntimeDraft(terminal)).toBe(false)
    })

    it('does not treat a running cancel request as terminal', async () => {
        const controller = new AbortController()
        const running = command('running')
        mocks.cancel.mockResolvedValue(command('running', {
            cancelRequestedAt: 2,
            lastSequence: 2,
        }))

        let settled = false
        const pending = waitForRuntimeGenerationTerminal(running, controller.signal)
            .then((value) => {
                settled = true
                return value
            })
        expect(mocks.watchers).toHaveLength(1)

        controller.abort('stop now')
        await vi.waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('command-1'))
        await Promise.resolve()
        expect(settled).toBe(false)
        expect(mocks.watchers[0].stop).not.toHaveBeenCalled()

        const terminal = command('cancelled', {
            cancelRequestedAt: 2,
            finishedAt: 3,
            result: { databaseRevision: 8, canonicalMutationPersisted: true },
        })
        mocks.watchers[0].handlers.onTerminal?.(terminal)
        await expect(pending).resolves.toEqual(terminal)
    })

    it('does not send another cancel after request admission already linearized Stop', async () => {
        const controller = new AbortController()
        controller.abort('stop already linearized')
        const running = command('running', {
            cancelRequestedAt: 2,
            lastSequence: 3,
        })

        const pending = waitForRuntimeGenerationTerminal(running, controller.signal)
        expect(mocks.watchers).toHaveLength(1)
        expect(mocks.cancel).not.toHaveBeenCalled()

        const terminal = command('cancelled', {
            cancelRequestedAt: 2,
            finishedAt: 3,
            lastSequence: 4,
        })
        mocks.watchers[0].handlers.onTerminal?.(terminal)
        await expect(pending).resolves.toEqual(terminal)
        expect(mocks.cancel).not.toHaveBeenCalled()
    })

    it('adopts a possible base-plus-one input before returning an unreported interruption', async () => {
        let releaseBarrier!: (value: { revision: number }) => void
        const barrier = new Promise<{ revision: number }>((resolve) => {
            releaseBarrier = resolve
        })
        const waitForPersistence = vi.fn(() => barrier)
        installRuntimeGenerationDelegation(waitForPersistence)
        const running = command('running', {
            action: 'send',
            payload: { input: 'durable before crash', databaseRevision: 7 },
        })

        let settled = false
        const pending = waitForRuntimeGenerationTerminal(running).then((terminal) => {
            settled = true
            return terminal
        })
        mocks.watchers[0].handlers.onTerminal?.(command('interrupted', {
            action: 'send',
            payload: undefined,
            result: null,
        }))

        await vi.waitFor(() => {
            expect(waitForPersistence).toHaveBeenCalledWith(10_000, 8)
        })
        expect(settled).toBe(false)
        mocks.dbState.db.characters[0].chats[0].message.push({
            role: 'user',
            data: 'durable before crash',
            chatId: 'request-1',
        })
        releaseBarrier({ revision: 8 })

        const terminal = await pending
        expect(terminal.payload).toEqual(running.payload)
        expect(shouldRestoreRuntimeDraft(terminal)).toBe(false)
    })

    it('keeps adopting after a trigger-only revision until the canonical input appears', async () => {
        let releaseInputRevision!: (value: { revision: number }) => void
        const inputRevision = new Promise<{ revision: number }>((resolve) => {
            releaseInputRevision = resolve
        })
        const waitForPersistence = vi.fn()
            // A low-level input trigger persisted its own mutation first.
            .mockResolvedValueOnce({ revision: 8 })
            .mockImplementation(() => inputRevision)
        installRuntimeGenerationDelegation(waitForPersistence)
        const running = command('running', {
            action: 'send',
            payload: { input: 'append after trigger', databaseRevision: 7 },
        })

        let settled = false
        const pending = waitForRuntimeGenerationTerminal(running).then((terminal) => {
            settled = true
            return terminal
        })
        mocks.watchers[0].handlers.onTerminal?.(command('interrupted', {
            action: 'send',
            payload: undefined,
            result: null,
        }))

        await vi.waitFor(() => expect(waitForPersistence).toHaveBeenCalledTimes(2))
        expect(waitForPersistence).toHaveBeenNthCalledWith(1, 10_000, 8)
        expect(waitForPersistence.mock.calls[1][0]).toBeGreaterThan(0)
        expect(waitForPersistence.mock.calls[1][0]).toBeLessThanOrEqual(10_000)
        expect(waitForPersistence.mock.calls[1][1]).toBe(9)
        expect(settled).toBe(false)

        mocks.dbState.db.characters[0].chats[0].message.push({
            role: 'user',
            data: 'append after trigger',
            chatId: 'request-1',
        })
        releaseInputRevision({ revision: 9 })

        const terminal = await pending
        expect(shouldRestoreRuntimeDraft(terminal)).toBe(false)
    })

    it('restores an interrupted draft after the bounded input-adoption grace expires', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const waitForPersistence = vi.fn().mockRejectedValue(new Error('adoption timed out'))
        installRuntimeGenerationDelegation(waitForPersistence)
        const interrupted = command('interrupted', {
            action: 'send',
            payload: { input: 'never committed', databaseRevision: 7 },
            result: null,
        })

        const terminal = await waitForRuntimeGenerationTerminal(interrupted)

        expect(waitForPersistence).toHaveBeenCalledWith(10_000, 8)
        expect(shouldRestoreRuntimeDraft(terminal)).toBe(true)
        warning.mockRestore()
    })

    it('keeps an active cancellation visible until the executor completes it', async () => {
        mocks.create.mockResolvedValue(command('running'))
        const running = await queueRuntimeGeneration({
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'hello', databaseRevision: 7 },
        })
        mocks.cancel.mockResolvedValue(command('running', {
            cancelRequestedAt: 2,
            lastSequence: 2,
        }))

        const requested = await cancelActiveRuntimeGeneration({
            characterId: 'character-1',
            chatId: 'chat-1',
        })
        expect(requested?.state).toBe('running')
        expect(mocks.watchers[0].stop).not.toHaveBeenCalled()
        const { doingChat } = await import('../process/index.svelte')
        expect(get(doingChat)).toBe(true)

        mocks.watchers[0].handlers.onTerminal?.(command('cancelled', {
            cancelRequestedAt: 2,
            finishedAt: 3,
        }))
        await vi.waitFor(() => expect(get(doingChat)).toBe(false))
        expect(running.state).toBe('running')
    })

    it('reuses an already durable active cancel request without another DELETE', async () => {
        mocks.create.mockResolvedValue(command('running', {
            cancelRequestedAt: 2,
            lastSequence: 3,
        }))
        const running = await queueRuntimeGeneration({
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'hello', databaseRevision: 7 },
        })

        await expect(cancelActiveRuntimeGeneration({
            characterId: 'character-1',
            chatId: 'chat-1',
        })).resolves.toEqual(running)
        expect(mocks.cancel).not.toHaveBeenCalled()
    })

    it('restores a fast-cancelled draft only when no canonical mutation was persisted', () => {
        expect(shouldRestoreCancelledRuntimeDraft(command('cancelled', {
            cancelRequestedAt: 2,
            finishedAt: 2,
            result: null,
        }))).toBe(true)
        expect(shouldRestoreCancelledRuntimeDraft(command('cancelled', {
            cancelRequestedAt: 2,
            finishedAt: 3,
            result: { databaseRevision: 8, canonicalMutationPersisted: false },
        }))).toBe(true)
        expect(shouldRestoreCancelledRuntimeDraft(command('cancelled', {
            cancelRequestedAt: 2,
            finishedAt: 3,
            result: { databaseRevision: 9, canonicalMutationPersisted: true },
        }))).toBe(false)
        expect(shouldRestoreRuntimeDraft(command('failed', {
            error: 'exact revision mismatch',
            result: { databaseRevision: 8, canonicalMutationPersisted: false },
        }))).toBe(true)
        expect(shouldRestoreRuntimeDraft(command('failed', {
            error: 'provider failed after input mutation',
            result: { databaseRevision: 8, canonicalMutationPersisted: true },
        }))).toBe(false)
        expect(shouldRestoreRuntimeDraft(command('completed', {
            result: { databaseRevision: 8, canonicalMutationPersisted: false },
        }))).toBe(false)

        mocks.dbState.db.characters[0].chats[0].message.push({
            role: 'user',
            data: 'durable input before resident crash',
            chatId: 'request-1',
        })
        expect(shouldRestoreRuntimeDraft(command('interrupted', {
            action: 'send',
            result: null,
        }))).toBe(false)
    })

    it('surfaces a failed resident terminal state to the original sendChat caller', async () => {
        mocks.create.mockResolvedValue(command('queued'))
        installRuntimeGenerationDelegation(vi.fn(async () => ({ revision: 25 })))

        const pending = mocks.delegate!(-1, {})
        const terminal = command('failed', {
            finishedAt: 2,
            error: 'provider exploded',
        })
        const settled = finishDelegate(pending, terminal)

        await expect(settled).rejects.toThrow('Server generation failed: provider exploded')
        expect(mocks.alertError).toHaveBeenCalledWith(
            'Server generation failed: provider exploded',
        )
    })

    it('waits for a failed database revision before surfacing the failure', async () => {
        let releaseBarrier!: (value: { revision: number }) => void
        const barrier = new Promise<{ revision: number }>((resolve) => {
            releaseBarrier = resolve
        })
        const waitForPersistence = vi.fn()
            .mockResolvedValueOnce({ revision: 7 })
            .mockImplementation(() => barrier)
        mocks.create.mockResolvedValue(command('queued'))
        installRuntimeGenerationDelegation(waitForPersistence)

        let settled = false
        const pending = mocks.delegate!(-1, {}).finally(() => {
            settled = true
        })
        await vi.waitFor(() => expect(mocks.watchers).toHaveLength(1))
        const failed = command('failed', {
            finishedAt: 3,
            error: 'provider failed',
            result: {
                databaseRevision: 8,
                canonicalMutationPersisted: true,
            },
        })
        mocks.watchers[0].handlers.onTerminal?.(failed)
        await Promise.resolve()

        expect(settled).toBe(false)
        await vi.waitFor(() => {
            expect(waitForPersistence).toHaveBeenCalledWith(60_000, 8)
        })

        releaseBarrier({ revision: 8 })
        await expect(pending).rejects.toThrow('Server generation failed: provider failed')
    })

    it('waits for the completed database revision before clearing or returning generation', async () => {
        let releaseBarrier!: (value: { revision: number }) => void
        const barrier = new Promise<{ revision: number }>((resolve) => {
            releaseBarrier = resolve
        })
        const waitForPersistence = vi.fn()
            .mockResolvedValueOnce({ revision: 30 })
            .mockImplementation(() => barrier)
        mocks.create.mockResolvedValue(command('queued'))
        installRuntimeGenerationDelegation(waitForPersistence)

        let settled = false
        const pending = mocks.delegate!(-1, {}).then((value) => {
            settled = true
            return value
        })
        await vi.waitFor(() => expect(mocks.watchers).toHaveLength(1))
        const terminal = command('completed', {
            finishedAt: 2,
            result: { generated: true, databaseRevision: 31 },
        })
        mocks.watchers[0].handlers.onSnapshot?.({
            ...terminal,
            type: 'generation_snapshot',
            clientId: 'desktop',
        })
        mocks.watchers[0].handlers.onTerminal?.(terminal)
        await Promise.resolve()

        expect(settled).toBe(false)
        const { doingChat } = await import('../process/index.svelte')
        expect(get(doingChat)).toBe(true)
        expect(mocks.dismissRuntimeAlertPromptsForCommand).not.toHaveBeenCalled()
        expect(waitForPersistence).toHaveBeenCalledWith(60_000, 31)

        releaseBarrier({ revision: 31 })
        await expect(pending).resolves.toBe(true)
        await vi.waitFor(() => {
            expect(mocks.dismissRuntimeAlertPromptsForCommand).toHaveBeenCalledWith('command-1')
        })
        expect(get(doingChat)).toBe(false)
    })

    it('hides a reconstructed input overlay only after its message revision is adopted', async () => {
        let releaseInput!: (value: { revision: number }) => void
        let releaseTerminal!: (value: { revision: number }) => void
        const inputBarrier = new Promise<{ revision: number }>((resolve) => {
            releaseInput = resolve
        })
        const terminalBarrier = new Promise<{ revision: number }>((resolve) => {
            releaseTerminal = resolve
        })
        const waitForPersistence = vi.fn((_timeout?: number, minimumRevision?: number) => {
            if (minimumRevision === 8) {
                return inputBarrier
            }
            if (minimumRevision === 9) {
                return terminalBarrier
            }
            return Promise.resolve({ revision: 9 })
        })
        const running = command('running', {
            action: 'send',
            payload: { input: 'hello', files: [], databaseRevision: 7 },
        })
        mocks.create.mockResolvedValue(running)
        installRuntimeGenerationDelegation(waitForPersistence)
        await queueRuntimeGeneration({
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'hello', files: [], databaseRevision: 7 },
        })
        const overlay = await import('./chatPresentationOverlay.svelte')
        expect(get(overlay.visibleRuntimeChatPresentationOverlays)).toHaveLength(1)

        mocks.dbState.db.characters[0].chats[0].message.push({
            role: 'user',
            data: 'hello',
            chatId: 'request-1',
        })
        mocks.watchers[0].handlers.onEvent?.({
            type: 'generation_event',
            commandId: 'command-1',
            sequence: 3,
            eventType: 'input_committed',
            timestamp: 3,
            payload: {
                databaseRevision: 8,
                messageIndex: 1,
                messageId: 'request-1',
            },
        })
        await vi.waitFor(() => expect(waitForPersistence).toHaveBeenCalledWith(60_000, 8))
        expect(get(overlay.visibleRuntimeChatPresentationOverlays)).toHaveLength(1)

        releaseInput({ revision: 8 })
        await vi.waitFor(() => {
            expect(get(overlay.visibleRuntimeChatPresentationOverlays)).toHaveLength(0)
        })
        expect(overlay.getRuntimeChatPresentationOverlay('command-1')).not.toBeNull()

        mocks.watchers[0].handlers.onTerminal?.(command('completed', {
            action: 'send',
            finishedAt: 4,
            payload: undefined,
            result: {
                generated: true,
                databaseRevision: 9,
                canonicalMutationPersisted: true,
            },
        }))
        await vi.waitFor(() => expect(waitForPersistence).toHaveBeenCalledWith(60_000, 9))
        expect(overlay.getRuntimeChatPresentationOverlay('command-1')).not.toBeNull()

        releaseTerminal({ revision: 9 })
        await vi.waitFor(() => {
            expect(overlay.getRuntimeChatPresentationOverlay('command-1')).toBeNull()
        })
    })

    it('hydrates a newly discovered active send once and reconstructs its cross-device overlay', async () => {
        const summary = command('running', {
            action: 'send',
            payload: undefined,
        })
        const hydrated = command('running', {
            action: 'send',
            payload: { input: 'remote hello', files: [], databaseRevision: 7 },
        })
        let listCall = 0
        mocks.list.mockImplementation(() => {
            listCall += 1
            if (listCall === 1) {
                return Promise.resolve([summary])
            }
            if (listCall <= 3) {
                return Promise.resolve([])
            }
            return new Promise(() => {})
        })
        mocks.get.mockResolvedValue(hydrated)

        startRuntimeGenerationFollower()
        const overlay = await import('./chatPresentationOverlay.svelte')
        await vi.waitFor(() => {
            expect(overlay.getRuntimeChatPresentationOverlay('command-1')).toMatchObject({
                requestId: 'request-1',
                commandId: 'command-1',
                displayText: 'remote hello',
                phase: 'running',
            })
        })
        expect(mocks.get).toHaveBeenCalledOnce()
        expect(mocks.get).toHaveBeenCalledWith('command-1')
    })

    it('finishes an observed command from HTTP terminal discovery when its socket is unavailable', async () => {
        const running = command('running', {
            action: 'send',
            payload: { input: 'remote hello', files: [], databaseRevision: 7 },
        })
        const terminal = command('completed', {
            action: 'send',
            payload: undefined,
            finishedAt: 4,
            lastSequence: 4,
            result: {
                generated: true,
                databaseRevision: 8,
                canonicalMutationPersisted: true,
            },
        })
        mocks.dbState.db.characters[0].chats[0].message.push({
            role: 'user',
            data: 'remote hello',
            chatId: 'request-1',
        })
        mocks.list.mockImplementation((query: { state?: string, updatedAfter?: number }) => {
            if (query.state === 'running') {
                return Promise.resolve([running])
            }
            if (query.state === 'queued') {
                return Promise.resolve([])
            }
            return Promise.resolve([terminal])
        })
        const waitForPersistence = vi.fn(async () => ({ revision: 8 }))
        installRuntimeGenerationDelegation(waitForPersistence)

        startRuntimeGenerationFollower()
        const overlay = await import('./chatPresentationOverlay.svelte')

        await vi.waitFor(() => {
            expect(waitForPersistence).toHaveBeenCalledWith(60_000, 8)
        })
        await vi.waitFor(() => {
            expect(overlay.getRuntimeChatPresentationOverlay('command-1')).toBeNull()
        })
        expect(mocks.watchers).toHaveLength(1)
        expect(mocks.watchers[0].stop).toHaveBeenCalledOnce()
        expect(mocks.get).not.toHaveBeenCalled()
        const { doingChat } = await import('../process/index.svelte')
        expect(get(doingChat)).toBe(false)
    })

    it('resolves the direct caller from HTTP terminal discovery when its socket never reports terminal', async () => {
        let releaseRecent!: (commands: RuntimeGenerationCommand[]) => void
        const recent = new Promise<RuntimeGenerationCommand[]>((resolve) => {
            releaseRecent = resolve
        })
        const running = command('running', {
            action: 'send',
            payload: { input: 'restore on failure', files: [], databaseRevision: 7 },
        })
        const failed = command('failed', {
            action: 'send',
            payload: undefined,
            finishedAt: 4,
            lastSequence: 4,
            error: 'provider failed before input append',
            result: {
                databaseRevision: 7,
                canonicalMutationPersisted: false,
            },
        })
        mocks.create.mockResolvedValue(running)
        mocks.list.mockImplementation((query: { updatedAfter?: number }) => (
            query.updatedAfter === undefined ? Promise.resolve([]) : recent
        ))
        const waitForPersistence = vi.fn(async () => ({ revision: 7 }))
        installRuntimeGenerationDelegation(waitForPersistence)
        const accepted = await queueRuntimeGeneration({
            requestId: 'request-1',
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: running.payload,
        })

        let settled = false
        const directTerminal = waitForRuntimeGenerationTerminal(accepted).then((terminal) => {
            settled = true
            return terminal
        })
        expect(mocks.watchers).toHaveLength(1)
        expect(settled).toBe(false)

        releaseRecent([failed])

        const terminal = await directTerminal
        expect(terminal).toMatchObject({
            state: 'failed',
            error: 'provider failed before input append',
            payload: running.payload,
        })
        expect(shouldRestoreRuntimeDraft(terminal)).toBe(true)
        expect(mocks.watchers).toHaveLength(1)
        expect(mocks.watchers[0].stop).toHaveBeenCalledOnce()
    })

    it('resolves a waiter registered after global terminal cleanup from the bounded terminal cache', async () => {
        const running = command('running', {
            action: 'send',
            payload: { input: 'completed quickly', files: [], databaseRevision: 7 },
        })
        const completed = command('completed', {
            action: 'send',
            payload: undefined,
            finishedAt: 4,
            lastSequence: 4,
            result: {
                generated: true,
                databaseRevision: 8,
                canonicalMutationPersisted: true,
            },
        })
        mocks.create.mockResolvedValue(running)
        const waitForPersistence = vi.fn(async () => ({ revision: 8 }))
        installRuntimeGenerationDelegation(waitForPersistence)
        const accepted = await queueRuntimeGeneration({
            requestId: 'request-1',
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: running.payload,
        })
        expect(mocks.watchers).toHaveLength(1)

        mocks.watchers[0].handlers.onTerminal?.(completed)
        await vi.waitFor(() => expect(mocks.watchers[0].stop).toHaveBeenCalledOnce())

        const terminal = await waitForRuntimeGenerationTerminal(accepted)
        expect(terminal).toMatchObject({
            state: 'completed',
            payload: running.payload,
        })
        expect(mocks.watchers).toHaveLength(1)
        expect(shouldRestoreRuntimeDraft(terminal)).toBe(false)
    })

    it('hydrates and finishes a newly discovered HTTP terminal without a socket callback', async () => {
        const summary = command('completed', {
            action: 'send',
            payload: undefined,
            finishedAt: 4,
            lastSequence: 4,
            result: {
                generated: true,
                databaseRevision: 8,
                canonicalMutationPersisted: true,
            },
        })
        const hydrated = command('completed', {
            ...summary,
            payload: { input: 'finished remotely', files: [], databaseRevision: 7 },
        })
        mocks.dbState.db.characters[0].chats[0].message.push({
            role: 'user',
            data: 'finished remotely',
            chatId: 'request-1',
        })
        mocks.list.mockImplementation((query: { state?: string, updatedAfter?: number }) => (
            query.updatedAfter === undefined
                ? Promise.resolve([])
                : Promise.resolve([summary])
        ))
        mocks.get.mockResolvedValue(hydrated)
        const waitForPersistence = vi.fn(async () => ({ revision: 8 }))
        installRuntimeGenerationDelegation(waitForPersistence)

        startRuntimeGenerationFollower()

        await vi.waitFor(() => {
            expect(mocks.dismissRuntimeAlertPromptsForCommand)
                .toHaveBeenCalledWith('command-1')
        })
        expect(mocks.get).toHaveBeenCalledOnce()
        expect(mocks.get).toHaveBeenCalledWith('command-1')
        expect(waitForPersistence).toHaveBeenCalledWith(60_000, 8)
        expect(mocks.watchers).toHaveLength(1)
        expect(mocks.watchers[0].stop).toHaveBeenCalledOnce()
    })

    it('keeps an overlay visible when an exact adopted revision lacks its message reference', async () => {
        const waitForPersistence = vi.fn(async () => ({ revision: 8 }))
        const running = command('running', {
            action: 'send',
            payload: { input: 'hello', databaseRevision: 7 },
        })
        mocks.create.mockResolvedValue(running)
        installRuntimeGenerationDelegation(waitForPersistence)
        await queueRuntimeGeneration({
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'hello', databaseRevision: 7 },
        })
        const overlay = await import('./chatPresentationOverlay.svelte')

        mocks.watchers[0].handlers.onEvent?.({
            type: 'generation_event',
            commandId: 'command-1',
            sequence: 3,
            eventType: 'input_committed',
            timestamp: 3,
            payload: {
                databaseRevision: 8,
                messageIndex: 1,
                messageId: 'request-1',
            },
        })

        await vi.waitFor(() => expect(waitForPersistence).toHaveBeenCalledWith(60_000, 8))
        await Promise.resolve()
        expect(get(overlay.visibleRuntimeChatPresentationOverlays)).toHaveLength(1)
    })

    it('accepts a missing historical message reference after a newer canonical revision supersedes it', async () => {
        const waitForPersistence = vi.fn(async () => ({ revision: 9 }))
        const running = command('running', {
            action: 'send',
            payload: { input: 'hello', databaseRevision: 7 },
        })
        mocks.create.mockResolvedValue(running)
        installRuntimeGenerationDelegation(waitForPersistence)
        await queueRuntimeGeneration({
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'hello', databaseRevision: 7 },
        })
        const overlay = await import('./chatPresentationOverlay.svelte')

        mocks.watchers[0].handlers.onEvent?.({
            type: 'generation_event',
            commandId: 'command-1',
            sequence: 3,
            eventType: 'input_committed',
            timestamp: 3,
            payload: {
                databaseRevision: 8,
                messageIndex: 1,
                messageId: 'request-1',
            },
        })

        await vi.waitFor(() => {
            expect(get(overlay.visibleRuntimeChatPresentationOverlays)).toHaveLength(0)
        })
    })

    it('shows resident UI prompts and posts the original AlertComp answer', async () => {
        mocks.create.mockResolvedValue(command('queued'))
        mocks.presentRuntimeAlertPrompt.mockResolvedValue('yes')
        installRuntimeGenerationDelegation(vi.fn(async () => ({ revision: 40 })))
        const pending = mocks.delegate!(-1, {})
        await vi.waitFor(() => expect(mocks.watchers).toHaveLength(1))
        mocks.watchers[0].handlers.onEvent?.({
            type: 'generation_event',
            commandId: 'command-1',
            sequence: 3,
            eventType: 'ui_prompt',
            timestamp: 3,
            payload: {
                promptId: 'prompt-1',
                prompt: { type: 'ask', msg: 'Allow low-level access?' },
            },
        })
        await vi.waitFor(() => {
            expect(mocks.respondToUiPrompt).toHaveBeenCalledWith(
                'command-1',
                'prompt-1',
                'yes',
            )
        })
        expect(mocks.presentRuntimeAlertPrompt).toHaveBeenCalledWith({
            commandId: 'command-1',
            promptId: 'prompt-1',
            prompt: { type: 'ask', msg: 'Allow low-level access?' },
        })

        mocks.watchers[0].handlers.onEvent?.({
            type: 'generation_event',
            commandId: 'command-1',
            sequence: 4,
            eventType: 'ui_prompt_response',
            timestamp: 4,
            payload: { promptId: 'prompt-1', responded: true },
        })
        expect(mocks.dismissRuntimeAlertPrompt).toHaveBeenCalledWith('prompt-1')

        const cancelled = command('cancelled', { finishedAt: 5, cancelRequestedAt: 5 })
        mocks.watchers[0].handlers.onTerminal?.(cancelled)
        await expect(pending).resolves.toBe(false)
    })
})
