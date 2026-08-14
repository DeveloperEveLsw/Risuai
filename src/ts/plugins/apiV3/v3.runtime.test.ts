import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

const mocks = vi.hoisted(() => {
    const pluginV2 = {
        providers: new Map<string, Function>(),
        providerOptions: new Map<string, unknown>(),
        editdisplay: new Set<Function>(),
        editoutput: new Set<Function>(),
        editprocess: new Set<Function>(),
        editinput: new Set<Function>(),
        replacerbeforeRequest: new Set<Function>(),
        replacerafterRequest: new Set<Function>(),
        chatOutput: new Set<Function>(),
        unload: new Set<Function>(),
        loaded: false,
    }
    const permissionStorage = new Map<string, boolean | number>()
    const lifecycleEvents: string[] = []
    const searchLLMCache = vi.fn()
    const getLLMCache = vi.fn()
    const requestChatDataMain = vi.fn()
    const getModuleLorebooks = vi.fn(() => [])
    const registeredMCPs = new Map<string, unknown>()
    const additionalSettingsMenu: any[] = []
    const additionalFloatingActionButtons: any[] = []
    const additionalHamburgerMenu: any[] = []
    const additionalChatMenu: any[] = []
    const bodyIntercepterStore: any[] = []
    const chatPanelStore: any[] = []
    const oldApis = {
        risuFetch: vi.fn(),
        nativeFetch: vi.fn(),
        getChar: vi.fn(),
        setChar: vi.fn(),
        addRisuScriptHandler: vi.fn(),
        removeRisuScriptHandler: vi.fn(),
        addRisuReplacer: vi.fn((name: string, func: Function) => {
            const replacers = pluginV2[`replacer${name}` as 'replacerbeforeRequest'|'replacerafterRequest']
            replacers.add(func)
        }),
        removeRisuReplacer: vi.fn((name: string, func: Function) => {
            lifecycleEvents.push(`remove:${name}`)
            const replacers = pluginV2[`replacer${name}` as 'replacerbeforeRequest'|'replacerafterRequest']
            replacers.delete(func)
        }),
        addRisuChatListener: vi.fn(),
        removeRisuChatListener: vi.fn(),
        setDatabaseLite: vi.fn(),
        setDatabase: vi.fn(),
        loadPlugins: vi.fn(),
        readImage: vi.fn(),
        saveAsset: vi.fn(),
        getArg: vi.fn(),
        setArg: vi.fn(),
        pluginStorage: {
            getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(),
            key: vi.fn(), keys: vi.fn(), length: vi.fn(),
        },
        safeLocalStorage: {
            getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(),
            key: vi.fn(), keys: vi.fn(),
        },
    }
    return {
        db: {
            plugins: [] as Array<{ name: string, script: string }>,
            characters: {},
        },
        pluginV2,
        oldApis,
        permissionStorage,
        lifecycleEvents,
        alertConfirm: vi.fn<() => Promise<boolean>>(),
        getFetchLogs: vi.fn(() => []),
        searchLLMCache,
        getLLMCache,
        requestChatDataMain,
        getModuleLorebooks,
        registeredMCPs,
        additionalSettingsMenu,
        additionalFloatingActionButtons,
        additionalHamburgerMenu,
        additionalChatMenu,
        bodyIntercepterStore,
        chatPanelStore,
        selectedCharID: null as any,
        apiFactories: [] as any[],
        terminatedApiFactories: [] as any[],
        runHook: null as null | ((api: any, script: string) => void | Promise<void>),
        isNodeServer: false,
        nodePermissionResolve: vi.fn(),
    }
})

vi.mock('../plugins.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        allowedDbKeys: ['characters'],
        customProviderStore: writable<string[]>([]),
        getV2PluginAPIs: () => mocks.oldApis,
        handlePluginInstallViaPlugin: vi.fn(),
        pluginV2: mocks.pluginV2,
    }
})
vi.mock('./factory', () => ({
    SandboxHost: class {
        private iframe: HTMLIFrameElement | null = null
        constructor(private readonly apiFactory: any) {
            mocks.apiFactories.push(apiFactory)
        }
        async run(iframe: HTMLIFrameElement, script: string) {
            this.iframe = iframe
            await mocks.runHook?.(this.apiFactory, script)
            return () => this.terminate()
        }
        terminate() {
            mocks.lifecycleEvents.push('terminate')
            mocks.terminatedApiFactories.push(this.apiFactory)
            this.iframe?.remove()
        }
    },
}))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => mocks.db }))
vi.mock('../pluginSafeClass', () => ({
    SafeLocalPluginStorage: class {},
    tagWhitelist: ['div'],
}))
vi.mock('dompurify', () => ({ default: { sanitize: (value: string) => value } }))
vi.mock('src/ts/stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    mocks.selectedCharID = writable<any>(-1)
    return {
        additionalChatMenu: mocks.additionalChatMenu,
        additionalFloatingActionButtons: mocks.additionalFloatingActionButtons,
        additionalHamburgerMenu: mocks.additionalHamburgerMenu,
        additionalSettingsMenu: mocks.additionalSettingsMenu,
        bodyIntercepterStore: mocks.bodyIntercepterStore,
        chatPanelStore: mocks.chatPanelStore,
        DBState: { db: mocks.db },
        selectedCharID: mocks.selectedCharID,
    }
})
vi.mock('uuid', () => ({ v4: vi.fn(() => 'fixture-id') }))
vi.mock('src/ts/util', () => ({ sleep: vi.fn(async () => undefined) }))
vi.mock('src/ts/alert', () => ({
    alertConfirm: mocks.alertConfirm,
    alertError: vi.fn(),
    alertNormal: vi.fn(),
}))
vi.mock('src/lang', () => ({
    language: {
        fetchLogConsent: 'fetchLogs:{}',
        getFullDatabaseConsent: 'db:{}',
        mainDomAccessConsent: 'mainDom:{}',
        replacerPermissionConsent: 'replacer:{}',
        providerPermissionConsent: 'provider:{}',
        sendChatConsent: 'sendChat:{}',
    },
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    checkCharOrder: vi.fn(),
    forageStorage: { isAccount: false },
    getFetchLogs: mocks.getFetchLogs,
}))
vi.mock('src/ts/gui/colorscheme', () => ({
    changeColorScheme: vi.fn(),
    updateColorScheme: vi.fn(),
    updateTextThemeAndCSS: vi.fn(),
}))
vi.mock('src/ts/platform', () => ({
    get isNodeServer() { return mocks.isNodeServer },
    isTauri: false,
}))
vi.mock('src/ts/runtime/pluginPermissionClient', () => ({
    RuntimePluginPermissionClient: class {
        resolve(...args: unknown[]) {
            return mocks.nodePermissionResolve(...args)
        }
    },
}))
vi.mock('src/ts/process/mcp/pluginmcp', () => ({
    registeredCustomPluginMCPs: mocks.registeredMCPs,
    registerMCPModule: vi.fn(async (arg: { identifier: string }) => {
        const client = { identifier: arg.identifier }
        mocks.registeredMCPs.set(arg.identifier, client)
        return client
    }),
    unregisterMCPModule: vi.fn(async (identifier: string) => {
        mocks.registeredMCPs.delete(identifier)
    }),
}))
vi.mock('src/ts/process/files/inlays', () => ({ getInlayAsset: vi.fn() }))
vi.mock('src/ts/translator/translator', () => ({
    getLLMCache: mocks.getLLMCache,
    searchLLMCache: mocks.searchLLMCache,
}))
vi.mock('src/ts/parser/parser.svelte', () => ({
    hasher: vi.fn(async (bytes: Uint8Array) => `hash:${new TextDecoder().decode(bytes)}`),
}))
vi.mock('localforage', () => ({
    default: {
        createInstance: () => ({
            getItem: async (key: string) => mocks.permissionStorage.get(key) ?? null,
            setItem: async (key: string, value: boolean | number) => {
                mocks.permissionStorage.set(key, value)
                return value
            },
            removeItem: async (key: string) => { mocks.permissionStorage.delete(key) },
        }),
    },
}))
vi.mock('src/ts/storage/nodeJsonKeyValueStorage', () => ({ NodeJsonKeyValueStorage: class {} }))
vi.mock('src/ts/model/types', () => ({
    LLMFlags: { hasFullSystemPrompt: 'hasFullSystemPrompt' },
    LLMFormat: { Plugin: 'Plugin' },
    LLMProvider: { AsIs: 'AsIs' },
    LLMTokenizer: { Unknown: 'Unknown' },
}))
vi.mock('src/ts/process/index.svelte', async () => {
    const { writable } = await import('svelte/store')
    return { sendChat: vi.fn(), doingChat: writable(false) }
})
vi.mock('src/ts/model/modellist', () => ({ getModelInfo: vi.fn() }))
vi.mock('src/ts/process/request/request', () => ({ requestChatDataMain: mocks.requestChatDataMain }))
vi.mock('src/ts/process/modules', () => ({ getModuleLorebooks: mocks.getModuleLorebooks }))
vi.mock('src/ts/process/ttsHooks', () => ({
    registerTTSPreprocessor: vi.fn(),
    unregisterTTSPreprocessor: vi.fn(),
    registerTTSPostprocessor: vi.fn(),
    unregisterTTSPostprocessor: vi.fn(),
}))

import {
    customV3ProviderMetaStore,
    executePluginV3,
    getV3PluginInstance,
    loadV3Plugins,
} from './v3.svelte'
import { customProviderStore } from '../plugins.svelte'

function plugin(name: string, script: string) {
    return {
        name,
        script,
        version: '3.0' as const,
        enabled: true,
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
    }
}

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>(resolvePromise => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

describe('V3 permission and lifecycle isolation', () => {
    beforeEach(async () => {
        await loadV3Plugins([])
        mocks.db.plugins.splice(0)
        mocks.db.characters = {}
        mocks.selectedCharID.set(-1)
        mocks.pluginV2.providers.clear()
        mocks.pluginV2.providerOptions.clear()
        mocks.pluginV2.replacerbeforeRequest.clear()
        mocks.pluginV2.replacerafterRequest.clear()
        customProviderStore.set([])
        customV3ProviderMetaStore.splice(0)
        mocks.registeredMCPs.clear()
        mocks.additionalSettingsMenu.splice(0)
        mocks.additionalFloatingActionButtons.splice(0)
        mocks.additionalHamburgerMenu.splice(0)
        mocks.additionalChatMenu.splice(0)
        mocks.bodyIntercepterStore.splice(0)
        mocks.chatPanelStore.splice(0)
        mocks.permissionStorage.clear()
        mocks.lifecycleEvents.splice(0)
        mocks.alertConfirm.mockReset()
        mocks.getFetchLogs.mockClear()
        mocks.oldApis.setDatabaseLite.mockReset()
        mocks.oldApis.setDatabase.mockReset()
        mocks.oldApis.getChar.mockReset()
        mocks.oldApis.setChar.mockReset()
        mocks.oldApis.loadPlugins.mockReset()
        mocks.searchLLMCache.mockReset()
        mocks.getLLMCache.mockReset()
        mocks.requestChatDataMain.mockReset()
        mocks.getModuleLorebooks.mockClear()
        mocks.oldApis.addRisuReplacer.mockClear()
        mocks.oldApis.removeRisuReplacer.mockClear()
        mocks.apiFactories.splice(0)
        mocks.terminatedApiFactories.splice(0)
        mocks.runHook = null
        mocks.isNodeServer = false
        mocks.nodePermissionResolve.mockReset()
    })

    afterEach(async () => {
        await loadV3Plugins([])
        vi.useRealTimers()
    })

    it('binds permissions to the loaded script and asks again only after reloading changed code', async () => {
        const fixture = plugin('permission-fixture', 'script-a')
        mocks.db.plugins.push(fixture)
        mocks.alertConfirm.mockResolvedValue(true)
        await executePluginV3(fixture)
        const api = mocks.apiFactories.at(-1)

        await expect(api.getFetchLogs()).resolves.toEqual([])
        await expect(api.getDatabase()).resolves.toEqual({ characters: {} })
        expect(mocks.alertConfirm).toHaveBeenNthCalledWith(1, 'fetchLogs:permission-fixture')
        expect(mocks.alertConfirm).toHaveBeenNthCalledWith(2, 'db:permission-fixture')

        fixture.script = 'script-b'
        await expect(api.getFetchLogs()).resolves.toEqual([])
        expect(mocks.alertConfirm).toHaveBeenCalledTimes(2)

        await loadV3Plugins([fixture])
        const reloadedApi = mocks.apiFactories.at(-1)
        await expect(reloadedApi.getFetchLogs()).resolves.toEqual([])
        expect(mocks.alertConfirm).toHaveBeenNthCalledWith(3, 'fetchLogs:permission-fixture')
    })

    it('delegates Node consent to the shared broker with exact principal and policy', async () => {
        mocks.isNodeServer = true
        mocks.nodePermissionResolve.mockResolvedValue(true)
        const fixture = plugin('node-permission-fixture', 'node-permission-script')
        mocks.db.plugins.push(fixture)
        await executePluginV3(fixture)
        const api = mocks.apiFactories.at(-1)

        await expect(api.getFetchLogs()).resolves.toEqual([])
        await expect(api.getDatabase()).resolves.toEqual({ characters: {} })
        expect(mocks.nodePermissionResolve).toHaveBeenNthCalledWith(
            1,
            {
                name: 'node-permission-fixture',
                scriptHash: 'hash:node-permission-script',
            },
            'fetchLogs',
            'persistent',
            'fetchLogs:node-permission-fixture',
            expect.any(AbortSignal),
        )
        expect(mocks.nodePermissionResolve).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ name: 'node-permission-fixture' }),
            'db',
            'periodically',
            'db:node-permission-fixture',
            expect.any(AbortSignal),
        )
        expect(mocks.alertConfirm).not.toHaveBeenCalled()
    })

    it('aborts a Node permission poll when its plugin is unloaded', async () => {
        mocks.isNodeServer = true
        mocks.nodePermissionResolve.mockImplementation(
            async (...args: unknown[]) => await new Promise<boolean>((_resolve, reject) => {
                const signal = args.at(-1) as AbortSignal
                signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            }),
        )
        const fixture = plugin('node-abort-fixture', 'node-abort-script')
        mocks.db.plugins.push(fixture)
        await executePluginV3(fixture)
        const api = mocks.apiFactories.at(-1)
        const pending = api.getDatabase()
        await vi.waitFor(() => expect(mocks.nodePermissionResolve).toHaveBeenCalledTimes(1))

        await loadV3Plugins([])
        await expect(pending).rejects.toThrow('PluginInactiveError')
        const signal = mocks.nodePermissionResolve.mock.calls[0].at(-1) as AbortSignal
        expect(signal.aborted).toBe(true)
        expect(mocks.alertConfirm).not.toHaveBeenCalled()
    })

    it('reconfirms an expired periodic permission in a long-lived process', async () => {
        const fixture = plugin('periodic-fixture', 'periodic-script')
        mocks.db.plugins.push(fixture)
        mocks.alertConfirm.mockResolvedValue(true)
        await executePluginV3(fixture)
        const api = mocks.apiFactories.at(-1)
        const callback = vi.fn(async () => ({ success: true, content: 'ok' }))
        api.addProvider('periodic-provider', callback)
        const provider = mocks.pluginV2.providers.get('periodic-provider')!

        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
        await expect(Promise.all([
            provider({ mode: 'test' }),
            provider({ mode: 'test' }),
        ])).resolves.toEqual([
            { success: true, content: 'ok' },
            { success: true, content: 'ok' },
        ])
        expect(mocks.alertConfirm).toHaveBeenCalledTimes(1)

        vi.setSystemTime(new Date('2026-01-05T00:00:00Z'))
        await expect(provider({ mode: 'test' })).resolves.toEqual({ success: true, content: 'ok' })
        expect(mocks.alertConfirm).toHaveBeenCalledTimes(2)
    })

    it('never invokes a provider callback after permission denial', async () => {
        const fixture = plugin('denied-provider-fixture', 'denied-provider-script')
        mocks.db.plugins.push(fixture)
        mocks.alertConfirm.mockResolvedValue(false)
        await executePluginV3(fixture)
        const api = mocks.apiFactories.at(-1)
        const callback = vi.fn(async () => ({ success: true, content: 'must-not-run' }))
        api.addProvider('denied-provider', callback)

        await expect(mocks.pluginV2.providers.get('denied-provider')!({ mode: 'test' }))
            .resolves.toEqual({
                success: false,
                content: 'Provider permission denied for plugin "denied-provider-fixture"',
            })
        expect(callback).not.toHaveBeenCalled()
    })

    it('blocks denied database and translation-cache APIs before reads or mutations', async () => {
        const fixture = plugin('denied-db-fixture', 'denied-db-script')
        const originalCharacters = {
            'character-a': {
                name: 'Original',
                chatPage: 0,
                globalLore: [{ key: 'character-lore' }],
                chats: [{ localLore: [{ key: 'chat-lore' }] }],
            },
        }
        mocks.db.characters = structuredClone(originalCharacters)
        mocks.db.plugins.push(fixture)
        mocks.alertConfirm.mockResolvedValue(false)
        await executePluginV3(fixture)
        const api = mocks.apiFactories.at(-1)

        await expect(api.getDatabase()).resolves.toBeNull()

        const deniedCalls = [
            () => api.getChar(),
            () => api.setChar({ name: 'Mutated through legacy alias' }),
            () => api.getCharacter(),
            () => api.setCharacter({ name: 'Mutated through new alias' }),
            () => api.setDatabaseLite({ characters: {} }),
            () => api.setDatabase({ characters: {} }),
            () => api.loadPlugins(),
            () => api.getCharacterFromIndex(0),
            () => api.setCharacterToIndex(0, { name: 'Mutated' }),
            () => api.getChatFromIndex(0, 0),
            () => api.setChatToIndex(0, 0, { message: ['mutated'] }),
            () => api.getCurrentCharacterIndex(),
            () => api.getCurrentChatIndex(),
            () => api.getCurrentLorebookEntries(),
            () => api.searchTranslationCache('secret'),
            () => api.getTranslationCache('secret-key'),
        ]

        for(const call of deniedCalls){
            await expect(call()).rejects.toMatchObject({
                name: 'PermissionDeniedError',
                message: expect.stringContaining('denied "db" permission'),
            })
        }

        expect(mocks.alertConfirm).toHaveBeenCalledTimes(1)
        expect(mocks.oldApis.setDatabaseLite).not.toHaveBeenCalled()
        expect(mocks.oldApis.setDatabase).not.toHaveBeenCalled()
        expect(mocks.oldApis.getChar).not.toHaveBeenCalled()
        expect(mocks.oldApis.setChar).not.toHaveBeenCalled()
        expect(mocks.oldApis.loadPlugins).not.toHaveBeenCalled()
        expect(mocks.searchLLMCache).not.toHaveBeenCalled()
        expect(mocks.getLLMCache).not.toHaveBeenCalled()
        expect(mocks.getModuleLorebooks).not.toHaveBeenCalled()
        expect(mocks.db.characters).toEqual(originalCharacters)
    })

    it('blocks runLLMModel before invoking the model requester when provider permission is denied', async () => {
        const fixture = plugin('denied-model-fixture', 'denied-model-script')
        mocks.db.plugins.push(fixture)
        mocks.alertConfirm.mockResolvedValue(false)
        await executePluginV3(fixture)
        const api = mocks.apiFactories.at(-1)

        await expect(api.runLLMModel({
            mode: 'model',
            messages: [{ role: 'user', content: 'must not be sent' }],
        })).rejects.toMatchObject({
            name: 'PermissionDeniedError',
            message: expect.stringContaining('denied "provider" permission'),
        })
        expect(mocks.requestChatDataMain).not.toHaveBeenCalled()
    })

    it('preserves the protected database, cache, and model APIs after consent', async () => {
        const fixture = plugin('allowed-guard-fixture', 'allowed-guard-script')
        const character = {
            name: 'Allowed',
            chatPage: 0,
            globalLore: [{ key: 'character-lore' }],
            chats: [{ localLore: [{ key: 'chat-lore' }] }],
        }
        mocks.db.characters = { 'character-a': character }
        mocks.db.plugins.push(fixture)
        mocks.selectedCharID.set('character-a')
        mocks.alertConfirm.mockResolvedValue(true)
        mocks.searchLLMCache.mockResolvedValue([{ key: 'cache-key', value: 'translation' }])
        mocks.getLLMCache.mockResolvedValue('translation')
        mocks.getModuleLorebooks.mockReturnValue([{ key: 'module-lore' }])
        mocks.requestChatDataMain.mockResolvedValue('model-result')
        mocks.oldApis.getChar.mockReturnValue(character)
        await executePluginV3(fixture)
        const api = mocks.apiFactories.at(-1)

        await expect(api.getChar()).resolves.toEqual(character)
        await expect(api.setChar({ name: 'Legacy update' })).resolves.toBeUndefined()
        await expect(api.getCharacter()).resolves.toEqual(character)
        await expect(api.setCharacter({ name: 'New update' })).resolves.toBeUndefined()
        await expect(api.setDatabaseLite({ characters: {} })).resolves.toBeUndefined()
        await expect(api.setDatabase({ characters: {} })).resolves.toBeUndefined()
        await expect(api.loadPlugins()).resolves.toBeUndefined()
        await expect(api.getCharacterFromIndex(0)).resolves.toEqual(character)
        await expect(api.getChatFromIndex(0, 0)).resolves.toEqual(character.chats[0])
        await expect(api.getCurrentCharacterIndex()).resolves.toBe('character-a')
        await expect(api.getCurrentChatIndex()).resolves.toBe(0)
        await expect(api.getCurrentLorebookEntries()).resolves.toEqual([
            { key: 'character-lore' },
            { key: 'chat-lore' },
            { key: 'module-lore' },
        ])
        await expect(api.searchTranslationCache('cache')).resolves.toEqual([
            { key: 'cache-key', value: 'translation' },
        ])
        await expect(api.getTranslationCache('cache-key')).resolves.toBe('translation')
        await expect(api.runLLMModel({
            mode: 'model',
            messages: [{ role: 'user', content: 'allowed' }],
        })).resolves.toBe('model-result')

        expect(mocks.oldApis.setDatabaseLite).toHaveBeenCalledWith({ characters: {} })
        expect(mocks.oldApis.setDatabase).toHaveBeenCalledWith({ characters: {} })
        expect(mocks.oldApis.getChar).toHaveBeenCalledTimes(2)
        expect(mocks.oldApis.setChar).toHaveBeenNthCalledWith(1, { name: 'Legacy update' })
        expect(mocks.oldApis.setChar).toHaveBeenNthCalledWith(2, { name: 'New update' })
        expect(mocks.oldApis.loadPlugins).toHaveBeenCalledTimes(1)
        expect(mocks.searchLLMCache).toHaveBeenCalledWith('cache')
        expect(mocks.getLLMCache).toHaveBeenCalledWith('cache-key')
        expect(mocks.requestChatDataMain).toHaveBeenCalledTimes(1)
        expect(mocks.alertConfirm).toHaveBeenCalledTimes(2)
    })

    it('rejects overlapping plugin reloads and releases the guard after completion', async () => {
        const fixture = plugin('reload-guard-fixture', 'reload-guard-script')
        mocks.db.plugins.push(fixture)
        mocks.alertConfirm.mockResolvedValue(true)
        let finishReload!: () => void
        const pendingReload = new Promise<void>((resolve) => {
            finishReload = resolve
        })
        mocks.oldApis.loadPlugins.mockReturnValueOnce(pendingReload)
        await executePluginV3(fixture)
        const api = mocks.apiFactories.at(-1)

        const firstReload = api.loadPlugins()
        await vi.waitFor(() => expect(mocks.oldApis.loadPlugins).toHaveBeenCalledTimes(1))
        await expect(api.loadPlugins()).rejects.toThrow(
            'PluginReloadInProgressError: A plugin reload is already in progress.',
        )
        expect(mocks.oldApis.loadPlugins).toHaveBeenCalledTimes(1)

        finishReload()
        await expect(firstReload).resolves.toBeUndefined()
        await expect(api.loadPlugins()).resolves.toBeUndefined()
        expect(mocks.oldApis.loadPlugins).toHaveBeenCalledTimes(2)
    })

    it('removes the old V3 replacer before terminating and reloading its sandbox', async () => {
        const fixture = plugin('replacer-fixture', 'replacer-script')
        mocks.db.plugins.push(fixture)
        mocks.alertConfirm.mockResolvedValue(true)
        const callbacks: ReturnType<typeof vi.fn>[] = []
        mocks.runHook = async (api) => {
            const callback = vi.fn(async (value: unknown) => value)
            callbacks.push(callback)
            await api.addRisuReplacer('beforeRequest', callback)
        }

        await loadV3Plugins([fixture])
        const first = [...mocks.pluginV2.replacerbeforeRequest][0]
        expect(mocks.pluginV2.replacerbeforeRequest.size).toBe(1)

        await loadV3Plugins([fixture])
        const second = [...mocks.pluginV2.replacerbeforeRequest][0]
        expect(mocks.pluginV2.replacerbeforeRequest.size).toBe(1)
        expect(second).not.toBe(first)
        expect(mocks.terminatedApiFactories).toHaveLength(1)
        expect(mocks.lifecycleEvents.slice(0, 2)).toEqual([
            'remove:beforeRequest',
            'terminate',
        ])

        await second('payload')
        expect(callbacks[0]).not.toHaveBeenCalled()
        expect(callbacks[1]).toHaveBeenCalledWith('payload')
    })

    it('waits for every concurrent initialization and atomically removes a failed plugin scope', async () => {
        const failed = plugin('fast-failure', 'fast-failure-script')
        const successful = plugin('delayed-success', 'delayed-success-script')
        mocks.db.plugins.push(failed, successful)
        const releaseSuccess = deferred()
        const successRegistered = deferred()
        const failedUnload = vi.fn()
        const inactiveRegistrationErrors: unknown[] = []
        const successfulSharedProvider = vi.fn(async () => ({
            success: true,
            content: 'successful shared provider',
        }))
        mocks.alertConfirm.mockResolvedValue(true)

        mocks.runHook = async (api, script) => {
            if(script === failed.script){
                await successRegistered.promise
                api.addProvider('failed-provider', vi.fn(), {
                    model: { name: 'Failed model' },
                })
                api.addProvider('shared-provider', vi.fn(async () => ({
                    success: true,
                    content: 'stale failed provider',
                })))
                api.setChatPanel('<p>stale panel</p>')
                await api.registerMCP(
                    {
                        identifier: 'plugin:failed-tools',
                        name: 'Failed tools',
                        version: '1.0.0',
                        description: 'must be removed',
                    },
                    vi.fn(),
                    vi.fn(),
                )
                api.onUnload(() => {
                    failedUnload()
                    try {
                        api.addProvider('resurrected-provider', vi.fn())
                    }
                    catch(error){
                        inactiveRegistrationErrors.push(error)
                    }
                })
                throw new Error('fast initialization failure')
            }

            api.addProvider('shared-provider', successfulSharedProvider)
            successRegistered.resolve()
            await releaseSuccess.promise
            api.addProvider('successful-provider', vi.fn(), {
                model: { name: 'Successful model' },
            })
        }

        let loadSettled = false
        const loading = loadV3Plugins([failed, successful]).finally(() => {
            loadSettled = true
        })

        await vi.waitFor(() => expect(failedUnload).toHaveBeenCalledTimes(1))
        expect(getV3PluginInstance(failed.name)).toBeUndefined()
        expect(loadSettled).toBe(false)
        expect(getV3PluginInstance(successful.name)).toBeDefined()
        expect(mocks.pluginV2.providers.has('failed-provider')).toBe(false)
        expect(mocks.pluginV2.providers.has('resurrected-provider')).toBe(false)
        expect(customV3ProviderMetaStore.some(model => model.id === 'pluginmodel:::failed-provider')).toBe(false)
        expect(mocks.chatPanelStore).toEqual([])
        expect(mocks.registeredMCPs.has('plugin:failed-tools')).toBe(false)
        expect(failedUnload).toHaveBeenCalledTimes(1)
        expect(inactiveRegistrationErrors).toEqual([
            expect.objectContaining({
                message: expect.stringContaining('PluginInactiveError'),
            }),
        ])

        releaseSuccess.resolve()
        await expect(loading).rejects.toThrow('fast initialization failure')
        expect(loadSettled).toBe(true)
        expect(getV3PluginInstance(successful.name)).toBeDefined()
        expect(mocks.pluginV2.providers.has('successful-provider')).toBe(true)
        expect(customV3ProviderMetaStore.some(model => model.id === 'pluginmodel:::successful-provider')).toBe(true)
        await expect(mocks.pluginV2.providers.get('shared-provider')!({ mode: 'test' }))
            .resolves.toEqual({
                success: true,
                content: 'successful shared provider',
            })
        expect(successfulSharedProvider).toHaveBeenCalledTimes(1)
        expect(document.body.querySelectorAll('iframe')).toHaveLength(1)
    })

    it('allows unregisterMCP to remove only a registration owned by the active scope', async () => {
        const fixture = plugin('mcp-owner', 'mcp-owner-script')
        mocks.db.plugins.push(fixture)
        const externalClient = { identifier: 'plugin:shared-owner-tools', external: true }
        mocks.registeredMCPs.set('plugin:shared-owner-tools', externalClient)
        await executePluginV3(fixture)
        const api = mocks.apiFactories.at(-1)

        await expect(api.unregisterMCP('plugin:shared-owner-tools')).rejects.toThrow(
            'PluginMCPRegistrationOwnershipError',
        )
        expect(mocks.registeredMCPs.get('plugin:shared-owner-tools')).toBe(externalClient)

        await api.registerMCP(
            {
                identifier: 'plugin:shared-owner-tools',
                name: 'Owned tools',
                version: '1.0.0',
                description: 'temporary owned registration',
            },
            vi.fn(),
            vi.fn(),
        )
        expect(mocks.registeredMCPs.get('plugin:shared-owner-tools')).not.toBe(externalClient)
        await api.unregisterMCP('plugin:shared-owner-tools')
        expect(mocks.registeredMCPs.get('plugin:shared-owner-tools')).toBe(externalClient)

        await loadV3Plugins([])
        await expect(api.unregisterMCP('plugin:shared-owner-tools')).rejects.toThrow(
            'PluginInactiveError',
        )
        expect(mocks.registeredMCPs.get('plugin:shared-owner-tools')).toBe(externalClient)
    })

    it('unloads same-name providers by registration ownership rather than instance order', async () => {
        const firstInstance = plugin('first-instance', 'first-instance-script')
        const secondInstance = plugin('second-instance', 'second-instance-script')
        mocks.db.plugins.push(firstInstance, secondInstance)
        mocks.alertConfirm.mockResolvedValue(true)
        const secondRegistered = deferred()
        const firstProvider = vi.fn(async () => ({ success: true, content: 'first wins' }))
        const secondProvider = vi.fn(async () => ({ success: true, content: 'second registered first' }))

        mocks.runHook = async (api, script) => {
            if(script === firstInstance.script){
                await secondRegistered.promise
                api.addProvider('shared-interleaved-provider', firstProvider)
                api.addProvider('first-distinct-provider', vi.fn())
                await api.registerMCP(
                    {
                        identifier: 'plugin:shared-interleaved-tools',
                        name: 'First tools',
                        version: '1.0.0',
                        description: 'registered second',
                    },
                    vi.fn(),
                    vi.fn(),
                )
                return
            }
            api.addProvider('shared-interleaved-provider', secondProvider)
            api.addProvider('second-distinct-provider', vi.fn())
            await api.registerMCP(
                {
                    identifier: 'plugin:shared-interleaved-tools',
                    name: 'Second tools',
                    version: '1.0.0',
                    description: 'registered first',
                },
                vi.fn(),
                vi.fn(),
            )
            secondRegistered.resolve()
        }

        await loadV3Plugins([firstInstance, secondInstance])
        expect(get(customProviderStore)).toEqual(expect.arrayContaining([
            'shared-interleaved-provider',
            'first-distinct-provider',
            'second-distinct-provider',
        ]))
        await expect(mocks.pluginV2.providers.get('shared-interleaved-provider')!({ mode: 'test' }))
            .resolves.toEqual({ success: true, content: 'first wins' })
        expect(firstProvider).toHaveBeenCalledTimes(1)
        expect(secondProvider).not.toHaveBeenCalled()
        expect(mocks.registeredMCPs.has('plugin:shared-interleaved-tools')).toBe(true)

        await loadV3Plugins([])
        expect(mocks.pluginV2.providers.has('shared-interleaved-provider')).toBe(false)
        expect(mocks.pluginV2.providers.has('first-distinct-provider')).toBe(false)
        expect(mocks.pluginV2.providers.has('second-distinct-provider')).toBe(false)
        expect(mocks.registeredMCPs.has('plugin:shared-interleaved-tools')).toBe(false)
        const unloadedProviderNames = new Set([
            'shared-interleaved-provider',
            'first-distinct-provider',
            'second-distinct-provider',
        ])
        expect(get(customProviderStore).filter(name => unloadedProviderNames.has(name))).toEqual([])
    })

    it('reserves a plugin name before asynchronous hashing prevents duplicate instances', async () => {
        const first = plugin('duplicate-name', 'first-script')
        const duplicate = plugin('duplicate-name', 'duplicate-script')
        mocks.db.plugins.push(first, duplicate)
        const releaseFirst = deferred()
        mocks.runHook = async (_api, script) => {
            if(script === first.script){
                await releaseFirst.promise
            }
        }

        const loading = loadV3Plugins([first, duplicate])
        await vi.waitFor(() => expect(mocks.apiFactories).toHaveLength(1))
        releaseFirst.resolve()
        await loading

        expect(getV3PluginInstance('duplicate-name')).toBeDefined()
        expect(mocks.apiFactories).toHaveLength(1)
    })
})
