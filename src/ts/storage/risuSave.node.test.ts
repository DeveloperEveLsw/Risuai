import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    cacheSetItem: vi.fn(),
    remoteSetItem: vi.fn(),
}))

vi.mock('src/ts/platform', () => ({
    isNodeServer: true,
    isTauri: false,
}))

vi.mock('localforage', () => ({
    default: {
        createInstance: vi.fn(() => ({
            setItem: mocks.cacheSetItem,
            getItem: vi.fn(),
        })),
    },
}))

vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        setItem: mocks.remoteSetItem,
        getItem: vi.fn(),
        keys: vi.fn(async () => []),
    },
}))

vi.mock('./database.svelte', () => ({
    getDatabase: vi.fn(() => ({ enableRemoteSaving: true })),
    presetTemplate: {},
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: { AppData: 0 },
    exists: vi.fn(),
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
}))

import { RisuSaveEncoder } from './risuSave'

function readBlockTypes(encoded: Uint8Array): number[] {
    const headerLength = new TextEncoder().encode('RISUSAVE\0').byteLength
    const types: number[] = []
    let offset = headerLength
    while (offset < encoded.byteLength) {
        const type = encoded[offset]
        const nameLength = encoded[offset + 2]
        const lengthOffset = offset + 3 + nameLength
        const view = new DataView(
            encoded.buffer,
            encoded.byteOffset + lengthOffset,
            4,
        )
        const dataLength = view.getUint32(0, true)
        types.push(type)
        offset = lengthOffset + 4 + dataLength
    }
    expect(offset).toBe(encoded.byteLength)
    return types
}

describe('RisuSaveEncoder in Node authoritative mode', () => {
    beforeEach(() => {
        mocks.cacheSetItem.mockClear()
        mocks.remoteSetItem.mockClear()
    })

    it('creates one self-contained snapshot without browser cache or remote character blocks', async () => {
        const encoder = new RisuSaveEncoder()
        await encoder.init({
            characters: [{
                chaId: 'character-1',
                type: 'character',
                name: 'Character',
                chats: [],
            }],
            botPresets: [],
            modules: [],
            loadouts: [],
            plugins: [],
            pluginCustomStorage: {},
        } as any)

        const encoded = encoder.encode()
        expect(encoded).not.toBeNull()
        expect(readBlockTypes(new Uint8Array(encoded!))).not.toContain(6)
        expect(mocks.remoteSetItem).not.toHaveBeenCalled()
        expect(mocks.cacheSetItem).not.toHaveBeenCalled()
    })
})
