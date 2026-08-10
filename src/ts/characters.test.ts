import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    dbState: {
        db: {
            characters: [
                {
                    chaId: 'character-1',
                    chats: [],
                    chatPage: 0,
                    globalLore: [],
                    newGenData: {},
                    type: 'character',
                },
            ],
        } as any,
    },
    selectedCharID: null as ReturnType<typeof writable<number>> | null,
    doingChat: null as ReturnType<typeof writable<boolean>> | null,
    localGenerationExecutionActive: null as ReturnType<typeof writable<boolean>> | null,
    runtimeGenerationActive: null as ReturnType<typeof writable<boolean>> | null,
    getColdStorageItem: vi.fn(),
    setSelectedCharacterForPresentation: vi.fn((index: number) => {
        mocks.selectedCharID!.set(index)
    }),
}))

vi.mock('./storage/database.svelte', () => ({
    defaultSdDataFunc: vi.fn(() => ({})),
    getDatabase: () => mocks.dbState.db,
    getCharacterByIndex: (index: number) => mocks.dbState.db.characters[index],
    setCharacterByIndex: (index: number, character: unknown) => {
        mocks.dbState.db.characters[index] = character
    },
}))

vi.mock('./alert', () => ({
    alertAddCharacter: vi.fn(),
    alertConfirm: vi.fn(),
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertSelect: vi.fn(),
    alertStore: writable({ type: 'none' }),
    alertWait: vi.fn(),
}))

vi.mock('../lang', () => ({
    language: { errors: {} },
}))

vi.mock('./util', () => ({
    checkNullish: vi.fn(),
    findCharacterbyId: vi.fn(),
    findCharacterIndexbyId: vi.fn(),
    getUserName: vi.fn(),
    selectMultipleFile: vi.fn(),
    selectSingleFile: vi.fn(),
}))

vi.mock('./media', () => ({ getImageType: vi.fn() }))

vi.mock('./stores.svelte', () => {
    mocks.selectedCharID = writable(-1)
    return {
        DBState: mocks.dbState,
        MobileGUIStack: writable(0),
        OpenRealmStore: writable(false),
        selectedCharID: mocks.selectedCharID,
        setSelectedCharacterForPresentation: mocks.setSelectedCharacterForPresentation,
    }
})

vi.mock('./globalApi.svelte', () => ({
    AppendableBuffer: class MockAppendableBuffer {},
    changeChatTo: vi.fn(),
    checkCharOrder: vi.fn(),
    downloadFile: vi.fn(),
    getFileSrc: vi.fn(),
    requiresFullEncoderReload: { state: false },
}))

vi.mock('./process/inlayScreen', () => ({ updateInlayScreen: vi.fn() }))
vi.mock('./parser/parser.svelte', () => ({ parseMarkdownSafe: vi.fn() }))
vi.mock('./translator/translator', () => ({ translateHTML: vi.fn() }))

vi.mock('./process/index.svelte', () => {
    mocks.doingChat = writable(false)
    mocks.localGenerationExecutionActive = writable(false)
    return {
        doingChat: mocks.doingChat,
        localGenerationExecutionActive: mocks.localGenerationExecutionActive,
    }
})

vi.mock('./characterCards', () => ({ importCharacter: vi.fn() }))
vi.mock('./pngChunk', () => ({ PngChunk: { readGenerator: vi.fn() } }))
vi.mock('./process/coldstorage.svelte', () => ({
    getColdStorageItem: mocks.getColdStorageItem,
}))
vi.mock('./platform', () => ({
    isNodeServer: true,
    isServerResidentExecutor: false,
}))
vi.mock('./runtime/generationActivity.svelte', () => {
    mocks.runtimeGenerationActive = writable(false)
    return { runtimeGenerationActive: mocks.runtimeGenerationActive }
})

import {
    changeChar,
    resolveCharacterNavigationMode,
} from './characters'

function characterFixture(overrides: Record<string, unknown> = {}) {
    return {
        chaId: 'character-1',
        chats: [{
            id: 'chat-1',
            message: [],
            note: '',
            name: 'Chat 1',
            localLore: [],
            fmIndex: -1,
        }],
        chatPage: 0,
        firstMsgIndex: -1,
        globalLore: [],
        newGenData: {},
        customscript: [],
        lastInteraction: 123,
        type: 'character',
        ...overrides,
    }
}

describe('character navigation during generation', () => {
    beforeEach(() => {
        mocks.dbState.db = { characters: [characterFixture()] }
        mocks.selectedCharID!.set(-1)
        mocks.doingChat!.set(false)
        mocks.localGenerationExecutionActive!.set(false)
        mocks.runtimeGenerationActive!.set(false)
        mocks.getColdStorageItem.mockReset()
        mocks.setSelectedCharacterForPresentation.mockClear()
    })

    it('keeps the original lock for local generation and the resident executor', () => {
        expect(resolveCharacterNavigationMode({
            doingChat: true,
            localExecutionActive: true,
            runtimeActive: false,
        }, {
            isNodeServer: true,
            isServerResidentExecutor: false,
        })).toBe('locked')
        expect(resolveCharacterNavigationMode({
            doingChat: true,
            localExecutionActive: false,
            runtimeActive: true,
        }, {
            isNodeServer: false,
            isServerResidentExecutor: false,
        })).toBe('locked')
        expect(resolveCharacterNavigationMode({
            doingChat: true,
            localExecutionActive: false,
            runtimeActive: true,
        }, {
            isNodeServer: true,
            isServerResidentExecutor: true,
        })).toBe('locked')
        expect(resolveCharacterNavigationMode({
            doingChat: true,
            localExecutionActive: true,
            runtimeActive: true,
        }, {
            isNodeServer: true,
            isServerResidentExecutor: false,
        })).toBe('locked')
    })

    it('does not lock an idle client or a delegated Node viewer', () => {
        expect(resolveCharacterNavigationMode({
            doingChat: false,
            localExecutionActive: false,
            runtimeActive: false,
        }, {
            isNodeServer: false,
            isServerResidentExecutor: false,
        })).toBe('normal')
        expect(resolveCharacterNavigationMode({
            doingChat: true,
            localExecutionActive: false,
            runtimeActive: false,
        }, {
            isNodeServer: true,
            isServerResidentExecutor: false,
        })).toBe('selection-only')
        expect(resolveCharacterNavigationMode({
            doingChat: true,
            localExecutionActive: false,
            runtimeActive: true,
        }, {
            isNodeServer: true,
            isServerResidentExecutor: false,
        })).toBe('selection-only')
        expect(resolveCharacterNavigationMode({
            doingChat: false,
            localExecutionActive: false,
            runtimeActive: true,
        }, {
            isNodeServer: true,
            isServerResidentExecutor: false,
        })).toBe('selection-only')
    })

    it('re-enters by selection only without touching canonical character data', async () => {
        mocks.dbState.db.characters[0] = characterFixture()
        const characterBefore = structuredClone(mocks.dbState.db.characters[0])
        const reseter = vi.fn()
        mocks.doingChat!.set(true)
        mocks.localGenerationExecutionActive!.set(false)
        mocks.runtimeGenerationActive!.set(true)

        await changeChar(0, { reseter })

        expect(reseter).toHaveBeenCalledOnce()
        expect(mocks.setSelectedCharacterForPresentation).toHaveBeenCalledWith(0)
        expect(get(mocks.selectedCharID!)).toBe(0)
        expect(mocks.getColdStorageItem).not.toHaveBeenCalled()
        expect(mocks.dbState.db.characters[0].lastInteraction).toBe(123)
        expect(mocks.dbState.db.characters[0]).toEqual(characterBefore)
    })

    it('does not expose an incomplete cold-storage stub during generation', async () => {
        mocks.dbState.db.characters[0] = characterFixture({ coldstorage: 'cold-1' })
        const characterBefore = structuredClone(mocks.dbState.db.characters[0])
        const reseter = vi.fn()
        mocks.doingChat!.set(true)
        mocks.runtimeGenerationActive!.set(true)

        await changeChar(0, { reseter })

        expect(reseter).toHaveBeenCalledOnce()
        expect(mocks.setSelectedCharacterForPresentation).not.toHaveBeenCalled()
        expect(get(mocks.selectedCharID!)).toBe(-1)
        expect(mocks.getColdStorageItem).not.toHaveBeenCalled()
        expect(mocks.dbState.db.characters[0]).toEqual(characterBefore)
    })

    it('keeps a Node local-preview execution locked without durable runtime activity', async () => {
        const characterBefore = structuredClone(mocks.dbState.db.characters[0])
        const reseter = vi.fn()
        mocks.doingChat!.set(true)
        mocks.localGenerationExecutionActive!.set(true)

        await changeChar(0, { reseter })

        expect(reseter).not.toHaveBeenCalled()
        expect(get(mocks.selectedCharID!)).toBe(-1)
        expect(mocks.getColdStorageItem).not.toHaveBeenCalled()
        expect(mocks.dbState.db.characters[0]).toEqual(characterBefore)
    })

    it('ignores invalid indices in the selection-only path', async () => {
        const databaseBefore = structuredClone(mocks.dbState.db)
        const reseter = vi.fn()
        mocks.doingChat!.set(true)
        mocks.localGenerationExecutionActive!.set(false)
        mocks.runtimeGenerationActive!.set(true)

        await changeChar(99, { reseter })

        expect(reseter).not.toHaveBeenCalled()
        expect(get(mocks.selectedCharID!)).toBe(-1)
        expect(mocks.dbState.db).toEqual(databaseBefore)
    })
})
