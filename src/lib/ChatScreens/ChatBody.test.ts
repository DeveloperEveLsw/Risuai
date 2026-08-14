// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { TranslationIntegrityError } from '../../ts/translator/translationPlan'
import {
    createChatTranslationIdentityKey,
    createChatTranslationScopeKey,
    snapshotChatTranslationSettings,
    type ManualTranslationPreparedTarget,
    type ManualTranslationPresentationHandoff,
} from './chatTranslationRun'

const mocks = vi.hoisted(() => {
    const db = {
        autoTranslate: false,
        autoTranslateCachedOnly: false,
        translatorType: 'llm',
        translateBeforeHTMLFormatting: false,
        legacyTranslation: false,
        showTranslationLoading: false,
        newImageHandlingBeta: false,
        characters: [],
    }
    type CacheMutation = {
        revision: number
        reason: 'manual' | 'force' | 'import' | 'clear'
        touchedKeys: string[]
        scope: {
            characterId?: string
            chatId?: string
            messageId?: string
        } | null
        result?: string
    }
    let cacheMutation: CacheMutation = {
        revision: 0,
        reason: 'clear',
        touchedKeys: [],
        scope: null,
    }
    const cacheMutationListeners = new Set<(value: CacheMutation) => void>()
    const futureCacheMutationListeners = new Set<(value: CacheMutation) => void>()
    const cacheMutationStore = {
        subscribe(run: (value: CacheMutation) => void) {
            cacheMutationListeners.add(run)
            run(cacheMutation)
            return () => cacheMutationListeners.delete(run)
        },
        set(value: CacheMutation) {
            cacheMutation = value
            for (const run of cacheMutationListeners) run(value)
            for (const run of futureCacheMutationListeners) run(value)
        },
    }
    const subscribeTranslationCacheMutations = (run: (value: CacheMutation) => void) => {
        futureCacheMutationListeners.add(run)
        return () => futureCacheMutationListeners.delete(run)
    }
    const cacheIdentity = (
        text: string,
        options: {
            context?: Record<string, unknown>
            sourceFormat?: string
            manualSource?: string
        } = {},
    ) => ({
        manualKey: `manual:${options.manualSource ?? text}:${JSON.stringify(options.context ?? {})}`,
        planKey: `plan:${text}:${options.sourceFormat ?? 'plain'}:${JSON.stringify(options.context ?? {})}`,
        legacyKey: text,
        pipelineStateful: false,
    })
    class ProviderError extends Error {
        constructor(message = 'provider failed') {
            super(message)
            this.name = 'TranslationProviderError'
        }
    }
    return {
        db,
        cacheMutationStore,
        subscribeTranslationCacheMutations,
        cacheIdentity,
        getLLMCacheIdentity: vi.fn(async (text: string, options: Record<string, unknown>) => (
            cacheIdentity(text, options)
        )),
        ProviderError,
        canonical: vi.fn(async (data: string) => `<p>canonical:${data}</p>`),
        prepare: vi.fn(async (data: string, _character?: unknown) => ({
            data: `prepared:${data}`,
            resolveStyleTemplates: true,
        })),
        finalize: vi.fn(async (prepared: { data: string }, mode: string) => `${mode}:${prepared.data}`),
        postTranslation: vi.fn(async (data: string) => data),
        readOnly: vi.fn(async (data: string) => `<p>readonly:${data}</p>`),
        trimCanonical: vi.fn((data: string) => data),
        trimReadOnly: vi.fn((data: string) => data),
        getLLMCache: vi.fn(async (_text: string, _options?: unknown) => null as string | null),
        translateHTML: vi.fn(async (data: string) => data),
        resolveTranslationContext: vi.fn((_char: unknown, chatID: number) => ({
            characterId: 'character-a',
            chatId: `room-${chatID}`,
            messageId: `message-${chatID}`,
            translatorNote: 'note-a',
        })),
        alertError: vi.fn(),
    }
})

vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: mocks.db },
}))

vi.mock('src/ts/util', () => ({
    sleep: () => Promise.resolve(),
    getUserName: () => 'User',
}))

vi.mock('../../ts/alert', () => ({
    alertError: mocks.alertError,
}))

vi.mock('../../ts/parser/parser.svelte', () => ({
    addMetadataToElement: (data: string) => data,
    getDistance: vi.fn(() => 0),
    finalizePreparedMarkdown: mocks.finalize,
    ParseMarkdown: mocks.canonical,
    ParseMarkdownReadOnlyPresentation: mocks.readOnly,
    postTranslationParse: mocks.postTranslation,
    prepareMarkdownDisplay: mocks.prepare,
    trimMarkdown: mocks.trimCanonical,
    trimMarkdownReadOnlyPresentation: mocks.trimReadOnly,
}))

vi.mock('../../ts/translator/translator', () => ({
    getLLMCache: mocks.getLLMCache,
    getLLMCacheIdentity: mocks.getLLMCacheIdentity,
    resolveTranslationContext: mocks.resolveTranslationContext,
    subscribeTranslationCacheMutations: mocks.subscribeTranslationCacheMutations,
    translateHTML: mocks.translateHTML,
    TranslationCacheMutationStore: mocks.cacheMutationStore,
    TranslationProviderError: mocks.ProviderError,
}))

vi.mock('src/ts/process/modules', () => ({
    getModuleAssets: () => [],
    getModuleRegexScripts: () => [],
}))

vi.mock('src/ts/storage/database.svelte', () => ({
    getCurrentCharacter: () => ({
        additionalAssets: [],
        prebuiltAssetStyle: '',
    }),
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    getFileSrc: vi.fn(async (path: string) => path),
}))

import ChatBody from './ChatBody.svelte'
import ChatBodyTestHarness from './ChatBodyTestHarness.svelte'

const mounted: unknown[] = []

async function renderBody(
    msgDisplay: string,
    readOnlyPresentation: boolean,
    options: {
        character?: string | null
        translationCharacter?: string | null
        translated?: boolean
        retranslate?: boolean
        idx?: number
        translationManualSource?: string
        manualTranslationPresentation?: ManualTranslationPresentationHandoff | null
        onManualTranslationTargetPrepared?: (target: ManualTranslationPreparedTarget) => void
    } = {},
) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    mounted.push(mount(ChatBody, {
        target,
        props: {
            msgDisplay,
            character: options.character,
            translationCharacter: options.translationCharacter,
            idx: options.idx ?? 0,
            translationManualSource: options.translationManualSource,
            role: 'char',
            translated: options.translated ?? false,
            translating: false,
            retranslate: options.retranslate ?? false,
            manualTranslationPresentation: options.manualTranslationPresentation,
            onManualTranslationTargetPrepared: options.onManualTranslationTargetPrepared,
            modelShortName: '',
            readOnlyPresentation,
        },
    }))
    await tick()
    return target
}

async function renderForceHarness(msgDisplay: string) {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const component = mount(ChatBodyTestHarness, {
        target,
        props: { msgDisplay },
    })
    mounted.push(component)
    await tick()
    return { target, component }
}

function manualPresentation(
    source: string,
    core: string,
    revision = 1,
): ManualTranslationPresentationHandoff {
    const identityInput = {
        source,
        manualSource: source,
        displayCharacter: null,
        translationCharacter: null,
        chatId: 0,
        firstMessage: false,
        role: 'char',
        context: {
            characterId: 'character-a',
            chatId: 'room-0',
            messageId: 'message-0',
            translatorNote: 'note-a',
        },
        settings: snapshotChatTranslationSettings(mocks.db, { userName: 'User' }),
        cacheRevision: 0,
    }
    const translationInput = `pretranslate:prepared:${source}`
    const identityKey = createChatTranslationIdentityKey(identityInput)
    const scopeKey = createChatTranslationScopeKey(identityInput)
    const cacheIdentity = mocks.cacheIdentity(translationInput, {
        context: identityInput.context,
        sourceFormat: 'html-segments-v1',
        manualSource: source,
    })
    return {
        identityKey,
        scopeKey,
        revision,
        core,
        target: {
            identityKey,
            scopeKey,
            translationInput,
            manualSource: source,
            sourceFormat: 'html-segments-v1',
            context: identityInput.context,
            ...cacheIdentity,
        },
    }
}

beforeEach(() => {
    mocks.db.autoTranslate = false
    mocks.db.autoTranslateCachedOnly = false
    mocks.db.translatorType = 'llm'
    mocks.db.translateBeforeHTMLFormatting = false
    mocks.db.legacyTranslation = false
    mocks.cacheMutationStore.set({
        revision: 0,
        reason: 'clear',
        touchedKeys: [],
        scope: null,
    })
    mocks.canonical.mockClear()
    mocks.prepare.mockReset()
    mocks.prepare.mockImplementation(async (data: string) => ({
        data: `prepared:${data}`,
        resolveStyleTemplates: true,
    }))
    mocks.finalize.mockClear()
    mocks.postTranslation.mockClear()
    mocks.readOnly.mockClear()
    mocks.trimCanonical.mockClear()
    mocks.trimReadOnly.mockClear()
    mocks.getLLMCache.mockReset()
    mocks.getLLMCache.mockResolvedValue(null)
    mocks.getLLMCacheIdentity.mockClear()
    mocks.translateHTML.mockReset()
    mocks.translateHTML.mockImplementation(async (data: string) => data)
    mocks.resolveTranslationContext.mockClear()
    mocks.resolveTranslationContext.mockImplementation((_char: unknown, chatID: number) => ({
        characterId: 'character-a',
        chatId: `room-${chatID}`,
        messageId: `message-${chatID}`,
        translatorNote: 'note-a',
    }))
    mocks.alertError.mockClear()
})

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
    document.body.replaceChildren()
})

describe('ChatBody runtime presentation isolation', () => {
    it('routes multiple versions on two follower presentations only through the read-only parser', async () => {
        const databaseBefore = structuredClone(mocks.db)
        const versions = ['one', 'two', 'three']

        const targets = []
        for(const follower of ['desktop', 'phone']){
            for(const version of versions){
                targets.push(await renderBody(`${follower}:${version}`, true))
            }
        }

        await vi.waitFor(() => expect(mocks.readOnly).toHaveBeenCalledTimes(6))
        expect(mocks.canonical).not.toHaveBeenCalled()
        expect(mocks.trimCanonical).not.toHaveBeenCalled()
        expect(mocks.trimReadOnly).toHaveBeenCalled()
        expect(targets.map((target) => target.textContent?.trim())).toEqual([
            'readonly:desktop:one',
            'readonly:desktop:two',
            'readonly:desktop:three',
            'readonly:phone:one',
            'readonly:phone:two',
            'readonly:phone:three',
        ])
        expect(mocks.db).toEqual(databaseBefore)
    })

    it('leaves an ordinary canonical message on the original parser', async () => {
        const target = await renderBody('adopted', false)

        await vi.waitFor(() => expect(target.textContent?.trim()).toBe('canonical:adopted'))
        expect(mocks.readOnly).not.toHaveBeenCalled()
        expect(mocks.trimCanonical).toHaveBeenCalled()
    })

    it('hands a cached-only hit directly to presentation without a provider-capable second lookup', async () => {
        mocks.db.autoTranslate = true
        mocks.db.autoTranslateCachedOnly = true
        mocks.getLLMCache.mockResolvedValue('cached result')
        mocks.translateHTML.mockImplementation(async (data: string) => `translated:${data}`)

        const target = await renderBody('cached message', false)

        await vi.waitFor(() => expect(target.textContent?.trim()).toContain('cached result'))
        expect(mocks.prepare).toHaveBeenCalledOnce()
        expect(mocks.canonical).not.toHaveBeenCalled()
        expect(mocks.getLLMCache).toHaveBeenCalledOnce()
        expect(mocks.translateHTML).not.toHaveBeenCalled()
        expect(mocks.finalize.mock.calls.filter(([, mode]) => mode === 'pretranslate')).toHaveLength(1)
        expect(mocks.postTranslation).toHaveBeenCalledOnce()
    })

    it('prepares editdisplay once for a cached-only miss and derives normal display without rerunning it', async () => {
        mocks.db.autoTranslate = true
        mocks.db.autoTranslateCachedOnly = true
        mocks.getLLMCache.mockResolvedValue(null)

        const target = await renderBody('uncached message', false)

        await vi.waitFor(() => expect(target.textContent?.trim()).toContain('notrim:prepared:uncached message'))
        expect(mocks.prepare).toHaveBeenCalledOnce()
        expect(mocks.canonical).not.toHaveBeenCalled()
        expect(mocks.translateHTML).not.toHaveBeenCalled()
        expect(mocks.finalize.mock.calls.filter(([, mode]) => mode === 'pretranslate')).toHaveLength(1)
        expect(mocks.finalize.mock.calls.filter(([, mode]) => mode === 'notrim')).toHaveLength(1)
    })

    it('keeps the manual override key stable when CBS expands the same raw message differently after remount', async () => {
        mocks.db.autoTranslate = true
        mocks.db.autoTranslateCachedOnly = true
        mocks.getLLMCache
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('manual override survives expansion')
        const firstTarget = vi.fn()
        const first = await renderBody('expanded output A', false, {
            translationManualSource: 'raw canonical message',
            onManualTranslationTargetPrepared: firstTarget,
        })
        await vi.waitFor(() => expect(first.textContent?.trim()).toContain(
            'notrim:prepared:expanded output A'
        ))
        await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))

        const secondTarget = vi.fn()
        const second = await renderBody('expanded output B', false, {
            translationManualSource: 'raw canonical message',
            onManualTranslationTargetPrepared: secondTarget,
        })
        await vi.waitFor(() => expect(second.textContent?.trim()).toContain(
            'manual override survives expansion'
        ))

        const firstPrepared = firstTarget.mock.calls.at(0)?.at(0) as ManualTranslationPreparedTarget
        const secondPrepared = secondTarget.mock.calls.at(0)?.at(0) as ManualTranslationPreparedTarget
        expect(firstPrepared.manualSource).toBe('raw canonical message')
        expect(secondPrepared.manualSource).toBe('raw canonical message')
        expect(firstPrepared.manualKey).toBe(secondPrepared.manualKey)
        expect(firstPrepared.planKey).not.toBe(secondPrepared.planKey)
        expect(mocks.translateHTML).not.toHaveBeenCalled()
    })

    it('invalidates an old cached presentation after clear and keeps a cached-only miss provider-free', async () => {
        mocks.db.autoTranslate = true
        mocks.db.autoTranslateCachedOnly = true
        mocks.getLLMCache
            .mockResolvedValueOnce('cached before clear')
            .mockResolvedValue(null)

        const target = await renderBody('clearable message', false)
        await vi.waitFor(() => expect(target.textContent?.trim()).toContain('cached before clear'))

        mocks.cacheMutationStore.set({
            revision: 1,
            reason: 'clear',
            touchedKeys: [],
            scope: null,
        })
        await tick()

        await vi.waitFor(() => expect(target.textContent?.trim()).toContain(
            'notrim:prepared:clearable message'
        ))
        expect(mocks.getLLMCache).toHaveBeenCalledOnce()
        expect(mocks.translateHTML).not.toHaveBeenCalled()
    })

    it('drops a stale cache probe and adopts the imported or manually saved override for the new revision', async () => {
        mocks.db.autoTranslate = true
        mocks.db.autoTranslateCachedOnly = true
        let resolveOld!: (value: string | null) => void
        const oldProbe = new Promise<string | null>((resolve) => {
            resolveOld = resolve
        })
        mocks.getLLMCache
            .mockImplementationOnce(() => oldProbe)
            .mockResolvedValue('new override')

        const target = await renderBody('overridden message', false)
        await vi.waitFor(() => expect(mocks.getLLMCache).toHaveBeenCalledOnce())

        const importedIdentity = mocks.cacheIdentity(
            'pretranslate:prepared:overridden message',
            {
                context: {
                    characterId: 'character-a',
                    chatId: 'room-0',
                    messageId: 'message-0',
                    translatorNote: 'note-a',
                },
                sourceFormat: 'html-segments-v1',
                manualSource: 'overridden message',
            },
        )
        mocks.cacheMutationStore.set({
            revision: 1,
            reason: 'import',
            touchedKeys: [importedIdentity.manualKey],
            scope: null,
        })
        await tick()
        await vi.waitFor(() => expect(mocks.getLLMCache).toHaveBeenCalledTimes(2))
        resolveOld('stale override')

        await vi.waitFor(() => expect(target.textContent?.trim()).toContain('new override'))
        expect(target.textContent).not.toContain('stale override')
        expect(mocks.translateHTML).not.toHaveBeenCalled()
    })

    it('turns off a visible translation after clear without refilling it through the provider', async () => {
        mocks.db.autoTranslate = true
        mocks.translateHTML.mockResolvedValue('translated before clear')
        const target = await renderBody('do not refill', false)
        await vi.waitFor(() => expect(target.textContent?.trim()).toContain('translated before clear'))

        mocks.translateHTML.mockClear()
        mocks.getLLMCache.mockClear()
        mocks.cacheMutationStore.set({
            revision: 1,
            reason: 'clear',
            touchedKeys: [],
            scope: null,
        })
        await tick()

        await vi.waitFor(() => expect(target.textContent?.trim()).toContain('notrim:prepared:do not refill'))
        expect(mocks.getLLMCache).not.toHaveBeenCalled()
        expect(mocks.translateHTML).not.toHaveBeenCalled()
    })

    it('invalidates the completed handoff when the parent turns translation off before the child handles clear', async () => {
        mocks.translateHTML.mockResolvedValue('old completed translation')
        const { target, component } = await renderForceHarness('parent-first clear')
        await vi.waitFor(() => expect(target.textContent?.trim()).toContain(
            'old completed translation'
        ))

        mocks.translateHTML.mockResolvedValue('new explicit translation')
        mocks.cacheMutationStore.set({
            revision: 1,
            reason: 'clear',
            touchedKeys: [],
            scope: null,
        })
        await vi.waitFor(() => expect(target.textContent?.trim()).toContain(
            'notrim:prepared:parent-first clear'
        ))
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(mocks.translateHTML).toHaveBeenCalledOnce()

        component.showTranslation()
        await vi.waitFor(() => expect(target.textContent?.trim()).toContain(
            'new explicit translation'
        ))
        expect(mocks.translateHTML).toHaveBeenCalledTimes(2)
        expect(target.textContent).not.toContain('old completed translation')
    })

    it('adopts a manually saved override atomically when ChatBody remounts after the editor closes', async () => {
        const presentation = manualPresentation(
            'manually edited',
            'new manual value',
        )
        const preparedTarget = vi.fn()
        const target = await renderBody('manually edited', false, {
            character: null,
            translationCharacter: null,
            translated: true,
            manualTranslationPresentation: presentation,
            onManualTranslationTargetPrepared: preparedTarget,
        })
        await vi.waitFor(() => expect(target.textContent?.trim()).toContain('new manual value'))
        expect(mocks.prepare).not.toHaveBeenCalled()
        expect(mocks.getLLMCacheIdentity).not.toHaveBeenCalled()
        expect(mocks.getLLMCache).not.toHaveBeenCalled()
        expect(mocks.translateHTML).not.toHaveBeenCalled()
        expect(preparedTarget).toHaveBeenCalledWith(presentation.target)
    })

    it('adopts one manual cache write in every live mount of the same canonical message without a provider', async () => {
        const first = await renderBody('shared canonical message', false, {
            character: 'speaker-a',
            translationCharacter: 'group-a',
            translated: true,
        })
        const second = await renderBody('shared canonical message', false, {
            character: 'speaker-b',
            translationCharacter: 'group-a',
            translated: true,
        })
        await vi.waitFor(() => expect(mocks.translateHTML).toHaveBeenCalledTimes(2))
        await vi.waitFor(() => {
            expect(first.textContent?.trim()).toContain('pretranslate:prepared:shared canonical message')
            expect(second.textContent?.trim()).toContain('pretranslate:prepared:shared canonical message')
        })

        mocks.translateHTML.mockClear()
        mocks.getLLMCache.mockResolvedValue('shared manual override')
        const cacheIdentity = await mocks.getLLMCacheIdentity.mock.results.at(0)?.value
        const context = (mocks.getLLMCacheIdentity.mock.calls.at(0)?.at(1) as {
            context: {
                characterId: string
                chatId: string
                messageId: string
            }
        }).context
        mocks.cacheMutationStore.set({
            revision: 1,
            reason: 'manual',
            touchedKeys: [cacheIdentity.manualKey],
            scope: {
                characterId: context.characterId,
                chatId: context.chatId,
                messageId: context.messageId,
            },
        })
        await tick()
        await vi.waitFor(() => expect(mocks.getLLMCache).toHaveBeenCalledTimes(2))

        await vi.waitFor(() => {
            expect(first.textContent?.trim()).toContain('shared manual override')
            expect(second.textContent?.trim()).toContain('shared manual override')
        })
        expect(mocks.getLLMCache).toHaveBeenCalledTimes(2)
        expect(mocks.translateHTML).not.toHaveBeenCalled()
    })

    it('does not inject a stateful force result into another prepared plan that only shares its manual key', async () => {
        mocks.prepare.mockImplementation(async (data: string, char?: string) => ({
            data: `prepared:${char}:${data}`,
            resolveStyleTemplates: true,
        }))
        mocks.translateHTML.mockImplementation(async (data: string) => `initial:${data}`)
        const first = await renderBody('shared force source', false, {
            character: 'speaker-a',
            translationCharacter: 'group-a',
            translated: true,
        })
        const second = await renderBody('shared force source', false, {
            character: 'speaker-b',
            translationCharacter: 'group-a',
            translated: true,
        })
        await vi.waitFor(() => {
            expect(first.textContent?.trim()).toContain('prepared:speaker-a:shared force source')
            expect(second.textContent?.trim()).toContain('prepared:speaker-b:shared force source')
        })

        const firstIdentity = await mocks.getLLMCacheIdentity.mock.results.at(0)?.value
        const secondIdentity = await mocks.getLLMCacheIdentity.mock.results.at(1)?.value
        expect(firstIdentity.manualKey).toBe(secondIdentity.manualKey)
        expect(firstIdentity.planKey).not.toBe(secondIdentity.planKey)
        const context = (mocks.getLLMCacheIdentity.mock.calls.at(0)?.at(1) as {
            context: {
                characterId: string
                chatId: string
                messageId: string
            }
        }).context
        mocks.translateHTML.mockClear()
        mocks.getLLMCache.mockImplementation(async (text: string) => (
            text.includes('speaker-b') ? 'cached core for speaker B' : null
        ))
        mocks.cacheMutationStore.set({
            revision: 1,
            reason: 'force',
            touchedKeys: [
                firstIdentity.manualKey,
                firstIdentity.planKey,
                firstIdentity.legacyKey,
            ],
            scope: {
                characterId: context.characterId,
                chatId: context.chatId,
                messageId: context.messageId,
            },
            result: 'forced core for speaker A',
        })

        await vi.waitFor(() => {
            expect(first.textContent?.trim()).toContain('forced core for speaker A')
            expect(second.textContent?.trim()).toContain('cached core for speaker B')
        })
        expect(second.textContent).not.toContain('forced core for speaker A')
        expect(mocks.getLLMCache).toHaveBeenCalledOnce()
        expect(mocks.translateHTML).not.toHaveBeenCalled()
    })

    it('does not retry or alert when an in-flight translation is aborted on teardown', async () => {
        mocks.db.autoTranslate = true
        mocks.db.autoTranslateCachedOnly = false
        mocks.translateHTML.mockImplementation((_data: string, ...args: unknown[]) => {
            const options = args.at(-1) as { signal: AbortSignal }
            return new Promise<string>((_resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    reject(new DOMException('aborted', 'AbortError'))
                }, { once: true })
            })
        })

        await renderBody('abort message', false)
        await vi.waitFor(() => expect(mocks.translateHTML).toHaveBeenCalledOnce())
        await Promise.all(mounted.splice(0).map((component) => unmount(component as never)))
        await tick()

        expect(mocks.translateHTML).toHaveBeenCalledOnce()
        expect(mocks.alertError).not.toHaveBeenCalled()
    })

    it('does not abort or restart an active provider for an unrelated cache mutation', async () => {
        mocks.db.autoTranslate = true
        let resolveProvider!: (value: string) => void
        let providerSignal: AbortSignal | undefined
        mocks.translateHTML.mockImplementation((_data: string, ...args: unknown[]) => {
            providerSignal = (args.at(-1) as { signal: AbortSignal }).signal
            return new Promise<string>((resolve) => {
                resolveProvider = resolve
            })
        })

        const target = await renderBody('paid request stays live', false)
        await vi.waitFor(() => expect(mocks.translateHTML).toHaveBeenCalledOnce())

        mocks.cacheMutationStore.set({
            revision: 1,
            reason: 'force',
            touchedKeys: ['translation:v1:same-message-but-old-settings'],
            scope: {
                characterId: 'character-a',
                chatId: 'room-0',
                messageId: 'message-0',
            },
            result: 'wrong-setting result',
        })
        await tick()

        expect(providerSignal?.aborted).toBe(false)
        expect(mocks.translateHTML).toHaveBeenCalledOnce()
        resolveProvider('paid result')
        await vi.waitFor(() => expect(target.textContent?.trim()).toContain('paid result'))
        expect(mocks.translateHTML).toHaveBeenCalledOnce()
    })

    it('never replays an old stateful force result into a ChatBody mounted later', async () => {
        mocks.cacheMutationStore.set({
            revision: 9,
            reason: 'force',
            touchedKeys: ['manual:old'],
            scope: {
                characterId: 'character-a',
                chatId: 'room-0',
                messageId: 'message-0',
            },
            result: 'old ephemeral force result',
        })
        mocks.translateHTML.mockResolvedValue('fresh mounted result')

        const target = await renderBody('late mounted message', false, {
            translated: true,
        })

        await vi.waitFor(() => expect(target.textContent?.trim()).toContain('fresh mounted result'))
        expect(target.textContent).not.toContain('old ephemeral force result')
        expect(mocks.translateHTML).toHaveBeenCalledOnce()
    })

    it('falls back to the original when the translator aborts while the component run is still current', async () => {
        mocks.db.autoTranslate = true
        mocks.translateHTML.mockRejectedValue(new DOMException(
            'translation plan changed',
            'AbortError',
        ))

        const target = await renderBody('current abort', false)

        await vi.waitFor(() => expect(target.textContent?.trim()).toContain(
            'notrim:prepared:current abort'
        ))
        expect(target.textContent?.trim()).not.toBe('')
        expect(mocks.translateHTML).toHaveBeenCalledOnce()
        expect(mocks.alertError).not.toHaveBeenCalled()
    })

    it('does not retry an integrity failure and falls back to the normal untranslated display', async () => {
        mocks.db.autoTranslate = true
        mocks.db.autoTranslateCachedOnly = false
        mocks.translateHTML.mockRejectedValue(new TranslationIntegrityError())

        const target = await renderBody('protected message', false)

        await vi.waitFor(() => expect(mocks.alertError).toHaveBeenCalledOnce())
        await vi.waitFor(() => expect(target.textContent?.trim()).toContain(
            'notrim:prepared:protected message'
        ))
        expect(mocks.getLLMCache).not.toHaveBeenCalled()
        expect(mocks.translateHTML).toHaveBeenCalledOnce()
        expect(mocks.alertError).toHaveBeenCalledWith(
            'Translation integrity check failed. Showing the original message.'
        )
    })

    it('reuses a completed forced stateful result when clearing the force flag', async () => {
        mocks.translateHTML.mockImplementation(async (data: string) => `forced:${data}`)

        const target = await renderBody('stateful force', false, {
            translated: true,
            retranslate: true,
        })

        await vi.waitFor(() => expect(target.textContent?.trim()).toContain(
            'forced:pretranslate:prepared:stateful force'
        ))
        await new Promise((resolve) => setTimeout(resolve, 30))
        await tick()
        expect(mocks.translateHTML).toHaveBeenCalledOnce()
    })

    it('restores the last completed presentation when an explicit force request fails', async () => {
        mocks.translateHTML.mockImplementation(async (_data: string, ...args: unknown[]) => {
            const force = args.at(-2)
            if (force) throw new mocks.ProviderError()
            return 'last good translation'
        })

        const { target, component } = await renderForceHarness('force failure')
        await vi.waitFor(() => expect(target.textContent?.trim()).toContain(
            'last good translation'
        ))

        component.forceRetranslate()
        await vi.waitFor(() => expect(mocks.translateHTML).toHaveBeenCalledTimes(2))
        await new Promise((resolve) => setTimeout(resolve, 30))
        await tick()

        expect(target.textContent?.trim()).toContain('last good translation')
        expect(mocks.translateHTML).toHaveBeenCalledTimes(2)
        expect(mocks.translateHTML.mock.calls.at(-1)?.at(-1)).toMatchObject({
            force: true,
            throwOnFailure: true,
            manualSource: 'force failure',
        })
    })

    it('consumes a matching stateful force event and clears the initiating force flag', async () => {
        mocks.translateHTML.mockImplementation(async (data: string, ...args: unknown[]) => {
            const force = args.at(-2)
            const options = args.at(-1) as {
                context: Record<string, unknown>
                sourceFormat: string
                manualSource: string
            }
            if (!force) return 'initial translation'
            const identity = mocks.cacheIdentity(data, options)
            setTimeout(() => {
                mocks.cacheMutationStore.set({
                    revision: 1,
                    reason: 'force',
                    touchedKeys: [identity.manualKey, identity.planKey, identity.legacyKey],
                    scope: {
                        characterId: options.context.characterId as string,
                        chatId: options.context.chatId as string,
                        messageId: options.context.messageId as string,
                    },
                    result: 'stateful forced translation',
                })
            }, 0)
            return 'provider forced translation'
        })

        const { target, component } = await renderForceHarness('force event')
        await vi.waitFor(() => expect(target.textContent?.trim()).toContain('initial translation'))
        component.forceRetranslate()

        await vi.waitFor(() => expect(target.textContent?.trim()).toContain(
            'stateful forced translation'
        ))
        await new Promise((resolve) => setTimeout(resolve, 30))
        await tick()
        expect(component.isRetranslating()).toBe(false)
        expect(mocks.translateHTML).toHaveBeenCalledTimes(2)
    })

    it('ends an active force when a matching manual write supersedes it', async () => {
        let forceSignal: AbortSignal | undefined
        mocks.translateHTML.mockImplementation(async (_data: string, ...args: unknown[]) => {
            const force = args.at(-2)
            const options = args.at(-1) as { signal: AbortSignal }
            if (!force) return 'translation before manual write'
            forceSignal = options.signal
            return new Promise<string>((_resolve, reject) => {
                options.signal.addEventListener('abort', () => {
                    reject(new DOMException('superseded by manual write', 'AbortError'))
                }, { once: true })
            })
        })

        const { target, component } = await renderForceHarness('manual beats force')
        await vi.waitFor(() => expect(target.textContent?.trim()).toContain(
            'translation before manual write'
        ))
        const identity = await mocks.getLLMCacheIdentity.mock.results.at(0)?.value
        const context = (mocks.getLLMCacheIdentity.mock.calls.at(0)?.at(1) as {
            context: {
                characterId: string
                chatId: string
                messageId: string
            }
        }).context

        component.forceRetranslate()
        await vi.waitFor(() => expect(mocks.translateHTML).toHaveBeenCalledTimes(2))
        mocks.getLLMCache.mockResolvedValue('new manual translation')
        mocks.cacheMutationStore.set({
            revision: 1,
            reason: 'manual',
            touchedKeys: [identity.manualKey],
            scope: {
                characterId: context.characterId,
                chatId: context.chatId,
                messageId: context.messageId,
            },
        })

        await vi.waitFor(() => expect(target.textContent?.trim()).toContain(
            'new manual translation'
        ))
        await new Promise((resolve) => setTimeout(resolve, 30))
        await tick()
        expect(forceSignal?.aborted).toBe(true)
        expect(component.isRetranslating()).toBe(false)
        expect(mocks.translateHTML).toHaveBeenCalledTimes(2)
    })

    it('does not let a retained manual handoff overwrite a completed forced result', async () => {
        mocks.translateHTML.mockImplementation(async (data: string) => `forced:${data}`)

        const target = await renderBody('force over manual', false, {
            character: null,
            translationCharacter: null,
            translated: true,
            retranslate: true,
            manualTranslationPresentation: manualPresentation(
                'force over manual',
                'stale manual core',
            ),
        })

        await vi.waitFor(() => expect(target.textContent?.trim()).toContain(
            'forced:pretranslate:prepared:force over manual'
        ))
        await new Promise((resolve) => setTimeout(resolve, 30))
        await tick()
        expect(target.textContent).not.toContain('stale manual core')
        expect(mocks.translateHTML).toHaveBeenCalledOnce()
    })

    it('uses the speaker for display preparation but the selected group for translation context and scripts', async () => {
        mocks.db.autoTranslate = true
        mocks.db.autoTranslateCachedOnly = false
        mocks.resolveTranslationContext.mockImplementation((char: unknown, chatID: number) => ({
            characterId: char === 'group-a' ? 'group-a' : String(char),
            chatId: char === 'group-a' ? 'group-room' : 'speaker-room',
            messageId: `message-${chatID}`,
            translatorNote: char === 'group-a' ? '' : 'speaker-note',
        }))
        mocks.translateHTML.mockResolvedValue('group translated')

        await renderBody('group bookmark', false, {
            character: 'speaker-a',
            translationCharacter: 'group-a',
            idx: 7,
        })

        await vi.waitFor(() => expect(mocks.translateHTML).toHaveBeenCalledOnce())
        expect(mocks.prepare).toHaveBeenCalledWith(
            'group bookmark',
            'speaker-a',
            7,
            expect.any(Object),
        )
        expect(mocks.resolveTranslationContext).toHaveBeenCalledWith('group-a', 7)
        const translationCall = mocks.translateHTML.mock.calls.at(0) as unknown[] | undefined
        expect(translationCall?.[2]).toBe('group-a')
        expect(translationCall?.at(-1)).toMatchObject({
            context: {
                characterId: 'group-a',
                chatId: 'group-room',
                messageId: 'message-7',
                translatorNote: '',
            },
        })
    })
})
