import type { alertData } from '../alert'
import { getNodeServerProxyAuth } from '../storage/nodeStorage'

export type RuntimePluginPermissionCapability =
    | 'fetchLogs'
    | 'db'
    | 'mainDom'
    | 'replacer'
    | 'provider'
    | 'sendChat'

export type RuntimePluginPermissionPolicy = 'persistent' | 'periodically' | 'always'

export interface RuntimePluginPermissionPrincipal {
    name: string
    scriptHash: string
}

export interface RuntimePluginPermissionClientOptions {
    getAuth?: () => Promise<string>
    fetchImpl?: typeof fetch
    cryptoImpl?: Pick<Crypto, 'randomUUID'>
    requesterId?: string
    pollIntervalMs?: number
    retryIntervalMs?: number
    requestTimeoutMs?: number
}

class RuntimePluginPermissionHttpError extends Error {
    constructor(
        readonly status: number,
        readonly body: unknown,
    ) {
        super(
            isRecord(body) && typeof body.error === 'string'
                ? body.error
                : `Runtime plugin permission request failed (${status})`,
        )
        this.name = 'RuntimePluginPermissionHttpError'
    }
}

class RuntimePluginPermissionTransportError extends Error {
    constructor(message: string, cause: unknown) {
        super(message, { cause })
        this.name = 'RuntimePluginPermissionTransportError'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

function abortError(signal: AbortSignal) {
    if (signal.reason instanceof Error) {
        return signal.reason
    }
    const error = new Error(
        typeof signal.reason === 'string'
            ? signal.reason
            : 'Runtime plugin permission request aborted',
    )
    error.name = 'AbortError'
    return error
}

function delay(milliseconds: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError(signal))
            return
        }
        const onAbort = () => {
            clearTimeout(timer)
            reject(abortError(signal!))
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, milliseconds)
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

function defaultRequesterId(cryptoImpl: Pick<Crypto, 'randomUUID'>) {
    const key = 'risu-runtime-plugin-permission-requester-id'
    try {
        const existing = sessionStorage.getItem(key)
        if (existing) {
            return existing
        }
        const created = `permission-${cryptoImpl.randomUUID()}`
        sessionStorage.setItem(key, created)
        return created
    }
    catch {
        return `permission-${cryptoImpl.randomUUID()}`
    }
}

function isRetryable(error: unknown) {
    return error instanceof RuntimePluginPermissionTransportError
        || (
            error instanceof RuntimePluginPermissionHttpError
            && (error.status === 408 || error.status === 429 || error.status >= 500)
        )
}

export class RuntimePluginPermissionClient {
    private readonly getAuth: () => Promise<string>
    private readonly fetchImpl: typeof fetch
    private readonly cryptoImpl: Pick<Crypto, 'randomUUID'>
    private readonly requesterId: string
    private readonly pollIntervalMs: number
    private readonly retryIntervalMs: number
    private readonly requestTimeoutMs: number

    constructor(options: RuntimePluginPermissionClientOptions = {}) {
        this.getAuth = options.getAuth ?? getNodeServerProxyAuth
        this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
        this.cryptoImpl = options.cryptoImpl ?? crypto
        this.requesterId = options.requesterId ?? defaultRequesterId(this.cryptoImpl)
        this.pollIntervalMs = options.pollIntervalMs ?? 1_000
        this.retryIntervalMs = options.retryIntervalMs ?? 1_000
        this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000
    }

    async resolve(
        principal: RuntimePluginPermissionPrincipal,
        capability: RuntimePluginPermissionCapability,
        policy: RuntimePluginPermissionPolicy,
        promptMessage: string,
        signal?: AbortSignal,
    ): Promise<boolean> {
        const requestId = this.cryptoImpl.randomUUID()
        while (true) {
            if (signal?.aborted) {
                throw abortError(signal)
            }
            let created: unknown
            try {
                created = await this.retryingRequest('/runtime-plugin-permissions/requests', {
                    method: 'POST',
                    body: JSON.stringify({
                        requesterId: this.requesterId,
                        requestId,
                        principal,
                        capability,
                        policy,
                        prompt: {
                            type: 'ask',
                            msg: promptMessage,
                        } satisfies alertData,
                    }),
                }, signal)
            }
            catch (error) {
                if (error instanceof RuntimePluginPermissionHttpError && error.status === 410) {
                    continue
                }
                throw error
            }
            if (!isRecord(created) || typeof created.state !== 'string') {
                throw new Error('Malformed runtime plugin permission response')
            }
            if (created.state === 'granted') {
                if (signal?.aborted) throw abortError(signal)
                return true
            }
            if (created.state === 'denied') {
                if (signal?.aborted) throw abortError(signal)
                return false
            }
            if (created.state !== 'pending' || typeof created.requestToken !== 'string') {
                throw new Error('Malformed pending runtime plugin permission response')
            }

            const requestToken = created.requestToken
            let recreate = false
            while (!recreate) {
                let polled: unknown
                try {
                    polled = await this.request('/runtime-plugin-permissions/poll', {
                        method: 'POST',
                        body: JSON.stringify({ requestToken }),
                    }, signal)
                }
                catch (error) {
                    if (error instanceof RuntimePluginPermissionHttpError && error.status === 410) {
                        // A server restart intentionally forgets pending
                        // decisions. Recreate the exact request and require a
                        // new observer decision unless a durable allow exists.
                        recreate = true
                        continue
                    }
                    if (!isRetryable(error)) {
                        throw error
                    }
                    await delay(this.retryIntervalMs, signal)
                    continue
                }
                if (!isRecord(polled) || typeof polled.state !== 'string') {
                    throw new Error('Malformed runtime plugin permission poll response')
                }
                if (polled.state === 'granted') {
                    if (signal?.aborted) throw abortError(signal)
                    return true
                }
                if (polled.state === 'denied') {
                    if (signal?.aborted) throw abortError(signal)
                    return false
                }
                if (polled.state !== 'pending') {
                    throw new Error('Malformed pending runtime plugin permission poll response')
                }
                await delay(this.pollIntervalMs, signal)
            }
        }
    }

    private async request(path: string, init: RequestInit, signal?: AbortSignal) {
        if (signal?.aborted) {
            throw abortError(signal)
        }
        const auth = await this.getAuth()
        if (signal?.aborted) {
            throw abortError(signal)
        }
        const attemptController = new AbortController()
        const onCallerAbort = () => attemptController.abort(abortError(signal!))
        signal?.addEventListener('abort', onCallerAbort, { once: true })
        const timeout = setTimeout(() => {
            attemptController.abort(new Error('Runtime plugin permission request timed out'))
        }, this.requestTimeoutMs)
        try {
            let response: Response
            try {
                response = await this.fetchImpl(path, {
                    ...init,
                    signal: attemptController.signal,
                    headers: {
                        'content-type': 'application/json',
                        'risu-auth': auth,
                        ...(init.headers ?? {}),
                    },
                })
            }
            catch (error) {
                if (signal?.aborted) {
                    throw abortError(signal)
                }
                throw new RuntimePluginPermissionTransportError(
                    'Runtime plugin permission transport failed',
                    error,
                )
            }
            let body: unknown = null
            try {
                const text = await response.text()
                body = text ? JSON.parse(text) : null
            }
            catch (error) {
                if (signal?.aborted) {
                    throw abortError(signal)
                }
                throw new RuntimePluginPermissionTransportError(
                    'Runtime plugin permission response was unreadable',
                    error,
                )
            }
            if (!response.ok) {
                throw new RuntimePluginPermissionHttpError(response.status, body)
            }
            return body
        }
        finally {
            clearTimeout(timeout)
            signal?.removeEventListener('abort', onCallerAbort)
        }
    }

    private async retryingRequest(path: string, init: RequestInit, signal?: AbortSignal) {
        while (true) {
            try {
                return await this.request(path, init, signal)
            }
            catch (error) {
                if (signal?.aborted) {
                    throw abortError(signal)
                }
                if (!isRetryable(error)) {
                    throw error
                }
                await delay(this.retryIntervalMs, signal)
            }
        }
    }
}
