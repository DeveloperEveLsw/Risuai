import { describe, expect, it, vi } from 'vitest'

vi.mock('../storage/nodeStorage', () => ({
    getNodeServerProxyAuth: vi.fn(async () => 'default-auth'),
}))

import {
    isRuntimeGenerationKeepaliveSafe,
    RUNTIME_GENERATION_KEEPALIVE_MAX_BYTES,
    RuntimeGenerationClient,
    RuntimeGenerationHttpError,
    type RuntimeGenerationCreateInput,
} from './generationClient'

function command(overrides: Record<string, unknown> = {}) {
    return {
        commandId: 'command-1',
        requestId: 'request-1',
        action: 'send',
        characterId: 'character-1',
        chatId: 'chat-1',
        state: 'queued',
        createdAt: 1,
        updatedAt: 1,
        startedAt: null,
        finishedAt: null,
        interruptedAt: null,
        cancelRequestedAt: null,
        executorId: null,
        fencingToken: null,
        leaseExpiresAt: null,
        result: null,
        error: null,
        lastSequence: 1,
        ...overrides,
    }
}

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

class FakeWebSocket {
    readyState = 1
    readonly closes: Array<[number | undefined, string | undefined]> = []
    private readonly listeners = new Map<string, Set<(event: any) => void>>()

    addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set()
        listeners.add(listener)
        this.listeners.set(type, listeners)
    }

    close(code?: number, reason?: string) {
        this.readyState = 3
        this.closes.push([code, reason])
    }

    message(value: unknown) {
        this.emit('message', { data: JSON.stringify(value) })
    }

    serverClose() {
        this.readyState = 3
        this.emit('close', {})
    }

    private emit(type: string, event: unknown) {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event)
        }
    }
}

describe('RuntimeGenerationClient', () => {
    it('classifies the exact serialized UTF-8 keepalive boundary', () => {
        const requestId = '00000000-0000-4000-8000-000000000010'
        const input: RuntimeGenerationCreateInput = {
            requestId,
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: '' },
        }
        const emptyBody = JSON.stringify({
            requestId,
            action: input.action,
            characterId: input.characterId,
            chatId: input.chatId,
            payload: input.payload,
        })
        const emptyBytes = new TextEncoder().encode(emptyBody).byteLength
        const exactInput: RuntimeGenerationCreateInput = {
            ...input,
            payload: {
                input: 'a'.repeat(RUNTIME_GENERATION_KEEPALIVE_MAX_BYTES - emptyBytes),
            },
        }
        const exactBody = JSON.stringify({
            requestId,
            action: exactInput.action,
            characterId: exactInput.characterId,
            chatId: exactInput.chatId,
            payload: exactInput.payload,
        })

        expect(new TextEncoder().encode(exactBody).byteLength)
            .toBe(RUNTIME_GENERATION_KEEPALIVE_MAX_BYTES)
        expect(isRuntimeGenerationKeepaliveSafe(exactInput)).toBe(true)
        expect(isRuntimeGenerationKeepaliveSafe({
            ...exactInput,
            payload: { input: `${exactInput.payload?.input}가` },
        })).toBe(false)
    })

    it('creates an idempotent keepalive command suitable for page navigation', async () => {
        const requestId = '00000000-0000-4000-8000-000000000001'
        const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            jsonResponse(command({ requestId, reused: false }), 201))
        const client = new RuntimeGenerationClient({
            fetchImpl: fetchImpl as typeof fetch,
            getAuth: async () => 'signed-auth',
            cryptoImpl: { randomUUID: () => requestId },
            location: { protocol: 'https:', host: 'risu.example' },
        })

        const created = await client.create({
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'hello' },
        })

        expect(created.commandId).toBe('command-1')
        expect(fetchImpl).toHaveBeenCalledOnce()
        const [path, init] = fetchImpl.mock.calls[0]
        if (!init) {
            throw new Error('Expected request init')
        }
        expect(path).toBe('/runtime-generations')
        expect(init).toMatchObject({ method: 'POST', keepalive: true })
        expect(init.headers).toMatchObject({
            'risu-auth': 'signed-auth',
            'Idempotency-Key': requestId,
        })
        expect(JSON.parse(init.body as string)).toMatchObject({
            requestId,
            action: 'send',
            payload: { input: 'hello' },
        })
    })

    it('omits keepalive when a long command exceeds the browser request quota', async () => {
        const requestId = '00000000-0000-4000-8000-000000000011'
        const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
            jsonResponse(command({ requestId, reused: false }), 201))
        const client = new RuntimeGenerationClient({
            fetchImpl: fetchImpl as typeof fetch,
            getAuth: async () => 'signed-auth',
            cryptoImpl: { randomUUID: () => requestId },
            location: { protocol: 'https:', host: 'risu.example' },
        })

        await client.create({
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: '가'.repeat(30_000) },
        })

        const init = fetchImpl.mock.calls[0][1]
        expect(init?.keepalive).toBeUndefined()
        expect(new TextEncoder().encode(init?.body as string).byteLength).toBeGreaterThan(64 * 1024)
    })

    it('parses executor claims and carries the fencing lease', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({
            claimed: true,
            command: command({ state: 'running', fencingToken: 7 }),
            lease: { executorId: 'resident-1', fencingToken: 7, expiresAt: 20_000 },
        }))
        const client = new RuntimeGenerationClient({
            fetchImpl: fetchImpl as typeof fetch,
            getAuth: async () => 'auth',
            location: { protocol: 'http:', host: 'localhost' },
        })

        const claimed = await client.claimNext('resident-1', 15_000)

        expect(claimed?.command.state).toBe('running')
        expect(claimed?.lease).toEqual({
            executorId: 'resident-1',
            fencingToken: 7,
            expiresAt: 20_000,
        })
    })

    it('posts cancellation completion with the original executor fence', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ success: true }))
        const client = new RuntimeGenerationClient({
            fetchImpl: fetchImpl as typeof fetch,
            getAuth: async () => 'auth',
            location: { protocol: 'http:', host: 'localhost' },
        })

        await client.completeCancellation(
            'command-1',
            { executorId: 'resident-1', fencingToken: 7, expiresAt: 20_000 },
            { databaseRevision: 12, canonicalMutationPersisted: true },
        )

        expect(fetchImpl).toHaveBeenCalledWith(
            '/runtime-generations/command-1/cancel-complete',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    executorId: 'resident-1',
                    fencingToken: 7,
                    result: { databaseRevision: 12, canonicalMutationPersisted: true },
                }),
            }),
        )
    })

    it('surfaces structured server conflicts without retrying a different command', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({
            error: 'requestId is already associated with a different request',
            code: 'IDEMPOTENCY_CONFLICT',
        }, 409))
        const client = new RuntimeGenerationClient({
            fetchImpl: fetchImpl as typeof fetch,
            getAuth: async () => 'auth',
            location: { protocol: 'http:', host: 'localhost' },
        })

        const error = await client.create({
            requestId: 'request-1',
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'different' },
        }).catch((caught) => caught)
        expect(error).toBeInstanceOf(RuntimeGenerationHttpError)
        expect(error).toMatchObject({
            status: 409,
            message: 'requestId is already associated with a different request',
        })
        expect(fetchImpl).toHaveBeenCalledOnce()
    })

    it('retries a lost create response with the identical idempotent command envelope', async () => {
        const requestId = '00000000-0000-4000-8000-000000000002'
        const getAuth = vi.fn()
            .mockResolvedValueOnce('auth-1')
            .mockResolvedValueOnce('auth-2')
        const fetchImpl = vi.fn()
            .mockRejectedValueOnce(new TypeError('connection reset after acceptance'))
            .mockResolvedValueOnce(jsonResponse(command({ requestId, reused: true })))
        const client = new RuntimeGenerationClient({
            fetchImpl: fetchImpl as typeof fetch,
            getAuth,
            cryptoImpl: { randomUUID: () => requestId },
            reconnectDelayMs: 0,
            location: { protocol: 'https:', host: 'risu.example' },
        })

        const created = await client.create({
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'once' },
        })

        expect(created.reused).toBe(true)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect(getAuth).toHaveBeenCalledTimes(2)
        expect(fetchImpl.mock.calls[0][1]?.body).toBe(fetchImpl.mock.calls[1][1]?.body)
        expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
            'Idempotency-Key': requestId,
            'risu-auth': 'auth-1',
        })
        expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({
            'Idempotency-Key': requestId,
            'risu-auth': 'auth-2',
        })
    })

    it('lets Stop abort an offline create retry before a command is observed', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new TypeError('server offline'))
        const client = new RuntimeGenerationClient({
            fetchImpl: fetchImpl as typeof fetch,
            getAuth: async () => 'auth',
            reconnectDelayMs: 60_000,
            location: { protocol: 'https:', host: 'risu.example' },
        })
        const controller = new AbortController()
        const pending = client.create({
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'keep this draft' },
        }, controller.signal)
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())

        controller.abort(new Error('generation cancelled by user'))

        await expect(pending).rejects.toThrow('generation cancelled by user')
        expect(fetchImpl).toHaveBeenCalledOnce()
    })

    it('retries an ambiguous UI prompt response and returns the durable winning event', async () => {
        const event = {
            type: 'generation_event',
            commandId: 'command-1',
            sequence: 4,
            eventType: 'ui_prompt_response',
            timestamp: 10,
            payload: { promptId: 'prompt-1', responded: true },
        }
        const fetchImpl = vi.fn()
            .mockRejectedValueOnce(new TypeError('response lost'))
            .mockResolvedValueOnce(jsonResponse({
                success: true,
                accepted: false,
                reused: true,
                event,
            }))
        const client = new RuntimeGenerationClient({
            fetchImpl: fetchImpl as typeof fetch,
            getAuth: async () => 'auth',
            reconnectDelayMs: 0,
            location: { protocol: 'https:', host: 'risu.example' },
        })

        await expect(client.respondToUiPrompt('command-1', 'prompt-1', 'desktop')).resolves.toEqual({
            accepted: false,
            reused: true,
            event,
        })
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect(fetchImpl.mock.calls[0][0]).toBe(
            '/runtime-generations/command-1/ui-prompts/prompt-1/response',
        )
        expect(fetchImpl.mock.calls[0][1]?.body).toBe(fetchImpl.mock.calls[1][1]?.body)
    })

    it('retrieves the sensitive prompt value only through the fenced executor mailbox', async () => {
        const fetchImpl = vi.fn()
            .mockRejectedValueOnce(new TypeError('mailbox response lost'))
            .mockResolvedValueOnce(jsonResponse({ response: 'secret-api-key' }))
        const client = new RuntimeGenerationClient({
            fetchImpl: fetchImpl as typeof fetch,
            getAuth: async () => 'auth',
            reconnectDelayMs: 0,
            location: { protocol: 'https:', host: 'risu.example' },
        })

        await expect(client.getUiPromptResponse(
            'command-1',
            'prompt-1',
            { executorId: 'resident-1', fencingToken: 7, expiresAt: 20_000 },
        )).resolves.toBe('secret-api-key')
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect(fetchImpl.mock.calls[0][0]).toBe(
            '/runtime-generations/command-1/ui-prompts/prompt-1/consume-response',
        )
        expect(fetchImpl.mock.calls[0][1]?.body).toBe(fetchImpl.mock.calls[1][1]?.body)
    })

    it('retries ambiguous UI prompt issuance with the same fenced prompt ID', async () => {
        const fetchImpl = vi.fn()
            .mockRejectedValueOnce(new TypeError('issue response lost'))
            .mockResolvedValueOnce(jsonResponse({ success: true, reused: true }))
        const client = new RuntimeGenerationClient({
            fetchImpl: fetchImpl as typeof fetch,
            getAuth: async () => 'auth',
            reconnectDelayMs: 0,
            location: { protocol: 'https:', host: 'risu.example' },
        })

        await client.progress(
            'command-1',
            { executorId: 'resident-1', fencingToken: 7, expiresAt: 20_000 },
            'ui_prompt',
            {
                promptId: 'prompt-1',
                prompt: { type: 'ask', msg: 'Allow?' },
            },
        )

        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect(fetchImpl.mock.calls[0][1]?.body).toBe(fetchImpl.mock.calls[1][1]?.body)
        expect(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string)).toMatchObject({
            executorId: 'resident-1',
            fencingToken: 7,
            eventType: 'ui_prompt',
            payload: { promptId: 'prompt-1' },
        })
    })

    it('stops UI prompt transport retries as soon as the resident command aborts', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new TypeError('offline'))
        const client = new RuntimeGenerationClient({
            fetchImpl: fetchImpl as typeof fetch,
            getAuth: async () => 'auth',
            reconnectDelayMs: 60_000,
            location: { protocol: 'https:', host: 'risu.example' },
        })
        const controller = new AbortController()
        const pending = client.progress(
            'command-1',
            { executorId: 'resident-1', fencingToken: 7, expiresAt: 20_000 },
            'ui_prompt',
            { promptId: 'prompt-abort', prompt: { type: 'ask', msg: 'Allow?' } },
            controller.signal,
        )
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())

        controller.abort(new Error('command cancelled'))

        await expect(pending).rejects.toThrow('command cancelled')
        expect(fetchImpl).toHaveBeenCalledOnce()
    })

    it('keeps watching and retries the terminal GET with fresh auth after a transient failure', async () => {
        vi.useFakeTimers()
        try {
            const getAuth = vi.fn()
                .mockResolvedValueOnce('ticket-auth')
                .mockRejectedValueOnce(new Error('temporary signer failure'))
                .mockResolvedValueOnce('terminal-auth')
            const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
                const path = String(input)
                if (path.endsWith('/socket-ticket')) {
                    return jsonResponse({
                        ticket: 'ticket-1',
                        path: '/runtime-generations/command-1/ws',
                    })
                }
                if (path === '/runtime-generations/command-1') {
                    return jsonResponse(command({
                        state: 'completed',
                        finishedAt: 2,
                        lastSequence: 1,
                    }))
                }
                throw new Error(`Unexpected request ${path}`)
            })
            const sockets: FakeWebSocket[] = []
            const onTerminal = vi.fn()
            const onError = vi.fn()
            const client = new RuntimeGenerationClient({
                fetchImpl: fetchImpl as typeof fetch,
                getAuth,
                webSocketFactory: () => {
                    const socket = new FakeWebSocket()
                    sockets.push(socket)
                    return socket
                },
                reconnectDelayMs: 100,
                location: { protocol: 'https:', host: 'risu.example' },
            })

            client.watch('command-1', { onTerminal, onError })
            await vi.advanceTimersByTimeAsync(0)
            expect(sockets).toHaveLength(1)

            sockets[0].message({
                type: 'generation_event',
                commandId: 'command-1',
                sequence: 1,
                eventType: 'completed',
                timestamp: 2,
                payload: {},
            })
            await vi.advanceTimersByTimeAsync(0)

            expect(onError).toHaveBeenCalledOnce()
            expect(onTerminal).not.toHaveBeenCalled()
            expect(sockets[0].closes).toHaveLength(0)
            await vi.advanceTimersByTimeAsync(99)
            expect(onTerminal).not.toHaveBeenCalled()

            await vi.advanceTimersByTimeAsync(1)
            expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({
                commandId: 'command-1',
                state: 'completed',
            }))
            expect(sockets[0].closes).toContainEqual([1000, 'terminal'])
            expect(getAuth).toHaveBeenCalledTimes(3)
            expect(fetchImpl).toHaveBeenCalledTimes(2)

            await vi.advanceTimersByTimeAsync(1_000)
            expect(getAuth).toHaveBeenCalledTimes(3)
        }
        finally {
            vi.useRealTimers()
        }
    })

    it('continues reconnect scheduling when a replacement socket ticket request fails', async () => {
        vi.useFakeTimers()
        try {
            const getAuth = vi.fn()
                .mockResolvedValueOnce('auth-1')
                .mockRejectedValueOnce(new Error('temporary auth failure'))
                .mockResolvedValueOnce('auth-3')
            let ticket = 0
            const fetchImpl = vi.fn(async () => jsonResponse({
                ticket: `ticket-${++ticket}`,
                path: '/runtime-generations/command-1/ws',
            }))
            const sockets: FakeWebSocket[] = []
            const onError = vi.fn()
            const client = new RuntimeGenerationClient({
                fetchImpl: fetchImpl as typeof fetch,
                getAuth,
                webSocketFactory: () => {
                    const socket = new FakeWebSocket()
                    sockets.push(socket)
                    return socket
                },
                reconnectDelayMs: 50,
                location: { protocol: 'https:', host: 'risu.example' },
            })

            const stop = client.watch('command-1', { onError })
            await vi.advanceTimersByTimeAsync(0)
            expect(sockets).toHaveLength(1)
            sockets[0].serverClose()

            await vi.advanceTimersByTimeAsync(50)
            expect(sockets).toHaveLength(1)
            expect(onError).toHaveBeenCalledOnce()
            await vi.advanceTimersByTimeAsync(49)
            expect(sockets).toHaveLength(1)
            await vi.advanceTimersByTimeAsync(1)

            expect(sockets).toHaveLength(2)
            expect(getAuth).toHaveBeenCalledTimes(3)
            expect(fetchImpl).toHaveBeenCalledTimes(2)
            stop()
        }
        finally {
            vi.useRealTimers()
        }
    })
})
