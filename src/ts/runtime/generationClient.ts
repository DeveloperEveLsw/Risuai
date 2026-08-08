import { getNodeServerProxyAuth } from '../storage/nodeStorage'
import type { CanonicalGenerationAction, CanonicalGenerationTarget } from './canonicalGeneration.svelte'

export type RuntimeGenerationState =
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'

export interface RuntimeGenerationCommand extends CanonicalGenerationTarget {
    commandId: string
    requestId: string
    action: CanonicalGenerationAction
    state: RuntimeGenerationState
    createdAt: number
    updatedAt: number
    startedAt: number | null
    finishedAt: number | null
    interruptedAt: number | null
    cancelRequestedAt: number | null
    executorId: string | null
    fencingToken: number | null
    leaseExpiresAt: number | null
    result: Record<string, unknown> | null
    error: string | null
    lastSequence: number
    payload?: Record<string, unknown>
    reused?: boolean
}

export interface RuntimeGenerationEvent {
    type: 'generation_event'
    commandId: string
    sequence: number
    eventType: string
    timestamp: number
    payload: Record<string, unknown>
}

export interface RuntimeGenerationSnapshot extends RuntimeGenerationCommand {
    type: 'generation_snapshot'
    clientId: string
}

export interface RuntimeExecutorLease {
    executorId: string
    fencingToken: number
    expiresAt: number
}

export interface RuntimeGenerationCreateInput extends CanonicalGenerationTarget {
    action: CanonicalGenerationAction
    requestId?: string
    payload?: Record<string, unknown>
}

export const RUNTIME_GENERATION_KEEPALIVE_MAX_BYTES = 60 * 1024

// crypto.randomUUID() always serializes to 36 ASCII bytes. This placeholder
// lets callers decide whether an input is keepalive-safe before a concrete ID
// is allocated, while an explicit requestId keeps the classification exact.
const runtimeGenerationRequestIdPlaceholder = '00000000-0000-4000-8000-000000000000'

function prepareRuntimeGenerationCreate(
    input: RuntimeGenerationCreateInput,
    requestId: string,
) {
    const body = JSON.stringify({
        requestId,
        action: input.action,
        characterId: input.characterId,
        chatId: input.chatId,
        payload: input.payload ?? {},
    })
    return {
        body,
        keepaliveSafe: new TextEncoder().encode(body).byteLength
            <= RUNTIME_GENERATION_KEEPALIVE_MAX_BYTES,
    }
}

export function isRuntimeGenerationKeepaliveSafe(
    input: RuntimeGenerationCreateInput,
    requestId = input.requestId ?? runtimeGenerationRequestIdPlaceholder,
) {
    return prepareRuntimeGenerationCreate(input, requestId).keepaliveSafe
}

export interface RuntimeGenerationWatchHandlers {
    onSnapshot?: (snapshot: RuntimeGenerationSnapshot) => void
    onEvent?: (event: RuntimeGenerationEvent) => void
    onError?: (error: Error) => void
    onTerminal?: (command: RuntimeGenerationCommand) => void
}

export interface RuntimeUiPromptResponse {
    accepted: boolean
    reused: boolean
    event: RuntimeGenerationEvent
}

interface WebSocketLike {
    readonly readyState: number
    addEventListener(type: string, listener: (event: any) => void): void
    close(code?: number, reason?: string): void
}

export interface RuntimeGenerationClientOptions {
    getAuth?: () => Promise<string>
    fetchImpl?: typeof fetch
    webSocketFactory?: (url: string) => WebSocketLike
    location?: Pick<Location, 'protocol' | 'host'>
    cryptoImpl?: Pick<Crypto, 'randomUUID'>
    reconnectDelayMs?: number
}

const terminalStates = new Set<RuntimeGenerationState>([
    'completed',
    'failed',
    'cancelled',
    'interrupted',
])

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asCommand(value: unknown): RuntimeGenerationCommand {
    if (
        !isRecord(value)
        || typeof value.commandId !== 'string'
        || typeof value.requestId !== 'string'
        || typeof value.characterId !== 'string'
        || typeof value.chatId !== 'string'
        || typeof value.action !== 'string'
        || typeof value.state !== 'string'
        || !Number.isSafeInteger(value.lastSequence)
    ) {
        throw new Error('Malformed runtime generation command response')
    }
    return value as unknown as RuntimeGenerationCommand
}

function asEvent(value: unknown): RuntimeGenerationEvent | null {
    if (
        !isRecord(value)
        || value.type !== 'generation_event'
        || typeof value.commandId !== 'string'
        || !Number.isSafeInteger(value.sequence)
        || (value.sequence as number) < 1
        || typeof value.eventType !== 'string'
        || typeof value.timestamp !== 'number'
        || !isRecord(value.payload)
    ) {
        return null
    }
    return value as unknown as RuntimeGenerationEvent
}

function asSnapshot(value: unknown): RuntimeGenerationSnapshot | null {
    if (!isRecord(value) || value.type !== 'generation_snapshot') {
        return null
    }
    try {
        asCommand(value)
        if (typeof value.clientId !== 'string') {
            return null
        }
        return value as unknown as RuntimeGenerationSnapshot
    }
    catch {
        return null
    }
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
        throw new Error(`Expected JSON from runtime generation endpoint (${response.status})`)
    }
}

function runtimeAbortError(signal: AbortSignal) {
    if (signal.reason instanceof Error) {
        return signal.reason
    }
    const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'Runtime request aborted')
    error.name = 'AbortError'
    return error
}

function retryDelay(milliseconds: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(runtimeAbortError(signal))
            return
        }
        const onAbort = () => {
            clearTimeout(timer)
            reject(runtimeAbortError(signal))
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, milliseconds)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

export class RuntimeGenerationHttpError extends Error {
    readonly status: number
    readonly body: unknown

    constructor(status: number, body: unknown) {
        super(
            isRecord(body) && typeof body.error === 'string'
                ? body.error
                : `Runtime generation request failed (${status})`,
        )
        this.name = 'RuntimeGenerationHttpError'
        this.status = status
        this.body = body
    }
}

class RuntimeGenerationTransportError extends Error {
    constructor(message: string, cause: unknown) {
        super(message, { cause })
        this.name = 'RuntimeGenerationTransportError'
    }
}

export class RuntimeGenerationClient {
    private readonly getAuth: () => Promise<string>
    private readonly fetchImpl: typeof fetch
    private readonly webSocketFactory: (url: string) => WebSocketLike
    private readonly location: Pick<Location, 'protocol' | 'host'>
    private readonly cryptoImpl: Pick<Crypto, 'randomUUID'>
    private readonly reconnectDelayMs: number

    constructor(options: RuntimeGenerationClientOptions = {}) {
        this.getAuth = options.getAuth ?? getNodeServerProxyAuth
        this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
        this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url))
        this.location = options.location ?? location
        this.cryptoImpl = options.cryptoImpl ?? crypto
        this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000
    }

    async create(
        input: RuntimeGenerationCreateInput,
        signal?: AbortSignal,
    ): Promise<RuntimeGenerationCommand> {
        const requestId = input.requestId ?? this.cryptoImpl.randomUUID()
        const prepared = prepareRuntimeGenerationCreate(input, requestId)
        // Fetch keepalive has a browser-wide 64 KiB request-body quota. It is
        // valuable for ordinary sends that may be followed immediately by a
        // navigation, but forcing it on a long prompt makes fetch throw before
        // the request reaches the durable/idempotent server endpoint.
        const useKeepalive = prepared.keepaliveSafe
        const init: RequestInit = {
            method: 'POST',
            ...(useKeepalive ? { keepalive: true } : {}),
            signal,
            headers: { 'Idempotency-Key': requestId },
            body: prepared.body,
        }
        while (true) {
            try {
                return asCommand(await this.request('/runtime-generations', init))
            }
            catch (error) {
                if (signal?.aborted) {
                    throw runtimeAbortError(signal)
                }
                if (!(error instanceof RuntimeGenerationTransportError)) {
                    throw error
                }
                await retryDelay(this.reconnectDelayMs, signal)
            }
        }
    }

    async get(commandId: string): Promise<RuntimeGenerationCommand> {
        return asCommand(await this.request(`/runtime-generations/${encodeURIComponent(commandId)}`))
    }

    async list(query: Partial<Pick<RuntimeGenerationCommand, 'state' | 'requestId' | 'action' | 'characterId' | 'chatId'>> & {
        updatedAfter?: number
        limit?: number
    } = {}) {
        const url = new URL('/runtime-generations', 'http://runtime.invalid')
        for (const [key, value] of Object.entries(query)) {
            if (typeof value === 'string') {
                url.searchParams.set(key, value)
            }
            else if (typeof value === 'number' && Number.isSafeInteger(value)) {
                url.searchParams.set(key, String(value))
            }
        }
        const body = await this.request(`${url.pathname}${url.search}`)
        if (!isRecord(body) || !Array.isArray(body.commands)) {
            throw new Error('Malformed runtime generation list response')
        }
        return body.commands.map(asCommand)
    }

    async cancel(commandId: string): Promise<RuntimeGenerationCommand> {
        const body = await this.request(`/runtime-generations/${encodeURIComponent(commandId)}`, {
            method: 'DELETE',
        })
        if (!isRecord(body)) {
            throw new Error('Malformed runtime generation cancel response')
        }
        return asCommand(body.command)
    }

    async respondToUiPrompt(
        commandId: string,
        promptId: string,
        response: string,
    ): Promise<RuntimeUiPromptResponse> {
        const path = `/runtime-generations/${encodeURIComponent(commandId)}`
            + `/ui-prompts/${encodeURIComponent(promptId)}/response`
        const init: RequestInit = {
            method: 'POST',
            body: JSON.stringify({ response }),
        }
        // The server commits the first answer durably. Retrying an ambiguous
        // transport failure is safe and returns that same winning event.
        while (true) {
            try {
                const body = await this.request(path, init)
                if (!isRecord(body)
                    || typeof body.accepted !== 'boolean'
                    || typeof body.reused !== 'boolean') {
                    throw new Error('Malformed UI prompt response')
                }
                const event = asEvent(body.event)
                if (!event || event.eventType !== 'ui_prompt_response') {
                    throw new Error('Malformed UI prompt response event')
                }
                return {
                    accepted: body.accepted,
                    reused: body.reused,
                    event,
                }
            }
            catch (error) {
                if (!(error instanceof RuntimeGenerationTransportError)) {
                    throw error
                }
                await new Promise((resolve) => setTimeout(resolve, this.reconnectDelayMs))
            }
        }
    }

    async getUiPromptResponse(
        commandId: string,
        promptId: string,
        lease: RuntimeExecutorLease,
        signal?: AbortSignal,
    ): Promise<string> {
        const path = `/runtime-generations/${encodeURIComponent(commandId)}`
            + `/ui-prompts/${encodeURIComponent(promptId)}/consume-response`
        const init: RequestInit = {
            method: 'POST',
            signal,
            body: JSON.stringify({
                executorId: lease.executorId,
                fencingToken: lease.fencingToken,
            }),
        }
        while (true) {
            try {
                const body = await this.request(path, init)
                if (!isRecord(body) || typeof body.response !== 'string') {
                    throw new Error('Malformed resident UI prompt response')
                }
                return body.response
            }
            catch (error) {
                if (signal?.aborted) {
                    throw runtimeAbortError(signal)
                }
                if (!(error instanceof RuntimeGenerationTransportError)) {
                    throw error
                }
                await retryDelay(this.reconnectDelayMs, signal)
            }
        }
    }

    async claimNext(executorId: string, leaseDurationMs: number) {
        const body = await this.request('/runtime-generations/executor/claim-next', {
            method: 'POST',
            body: JSON.stringify({ executorId, leaseDurationMs }),
        })
        if (!isRecord(body) || typeof body.claimed !== 'boolean') {
            throw new Error('Malformed executor claim response')
        }
        if (!body.claimed) {
            return null
        }
        if (!isRecord(body.lease)) {
            throw new Error('Executor claim has no lease')
        }
        return {
            command: asCommand(body.command),
            lease: body.lease as unknown as RuntimeExecutorLease,
        }
    }

    async heartbeat(commandId: string, lease: RuntimeExecutorLease, leaseDurationMs: number) {
        const body = await this.request('/runtime-generations/executor/heartbeat', {
            method: 'POST',
            body: JSON.stringify({
                commandId,
                executorId: lease.executorId,
                fencingToken: lease.fencingToken,
                leaseDurationMs,
            }),
        })
        if (!isRecord(body) || !isRecord(body.lease)) {
            throw new Error('Malformed executor heartbeat response')
        }
        return body.lease as unknown as RuntimeExecutorLease
    }

    async progress(
        commandId: string,
        lease: RuntimeExecutorLease,
        eventType: string,
        payload: Record<string, unknown> = {},
        signal?: AbortSignal,
    ) {
        const body = {
            eventType,
            payload,
        }
        while (true) {
            try {
                return await this.executorTerminalRequest(commandId, 'progress', lease, body, signal)
            }
            catch (error) {
                // UI prompt IDs make issuance idempotent in the durable store;
                // retrying an ambiguous response avoids failing generation
                // after observers have already seen the committed prompt.
                if (signal?.aborted) {
                    throw runtimeAbortError(signal)
                }
                if (eventType !== 'ui_prompt' || !(error instanceof RuntimeGenerationTransportError)) {
                    throw error
                }
                await retryDelay(this.reconnectDelayMs, signal)
            }
        }
    }

    async complete(
        commandId: string,
        lease: RuntimeExecutorLease,
        result: Record<string, unknown> = {},
    ) {
        return await this.executorTerminalRequest(commandId, 'complete', lease, { result })
    }

    async completeCancellation(
        commandId: string,
        lease: RuntimeExecutorLease,
        result: Record<string, unknown> = {},
    ) {
        return await this.executorTerminalRequest(commandId, 'cancel-complete', lease, { result })
    }

    async fail(
        commandId: string,
        lease: RuntimeExecutorLease,
        error: string,
        details: Record<string, unknown> = {},
    ) {
        return await this.executorTerminalRequest(commandId, 'fail', lease, { error, details })
    }

    watch(commandId: string, handlers: RuntimeGenerationWatchHandlers = {}, afterSequence = 0) {
        let stopped = false
        let socket: WebSocketLike | null = null
        let cursor = afterSequence
        let latestSnapshot: RuntimeGenerationSnapshot | null = null
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null
        let terminalLookupTimer: ReturnType<typeof setTimeout> | null = null
        let terminalLookupInFlight = false

        const reportError = (error: unknown) => {
            handlers.onError?.(error instanceof Error ? error : new Error(String(error)))
        }
        const finishTerminal = (command: RuntimeGenerationCommand) => {
            if (stopped) {
                return
            }
            stopped = true
            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer)
                reconnectTimer = null
            }
            if (terminalLookupTimer !== null) {
                clearTimeout(terminalLookupTimer)
                terminalLookupTimer = null
            }
            const terminalSocket = socket
            socket = null
            try {
                handlers.onTerminal?.(command)
            }
            catch (error) {
                reportError(error)
            }
            terminalSocket?.close(1000, 'terminal')
        }
        const scheduleTerminalLookup = () => {
            if (stopped || terminalLookupInFlight || terminalLookupTimer !== null) {
                return
            }
            terminalLookupTimer = setTimeout(() => {
                terminalLookupTimer = null
                void lookupTerminal()
            }, this.reconnectDelayMs)
        }
        const lookupTerminal = async () => {
            if (stopped || terminalLookupInFlight) {
                return
            }
            terminalLookupInFlight = true
            let retry = false
            try {
                finishTerminal(await this.get(commandId))
            }
            catch (error) {
                retry = true
                reportError(error)
            }
            finally {
                terminalLookupInFlight = false
                if (retry) {
                    scheduleTerminalLookup()
                }
            }
        }
        const scheduleReconnect = () => {
            if (stopped || reconnectTimer !== null) {
                return
            }
            if (latestSnapshot && terminalStates.has(latestSnapshot.state) && cursor >= latestSnapshot.lastSequence) {
                finishTerminal(latestSnapshot)
                return
            }
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null
                void open().catch((error) => {
                    reportError(error)
                    scheduleReconnect()
                })
            }, this.reconnectDelayMs)
        }
        const open = async () => {
            const ticketBody = await this.request(
                `/runtime-generations/${encodeURIComponent(commandId)}/socket-ticket`,
                { method: 'POST', body: JSON.stringify({}) },
            )
            if (!isRecord(ticketBody) || typeof ticketBody.ticket !== 'string' || typeof ticketBody.path !== 'string') {
                throw new Error('Malformed runtime generation socket ticket')
            }
            if (stopped) {
                return
            }
            const protocol = this.location.protocol === 'https:' ? 'wss:' : 'ws:'
            const url = new URL(ticketBody.path, `${protocol}//${this.location.host}`)
            url.searchParams.set('ticket', ticketBody.ticket)
            url.searchParams.set('afterSequence', String(cursor))
            const nextSocket = this.webSocketFactory(url.toString())
            socket = nextSocket
            nextSocket.addEventListener('message', (message) => {
                if (typeof message.data !== 'string') {
                    return
                }
                let parsed: unknown
                try {
                    parsed = JSON.parse(message.data)
                }
                catch {
                    nextSocket.close(1002, 'invalid JSON')
                    return
                }
                if (isRecord(parsed) && parsed.type === 'generation_ping') {
                    return
                }
                const snapshot = asSnapshot(parsed)
                if (snapshot) {
                    latestSnapshot = snapshot
                    handlers.onSnapshot?.(snapshot)
                    if (terminalStates.has(snapshot.state) && cursor >= snapshot.lastSequence) {
                        finishTerminal(snapshot)
                    }
                    return
                }
                const event = asEvent(parsed)
                if (!event || event.commandId !== commandId) {
                    nextSocket.close(1002, 'invalid event')
                    return
                }
                if (event.sequence <= cursor) {
                    return
                }
                if (event.sequence !== cursor + 1) {
                    nextSocket.close(1012, 'event gap')
                    return
                }
                cursor = event.sequence
                handlers.onEvent?.(event)
                if (['completed', 'failed', 'cancelled', 'interrupted'].includes(event.eventType)) {
                    void lookupTerminal()
                }
            })
            nextSocket.addEventListener('close', () => {
                if (socket !== nextSocket) {
                    return
                }
                socket = null
                scheduleReconnect()
            })
            nextSocket.addEventListener('error', () => reportError(new Error('Runtime generation WebSocket failed')))
        }

        void open().catch((error) => {
            reportError(error)
            scheduleReconnect()
        })
        return () => {
            stopped = true
            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer)
                reconnectTimer = null
            }
            if (terminalLookupTimer !== null) {
                clearTimeout(terminalLookupTimer)
                terminalLookupTimer = null
            }
            socket?.close(1000, 'observer stopped')
            socket = null
        }
    }

    private async executorTerminalRequest(
        commandId: string,
        operation: 'progress' | 'complete' | 'cancel-complete' | 'fail',
        lease: RuntimeExecutorLease,
        body: Record<string, unknown>,
        signal?: AbortSignal,
    ) {
        return await this.request(
            `/runtime-generations/${encodeURIComponent(commandId)}/${operation}`,
            {
                method: 'POST',
                signal,
                body: JSON.stringify({
                    executorId: lease.executorId,
                    fencingToken: lease.fencingToken,
                    ...body,
                }),
            },
        )
    }

    private async request(path: string, init: RequestInit = {}) {
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
            throw new RuntimeGenerationTransportError('Runtime generation transport failed', error)
        }
        let body: unknown
        try {
            body = await readJson(response)
        }
        catch (error) {
            throw new RuntimeGenerationTransportError('Runtime generation response was unreadable', error)
        }
        if (!response.ok) {
            throw new RuntimeGenerationHttpError(response.status, body)
        }
        return body
    }
}
