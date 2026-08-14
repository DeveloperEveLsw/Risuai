import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeAlertBridge } from '../alert'
import type {
    RuntimeStartupClient,
    RuntimeStartupWatchHandlers,
} from './startupPromptClient'

const mocks = vi.hoisted(() => ({
    isNodeServer: true,
    isServerResidentExecutor: true,
    bridge: null as RuntimeAlertBridge | null,
    dismiss: vi.fn(),
    presentNotice: vi.fn(async () => undefined),
    presentPrompt: vi.fn(async () => 'yes' as string | null),
}))

vi.mock('../platform', () => ({
    get isNodeServer() {
        return mocks.isNodeServer
    },
    get isServerResidentExecutor() {
        return mocks.isServerResidentExecutor
    },
    isTauri: false,
}))

vi.mock('./startupPromptClient', () => ({
    RuntimeStartupClient: class RuntimeStartupClient {},
}))

vi.mock('../alert', () => ({
    dismissRuntimeAlertPrompt: mocks.dismiss,
    installRuntimeAlertBridge: (bridge: RuntimeAlertBridge) => {
        mocks.bridge = bridge
        return () => {
            if (mocks.bridge === bridge) {
                mocks.bridge = null
            }
        }
    },
    presentRuntimeAlertNotice: mocks.presentNotice,
    presentRuntimeAlertPrompt: mocks.presentPrompt,
}))

import {
    startResidentRuntimeStartupBroker,
    startRuntimeStartupFollower,
} from './startupPromptBroker'

function startupSession() {
    return {
        sessionId: 'startup-session-1',
        producerId: 'resident-1',
        fencingToken: 4,
        phase: 'loading_data' as const,
        expiresAt: Date.now() + 60_000,
        reused: false,
    }
}

describe('resident runtime startup alert bridge', () => {
    beforeEach(() => {
        mocks.isNodeServer = true
        mocks.isServerResidentExecutor = true
        mocks.bridge = null
        mocks.dismiss.mockReset()
        mocks.presentNotice.mockReset().mockResolvedValue(undefined)
        mocks.presentPrompt.mockReset().mockResolvedValue('yes')
        sessionStorage.clear()
    })

    it('installs a base bridge, heartbeats phases, and keeps notices nonblocking', async () => {
        const session = startupSession()
        const client = {
            beginSession: vi.fn(async () => session),
            heartbeat: vi.fn(async () => ({ success: true })),
            prompt: vi.fn(async () => 'phone-secret'),
            notice: vi.fn(async () => ({ noticeId: 'notice-1' })),
        } as unknown as RuntimeStartupClient
        const handle = await startResidentRuntimeStartupBroker({
            client,
            producerId: 'resident-1',
            heartbeatMs: 60_000,
        })
        expect(handle).not.toBeNull()
        expect(mocks.bridge).not.toBeNull()

        await expect(mocks.bridge!.prompt({
            type: 'input',
            msg: 'Provider key',
            defaultValue: '',
        })).resolves.toBe('phone-secret')
        await mocks.bridge!.notice({ type: 'markdown', msg: '**Loaded**' })
        expect(client.prompt).toHaveBeenCalledOnce()
        expect(client.notice).toHaveBeenCalledOnce()
        expect(client.notice).toHaveBeenCalledWith(
            session,
            { type: 'markdown', msg: '**Loaded**' },
            { kind: 'runtime_notice' },
        )

        await handle!.setPhase('loading_plugins')
        await handle!.setPhase('starting_executor')
        expect(client.heartbeat).toHaveBeenCalledWith(session, 'starting_executor')
        handle!.stop()
        expect(mocks.bridge).toBeNull()
    })

    it('recreates its fenced mailbox after a Node server restart and switches every bridge call', async () => {
        const firstSession = startupSession()
        const recoveredSession = {
            ...startupSession(),
            sessionId: 'startup-session-after-restart',
            fencingToken: 1,
        }
        const staleSessionError = Object.assign(new Error('stale startup session'), {
            status: 409,
            body: { code: 'STALE_STARTUP_SESSION' },
        })
        const client = {
            beginSession: vi.fn()
                .mockResolvedValueOnce(firstSession)
                .mockResolvedValueOnce(recoveredSession),
            heartbeat: vi.fn()
                .mockRejectedValueOnce(staleSessionError)
                .mockResolvedValue({ success: true }),
            prompt: vi.fn(async () => 'recovered-secret'),
            notice: vi.fn(async () => ({ noticeId: 'recovered-notice' })),
        } as unknown as RuntimeStartupClient

        const handle = await startResidentRuntimeStartupBroker({
            client,
            producerId: 'resident-1',
            requestId: 'stable-browser-boot-request',
            heartbeatMs: 60_000,
        })
        await vi.waitFor(() => expect(client.beginSession).toHaveBeenCalledTimes(2))
        await vi.waitFor(() => expect(client.heartbeat).toHaveBeenCalledWith(
            recoveredSession,
            'loading_data',
        ))

        expect(client.beginSession).toHaveBeenNthCalledWith(
            1,
            'resident-1',
            'stable-browser-boot-request',
        )
        expect(client.beginSession).toHaveBeenNthCalledWith(
            2,
            'resident-1',
            'stable-browser-boot-request',
        )
        expect(handle!.session).toBe(recoveredSession)

        await expect(mocks.bridge!.prompt({
            type: 'input',
            msg: 'Provider key after restart',
        })).resolves.toBe('recovered-secret')
        await mocks.bridge!.notice({ type: 'normal', msg: 'Recovered' })
        expect(client.prompt).toHaveBeenCalledWith(
            recoveredSession,
            { type: 'input', msg: 'Provider key after restart' },
            { kind: 'runtime_alert' },
        )
        expect(client.notice).toHaveBeenCalledWith(
            recoveredSession,
            { type: 'normal', msg: 'Recovered' },
            { kind: 'runtime_notice' },
        )
        handle!.stop()
    })
})

describe('public runtime startup prompt follower', () => {
    beforeEach(() => {
        mocks.isNodeServer = true
        mocks.isServerResidentExecutor = false
        mocks.dismiss.mockReset()
        mocks.presentNotice.mockReset().mockResolvedValue(undefined)
        mocks.presentPrompt.mockReset().mockResolvedValue('yes')
    })

    it('presents snapshot prompts/notices and posts only the local winning answer', async () => {
        let handlers: RuntimeStartupWatchHandlers | null = null
        const stopWatching = vi.fn()
        const client = {
            watch: vi.fn((_clientId: string, nextHandlers: RuntimeStartupWatchHandlers) => {
                handlers = nextHandlers
                return stopWatching
            }),
            respond: vi.fn(async () => ({ accepted: true, reused: false })),
        } as unknown as RuntimeStartupClient
        const stop = startRuntimeStartupFollower({ client, clientId: 'phone' })
        expect(stop).toBeTypeOf('function')
        expect(handlers).not.toBeNull()

        handlers!.onSnapshot?.({
            type: 'runtime_startup_snapshot',
            instanceId: 'server-instance-1',
            sequence: 1,
            sessionId: 'startup-session-1',
            phase: 'waiting_for_ui',
            prompts: [{
                promptId: 'prompt-1',
                prompt: { type: 'ask', msg: 'Allow plugin?' },
                source: {
                    kind: 'plugin_permission',
                    pluginName: 'fixture-v3',
                    permission: 'db',
                    pluginScriptHash: 'a'.repeat(64),
                    permissionPolicy: 'periodically',
                },
                createdAt: 1,
                expiresAt: 100,
            }],
            notices: [{
                noticeId: 'notice-1',
                notice: { type: 'normal', msg: 'Loading plugin' },
                source: { kind: 'runtime_notice' },
                createdAt: 1,
                expiresAt: 100,
            }],
        })
        await vi.waitFor(() => expect(client.respond).toHaveBeenCalledWith('prompt-1', 'yes'))
        expect(mocks.presentNotice).toHaveBeenCalledWith({
            type: 'normal',
            msg: 'Loading plugin',
        })
        expect(mocks.dismiss).toHaveBeenCalledWith('prompt-1')

        handlers!.onEvent?.({
            type: 'runtime_startup_event',
            instanceId: 'server-instance-1',
            sequence: 2,
            eventType: 'prompt_settled',
            timestamp: 2,
            promptId: 'prompt-1',
            state: 'answered',
        })
        expect(mocks.dismiss).toHaveBeenCalledWith('prompt-1')

        stop!()
        expect(stopWatching).toHaveBeenCalledOnce()
    })

    it('deduplicates the same shared permission prompt across snapshot and event delivery', async () => {
        let handlers: RuntimeStartupWatchHandlers | null = null
        let resolvePrompt!: (value: string | null) => void
        mocks.presentPrompt.mockImplementationOnce(async () => await new Promise((resolve) => {
            resolvePrompt = resolve
        }))
        const client = {
            watch: vi.fn((_clientId: string, nextHandlers: RuntimeStartupWatchHandlers) => {
                handlers = nextHandlers
                return vi.fn()
            }),
            respond: vi.fn(async () => ({ accepted: true, reused: false })),
        } as unknown as RuntimeStartupClient
        const stop = startRuntimeStartupFollower({ client, clientId: 'desktop' })
        const prompt = {
            promptId: 'permission-prompt-1',
            prompt: { type: 'ask' as const, msg: 'Allow database access?' },
            source: {
                kind: 'plugin_permission',
                pluginName: 'fixture-v3',
                permission: 'db',
                pluginScriptHash: 'b'.repeat(64),
                permissionPolicy: 'periodically',
            },
            createdAt: 1,
            expiresAt: 100,
        }

        handlers!.onSnapshot?.({
            type: 'runtime_startup_snapshot',
            instanceId: 'server-instance-1',
            sequence: 1,
            sessionId: null,
            phase: 'waiting_for_ui',
            prompts: [prompt],
            notices: [],
        })
        handlers!.onEvent?.({
            type: 'runtime_startup_event',
            instanceId: 'server-instance-1',
            sequence: 2,
            eventType: 'prompt_created',
            timestamp: 2,
            prompt,
        })
        expect(mocks.presentPrompt).toHaveBeenCalledTimes(1)

        resolvePrompt('yes')
        await vi.waitFor(() => expect(client.respond).toHaveBeenCalledTimes(1))
        expect(client.respond).toHaveBeenCalledWith('permission-prompt-1', 'yes')
        stop!()
    })
})
