import { beforeEach, describe, expect, it } from 'vitest'
import type { InlayAsset } from '../process/files/inlays'
import {
    decodeNodeInlayAsset,
    encodeNodeInlayAsset,
    NodeInlayStorage,
    type NodeInlayBinaryStorage,
} from './nodeInlayStorage'

class MemoryBinaryStorage implements NodeInlayBinaryStorage {
    readonly values = new Map<string, Uint8Array>()

    async getItem(key: string) {
        return this.values.get(key) ?? null
    }

    async setItem(key: string, value: Uint8Array) {
        this.values.set(key, Uint8Array.from(value))
    }

    async keys() {
        return [...this.values.keys()]
    }

    async removeItem(key: string) {
        this.values.delete(key)
    }
}

describe('NodeInlayStorage', () => {
    let binaryStorage: MemoryBinaryStorage
    let storage: NodeInlayStorage

    beforeEach(() => {
        binaryStorage = new MemoryBinaryStorage()
        storage = new NodeInlayStorage(binaryStorage)
    })

    it('round-trips binary media and metadata without base64 expansion', async () => {
        const asset: InlayAsset = {
            data: new Blob([Uint8Array.from([0, 1, 2, 255])], { type: 'image/png' }),
            ext: 'png',
            height: 240,
            name: 'photo.png',
            type: 'image',
            width: 320,
        }

        await storage.setItem('image-id', asset)
        const decoded = await storage.getItem('image-id')

        expect(decoded).toMatchObject({
            ext: 'png',
            height: 240,
            name: 'photo.png',
            type: 'image',
            width: 320,
        })
        expect(decoded?.data).toBeInstanceOf(Blob)
        expect([...new Uint8Array(await (decoded?.data as Blob).arrayBuffer())]).toEqual([0, 1, 2, 255])
        expect(binaryStorage.values.get('inlays/image-id')?.byteLength).toBeLessThan(512)
    })

    it('preserves signature strings and lists only the inlay namespace', async () => {
        await storage.setItem('signature-id', {
            data: '{"signature":true}',
            ext: 'json',
            name: 'signature-id',
            type: 'signature',
        })
        binaryStorage.values.set('assets/unrelated', Uint8Array.from([1]))

        expect(await storage.entries()).toEqual([[
            'signature-id',
            expect.objectContaining({
                data: '{"signature":true}',
                type: 'signature',
            }),
        ]])
    })

    it('does not issue a destructive remove for a missing asset', async () => {
        await storage.removeItem('missing')
        expect(binaryStorage.values.size).toBe(0)
    })

    it('rejects corrupt records while preserving opaque upstream asset ids', async () => {
        expect(() => decodeNodeInlayAsset(Uint8Array.from([1, 2, 3]))).toThrow('truncated')
        await storage.setItem('assets/character.png', {
            data: 'x',
            ext: 'json',
            name: 'x',
            type: 'signature',
        })
        expect(binaryStorage.values.has('inlays/assets/character.png')).toBe(true)
        await expect(storage.setItem('', {
            data: 'x',
            ext: 'json',
            name: 'x',
            type: 'signature',
        })).rejects.toThrow('Invalid inlay asset id')
    })

    it('keeps the standalone codec symmetric for string data', async () => {
        const asset: InlayAsset = {
            data: 'data:image/png;base64,aGVsbG8=',
            ext: 'png',
            name: 'legacy.png',
            type: 'image',
        }
        expect(decodeNodeInlayAsset(await encodeNodeInlayAsset(asset))).toEqual(asset)
    })
})
