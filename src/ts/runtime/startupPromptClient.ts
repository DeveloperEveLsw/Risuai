import { getNodeServerProxyAuth } from '../storage/nodeStorage'
import type { alertData } from '../alert'

export type RuntimeStartupPhase =
    | 'loading_data'
    | 'loading_plugins'
    | 'starting_executor'
    | 'waiting_for_ui'
    | 'claim_ready'
    | 'unavailable'

export interface RuntimeStartupPromptSource {
    kind: string
    pluginName?: string
    pluginVersion?: string
    permission?: string
    pluginScriptHash?: string
    permissionPolicy?: string
}

export interface RuntimeStartupPublicPrompt {
    promptId: string
    prompt: alertData
    source: RuntimeStartupPromptSource
    createdAt: number
    expiresAt: number
}

export interface RuntimeStartupPublicNotice {
    noticeId: string
    notice: alertData
    source: RuntimeStartupPromptSource
    createdAt: number
    expiresAt: number
}

export interface RuntimeStartupSnapshot {
    type: 'runtime_startup_snapshot'
    instanceId: string
    sequence: number
    sessionId: string | null
    phase: RuntimeStartupPhase
    prompts: RuntimeStartupPublicPrompt[]
    notices: RuntimeStartupPublicNotice[]
    clientId?: string
}

export interface RuntimeStartupEvent {
    type: 'runtime_startup_event'
    instanceId: string
    sequence: number
    eventType: 'session_started' | 'session_expired' | 'phase_changed'
        | 'prompt_created' | 'prompt_settled' | 'notice_created' | 'notice_expired'
    timestamp: number
    sessionId?: string
    phase?: RuntimeStartupPhase
    prompt?: RuntimeStartupPublicPrompt
    promptId?: string
    state?: string
    reason?: string
    notice?: RuntimeStartupPublicNotice
    noticeId?: string
}

export interface RuntimeStartupSession {
    sessionId: string
    producerId: string
    fencingToken: number
    phase: RuntimeStartupPhase
    expiresAt: number
    reused: boolean
}

interface WebSocketLike {
    readonly readyState: number
    addEventListener(type: string, listener: (event: any) => void): void
    close(code?: number, reason?: string): void
}

export interface RuntimeStartupClientOptions {
    getAuth?: () => Promise<string>
    fetchImpl?: typeof fetch
    webSocketFactory?: (url: string) => WebSocketLike
    location?: Pick<Location, 'protocol' | 'host'>
    cryptoImpl?: Pick<Crypto, 'randomUUID'>
    pollIntervalMs?: number
    reconnectDelayMs?: number
    observerPollIntervalMs?: number
    observerRequestTimeoutMs?: number
}

export interface RuntimeStartupWatchHandlers {
    onSnapshot?: (snapshot: RuntimeStartupSnapshot) => void
    onEvent?: (event: RuntimeStartupEvent) => void
    onError?: (error: Error) => void
}

export class RuntimeStartupHttpError extends Error {
    readonly status: number
    readonly body: unknown

    constructor(status: number, body: unknown) {
        super(
            isRecord(body) && typeof body.error === 'string'
                ? body.error
                : `Runtime startup request failed (${status})`,
        )
        this.name = 'RuntimeStartupHttpError'
        this.status = status
        this.body = body
    }
}

class RuntimeStartupTransportError extends Error {
    constructor(message: string, cause: unknown) {
        super(message, { cause })
        this.name = 'RuntimeStartupTransportError'
    }
}

function isRetryableStartupError(error: unknown) {
    return error instanceof RuntimeStartupTransportError
        || (
            error instanceof RuntimeStartupHttpError
            && (error.status === 408 || error.status === 429 || error.status >= 500)
        )
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function runtimeAbortError(signal: AbortSignal) {
    if (signal.reason instanceof Error) {
        return signal.reason
    }
    const error = new Error(
        typeof signal.reason === 'string' ? signal.reason : 'Runtime startup request aborted',
    )
    error.name = 'AbortError'
    return error
}

function delay(milliseconds: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(runtimeAbortError(signal))
            return
        }
        const onAbort = () => {
            clearTimeout(timer)
            reject(runtimeAbortError(signal!))
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, milliseconds)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

async function readJson(response: Response): Promise<unknown> {
    const text = await response.text()
    if (!text) {
        return null
    }
    try {
        return JSON.parse(text)
    }
    catch {
        throw new Error(`Expected JSON from runtime startup endpoint (${response.status})`)
    }
}

function asSession(value: unknown): RuntimeStartupSession {
    if (
        !isRecord(value)
        || typeof value.sessionId !== 'string'
        || typeof value.producerId !== 'string'
        || !Number.isSafeInteger(value.fencingToken)
        || typeof value.phase !== 'string'
        || typeof value.expiresAt !== 'number'
        || typeof value.reused !== 'boolean'
    ) {
        throw new Error('Malformed runtime startup session response')
    }
    return value as unknown as RuntimeStartupSession
}

function asPublicPrompt(value: unknown): RuntimeStartupPublicPrompt | null {
    if (
        !isRecord(value)
        || typeof value.promptId !== 'string'
        || !isRecord(value.prompt)
        || typeof value.prompt.type !== 'string'
        || typeof value.prompt.msg !== 'string'
        || !isRecord(value.source)
        || typeof value.source.kind !== 'string'
        || typeof value.createdAt !== 'number'
        || typeof value.expiresAt !== 'number'
    ) {
        return null
    }
    return value as unknown as RuntimeStartupPublicPrompt
}

function asPublicNotice(value: unknown): RuntimeStartupPublicNotice | null {
    if (
        !isRecord(value)
        || typeof value.noticeId !== 'string'
        || !isRecord(value.notice)
        || typeof value.notice.type !== 'string'
        || typeof value.notice.msg !== 'string'
        || !isRecord(value.source)
        || typeof value.source.kind !== 'string'
        || typeof value.createdAt !== 'number'
        || typeof value.expiresAt !== 'number'
    ) {
        return null
    }
    return value as unknown as RuntimeStartupPublicNotice
}

function asSnapshot(value: unknown): RuntimeStartupSnapshot | null {
    if (
        !isRecord(value)
        || value.type !== 'runtime_startup_snapshot'
        || typeof value.instanceId !== 'string'
        || !Number.isSafeInteger(value.sequence)
        || (value.sessionId !== null && typeof value.sessionId !== 'string')
        || typeof value.phase !== 'string'
        || !Array.isArray(value.prompts)
        || !Array.isArray(value.notices)
    ) {
        return null
    }
    const prompts = value.prompts.map(asPublicPrompt)
    if (prompts.some((prompt) => prompt === null)) {
        return null
    }
    const notices = value.notices.map(asPublicNotice)
    if (notices.some((notice) => notice === null)) {
        return null
    }
    return {
        ...value,
        prompts: prompts as RuntimeStartupPublicPrompt[],
        notices: notices as RuntimeStartupPublicNotice[],
    } as RuntimeStartupSnapshot
}

function asEvent(value: unknown): RuntimeStartupEvent | null {
    if (
        !isRecord(value)
        || value.type !== 'runtime_startup_event'
        || typeof value.instanceId !== 'string'
        || !Number.isSafeInteger(value.sequence)
        || typeof value.eventType !== 'string'
        || typeof value.timestamp !== 'number'
    ) {
        return null
    }
    if (value.eventType === 'prompt_created' && !asPublicPrompt(value.prompt)) {
        return null
    }
    if (value.eventType === 'notice_created' && !asPublicNotice(value.notice)) {
        return null
    }
    return value as unknown as RuntimeStartupEvent
}

export class RuntimeStartupClient {
    private readonly getAuth: () => Promise<string>
    private readonly fetchImpl: typeof fetch
    private readonly webSocketFactory: (url: string) => WebSocketLike
    private readonly location: Pick<Location, 'protocol' | 'host'>
    private readonly cryptoImpl: Pick<Crypto, 'randomUUID'>
    private readonly pollIntervalMs: number
    private readonly reconnectDelayMs: number
    private readonly observerPollIntervalMs: number
    private readonly observerRequestTimeoutMs: number

    constructor(options: RuntimeStartupClientOptions = {}) {
        this.getAuth = options.getAuth ?? getNodeServerProxyAuth
        this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
        this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url))
        this.location = options.location ?? location
        this.cryptoImpl = options.cryptoImpl ?? crypto
        this.pollIntervalMs = options.pollIntervalMs ?? 1_000
        this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000
        this.observerPollIntervalMs = options.observerPollIntervalMs ?? 5_000
        this.observerRequestTimeoutMs = options.observerRequestTimeoutMs ?? 5_000
    }

    async beginSession(producerId: string, requestId: string = this.cryptoImpl.randomUUID()) {
        return asSession(await this.retryingRequest('/runtime-startup/session', {
            method: 'POST',
            body: JSON.stringify({ requestId, producerId }),
        }))
    }

    async heartbeat(session: RuntimeStartupSession, phase: Exclude<RuntimeStartupPhase,
        'waiting_for_ui' | 'claim_ready' | 'unavailable'>) {
        const value = await this.request(
            `/runtime-startup/session/${encodeURIComponent(session.sessionId)}/heartbeat`,
            {
                method: 'POST',
                body: JSON.stringify({
                    producerId: session.producerId,
                    fencingToken: session.fencingToken,
                    phase,
                }),
            },
        )
        if (!isRecord(value) || value.success !== true) {
            throw new Error('Malformed runtime startup heartbeat response')
        }
        return value
    }

    async prompt(
        session: RuntimeStartupSession,
        prompt: alertData,
        source: RuntimeStartupPromptSource = { kind: 'runtime_alert' },
        signal?: AbortSignal,
    ) {
        const requestId = this.cryptoImpl.randomUUID()
        const path = `/runtime-startup/session/${encodeURIComponent(session.sessionId)}/prompts`
        const created = await this.retryingRequest(path, {
            method: 'POST',
            signal,
            body: JSON.stringify({
                producerId: session.producerId,
                fencingToken: session.fencingToken,
                requestId,
                prompt,
                source,
            }),
        })
        if (!isRecord(created) || typeof created.promptId !== 'string') {
            throw new Error('Malformed runtime startup prompt response')
        }
        const promptId = created.promptId
        const pollPath = `${path}/${encodeURIComponent(promptId)}/poll`
        try {
            while (true) {
                if (signal?.aborted) {
                    throw runtimeAbortError(signal)
                }
                let response: { status: number, body: unknown }
                try {
                    response = await this.requestWithStatus(pollPath, {
                        method: 'POST',
                        signal,
                        body: JSON.stringify({
                            producerId: session.producerId,
                            fencingToken: session.fencingToken,
                        }),
                    })
                }
                catch (error) {
                    if (!isRetryableStartupError(error)) {
                        throw error
                    }
                    await delay(this.pollIntervalMs, signal)
                    continue
                }
                if (response.status === 202) {
                    await delay(this.pollIntervalMs, signal)
                    continue
                }
                if (!isRecord(response.body) || typeof response.body.response !== 'string') {
                    throw new Error('Malformed runtime startup prompt poll response')
                }
                return response.body.response
            }
        }
        finally {
            // The answer is repeatable until this explicit close, so an
            // ambiguous poll response can safely be retried without losing a
            // provider key. Closing promptly minimizes secret lifetime.
            await this.request(`${path}/${encodeURIComponent(promptId)}`, {
                method: 'DELETE',
                body: JSON.stringify({
                    producerId: session.producerId,
                    fencingToken: session.fencingToken,
                }),
            }).catch(() => {})
        }
    }

    async notice(
        session: RuntimeStartupSession,
        notice: alertData,
        source: RuntimeStartupPromptSource = { kind: 'runtime_notice' },
    ) {
        const value = await this.request(
            `/runtime-startup/session/${encodeURIComponent(session.sessionId)}/notices`,
            {
                method: 'POST',
                body: JSON.stringify({
                    producerId: session.producerId,
                    fencingToken: session.fencingToken,
                    notice,
                    source,
                }),
            },
        )
        if (!isRecord(value) || typeof value.noticeId !== 'string') {
            throw new Error('Malformed runtime startup notice response')
        }
        return value
    }

    async getSnapshot(signal?: AbortSignal) {
        const snapshot = asSnapshot(await this.request(
            '/runtime-startup',
            signal ? { signal } : {},
        ))
        if (!snapshot) {
            throw new Error('Malformed runtime startup snapshot')
        }
        return snapshot
    }

    async respond(promptId: string, response: string) {
        const body = await this.retryingRequest(
            `/runtime-startup/prompts/${encodeURIComponent(promptId)}/response`,
            {
                method: 'POST',
                body: JSON.stringify({ response }),
            },
        )
        if (
            !isRecord(body)
            || body.success !== true
            || typeof body.accepted !== 'boolean'
            || typeof body.reused !== 'boolean'
        ) {
            throw new Error('Malformed runtime startup prompt response acknowledgement')
        }
        return {
            accepted: body.accepted,
            reused: body.reused,
        }
    }

    watch(clientId: string, handlers: RuntimeStartupWatchHandlers = {}) {
        let stopped = false
        let socket: WebSocketLike | null = null
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null
        let hydrateInFlight: Promise<void> | null = null
        let hydrateAbortController: AbortController | null = null
        let currentInstanceId: string | null = null
        let lastSequence = -1
        let webSocketSnapshotVersion = 0

        const reportError = (error: unknown) => {
            handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
        }
        const deliverSnapshot = (
            snapshot: RuntimeStartupSnapshot,
            webSocketVersionAtRequest?: number,
        ) => {
            // A WS snapshot invalidates any slower HTTP hydrate that began
            // before it. Within one server instance, sequence is monotonic.
            if (webSocketVersionAtRequest !== undefined
                && webSocketVersionAtRequest !== webSocketSnapshotVersion) {
                return
            }
            if (snapshot.instanceId !== currentInstanceId) {
                currentInstanceId = snapshot.instanceId
                lastSequence = -1
            }
            if (snapshot.sequence <= lastSequence) {
                return
            }
            lastSequence = snapshot.sequence
            handlers.onSnapshot?.(snapshot)
        }
        const deliverEvent = (event: RuntimeStartupEvent) => {
            if (event.instanceId !== currentInstanceId || event.sequence <= lastSequence) {
                return
            }
            lastSequence = event.sequence
            handlers.onEvent?.(event)
        }
        const scheduleReconnect = () => {
            if (stopped || reconnectTimer !== null) {
                return
            }
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null
                void connect()
            }, this.reconnectDelayMs)
        }
        const hydrate = () => {
            if (stopped) {
                return Promise.resolve()
            }
            if (hydrateInFlight) {
                return hydrateInFlight
            }
            const webSocketVersionAtRequest = webSocketSnapshotVersion
            const controller = new AbortController()
            hydrateAbortController = controller
            const requestTimeout = setTimeout(() => {
                controller.abort(new Error('Runtime startup snapshot timed out'))
            }, this.observerRequestTimeoutMs)
            const request = (async () => {
                try {
                    deliverSnapshot(
                        await this.getSnapshot(controller.signal),
                        webSocketVersionAtRequest,
                    )
                }
                catch (error) {
                    if (!stopped) {
                        reportError(error)
                    }
                }
            })().finally(() => {
                clearTimeout(requestTimeout)
                if (hydrateAbortController === controller) {
                    hydrateAbortController = null
                }
                if (hydrateInFlight === request) {
                    hydrateInFlight = null
                }
            })
            hydrateInFlight = request
            return request
        }
        const connect = async () => {
            if (stopped) {
                return
            }
            try {
                const ticket = await this.request('/runtime-startup/socket-ticket', {
                    method: 'POST',
                    body: JSON.stringify({ clientId }),
                })
                if (
                    !isRecord(ticket)
                    || typeof ticket.ticket !== 'string'
                    || typeof ticket.path !== 'string'
                ) {
                    throw new Error('Malformed runtime startup socket ticket')
                }
                const protocol = this.location.protocol === 'https:' ? 'wss:' : 'ws:'
                const url = new URL(ticket.path, `${protocol}//${this.location.host}`)
                url.searchParams.set('ticket', ticket.ticket)
                const nextSocket = this.webSocketFactory(url.toString())
                socket = nextSocket
                nextSocket.addEventListener('message', (event) => {
                    if (stopped || socket !== nextSocket) {
                        return
                    }
                    try {
                        const value = JSON.parse(String(event.data)) as unknown
                        const snapshot = asSnapshot(value)
                        if (snapshot) {
                            webSocketSnapshotVersion += 1
                            deliverSnapshot(snapshot)
                            return
                        }
                        const runtimeEvent = asEvent(value)
                        if (runtimeEvent) {
                            deliverEvent(runtimeEvent)
                        }
                    }
                    catch (error) {
                        reportError(error)
                    }
                })
                const disconnected = () => {
                    if (socket !== nextSocket) {
                        return
                    }
                    socket = null
                    void hydrate()
                    scheduleReconnect()
                }
                nextSocket.addEventListener('error', disconnected)
                nextSocket.addEventListener('close', disconnected)
            }
            catch (error) {
                reportError(error)
                await hydrate()
                scheduleReconnect()
            }
        }
        void hydrate()
        void connect()
        // WebSocket is the low-latency path, while periodic authenticated
        // snapshots are the correctness fallback for proxies that reject WS
        // or leave an upgrade indefinitely stuck in CONNECTING.
        const observerPollTimer = setInterval(
            () => void hydrate(),
            this.observerPollIntervalMs,
        )

        return () => {
            stopped = true
            clearInterval(observerPollTimer)
            hydrateAbortController?.abort(new Error('Runtime startup observer stopped'))
            hydrateAbortController = null
            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer)
                reconnectTimer = null
            }
            socket?.close(1000, 'runtime startup observer stopped')
            socket = null
        }
    }

    private async requestWithStatus(path: string, init: RequestInit = {}) {
        let response: Response
        try {
            response = await this.fetchImpl(path, {
                ...init,
                headers: {
                    'content-type': 'application/json',
                    'risu-auth': await this.getAuth(),
                    ...(init.headers ?? {}),
                },
            })
        }
        catch (error) {
            throw new RuntimeStartupTransportError('Runtime startup transport failed', error)
        }
        let body: unknown
        try {
            body = await readJson(response)
        }
        catch (error) {
            throw new RuntimeStartupTransportError(
                'Runtime startup response was unreadable',
                error,
            )
        }
        if (!response.ok) {
            throw new RuntimeStartupHttpError(response.status, body)
        }
        return { status: response.status, body }
    }

    private async request(path: string, init: RequestInit = {}) {
        return (await this.requestWithStatus(path, init)).body
    }

    private async retryingRequest(path: string, init: RequestInit = {}) {
        while (true) {
            try {
                return await this.request(path, init)
            }
            catch (error) {
                if (init.signal?.aborted) {
                    throw runtimeAbortError(init.signal)
                }
                if (!isRetryableStartupError(error)) {
                    throw error
                }
                await delay(this.reconnectDelayMs, init.signal ?? undefined)
            }
        }
    }
}
