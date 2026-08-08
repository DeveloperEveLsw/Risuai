export interface NodeJsonBinaryStorage {
    getItem(key: string): Promise<Uint8Array | Buffer | null>
    setItem(key: string, value: Uint8Array): Promise<unknown>
}

interface StoredValue<T> {
    schemaVersion: 1
    key: string
    value: T
}

async function sha256Hex(value: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
}

export class NodeJsonKeyValueStorage<T> {
    constructor(
        private readonly storage: NodeJsonBinaryStorage,
        private readonly prefix: string,
    ) {
        if (!prefix || prefix.includes('\0')) {
            throw new TypeError('Node JSON storage prefix is invalid')
        }
    }

    private async storageKey(key: string) {
        if (!key || key.includes('\0')) {
            throw new TypeError('Node JSON storage key is invalid')
        }
        return `${this.prefix}${await sha256Hex(key)}`
    }

    async getItem(key: string): Promise<T | null> {
        const encoded = await this.storage.getItem(await this.storageKey(key))
        if (!encoded) {
            return null
        }
        let stored: StoredValue<T>
        try {
            stored = JSON.parse(new TextDecoder().decode(new Uint8Array(encoded))) as StoredValue<T>
        }
        catch {
            throw new Error('Stored Node JSON value is not valid JSON')
        }
        if (stored?.schemaVersion !== 1 || stored.key !== key || !('value' in stored)) {
            throw new Error('Stored Node JSON value is malformed')
        }
        return stored.value
    }

    async setItem(key: string, value: T) {
        const stored: StoredValue<T> = { schemaVersion: 1, key, value }
        await this.storage.setItem(
            await this.storageKey(key),
            new TextEncoder().encode(JSON.stringify(stored)),
        )
        return value
    }
}
