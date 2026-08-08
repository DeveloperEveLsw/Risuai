import { describe, expect, it } from 'vitest'

import {
    ProxyJobClientError,
    fetchDurableProxyJob,
    isDurableOpenAIProxyInterceptor,
    type ProxyJobWebSocketLike,
} from './proxyJobClient'
import type { ProxyJobWsEvent } from './proxyJobWs'

type DurableRecord = ProxyJobWsEvent | null

class FakeWebSocket implements ProxyJobWebSocketLike {
    onopen: ((event: Event) => unknown) | null = null
    onmessage: ((event: MessageEvent) => unknown) | null = null
    onerror: ((event: Event) => unknown) | null = null
    onclose: ((event: CloseEvent) => unknown) | null = null
    closed = false

    emit(value: unknown) {
        this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent)
    }

    disconnect() {
        this.onclose?.({ code: 1006 } as CloseEvent)
    }

    close() {
        this.closed = true
    }
}

const base64 = (value: string) => Buffer.from(value).toString('base64')
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
})

async function waitFor(predicate: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) {
            return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('Timed out waiting for test condition')
}

function createHarness() {
    const records: DurableRecord[] = [
        null, // created
        null, // running
        {
            type: 'upstream_headers',
            sequence: 3,
            status: 200,
            headers: { 'content-type': 'text/plain' },
        },
    ]
    const sockets: FakeWebSocket[] = []
    const socketUrls: string[] = []
    const calls: Array<{ url: string, init: RequestInit }> = []
    let deleteCalls = 0
    let ackCalls = 0
    let ticketCalls = 0
    const authTokens: string[] = []
    const getAuth = async () => {
        const token = `fresh-auth-${authTokens.length + 1}`
        authTokens.push(token)
        return token
    }

    const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        calls.push({ url, init })
        if (url === '/proxy-stream-jobs' && init.method === 'POST') {
            return json({
                jobId: 'job-1',
                requestId: 'request-1',
                state: 'running',
                reused: calls.filter((call) => call.url === '/proxy-stream-jobs').length > 1,
            }, calls.filter((call) => call.url === '/proxy-stream-jobs').length > 1 ? 200 : 201)
        }
        if (url.includes('/events?')) {
            const parsed = new URL(url, 'http://test.local')
            const afterSequence = Number(parsed.searchParams.get('afterSequence'))
            const limit = Number(parsed.searchParams.get('limit'))
            const selected = records
                .map((event, index) => ({ event, sequence: index + 1 }))
                .filter((record) => record.sequence > afterSequence)
                .slice(0, limit)
            const nextCursor = selected.at(-1)?.sequence ?? afterSequence
            return json({
                events: selected.flatMap((record) => record.event ? [record.event] : []),
                nextCursor,
                hasMore: records.length > nextCursor,
            })
        }
        if (url === '/proxy-stream-jobs/job-1/socket-ticket' && init.method === 'POST') {
            ticketCalls += 1
            return json({
                ticket: `socket-ticket-${ticketCalls}`,
                expiresAt: Date.now() + 30_000,
                path: '/proxy-stream-jobs/job-1/ws',
            })
        }
        if (url.endsWith('/ack') && init.method === 'POST') {
            ackCalls += 1
            return json({ success: true })
        }
        if (url === '/proxy-stream-jobs/job-1' && init.method === 'DELETE') {
            deleteCalls += 1
            return json({ success: true, state: 'cancelled' })
        }
        throw new Error(`Unexpected fetch ${init.method ?? 'GET'} ${url}`)
    }

    const webSocketFactory = (url: string) => {
        socketUrls.push(url)
        const socket = new FakeWebSocket()
        sockets.push(socket)
        return socket
    }

    const append = (event: ProxyJobWsEvent & { sequence: number }) => {
        expect(event.sequence).toBe(records.length + 1)
        records.push(event)
    }

    const start = (overrides: Partial<Parameters<typeof fetchDurableProxyJob>[0]> = {}) => fetchDurableProxyJob({
        baseUrl: '',
        webSocketBaseUrl: 'ws://test.local',
        getAuth,
        url: 'http://127.0.0.1:1234/v1/chat/completions',
        method: 'POST',
        body: new TextEncoder().encode('{"stream":true}'),
        headers: { authorization: 'Bearer local' },
        chatId: 'chat-7',
        requestId: 'request-1',
        reconnectDelayMs: 0,
        delay: async () => {},
        fetchImpl,
        webSocketFactory,
        ...overrides,
    })

    return {
        records,
        sockets,
        socketUrls,
        calls,
        authTokens,
        getAuth,
        fetchImpl,
        webSocketFactory,
        append,
        start,
        get deleteCalls() { return deleteCalls },
        get ackCalls() { return ackCalls },
        get ticketCalls() { return ticketCalls },
    }
}

describe('fetchDurableProxyJob', () => {
    it('routes every local OpenAI streaming and tool continuation interceptor durably', () => {
        expect([
            'openai_streaming',
            'openai_response_api_streaming',
            'openai_tool',
            'openai_response_api_tool',
        ].every(isDurableOpenAIProxyInterceptor)).toBe(true)
        expect(isDurableOpenAIProxyInterceptor('anthropic')).toBe(false)
        expect(isDurableOpenAIProxyInterceptor(undefined)).toBe(false)
    })

    it('sends stable ownership/idempotency metadata before observing the job', async () => {
        const harness = createHarness()
        const responsePromise = harness.start()
        await waitFor(() => harness.sockets.length === 1)
        const create = harness.calls[0]
        const body = JSON.parse(String(create.init.body))

        expect(create.init.headers).toMatchObject({
            'Idempotency-Key': 'request-1',
            'risu-auth': 'fresh-auth-1',
        })
        expect(body).toMatchObject({
            requestId: 'request-1',
            idempotencyKey: 'request-1',
            generationId: 'chat-7',
            chatId: 'chat-7',
            stepId: 'request-1',
        })
        expect(harness.socketUrls[0]).toContain('afterSequence=3')
        expect(harness.socketUrls[0]).toContain('ticket=socket-ticket-1')
        expect(harness.socketUrls[0]).not.toContain('risu-auth')

        harness.append({ type: 'done', sequence: 4, finalOffset: 0, finalSequence: 4 })
        harness.sockets[0].emit(harness.records[3])
        await expect((await responsePromise).text()).resolves.toBe('')
    })

    it('reconnects to the same job and reconstructs exact bytes while skipping a full duplicate', async () => {
        const harness = createHarness()
        const response = await harness.start()
        await waitFor(() => harness.sockets.length === 1)
        const first = harness.sockets[0]

        harness.append({
            type: 'chunk',
            sequence: 4,
            offset: 0,
            endOffset: 3,
            dataBase64: base64('abc'),
        })
        first.emit(harness.records[3])
        harness.append({
            type: 'chunk',
            sequence: 5,
            offset: 3,
            endOffset: 6,
            dataBase64: base64('def'),
        })
        first.disconnect()

        await waitFor(() => harness.sockets.length === 2)
        expect(harness.socketUrls[1]).toContain('afterSequence=5')
        // A stale observer/replay may redeliver a fully consumed chunk.
        harness.sockets[1].emit(harness.records[4])
        harness.append({ type: 'done', sequence: 6, finalOffset: 6, finalSequence: 6 })
        harness.sockets[1].emit(harness.records[5])

        await expect(response.text()).resolves.toBe('abcdef')
        await waitFor(() => harness.ackCalls === 1)
        expect(harness.deleteCalls).toBe(0)
        expect(harness.calls.filter((call) => call.url === '/proxy-stream-jobs')).toHaveLength(1)
        expect(harness.calls.some((call) => call.url.includes('/proxy2'))).toBe(false)
    })

    it('uses fresh authentication for create, replay, each socket ticket, and acknowledgement', async () => {
        const harness = createHarness()
        const response = await harness.start()
        await waitFor(() => harness.sockets.length === 1)

        expect((harness.calls[0].init.headers as Record<string, string>)['risu-auth']).toBe('fresh-auth-1')
        const firstReplay = harness.calls.find((call) => call.url.includes('/events?'))!
        expect((firstReplay.init.headers as Record<string, string>)['risu-auth']).toBe('fresh-auth-2')
        const firstTicket = harness.calls.find((call) => call.url.endsWith('/socket-ticket'))!
        expect((firstTicket.init.headers as Record<string, string>)['risu-auth']).toBe('fresh-auth-3')
        expect(harness.socketUrls[0]).toContain('ticket=socket-ticket-1')
        expect(harness.socketUrls[0]).not.toContain('risu-auth')

        harness.sockets[0].disconnect()
        await waitFor(() => harness.sockets.length === 2)
        const replayCalls = harness.calls.filter((call) => call.url.includes('/events?'))
        expect((replayCalls[1].init.headers as Record<string, string>)['risu-auth']).toBe('fresh-auth-4')
        const ticketCalls = harness.calls.filter((call) => call.url.endsWith('/socket-ticket'))
        expect((ticketCalls[1].init.headers as Record<string, string>)['risu-auth']).toBe('fresh-auth-5')
        expect(harness.socketUrls[1]).toContain('ticket=socket-ticket-2')
        expect(harness.socketUrls[1]).not.toContain('risu-auth')

        harness.append({ type: 'done', sequence: 4, finalOffset: 0, finalSequence: 4 })
        harness.sockets[1].emit(harness.records[3])
        await expect(response.text()).resolves.toBe('')
        await waitFor(() => harness.ackCalls === 1)
        const ack = harness.calls.find((call) => call.url.endsWith('/ack'))!
        expect((ack.init.headers as Record<string, string>)['risu-auth']).toBe('fresh-auth-6')
        expect(new Set(harness.authTokens).size).toBe(harness.authTokens.length)
    })

    it('rejects a socket ticket for any path other than the accepted job websocket', async () => {
        const harness = createHarness()
        let mismatchedTicketAttempts = 0
        const fetchWithMismatchedPath = async (input: RequestInfo | URL, init: RequestInit = {}) => {
            if (String(input).endsWith('/socket-ticket') && mismatchedTicketAttempts === 0) {
                mismatchedTicketAttempts += 1
                return json({
                    ticket: 'wrong-job-ticket',
                    expiresAt: Date.now() + 30_000,
                    path: '/proxy-stream-jobs/another-job/ws',
                })
            }
            return await harness.fetchImpl(input, init)
        }

        const responsePromise = harness.start({ fetchImpl: fetchWithMismatchedPath })
        await waitFor(() => harness.sockets.length === 1)

        expect(mismatchedTicketAttempts).toBe(1)
        expect(harness.socketUrls[0].startsWith('ws://test.local/proxy-stream-jobs/job-1/ws?')).toBe(true)
        expect(harness.socketUrls[0]).toContain('ticket=socket-ticket-1')
        expect(harness.socketUrls[0]).not.toContain('wrong-job-ticket')
        expect(harness.socketUrls[0]).not.toContain('risu-auth')

        harness.append({ type: 'done', sequence: 4, finalOffset: 0, finalSequence: 4 })
        harness.sockets[0].emit(harness.records[3])
        await expect((await responsePromise).text()).resolves.toBe('')
    })

    it('retries a lost create request/response with the exact same idempotent envelope', async () => {
        const harness = createHarness()
        const attempts: Array<{ body: BodyInit | null | undefined, headers: HeadersInit | undefined }> = []
        let createAttempt = 0
        const retryingFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
            if (String(input) === '/proxy-stream-jobs' && init.method === 'POST') {
                attempts.push({ body: init.body, headers: init.headers })
                createAttempt += 1
                if (createAttempt === 1) {
                    throw new TypeError('response lost after server accepted request')
                }
                if (createAttempt === 2) {
                    const lostBody = json({ jobId: 'job-1', reused: true })
                    lostBody.text = async () => {
                        throw new TypeError('response body disconnected')
                    }
                    return lostBody
                }
            }
            return await harness.fetchImpl(input, init)
        }

        const responsePromise = harness.start({ fetchImpl: retryingFetch })
        await waitFor(() => harness.sockets.length === 1)
        expect(attempts).toHaveLength(3)
        expect(attempts.map((attempt) => attempt.body)).toEqual([
            attempts[0].body,
            attempts[0].body,
            attempts[0].body,
        ])
        expect(attempts.map((attempt) => (attempt.headers as Record<string, string>)['Idempotency-Key']))
            .toEqual(['request-1', 'request-1', 'request-1'])
        expect(attempts.map((attempt) => (attempt.headers as Record<string, string>)['risu-auth']))
            .toEqual(['fresh-auth-1', 'fresh-auth-2', 'fresh-auth-3'])

        harness.append({ type: 'done', sequence: 4, finalOffset: 0, finalSequence: 4 })
        harness.sockets[0].emit(harness.records[3])
        await expect((await responsePromise).text()).resolves.toBe('')
        expect(harness.calls.some((call) => call.url.includes('/proxy2'))).toBe(false)
    })

    it('skips a duplicated HTTP replay event before reconnecting', async () => {
        const harness = createHarness()
        const response = await harness.start()
        await waitFor(() => harness.sockets.length === 1)
        harness.append({
            type: 'chunk',
            sequence: 4,
            offset: 0,
            endOffset: 3,
            dataBase64: base64('one'),
        })
        harness.sockets[0].emit(harness.records[3])

        let duplicateSent = false
        const fetchWithDuplicate = async (input: RequestInfo | URL, init: RequestInit = {}) => {
            const url = String(input)
            if (!duplicateSent && url.includes('/events?afterSequence=4')) {
                duplicateSent = true
                return json({ events: [harness.records[3]], nextCursor: 4, hasMore: false })
            }
            return await harness.fetchImpl(input, init)
        }
        // The active observer was created with the original fetch function, so
        // create a re-attached observer to exercise duplicate HTTP recovery.
        const replayedResponsePromise = fetchDurableProxyJob({
            baseUrl: '',
            webSocketBaseUrl: 'ws://test.local',
            getAuth: harness.getAuth,
            url: 'http://127.0.0.1:1234/v1/chat/completions',
            method: 'POST',
            body: new TextEncoder().encode('{"stream":true}'),
            chatId: 'chat-7',
            requestId: 'request-1',
            reconnectDelayMs: 0,
            delay: async () => {},
            fetchImpl: fetchWithDuplicate,
            webSocketFactory: harness.webSocketFactory,
        })
        const replayedResponse = await replayedResponsePromise
        await waitFor(() => harness.sockets.length === 2)
        const replaySocket = harness.sockets.at(-1)!
        // Force recovery after this observer has reconstructed seq 4.
        replaySocket.disconnect()
        await waitFor(() => duplicateSent && harness.sockets.at(-1) !== replaySocket)
        const finalSocket = harness.sockets.at(-1)!

        harness.append({ type: 'done', sequence: 5, finalOffset: 3, finalSequence: 5 })
        // Complete both independent observers.
        harness.sockets[0].emit(harness.records[4])
        finalSocket.emit(harness.records[4])
        await expect(Promise.all([response.text(), replayedResponse.text()])).resolves.toEqual(['one', 'one'])
    })

    it('rejects a byte gap, replays from the last accepted sequence, and does not append corrupt bytes', async () => {
        const harness = createHarness()
        const response = await harness.start()
        await waitFor(() => harness.sockets.length === 1)

        harness.append({
            type: 'chunk',
            sequence: 4,
            offset: 0,
            endOffset: 2,
            dataBase64: base64('ok'),
        })
        harness.sockets[0].emit({
            type: 'chunk',
            sequence: 4,
            offset: 3,
            endOffset: 6,
            dataBase64: base64('bad'),
        })

        await waitFor(() => harness.sockets.length === 2)
        expect(harness.socketUrls[1]).toContain('afterSequence=4')
        harness.append({ type: 'done', sequence: 5, finalOffset: 2, finalSequence: 5 })
        harness.sockets[1].emit(harness.records[4])

        await expect(response.text()).resolves.toBe('ok')
        expect(harness.deleteCalls).toBe(0)
    })

    it('recovers a missing durable sequence before consuming later live bytes', async () => {
        const harness = createHarness()
        const response = await harness.start()
        await waitFor(() => harness.sockets.length === 1)
        harness.append({
            type: 'chunk',
            sequence: 4,
            offset: 0,
            endOffset: 1,
            dataBase64: base64('a'),
        })

        harness.sockets[0].emit({
            type: 'chunk',
            sequence: 5,
            offset: 1,
            endOffset: 2,
            dataBase64: base64('b'),
        })
        await waitFor(() => harness.sockets.length === 2)
        expect(harness.socketUrls[1]).toContain('afterSequence=4')

        harness.append({
            type: 'chunk',
            sequence: 5,
            offset: 1,
            endOffset: 2,
            dataBase64: base64('b'),
        })
        harness.sockets[1].emit(harness.records[4])
        harness.append({ type: 'done', sequence: 6, finalOffset: 2, finalSequence: 6 })
        harness.sockets[1].emit(harness.records[5])

        await expect(response.text()).resolves.toBe('ab')
    })

    it('allows hidden lifecycle sequence gaps while byte offsets remain exact', async () => {
        const harness = createHarness()
        const response = await harness.start()
        await waitFor(() => harness.sockets.length === 1)

        harness.records.push(null)
        harness.append({
            type: 'chunk',
            sequence: 5,
            offset: 0,
            endOffset: 1,
            dataBase64: base64('x'),
        })
        harness.sockets[0].emit(harness.records[4])
        harness.records.push(null)
        harness.append({ type: 'done', sequence: 7, finalOffset: 1, finalSequence: 7 })
        harness.sockets[0].emit(harness.records[6])

        await expect(response.text()).resolves.toBe('x')
        expect(harness.deleteCalls).toBe(0)
    })

    it('replays bytes created before a completed snapshot before accepting its durable done event', async () => {
        const harness = createHarness()
        const response = await harness.start()
        await waitFor(() => harness.sockets.length === 1)

        harness.append({
            type: 'chunk',
            sequence: 4,
            offset: 0,
            endOffset: 3,
            dataBase64: base64('abc'),
        })
        harness.append({ type: 'done', sequence: 5, finalOffset: 3, finalSequence: 5 })
        harness.records.push(null) // completed lifecycle record, hidden on the wire
        harness.sockets[0].emit({
            type: 'job_snapshot',
            jobId: 'job-1',
            state: 'completed',
            lastSequence: 6,
            cursor: 3,
            status: 200,
            headers: { 'content-type': 'text/plain' },
        })

        await expect(response.text()).resolves.toBe('abc')
        await waitFor(() => harness.ackCalls === 1)
        expect(harness.sockets).toHaveLength(1)
    })

    it('terminates an interrupted snapshot after replay instead of reconnecting forever', async () => {
        const harness = createHarness()
        const replayed: string[] = []
        const response = await harness.start({
            onChunk: (bytes) => replayed.push(new TextDecoder().decode(bytes)),
        })
        await waitFor(() => harness.sockets.length === 1)

        harness.append({
            type: 'chunk',
            sequence: 4,
            offset: 0,
            endOffset: 3,
            dataBase64: base64('abc'),
        })
        harness.records.push(null) // interrupted lifecycle record
        harness.sockets[0].emit({
            type: 'job_snapshot',
            jobId: 'job-1',
            state: 'interrupted',
            lastSequence: 5,
            cursor: 3,
            status: 200,
            headers: { 'content-type': 'text/plain' },
        })

        const reader = response.body!.getReader()
        const replayedChunk = await reader.read()
        expect(new TextDecoder().decode(replayedChunk.value)).toBe('abc')
        await expect(reader.read()).rejects.toMatchObject({
            name: 'ProxyJobClientError',
            acceptedJobId: 'job-1',
        })
        expect(replayed).toEqual(['abc'])
        expect(harness.sockets).toHaveLength(1)
    })

    it('accepts snapshot headers without advancing either durable cursor', async () => {
        const harness = createHarness()
        harness.records.pop()
        const responsePromise = harness.start()
        await waitFor(() => harness.sockets.length === 1)
        harness.sockets[0].emit({
            type: 'job_snapshot',
            jobId: 'job-1',
            state: 'running',
            lastSequence: 2,
            cursor: 0,
            status: 202,
            headers: { 'content-type': 'text/event-stream', 'x-from-snapshot': 'yes' },
        })
        const response = await responsePromise
        expect(response.status).toBe(202)
        expect(response.headers.get('x-from-snapshot')).toBe('yes')

        harness.append({
            type: 'upstream_headers',
            sequence: 3,
            status: 202,
            headers: { 'content-type': 'text/event-stream' },
        })
        harness.sockets[0].emit(harness.records[2])
        harness.append({ type: 'done', sequence: 4, finalOffset: 0, finalSequence: 4 })
        harness.sockets[0].emit(harness.records[3])
        await expect(response.text()).resolves.toBe('')
    })

    it('errors the response stream when upstream fails after headers', async () => {
        const harness = createHarness()
        const response = await harness.start()
        await waitFor(() => harness.sockets.length === 1)

        harness.append({
            type: 'chunk',
            sequence: 4,
            offset: 0,
            endOffset: 7,
            dataBase64: base64('partial'),
        })
        harness.sockets[0].emit(harness.records[3])
        harness.append({
            type: 'error',
            sequence: 5,
            status: 502,
            message: 'upstream disconnected',
            finalOffset: 7,
        })
        harness.sockets[0].emit(harness.records[4])

        await expect(response.body!.getReader().read()).rejects.toEqual(expect.objectContaining({
            name: 'ProxyJobClientError',
            acceptedJobId: 'job-1',
            status: 502,
            message: 'upstream disconnected',
        }))
        await waitFor(() => harness.ackCalls === 1)
    })

    it('lets two observers independently consume one idempotent job', async () => {
        const harness = createHarness()
        const [desktop, phone] = await Promise.all([
            harness.start(),
            harness.start(),
        ])
        await waitFor(() => harness.sockets.length === 2)
        expect(harness.sockets).toHaveLength(2)

        harness.append({
            type: 'chunk',
            sequence: 4,
            offset: 0,
            endOffset: 6,
            dataBase64: base64('shared'),
        })
        for (const socket of harness.sockets) {
            socket.emit(harness.records[3])
        }
        harness.append({ type: 'done', sequence: 5, finalOffset: 6, finalSequence: 5 })
        for (const socket of harness.sockets) {
            socket.emit(harness.records[4])
        }

        await expect(Promise.all([desktop.text(), phone.text()])).resolves.toEqual(['shared', 'shared'])
        const creates = harness.calls.filter((call) => call.url === '/proxy-stream-jobs')
        expect(creates).toHaveLength(2)
        expect(creates.map((call) => (call.init.headers as Record<string, string>)['Idempotency-Key']))
            .toEqual(['request-1', 'request-1'])
        expect(creates.map((call) => call.init.body)).toEqual([creates[0].init.body, creates[0].init.body])
        expect(harness.deleteCalls).toBe(0)
    })

    it('keeps abort active after response headers and sends DELETE exactly once', async () => {
        const harness = createHarness()
        const abortController = new AbortController()
        const response = await harness.start({ signal: abortController.signal })
        await waitFor(() => harness.sockets.length === 1)

        abortController.abort()
        abortController.abort()
        harness.sockets[0].disconnect()

        await expect(response.text()).rejects.toMatchObject({ name: 'AbortError' })
        await waitFor(() => harness.deleteCalls === 1)
        expect(harness.deleteCalls).toBe(1)
        expect(harness.ackCalls).toBe(0)
        const deletion = harness.calls.find((call) => call.init.method === 'DELETE')!
        expect((deletion.init.headers as Record<string, string>)['risu-auth']).toBe('fresh-auth-4')
    })

    it('treats ReadableStream cancellation as explicit consumer cancellation', async () => {
        const harness = createHarness()
        const response = await harness.start()
        const reader = response.body!.getReader()

        await reader.cancel('consumer stopped parsing')
        await waitFor(() => harness.deleteCalls === 1)

        expect(harness.deleteCalls).toBe(1)
        expect(harness.ackCalls).toBe(0)
    })
})
