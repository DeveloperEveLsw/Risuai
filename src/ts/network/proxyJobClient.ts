import {
    ProxyJobStreamProtocolError,
    createProxyJobStreamCursorState,
    formatProxyStreamErrorMessage,
    parseProxyJobReplayPage,
    parseProxyJobWsEvent,
    reduceProxyJobStreamEvent,
    type ProxyJobSnapshotEvent,
    type ProxyJobStreamCursorState,
    type ProxyJobWsEvent,
} from './proxyJobWs'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const durableOpenAIInterceptors = new Set([
    'openai_streaming',
    'openai_response_api_streaming',
    'openai_tool',
    'openai_response_api_tool',
])

export function isDurableOpenAIProxyInterceptor(interceptor: string | undefined) {
    return interceptor !== undefined && durableOpenAIInterceptors.has(interceptor)
}

export interface ProxyJobWebSocketLike {
    onopen: ((event: Event) => unknown) | null
    onmessage: ((event: MessageEvent) => unknown) | null
    onerror: ((event: Event) => unknown) | null
    onclose: ((event: CloseEvent) => unknown) | null
    close(code?: number, reason?: string): void
}

export interface FetchDurableProxyJobOptions {
    baseUrl: string
    webSocketBaseUrl: string
    /** Returns a short-lived bearer immediately before each transport attempt. */
    getAuth: () => Promise<string>
    url: string
    method: 'POST' | 'GET' | 'PUT' | 'DELETE'
    body: Uint8Array
    headers?: Record<string, string>
    signal?: AbortSignal
    requestTimeoutMs?: number
    heartbeatSec?: number
    chatId?: string
    generationId?: string
    stepId?: string
    requestId?: string
    fetchImpl?: FetchLike
    webSocketFactory?: (url: string) => ProxyJobWebSocketLike
    randomUUID?: () => string
    replayPageSize?: number
    reconnectDelayMs?: number
    delay?: (milliseconds: number) => Promise<void>
    onChunk?: (bytes: Uint8Array) => void
    onTerminal?: (terminal: 'done' | 'error' | 'cancelled') => void
}

export class ProxyJobClientError extends Error {
    readonly acceptedJobId: string | null
    readonly status: number | undefined

    constructor(message: string, options: {
        acceptedJobId?: string | null
        status?: number
        cause?: unknown
    } = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause })
        this.name = 'ProxyJobClientError'
        this.acceptedJobId = options.acceptedJobId ?? null
        this.status = options.status
    }
}

class ProxyJobSequenceError extends Error {
    readonly minimumSequence: number
    readonly actualSequence: number

    constructor(minimumSequence: number, actualSequence: number) {
        super(`Proxy stream cursor regressed: expected at least ${minimumSequence}, received ${actualSequence}`)
        this.name = 'ProxyJobSequenceError'
        this.minimumSequence = minimumSequence
        this.actualSequence = actualSequence
    }
}

function defaultRandomUUID() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID()
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function defaultDelay(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function normalizeBaseUrl(value: string) {
    return value.endsWith('/') ? value.slice(0, -1) : value
}

function parseCreationResponse(value: unknown): { jobId: string } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    const jobId = (value as Record<string, unknown>).jobId
    return typeof jobId === 'string' && jobId.length > 0 ? { jobId } : null
}

function parseSocketTicketResponse(value: unknown, expectedPath: string): {
    ticket: string
    expiresAt: number
    path: string
} | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    const record = value as Record<string, unknown>
    if (
        typeof record.ticket !== 'string'
        || record.ticket.length === 0
        || typeof record.expiresAt !== 'number'
        || !Number.isSafeInteger(record.expiresAt)
        || record.expiresAt <= Date.now()
        || record.path !== expectedPath
    ) {
        return null
    }
    return {
        ticket: record.ticket,
        expiresAt: record.expiresAt,
        path: record.path,
    }
}

function abortError() {
    return new DOMException('The operation was aborted', 'AbortError')
}

/**
 * Starts (or idempotently re-attaches to) a durable proxy job and reconstructs
 * its response from the persisted event log. A transport disconnect never
 * reissues the upstream request and never cancels the job.
 */
export async function fetchDurableProxyJob(options: FetchDurableProxyJobOptions): Promise<Response> {
    const fetchImpl = options.fetchImpl ?? fetch
    const webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url))
    const delay = options.delay ?? defaultDelay
    const reconnectDelayMs = options.reconnectDelayMs ?? 100
    const replayPageSize = options.replayPageSize ?? 512
    const baseUrl = normalizeBaseUrl(options.baseUrl)
    const webSocketBaseUrl = normalizeBaseUrl(options.webSocketBaseUrl)
    const requestId = options.requestId ?? (options.randomUUID ?? defaultRandomUUID)()
    const idempotencyKey = requestId
    const generationId = options.generationId ?? options.chatId ?? requestId
    const stepId = options.stepId ?? requestId

    const createBody = JSON.stringify({
        requestId,
        idempotencyKey,
        generationId,
        chatId: options.chatId ?? null,
        stepId,
        context: { source: 'risu-native-openai-streaming' },
        url: options.url,
        method: options.method,
        headers: options.headers ?? {},
        bodyBase64: Buffer.from(options.body).toString('base64'),
        timeoutMs: options.requestTimeoutMs,
        heartbeatSec: options.heartbeatSec ?? 15,
    })

    // Do not bind job creation to the consumer signal. If an abort or response
    // loss races server acceptance, retrying this exact envelope is the only
    // safe way to recover the job id and either observe or cancel that one job.
    let creation: { jobId: string } | null = null
    while (!creation) {
        let createResponse: Response
        try {
            const auth = await options.getAuth()
            createResponse = await fetchImpl(`${baseUrl}/proxy-stream-jobs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': idempotencyKey,
                    'risu-auth': auth,
                },
                body: createBody,
            })
        }
        catch {
            await delay(reconnectDelayMs)
            continue
        }

        let rawCreationBody: string
        try {
            rawCreationBody = await createResponse.text()
        }
        catch {
            await delay(reconnectDelayMs)
            continue
        }
        let creationBody: unknown = null
        try {
            creationBody = JSON.parse(rawCreationBody)
        }
        catch {
            if (createResponse.ok) {
                await delay(reconnectDelayMs)
                continue
            }
        }
        creation = parseCreationResponse(creationBody)
        if (!createResponse.ok) {
            throw new ProxyJobClientError(
                `Proxy stream job creation failed: ${createResponse.status} ${rawCreationBody}`,
                {
                    acceptedJobId: creation?.jobId,
                    status: createResponse.status,
                },
            )
        }
        if (!creation) {
            await delay(reconnectDelayMs)
        }
    }

    const jobId = creation.jobId
    const encodedJobId = encodeURIComponent(jobId)
    const jobUrl = `${baseUrl}/proxy-stream-jobs/${encodedJobId}`
    const expectedSocketPath = `/proxy-stream-jobs/${encodedJobId}/ws`
    let sequenceCursor = 0
    let byteState: ProxyJobStreamCursorState = createProxyJobStreamCursorState()
    let pendingTerminalSnapshot: ProxyJobSnapshotEvent | null = null
    let status = 200
    let responseHeaders: HeadersInit = { 'content-type': 'text/event-stream' }
    let headersResolved = false
    let resolveHeaders: () => void = () => {}
    const waitForHeaders = new Promise<void>((resolve) => {
        resolveHeaders = resolve
    })
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    let activeSocket: ProxyJobWebSocketLike | null = null
    let terminal = false
    let locallyCancelled = false
    let cancelSent = false
    let acknowledgementSent = false
    let recovering = false
    let recoverAgain = false
    const textEncoder = new TextEncoder()

    const ensureHeaders = () => {
        if (!headersResolved) {
            headersResolved = true
            resolveHeaders()
        }
    }

    const detachAndCloseSocket = (socket: ProxyJobWebSocketLike | null) => {
        if (!socket) {
            return
        }
        if (activeSocket === socket) {
            activeSocket = null
        }
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
        try {
            socket.close()
        }
        catch {
            // A closed/broken observer does not affect the durable job.
        }
    }

    const acknowledgeOnce = (kind: 'done' | 'error') => {
        if (acknowledgementSent) {
            return
        }
        acknowledgementSent = true
        void (async () => {
            const auth = await options.getAuth()
            await fetchImpl(`${jobUrl}/ack`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'risu-auth': auth,
                },
                body: JSON.stringify({
                    requestId,
                    generationId,
                    stepId,
                    terminal: kind,
                    afterSequence: sequenceCursor,
                    offset: byteState.cursor,
                }),
            })
        })().catch(() => {})
    }

    const removeAbortListener = () => {
        options.signal?.removeEventListener('abort', abortHandler)
    }

    const finishTerminal = (kind: 'done' | 'error', event?: Extract<ProxyJobWsEvent, { type: 'error' }>) => {
        if (terminal || locallyCancelled) {
            return
        }
        const responseHeadersWereReady = headersResolved
        terminal = true
        removeAbortListener()
        detachAndCloseSocket(activeSocket)
        let streamError: ProxyJobClientError | null = null
        if (kind === 'error') {
            status = event?.status ?? 502
            responseHeaders = { 'content-type': 'text/plain; charset=utf-8' }
            streamError = new ProxyJobClientError(
                formatProxyStreamErrorMessage(event?.status, event?.message ?? ''),
                {
                    acceptedJobId: jobId,
                    status: event?.status,
                },
            )
        }
        ensureHeaders()
        if (streamController) {
            try {
                if (kind === 'error' && responseHeadersWereReady) {
                    streamController.error(streamError!)
                }
                else {
                    if (kind === 'error') {
                        streamController.enqueue(textEncoder.encode(streamError!.message))
                    }
                    streamController.close()
                }
            }
            catch {
                // The response consumer may already have cancelled its branch.
            }
        }
        options.onTerminal?.(kind)
        acknowledgeOnce(kind)
    }

    const cancelJobOnce = (source: 'abort' | 'stream_cancel') => {
        if (cancelSent || terminal) {
            return
        }
        cancelSent = true
        locallyCancelled = true
        removeAbortListener()
        detachAndCloseSocket(activeSocket)
        status = 499
        responseHeaders = { 'content-type': 'text/plain; charset=utf-8' }
        ensureHeaders()
        if (source === 'abort' && streamController) {
            try {
                streamController.error(abortError())
            }
            catch {
                // no-op
            }
        }
        options.onTerminal?.('cancelled')
        void (async () => {
            const auth = await options.getAuth()
            await fetchImpl(jobUrl, {
                method: 'DELETE',
                headers: { 'risu-auth': auth },
            })
        })().catch(() => {})
    }

    const abortHandler = () => cancelJobOnce('abort')

    const readable = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller
        },
        cancel() {
            cancelJobOnce('stream_cancel')
        },
    })

    const processEvent = (event: ProxyJobWsEvent): 'continue' | 'replay_terminal_snapshot' => {
        if (event.type === 'ping') {
            return 'continue'
        }
        if (event.type === 'job_snapshot') {
            if (event.jobId !== jobId) {
                throw new ProxyJobClientError(`Proxy job snapshot id mismatch: expected ${jobId}, received ${event.jobId}`, {
                    acceptedJobId: jobId,
                })
            }
            if (event.status !== undefined) {
                status = event.status
            }
            if (event.headers !== undefined) {
                responseHeaders = event.headers
                ensureHeaders()
            }
            if (event.state !== 'queued' && event.state !== 'running') {
                if (!pendingTerminalSnapshot || event.lastSequence >= pendingTerminalSnapshot.lastSequence) {
                    pendingTerminalSnapshot = event
                }
                return 'replay_terminal_snapshot'
            }
            return 'continue'
        }
        if (event.type === 'job_accepted') {
            return 'continue'
        }

        if (event.sequence === undefined) {
            throw new ProxyJobClientError(`Durable proxy event ${event.type} is missing its sequence`, {
                acceptedJobId: jobId,
            })
        }

        if (event.sequence <= sequenceCursor) {
            // Replayed transport events are still reduced so that a malformed
            // partial overlap cannot masquerade as a harmless duplicate.
            if (event.type === 'chunk' || event.type === 'done' || event.type === 'error') {
                const duplicate = reduceProxyJobStreamEvent(byteState, event)
                if (duplicate.action !== 'skip_duplicate') {
                    throw new ProxyJobClientError(
                        `Proxy stream sequence ${event.sequence} was already passed but its bytes were not consumed`,
                        { acceptedJobId: jobId },
                    )
                }
            }
            return 'continue'
        }

        const reduction = reduceProxyJobStreamEvent(byteState, event)
        byteState = reduction.state
        sequenceCursor = event.sequence

        if (event.type === 'upstream_headers') {
            status = event.status
            responseHeaders = event.headers
            ensureHeaders()
            return 'continue'
        }
        if (event.type === 'chunk') {
            ensureHeaders()
            if (reduction.action === 'append') {
                streamController?.enqueue(reduction.bytes)
                options.onChunk?.(reduction.bytes)
            }
            return 'continue'
        }
        if (event.type === 'error') {
            finishTerminal('error', event)
            return 'continue'
        }
        if (event.type === 'done') {
            finishTerminal('done')
        }
        return 'continue'
    }

    const finishUnloggedTerminalSnapshot = () => {
        const snapshot = pendingTerminalSnapshot
        if (!snapshot || sequenceCursor < snapshot.lastSequence || terminal || locallyCancelled) {
            return false
        }
        pendingTerminalSnapshot = null
        const cursorDetails = snapshot.cursor !== undefined && snapshot.cursor !== byteState.cursor
            ? `; snapshot byte cursor ${snapshot.cursor}, replayed ${byteState.cursor}`
            : ''
        const errorStatus = snapshot.state === 'cancelled' ? 499 : 502
        finishTerminal('error', {
            type: 'error',
            status: errorStatus,
            message: `Proxy stream job became ${snapshot.state} without a durable terminal event${cursorDetails}`,
            finalOffset: byteState.cursor,
        })
        return true
    }

    const replayAvailable = async () => {
        while (!terminal && !locallyCancelled) {
            const startCursor = sequenceCursor
            const auth = await options.getAuth()
            const response = await fetchImpl(
                `${jobUrl}/events?afterSequence=${sequenceCursor}&limit=${replayPageSize}`,
                {
                    method: 'GET',
                    headers: { 'risu-auth': auth },
                    cache: 'no-store',
                },
            )
            if (!response.ok) {
                throw new ProxyJobClientError(`Proxy stream replay failed: ${response.status}`, {
                    acceptedJobId: jobId,
                })
            }
            const page = parseProxyJobReplayPage(await response.text())
            if (!page) {
                throw new ProxyJobClientError('Proxy stream replay returned an invalid event page', {
                    acceptedJobId: jobId,
                })
            }
            let highestEventSequence = startCursor
            for (const event of page.events) {
                if (event.type !== 'job_snapshot' && event.type !== 'job_accepted' && event.type !== 'ping') {
                    if (event.sequence === undefined) {
                        throw new ProxyJobClientError(`Durable proxy event ${event.type} is missing its sequence`, {
                            acceptedJobId: jobId,
                        })
                    }
                    highestEventSequence = Math.max(highestEventSequence, event.sequence)
                }
                processEvent(event)
                if (terminal || locallyCancelled) {
                    return
                }
            }

            if (page.nextCursor < startCursor || page.nextCursor < highestEventSequence) {
                throw new ProxyJobSequenceError(Math.max(startCursor, highestEventSequence), page.nextCursor)
            }
            // nextCursor belongs to the raw store log. It may legitimately
            // advance over lifecycle records omitted from `events`.
            sequenceCursor = Math.max(sequenceCursor, page.nextCursor)

            if (!page.hasMore) {
                finishUnloggedTerminalSnapshot()
                return
            }
            if (sequenceCursor === startCursor) {
                throw new ProxyJobClientError('Proxy stream replay cursor did not advance', {
                    acceptedJobId: jobId,
                })
            }
        }
    }

    const scheduleRecovery = () => {
        if (terminal || locallyCancelled) {
            return
        }
        if (recovering) {
            recoverAgain = true
            return
        }
        recovering = true
        void (async () => {
            while (!terminal && !locallyCancelled) {
                recoverAgain = false
                try {
                    await replayAvailable()
                    if (terminal || locallyCancelled) {
                        break
                    }
                    const auth = await options.getAuth()
                    const ticketResponse = await fetchImpl(`${jobUrl}/socket-ticket`, {
                        method: 'POST',
                        headers: { 'risu-auth': auth },
                        cache: 'no-store',
                    })
                    if (!ticketResponse.ok) {
                        throw new ProxyJobClientError(`Proxy stream socket ticket failed: ${ticketResponse.status}`, {
                            acceptedJobId: jobId,
                            status: ticketResponse.status,
                        })
                    }
                    let ticketBody: unknown
                    try {
                        ticketBody = await ticketResponse.json()
                    }
                    catch (error) {
                        throw new ProxyJobClientError('Proxy stream socket ticket returned invalid JSON', {
                            acceptedJobId: jobId,
                            cause: error,
                        })
                    }
                    const socketTicket = parseSocketTicketResponse(ticketBody, expectedSocketPath)
                    if (!socketTicket) {
                        throw new ProxyJobClientError('Proxy stream socket ticket response was invalid or job path mismatched', {
                            acceptedJobId: jobId,
                        })
                    }
                    const wsUrl = `${webSocketBaseUrl}${socketTicket.path}`
                        + `?ticket=${encodeURIComponent(socketTicket.ticket)}`
                        + `&afterSequence=${sequenceCursor}`
                    const socket = webSocketFactory(wsUrl)
                    activeSocket = socket
                    socket.onopen = () => {}
                    socket.onmessage = (message) => {
                        if (activeSocket !== socket || terminal || locallyCancelled) {
                            return
                        }
                        const raw = typeof message.data === 'string' ? message.data : ''
                        const event = parseProxyJobWsEvent(raw)
                        if (!event) {
                            detachAndCloseSocket(socket)
                            scheduleRecovery()
                            return
                        }
                        try {
                            const action = processEvent(event)
                            if (action === 'replay_terminal_snapshot') {
                                detachAndCloseSocket(socket)
                                scheduleRecovery()
                            }
                        }
                        catch (error) {
                            if (error instanceof ProxyJobStreamProtocolError || error instanceof ProxyJobSequenceError || error instanceof ProxyJobClientError) {
                                detachAndCloseSocket(socket)
                                scheduleRecovery()
                                return
                            }
                            throw error
                        }
                    }
                    socket.onerror = () => {
                        if (activeSocket !== socket || terminal || locallyCancelled) {
                            return
                        }
                        detachAndCloseSocket(socket)
                        scheduleRecovery()
                    }
                    socket.onclose = () => {
                        if (activeSocket !== socket || terminal || locallyCancelled) {
                            return
                        }
                        activeSocket = null
                        scheduleRecovery()
                    }
                    break
                }
                catch {
                    if (!terminal && !locallyCancelled) {
                        await delay(reconnectDelayMs)
                    }
                }
            }
        })().finally(() => {
            recovering = false
            if (recoverAgain && !terminal && !locallyCancelled) {
                scheduleRecovery()
            }
        })
    }

    if (options.signal?.aborted) {
        abortHandler()
    }
    else {
        options.signal?.addEventListener('abort', abortHandler, { once: true })
    }
    scheduleRecovery()

    await waitForHeaders
    return new Response(readable, {
        status,
        headers: new Headers(responseHeaders),
    })
}
