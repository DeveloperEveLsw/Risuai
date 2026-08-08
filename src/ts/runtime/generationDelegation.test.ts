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
    RuntimeGenerationClient: function MockRuntimeGenerationClient() {
        return {
            create: mocks.create,
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
    await vi.waitFor(() => expect(mocks.watchers).toHaveLength(2))
    for (const watcher of mocks.watchers) {
        watcher.handlers.onTerminal?.(terminal)
    }
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
        await vi.waitFor(() => expect(mocks.watchers).toHaveLength(2))
        const failed = command('failed', {
            finishedAt: 3,
            error: 'provider failed',
            result: {
                databaseRevision: 8,
                canonicalMutationPersisted: true,
            },
        })
        for (const watcher of mocks.watchers) {
            watcher.handlers.onTerminal?.(failed)
        }
        await Promise.resolve()

        expect(settled).toBe(false)
        expect(waitForPersistence).toHaveBeenCalledWith(60_000, 8)

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
        await vi.waitFor(() => expect(mocks.watchers).toHaveLength(2))
        const terminal = command('completed', {
            finishedAt: 2,
            result: { generated: true, databaseRevision: 31 },
        })
        mocks.watchers[0].handlers.onSnapshot?.({
            ...terminal,
            type: 'generation_snapshot',
            clientId: 'desktop',
        })
        for (const watcher of mocks.watchers) {
            watcher.handlers.onTerminal?.(terminal)
        }
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

    it('shows resident UI prompts and posts the original AlertComp answer', async () => {
        mocks.create.mockResolvedValue(command('queued'))
        mocks.presentRuntimeAlertPrompt.mockResolvedValue('yes')
        installRuntimeGenerationDelegation(vi.fn(async () => ({ revision: 40 })))
        const pending = mocks.delegate!(-1, {})
        await vi.waitFor(() => expect(mocks.watchers).toHaveLength(2))
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
        for (const watcher of mocks.watchers) {
            watcher.handlers.onTerminal?.(cancelled)
        }
        await expect(pending).resolves.toBe(false)
    })
})
