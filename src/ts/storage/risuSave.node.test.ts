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

import { RisuSaveEncoder, RisuSaveDecoder, type toSaveType } from './risuSave'
import { snapshotDatabaseForSave } from './databaseSaveSnapshot'
import type { Database } from './database.svelte'

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
            characters: [
                {
                    chaId: 'character-1',
                    type: 'character',
                    name: 'Character',
                    chats: [],
                },
            ],
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

describe('canonical encoded block adoption', () => {
    const database = (): Database =>
        ({
            characters: [
                {
                    chaId: 'character-1',
                    type: 'character',
                    name: 'One',
                    chats: [],
                },
            ],
            botPresets: [],
            modules: [],
            loadouts: [],
            plugins: [],
            pluginCustomStorage: {},
            globalChatVariables: { choice: 'before' },
        }) as unknown as Database
    const flags = (): toSaveType => ({
        character: [],
        botPreset: false,
        modules: false,
        loadouts: false,
        plugins: false,
        pluginCustomStorage: false,
    })

    it.each([false, true])(
        'preserves received character blocks without cloning history (compression=%s)',
        async (compression) => {
            const db = database()
            const original = new RisuSaveEncoder()
            await original.init(db, { compression })
            await original.set(db, flags())
            const raw = new Uint8Array(original.encode()!)
            const adopted = new RisuSaveEncoder()
            expect(
                adopted.initFromSnapshot(raw, ['character-1'], compression),
            ).toBe(true)
            expect(new Uint8Array(adopted.encode()!)).toEqual(raw)
            Object.defineProperty(db.characters[0], 'chats', {
                get() {
                    throw new Error('untouched history read')
                },
            })
            db.globalChatVariables.choice = 'after'
            const captured = snapshotDatabaseForSave(
                db,
                flags(),
                structuredClone,
                (id) => adopted.hasCharacterBlock(id),
            )
            await adopted.set(captured.database, flags())
            const decoded = await new RisuSaveDecoder().decode(
                new Uint8Array(adopted.encode()!),
            )
            expect(decoded.globalChatVariables.choice).toBe('after')
            expect(decoded.characters[0].chats).toEqual([])
        },
    )

    it('rejects missing, mismatched, legacy and truncated blocks atomically', async () => {
        const encoder = new RisuSaveEncoder()
        await encoder.init(database())
        const valid = new Uint8Array(encoder.encode()!)
        const previous = new Uint8Array(encoder.encode()!)
        for (const raw of [
            valid.slice(0, -1),
            valid.slice(0, 12),
            new Uint8Array([0, 82, 73]),
        ]) {
            expect(encoder.initFromSnapshot(raw, ['character-1'])).toBe(false)
            expect(new Uint8Array(encoder.encode()!)).toEqual(previous)
        }
        expect(encoder.initFromSnapshot(valid, [])).toBe(false)
        expect(encoder.initFromSnapshot(valid, ['root'])).toBe(false)
        expect(
            encoder.initFromSnapshot(valid, ['character-1', 'character-1']),
        ).toBe(false)
    })
})

it('persists incremental settings and chat edits without dropping or re-reading untouched histories', async () => {
    const db = {
        characters: ['one', 'two'].map((chaId) => ({
            chaId,
            type: 'character',
            name: chaId,
            chatPage: 0,
            chats: [
                { id: chaId, message: [{ role: 'char', data: 'original' }] },
            ],
        })),
        botPresets: [],
        modules: [],
        loadouts: [],
        plugins: [],
        pluginCustomStorage: {},
        globalChatVariables: { toggle: 'off' },
    } as unknown as Database
    const encoder = new RisuSaveEncoder()
    await encoder.init(db)
    Object.defineProperty(db.characters[1].chats[0].message[0], 'data', {
        get() {
            throw new Error(
                'unchanged history must come from the encoded block',
            )
        },
    })
    const flags = (): toSaveType => ({
        character: [],
        botPreset: false,
        modules: false,
        loadouts: false,
        plugins: false,
        pluginCustomStorage: false,
    })
    db.globalChatVariables.toggle = 'on'
    let pending = flags()
    let captured = snapshotDatabaseForSave(db, pending, structuredClone, (id) =>
        encoder.hasCharacterBlock(id),
    )
    await encoder.set(captured.database, pending)
    let decoded = await new RisuSaveDecoder().decode(
        new Uint8Array(encoder.encode()!),
    )
    expect(decoded.globalChatVariables.toggle).toBe('on')
    expect(decoded.characters.map((c) => c.chats[0].message[0].data)).toEqual([
        'original',
        'original',
    ])

    db.characters[0].chats[0].message[0].data = 'edited'
    pending = flags()
    pending.character = ['one']
    captured = snapshotDatabaseForSave(db, pending, structuredClone, (id) =>
        encoder.hasCharacterBlock(id),
    )
    db.characters[0].chats[0].message[0].data = 'changed after capture'
    await encoder.set(captured.database, pending)
    decoded = await new RisuSaveDecoder().decode(
        new Uint8Array(encoder.encode()!),
    )
    expect(decoded.characters.map((c) => c.chats[0].message[0].data)).toEqual([
        'edited',
        'original',
    ])
    expect(mocks.remoteSetItem).not.toHaveBeenCalled()
    expect(mocks.cacheSetItem).not.toHaveBeenCalled()
})
