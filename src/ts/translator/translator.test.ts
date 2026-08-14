// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { simpleCharacterArgument } from '../parser/parser.svelte'
import type { customscript } from '../storage/database.svelte'

const mocks = vi.hoisted(() => {
    const db = {
        translatorType: 'llm',
        translator: 'ko',
        translatorInputLanguage: 'en',
        aiModel: 'model-main',
        subModel: 'model-translate',
        translatorPresetId: 0,
        translatorPresets: [{
            name: 'Default',
            prompt: 'Translate to {{slot}}. Note={{slot::tnote}}',
            maxResponse: 512,
        }],
        translatorPrompt: '',
        translatorMaxResponse: 512,
        fallbackModels: { translate: [] },
        seperateModelsForAxModels: false,
        seperateModels: { translate: '' },
        temperature: 40,
        top_p: 1,
        top_k: 0,
        min_p: 0,
        top_a: 0,
        repetition_penalty: 1,
        frequencyPenalty: 0,
        PresensePenalty: 0,
        reasoningEffort: 0,
        thinkingTokens: 0,
        verbosity: 1,
        generationSeed: -1,
        seperateParametersEnabled: false,
        seperateParametersByModel: false,
        seperateParameters: { translate: {}, overrides: {} },
        additionalParams: [],
        applyAdditionalParamsToAll: false,
        systemContentReplacement: '',
        systemRoleReplacement: 'user',
        extractJson: '',
        banCharacterset: [],
        fallbackWhenBlankResponse: false,
        ainconfig: { top_p: 1 },
        openrouterRequestModel: 'openai/model-a',
        openrouterProvider: { order: [], only: [], ignore: [] },
        useInstructPrompt: false,
        openrouterFallback: false,
        openrouterMiddleOut: false,
        jsonSchemaEnabled: false,
        OAIPrediction: '',
        deepseekThinkingType: 'off',
        openAIFlexProcessing: false,
        nanogptRequestModel: 'nano/model-a',
        nanogptProvider: '',
        nanogptUseSubscriptionEndpoint: false,
        ollamaModel: 'ollama-model-a',
        ollamaCloudModel: 'ollama-cloud-a',
        ollamaRequestFormat: 'ollama',
        ollamaThinkingMode: 'auto',
        ollamaModelSource: 'local',
        ollamaURL: 'http://localhost:11434',
        autofillRequestUrl: true,
        customProxyRequestModel: '',
        customAPIFormat: 'openai',
        forceReplaceUrl: '',
        reverseProxyOobaArgs: {},
        textgenWebUIBlockingURL: 'http://localhost:5000/api/v1/generate',
        koboldURL: 'http://localhost:5001/api/v1',
        customModels: [],
        playMessageOnTranslateEnd: false,
        htmlTranslation: false,
        combineTranslation: false,
        useExperimentalGoogleTranslator: false,
        noWaitForTranslate: true,
        deeplOptions: { key: '', freeApi: true },
        deeplXOptions: { url: '', token: '' },
        characters: [] as Array<any>,
    }
    return {
        db,
        requestChatData: vi.fn(),
        alertError: vi.fn(),
        moduleScripts: [] as Array<Record<string, unknown>>,
        audioPlay: vi.fn(async () => {}),
        pipelineStateful: false,
        modelFormats: {} as Record<string, number>,
        databaseUpdateListeners: new Set<(update: { path: Array<string | number | symbol> }) => void>(),
        selectedCharacterListeners: new Set<(index: number) => void>(),
    }
})

vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => mocks.db,
    getCurrentCharacter: () => mocks.db.characters[0],
    getCurrentChat: () => {
        const character = mocks.db.characters[0]
        return character?.chats?.[character.chatPage]
    },
    onDatabaseUpdate: (listener: (update: { path: Array<string | number | symbol> }) => void) => {
        mocks.databaseUpdateListeners.add(listener)
        return () => mocks.databaseUpdateListeners.delete(listener)
    },
}))

vi.mock('../storage/databaseState.svelte', () => ({
    onDatabaseUpdate: (listener: (update: { path: Array<string | number | symbol> }) => void) => {
        mocks.databaseUpdateListeners.add(listener)
        return () => mocks.databaseUpdateListeners.delete(listener)
    },
}))

vi.mock('../parser/chatML', () => ({
    parseChatML: vi.fn(() => null),
}))

vi.mock('../parser/parser.svelte', () => ({
    applyMarkdownToNode: vi.fn(),
}))

vi.mock('../model/modellist', () => ({
    LLMFormat: {
        OobaLegacy: 11,
        Ooba: 13,
        Kobold: 14,
    },
    getModelInfo: (id: string) => ({
        id,
        internalID: id,
        provider: 0,
        format: mocks.modelFormats[id] ?? 0,
        flags: [],
        parameters: [],
    }),
}))

vi.mock('../globalApi.svelte', () => ({
    globalFetch: vi.fn(),
}))

vi.mock('src/ts/platform', () => ({
    isTauri: false,
    isNodeServer: true,
}))

vi.mock('../alert', () => ({
    alertError: mocks.alertError,
}))

vi.mock('../process/request/request', () => ({
    requestChatData: mocks.requestChatData,
    translationRequestPipelineIsStateful: () => mocks.pipelineStateful,
}))

vi.mock('../process/index.svelte', async () => {
    const { writable } = await import('svelte/store')
    return { doingChat: writable(false) }
})

vi.mock('../stores.svelte', () => ({
    selectedCharID: {
        subscribe: (listener: (index: number) => void) => {
            mocks.selectedCharacterListeners.add(listener)
            listener(0)
            return () => mocks.selectedCharacterListeners.delete(listener)
        },
    },
}))

vi.mock('../selectionEvents', () => ({
    onSelectedCharacterChanged: (listener: () => void) => {
        mocks.selectedCharacterListeners.add(listener)
        return () => mocks.selectedCharacterListeners.delete(listener)
    },
}))

vi.mock('../process/modules', () => ({
    getModuleRegexScripts: () => mocks.moduleScripts,
}))

vi.mock('../util', () => ({
    findCharacterbyId: (id: string) => mocks.db.characters.find((entry: { chaId: string }) => entry.chaId === id) ?? {
        type: 'character',
        chaId: id,
        translatorNote: '',
        customscript: [],
    },
    getNodetextToSentence: (node: Node) => node.textContent ?? '',
    getUserName: () => 'User',
    sleep: () => Promise.resolve(),
}))

vi.mock('localforage', () => ({
    default: {
        createInstance: () => ({
            getItem: vi.fn(async () => null),
            setItem: vi.fn(async (_key: string, value: unknown) => value),
            removeItem: vi.fn(async () => {}),
            iterate: vi.fn(async () => undefined),
            clear: vi.fn(async () => {}),
        }),
    },
}))

vi.mock('./presets', () => ({
    defaultTranslatorPrompt: 'Translate {{slot::content}} to {{slot}}.',
    getCurrentTranslatorPresetFromState: (state: typeof mocks.db) => state.translatorPresets[state.translatorPresetId],
}))

import {
    LLMCacheStorage,
    TranslationCacheRevisionStore,
    type TranslationCacheMutationEvent,
    clearLLMCache,
    exportLLMCacheAsJSON,
    getLLMCache,
    getLLMCacheIdentity,
    getLLMCacheByStorageKey,
    importLLMCacheFromJSON,
    searchLLMCache,
    setLLMCache,
    subscribeTranslationCacheMutations,
    translate,
    translateHTML,
} from './translator'

class MockAudio {
    play = mocks.audioPlay
}

function simpleCharacter(note = 'note-a', id = 'character-a', scripts: customscript[] = []): simpleCharacterArgument {
    return {
        type: 'simple' as const,
        chaId: id,
        translatorNote: note,
        customscript: scripts,
        virtualscript: undefined,
        emotionImages: [],
    }
}

beforeEach(async () => {
    await clearLLMCache()
    mocks.requestChatData.mockReset()
    mocks.alertError.mockReset()
    mocks.audioPlay.mockReset()
    mocks.moduleScripts.length = 0
    mocks.pipelineStateful = false
    for (const key of Object.keys(mocks.modelFormats)) delete mocks.modelFormats[key]
    mocks.db.characters = []
    mocks.db.translator = 'ko'
    mocks.db.translatorInputLanguage = 'en'
    mocks.db.subModel = 'model-translate'
    mocks.db.fallbackModels.translate = []
    mocks.db.frequencyPenalty = 0
    mocks.db.reasoningEffort = 0
    mocks.db.openrouterRequestModel = 'openai/model-a'
    mocks.db.openrouterProvider = { order: [], only: [], ignore: [] }
    mocks.db.useInstructPrompt = false
    mocks.db.jsonSchemaEnabled = false
    mocks.db.OAIPrediction = ''
    mocks.db.deepseekThinkingType = 'off'
    mocks.db.openAIFlexProcessing = false
    mocks.db.ainconfig = { top_p: 1 }
    mocks.db.nanogptRequestModel = 'nano/model-a'
    mocks.db.ollamaCloudModel = 'ollama-cloud-a'
    mocks.db.translatorPresetId = 0
    mocks.db.translatorPresets = [{
        name: 'Default',
        prompt: 'Translate to {{slot}}. Note={{slot::tnote}}',
        maxResponse: 512,
    }]
    mocks.db.playMessageOnTranslateEnd = false
    vi.stubGlobal('Audio', MockAudio)
})

describe('deterministic local LLM translation execution', () => {
    it('single-flights concurrent same-key calls and applies edittrans once on miss and hit', async () => {
        let resolveProvider!: (value: { type: 'success', result: string }) => void
        mocks.requestChatData.mockImplementationOnce(() => new Promise((resolve) => {
            resolveProvider = resolve
        }))
        const character = simpleCharacter('note-a', 'character-a', [{
            comment: '',
            type: 'edittrans',
            in: 'hello',
            out: 'hello!',
            ableFlag: true,
            flag: 'g',
        }])

        const first = translateHTML('hello', false, character, 1)
        const second = translateHTML('hello', false, character, 1)
        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledTimes(1))
        resolveProvider({ type: 'success', result: 'hello' })

        await expect(first).resolves.toBe('hello!')
        await expect(second).resolves.toBe('hello!')
        await expect(translateHTML('hello', false, character, 1)).resolves.toBe('hello!')
        expect(mocks.requestChatData).toHaveBeenCalledTimes(1)
        expect(mocks.requestChatData.mock.calls[0][0].tools).toEqual([])
        expect(mocks.requestChatData.mock.calls[0][0].blockModelTools).toBe(true)
        expect(mocks.requestChatData.mock.calls[0][0].blockBatching).toBe(true)
    })

    it('captures explicit character/note context before selected state can change', async () => {
        let resolveProvider!: (value: { type: 'success', result: string }) => void
        mocks.requestChatData.mockImplementationOnce((arg) => new Promise((resolve) => {
            const system = arg.formated.find((entry: { role: string }) => entry.role === 'system')
            expect(system.content).toContain('Note=first-private-note')
            expect(system.content).not.toContain('second-private-note')
            resolveProvider = resolve
        }))
        const character = simpleCharacter('first-private-note')

        const pending = translateHTML('hello context', false, character, 2)
        character.translatorNote = 'second-private-note'
        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledOnce())
        resolveProvider({ type: 'success', result: 'translated context' })

        await expect(pending).resolves.toBe('translated context')
    })

    it('re-resolves a mounted character snapshot to the live note and room/message identity', async () => {
        const liveCharacter = {
            type: 'character',
            chaId: 'character-live',
            translatorNote: 'live-note-one',
            chatPage: 0,
            chats: [{ id: 'room-live', message: [{ chatId: 'message-live' }] }],
            customscript: [],
            triggerscript: [],
        }
        mocks.db.characters = [liveCharacter]
        const staleSnapshot = simpleCharacter('stale-mounted-note', 'character-live')
        mocks.requestChatData.mockImplementation(async (arg) => ({
            type: 'success',
            result: arg.formated.at(-1).content,
        }))

        await translateHTML('live note source', false, staleSnapshot, 0)
        expect(mocks.requestChatData.mock.calls[0][0].formated[0].content).toContain('Note=live-note-one')

        liveCharacter.translatorNote = 'live-note-two'
        await translateHTML('live note source', false, staleSnapshot, 0)

        expect(mocks.requestChatData).toHaveBeenCalledTimes(2)
        expect(mocks.requestChatData.mock.calls[1][0].formated[0].content).toContain('Note=live-note-two')
    })

    it('preserves the selected live translator note for generic translate callers', async () => {
        mocks.db.characters = [{
            type: 'character',
            chaId: 'selected-character',
            translatorNote: 'selected-live-note',
            chatPage: 0,
            chats: [{ id: 'selected-room', message: [] }],
            customscript: [],
            triggerscript: [],
        }]
        mocks.requestChatData.mockImplementationOnce(async (arg) => {
            expect(arg.formated[0].content).toContain('Note=selected-live-note')
            return { type: 'success', result: 'generic translation' }
        })

        await expect(translate('generic source', false)).resolves.toBe('generic translation')
    })

    it('misses semantic cache when effective OpenRouter request settings change', async () => {
        mocks.db.subModel = 'openrouter'
        mocks.requestChatData
            .mockResolvedValueOnce({ type: 'success', result: 'model-a result' })
            .mockResolvedValueOnce({ type: 'success', result: 'model-b result' })
            .mockResolvedValueOnce({ type: 'success', result: 'provider result' })

        await expect(translateHTML('openrouter source', false, simpleCharacter(), 12))
            .resolves.toBe('model-a result')
        mocks.db.openrouterRequestModel = 'openai/model-b'
        await expect(translateHTML('openrouter source', false, simpleCharacter(), 12))
            .resolves.toBe('model-b result')
        mocks.db.openrouterProvider = { order: ['provider-a'], only: [], ignore: [] }
        await expect(translateHTML('openrouter source', false, simpleCharacter(), 12))
            .resolves.toBe('provider result')

        expect(mocks.requestChatData).toHaveBeenCalledTimes(3)
    })

    it('misses semantic cache when NanoGPT or Ollama effective model aliases change', async () => {
        mocks.requestChatData.mockImplementation(async () => ({
            type: 'success',
            result: `alias result ${mocks.requestChatData.mock.calls.length}`,
        }))

        mocks.db.subModel = 'nanogpt'
        await translateHTML('alias source', false, simpleCharacter(), 16)
        mocks.db.nanogptRequestModel = 'nano/model-b'
        await translateHTML('alias source', false, simpleCharacter(), 16)

        mocks.db.subModel = 'ollama-cloud'
        await translateHTML('alias source', false, simpleCharacter(), 16)
        mocks.db.ollamaCloudModel = 'ollama-cloud-b'
        await translateHTML('alias source', false, simpleCharacter(), 16)

        mocks.db.subModel = 'model-translate'
        mocks.db.fallbackModels.translate = ['openrouter']
        await translateHTML('fallback alias source', false, simpleCharacter(), 16)
        mocks.db.openrouterRequestModel = 'openai/fallback-model-b'
        await translateHTML('fallback alias source', false, simpleCharacter(), 16)

        expect(mocks.requestChatData).toHaveBeenCalledTimes(6)
    })

    it('misses semantic cache when NovelList request parameters change', async () => {
        mocks.requestChatData
            .mockResolvedValueOnce({ type: 'success', result: 'ain result one' })
            .mockResolvedValueOnce({ type: 'success', result: 'ain result two' })

        await expect(translateHTML('ain source', false, simpleCharacter(), 18))
            .resolves.toBe('ain result one')
        mocks.db.ainconfig = { top_p: 0.5 }
        await expect(translateHTML('ain source', false, simpleCharacter(), 18))
            .resolves.toBe('ain result two')

        expect(mocks.requestChatData).toHaveBeenCalledTimes(2)
    })

    it('fails an in-flight result closed when a generation parameter changes', async () => {
        let resolveProvider!: (value: { type: 'success', result: string }) => void
        mocks.requestChatData.mockImplementationOnce(() => new Promise((resolve) => {
            resolveProvider = resolve
        }))
        const pending = translateHTML('parameter race', false, simpleCharacter(), 13)
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledOnce())

        mocks.db.frequencyPenalty = 25
        resolveProvider({ type: 'success', result: 'stale parameter result' })

        await rejected
        expect(mocks.alertError).not.toHaveBeenCalled()
    })

    it('fails closed when live provider settings change away and back during one request', async () => {
        mocks.requestChatData.mockImplementationOnce(async () => {
            mocks.db.frequencyPenalty = 35
            for (const listener of mocks.databaseUpdateListeners) listener({ path: ['frequencyPenalty'] })
            // The final semantic hash is A again, but the provider could have
            // built its body while B was active. The monotonic mutation fence
            // must reject that ABA result.
            mocks.db.frequencyPenalty = 0
            for (const listener of mocks.databaseUpdateListeners) listener({ path: ['frequencyPenalty'] })
            return { type: 'success', result: 'wrong ABA result' }
        })

        await expect(translateHTML('ABA source', false, simpleCharacter(), 19))
            .rejects.toMatchObject({ name: 'AbortError' })
        expect(mocks.alertError).not.toHaveBeenCalled()
    })

    it('fails closed when the selected character changes away and back during one request', async () => {
        mocks.requestChatData.mockImplementationOnce(async () => {
            for (const listener of mocks.selectedCharacterListeners) listener(1)
            for (const listener of mocks.selectedCharacterListeners) listener(0)
            return { type: 'success', result: 'wrong selected-character result' }
        })

        await expect(translateHTML('selected ABA source', false, simpleCharacter(), 21))
            .rejects.toMatchObject({ name: 'AbortError' })
    })

    it('bypasses generated cache and single-flight while the request pipeline is stateful', async () => {
        mocks.pipelineStateful = true
        mocks.requestChatData.mockImplementation(async () => ({
            type: 'success',
            result: `stateful result ${mocks.requestChatData.mock.calls.length}`,
            pipelineStateful: true,
        }))
        const character = simpleCharacter()

        const [first, second] = await Promise.all([
            translateHTML('stateful source', false, character, 14),
            translateHTML('stateful source', false, character, 14),
        ])
        const third = await translateHTML('stateful source', false, character, 14)

        expect(first).not.toBe(second)
        expect(third).toContain('stateful result')
        expect(mocks.requestChatData).toHaveBeenCalledTimes(3)
        await expect(getLLMCache('stateful source', {
            context: {
                characterId: character.chaId,
                messageId: '14',
                translatorNote: character.translatorNote,
            },
            sourceFormat: 'plain',
        })).resolves.toBeNull()
    })

    it('allows stateful request hooks to mutate chat state without discarding their result', async () => {
        mocks.pipelineStateful = true
        mocks.requestChatData.mockImplementationOnce(async () => {
            for (const listener of mocks.databaseUpdateListeners) {
                listener({ path: ['characters', 0, 'chats', 0, 'scriptstate', 'counter'] })
            }
            return {
                type: 'success',
                result: 'stateful mutation result',
                pipelineStateful: true,
            }
        })

        await expect(translateHTML('stateful mutation source', false, simpleCharacter(), 20))
            .resolves.toBe('stateful mutation result')
    })

    it('rejects a stateful result when effective provider settings change in flight', async () => {
        mocks.pipelineStateful = true
        mocks.requestChatData.mockImplementationOnce(async () => {
            mocks.db.frequencyPenalty = 35
            for (const listener of mocks.databaseUpdateListeners) {
                listener({ path: ['frequencyPenalty'] })
            }
            return {
                type: 'success',
                result: 'stale stateful settings result',
                pipelineStateful: true,
            }
        })

        await expect(translateHTML('stateful settings race source', false, simpleCharacter(), 23))
            .rejects.toMatchObject({ name: 'AbortError' })
    })

    it('adopts a manual override committed while a stateful provider is in flight', async () => {
        mocks.pipelineStateful = true
        let resolveProvider!: (value: { type: 'success', result: string, pipelineStateful: true }) => void
        mocks.requestChatData.mockImplementationOnce(() => new Promise((resolve) => {
            resolveProvider = resolve
        }))
        const character = simpleCharacter()
        const options = {
            context: {
                characterId: character.chaId,
                messageId: '24',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain' as const,
        }
        const pending = translateHTML('stateful concurrent manual', false, character, 24)
        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledOnce())

        await setLLMCache('stateful concurrent manual', 'new manual result', options)
        resolveProvider({
            type: 'success',
            result: 'late provider result',
            pipelineStateful: true,
        })

        await expect(pending).resolves.toBe('new manual result')
    })

    it('adopts a newer manual override committed while a stateful force waits to supersede the old one', async () => {
        mocks.pipelineStateful = true
        const character = simpleCharacter()
        const options = {
            context: {
                characterId: character.chaId,
                messageId: '25',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain' as const,
        }
        await setLLMCache('stateful force concurrent manual', 'old manual result', options)

        let resolveProvider!: (value: { type: 'success', result: string, pipelineStateful: true }) => void
        mocks.requestChatData.mockImplementationOnce(() => new Promise((resolve) => {
            resolveProvider = resolve
        }))
        const forced = translateHTML(
            'stateful force concurrent manual',
            false,
            character,
            25,
            true,
        )
        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledOnce())

        const originalSetItem = LLMCacheStorage.setItem.bind(LLMCacheStorage)
        let releaseManualWrite!: () => void
        const manualWriteGate = new Promise<void>((resolve) => {
            releaseManualWrite = resolve
        })
        let newerManualStored = false
        const setSpy = vi.spyOn(LLMCacheStorage, 'setItem').mockImplementation(async (key, value) => {
            const stored = await originalSetItem(key, value)
            if (
                !newerManualStored
                && key.startsWith('translation:manual:v1:')
                && typeof value === 'object'
                && value !== null
                && (value as { result?: string }).result === 'newer manual result'
            ) {
                newerManualStored = true
                await manualWriteGate
            }
            return stored
        })

        const saving = setLLMCache(
            'stateful force concurrent manual',
            'newer manual result',
            options,
        )
        await vi.waitFor(() => expect(newerManualStored).toBe(true))
        resolveProvider({
            type: 'success',
            result: 'stale forced provider result',
            pipelineStateful: true,
        })
        releaseManualWrite()

        await saving
        await expect(forced).resolves.toBe('newer manual result')
        setSpy.mockRestore()
    })

    it.each([
        ['manual semantic key', 'manualKey'],
        ['plan semantic key', 'planKey'],
        ['legacy source key', 'legacyKey'],
    ] as const)(
        'adopts a newer imported override on the %s while a stateful force is superseding the old one',
        async (_label, targetKey) => {
            mocks.pipelineStateful = true
            const source = 'stateful force concurrent import'
            const character = simpleCharacter()
            const options = {
                context: {
                    characterId: character.chaId,
                    messageId: '26',
                    translatorNote: character.translatorNote ?? '',
                },
                sourceFormat: 'plain' as const,
            }
            const identity = await getLLMCacheIdentity(source, options)
            const storageKey = identity[targetKey]
            const importedEntry = (result: string) => ({
                translationCacheExportVersion: 2 as const,
                entries: {
                    [storageKey]: {
                        result,
                        sourceSearchText: source,
                        origin: 'imported' as const,
                    },
                },
            })
            await importLLMCacheFromJSON(importedEntry('old imported result'))

            let resolveProvider!: (value: {
                type: 'success'
                result: string
                pipelineStateful: true
            }) => void
            mocks.requestChatData.mockImplementationOnce(() => new Promise((resolve) => {
                resolveProvider = resolve
            }))
            const forced = translateHTML(source, false, character, 26, true, options)
            await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledOnce())

            const originalSetItem = LLMCacheStorage.setItem.bind(LLMCacheStorage)
            let releaseImportWrite!: () => void
            const importWriteGate = new Promise<void>((resolve) => {
                releaseImportWrite = resolve
            })
            let newerImportStored = false
            const setSpy = vi.spyOn(LLMCacheStorage, 'setItem').mockImplementation(async (key, value) => {
                const stored = await originalSetItem(key, value)
                if (
                    !newerImportStored
                    && key === storageKey
                    && typeof value === 'object'
                    && value !== null
                    && (value as { result?: string }).result === 'newer imported result'
                ) {
                    newerImportStored = true
                    await importWriteGate
                }
                return stored
            })

            const importing = importLLMCacheFromJSON(importedEntry('newer imported result'))
            await vi.waitFor(() => expect(newerImportStored).toBe(true))
            resolveProvider({
                type: 'success',
                result: 'stale forced provider result',
                pipelineStateful: true,
            })
            // Let the force queue its supersession behind the imported write.
            await new Promise((resolve) => setTimeout(resolve, 0))
            releaseImportWrite()

            await expect(importing).resolves.toEqual({ count: 1, failed: 0 })
            await expect(forced).resolves.toBe('newer imported result')
            setSpy.mockRestore()
        },
    )

    it('rejects an older stateful force result after a newer force completes first', async () => {
        mocks.pipelineStateful = true
        const resolvers: Array<(value: {
            type: 'success'
            result: string
            pipelineStateful: true
        }) => void> = []
        mocks.requestChatData.mockImplementation(() => new Promise((resolve) => {
            resolvers.push(resolve)
        }))
        const character = simpleCharacter()
        const first = translateHTML('stateful force ordering', false, character, 27, true)
        const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
        await vi.waitFor(() => expect(resolvers).toHaveLength(1))

        const second = translateHTML('stateful force ordering', false, character, 27, true)
        await vi.waitFor(() => expect(resolvers).toHaveLength(2))
        resolvers[1]({
            type: 'success',
            result: 'newer stateful force result',
            pipelineStateful: true,
        })
        await expect(second).resolves.toBe('newer stateful force result')

        resolvers[0]({
            type: 'success',
            result: 'older late stateful force result',
            pipelineStateful: true,
        })
        await firstRejected
    })

    it('does not discard a translation for an unrelated database UI update', async () => {
        mocks.requestChatData.mockImplementationOnce(async () => {
            for (const listener of mocks.databaseUpdateListeners) {
                listener({ path: ['colorScheme', 'accent'] })
            }
            return { type: 'success', result: 'unrelated update result' }
        })

        await expect(translateHTML('unrelated update source', false, simpleCharacter(), 22))
            .resolves.toBe('unrelated update result')
    })

    it('keeps an explicit manual translation usable with stateful request hooks', async () => {
        mocks.pipelineStateful = true
        const character = simpleCharacter()
        const options = {
            context: {
                characterId: character.chaId,
                messageId: '15',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain' as const,
        }
        await setLLMCache('manual stateful source', 'manual result', options)

        // Manual correction identity deliberately excludes provider config and
        // translator note; only force explicitly bypasses the override.
        mocks.db.subModel = 'new-provider-model'
        mocks.db.frequencyPenalty = 50
        mocks.db.translatorPresets[0].prompt = 'Changed provider prompt {{slot::content}}'

        await expect(getLLMCache('manual stateful source', options)).resolves.toBe('manual result')
        await expect(translateHTML('manual stateful source', false, character, 15))
            .resolves.toBe('manual result')
        expect(mocks.requestChatData).not.toHaveBeenCalled()

        mocks.requestChatData.mockResolvedValueOnce({
            type: 'success',
            result: 'forced provider result',
            pipelineStateful: true,
        })
        await expect(translateHTML('manual stateful source', false, character, 15, true))
            .resolves.toBe('forced provider result')
        mocks.requestChatData.mockResolvedValueOnce({
            type: 'success',
            result: 'next stateful result',
            pipelineStateful: true,
        })
        await expect(translateHTML('manual stateful source', false, character, 15))
            .resolves.toBe('next stateful result')
        expect(mocks.requestChatData).toHaveBeenCalledTimes(2)
    })

    it('bypasses generated caching for ChatML presets with ambient CBS evaluation', async () => {
        mocks.db.translatorPresets[0].prompt = '<|im_start|>system\n{{char}} {{slot::content}}<|im_end|>'
        mocks.requestChatData.mockResolvedValue({ type: 'success', result: 'chatml result' })

        await translateHTML('chatml source', false, simpleCharacter(), 17)
        await translateHTML('chatml source', false, simpleCharacter(), 17)

        expect(mocks.requestChatData).toHaveBeenCalledTimes(2)
    })

    it('fails stale execution closed when a semantic model setting changes in flight', async () => {
        let resolveProvider!: (value: { type: 'success', result: string }) => void
        mocks.requestChatData.mockImplementationOnce(() => new Promise((resolve) => {
            resolveProvider = resolve
        }))
        const character = simpleCharacter()
        const pending = translateHTML('model race', false, character, 21)
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledOnce())

        mocks.db.subModel = 'new-translation-model'
        resolveProvider({ type: 'success', result: 'stale model result' })
        await rejected
        expect(mocks.alertError).not.toHaveBeenCalled()
        expect(mocks.audioPlay).not.toHaveBeenCalled()

        mocks.db.subModel = 'model-translate'
        await expect(getLLMCache('model race', {
            context: {
                characterId: character.chaId,
                messageId: '21',
                translatorNote: character.translatorNote,
            },
            sourceFormat: 'plain',
        })).resolves.toBeNull()
    })

    it('restores the complete risu-style wrapper and exact HTML/media bytes', async () => {
        const source = '<risu-style>2e617b636f6c6f723a7265647d</risu-style><p class="a">hello</p>{{img::a.webp}}'
        mocks.requestChatData.mockImplementationOnce(async (arg) => ({
            type: 'success',
            result: arg.formated.at(-1).content.replace('hello', '안녕'),
        }))

        const result = await translateHTML(source, false, simpleCharacter(), 3)

        expect(result).toBe(source.replace('hello', '안녕'))
        expect(result).toContain('<risu-style>2e617b636f6c6f723a7265647d</risu-style>')
        expect(result).toContain('<p class="a">')
        expect(result).toContain('{{img::a.webp}}')
    })

    it('fails closed and does not cache a response with a corrupted protected token', async () => {
        const character = simpleCharacter()
        mocks.requestChatData.mockImplementationOnce(async (arg) => ({
            type: 'success',
            result: arg.formated.at(-1).content.replace(/__RISU_PROTECTED_[A-Za-z0-9_-]+__/, ''),
        }))

        await expect(translateHTML('<b>hello</b>', false, character, 4)).rejects.toMatchObject({
            name: 'TranslationIntegrityError',
        })
        await expect(getLLMCache('<b>hello</b>', {
            context: {
                characterId: character.chaId,
                messageId: '4',
                translatorNote: character.translatorNote,
            },
            sourceFormat: 'html-segments-v1',
        })).resolves.toBeNull()
    })

    it('does not cache a provider failure as a successful translation', async () => {
        const character = simpleCharacter()
        mocks.requestChatData.mockResolvedValueOnce({ type: 'fail', result: 'provider failed' })

        await expect(translateHTML('failed source', false, character, 40)).resolves.toBe('failed source')
        expect(mocks.alertError).toHaveBeenCalledOnce()
        await expect(getLLMCache('failed source', {
            context: {
                characterId: character.chaId,
                messageId: '40',
                translatorNote: character.translatorNote,
            },
            sourceFormat: 'plain',
        })).resolves.toBeNull()
    })

    it('can report a forced provider failure without replacing the caller presentation', async () => {
        const character = simpleCharacter()
        mocks.requestChatData.mockResolvedValueOnce({ type: 'fail', result: 'forced provider failed' })

        await expect(translateHTML('forced failed source', false, character, 44, true, {
            throwOnFailure: true,
        })).rejects.toMatchObject({
            name: 'TranslationProviderError',
            message: 'forced provider failed',
        })
    })

    it('publishes a key-scoped manual cache mutation for other mounted views', async () => {
        const character = simpleCharacter()
        const options = {
            context: {
                characterId: character.chaId,
                chatId: 'room-1',
                messageId: 'message-1',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain' as const,
        }
        const identity = await getLLMCacheIdentity('shared manual source', options)
        const events: TranslationCacheMutationEvent[] = []
        const unsubscribe = subscribeTranslationCacheMutations((event) => events.push(event))

        await setLLMCache('shared manual source', 'shared manual result', options)
        unsubscribe()

        expect(events).toContainEqual(expect.objectContaining({
            reason: 'manual',
            touchedKeys: [identity.manualKey],
            scope: {
                characterId: character.chaId,
                chatId: 'room-1',
                messageId: 'message-1',
            },
        }))
    })

    it('does not replay an old mutation to a view mounted after publication', async () => {
        await setLLMCache('pre-mount source', 'pre-mount manual result', {
            context: { messageId: 'pre-mount', translatorNote: '' },
            sourceFormat: 'plain',
        })
        const events: TranslationCacheMutationEvent[] = []
        const unsubscribe = subscribeTranslationCacheMutations((event) => events.push(event))

        await Promise.resolve()
        unsubscribe()

        expect(events).toEqual([])
    })

    it('keeps a manual override stable across stateful display preparations of one message', async () => {
        const character = simpleCharacter()
        const options = {
            context: {
                characterId: character.chaId,
                chatId: 'room-stateful-display',
                messageId: 'message-stateful-display',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'html-segments-v1' as const,
            manualSource: 'canonical raw message',
        }
        const firstIdentity = await getLLMCacheIdentity('prepared display A', options)
        const secondIdentity = await getLLMCacheIdentity('prepared display B', options)
        expect(firstIdentity.manualKey).toBe(secondIdentity.manualKey)
        expect(firstIdentity.planKey).not.toBe(secondIdentity.planKey)

        await setLLMCache('prepared display A', 'stable manual override', options)
        await expect(getLLMCache('prepared display B', options))
            .resolves.toBe('stable manual override')
    })

    it('publishes the core result of a successful stateful force for matching views', async () => {
        mocks.pipelineStateful = true
        const character = simpleCharacter()
        const options = {
            context: {
                characterId: character.chaId,
                chatId: 'room-force',
                messageId: 'message-force',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain' as const,
        }
        const identity = await getLLMCacheIdentity('shared force source', options)
        const events: TranslationCacheMutationEvent[] = []
        const unsubscribe = subscribeTranslationCacheMutations((event) => events.push(event))
        mocks.requestChatData.mockResolvedValueOnce({
            type: 'success',
            result: 'shared forced result',
            pipelineStateful: true,
        })

        await expect(translateHTML('shared force source', false, character, 45, true, options))
            .resolves.toBe('shared forced result')
        await new Promise((resolve) => setTimeout(resolve, 0))
        unsubscribe()

        expect(events).toContainEqual(expect.objectContaining({
            reason: 'force',
            touchedKeys: expect.arrayContaining([
                identity.manualKey,
                identity.planKey,
                identity.legacyKey,
            ]),
            scope: {
                characterId: character.chaId,
                chatId: 'room-force',
                messageId: 'message-force',
            },
            result: 'shared forced result',
        }))
    })

    it('does not cache an unexpected streaming response as a successful translation', async () => {
        const character = simpleCharacter()
        mocks.requestChatData.mockResolvedValueOnce({
            type: 'streaming',
            result: new ReadableStream(),
        })

        await expect(translateHTML('unexpected source', false, character, 42)).resolves.toBe('unexpected source')
        expect(mocks.alertError).toHaveBeenCalledWith('Unexpected response type')
        await expect(getLLMCache('unexpected source', {
            context: {
                characterId: character.chaId,
                messageId: '42',
                translatorNote: character.translatorNote,
            },
            sourceFormat: 'plain',
        })).resolves.toBeNull()
    })

    it('keeps plugin cache handles as exact opaque-key lookups', async () => {
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'opaque result' })
        await translateHTML('opaque source', false, simpleCharacter(), 41)

        const records = await searchLLMCache('opaque source')
        expect(records).toHaveLength(1)
        expect(records[0].key).not.toContain('opaque source')
        await expect(getLLMCacheByStorageKey(records[0].key)).resolves.toBe('opaque result')
        await expect(getLLMCacheByStorageKey('opaque source')).resolves.toBe('opaque result')
    })

    it('restores an explicitly imported legacy raw-key backup by exact source', async () => {
        await importLLMCacheFromJSON({ 'legacy source cache key': 'legacy result' })

        await expect(searchLLMCache('source cache')).resolves.toEqual([
            { key: 'legacy source cache key', value: 'legacy result' },
        ])
        await expect(getLLMCacheByStorageKey('legacy source cache key')).resolves.toBe('legacy result')
        await expect(getLLMCache('legacy source cache key')).resolves.toBe('legacy result')
    })

    it('preserves durable source search metadata through versioned export and import', async () => {
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'backup result' })
        await translateHTML('durable backup source', false, simpleCharacter(), 43)
        const backup = await exportLLMCacheAsJSON()

        expect(backup.translationCacheExportVersion).toBe(2)
        expect(Object.values(backup.entries)[0]).toMatchObject({
            result: 'backup result',
            sourceSearchText: 'durable backup source',
            origin: 'generated',
        })

        await clearLLMCache()
        await importLLMCacheFromJSON(backup)

        await expect(searchLLMCache('backup source')).resolves.toHaveLength(1)
    })

    it('publishes one cache revision for an entire multi-entry import batch', async () => {
        const revisions: number[] = []
        const unsubscribe = TranslationCacheRevisionStore.subscribe((revision) => {
            revisions.push(revision)
        })

        await importLLMCacheFromJSON({
            'legacy import one': 'result one',
            'legacy import two': 'result two',
        })

        expect(revisions).toHaveLength(2)
        expect(revisions[1]).toBe(revisions[0] + 1)
        unsubscribe()
    })

    it('lets one waiter abort without cancelling a same-key waiter', async () => {
        let resolveProvider!: (value: { type: 'success', result: string }) => void
        mocks.requestChatData.mockImplementationOnce(() => new Promise((resolve) => {
            resolveProvider = resolve
        }))
        const firstController = new AbortController()
        const secondController = new AbortController()
        const character = simpleCharacter()

        const first = translateHTML('shared wait', false, character, 5, false, { signal: firstController.signal })
        const second = translateHTML('shared wait', false, character, 5, false, { signal: secondController.signal })
        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledOnce())
        firstController.abort()
        await expect(first).rejects.toMatchObject({ name: 'AbortError' })
        resolveProvider({ type: 'success', result: 'shared result' })
        await expect(second).resolves.toBe('shared result')
    })

    it('aborts the provider when all waiters leave and performs no alert, sound, or cache write', async () => {
        mocks.db.playMessageOnTranslateEnd = true
        mocks.requestChatData.mockImplementationOnce((_arg, _mode, signal: AbortSignal) => new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve({ type: 'fail', result: 'Aborted' }), { once: true })
        }))
        const controller = new AbortController()
        const character = simpleCharacter()
        const pending = translateHTML('abort me', false, character, 6, false, { signal: controller.signal })
        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledOnce())

        controller.abort()

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(mocks.alertError).not.toHaveBeenCalled()
        expect(mocks.audioPlay).not.toHaveBeenCalled()
        await expect(getLLMCache('abort me', {
            context: {
                characterId: character.chaId,
                messageId: '6',
                translatorNote: character.translatorNote,
            },
            sourceFormat: 'plain',
        })).resolves.toBeNull()
    })

    it('prevents a superseded force result from overwriting the latest version', async () => {
        const resolvers: Array<(value: { type: 'success', result: string }) => void> = []
        mocks.requestChatData.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)))
        const character = simpleCharacter()
        const first = translateHTML('versioned', false, character, 7)
        const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
        await vi.waitFor(() => expect(resolvers).toHaveLength(1))
        const forced = translateHTML('versioned', false, character, 7, true)
        await vi.waitFor(() => expect(resolvers).toHaveLength(2))

        resolvers[1]({ type: 'success', result: 'new result' })
        await expect(forced).resolves.toBe('new result')
        resolvers[0]({ type: 'success', result: 'stale result' })
        await firstRejected

        await expect(translateHTML('versioned', false, character, 7)).resolves.toBe('new result')
        expect(mocks.requestChatData).toHaveBeenCalledTimes(2)
    })

    it('keeps the last committed result when a forced provider attempt fails', async () => {
        const character = simpleCharacter()
        mocks.requestChatData
            .mockResolvedValueOnce({ type: 'success', result: 'last good result' })
            .mockResolvedValueOnce({ type: 'fail', result: 'forced provider failed' })

        await expect(translateHTML('force failure', false, character, 8)).resolves.toBe('last good result')
        await expect(translateHTML('force failure', false, character, 8, true)).resolves.toBe('force failure')
        await expect(translateHTML('force failure', false, character, 8)).resolves.toBe('last good result')
        expect(mocks.requestChatData).toHaveBeenCalledTimes(2)
    })

    it('replaces a manual override only after a forced translation succeeds', async () => {
        const character = simpleCharacter()
        const options = {
            context: {
                characterId: character.chaId,
                messageId: '81',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain' as const,
        }
        await setLLMCache('manual force source', 'manual old result', options)
        mocks.requestChatData
            .mockResolvedValueOnce({ type: 'fail', result: 'forced failure' })
            .mockResolvedValueOnce({ type: 'success', result: 'forced new result' })

        await expect(translateHTML('manual force source', false, character, 81))
            .resolves.toBe('manual old result')
        await expect(translateHTML('manual force source', false, character, 81, true))
            .resolves.toBe('manual force source')
        await expect(translateHTML('manual force source', false, character, 81))
            .resolves.toBe('manual old result')
        await expect(translateHTML('manual force source', false, character, 81, true))
            .resolves.toBe('forced new result')
        await expect(translateHTML('manual force source', false, character, 81))
            .resolves.toBe('forced new result')
        expect(mocks.requestChatData).toHaveBeenCalledTimes(2)
    })

    it('keeps the last committed result when a forced attempt is aborted', async () => {
        const character = simpleCharacter()
        mocks.requestChatData
            .mockResolvedValueOnce({ type: 'success', result: 'last good abort result' })
            .mockImplementationOnce((_arg, _mode, signal: AbortSignal) => new Promise((resolve) => {
                signal.addEventListener('abort', () => resolve({ type: 'fail', result: 'Aborted' }), { once: true })
            }))
        await translateHTML('force abort', false, character, 9)
        const controller = new AbortController()
        const forced = translateHTML('force abort', false, character, 9, true, {
            signal: controller.signal,
        })
        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledTimes(2))

        controller.abort()

        await expect(forced).rejects.toMatchObject({ name: 'AbortError' })
        await expect(translateHTML('force abort', false, character, 9)).resolves.toBe('last good abort result')
        expect(mocks.requestChatData).toHaveBeenCalledTimes(2)
    })

    it('re-reads a committed force result that overtakes an older cache read', async () => {
        const character = simpleCharacter()
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'old committed result' })
        await translateHTML('overtaken read', false, character, 10)
        const [{ key }] = await searchLLMCache('overtaken read')
        const originalGetItem = LLMCacheStorage.getItem.bind(LLMCacheStorage)
        let releaseOldRead!: () => void
        const oldReadGate = new Promise<void>((resolve) => {
            releaseOldRead = resolve
        })
        let delayed = false
        const getSpy = vi.spyOn(LLMCacheStorage, 'getItem').mockImplementation(async (storageKey) => {
            const value = await originalGetItem(storageKey)
            if (!delayed && storageKey === key) {
                delayed = true
                await oldReadGate
            }
            return value
        })
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'new committed result' })

        const olderReader = translateHTML('overtaken read', false, character, 10)
        await vi.waitFor(() => expect(delayed).toBe(true))
        await expect(translateHTML('overtaken read', false, character, 10, true))
            .resolves.toBe('new committed result')
        releaseOldRead()

        await expect(olderReader).resolves.toBe('new committed result')
        getSpy.mockRestore()
        expect(mocks.requestChatData).toHaveBeenCalledTimes(2)
    })

    it('keeps imported semantic overrides usable when request hooks are stateful', async () => {
        const character = simpleCharacter()
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'generated before import' })
        await translateHTML('semantic imported source', false, character, 82)
        const backup = await exportLLMCacheAsJSON()
        const semanticKey = Object.keys(backup.entries).find((key) => key.startsWith('translation:v1:'))
        expect(semanticKey).toBeTruthy()
        backup.entries[semanticKey!] = {
            ...backup.entries[semanticKey!],
            result: 'explicit imported result',
            origin: 'imported',
        }

        await clearLLMCache()
        await importLLMCacheFromJSON(backup)
        mocks.requestChatData.mockReset()
        mocks.pipelineStateful = true

        await expect(getLLMCache('semantic imported source', {
            context: {
                characterId: character.chaId,
                messageId: '82',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain',
        })).resolves.toBe('explicit imported result')
        await expect(translateHTML('semantic imported source', false, character, 82))
            .resolves.toBe('explicit imported result')
        expect(mocks.requestChatData).not.toHaveBeenCalled()

        mocks.requestChatData
            .mockResolvedValueOnce({
                type: 'success',
                result: 'forced stateful replacement',
                pipelineStateful: true,
            })
            .mockResolvedValueOnce({
                type: 'success',
                result: 'next stateful provider result',
                pipelineStateful: true,
            })
        await expect(translateHTML('semantic imported source', false, character, 82, true))
            .resolves.toBe('forced stateful replacement')
        await expect(translateHTML('semantic imported source', false, character, 82))
            .resolves.toBe('next stateful provider result')
        expect(mocks.requestChatData).toHaveBeenCalledTimes(2)
    })

    it('prefers the newest semantic source variant over a coexisting legacy raw key', async () => {
        await importLLMCacheFromJSON({ 'coexisting source': 'legacy result' })
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'new semantic result' })

        await translateHTML('coexisting source', false, simpleCharacter(), 83, true)

        await expect(getLLMCacheByStorageKey('coexisting source'))
            .resolves.toBe('new semantic result')
    })

    it('does not let an aborted manual cache read cancel an existing provider flight', async () => {
        const character = simpleCharacter()
        let resolveProvider!: (value: { type: 'success', result: string }) => void
        let providerSignal!: AbortSignal
        mocks.requestChatData.mockImplementationOnce((_arg, _mode, signal: AbortSignal) => {
            providerSignal = signal
            return new Promise((resolve) => {
                resolveProvider = resolve
            })
        })
        const generated = translateHTML('manual abort source', false, character, 84)
        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledOnce())

        const originalGetItem = LLMCacheStorage.getItem.bind(LLMCacheStorage)
        let releaseManualRead!: () => void
        const manualReadGate = new Promise<void>((resolve) => {
            releaseManualRead = resolve
        })
        let manualReadStarted = false
        const getSpy = vi.spyOn(LLMCacheStorage, 'getItem').mockImplementation(async (key) => {
            const value = await originalGetItem(key)
            if (!manualReadStarted && key.startsWith('translation:manual:v1:')) {
                manualReadStarted = true
                await manualReadGate
            }
            return value
        })
        const controller = new AbortController()
        const manualWrite = setLLMCache('manual abort source', 'cancelled manual', {
            context: {
                characterId: character.chaId,
                messageId: '84',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain',
            signal: controller.signal,
        })
        await vi.waitFor(() => expect(manualReadStarted).toBe(true))

        controller.abort()
        releaseManualRead()
        await expect(manualWrite).rejects.toMatchObject({ name: 'AbortError' })
        expect(providerSignal.aborted).toBe(false)
        resolveProvider({ type: 'success', result: 'provider survived' })
        await expect(generated).resolves.toBe('provider survived')
        getSpy.mockRestore()
    })

    it('does not cancel an existing provider flight when a manual storage write fails', async () => {
        const character = simpleCharacter()
        let resolveProvider!: (value: { type: 'success', result: string }) => void
        let providerSignal!: AbortSignal
        mocks.requestChatData.mockImplementationOnce((_arg, _mode, signal: AbortSignal) => {
            providerSignal = signal
            return new Promise((resolve) => {
                resolveProvider = resolve
            })
        })
        const generated = translateHTML('manual storage failure', false, character, 93)
        await vi.waitFor(() => expect(mocks.requestChatData).toHaveBeenCalledOnce())
        const originalSetItem = LLMCacheStorage.setItem.bind(LLMCacheStorage)
        const setSpy = vi.spyOn(LLMCacheStorage, 'setItem').mockImplementation(async (key, value) => {
            if (key.startsWith('translation:manual:v1:')) {
                throw new Error('manual storage failed')
            }
            return originalSetItem(key, value)
        })

        await expect(setLLMCache('manual storage failure', 'manual value', {
            context: {
                characterId: character.chaId,
                messageId: '93',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain',
        })).rejects.toThrow('manual storage failed')
        expect(providerSignal.aborted).toBe(false)
        resolveProvider({ type: 'success', result: 'provider still completes' })
        await expect(generated).resolves.toBe('provider still completes')
        setSpy.mockRestore()
    })

    it('aborts force during a delayed manual read without starting a provider or deleting the override', async () => {
        const character = simpleCharacter()
        const options = {
            context: {
                characterId: character.chaId,
                messageId: '85',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain' as const,
        }
        await setLLMCache('force read abort', 'manual survives', options)
        const originalGetItem = LLMCacheStorage.getItem.bind(LLMCacheStorage)
        let releaseManualRead!: () => void
        const manualReadGate = new Promise<void>((resolve) => {
            releaseManualRead = resolve
        })
        let manualReadStarted = false
        const getSpy = vi.spyOn(LLMCacheStorage, 'getItem').mockImplementation(async (key) => {
            const value = await originalGetItem(key)
            if (!manualReadStarted && key.startsWith('translation:manual:v1:')) {
                manualReadStarted = true
                await manualReadGate
            }
            return value
        })
        const controller = new AbortController()
        const forced = translateHTML('force read abort', false, character, 85, true, {
            signal: controller.signal,
        })
        await vi.waitFor(() => expect(manualReadStarted).toBe(true))

        controller.abort()
        releaseManualRead()

        await expect(forced).rejects.toMatchObject({ name: 'AbortError' })
        expect(mocks.requestChatData).not.toHaveBeenCalled()
        await expect(getLLMCache('force read abort', options)).resolves.toBe('manual survives')
        getSpy.mockRestore()
    })

    it('fences a delayed manual reader after force successfully removes the override', async () => {
        const character = simpleCharacter()
        const options = {
            context: {
                characterId: character.chaId,
                messageId: '86',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain' as const,
        }
        await setLLMCache('manual delayed read', 'stale manual result', options)
        const originalGetItem = LLMCacheStorage.getItem.bind(LLMCacheStorage)
        let releaseOldRead!: () => void
        const oldReadGate = new Promise<void>((resolve) => {
            releaseOldRead = resolve
        })
        let delayed = false
        const getSpy = vi.spyOn(LLMCacheStorage, 'getItem').mockImplementation(async (key) => {
            const value = await originalGetItem(key)
            if (!delayed && key.startsWith('translation:manual:v1:')) {
                delayed = true
                await oldReadGate
            }
            return value
        })
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'fresh forced result' })

        const olderReader = translateHTML('manual delayed read', false, character, 86)
        await vi.waitFor(() => expect(delayed).toBe(true))
        await expect(translateHTML('manual delayed read', false, character, 86, true))
            .resolves.toBe('fresh forced result')
        releaseOldRead()

        await expect(olderReader).resolves.toBe('fresh forced result')
        getSpy.mockRestore()
        expect(mocks.requestChatData).toHaveBeenCalledOnce()
    })

    it('restores the prior committed record when force is aborted after storage replacement', async () => {
        const character = simpleCharacter()
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'durable old result' })
        await translateHTML('post-write abort', false, character, 87)
        const [{ key }] = await searchLLMCache('post-write abort')
        const originalSetItem = LLMCacheStorage.setItem.bind(LLMCacheStorage)
        let releaseWrite!: () => void
        const writeGate = new Promise<void>((resolve) => {
            releaseWrite = resolve
        })
        let replacementStored = false
        const setSpy = vi.spyOn(LLMCacheStorage, 'setItem').mockImplementation(async (storageKey, value) => {
            const result = await originalSetItem(storageKey, value)
            if (
                !replacementStored
                && storageKey === key
                && typeof value === 'object'
                && value !== null
                && (value as { result?: string }).result === 'uncommitted replacement'
            ) {
                replacementStored = true
                await writeGate
            }
            return result
        })
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'uncommitted replacement' })
        const controller = new AbortController()
        const forced = translateHTML('post-write abort', false, character, 87, true, {
            signal: controller.signal,
        })
        await vi.waitFor(() => expect(replacementStored).toBe(true))

        controller.abort()
        releaseWrite()

        await expect(forced).rejects.toMatchObject({ name: 'AbortError' })
        await expect(translateHTML('post-write abort', false, character, 87))
            .resolves.toBe('durable old result')
        setSpy.mockRestore()
        expect(mocks.requestChatData).toHaveBeenCalledTimes(2)
    })

    it('seeds force versions from durable storage after in-memory version state is empty', async () => {
        const character = simpleCharacter()
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'discover key' })
        await translateHTML('durable version seed', false, character, 88)
        const [{ key }] = await searchLLMCache('durable version seed')
        await clearLLMCache()
        await LLMCacheStorage.setItem(key, {
            schemaVersion: 1,
            version: 5,
            result: 'persisted v5',
            origin: 'generated',
            updatedAt: Date.now(),
            sourceSearchText: 'durable version seed',
        })
        mocks.requestChatData.mockReset()
        const originalGetItem = LLMCacheStorage.getItem.bind(LLMCacheStorage)
        let releaseOldRead!: () => void
        const oldReadGate = new Promise<void>((resolve) => {
            releaseOldRead = resolve
        })
        let delayed = false
        const getSpy = vi.spyOn(LLMCacheStorage, 'getItem').mockImplementation(async (storageKey) => {
            const value = await originalGetItem(storageKey)
            if (!delayed && storageKey === key) {
                delayed = true
                await oldReadGate
            }
            return value
        })
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'persisted v6' })

        const oldReader = translateHTML('durable version seed', false, character, 88)
        await vi.waitFor(() => expect(delayed).toBe(true))
        await expect(translateHTML('durable version seed', false, character, 88, true))
            .resolves.toBe('persisted v6')
        releaseOldRead()

        await expect(oldReader).resolves.toBe('persisted v6')
        const stored = await originalGetItem(key) as { version: number, result: string }
        expect(stored).toMatchObject({ version: 6, result: 'persisted v6' })
        getSpy.mockRestore()
    })

    it('does not let a translation preflight repopulate cache after clear completes', async () => {
        const originalGetItem = LLMCacheStorage.getItem.bind(LLMCacheStorage)
        let releaseRead!: () => void
        const readGate = new Promise<void>((resolve) => {
            releaseRead = resolve
        })
        let readStarted = false
        const getSpy = vi.spyOn(LLMCacheStorage, 'getItem').mockImplementation(async (key) => {
            const value = await originalGetItem(key)
            if (!readStarted && key.startsWith('translation:manual:v1:')) {
                readStarted = true
                await readGate
            }
            return value
        })

        const pending = translateHTML('clear preflight source', false, simpleCharacter(), 89)
        await vi.waitFor(() => expect(readStarted).toBe(true))
        await clearLLMCache()
        releaseRead()

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(mocks.requestChatData).not.toHaveBeenCalled()
        getSpy.mockRestore()
    })

    it('reports a manual save as aborted when clear wins during its storage write', async () => {
        const originalSetItem = LLMCacheStorage.setItem.bind(LLMCacheStorage)
        let releaseWrite!: () => void
        const writeGate = new Promise<void>((resolve) => {
            releaseWrite = resolve
        })
        let manualStored = false
        const setSpy = vi.spyOn(LLMCacheStorage, 'setItem').mockImplementation(async (key, value) => {
            const result = await originalSetItem(key, value)
            if (!manualStored && key.startsWith('translation:manual:v1:')) {
                manualStored = true
                await writeGate
            }
            return result
        })
        const character = simpleCharacter()
        const options = {
            context: {
                characterId: character.chaId,
                messageId: '92',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain' as const,
        }
        const saving = setLLMCache('clear manual write', 'must be cleared', options)
        await vi.waitFor(() => expect(manualStored).toBe(true))
        const clearing = clearLLMCache()
        releaseWrite()

        await expect(saving).rejects.toMatchObject({ name: 'AbortError' })
        await clearing
        await expect(getLLMCache('clear manual write', options)).resolves.toBeNull()
        setSpy.mockRestore()
    })

    it('does not let an import preflight write after a newer clear', async () => {
        const semanticKey = `translation:v1:${'a'.repeat(64)}`
        const originalGetItem = LLMCacheStorage.getItem.bind(LLMCacheStorage)
        let releaseRead!: () => void
        const readGate = new Promise<void>((resolve) => {
            releaseRead = resolve
        })
        let readStarted = false
        const getSpy = vi.spyOn(LLMCacheStorage, 'getItem').mockImplementation(async (key) => {
            const value = await originalGetItem(key)
            if (!readStarted && key === semanticKey) {
                readStarted = true
                await readGate
            }
            return value
        })
        const importing = importLLMCacheFromJSON({
            translationCacheExportVersion: 2,
            entries: {
                [semanticKey]: {
                    result: 'must not survive clear',
                    sourceSearchText: 'clear import source',
                    origin: 'imported',
                },
            },
        })
        await vi.waitFor(() => expect(readStarted).toBe(true))
        await clearLLMCache()
        releaseRead()

        await expect(importing).resolves.toEqual({ count: 0, failed: 1 })
        await expect(originalGetItem(semanticKey)).resolves.toBeNull()
        getSpy.mockRestore()
    })

    it('re-reads a manual override committed after an earlier null snapshot', async () => {
        const character = simpleCharacter()
        const options = {
            context: {
                characterId: character.chaId,
                messageId: '90',
                translatorNote: character.translatorNote ?? '',
            },
            sourceFormat: 'plain' as const,
        }
        const originalGetItem = LLMCacheStorage.getItem.bind(LLMCacheStorage)
        let releaseNullRead!: () => void
        const nullReadGate = new Promise<void>((resolve) => {
            releaseNullRead = resolve
        })
        let delayed = false
        const getSpy = vi.spyOn(LLMCacheStorage, 'getItem').mockImplementation(async (key) => {
            const value = await originalGetItem(key)
            if (!delayed && key.startsWith('translation:manual:v1:')) {
                delayed = true
                await nullReadGate
            }
            return value
        })

        const reader = translateHTML('late manual source', false, character, 90)
        await vi.waitFor(() => expect(delayed).toBe(true))
        await setLLMCache('late manual source', 'late manual result', options)
        releaseNullRead()

        await expect(reader).resolves.toBe('late manual result')
        expect(mocks.requestChatData).not.toHaveBeenCalled()
        getSpy.mockRestore()
    })

    it('joins a result committed after an earlier generated null snapshot', async () => {
        const character = simpleCharacter()
        // Discover the deterministic plan key without retaining its record.
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'discovery' })
        await translateHTML('late generated source', false, character, 91)
        const [{ key }] = await searchLLMCache('late generated source')
        await clearLLMCache()
        mocks.requestChatData.mockReset()
        const originalGetItem = LLMCacheStorage.getItem.bind(LLMCacheStorage)
        let releaseNullRead!: () => void
        const nullReadGate = new Promise<void>((resolve) => {
            releaseNullRead = resolve
        })
        let delayed = false
        const getSpy = vi.spyOn(LLMCacheStorage, 'getItem').mockImplementation(async (storageKey) => {
            const value = await originalGetItem(storageKey)
            if (!delayed && storageKey === key) {
                delayed = true
                await nullReadGate
            }
            return value
        })
        mocks.requestChatData.mockResolvedValueOnce({ type: 'success', result: 'single late result' })

        const olderReader = translateHTML('late generated source', false, character, 91)
        await vi.waitFor(() => expect(delayed).toBe(true))
        await expect(translateHTML('late generated source', false, character, 91))
            .resolves.toBe('single late result')
        releaseNullRead()

        await expect(olderReader).resolves.toBe('single late result')
        expect(mocks.requestChatData).toHaveBeenCalledOnce()
        getSpy.mockRestore()
    })
})
