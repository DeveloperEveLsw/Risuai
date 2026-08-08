import { beforeEach, describe, expect, it } from 'vitest'
import {
    NodeMcpToolCallStorage,
    type NodeMcpBinaryStorage,
} from './nodeMcpToolCallStorage'

class MemoryStorage implements NodeMcpBinaryStorage {
    readonly values = new Map<string, Uint8Array>()

    async getItem(key: string) {
        return this.values.get(key) ?? null
    }

    async setItem(key: string, value: Uint8Array) {
        this.values.set(key, Uint8Array.from(value))
    }

    async removeItem(key: string) {
        this.values.delete(key)
    }
}

describe('NodeMcpToolCallStorage', () => {
    let binary: MemoryStorage
    let storage: NodeMcpToolCallStorage<Record<string, unknown>>

    beforeEach(() => {
        binary = new MemoryStorage()
        storage = new NodeMcpToolCallStorage(binary)
    })

    it('round-trips a tool call in the server namespace', async () => {
        const value = {
            call: { id: 'call-1', name: 'search', arg: { query: 'hello' } },
            response: [{ type: 'text', text: 'world' }],
        }
        await storage.setItem('call-1', value)

        expect(await storage.getItem('call-1')).toEqual(value)
        expect(binary.values.has('mcp-tool-calls/call-1')).toBe(true)
    })

    it('rejects unsafe or corrupt records', async () => {
        await expect(storage.setItem('', {})).rejects.toThrow('Invalid MCP tool-call id')
        binary.values.set('mcp-tool-calls/broken', new TextEncoder().encode('{'))
        await expect(storage.getItem('broken')).rejects.toThrow('not valid JSON')
    })
})
