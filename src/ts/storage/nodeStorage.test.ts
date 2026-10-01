import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({
    language: {},
}))

vi.mock('../alert', () => ({
    alertError: vi.fn(),
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
}))

vi.mock('../util', () => ({
    base64url: vi.fn(() => 'encoded'),
    getKeypairStore: vi.fn(),
    saveKeypairStore: vi.fn(),
}))

import { NODE_DATABASE_STORAGE_KEY, NodeStorage } from './nodeStorage'
import type { NodeDatabaseSync } from './nodeDatabaseSync'

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
})

describe('NodeStorage rate-limited asset writes', () => {
    function prepareStorage() {
        const { storage } = storageWithFakeDatabaseSync()
        storage.authChecked = true
        const auth = vi.spyOn(storage, 'createAuth').mockResolvedValue('signed-auth')
        return { storage, auth }
    }

    function rateLimited(retryAfter?: string) {
        return new Response(JSON.stringify({ error: 'Too many requests' }), {
            status: 429,
            headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
        })
    }

    it.each([
        ['seconds', '37', 37_250],
        ['HTTP date', 'Mon, 14 Sep 2026 06:01:00 GMT', 60_250],
        ['missing header', undefined, 60_000],
        ['invalid header', 'invalid', 60_000],
    ])('honors %s Retry-After and refreshes auth before retrying', async (_, header, delay) => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-14T06:00:00Z'))
        const { storage, auth } = prepareStorage()
        auth.mockResolvedValueOnce('first-token').mockResolvedValue('fresh-token')
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(rateLimited(header))
            .mockResolvedValueOnce(new Response('{"success":true}'))
        vi.stubGlobal('fetch', fetchMock)
        const value = Uint8Array.from([1, 2, 3])
        const write = storage.setItem('assets/example.png', value)

        await vi.advanceTimersByTimeAsync(0)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await write

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(fetchMock).toHaveBeenLastCalledWith('/api/write', expect.objectContaining({
            body: value,
            headers: expect.objectContaining({ 'risu-auth': 'fresh-token' }),
        }))
    })

    it('holds newly queued writes during a shared cooldown', async () => {
        vi.useFakeTimers()
        const { storage } = prepareStorage()
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(rateLimited('2'))
            .mockImplementation(async () => new Response('{"success":true}'))
        vi.stubGlobal('fetch', fetchMock)
        const first = storage.setItem('assets/one.png', Uint8Array.of(1))
        await vi.advanceTimersByTimeAsync(0)
        const second = storage.setItem('assets/two.png', Uint8Array.of(2))
        await vi.advanceTimersByTimeAsync(2249)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        await Promise.all([first, second])
        expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('stops after three retries and preserves the HTTP error', async () => {
        vi.useFakeTimers()
        const { storage } = prepareStorage()
        const fetchMock = vi.fn(async () => rateLimited('1'))
        vi.stubGlobal('fetch', fetchMock)
        const write = storage.setItem('assets/example.png', Uint8Array.of(1))
        const rejection = expect(write).rejects.toThrow('HTTP 429')
        await vi.advanceTimersByTimeAsync(3750)
        await rejection
        expect(fetchMock).toHaveBeenCalledTimes(4)
    })

    it.each([401, 413, 507])('does not retry permanent HTTP %i failures', async (status) => {
        const { storage } = prepareStorage()
        const fetchMock = vi.fn(async () => new Response('{"error":"server reason"}', { status }))
        vi.stubGlobal('fetch', fetchMock)
        await expect(storage.setItem('assets/example.png', Uint8Array.of(1)))
            .rejects.toThrow(`HTTP ${status}) for assets/example.png: server reason`)
        expect(fetchMock).toHaveBeenCalledOnce()
    })
})

function storageWithFakeDatabaseSync() {
    const databaseSync = {
        read: vi.fn(async () => Uint8Array.from([1, 2, 3])),
        commit: vi.fn(async () => ({
            duplicate: false,
            revision: 1,
            sha256: '1'.repeat(64),
            etag: 'etag-1',
            currentRevision: 1,
            currentSha256: '1'.repeat(64),
            currentEtag: 'etag-1',
            idempotencyKey: 'save-1',
        })),
    }
    const storage = new NodeStorage({
        databaseSync: databaseSync as unknown as NodeDatabaseSync,
    })
    return { storage, databaseSync }
}

describe('NodeStorage database routing', () => {
    it('routes only database/database.bin through the versioned transport', async () => {
        const { storage, databaseSync } = storageWithFakeDatabaseSync()
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (input === '/api/test_auth') {
                return new Response(JSON.stringify({ status: 'correct' }))
            }
            if (input === '/api/write') {
                return new Response(JSON.stringify({}), { status: 200 })
            }
            throw new Error(`Unexpected URL: ${String(input)}`)
        })
        vi.stubGlobal('fetch', fetchMock)
        vi.spyOn(storage, 'createAuth').mockResolvedValue('signed-auth')

        await storage.setItem(NODE_DATABASE_STORAGE_KEY, Uint8Array.from([9]), {
            kind: 'streaming',
            idempotencyKey: 'database-save',
        })
        const database = await storage.getItem(NODE_DATABASE_STORAGE_KEY)

        expect(databaseSync.commit).toHaveBeenCalledWith(
            Uint8Array.from([9]),
            { kind: 'streaming', idempotencyKey: 'database-save' },
        )
        expect(databaseSync.read).toHaveBeenCalledOnce()
        expect([...database]).toEqual([1, 2, 3])
        expect(fetchMock).not.toHaveBeenCalled()

        await storage.setItem('assets/avatar.png', Uint8Array.from([4]))

        expect(fetchMock).toHaveBeenCalledWith('/api/write', expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
                'file-path': Buffer.from('assets/avatar.png').toString('hex'),
                'risu-auth': 'signed-auth',
            }),
        }))
        expect(databaseSync.commit).toHaveBeenCalledTimes(1)
    })

    it('does not persist the short-lived signed auth token in localStorage', async () => {
        const { storage } = storageWithFakeDatabaseSync()
        storage.authChecked = true
        vi.spyOn(storage, 'createAuth').mockResolvedValue('short-lived-token')
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({
            expiresAt: Date.now() + 60_000,
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))
        vi.stubGlobal('fetch', fetchMock)

        expect(await storage.getProxyAuth()).toBe('short-lived-token')
        expect(fetchMock).toHaveBeenCalledWith('/api/hub-session', {
            method: 'POST',
            headers: { 'risu-auth': 'short-lived-token' },
        })
        expect(localStorage.getItem('risuauth')).toBeNull()
    })

    it('hex-encodes each legacy removal key independently', async () => {
        const { storage } = storageWithFakeDatabaseSync()
        storage.authChecked = true
        vi.spyOn(storage, 'createAuth').mockResolvedValue('signed-auth')
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }))
        vi.stubGlobal('fetch', fetchMock)

        await storage.removeItem(['assets/one.png', 'assets/two.png'])

        expect(fetchMock).toHaveBeenCalledWith('/api/remove', expect.objectContaining({
            headers: expect.objectContaining({
                'file-path': [
                    Buffer.from('assets/one.png').toString('hex'),
                    Buffer.from('assets/two.png').toString('hex'),
                ].join('$$'),
            }),
        }))
    })
})
