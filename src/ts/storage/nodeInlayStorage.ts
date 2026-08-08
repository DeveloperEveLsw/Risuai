import type { InlayAsset } from '../process/files/inlays'

export interface NodeInlayBinaryStorage {
    getItem(key: string): Promise<Uint8Array | Buffer | null>
    setItem(key: string, value: Uint8Array): Promise<unknown>
    keys(): Promise<string[]>
    removeItem(key: string): Promise<unknown>
}

interface StoredInlayHeader {
    schemaVersion: 1
    dataKind: 'blob' | 'string'
    mimeType: string
    ext: string
    height?: number
    name: string
    type: InlayAsset['type']
    width?: number
}

const MAGIC = new TextEncoder().encode('RISUINLAY1')
const HEADER_LENGTH_BYTES = 4
export const NODE_INLAY_STORAGE_PREFIX = 'inlays/'

function storageKey(id: string) {
    // NodeStorage hex-encodes this entire logical key before it ever becomes a
    // filesystem name, so upstream inlay identifiers such as
    // `assets/<character>.png` remain opaque and safe rather than being
    // interpreted as paths.
    // The logical key is hex-encoded into one POSIX filename by NodeStorage;
    // keep `inlays/` + UTF-8 id within 127 bytes (254 hex characters).
    if (!id || new TextEncoder().encode(id).byteLength > 120 || id.includes('\0')) {
        throw new TypeError('Invalid inlay asset id')
    }
    return `${NODE_INLAY_STORAGE_PREFIX}${id}`
}

function mimeTypeFor(asset: Pick<InlayAsset, 'type' | 'ext'>) {
    if (asset.type === 'signature') {
        return 'application/json'
    }
    const subtype = asset.ext === 'jpg' ? 'jpeg' : asset.ext
    return `${asset.type}/${subtype}`
}

export async function encodeNodeInlayAsset(asset: InlayAsset): Promise<Uint8Array> {
    const dataKind = asset.data instanceof Blob ? 'blob' : 'string'
    const payload = dataKind === 'blob'
        ? new Uint8Array(await (asset.data as Blob).arrayBuffer())
        : new TextEncoder().encode(asset.data as string)
    const header: StoredInlayHeader = {
        schemaVersion: 1,
        dataKind,
        mimeType: asset.data instanceof Blob && asset.data.type
            ? asset.data.type
            : mimeTypeFor(asset),
        ext: asset.ext,
        ...(asset.height === undefined ? {} : { height: asset.height }),
        name: asset.name,
        type: asset.type,
        ...(asset.width === undefined ? {} : { width: asset.width }),
    }
    const headerBytes = new TextEncoder().encode(JSON.stringify(header))
    if (headerBytes.byteLength > 1024 * 1024) {
        throw new RangeError('Inlay metadata is too large')
    }
    const encoded = new Uint8Array(
        MAGIC.byteLength + HEADER_LENGTH_BYTES + headerBytes.byteLength + payload.byteLength,
    )
    encoded.set(MAGIC, 0)
    new DataView(encoded.buffer).setUint32(MAGIC.byteLength, headerBytes.byteLength, false)
    encoded.set(headerBytes, MAGIC.byteLength + HEADER_LENGTH_BYTES)
    encoded.set(payload, MAGIC.byteLength + HEADER_LENGTH_BYTES + headerBytes.byteLength)
    return encoded
}

function isInlayType(value: unknown): value is InlayAsset['type'] {
    return value === 'image'
        || value === 'video'
        || value === 'audio'
        || value === 'signature'
}

export function decodeNodeInlayAsset(input: Uint8Array): InlayAsset {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
    const prefixLength = MAGIC.byteLength + HEADER_LENGTH_BYTES
    if (bytes.byteLength < prefixLength) {
        throw new Error('Stored inlay asset is truncated')
    }
    for (let index = 0; index < MAGIC.byteLength; index += 1) {
        if (bytes[index] !== MAGIC[index]) {
            throw new Error('Stored inlay asset has an invalid signature')
        }
    }
    const headerLength = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
    ).getUint32(MAGIC.byteLength, false)
    if (headerLength <= 0 || headerLength > 1024 * 1024 || prefixLength + headerLength > bytes.byteLength) {
        throw new Error('Stored inlay asset has invalid metadata length')
    }
    let header: StoredInlayHeader
    try {
        header = JSON.parse(new TextDecoder().decode(
            bytes.subarray(prefixLength, prefixLength + headerLength),
        )) as StoredInlayHeader
    }
    catch {
        throw new Error('Stored inlay asset metadata is not valid JSON')
    }
    if (
        header.schemaVersion !== 1
        || (header.dataKind !== 'blob' && header.dataKind !== 'string')
        || typeof header.mimeType !== 'string'
        || typeof header.ext !== 'string'
        || typeof header.name !== 'string'
        || !isInlayType(header.type)
        || (header.height !== undefined && !Number.isFinite(header.height))
        || (header.width !== undefined && !Number.isFinite(header.width))
    ) {
        throw new Error('Stored inlay asset metadata is malformed')
    }
    const payload = bytes.subarray(prefixLength + headerLength)
    return {
        data: header.dataKind === 'blob'
            ? new Blob([Uint8Array.from(payload).buffer], { type: header.mimeType })
            : new TextDecoder().decode(payload),
        ext: header.ext,
        ...(header.height === undefined ? {} : { height: header.height }),
        name: header.name,
        type: header.type,
        ...(header.width === undefined ? {} : { width: header.width }),
    }
}

export class NodeInlayStorage {
    constructor(private readonly storage: NodeInlayBinaryStorage) {}

    async getItem(id: string): Promise<InlayAsset | null> {
        const value = await this.storage.getItem(storageKey(id))
        return value ? decodeNodeInlayAsset(new Uint8Array(value)) : null
    }

    async setItem(id: string, asset: InlayAsset) {
        await this.storage.setItem(storageKey(id), await encodeNodeInlayAsset(asset))
    }

    async removeItem(id: string) {
        const key = storageKey(id)
        if (await this.storage.getItem(key)) {
            await this.storage.removeItem(key)
        }
    }

    async entries(): Promise<Array<[string, InlayAsset]>> {
        const ids = await this.ids()
        const entries: Array<[string, InlayAsset]> = []
        for (const id of ids) {
            const asset = await this.getItem(id)
            if (asset) {
                entries.push([id, asset])
            }
        }
        return entries
    }

    async ids(): Promise<string[]> {
        return (await this.storage.keys())
            .filter((key) => key.startsWith(NODE_INLAY_STORAGE_PREFIX))
            .sort()
            .map((key) => key.slice(NODE_INLAY_STORAGE_PREFIX.length))
            .filter(Boolean)
    }
}
