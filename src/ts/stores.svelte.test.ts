import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    dbState: { db: {} as any },
    moduleUpdate: vi.fn(),
    resetScriptCache: vi.fn(),
}))

vi.mock('./storage/databaseState.svelte', () => ({
    DBState: mocks.dbState,
}))

vi.mock('./process/modules', () => ({
    moduleUpdate: mocks.moduleUpdate,
}))

vi.mock('./process/scripts', () => ({
    resetScriptCache: mocks.resetScriptCache,
}))

// Vite resolves these type-only module edges before TypeScript erases them.
// Keep this store test isolated from their application-level effects.
vi.mock('./storage/database.svelte', () => ({}))
vi.mock('./parser/parser.svelte', () => ({}))
vi.mock('./alert', () => ({}))
vi.mock('./characterCards', () => ({}))
vi.mock('./plugins/pluginSafety', () => ({}))

import {
    selectedCharID,
    selIdState,
    setSelectedCharacterForPresentation,
} from './stores.svelte'

function databaseFixture() {
    return {
        characters: [{
            chaId: 'character-1',
            supaMemory: false,
        }],
        enabledModules: [],
        hypaV3: true,
        hypaV3PresetId: 'preset-1',
        hypaV3Presets: {
            'preset-1': {
                settings: { alwaysToggleOn: true },
            },
        },
        modules: [],
    }
}

describe('presentation-only character selection', () => {
    beforeEach(() => {
        mocks.dbState.db = databaseFixture()
        selectedCharID.set(-1)
    })

    it('updates selection subscribers without applying persistent defaults', () => {
        const databaseBefore = structuredClone(mocks.dbState.db)

        setSelectedCharacterForPresentation(0)

        expect(get(selectedCharID)).toBe(0)
        expect(selIdState.selId).toBe(0)
        expect(mocks.dbState.db).toEqual(databaseBefore)
    })

    it('preserves the existing persistent effect for a normal selection', () => {
        selectedCharID.set(0)

        expect(mocks.dbState.db.characters[0].supaMemory).toBe(true)
    })
})
