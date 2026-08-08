import { beforeEach, describe, expect, it } from 'vitest'
import {
    NodeJsonKeyValueStorage,
    type NodeJsonBinaryStorage,
} from './nodeJsonKeyValueStorage'

class MemoryStorage implements NodeJsonBinaryStorage {
    readonly values = new Map<string, Uint8Array>()
    async getItem(key: string) { return this.values.get(key) ?? null }
    async setItem(key: string, value: Uint8Array) { this.values.set(key, Uint8Array.from(value)) }
}

describe('NodeJsonKeyValueStorage', () => {
    let binary: MemoryStorage
    let storage: NodeJsonKeyValueStorage<boolean | number>

    beforeEach(() => {
        binary = new MemoryStorage()
        storage = new NodeJsonKeyValueStorage(binary, 'plugin-permissions/')
    })

    it('hashes arbitrary logical keys and round-trips typed values', async () => {
        await storage.setItem('plugin with a long name_replacer_lastGrantTime', 123)
        expect(await storage.getItem('plugin with a long name_replacer_lastGrantTime')).toBe(123)
        expect([...binary.values.keys()]).toEqual([
            expect.stringMatching(/^plugin-permissions\/[a-f0-9]{64}$/),
        ])
    })

    it('detects a key mismatch in a stored envelope', async () => {
        await storage.setItem('one', true)
        const [physicalKey] = binary.values.keys()
        binary.values.set(physicalKey, new TextEncoder().encode(JSON.stringify({
            schemaVersion: 1,
            key: 'other',
            value: true,
        })))
        await expect(storage.getItem('one')).rejects.toThrow('malformed')
    })
})
