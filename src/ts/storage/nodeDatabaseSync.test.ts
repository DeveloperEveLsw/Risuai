import { webcrypto } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
    NODE_DATABASE_SOCKET_PATH,
    NODE_DATABASE_SOCKET_TICKET_PATH,
    NODE_DATABASE_SYNC_PATH,
    NodeDatabaseConflictError,
    NodeDatabaseProtocolError,
    NodeDatabaseSync,
    deriveNodeDatabaseDeviceId,
} from './nodeDatabaseSync'

const cryptoImpl = webcrypto as unknown as Crypto
const sha0 = '0'.repeat(64)
const sha1 = '1'.repeat(64)
const sha2 = '2'.repeat(64)

let keyPair: CryptoKeyPair

beforeAll(async () => {
    keyPair = await cryptoImpl.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify'],
    ) as CryptoKeyPair
})

function responseHead(revision: number, sha256: string, etag = `"risu-${revision}-${sha256}"`) {
    return {
        ETag: etag,
        'X-Risu-Revision': String(revision),
        'X-Risu-Sha256': sha256,
    }
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
    return new Response(JSON.stringify(body), {
        ...init,
        headers: {
            'content-type': 'application/json',
            ...init.headers,
        },
    })
}

function makeSync(fetchImpl: typeof fetch, options: Partial<ConstructorParameters<typeof NodeDatabaseSync>[0]> = {}) {
    return new NodeDatabaseSync({
        getAuth: async () => 'signed-auth',
        getKeyPair: async () => keyPair,
        fetchImpl,
        cryptoImpl,
        location: { protocol: 'https:', host: 'risu.example' },
        pageClientId: 'page-a',
        ...options,
    })
}

describe('NodeDatabaseSync HTTP transport', () => {
    it('derives a stable device id from the existing keypair while keeping page ids ephemeral', async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const first = makeSync(fetchImpl, { pageClientId: 'page-a' })
        const second = makeSync(fetchImpl, { pageClientId: 'page-b' })

        const firstIdentity = await first.getIdentity()
        const secondIdentity = await second.getIdentity()

        expect(firstIdentity.deviceId).toBe(await deriveNodeDatabaseDeviceId(keyPair, cryptoImpl))
        expect(secondIdentity.deviceId).toBe(firstIdentity.deviceId)
        expect(firstIdentity.pageClientId).toBe('page-a')
        expect(secondIdentity.pageClientId).toBe('page-b')
        expect(firstIdentity.clientId).not.toBe(secondIdentity.clientId)
    })

    it('reads the authoritative blob and uses its ETag and revision on commit', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3]), {
                status: 200,
                headers: responseHead(4, sha0),
            }))
            .mockResolvedValueOnce(jsonResponse({
                ok: true,
                duplicate: false,
                revision: 5,
                sha256: sha1,
                etag: `"risu-5-${sha1}"`,
            }, {
                status: 200,
                headers: responseHead(5, sha1),
            }))
        const sync = makeSync(fetchMock as unknown as typeof fetch)

        expect([...await sync.read()]).toEqual([1, 2, 3])
        const committed = await sync.commit(Uint8Array.from([4, 5]), {
            kind: 'streaming',
            idempotencyKey: 'save-5',
            generationId: 'command-5',
            executorId: 'resident-1',
            fencingToken: 7,
        })

        expect(fetchMock).toHaveBeenNthCalledWith(1, NODE_DATABASE_SYNC_PATH, expect.objectContaining({
            method: 'GET',
            headers: expect.objectContaining({ 'risu-auth': 'signed-auth' }),
        }))
        const put = fetchMock.mock.calls[1][1] as RequestInit
        const headers = put.headers as Record<string, string>
        expect(fetchMock.mock.calls[1][0]).toBe(NODE_DATABASE_SYNC_PATH)
        expect(put.method).toBe('PUT')
        expect(headers['If-Match']).toBe(`"risu-4-${sha0}"`)
        expect(headers['X-Risu-Base-Revision']).toBe('4')
        expect(headers['Idempotency-Key']).toBe('save-5')
        expect(headers['X-Risu-Commit-Kind']).toBe('streaming')
        expect(headers['X-Risu-Generation-Id']).toBe('command-5')
        expect(headers['X-Risu-Executor-Id']).toBe('resident-1')
        expect(headers['X-Risu-Fencing-Token']).toBe('7')
        expect(headers['X-Risu-Client-Id']).toContain('.page-a')
        expect(headers['X-Risu-Device-Id']).toBe((await sync.getIdentity()).deviceId)
        expect([...new Uint8Array(put.body as ArrayBuffer)]).toEqual([4, 5])
        expect(committed).toMatchObject({
            revision: 5,
            duplicate: false,
            currentRevision: 5,
            idempotencyKey: 'save-5',
        })
        expect(sync.head?.revision).toBe(5)
        expect(sync.loadedSnapshotHead?.revision).toBe(5)
        expect(sync.observedServerHead?.revision).toBe(5)
    })

    it('uses X-Risu-ETag when a CDN weakens the standard representation ETag', async () => {
        const strongReadEtag = `"risu-4-${sha0}"`
        const strongCommitEtag = `"risu-5-${sha1}"`
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3]), {
                status: 200,
                headers: {
                    ...responseHead(4, sha0, `W/${strongReadEtag}`),
                    'X-Risu-ETag': strongReadEtag,
                },
            }))
            .mockResolvedValueOnce(jsonResponse({
                ok: true,
                duplicate: true,
                revision: 5,
                sha256: sha1,
                etag: strongCommitEtag,
                currentRevision: 5,
                currentSha256: sha1,
                currentEtag: strongCommitEtag,
            }, {
                status: 200,
                headers: {
                    ...responseHead(5, sha1, `W/${strongCommitEtag}`),
                    'X-Risu-ETag': strongCommitEtag,
                },
            }))
        const sync = makeSync(fetchMock as unknown as typeof fetch)

        await sync.read()
        const committed = await sync.commit(Uint8Array.from([4, 5]))

        const put = fetchMock.mock.calls[1][1] as RequestInit
        expect((put.headers as Record<string, string>)['If-Match']).toBe(strongReadEtag)
        expect(committed.duplicate).toBe(true)
        expect(committed.etag).toBe(strongCommitEtag)
        expect(sync.loadedSnapshotHead?.etag).toBe(strongCommitEtag)
    })

    it('falls back to a strong standard ETag from an older server', async () => {
        const strongEtag = `"risu-2-${sha1}"`
        const fetchMock = vi.fn().mockResolvedValueOnce(new Response(Uint8Array.from([1]), {
            status: 200,
            headers: responseHead(2, sha1, strongEtag),
        }))
        const sync = makeSync(fetchMock as unknown as typeof fetch)

        await sync.read()

        expect(sync.loadedSnapshotHead?.etag).toBe(strongEtag)
    })

    it.each([
        {
            name: 'a weak standard ETag without the canonical header',
            headers: responseHead(2, sha1, `W/"risu-2-${sha1}"`),
            label: 'ETag',
        },
        {
            name: 'a weak canonical ETag even when the standard ETag is strong',
            headers: {
                ...responseHead(2, sha1),
                'X-Risu-ETag': `W/"risu-2-${sha1}"`,
            },
            label: 'X-Risu-ETag',
        },
        {
            name: 'a malformed canonical ETag even when the standard ETag is strong',
            headers: {
                ...responseHead(2, sha1),
                'X-Risu-ETag': `risu-2-${sha1}`,
            },
            label: 'X-Risu-ETag',
        },
    ])('rejects $name', async ({ headers, label }) => {
        const fetchMock = vi.fn().mockResolvedValueOnce(new Response(Uint8Array.from([1]), {
            status: 200,
            headers,
        }))
        const sync = makeSync(fetchMock as unknown as typeof fetch)

        await expect(sync.read()).rejects.toThrow(
            new NodeDatabaseProtocolError(`${label} must be a strong ETag`),
        )
        expect(sync.loadedSnapshotHead).toBeNull()
    })

    it('rejects a weak ETag in a commit body even when the canonical header is strong', async () => {
        const strongEtag = `"risu-3-${sha1}"`
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
            ok: true,
            duplicate: false,
            revision: 3,
            sha256: sha1,
            etag: `W/${strongEtag}`,
        }, {
            status: 200,
            headers: {
                ...responseHead(3, sha1, `W/${strongEtag}`),
                'X-Risu-ETag': strongEtag,
            },
        }))
        const sync = makeSync(fetchMock as unknown as typeof fetch)

        await expect(sync.commit(Uint8Array.from([1]))).rejects.toThrow(
            new NodeDatabaseProtocolError('commit.etag must be a strong ETag'),
        )
        expect(sync.loadedSnapshotHead).toBeNull()
    })

    it('does not promote a staged remote read to the CAS base until it is adopted', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(Uint8Array.from([1]), {
                status: 200,
                headers: responseHead(1, sha1),
            }))
            .mockResolvedValueOnce(new Response(Uint8Array.from([2]), {
                status: 200,
                headers: responseHead(2, sha2),
            }))
        const sync = makeSync(fetchMock as unknown as typeof fetch)
        await sync.read()

        const candidate = await sync.readSnapshot()

        expect(candidate?.head.revision).toBe(2)
        expect(sync.loadedSnapshotHead?.revision).toBe(1)
        expect(sync.observedServerHead?.revision).toBe(2)
        sync.adoptSnapshot(candidate!)
        expect(sync.loadedSnapshotHead?.revision).toBe(2)
    })

    it('rejects a partial generation fence before sending database bytes', async () => {
        const fetchMock = vi.fn()
        const sync = makeSync(fetchMock as unknown as typeof fetch)

        await expect(sync.commit(Uint8Array.from([1]), {
            idempotencyKey: 'partial-fence',
            generationId: 'command-1',
        })).rejects.toThrow('generationId, executorId, and a positive fencingToken')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('uses If-Match star for the first atomic create after a 404', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(null, { status: 404 }))
            .mockResolvedValueOnce(jsonResponse({
                ok: true,
                duplicate: false,
                revision: 1,
                sha256: sha1,
                etag: `"risu-1-${sha1}"`,
            }, {
                status: 200,
                headers: responseHead(1, sha1),
            }))
        const sync = makeSync(fetchMock as unknown as typeof fetch)

        expect(await sync.read()).toBeNull()
        await sync.commit(Uint8Array.from([9]), { idempotencyKey: 'initial-save' })

        const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>
        expect(headers['If-Match']).toBe('*')
        expect(headers['X-Risu-Base-Revision']).toBeUndefined()
    })

    it('does not silently load an unseen snapshot as the base for caller-owned bytes', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
            ok: false,
            conflict: true,
            reason: 'stale_base',
            conflictId: 'unseen-server-database',
            revision: 1,
            sha256: sha1,
            etag: `"risu-1-${sha1}"`,
        }, {
            status: 409,
            headers: responseHead(1, sha1),
        }))
        const sync = makeSync(fetchMock as unknown as typeof fetch)

        const error = await sync.commit(Uint8Array.from([9]), {
            idempotencyKey: 'unbased-save',
        }).catch((caught) => caught)

        expect(fetchMock).toHaveBeenCalledOnce()
        expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({
            method: 'PUT',
            headers: expect.objectContaining({ 'If-Match': '*' }),
        }))
        expect(error).toBeInstanceOf(NodeDatabaseConflictError)
        expect(sync.loadedSnapshotHead).toBeNull()
        expect(sync.observedServerHead?.revision).toBe(1)
    })

    it('throws a typed conflict that preserves the conflict id and current head', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(Uint8Array.from([1]), {
                status: 200,
                headers: responseHead(2, sha0),
            }))
            .mockResolvedValueOnce(jsonResponse({
                ok: false,
                conflict: true,
                reason: 'stale_base',
                conflictId: 'conflict-17',
                revision: 3,
                sha256: sha2,
                etag: `"risu-3-${sha2}"`,
            }, {
                status: 409,
                headers: responseHead(3, sha2),
            }))
        const sync = makeSync(fetchMock as unknown as typeof fetch)
        await sync.read()

        const error = await sync.commit(Uint8Array.from([2]), {
            idempotencyKey: 'stale-save',
        }).catch((caught) => caught)

        expect(error).toBeInstanceOf(NodeDatabaseConflictError)
        expect(error).toMatchObject({
            status: 409,
            conflictId: 'conflict-17',
            reason: 'stale_base',
            currentRevision: 3,
            currentSha256: sha2,
            currentEtag: `"risu-3-${sha2}"`,
        })
        expect(sync.head).toEqual({
            revision: 3,
            sha256: sha2,
            etag: `"risu-3-${sha2}"`,
        })
        expect(sync.loadedSnapshotHead).toEqual({
            revision: 2,
            sha256: sha0,
            etag: `"risu-2-${sha0}"`,
        })
    })

    it('keeps the current head when an idempotent replay describes an older commit', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(Uint8Array.from([1]), {
                status: 200,
                headers: responseHead(6, sha2),
            }))
            .mockResolvedValueOnce(jsonResponse({
                ok: true,
                duplicate: true,
                revision: 4,
                sha256: sha1,
                etag: `"risu-4-${sha1}"`,
                currentRevision: 6,
                currentSha256: sha2,
                currentEtag: `"risu-6-${sha2}"`,
            }, {
                status: 200,
                headers: responseHead(6, sha2),
            }))
        const sync = makeSync(fetchMock as unknown as typeof fetch)
        await sync.read()

        const result = await sync.commit(Uint8Array.from([1]), { idempotencyKey: 'replay' })

        expect(result.revision).toBe(4)
        expect(result.currentRevision).toBe(6)
        expect(sync.head?.revision).toBe(6)
        expect(sync.loadedSnapshotHead?.revision).toBe(4)
        expect(sync.observedServerHead?.revision).toBe(6)
    })
})

class FakeWebSocket {
    readyState = 1
    readonly sent: string[] = []
    readonly closes: Array<[number | undefined, string | undefined]> = []
    private readonly listeners = new Map<string, Set<(event: any) => void>>()

    addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set()
        listeners.add(listener)
        this.listeners.set(type, listeners)
    }

    send(data: string) {
        this.sent.push(data)
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

describe('NodeDatabaseSync WebSocket transport', () => {
    it('uses a fresh one-time ticket on reconnect and emits validated hello/committed events', async () => {
        let ticketNumber = 0
        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            expect(input).toBe(NODE_DATABASE_SOCKET_TICKET_PATH)
            ticketNumber += 1
            return jsonResponse({
                ticket: `ticket-${ticketNumber}`,
                expiresAt: 123456,
                path: NODE_DATABASE_SOCKET_PATH,
            })
        })
        const sockets: FakeWebSocket[] = []
        const urls: string[] = []
        let scheduledReconnect: (() => void) | null = null
        const sync = makeSync(fetchMock as unknown as typeof fetch, {
            webSocketFactory: (url) => {
                urls.push(url)
                const socket = new FakeWebSocket()
                sockets.push(socket)
                return socket
            },
            setTimeoutImpl: ((callback: TimerHandler) => {
                scheduledReconnect = callback as () => void
                return 1
            }) as unknown as typeof setTimeout,
            clearTimeoutImpl: (() => {}) as typeof clearTimeout,
        })
        const hello = vi.fn()
        const committed = vi.fn()
        sync.onHello(hello)
        sync.onCommitted(committed)

        await sync.connect()
        expect(urls[0]).toBe('wss://risu.example/api/sync/database/ws?ticket=ticket-1')
        const ticketRequest = fetchMock.mock.calls[0][1] as RequestInit
        expect(ticketRequest.headers).toEqual(expect.objectContaining({
            'risu-auth': 'signed-auth',
            'X-Risu-Client-Id': expect.stringContaining('.page-a'),
        }))

        sockets[0].message({
            type: 'hello',
            revision: 7,
            sha256: sha1,
            etag: `"risu-7-${sha1}"`,
            clientId: 'server-view',
        })
        sockets[0].message({
            type: 'committed',
            revision: 8,
            sha256: sha2,
            etag: `"risu-8-${sha2}"`,
            clientId: 'phone',
            kind: 'stable',
            idempotencyKey: 'phone-save',
            committedAt: 456,
        })
        sockets[0].message({ type: 'ping', ts: 99 })

        expect(hello).toHaveBeenCalledWith(expect.objectContaining({ type: 'hello', revision: 7 }))
        expect(committed).toHaveBeenCalledWith(expect.objectContaining({
            type: 'committed',
            revision: 8,
            clientId: 'phone',
        }))
        expect(sync.head?.revision).toBe(8)
        expect(sync.loadedSnapshotHead).toBeNull()
        expect(sync.observedServerHead?.revision).toBe(8)
        expect(sockets[0].sent).toEqual([JSON.stringify({ type: 'pong', ts: 99 })])

        sockets[0].serverClose()
        expect(scheduledReconnect).toBeTypeOf('function')
        scheduledReconnect!()
        await vi.waitFor(() => expect(sockets).toHaveLength(2))
        expect(urls[1]).toContain('ticket=ticket-2')
        expect(fetchMock).toHaveBeenCalledTimes(2)

        sync.disconnect()
    })

    it('never uses a WebSocket-observed revision as the CAS base for older loaded bytes', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            if (input === NODE_DATABASE_SYNC_PATH && init?.method === 'GET') {
                return new Response(Uint8Array.from([1]), {
                    status: 200,
                    headers: responseHead(1, sha1),
                })
            }
            if (input === NODE_DATABASE_SOCKET_TICKET_PATH) {
                return jsonResponse({
                    ticket: 'ticket-concurrency',
                    expiresAt: 123456,
                    path: NODE_DATABASE_SOCKET_PATH,
                })
            }
            if (input === NODE_DATABASE_SYNC_PATH && init?.method === 'PUT') {
                return jsonResponse({
                    ok: false,
                    conflict: true,
                    reason: 'stale_base',
                    conflictId: 'preserved-stale-write',
                    revision: 2,
                    sha256: sha2,
                    etag: `"risu-2-${sha2}"`,
                }, {
                    status: 409,
                    headers: responseHead(2, sha2),
                })
            }
            throw new Error(`Unexpected request: ${String(input)} ${init?.method}`)
        })
        const socket = new FakeWebSocket()
        const sync = makeSync(fetchMock as unknown as typeof fetch, {
            webSocketFactory: () => socket,
        })

        await sync.read()
        await sync.connect()
        socket.message({
            type: 'committed',
            revision: 2,
            sha256: sha2,
            etag: `"risu-2-${sha2}"`,
            clientId: 'other-device',
            kind: 'stable',
            idempotencyKey: 'other-save',
            committedAt: 999,
        })

        expect(sync.loadedSnapshotHead?.revision).toBe(1)
        expect(sync.observedServerHead?.revision).toBe(2)

        const error = await sync.commit(Uint8Array.from([9]), {
            idempotencyKey: 'stale-local-save',
        }).catch((caught) => caught)
        const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
        const putHeaders = putCall?.[1]?.headers as Record<string, string>

        expect(putHeaders['If-Match']).toBe(`"risu-1-${sha1}"`)
        expect(putHeaders['X-Risu-Base-Revision']).toBe('1')
        expect(error).toBeInstanceOf(NodeDatabaseConflictError)
        expect(error.conflictId).toBe('preserved-stale-write')
        expect(sync.loadedSnapshotHead?.revision).toBe(1)
        expect(sync.observedServerHead?.revision).toBe(2)

        sync.disconnect()
    })

    it('rejects malformed events and closes the socket with a protocol error', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({
            ticket: 'ticket-1',
            expiresAt: 123456,
            path: NODE_DATABASE_SOCKET_PATH,
        }))
        const socket = new FakeWebSocket()
        const errors: Error[] = []
        const sync = makeSync(fetchMock as unknown as typeof fetch, {
            webSocketFactory: () => socket,
        })
        sync.onError((error) => errors.push(error))
        await sync.connect()

        socket.message({ type: 'committed', revision: 1 })

        expect(errors.at(-1)).toBeInstanceOf(NodeDatabaseProtocolError)
        expect(socket.closes.at(-1)?.[0]).toBe(1002)
        expect(sync.head).toBeNull()
        expect(sync.loadedSnapshotHead).toBeNull()
        sync.disconnect()
    })
})
