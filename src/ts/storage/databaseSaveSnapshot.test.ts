import { describe, expect, it, vi } from 'vitest'
import type { Database } from './database.svelte'
import type { toSaveType } from './risuSave'
import { snapshotDatabaseForSave } from './databaseSaveSnapshot'

const changes = (): toSaveType => ({
    character: [],
    botPreset: false,
    modules: false,
    loadouts: false,
    plugins: false,
    pluginCustomStorage: false,
})
function database(): Database {
    return {
        characters: ['one', 'two'].map((chaId) => ({
            chaId,
            type: 'character',
            name: chaId,
            chatPage: 0,
            chats: [
                {
                    id: chaId,
                    message: [{ role: 'char', data: 'old conversation' }],
                },
            ],
        })),
        botPresets: [],
        modules: [],
        loadouts: [],
        plugins: [],
        pluginCustomStorage: {},
        globalChatVariables: { choice: 'a' },
    } as unknown as Database
}

describe('incremental database save snapshot', () => {
    it('does not read historical messages for a root setting change', () => {
        const db = database()
        const historyRead = vi.fn(() => {
            throw new Error('untouched history was traversed')
        })
        Object.defineProperty(db.characters[1].chats[0].message[0], 'data', {
            get: historyRead,
        })
        const captured = snapshotDatabaseForSave(
            db,
            changes(),
            structuredClone,
            () => true,
        )
        expect(captured.database.globalChatVariables).toEqual({ choice: 'a' })
        expect(captured.database.globalChatVariables).not.toBe(
            db.globalChatVariables,
        )
        expect(captured.database.characters[1]).toBe(db.characters[1])
        expect(captured.characterIds.size).toBe(0)
        expect(historyRead).not.toHaveBeenCalled()
        db.globalChatVariables.choice = 'b'
        expect(captured.database.globalChatVariables.choice).toBe('a')
    })

    it('detaches changed and newly added characters before asynchronous encoding', () => {
        const db = database()
        const pending = changes()
        pending.character.push('one')
        const captured = snapshotDatabaseForSave(
            db,
            pending,
            structuredClone,
            (id) => id === 'one',
        )
        expect([...captured.characterIds]).toEqual(['one', 'two'])
        db.characters[0].chats[0].message[0].data = 'changed during save'
        db.characters[1].chats[0].message[0].data =
            'new character changed during save'
        expect(
            captured.database.characters.map((c) => c.chats[0].message[0].data),
        ).toEqual(['old conversation', 'old conversation'])
    })
})
