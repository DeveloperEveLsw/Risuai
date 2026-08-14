import { getNodeServerProxyAuth } from '../storage/nodeStorage'
import type { MessageGenerationInfo, StreamingDisplayOptimizationMode } from '../storage/database.svelte'
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
    /** Executor/create-response-only signal; never part of the durable command. */
    presentationChannel?: boolean
}

export interface RuntimePresentationSpeakAction {
    type: 'speak'
    characterId: string
    text: string
}

export type RuntimePresentationAction = RuntimePresentationSpeakAction

export interface RuntimeGenerationEvent {
    type: 'generation_event'
    commandId: string
    sequence: number
    eventType: string
    timestamp: number
    payload: Record<string, unknown>
}

export interface RuntimeGenerationOutputMessage {
    messageId: string
    messageIndex: number
    data: string
    createdAt: number
    generationInfo: MessageGenerationInfo | null
    optimizationMode: StreamingDisplayOptimizationMode
}

export interface RuntimeGenerationOutput {
    type: 'generation_output'
    commandId: string
    version: number
    messages: RuntimeGenerationOutputMessage[]
    timestamp: number
}

export interface RuntimeGenerationOutputInput {
    version: number
    messages: RuntimeGenerationOutputMessage[]
}

export interface RuntimeCanonicalInputCommit {
    databaseRevision: number
    messageIndex: number
    messageId: string
}

export function canonicalInputCommitFromEvent(
    event: RuntimeGenerationEvent,
): RuntimeCanonicalInputCommit | null {
    if (event.eventType !== 'input_committed') {
        return null
    }
    const { databaseRevision, messageIndex, messageId } = event.payload
    if (
        !Number.isSafeInteger(databaseRevision)
        || (databaseRevision as number) < 0
        || !Number.isSafeInteger(messageIndex)
        || (messageIndex as number) < 0
        || typeof messageId !== 'string'
        || messageId.length === 0
    ) {
        throw new Error('Malformed input_committed runtime generation event')
    }
    return {
        databaseRevision: databaseRevision as number,
        messageIndex: messageIndex as number,
        messageId,
    }
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
    /** Open an ephemeral, initiating-client-only presentation mailbox. */
    localPresentation?: boolean
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
    onOutput?: (output: RuntimeGenerationOutput) => void
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
    cryptoImpl?: Pick<Crypto, 'randomUUID'> & Partial<Pick<Crypto, 'subtle'>>
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

function sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortJsonValue)
    }
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, sortJsonValue(value[key])]),
        )
    }
    return value
}

function canonicalJson(value: unknown) {
    return JSON.stringify(sortJsonValue(JSON.parse(JSON.stringify(value))))
}

function jsonEquivalent(left: unknown, right: unknown) {
    return canonicalJson(left) === canonicalJson(right)
}

function withExpectedRuntimeGenerationPayload(
    command: RuntimeGenerationCommand,
    input: RuntimeGenerationCreateInput,
    requestId: string,
    payload: Record<string, unknown>,
    requireResponsePayload = false,
) {
    if (
        command.requestId !== requestId
        || command.action !== input.action
        || command.characterId !== input.characterId
        || command.chatId !== input.chatId
        || (requireResponsePayload && command.payload === undefined)
        || (command.payload !== undefined && !jsonEquivalent(command.payload, payload))
    ) {
        throw new Error(`requestId ${requestId} resolved to a different runtime generation request`)
    }
    return {
        ...command,
        payload,
    }
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

function asOutput(value: unknown): RuntimeGenerationOutput | null {
    if (
        !isRecord(value)
        || value.type !== 'generation_output'
        || typeof value.commandId !== 'string'
        || value.commandId.length === 0
        || !Number.isSafeInteger(value.version)
        || (value.version as number) < 1
        || !Array.isArray(value.messages)
        || value.messages.length === 0
        || typeof value.timestamp !== 'number'
        || !Number.isFinite(value.timestamp)
        || value.timestamp < 0
    ) {
        return null
    }
    const messageIds = new Set<string>()
    let previousMessageIndex = -1
    for (const message of value.messages) {
        if (
            !isRecord(message)
            || typeof message.messageId !== 'string'
            || message.messageId.length === 0
            || messageIds.has(message.messageId)
            || !Number.isSafeInteger(message.messageIndex)
            || (message.messageIndex as number) < 0
            || (message.messageIndex as number) <= previousMessageIndex
            || typeof message.data !== 'string'
            || typeof message.createdAt !== 'number'
            || !Number.isFinite(message.createdAt)
            || message.createdAt < 0
            || (message.generationInfo !== null && !isRecord(message.generationInfo))
            || !['off', 'balanced', 'strong'].includes(message.optimizationMode as string)
        ) {
            return null
        }
        messageIds.add(message.messageId)
        previousMessageIndex = message.messageIndex as number
    }
    return value as unknown as RuntimeGenerationOutput
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

function isRetryableRuntimeAdmissionHttpError(error: unknown) {
    return error instanceof RuntimeGenerationHttpError
        && (
            error.status === 408
            || error.status === 425
            || error.status === 429
            || error.status >= 500
        )
}

export class RuntimeGenerationClient {
    private readonly getAuth: () => Promise<string>
    private readonly fetchImpl: typeof fetch
    private readonly webSocketFactory: (url: string) => WebSocketLike
    private readonly location: Pick<Location, 'protocol' | 'host'>
    private readonly cryptoImpl: Pick<Crypto, 'randomUUID'> & Partial<Pick<Crypto, 'subtle'>>
    private readonly reconnectDelayMs: number
    private readonly presentationTokens = new Map<string, string>()
    private readonly presentationConsumptions = new Map<
        string,
        Promise<RuntimePresentationAction[]>
    >()

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
        const presentationToken = input.localPresentation
            ? this.cryptoImpl.randomUUID()
            : null
        const prepared = prepareRuntimeGenerationCreate(input, requestId)
        const serializedPayload = (JSON.parse(prepared.body) as { payload: Record<string, unknown> }).payload
        // Fetch keepalive has a browser-wide 64 KiB request-body quota. It is
        // valuable for ordinary sends that may be followed immediately by a
        // navigation, but forcing it on a long prompt makes fetch throw before
        // the request reaches the durable/idempotent server endpoint.
        const useKeepalive = prepared.keepaliveSafe
        const init: RequestInit = {
            method: 'POST',
            ...(useKeepalive ? { keepalive: true } : {}),
            signal,
            headers: {
                'Idempotency-Key': requestId,
                ...(presentationToken
                    ? { 'X-Risu-Runtime-Presentation-Token': presentationToken }
                    : {}),
            },
            body: prepared.body,
        }
        try {
            while (true) {
                try {
                    if (signal?.aborted) {
                        throw runtimeAbortError(signal)
                    }
                    const command = asCommand(await this.request('/runtime-generations', init))
                    if (
                        presentationToken
                        && typeof command.presentationChannel !== 'boolean'
                    ) {
                        throw new Error('Malformed runtime presentation channel response')
                    }
                    if (presentationToken && command.presentationChannel) {
                        this.presentationTokens.set(command.commandId, presentationToken)
                    }
                    // POST intentionally omits payload from its public response.
                    // Preserve the exact serialized envelope locally so crash
                    // fallback and cross-device overlay observation retain the
                    // command's canonical base revision.
                    return withExpectedRuntimeGenerationPayload(
                        command,
                        input,
                        requestId,
                        serializedPayload,
                    )
                }
                catch (error) {
                    if (signal?.aborted) {
                        throw runtimeAbortError(signal)
                    }
                    if (
                        !(error instanceof RuntimeGenerationTransportError)
                        && !isRetryableRuntimeAdmissionHttpError(error)
                    ) {
                        throw error
                    }
                    await retryDelay(this.reconnectDelayMs, signal)
                }
            }
        }
        catch (error) {
            if (!signal?.aborted) {
                throw error
            }

            // Fetch abort cannot prove that the origin rejected POST. Stop is
            // linearized by the same full idempotency envelope: the server
            // either cancels the command that won create, or durably records a
            // terminal cancellation that a delayed create can only reuse.
            return await this.cancelByRequest(
                { ...input, requestId },
                presentationToken ?? undefined,
            )
        }
    }

    async get(commandId: string, signal?: AbortSignal): Promise<RuntimeGenerationCommand> {
        return asCommand(await this.request(
            `/runtime-generations/${encodeURIComponent(commandId)}`,
            signal ? { signal } : {},
        ))
    }

    async getOutput(
        commandId: string,
        signal?: AbortSignal,
    ): Promise<RuntimeGenerationOutput | null> {
        const body = await this.request(
            `/runtime-generations/${encodeURIComponent(commandId)}/output`,
            signal ? { signal } : {},
        )
        if (!isRecord(body) || !Object.hasOwn(body, 'output')) {
            throw new Error('Malformed runtime generation output response')
        }
        if (body.output === null) {
            return null
        }
        const output = asOutput(body.output)
        if (!output || output.commandId !== commandId) {
            throw new Error('Malformed runtime generation output response')
        }
        return output
    }

    async list(query: Partial<Pick<RuntimeGenerationCommand, 'state' | 'requestId' | 'action' | 'characterId' | 'chatId'>> & {
        updatedAfter?: number
        limit?: number
    } = {}, signal?: AbortSignal) {
        const url = new URL('/runtime-generations', 'http://runtime.invalid')
        for (const [key, value] of Object.entries(query)) {
            if (typeof value === 'string') {
                url.searchParams.set(key, value)
            }
            else if (typeof value === 'number' && Number.isSafeInteger(value)) {
                url.searchParams.set(key, String(value))
            }
        }
        const body = await this.request(
            `${url.pathname}${url.search}`,
            signal ? { signal } : {},
        )
        if (!isRecord(body) || !Array.isArray(body.commands)) {
            throw new Error('Malformed runtime generation list response')
        }
        return body.commands.map(asCommand)
    }

    async cancelByRequest(
        input: RuntimeGenerationCreateInput & { requestId: string },
        presentationToken?: string,
    ): Promise<RuntimeGenerationCommand> {
        const prepared = prepareRuntimeGenerationCreate(input, input.requestId)
        const serializedPayload = (JSON.parse(prepared.body) as { payload: Record<string, unknown> }).payload
        const init: RequestInit = {
            method: 'DELETE',
            ...(prepared.keepaliveSafe ? { keepalive: true } : {}),
            headers: {
                'Idempotency-Key': input.requestId,
                ...(presentationToken
                    ? { 'X-Risu-Runtime-Presentation-Token': presentationToken }
                    : {}),
            },
            body: prepared.body,
        }
        const path = `/runtime-generations/by-request/${encodeURIComponent(input.requestId)}`
        while (true) {
            try {
                const body = await this.request(path, init)
                if (
                    !isRecord(body)
                    || body.success !== true
                    || typeof body.created !== 'boolean'
                ) {
                    throw new Error('Malformed runtime generation request cancellation response')
                }
                const command = await this.restoreExpectedPrivatePayload(
                    asCommand(body.command),
                    serializedPayload,
                )
                if (
                    presentationToken
                    && typeof command.presentationChannel !== 'boolean'
                ) {
                    throw new Error('Malformed runtime presentation channel response')
                }
                if (presentationToken && command.presentationChannel) {
                    this.presentationTokens.set(command.commandId, presentationToken)
                }
                return withExpectedRuntimeGenerationPayload(
                    command,
                    input,
                    input.requestId,
                    serializedPayload,
                    true,
                )
            }
            catch (error) {
                if (
                    !(error instanceof RuntimeGenerationTransportError)
                    && !isRetryableRuntimeAdmissionHttpError(error)
                ) {
                    throw error
                }
                await retryDelay(this.reconnectDelayMs)
            }
        }
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
                // UI prompt IDs and the command-scoped input commit make these
                // writes idempotent in the durable store. Retrying an ambiguous
                // response avoids failing generation after observers have
                // already seen the committed protocol event.
                if (signal?.aborted) {
                    throw runtimeAbortError(signal)
                }
                if (
                    (
                        eventType !== 'ui_prompt'
                        && eventType !== 'input_committed'
                    )
                    || !(error instanceof RuntimeGenerationTransportError)
                ) {
                    throw error
                }
                await retryDelay(this.reconnectDelayMs, signal)
            }
        }
    }

    async publishOutput(
        commandId: string,
        lease: RuntimeExecutorLease,
        input: RuntimeGenerationOutputInput,
        signal?: AbortSignal,
    ): Promise<RuntimeGenerationOutput> {
        // Rebuild the public input explicitly so runtime callers cannot smuggle
        // lease or server-owned wire fields through a structurally wider object.
        const serializedInput = JSON.parse(JSON.stringify({
            version: input.version,
            messages: input.messages.map((message) => ({
                messageId: message.messageId,
                messageIndex: message.messageIndex,
                data: message.data,
                createdAt: message.createdAt,
                generationInfo: message.generationInfo,
                optimizationMode: message.optimizationMode,
            })),
        })) as RuntimeGenerationOutputInput
        if (!asOutput({
            type: 'generation_output',
            commandId,
            ...serializedInput,
            timestamp: 0,
        })) {
            throw new Error('Malformed runtime generation output input')
        }
        const path = `/runtime-generations/${encodeURIComponent(commandId)}/output`
        const body = JSON.stringify({
            executorId: lease.executorId,
            fencingToken: lease.fencingToken,
            ...serializedInput,
        })
        const init: RequestInit = {
            method: 'PUT',
            signal,
            body,
        }
        while (true) {
            try {
                const response = await this.request(path, init)
                if (!isRecord(response) || typeof response.reused !== 'boolean') {
                    throw new Error('Malformed runtime generation output publish response')
                }
                const output = asOutput(response.output)
                if (
                    !output
                    || output.commandId !== commandId
                    || !jsonEquivalent(
                        {
                            version: output.version,
                            messages: output.messages,
                        },
                        serializedInput,
                    )
                ) {
                    throw new Error('Malformed runtime generation output publish response')
                }
                return output
            }
            catch (error) {
                if (signal?.aborted) {
                    throw runtimeAbortError(signal)
                }
                if (
                    !(error instanceof RuntimeGenerationTransportError)
                    && !isRetryableRuntimeAdmissionHttpError(error)
                ) {
                    throw error
                }
                await retryDelay(this.reconnectDelayMs, signal)
            }
        }
    }

    async publishPresentationAction(
        commandId: string,
        lease: RuntimeExecutorLease,
        actionId: string,
        action: RuntimePresentationAction,
        signal?: AbortSignal,
    ) {
        const path = `/runtime-generations/${encodeURIComponent(commandId)}`
            + `/presentation/${encodeURIComponent(actionId)}`
        const init: RequestInit = {
            method: 'PUT',
            signal,
            body: JSON.stringify({
                executorId: lease.executorId,
                fencingToken: lease.fencingToken,
                action,
            }),
        }
        while (true) {
            try {
                const body = await this.request(path, init)
                if (
                    !isRecord(body)
                    || typeof body.accepted !== 'boolean'
                    || typeof body.reused !== 'boolean'
                    || body.accepted === body.reused
                ) {
                    throw new Error('Malformed runtime presentation publish response')
                }
                return { accepted: body.accepted, reused: body.reused }
            }
            catch (error) {
                if (signal?.aborted) {
                    throw runtimeAbortError(signal)
                }
                if (
                    !(error instanceof RuntimeGenerationTransportError)
                    && !isRetryableRuntimeAdmissionHttpError(error)
                ) {
                    throw error
                }
                await retryDelay(this.reconnectDelayMs, signal)
            }
        }
    }

    /**
     * Consume effects only when this RuntimeGenerationClient admitted the
     * command. The server returns the same ephemeral value until the explicit
     * acknowledgement, which makes an ambiguous response retry-safe; the
     * in-process promise prevents two late waiters from replaying it.
     */
    async consumePresentationActions(
        commandId: string,
        signal?: AbortSignal,
    ): Promise<RuntimePresentationAction[]> {
        const existing = this.presentationConsumptions.get(commandId)
        if (existing) {
            // The first initiating waiter owns playback. Concurrent and late
            // waiters intentionally observe no effects rather than sharing the
            // fulfilled action array and replaying it.
            return []
        }
        const token = this.presentationTokens.get(commandId)
        if (!token) {
            return []
        }
        const consuming = (async () => {
            const path = `/runtime-generations/${encodeURIComponent(commandId)}`
                + '/presentation/consume'
            const init: RequestInit = {
                method: 'POST',
                signal,
                headers: { 'X-Risu-Runtime-Presentation-Token': token },
                body: '{}',
            }
            let response: unknown
            while (true) {
                try {
                    response = await this.request(path, init)
                    break
                }
                catch (error) {
                    if (signal?.aborted) {
                        throw runtimeAbortError(signal)
                    }
                    if (
                        !(error instanceof RuntimeGenerationTransportError)
                        && !isRetryableRuntimeAdmissionHttpError(error)
                    ) {
                        throw error
                    }
                    await retryDelay(this.reconnectDelayMs, signal)
                }
            }
            if (!isRecord(response) || !Array.isArray(response.actions)) {
                throw new Error('Malformed runtime presentation consume response')
            }
            const actions = response.actions.map((value) => {
                if (
                    !isRecord(value)
                    || value.type !== 'speak'
                    || typeof value.characterId !== 'string'
                    || typeof value.text !== 'string'
                ) {
                    throw new Error('Malformed runtime presentation action')
                }
                return value as unknown as RuntimePresentationAction
            })
            // Remove the local capability before acknowledgement/playback so
            // concurrent or late waiters in this browser can never replay it.
            this.presentationTokens.delete(commandId)
            void this.request(path, {
                method: 'DELETE',
                headers: { 'X-Risu-Runtime-Presentation-Token': token },
            }).catch(() => {
                // The memory-only server mailbox expires independently. A lost
                // acknowledgement must not make the visible browser replay.
            })
            return actions
        })()
        this.presentationConsumptions.set(commandId, consuming)
        try {
            return await consuming
        }
        finally {
            if (this.presentationConsumptions.get(commandId) === consuming) {
                this.presentationConsumptions.delete(commandId)
            }
        }
    }

    discardPresentationActions(commandId: string) {
        this.presentationTokens.delete(commandId)
        this.presentationConsumptions.delete(commandId)
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
        let latestOutputVersion = 0
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
                if (isRecord(parsed) && parsed.type === 'generation_output') {
                    const output = asOutput(parsed)
                    if (!output || output.commandId !== commandId) {
                        nextSocket.close(1002, 'invalid output')
                        return
                    }
                    // Output versions are a cumulative, independently ordered
                    // stream. A reconnect replays the latest value, so equal or
                    // older versions are harmless duplicates and gaps are valid.
                    if (output.version <= latestOutputVersion) {
                        return
                    }
                    latestOutputVersion = output.version
                    handlers.onOutput?.(output)
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

    private async restoreExpectedPrivatePayload(
        command: RuntimeGenerationCommand,
        expectedPayload: Record<string, unknown>,
    ) {
        if (command.payload === undefined || jsonEquivalent(command.payload, expectedPayload)) {
            return command
        }
        const marker = command.payload.__runtimePrivateInput
        const expectedInput = expectedPayload.input
        if (
            !isRecord(marker)
            || command.payload.input !== ''
            || typeof expectedInput !== 'string'
            || !expectedInput.startsWith('/')
            || typeof marker.sha256 !== 'string'
            || !Number.isSafeInteger(marker.byteLength)
        ) {
            return command
        }
        const expectedRest = { ...expectedPayload }
        const redactedRest = { ...command.payload }
        delete expectedRest.input
        delete redactedRest.input
        delete redactedRest.__runtimePrivateInput
        const encoded = new TextEncoder().encode(expectedInput)
        if (
            encoded.byteLength !== marker.byteLength
            || !jsonEquivalent(expectedRest, redactedRest)
            || !this.cryptoImpl.subtle
        ) {
            return command
        }
        const digest = new Uint8Array(await this.cryptoImpl.subtle.digest('SHA-256', encoded))
        const digestHex = [...digest]
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')
        if (digestHex !== marker.sha256) {
            return command
        }
        return { ...command, payload: expectedPayload }
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
