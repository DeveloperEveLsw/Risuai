import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import type { character } from './storage/database.svelte'

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
    setCharacterByIndex: vi.fn(),
    setSelectedCharacterForPresentation: vi.fn((index: number) => {
        mocks.selectedCharID!.set(index)
    }),
}))

vi.mock('./storage/database.svelte', () => ({
    defaultSdDataFunc: vi.fn(() => ({})),
    getDatabase: () => mocks.dbState.db,
    getCharacterByIndex: (index: number) => mocks.dbState.db.characters[index],
    setCharacterByIndex: (index: number, character: unknown) => {
        mocks.setCharacterByIndex(index, character)
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
    characterFormatUpdate,
    resolveCharacterNavigationMode,
    shouldUpdateCharacterInteraction,
} from './characters'

function characterFixture(overrides: Partial<character> = {}): character {
    return {
        name: 'Character 1',
        firstMessage: '',
        desc: '',
        notes: '',
        chaId: 'character-1',
        chats: [{
            id: 'chat-1',
            message: [],
            note: '',
            name: 'Chat 1',
            localLore: [],
            fmIndex: -1,
        }],
        chatFolders: [],
        chatPage: 0,
        viewScreen: 'none',
        bias: [],
        emotionImages: [],
        firstMsgIndex: -1,
        globalLore: [],
        sdData: [],
        utilityBot: false,
        triggerscript: [],
        alternateGreetings: [],
        exampleMessage: '',
        creatorNotes: '',
        systemPrompt: '',
        tags: [],
        creator: '',
        characterVersion: '',
        personality: '',
        scenario: '',
        additionalData: {
            tag: [],
            creator: '',
            character_version: '',
        },
        voicevoxConfig: {
            SPEED_SCALE: 1,
            PITCH_SCALE: 0,
            INTONATION_SCALE: 1,
            VOLUME_SCALE: 1,
        },
        additionalText: '',
        depth_prompt: {
            depth: 0,
            prompt: '',
        },
        hfTTS: {
            model: '',
            language: 'en',
        },
        backgroundHTML: '',
        backgroundCSS: '',
        creation_date: 100,
        ttsMode: '',
        newGenData: {
            prompt: '',
            negative: '',
            instructions: '',
            emotionInstructions: '',
        },
        customscript: [],
        postHistoryInstructions: '',
        replaceGlobalNote: '',
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
        mocks.setCharacterByIndex.mockReset()
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

    it.each([
        {
            name: 'idle browser client',
            activity: { doingChat: false, localExecutionActive: false, runtimeActive: false },
            platform: { isNodeServer: false, isServerResidentExecutor: false },
            expected: 'normal',
        },
        {
            name: 'idle resident executor',
            activity: { doingChat: false, localExecutionActive: false, runtimeActive: false },
            platform: { isNodeServer: true, isServerResidentExecutor: true },
            expected: 'normal',
        },
        {
            name: 'idle delegated Node viewer during discovery gap',
            activity: { doingChat: false, localExecutionActive: false, runtimeActive: false },
            platform: { isNodeServer: true, isServerResidentExecutor: false },
            expected: 'normal',
        },
        {
            name: 'delegated Node viewer during admission',
            activity: { doingChat: true, localExecutionActive: false, runtimeActive: false },
            platform: { isNodeServer: true, isServerResidentExecutor: false },
            expected: 'selection-only',
        },
        {
            name: 'delegated Node viewer during durable execution',
            activity: { doingChat: false, localExecutionActive: false, runtimeActive: true },
            platform: { isNodeServer: true, isServerResidentExecutor: false },
            expected: 'selection-only',
        },
        {
            name: 'delegated Node viewer running a local preview',
            activity: { doingChat: true, localExecutionActive: true, runtimeActive: false },
            platform: { isNodeServer: true, isServerResidentExecutor: false },
            expected: 'locked',
        },
    ])('resolves $name as $expected', ({ activity, platform, expected }) => {
        expect(resolveCharacterNavigationMode(activity, platform)).toBe(expected)
    })

    it.each([
        {
            name: 'browser client',
            platform: { isNodeServer: false, isServerResidentExecutor: false },
            expected: true,
        },
        {
            name: 'resident executor',
            platform: { isNodeServer: true, isServerResidentExecutor: true },
            expected: true,
        },
        {
            name: 'delegated Node viewer',
            platform: { isNodeServer: true, isServerResidentExecutor: false },
            expected: false,
        },
    ])('$name interaction timestamp policy is $expected', ({ platform, expected }) => {
        expect(shouldUpdateCharacterInteraction(platform)).toBe(expected)
    })

    it('keeps characterFormatUpdate timestamp behavior by default and honors an explicit opt-out', () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(456)
        const defaultCharacter = characterFixture()
        const readOnlyCharacter = characterFixture()

        characterFormatUpdate(defaultCharacter)
        characterFormatUpdate(readOnlyCharacter, { updateInteraction: false })

        expect(defaultCharacter.lastInteraction).toBe(456)
        expect(readOnlyCharacter.lastInteraction).toBe(123)
        now.mockRestore()
    })

    it('still performs genuine legacy migrations when interaction updates are disabled', () => {
        const legacyCharacter = characterFixture({
            globalLore: [{
                key: 'legacy',
                secondkey: '',
                insertorder: 0,
                comment: '',
                content: 'Legacy lore',
                mode: 'normal',
                alwaysActive: false,
                selective: false,
                activationPercent: 75,
                bookVersion: 1,
            }],
        })
        delete (legacyCharacter as Partial<character>).alternateGreetings
        mocks.dbState.db.characters[0] = legacyCharacter

        characterFormatUpdate(0, { updateInteraction: false })

        expect(mocks.dbState.db.characters[0].alternateGreetings).toEqual([])
        expect(mocks.dbState.db.characters[0].globalLore[0]).toMatchObject({
            bookVersion: 2,
            activationPercent: null,
            content: '@@probability 75\nLegacy lore',
        })
        expect(mocks.dbState.db.characters[0].lastInteraction).toBe(123)
    })

    it('selects an idle delegated viewer without any canonical proxy write', async () => {
        const writes: PropertyKey[] = []
        const normalizedCharacter = characterFixture()
        const characterBefore = structuredClone(normalizedCharacter)
        const characterWithWriteListener = new Proxy(normalizedCharacter, {
            set(target, property, value, receiver) {
                writes.push(property)
                return Reflect.set(target, property, value, receiver)
            },
        })
        mocks.dbState.db.characters[0] = characterWithWriteListener
        const reseter = vi.fn()

        // This is the cold-start discovery gap: the resident may already be
        // generating, but this newly loaded viewer has not observed it yet.
        mocks.doingChat!.set(false)
        mocks.localGenerationExecutionActive!.set(false)
        mocks.runtimeGenerationActive!.set(false)

        await changeChar(0, { reseter })

        expect(reseter).toHaveBeenCalledOnce()
        expect(mocks.setSelectedCharacterForPresentation).toHaveBeenCalledWith(0)
        expect(get(mocks.selectedCharID!)).toBe(0)
        expect(mocks.getColdStorageItem).not.toHaveBeenCalled()
        expect(mocks.setCharacterByIndex).not.toHaveBeenCalled()
        expect(writes).toEqual([])
        expect(mocks.dbState.db.characters[0].lastInteraction).toBe(123)
        expect(mocks.dbState.db.characters[0]).toEqual(characterBefore)
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
