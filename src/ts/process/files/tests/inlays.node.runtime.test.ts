import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InlayAsset } from '../inlays'

const fixture = vi.hoisted(() => ({
    browser: new Map<string, InlayAsset>(),
    server: new Map<string, Uint8Array>(),
}))

vi.mock('src/ts/platform', () => ({ isNodeServer: true }))
vi.mock('localforage', () => ({
    default: {
        createInstance: () => ({
            getItem: vi.fn(async (key: string) => fixture.browser.get(key) ?? null),
            setItem: vi.fn(async (key: string, value: InlayAsset) => {
                fixture.browser.set(key, value)
                return value
            }),
            removeItem: vi.fn(async (key: string) => {
                fixture.browser.delete(key)
            }),
            iterate: vi.fn(async (callback: (value: InlayAsset, key: string) => void) => {
                for (const [key, value] of fixture.browser) {
                    callback(value, key)
                }
            }),
        }),
    },
}))
vi.mock('src/ts/storage/nodeStorage', () => ({
    getSharedNodeStorage: () => ({
        getItem: vi.fn(async (key: string) => fixture.server.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: Uint8Array) => {
            fixture.server.set(key, Uint8Array.from(value))
        }),
        keys: vi.fn(async () => [...fixture.server.keys()]),
        removeItem: vi.fn(async (key: string) => {
            fixture.server.delete(key)
        }),
    }),
}))
vi.mock('src/ts/media', () => ({ getImageType: vi.fn() }))
vi.mock('src/ts/model/modellist', () => ({ getModelInfo: vi.fn() }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: vi.fn() }))
vi.mock('src/ts/util', () => ({ asBuffer: (value: Uint8Array) => value }))
vi.mock('uuid', () => ({ v4: () => 'fixture-id' }))

import {
    getInlayAsset,
    listInlayAssets,
    migrateNodeInlayAssets,
    setInlayAsset,
} from '../inlays'

function signature(name: string, data: string): InlayAsset {
    return {
        data,
        ext: 'json',
        name,
        type: 'signature',
    }
}

describe('Node inlay routing compatibility fixture', () => {
    beforeEach(() => {
        fixture.browser.clear()
        fixture.server.clear()
    })

    it('writes and reads community inlay ids through the shared server namespace only', async () => {
        await setInlayAsset('assets/community-card.png', signature(
            'community-card',
            '{"fixture":"shared"}',
        ))

        expect(fixture.browser.size).toBe(0)
        expect([...fixture.server.keys()]).toEqual(['inlays/assets/community-card.png'])
        await expect(getInlayAsset('assets/community-card.png')).resolves.toEqual({
            data: '{"fixture":"shared"}',
            ext: 'json',
            name: 'community-card',
            type: 'signature',
        })
    })

    it('migrates a legacy browser asset once and removes the duplicate payload', async () => {
        fixture.browser.set('legacy-community-id', signature(
            'legacy-community-id',
            '{"fixture":"legacy"}',
        ))

        expect(await migrateNodeInlayAssets()).toBe(1)
        expect(fixture.browser.size).toBe(0)
        expect(fixture.server.has('inlays/legacy-community-id')).toBe(true)
        await expect(listInlayAssets()).resolves.toEqual([[
            'legacy-community-id',
            signature('legacy-community-id', '{"fixture":"legacy"}'),
        ]])
    })
})
