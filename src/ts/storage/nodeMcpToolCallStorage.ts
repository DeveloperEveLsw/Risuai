export interface NodeMcpBinaryStorage {
    getItem(key: string): Promise<Uint8Array | Buffer | null>
    setItem(key: string, value: Uint8Array): Promise<unknown>
    removeItem(key: string): Promise<unknown>
}

export const NODE_MCP_TOOL_CALL_PREFIX = 'mcp-tool-calls/'

function storageKey(id: string) {
    if (
        !id
        || id.includes('\0')
        || new TextEncoder().encode(id).byteLength > 120
    ) {
        throw new TypeError('Invalid MCP tool-call id')
    }
    return `${NODE_MCP_TOOL_CALL_PREFIX}${id}`
}

export class NodeMcpToolCallStorage<TValue> {
    constructor(private readonly storage: NodeMcpBinaryStorage) {}

    async getItem(id: string): Promise<TValue | null> {
        const encoded = await this.storage.getItem(storageKey(id))
        if (!encoded) {
            return null
        }
        let parsed: unknown
        try {
            parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(encoded)))
        }
        catch {
            throw new Error('Stored MCP tool call is not valid JSON')
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Stored MCP tool call is malformed')
        }
        return parsed as TValue
    }

    async setItem(id: string, value: TValue) {
        const encoded = new TextEncoder().encode(JSON.stringify(value))
        await this.storage.setItem(storageKey(id), encoded)
    }

    async removeItem(id: string) {
        await this.storage.removeItem(storageKey(id))
    }
}
