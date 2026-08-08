export const NODE_DATABASE_SYNC_PATH = '/api/sync/database'
export const NODE_DATABASE_SOCKET_TICKET_PATH = '/api/sync/socket-ticket'
export const NODE_DATABASE_SOCKET_PATH = '/api/sync/database/ws'

export type NodeDatabaseCommitKind = 'stable' | 'streaming'

export interface NodeDatabaseHead {
    revision: number
    sha256: string
    etag: string
}

export interface NodeDatabaseSnapshot {
    readonly head: NodeDatabaseHead
    readonly data: Uint8Array
}

export interface NodeDatabaseCommitResult extends NodeDatabaseHead {
    duplicate: boolean
    currentRevision: number
    currentSha256: string
    currentEtag: string
    idempotencyKey: string
}

export interface NodeDatabaseCommitOptions {
    kind?: NodeDatabaseCommitKind
    idempotencyKey?: string
    generationId?: string
    executorId?: string
    fencingToken?: number
}

export interface NodeDatabaseClientIdentity {
    /** Stable for the existing NodeStorage keypair. */
    deviceId: string
    /** Stable only for this page lifetime. */
    pageClientId: string
    /** The value sent as X-Risu-Client-Id. */
    clientId: string
}

export interface NodeDatabaseHelloEvent extends NodeDatabaseHead {
    type: 'hello'
    clientId: string
}

export interface NodeDatabaseCommittedEvent extends NodeDatabaseHead {
    type: 'committed'
    clientId: string
    kind: NodeDatabaseCommitKind
    idempotencyKey: string
    committedAt: number
}

export class NodeDatabaseProtocolError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'NodeDatabaseProtocolError'
    }
}

export class NodeDatabaseHttpError extends Error {
    readonly status: number
    readonly body: unknown

    constructor(status: number, message: string, body?: unknown) {
        super(message)
        this.name = 'NodeDatabaseHttpError'
        this.status = status
        this.body = body
    }
}

export class NodeDatabaseConflictError extends Error {
    readonly status: number
    readonly conflictId: string
    readonly reason: 'stale_base' | 'idempotency_key_reused'
    readonly currentHead: NodeDatabaseHead

    constructor(options: {
        status: number
        conflictId: string
        reason: 'stale_base' | 'idempotency_key_reused'
        currentHead: NodeDatabaseHead
    }) {
        super(`Database commit conflicted with revision ${options.currentHead.revision} (${options.reason})`)
        this.name = 'NodeDatabaseConflictError'
        this.status = options.status
        this.conflictId = options.conflictId
        this.reason = options.reason
        this.currentHead = Object.freeze({ ...options.currentHead })
    }

    get currentRevision() {
        return this.currentHead.revision
    }

    get currentSha256() {
        return this.currentHead.sha256
    }

    get currentEtag() {
        return this.currentHead.etag
    }
}

interface DatabaseWebSocket {
    readonly readyState: number
    addEventListener(type: string, listener: (event: any) => void): void
    send(data: string): void
    close(code?: number, reason?: string): void
}

interface LocationLike {
    protocol: string
    host: string
}

export interface NodeDatabaseSyncOptions {
    getAuth: () => Promise<string>
    getKeyPair: () => Promise<CryptoKeyPair>
    fetchImpl?: typeof fetch
    cryptoImpl?: Crypto
    webSocketFactory?: (url: string) => DatabaseWebSocket
    location?: LocationLike
    pageClientId?: string
    reconnectDelayMs?: number
    setTimeoutImpl?: typeof setTimeout
    clearTimeoutImpl?: typeof clearTimeout
}

type Listener<T> = (event: T) => void

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new NodeDatabaseProtocolError(`${label} must be a non-empty string`)
    }
    return value
}

function requireRevision(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new NodeDatabaseProtocolError(`${label} must be a non-negative safe integer`)
    }
    return value as number
}

function requireSha256(value: unknown, label: string): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
        throw new NodeDatabaseProtocolError(`${label} must be a SHA-256 hex digest`)
    }
    return value.toLowerCase()
}

function parseRevisionHeader(headers: Headers): number {
    const raw = headers.get('X-Risu-Revision')
    if (raw === null || !/^(0|[1-9][0-9]*)$/.test(raw)) {
        throw new NodeDatabaseProtocolError('X-Risu-Revision is missing or invalid')
    }
    return requireRevision(Number(raw), 'X-Risu-Revision')
}

function parseHeadHeaders(headers: Headers): NodeDatabaseHead {
    return {
        revision: parseRevisionHeader(headers),
        sha256: requireSha256(headers.get('X-Risu-Sha256'), 'X-Risu-Sha256'),
        etag: requireString(headers.get('ETag'), 'ETag'),
    }
}

function parseHeadRecord(value: Record<string, unknown>, label: string): NodeDatabaseHead {
    return {
        revision: requireRevision(value.revision, `${label}.revision`),
        sha256: requireSha256(value.sha256, `${label}.sha256`),
        etag: requireString(value.etag, `${label}.etag`),
    }
}

function assertMatchingHead(left: NodeDatabaseHead, right: NodeDatabaseHead, label: string) {
    if (
        left.revision !== right.revision
        || left.sha256 !== right.sha256
        || left.etag !== right.etag
    ) {
        throw new NodeDatabaseProtocolError(`${label} disagrees with response headers`)
    }
}

function normalizeGenerationFence(options: NodeDatabaseCommitOptions) {
    const values = [options.generationId, options.executorId, options.fencingToken]
    if (values.every((value) => value === undefined)) {
        return null
    }
    if (
        typeof options.generationId !== 'string'
        || options.generationId.length === 0
        || options.generationId.length > 128
        || typeof options.executorId !== 'string'
        || options.executorId.length === 0
        || options.executorId.length > 256
        || !Number.isSafeInteger(options.fencingToken)
        || (options.fencingToken as number) <= 0
    ) {
        throw new TypeError('generationId, executorId, and a positive fencingToken must be provided together')
    }
    return {
        generationId: options.generationId,
        executorId: options.executorId,
        fencingToken: options.fencingToken as number,
    }
}

function bytesToBase64Url(value: ArrayBuffer): string {
    const bytes = new Uint8Array(value)
    let binary = ''
    for (const byte of bytes) {
        binary += String.fromCharCode(byte)
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function randomId(cryptoImpl: Crypto): string {
    if (typeof cryptoImpl.randomUUID === 'function') {
        return cryptoImpl.randomUUID()
    }
    const bytes = cryptoImpl.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    return [...bytes]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
}

async function readJson(response: Response): Promise<unknown> {
    const text = await response.text()
    if (text.length === 0) {
        return null
    }
    try {
        return JSON.parse(text)
    }
    catch {
        throw new NodeDatabaseProtocolError(`Expected JSON response from ${response.url || 'server'}`)
    }
}

export async function deriveNodeDatabaseDeviceId(
    keyPair: CryptoKeyPair,
    cryptoImpl: Crypto = crypto,
): Promise<string> {
    const publicKey = await cryptoImpl.subtle.exportKey('jwk', keyPair.publicKey)
    const canonicalPublicKey = JSON.stringify({
        kty: publicKey.kty,
        crv: publicKey.crv,
        x: publicKey.x,
        y: publicKey.y,
    })
    const digest = await cryptoImpl.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonicalPublicKey),
    )
    return `risu-${bytesToBase64Url(digest)}`
}

export class NodeDatabaseSync {
    private readonly getAuth: () => Promise<string>
    private readonly getKeyPair: () => Promise<CryptoKeyPair>
    private readonly fetchImpl: typeof fetch
    private readonly cryptoImpl: Crypto
    private readonly webSocketFactory: (url: string) => DatabaseWebSocket
    private readonly location: LocationLike
    private readonly reconnectDelayMs: number
    private readonly setTimeoutImpl: typeof setTimeout
    private readonly clearTimeoutImpl: typeof clearTimeout
    private readonly pageClientId: string

    private identityPromise: Promise<NodeDatabaseClientIdentity> | null = null
    private _loadedSnapshotHead: NodeDatabaseHead | null = null
    private _observedServerHead: NodeDatabaseHead | null = null
    private commitQueue: Promise<void> = Promise.resolve()
    private socket: DatabaseWebSocket | null = null
    private openingSocket: Promise<void> | null = null
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private wantsSocket = false
    private readonly helloListeners = new Set<Listener<NodeDatabaseHelloEvent>>()
    private readonly committedListeners = new Set<Listener<NodeDatabaseCommittedEvent>>()
    private readonly errorListeners = new Set<Listener<Error>>()

    constructor(options: NodeDatabaseSyncOptions) {
        this.getAuth = options.getAuth
        this.getKeyPair = options.getKeyPair
        this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
        this.cryptoImpl = options.cryptoImpl ?? crypto
        this.pageClientId = options.pageClientId ?? randomId(this.cryptoImpl)
        this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000
        this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout
        this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout
        this.location = options.location ?? globalThis.location
        this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url))
    }

    /**
     * Backwards-compatible alias for the newest server head this page has
     * observed. This is deliberately not the CAS base used by commit().
     */
    get head(): NodeDatabaseHead | null {
        return this.observedServerHead
    }

    /** The revision whose exact database bytes are currently loaded by this page. */
    get loadedSnapshotHead(): NodeDatabaseHead | null {
        return this._loadedSnapshotHead ? { ...this._loadedSnapshotHead } : null
    }

    /** The newest authoritative head observed through HTTP or WebSocket. */
    get observedServerHead(): NodeDatabaseHead | null {
        return this._observedServerHead ? { ...this._observedServerHead } : null
    }

    async getIdentity(): Promise<NodeDatabaseClientIdentity> {
        if (!this.identityPromise) {
            this.identityPromise = (async () => {
                const deviceId = await deriveNodeDatabaseDeviceId(
                    await this.getKeyPair(),
                    this.cryptoImpl,
                )
                return Object.freeze({
                    deviceId,
                    pageClientId: this.pageClientId,
                    clientId: `${deviceId}.${this.pageClientId}`,
                })
            })()
        }
        return await this.identityPromise
    }

    async read(): Promise<Uint8Array | null> {
        const snapshot = await this.readSnapshot()
        if (!snapshot) {
            this._loadedSnapshotHead = null
            return null
        }
        this.adoptSnapshot(snapshot)
        return snapshot.data
    }

    /**
     * Fetches a candidate without making it the CAS base. Call adoptSnapshot()
     * only after the decoded bytes have actually replaced the page database.
     */
    async readSnapshot(): Promise<NodeDatabaseSnapshot | null> {
        const response = await this.fetchImpl(NODE_DATABASE_SYNC_PATH, {
            method: 'GET',
            headers: {
                'risu-auth': await this.getAuth(),
                'cache-control': 'no-cache',
            },
        })
        if (response.status === 404) {
            this._observedServerHead = null
            return null
        }
        if (!response.ok) {
            const body = await readJson(response).catch(() => null)
            throw new NodeDatabaseHttpError(
                response.status,
                `Database read failed (${response.status})`,
                body,
            )
        }

        const responseHead = parseHeadHeaders(response.headers)
        const data = new Uint8Array(await response.arrayBuffer())
        this.applyObservedHead(responseHead)
        return Object.freeze({
            head: Object.freeze({ ...responseHead }),
            data,
        })
    }

    adoptSnapshot(snapshot: NodeDatabaseSnapshot) {
        this.setLoadedSnapshotHead(snapshot.head)
        this.applyObservedHead(snapshot.head)
    }

    commit(data: Uint8Array, options: NodeDatabaseCommitOptions = {}): Promise<NodeDatabaseCommitResult> {
        const capturedData = new Uint8Array(data)
        const capturedOptions = { ...options }
        const operation = () => this.commitNow(capturedData, capturedOptions)
        const result = this.commitQueue.then(operation, operation)
        this.commitQueue = result.then(() => undefined, () => undefined)
        return result
    }

    async connect(): Promise<void> {
        this.wantsSocket = true
        if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) {
            return
        }
        if (this.openingSocket) {
            return await this.openingSocket
        }

        this.openingSocket = this.openSocket()
        try {
            await this.openingSocket
        }
        finally {
            this.openingSocket = null
        }
    }

    disconnect() {
        this.wantsSocket = false
        if (this.reconnectTimer !== null) {
            this.clearTimeoutImpl(this.reconnectTimer)
            this.reconnectTimer = null
        }
        const socket = this.socket
        this.socket = null
        socket?.close(1000, 'client disconnect')
    }

    onHello(listener: Listener<NodeDatabaseHelloEvent>): () => void {
        this.helloListeners.add(listener)
        return () => this.helloListeners.delete(listener)
    }

    onCommitted(listener: Listener<NodeDatabaseCommittedEvent>): () => void {
        this.committedListeners.add(listener)
        return () => this.committedListeners.delete(listener)
    }

    onError(listener: Listener<Error>): () => void {
        this.errorListeners.add(listener)
        return () => this.errorListeners.delete(listener)
    }

    private async commitNow(
        data: Uint8Array,
        options: NodeDatabaseCommitOptions,
    ): Promise<NodeDatabaseCommitResult> {
        const kind = options.kind ?? 'stable'
        if (kind !== 'stable' && kind !== 'streaming') {
            throw new TypeError('Database commit kind must be stable or streaming')
        }
        const identity = await this.getIdentity()
        const idempotencyKey = options.idempotencyKey
            ?? `risu-${this.pageClientId}-${randomId(this.cryptoImpl)}`
        if (idempotencyKey.length === 0 || idempotencyKey.length > 256) {
            throw new TypeError('idempotencyKey must be between 1 and 256 characters')
        }

        // Only bytes actually loaded by this page may be used as a CAS base.
        // A WebSocket observation must never silently bless stale local bytes.
        const baseHead = this._loadedSnapshotHead
        const headers: Record<string, string> = {
            'content-type': 'application/octet-stream',
            'risu-auth': await this.getAuth(),
            'If-Match': baseHead?.etag ?? '*',
            'Idempotency-Key': idempotencyKey,
            'X-Risu-Client-Id': identity.clientId,
            'X-Risu-Device-Id': identity.deviceId,
            'X-Risu-Commit-Kind': kind,
        }
        const generationFence = normalizeGenerationFence(options)
        if (generationFence) {
            headers['X-Risu-Generation-Id'] = generationFence.generationId
            headers['X-Risu-Executor-Id'] = generationFence.executorId
            headers['X-Risu-Fencing-Token'] = String(generationFence.fencingToken)
        }
        if (baseHead) {
            headers['X-Risu-Base-Revision'] = String(baseHead.revision)
        }

        const response = await this.fetchImpl(NODE_DATABASE_SYNC_PATH, {
            method: 'PUT',
            headers,
            body: data as BodyInit,
        })
        const body = await readJson(response)

        if ((response.status === 409 || response.status === 412) && isRecord(body) && body.conflict === true) {
            const reason = body.reason
            if (reason !== 'stale_base' && reason !== 'idempotency_key_reused') {
                throw new NodeDatabaseProtocolError('Database conflict reason is invalid')
            }
            const bodyHead = parseHeadRecord(body, 'conflict')
            const headerHead = parseHeadHeaders(response.headers)
            assertMatchingHead(bodyHead, headerHead, 'Database conflict')
            this.applyObservedHead(headerHead)
            throw new NodeDatabaseConflictError({
                status: response.status,
                conflictId: requireString(body.conflictId, 'conflict.conflictId'),
                reason,
                currentHead: headerHead,
            })
        }

        if (!response.ok) {
            throw new NodeDatabaseHttpError(
                response.status,
                `Database commit failed (${response.status})`,
                body,
            )
        }
        if (!isRecord(body) || body.ok !== true || typeof body.duplicate !== 'boolean') {
            throw new NodeDatabaseProtocolError('Database commit response is malformed')
        }

        const committedHead = parseHeadRecord(body, 'commit')
        const responseHead = parseHeadHeaders(response.headers)
        if (!body.duplicate) {
            assertMatchingHead(committedHead, responseHead, 'Database commit')
        }
        else {
            if (requireRevision(body.currentRevision, 'commit.currentRevision') !== responseHead.revision) {
                throw new NodeDatabaseProtocolError('commit.currentRevision disagrees with response headers')
            }
            if (requireSha256(body.currentSha256, 'commit.currentSha256') !== responseHead.sha256) {
                throw new NodeDatabaseProtocolError('commit.currentSha256 disagrees with response headers')
            }
            if (requireString(body.currentEtag, 'commit.currentEtag') !== responseHead.etag) {
                throw new NodeDatabaseProtocolError('commit.currentEtag disagrees with response headers')
            }
        }
        // The request body now corresponds to the accepted commit revision.
        // For an old idempotent replay this intentionally remains the original
        // accepted revision while observedServerHead advances to current head.
        this.setLoadedSnapshotHead(committedHead)
        this.applyObservedHead(responseHead)

        return {
            ...committedHead,
            duplicate: body.duplicate,
            currentRevision: responseHead.revision,
            currentSha256: responseHead.sha256,
            currentEtag: responseHead.etag,
            idempotencyKey,
        }
    }

    private async openSocket(): Promise<void> {
        try {
            const identity = await this.getIdentity()
            const response = await this.fetchImpl(NODE_DATABASE_SOCKET_TICKET_PATH, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'risu-auth': await this.getAuth(),
                    'X-Risu-Client-Id': identity.clientId,
                    'X-Risu-Device-Id': identity.deviceId,
                },
                body: JSON.stringify({ clientId: identity.clientId }),
            })
            const body = await readJson(response)
            if (!response.ok) {
                throw new NodeDatabaseHttpError(
                    response.status,
                    `Database socket ticket failed (${response.status})`,
                    body,
                )
            }
            if (!isRecord(body)) {
                throw new NodeDatabaseProtocolError('Database socket ticket response is malformed')
            }
            const ticket = requireString(body.ticket, 'socket ticket')
            requireRevision(body.expiresAt, 'socket ticket expiry')
            const socketPath = requireString(body.path, 'socket path')
            if (socketPath !== NODE_DATABASE_SOCKET_PATH) {
                throw new NodeDatabaseProtocolError('Database socket path is invalid')
            }
            if (!this.wantsSocket) {
                return
            }

            const protocol = this.location.protocol === 'https:' ? 'wss:' : 'ws:'
            const url = new URL(socketPath, `${protocol}//${this.location.host}`)
            url.searchParams.set('ticket', ticket)
            const socket = this.webSocketFactory(url.toString())
            this.socket = socket
            socket.addEventListener('message', (event) => this.handleSocketMessage(socket, event))
            socket.addEventListener('close', () => this.handleSocketClose(socket))
            socket.addEventListener('error', () => {
                this.emitError(new Error('Database sync WebSocket failed'))
            })
        }
        catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error))
            this.emitError(normalized)
            this.scheduleReconnect()
            throw normalized
        }
    }

    private handleSocketMessage(socket: DatabaseWebSocket, messageEvent: { data?: unknown }) {
        try {
            if (typeof messageEvent.data !== 'string') {
                throw new NodeDatabaseProtocolError('Database socket message must be text')
            }
            const parsed: unknown = JSON.parse(messageEvent.data)
            if (!isRecord(parsed)) {
                throw new NodeDatabaseProtocolError('Database socket message must be an object')
            }

            if (parsed.type === 'ping') {
                if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) {
                    throw new NodeDatabaseProtocolError('Database socket ping is malformed')
                }
                socket.send(JSON.stringify({ type: 'pong', ts: parsed.ts }))
                return
            }

            if (parsed.type === 'hello') {
                const head = parseHeadRecord(parsed, 'socket hello')
                const event: NodeDatabaseHelloEvent = {
                    type: 'hello',
                    ...head,
                    clientId: requireString(parsed.clientId, 'hello.clientId'),
                }
                this.applyObservedHead(head)
                this.emit(this.helloListeners, event)
                return
            }
            if (parsed.type === 'committed') {
                const head = parseHeadRecord(parsed, 'socket committed')
                if (parsed.kind !== 'stable' && parsed.kind !== 'streaming') {
                    throw new NodeDatabaseProtocolError('committed.kind is invalid')
                }
                if (typeof parsed.committedAt !== 'number' || !Number.isFinite(parsed.committedAt)) {
                    throw new NodeDatabaseProtocolError('committed.committedAt is invalid')
                }
                const event: NodeDatabaseCommittedEvent = {
                    type: 'committed',
                    ...head,
                    clientId: requireString(parsed.clientId, 'committed.clientId'),
                    kind: parsed.kind,
                    idempotencyKey: requireString(parsed.idempotencyKey, 'committed.idempotencyKey'),
                    committedAt: parsed.committedAt,
                }
                this.applyObservedHead(head)
                this.emit(this.committedListeners, event)
                return
            }
            throw new NodeDatabaseProtocolError(`Unknown database socket event: ${String(parsed.type)}`)
        }
        catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error))
            this.emitError(normalized)
            socket.close(1002, 'invalid database sync event')
        }
    }

    private handleSocketClose(socket: DatabaseWebSocket) {
        if (this.socket === socket) {
            this.socket = null
        }
        this.scheduleReconnect()
    }

    private scheduleReconnect() {
        if (!this.wantsSocket || this.reconnectTimer !== null) {
            return
        }
        this.reconnectTimer = this.setTimeoutImpl(() => {
            this.reconnectTimer = null
            void this.connect().catch(() => {})
        }, this.reconnectDelayMs)
    }

    private setLoadedSnapshotHead(head: NodeDatabaseHead) {
        if (
            this._observedServerHead
            && head.revision === this._observedServerHead.revision
            && (
                head.etag !== this._observedServerHead.etag
                || head.sha256 !== this._observedServerHead.sha256
            )
        ) {
            throw new NodeDatabaseProtocolError('Database revision maps to conflicting heads')
        }
        this._loadedSnapshotHead = Object.freeze({ ...head })
    }

    private applyObservedHead(head: NodeDatabaseHead) {
        if (this._observedServerHead && head.revision < this._observedServerHead.revision) {
            return
        }
        if (
            this._observedServerHead
            && head.revision === this._observedServerHead.revision
            && (
                head.etag !== this._observedServerHead.etag
                || head.sha256 !== this._observedServerHead.sha256
            )
        ) {
            throw new NodeDatabaseProtocolError('Database revision maps to conflicting heads')
        }
        this._observedServerHead = Object.freeze({ ...head })
    }

    private emit<T>(listeners: Set<Listener<T>>, event: T) {
        for (const listener of listeners) {
            try {
                listener(event)
            }
            catch (error) {
                this.emitError(error instanceof Error ? error : new Error(String(error)))
            }
        }
    }

    private emitError(error: Error) {
        for (const listener of this.errorListeners) {
            try {
                listener(error)
            }
            catch {
                // Error observers cannot be allowed to break transport cleanup.
            }
        }
    }
}
