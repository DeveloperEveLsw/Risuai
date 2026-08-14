import { describe, expect, it, vi } from 'vitest'

vi.mock('../storage/nodeStorage', () => ({
    getNodeServerProxyAuth: vi.fn(async () => 'mocked-auth'),
}))

import {
    RuntimeStartupClient,
    type RuntimeStartupEvent,
    type RuntimeStartupSnapshot,
} from './startupPromptClient'

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

function sessionBody() {
    return {
        sessionId: 'startup-session-1',
        producerId: 'resident-1',
        fencingToken: 7,
        phase: 'loading_data',
        expiresAt: Date.now() + 60_000,
        reused: false,
    }
}

describe('runtime startup prompt HTTP client', () => {
    it('keeps an answer replayable through polling and then explicitly closes the secret', async () => {
        let pollCount = 0
        const requests: Array<{ path: string, init: RequestInit }> = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
            const path = String(input)
            requests.push({ path, init })
            if (path === '/runtime-startup/session') {
                return jsonResponse(sessionBody(), 201)
            }
            if (path.endsWith('/prompts') && init.method === 'POST') {
                return jsonResponse({
                    promptId: 'prompt-1',
                    state: 'pending',
                    expiresAt: Date.now() + 60_000,
                    reused: false,
                }, 201)
            }
            if (path.endsWith('/prompts/prompt-1/poll')) {
                pollCount += 1
                return pollCount === 1
                    ? jsonResponse({ state: 'pending' }, 202)
                    : jsonResponse({ state: 'answered', response: 'provider-secret' })
            }
            if (path.endsWith('/prompts/prompt-1') && init.method === 'DELETE') {
                return jsonResponse({ success: true, reused: false })
            }
            throw new Error(`Unexpected request: ${path}`)
        }) as unknown as typeof fetch
        const uuids = ['boot-request', 'prompt-request']
        const client = new RuntimeStartupClient({
            fetchImpl,
            getAuth: async () => 'signed-auth',
            cryptoImpl: {
                randomUUID: () => uuids.shift()! as `${string}-${string}-${string}-${string}-${string}`,
            },
            pollIntervalMs: 1,
            reconnectDelayMs: 1,
        })

        const session = await client.beginSession('resident-1')
        await expect(client.prompt(session, {
            type: 'input',
            msg: 'Provider key',
            defaultValue: '',
        }, {
            kind: 'v2_dialog',
            pluginName: 'fixture-plugin',
        })).resolves.toBe('provider-secret')

        expect(pollCount).toBe(2)
        expect(requests.at(-1)).toMatchObject({
            path: '/runtime-startup/session/startup-session-1/prompts/prompt-1',
            init: { method: 'DELETE' },
        })
        for (const request of requests) {
            expect(new Headers(request.init.headers).get('risu-auth')).toBe('signed-auth')
        }
        const createBody = JSON.parse(String(requests[1].init.body))
        expect(createBody).toMatchObject({
            producerId: 'resident-1',
            fencingToken: 7,
            requestId: 'prompt-request',
            source: { kind: 'v2_dialog', pluginName: 'fixture-plugin' },
        })
    })

    it('uses a nonblocking notice endpoint and retries an ambiguous first-writer response', async () => {
        let responseAttempts = 0
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
            const path = String(input)
            if (path.endsWith('/notices')) {
                return jsonResponse({ noticeId: 'notice-1', expiresAt: Date.now() + 1_000 }, 201)
            }
            if (path.endsWith('/prompts/prompt-1/response')) {
                responseAttempts += 1
                if (responseAttempts === 1) {
                    throw new TypeError('ambiguous connection reset')
                }
                return jsonResponse({ success: true, accepted: false, reused: true })
            }
            throw new Error(`Unexpected request: ${path} ${init.method}`)
        }) as unknown as typeof fetch
        const client = new RuntimeStartupClient({
            fetchImpl,
            getAuth: async () => 'signed-auth',
            reconnectDelayMs: 1,
        })
        const session = {
            ...sessionBody(),
            phase: 'loading_data' as const,
        }

        await expect(client.notice(session, {
            type: 'markdown',
            msg: '**Loaded**',
        })).resolves.toMatchObject({ noticeId: 'notice-1' })
        await expect(client.respond('prompt-1', 'yes')).resolves.toEqual({
            accepted: false,
            reused: true,
        })
        expect(responseAttempts).toBe(2)
    })
})

class FakeSocket {
    readyState = 1
    private readonly listeners = new Map<string, Array<(event: any) => void>>()

    addEventListener(type: string, listener: (event: any) => void) {
        const entries = this.listeners.get(type) ?? []
        entries.push(listener)
        this.listeners.set(type, entries)
    }

    emit(type: string, event: any = {}) {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event)
        }
    }

    close() {
        this.readyState = 3
        this.emit('close')
    }
}

describe('runtime startup observer transport', () => {
    it('hydrates over HTTP and consumes redacted snapshot/event WebSocket messages', async () => {
        const snapshot: RuntimeStartupSnapshot = {
            type: 'runtime_startup_snapshot',
            instanceId: 'server-instance-1',
            sequence: 1,
            sessionId: 'startup-session-1',
            phase: 'waiting_for_ui',
            prompts: [{
                promptId: 'prompt-1',
                prompt: { type: 'ask', msg: 'Allow?' },
                source: { kind: 'v3_permission', pluginName: 'fixture-v3' },
                createdAt: 1,
                expiresAt: 100,
            }],
            notices: [],
        }
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
            const path = String(input)
            if (path === '/runtime-startup') {
                return jsonResponse(snapshot)
            }
            if (path === '/runtime-startup/socket-ticket') {
                return jsonResponse({
                    ticket: 'one-use-ticket',
                    path: '/runtime-startup/ws',
                    expiresAt: Date.now() + 30_000,
                })
            }
            throw new Error(`Unexpected request: ${path}`)
        }) as unknown as typeof fetch
        const socket = new FakeSocket()
        const snapshots: RuntimeStartupSnapshot[] = []
        const events: RuntimeStartupEvent[] = []
        const client = new RuntimeStartupClient({
            fetchImpl,
            getAuth: async () => 'signed-auth',
            location: { protocol: 'https:', host: 'risu.example' },
            webSocketFactory: (url) => {
                expect(url).toBe('wss://risu.example/runtime-startup/ws?ticket=one-use-ticket')
                return socket
            },
        })

        const stop = client.watch('phone', {
            onSnapshot: (value) => snapshots.push(value),
            onEvent: (value) => events.push(value),
        })
        await vi.waitFor(() => expect(snapshots.length).toBeGreaterThanOrEqual(1))
        socket.emit('message', { data: JSON.stringify({ ...snapshot, clientId: 'phone' }) })
        socket.emit('message', { data: JSON.stringify({
            type: 'runtime_startup_event',
            instanceId: 'server-instance-1',
            sequence: 2,
            eventType: 'prompt_settled',
            timestamp: 2,
            promptId: 'prompt-1',
            state: 'answered',
            reason: 'observer_response',
        }) })
        await vi.waitFor(() => expect(events).toHaveLength(1))
        expect(events[0]).not.toHaveProperty('response')

        stop()
    })

    it('polls through a half-open socket and ignores an older HTTP hydrate after WS state', async () => {
        let resolveFirstHydrate!: (response: Response) => void
        const firstHydrate = new Promise<Response>((resolve) => {
            resolveFirstHydrate = resolve
        })
        let hydrateCount = 0
        let socketCreated = false
        const makeSnapshot = (sequence: number): RuntimeStartupSnapshot => ({
            type: 'runtime_startup_snapshot',
            instanceId: 'server-instance-1',
            sequence,
            sessionId: 'startup-session-1',
            phase: 'waiting_for_ui',
            prompts: sequence === 1 ? [] : [{
                promptId: 'prompt-newer',
                prompt: { type: 'ask', msg: 'Allow?' },
                source: { kind: 'v3_permission' },
                createdAt: 1,
                expiresAt: 100,
            }],
            notices: [],
        })
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
            const path = String(input)
            if (path === '/runtime-startup') {
                hydrateCount += 1
                if (hydrateCount === 1) {
                    return await firstHydrate
                }
                return jsonResponse(makeSnapshot(3))
            }
            if (path === '/runtime-startup/socket-ticket') {
                return jsonResponse({
                    ticket: 'half-open-ticket',
                    path: '/runtime-startup/ws',
                    expiresAt: Date.now() + 30_000,
                })
            }
            throw new Error(`Unexpected request: ${path}`)
        }) as unknown as typeof fetch
        const socket = new FakeSocket()
        const sequences: number[] = []
        const client = new RuntimeStartupClient({
            fetchImpl,
            getAuth: async () => 'signed-auth',
            location: { protocol: 'https:', host: 'risu.example' },
            webSocketFactory: () => {
                socketCreated = true
                return socket
            },
            observerPollIntervalMs: 5,
        })

        const stop = client.watch('phone', {
            onSnapshot: (snapshot) => sequences.push(snapshot.sequence),
        })
        await vi.waitFor(() => expect(socketCreated).toBe(true))
        socket.emit('message', { data: JSON.stringify(makeSnapshot(2)) })
        resolveFirstHydrate(jsonResponse(makeSnapshot(1)))

        await vi.waitFor(() => expect(sequences).toContain(3))
        expect(sequences).toEqual([2, 3])
        stop()
    })

    it('abandons a stuck HTTP hydrate so a later fallback poll can recover', async () => {
        let hydrateCount = 0
        const recoveredSnapshot: RuntimeStartupSnapshot = {
            type: 'runtime_startup_snapshot',
            instanceId: 'server-instance-1',
            sequence: 1,
            sessionId: null,
            phase: 'unavailable',
            prompts: [],
            notices: [],
        }
        const fetchImpl = vi.fn(async (
            input: RequestInfo | URL,
            init: RequestInit = {},
        ) => {
            const path = String(input)
            if (path === '/runtime-startup') {
                hydrateCount += 1
                if (hydrateCount === 1) {
                    return await new Promise<Response>((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () => {
                            reject(init.signal?.reason ?? new Error('aborted'))
                        }, { once: true })
                    })
                }
                return jsonResponse(recoveredSnapshot)
            }
            if (path === '/runtime-startup/socket-ticket') {
                return jsonResponse({
                    ticket: 'half-open-ticket',
                    path: '/runtime-startup/ws',
                    expiresAt: Date.now() + 30_000,
                })
            }
            throw new Error(`Unexpected request: ${path}`)
        }) as unknown as typeof fetch
        const snapshots: RuntimeStartupSnapshot[] = []
        const stop = new RuntimeStartupClient({
            fetchImpl,
            getAuth: async () => 'signed-auth',
            location: { protocol: 'https:', host: 'risu.example' },
            webSocketFactory: () => new FakeSocket(),
            observerPollIntervalMs: 10,
            observerRequestTimeoutMs: 5,
        }).watch('phone', {
            onSnapshot: (snapshot) => snapshots.push(snapshot),
        })

        await vi.waitFor(() => expect(snapshots).toEqual([recoveredSnapshot]))
        expect(hydrateCount).toBeGreaterThanOrEqual(2)
        stop()
    })
})
