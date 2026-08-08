import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    MockNodeStorage: class MockNodeStorage {
        readonly databaseSync = { kind: 'node-sync' }
        async getItem() { return null }
        async setItem() {}
        async keys() { return [] }
        async removeItem() {}
    },
    MockAccountStorage: class MockAccountStorage {
        async getItem() { return null }
        async setItem() { return null }
        async keys() { return [] }
        async removeItem() {}
    },
    alertInput: vi.fn(),
    alertSelect: vi.fn(),
}))

vi.mock('src/ts/platform', () => ({ isNodeServer: true }))
vi.mock('./nodeStorage', () => ({ NodeStorage: mocks.MockNodeStorage }))
vi.mock('./accountStorage', () => ({ AccountStorage: mocks.MockAccountStorage }))
vi.mock('./opfsStorage', () => ({ OpfsStorage: class MockOpfsStorage {} }))
vi.mock('../globalApi.svelte', () => ({ replaceDbResources: vi.fn() }))
vi.mock('../alert', () => ({
    alertError: vi.fn(),
    alertInput: mocks.alertInput,
    alertSelect: mocks.alertSelect,
    alertStore: { set: vi.fn() },
}))
vi.mock('./database.svelte', () => ({
    getDatabase: () => ({ account: { useSync: true } }),
}))
vi.mock('./risuSave', () => ({
    decodeRisuSave: vi.fn(),
    encodeRisuSaveLegacy: vi.fn(),
}))
vi.mock('src/lang', () => ({ language: {} }))

import { AutoStorage } from './autoStorage'

describe('AutoStorage in a Node self-host', () => {
    beforeEach(() => {
        localStorage.clear()
        vi.clearAllMocks()
    })

    it('ignores a legacy accountst flag and initializes the authoritative Node store', async () => {
        localStorage.setItem('accountst', 'able')
        const storage = new AutoStorage()

        await storage.Init()

        expect(storage.realStorage).toBeInstanceOf(mocks.MockNodeStorage)
        expect(storage.isAccount).toBe(false)
    })

    it('refuses a later account-sync transition and restores Node storage', async () => {
        localStorage.setItem('dosync', 'sync')
        const storage = new AutoStorage()
        storage.realStorage = new mocks.MockAccountStorage() as never
        storage.isAccount = true

        await expect(storage.checkAccountSync()).resolves.toBe(false)

        expect(storage.realStorage).toBeInstanceOf(mocks.MockNodeStorage)
        expect(storage.isAccount).toBe(false)
        expect(mocks.alertInput).not.toHaveBeenCalled()
        expect(mocks.alertSelect).not.toHaveBeenCalled()
    })
})
