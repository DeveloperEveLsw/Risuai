import { writable } from 'svelte/store'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
    const chat = {
        id: 'chat-1',
        message: [],
        scriptstate: {},
    }
    const character = {
        type: 'character',
        chaId: 'character-1',
        name: 'Character',
        chatPage: 0,
        chats: [chat],
        customscript: [],
        additionalAssets: [['portrait', 'character-portrait', 'png']],
        emotionImages: [],
        defaultVariables: '',
    }
    const db = {
        characters: [character],
        enabledModules: [],
        modules: [],
        globalChatVariables: {},
        templateDefaultVariables: '',
        hideAllImages: false,
        legacyMediaFindings: false,
        assetWidth: -1,
        customQuotes: false,
        unformatQuotes: false,
        blockquoteStyling: false,
        returnCSSError: true,
    }
    const databaseUpdate = vi.fn()
    const setChatVar = vi.fn((key: string, value: string) => {
        chat.scriptstate[`$${key}`] = value
        databaseUpdate()
        return true
    })
    const getChatVar = vi.fn((key: string) => chat.scriptstate[`$${key}`] ?? 'null')
    const processScriptFull = vi.fn(async (_char, data: string, mode: string) => {
        setChatVar('editdisplay', mode)
        return { data: `extended:${data}`, emoChanged: false }
    })
    const moduleAssets: [string, string, string][] = [['spark', 'module-spark', 'png']]
    const modules: { id: string }[] = [{ id: 'module-1' }]

    return {
        chat,
        character,
        databaseUpdate,
        db,
        getChatVar,
        processScriptFull,
        setChatVar,
        moduleAssets,
        modules,
    }
})

vi.mock(import('../storage/database.svelte'), () => (
    ({
        appVer: 'test',
        getCurrentCharacter: () => mocks.character,
        getDatabase: () => mocks.db,
    }) as unknown as typeof import('../storage/database.svelte')
))

vi.mock(import('../stores.svelte'), () => (
    ({
        DBState: { db: mocks.db },
        selIdState: { selId: 0 },
        selectedCharID: writable(0),
    }) as unknown as typeof import('../stores.svelte')
))

vi.mock(import('../globalApi.svelte'), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: (path: string) => Promise.resolve(
        path.startsWith('assets/legacy-')
            ? 'data:image/png;base64,AAE='
            : `/asset/${path}`
    ),
}))

vi.mock(import('../process/scripts'), () => ({
    processScriptFull: mocks.processScriptFull,
}))

vi.mock(import('./chatVar.svelte'), () => ({
    getChatVar: mocks.getChatVar,
    getGlobalChatVar: vi.fn(() => 'null'),
    setChatVar: mocks.setChatVar,
}))

vi.mock(import('../process/modules'), () => (
    ({
        getModuleAssets: () => mocks.moduleAssets,
        getModuleLorebooks: () => [],
        getModules: () => mocks.modules,
    }) as unknown as typeof import('../process/modules')
))

vi.mock(import('../process/files/inlays'), () => ({
    getInlayAssetBlob: vi.fn(async () => null),
}))

import {
    ParseMarkdown,
    ParseMarkdownReadOnlyPresentation,
    resetAssetsCache,
    trimMarkdownReadOnlyPresentation,
} from './parser.svelte'

describe('read-only runtime presentation markdown', () => {
    beforeEach(() => {
        mocks.chat.scriptstate = {}
        mocks.databaseUpdate.mockClear()
        mocks.getChatVar.mockClear()
        mocks.processScriptFull.mockClear()
        mocks.setChatVar.mockClear()
        mocks.moduleAssets = [['spark', 'module-spark', 'png']]
        mocks.modules = [{ id: 'module-1' }]
        resetAssetsCache(
            mocks.character.additionalAssets as [string, string, string][],
            [],
            [['spark', 'module-spark', 'png']],
        )
    })

    it('resolves an active module asset on the first simple-character render', async () => {
        resetAssetsCache([], [], [])
        const simpleCharacter = {
            ...mocks.character,
            type: 'simple',
        }

        const result = await ParseMarkdownReadOnlyPresentation(
            '{{img::spark}}',
            simpleCharacter as never,
            'notrim',
            0,
        )

        expect(result).toContain('/asset/module-spark')
    })

    it('uses each stored media extension for generated source elements', async () => {
        const originalAssets = mocks.character.additionalAssets
        mocks.character.additionalAssets = [
            // Older .risum imports stored every payload under a .png key while
            // keeping the real extension in the asset tuple.
            ['clip', 'assets/legacy-clip.png', 'webm'],
            ['sound', 'assets/legacy-sound.png', 'wav'],
            ['stylesheet', 'assets/legacy-stylesheet.png', 'css'],
            ['font', 'assets/legacy-font.png', 'woff2'],
        ]

        try {
            const result = await ParseMarkdownReadOnlyPresentation(
                '{{video::clip}}{{audio::sound}}'
                + '{{raw::stylesheet}}{{path::font}}',
                mocks.character as never,
                'notrim',
                0,
            )

            expect(result).toContain('type="video/webm"')
            expect(result).toContain('type="audio/wav"')
            expect(result).toContain('data:video/webm;base64,AAE=')
            expect(result).toContain('data:audio/wav;base64,AAE=')
            expect(result).toContain('data:text/css;base64,AAE=')
            expect(result).toContain('data:font/woff2;base64,AAE=')
        }
        finally {
            mocks.character.additionalAssets = originalAssets
        }
    })

    it('does not reuse a same-named asset from the previously rendered character', async () => {
        const previousCharacter = {
            ...mocks.character,
            type: 'simple',
            chaId: 'previous-character',
            additionalAssets: [['portrait', 'previous-portrait', 'png']],
        }
        const nextCharacter = {
            ...mocks.character,
            type: 'simple',
            chaId: 'next-character',
            additionalAssets: [['portrait', 'next-portrait', 'png']],
        }

        expect(await ParseMarkdownReadOnlyPresentation(
            '{{img::portrait}}', previousCharacter as never, 'notrim', 0,
        )).toContain('/asset/previous-portrait')
        const result = await ParseMarkdownReadOnlyPresentation(
            '{{img::portrait}}', nextCharacter as never, 'notrim', 0,
        )

        expect(result).toContain('/asset/next-portrait')
        expect(result).not.toContain('/asset/previous-portrait')
    })

    it('refreshes module assets when the active module set identity changes', async () => {
        const simpleCharacter = {
            ...mocks.character,
            type: 'simple',
        }
        expect(await ParseMarkdownReadOnlyPresentation(
            '{{img::spark}}', simpleCharacter as never, 'notrim', 0,
        )).toContain('/asset/module-spark')

        mocks.modules = [{ id: 'module-2' }]
        mocks.moduleAssets = [['spark', 'module-spark-next', 'png']]
        const result = await ParseMarkdownReadOnlyPresentation(
            '{{img::spark}}', simpleCharacter as never, 'notrim', 0,
        )

        expect(result).toContain('/asset/module-spark-next')
        expect(result).not.toContain('/asset/module-spark\"')
    })

    it('renders multiple versions on two followers without display extensions or database writes', async () => {
        const databaseBefore = structuredClone(mocks.db)
        const versions = [
            '**first** {{img::portrait}}',
            '**second** {{img::spark}} {{setvar::leak::1}}',
            '<style>.stream { content: "{{getvar::leak}}"; }</style> **third**',
        ]

        const renderVersion = async (data: string) => trimMarkdownReadOnlyPresentation(
            await ParseMarkdownReadOnlyPresentation(data, mocks.character as never, 'notrim', -1),
        )
        const followerOne = await Promise.all(versions.map(renderVersion))
        const followerTwo = await Promise.all(versions.map(renderVersion))

        expect(followerOne).toEqual(followerTwo)
        expect(followerOne[0]).toContain('<strong>first</strong>')
        expect(followerOne[0]).toContain('/asset/character-portrait')
        expect(followerOne[1]).toContain('/asset/module-spark')
        expect(followerOne[1]).toContain('{{setvar::leak::1}}')
        expect(followerOne[2]).toContain('{{getvar::leak}}')
        expect(mocks.processScriptFull).not.toHaveBeenCalled()
        expect(mocks.getChatVar).not.toHaveBeenCalled()
        expect(mocks.setChatVar).not.toHaveBeenCalled()
        expect(mocks.databaseUpdate).not.toHaveBeenCalled()
        expect(mocks.db).toEqual(databaseBefore)
    })

    it('keeps the canonical renderer on the complete editdisplay pipeline', async () => {
        const result = await ParseMarkdown('**canonical**', mocks.character as never, 'notrim', 0)

        expect(mocks.processScriptFull).toHaveBeenCalledOnce()
        expect(mocks.processScriptFull).toHaveBeenCalledWith(
            mocks.character,
            '**canonical**',
            'editdisplay',
            0,
            {},
        )
        expect(mocks.setChatVar).toHaveBeenCalledWith('editdisplay', 'editdisplay')
        expect(mocks.databaseUpdate).toHaveBeenCalledOnce()
        expect(result).toContain('extended:<strong>canonical</strong>')
    })

    it('strips DOM controls and autoplay side effects from uncommitted output', async () => {
        const parsed = await ParseMarkdownReadOnlyPresentation(
            '{{bgm::spark}}<audio autoplay controls src="/audio.mp3"></audio>'
            + '<iframe src="https://example.invalid"></iframe>'
            + '<button risu-btn="run" risu-trigger="trigger">run</button>',
            mocks.character as never,
            'notrim',
            -1,
        )
        const result = trimMarkdownReadOnlyPresentation(parsed)

        expect(result).not.toContain('risu-ctrl')
        expect(result).not.toContain('risu-btn')
        expect(result).not.toContain('risu-trigger')
        expect(result).not.toContain('autoplay')
        expect(result).not.toContain('<iframe')
        expect(result).toContain('<audio')
        expect(result).toContain('>run</button>')
        expect(mocks.processScriptFull).not.toHaveBeenCalled()
        expect(mocks.databaseUpdate).not.toHaveBeenCalled()
    })
})
