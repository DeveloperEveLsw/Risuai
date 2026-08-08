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
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
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
