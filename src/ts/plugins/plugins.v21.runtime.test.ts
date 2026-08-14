import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    db: {
        plugins: [],
        pluginCustomStorage: {},
        characters: [],
    } as Record<string, any>,
    runtimeAlert: vi.fn(),
    runtimePrompt: vi.fn(),
    alertConfirm: vi.fn(),
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
    fetchNative: vi.fn(),
    globalFetch: vi.fn(),
    readImage: vi.fn(),
    saveAsset: vi.fn(),
    safeLocalStorageSetItem: vi.fn(),
    safeIdbOpen: vi.fn(),
    safeDocumentCreateElement: vi.fn(),
}))

vi.mock('../../lang', () => ({
    language: { confirmInstallPluginViaPlugin: 'Install {plugin}?' },
}))
vi.mock('../storage/database.svelte', () => ({
    getCurrentCharacter: vi.fn(() => null),
    getDatabase: vi.fn(() => mocks.db),
    setDatabase: mocks.setDatabase,
    setDatabaseLite: mocks.setDatabaseLite,
}))
vi.mock('../alert', () => ({
    alertConfirm: mocks.alertConfirm,
    alertError: vi.fn(),
    alertPluginConfirm: vi.fn(),
    runtimeAlertGlobals: {
        alert: mocks.runtimeAlert,
        confirm: vi.fn(async () => true),
        prompt: mocks.runtimePrompt,
    },
}))
vi.mock('../util', () => ({
    selectSingleFile: vi.fn(),
    sleep: vi.fn(async () => undefined),
}))
vi.mock('../globalApi.svelte', () => ({
    fetchNative: mocks.fetchNative,
    globalFetch: mocks.globalFetch,
    readImage: mocks.readImage,
    saveAsset: mocks.saveAsset,
    toGetter: (getter: () => unknown) => getter(),
}))
vi.mock('../stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        DBState: { db: mocks.db },
        hotReloading: writable(false),
        pluginAlertModalStore: writable(null),
        selectedCharID: writable(-1),
    }
})
vi.mock('../parser/parser.svelte', () => ({
    hasher: vi.fn(async (data: Uint8Array) => `fixture-v21-hash:${new TextDecoder().decode(data)}`),
}))
vi.mock('./pluginSafeClass', () => ({
    SafeDocument: {
        createElement: mocks.safeDocumentCreateElement,
    },
    SafeIdbFactory: {
        open: mocks.safeIdbOpen,
    },
    SafeLocalStorage: class SafeLocalStorage {
        setItem(key: string, value: string) {
            return mocks.safeLocalStorageSetItem(key, value)
        }
    },
}))
vi.mock('./apiV3/v3.svelte', () => ({ loadV3Plugins: vi.fn() }))
vi.mock('./apiV3/transpiler', () => ({ pluginCodeTranspiler: vi.fn() }))

import { loadPlugins, loadV2Plugin, pluginV2 } from './plugins.svelte'

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

describe('V2.1 resident low-level compatibility fixture', () => {
    beforeEach(() => {
        localStorage.clear()
        mocks.db.plugins = []
        mocks.db.pluginCustomStorage = {}
        mocks.db.characters = []
        mocks.runtimeAlert.mockReset().mockResolvedValue(undefined)
        mocks.runtimePrompt.mockReset()
        mocks.alertConfirm.mockReset().mockResolvedValue(false)
        mocks.setDatabase.mockReset()
        mocks.setDatabaseLite.mockReset()
        mocks.fetchNative.mockReset()
        mocks.globalFetch.mockReset()
        mocks.readImage.mockReset()
        mocks.saveAsset.mockReset()
        mocks.safeLocalStorageSetItem.mockReset()
        mocks.safeIdbOpen.mockReset()
        mocks.safeDocumentCreateElement.mockReset()
        pluginV2.providers.clear()
        pluginV2.providerOptions.clear()
        pluginV2.replacerbeforeRequest.clear()
        pluginV2.replacerafterRequest.clear()
        pluginV2.unload.clear()
        pluginV2.loaded = false
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it('rewrites a low-level alert global and registers provider/replacer hooks', async () => {
        const fixture = {
            name: 'fixture-v21',
            version: '2.1' as const,
            enabled: true,
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            script: `
                const relayValue = 'phone-secret'
                addProvider('fixture-provider', async (arg, signal) => {
                    await globalThis.alert('Provider ' + arg.mode)
                    return {
                        success: true,
                        content: relayValue + ':' + arg.mode + ':' + signal.aborted
                    }
                }, { tokenizer: 'fixture-tokenizer' })
                addRisuReplacer('beforeRequest', async (chat, type) => [
                    ...chat,
                    { role: 'system', content: relayValue + ':' + type }
                ])
            `,
        }

        await loadV2Plugin([fixture])

        const alert = deferred<void>()
        mocks.runtimeAlert.mockReturnValueOnce(alert.promise)
        const controller = new AbortController()
        const provider = pluginV2.providers.get('fixture-provider')!
        let providerSettled = false
        const pendingProvider = provider({ mode: 'resident' } as never, controller.signal)
            .then((value) => {
                providerSettled = true
                return value
            })
        await vi.waitFor(() => expect(mocks.runtimeAlert).toHaveBeenCalledWith(
            'Provider resident',
        ))
        expect(providerSettled).toBe(false)
        alert.resolve()
        await expect(pendingProvider).resolves.toEqual({
            success: true,
            content: 'phone-secret:resident:false',
        })
        expect(pluginV2.providerOptions.get('fixture-provider')).toEqual({
            tokenizer: 'fixture-tokenizer',
        })

        const replacer = [...pluginV2.replacerbeforeRequest][0]
        await expect(replacer([
            { role: 'user', content: 'hello' },
        ] as never, 'prompt')).resolves.toEqual([
            { role: 'user', content: 'hello' },
            { role: 'system', content: 'phone-secret:prompt' },
        ])
    })

    it('bridges top-level awaited prompt/alert without invoking native dialogs', async () => {
        const prompt = deferred<string>()
        const alert = deferred<void>()
        mocks.runtimePrompt.mockReturnValueOnce(prompt.promise)
        mocks.runtimeAlert.mockReturnValueOnce(alert.promise)
        const nativePrompt = vi.fn()
        const nativeAlert = vi.fn()
        vi.stubGlobal('prompt', nativePrompt)
        vi.stubGlobal('alert', nativeAlert)

        const pending = loadV2Plugin([{
            name: 'fixture-v21-top-level-await',
            version: '2.1',
            enabled: true,
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            script: `
                const relayValue = await globalThis.prompt('Provider key', 'seed')
                await globalThis.alert('Loaded ' + relayValue)
                addProvider('fixture-awaited-provider', async () => ({
                    success: true,
                    content: relayValue
                }))
            `,
        }])

        await vi.waitFor(() => expect(mocks.runtimePrompt).toHaveBeenCalledWith(
            'Provider key',
            'seed',
        ))
        expect(pluginV2.providers.has('fixture-awaited-provider')).toBe(false)

        prompt.resolve('bridge-secret')
        await vi.waitFor(() => expect(mocks.runtimeAlert).toHaveBeenCalledWith(
            'Loaded bridge-secret',
        ))
        expect(pluginV2.providers.has('fixture-awaited-provider')).toBe(false)

        alert.resolve()
        await pending
        expect(nativePrompt).not.toHaveBeenCalled()
        expect(nativeAlert).not.toHaveBeenCalled()
        await expect(pluginV2.providers.get('fixture-awaited-provider')!({} as never))
            .resolves.toEqual({
                success: true,
                content: 'bridge-secret',
            })
    })

    it('replaces request replacers instead of accumulating them across reloads', async () => {
        const fixture = {
            name: 'fixture-v21-reload',
            version: '2.1' as const,
            enabled: true,
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            script: `
                addRisuReplacer('beforeRequest', async (chat) => chat)
                addRisuReplacer('afterRequest', async (content) => content)
            `,
        }

        await loadV2Plugin([fixture])
        expect(pluginV2.replacerbeforeRequest.size).toBe(1)
        expect(pluginV2.replacerafterRequest.size).toBe(1)

        await loadV2Plugin([fixture])
        expect(pluginV2.replacerbeforeRequest.size).toBe(1)
        expect(pluginV2.replacerafterRequest.size).toBe(1)

        await loadV2Plugin([])
        expect(pluginV2.replacerbeforeRequest.size).toBe(0)
        expect(pluginV2.replacerafterRequest.size).toBe(0)
    })

    it('rolls back only registrations from a plugin that throws during initialization', async () => {
        const successful = {
            name: 'successful-v21',
            version: '2.1' as const,
            enabled: true,
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            script: `
                addProvider('shared-provider', async () => ({
                    success: true,
                    content: 'successful-provider'
                }), { tokenizer: 'successful-tokenizer' })
                addRisuReplacer('beforeRequest', async (chat) => chat)
                onUnload(() => setArg('successful-v21::unloaded', 1))
            `,
        }
        const failing = {
            name: 'failing-v21',
            version: '2.1' as const,
            enabled: true,
            arguments: {},
            realArg: { unloaded: 0 },
            customLink: [],
            argMeta: {},
            script: `
                addProvider('shared-provider', async () => ({
                    success: true,
                    content: 'stale-failed-provider'
                }), { tokenizer: 'stale-tokenizer' })
                addRisuReplacer('afterRequest', async (content) => content)
                onUnload(() => setArg('failing-v21::unloaded', 1))
                throw new Error('fixture initialization failed')
            `,
        }
        mocks.db.plugins = [successful, failing]
        const consoleLog = vi.spyOn(console, 'log')

        await loadV2Plugin([successful, failing])

        await expect(pluginV2.providers.get('shared-provider')!({} as never))
            .resolves.toEqual({
                success: true,
                content: 'successful-provider',
            })
        expect(pluginV2.providerOptions.get('shared-provider')).toEqual({
            tokenizer: 'successful-tokenizer',
        })
        expect(pluginV2.replacerbeforeRequest.size).toBe(1)
        expect(pluginV2.replacerafterRequest.size).toBe(0)
        expect(pluginV2.unload.size).toBe(1)
        // Failed scopes are revoked before onUnload callbacks run; cleanup is
        // invoked, but it cannot mutate canonical plugin arguments.
        expect(failing.realArg.unloaded).toBe(0)
        expect(consoleLog).toHaveBeenCalledWith('Loaded V2.1 Plugin', successful.name)
        expect(consoleLog).not.toHaveBeenCalledWith('Loaded V2.1 Plugin', failing.name)
        consoleLog.mockRestore()
    })

    it('fails a top-level reentrant loadPlugins call inside the active load transaction', async () => {
        const fixture = {
            name: 'reentrant-load-v21',
            version: '2.1' as const,
            enabled: true,
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            script: `
                addProvider('must-roll-back', async () => ({
                    success: true,
                    content: 'stale'
                }))
                await loadPlugins()
                addProvider('must-never-register', async () => ({
                    success: true,
                    content: 'stale'
                }))
            `,
        }
        mocks.db.plugins = [fixture]
        vi.stubGlobal('safeStructuredClone', (value: unknown) => structuredClone(value))
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

        await expect(loadPlugins()).resolves.toBeUndefined()

        expect(pluginV2.providers.has('must-roll-back')).toBe(false)
        expect(pluginV2.providers.has('must-never-register')).toBe(false)
        expect(consoleError.mock.calls.flat(Infinity).join(' ')).toContain(
            'PluginReloadInProgressError',
        )
        consoleError.mockRestore()
    })

    it('fences a timed-out plugin from registering after its awaited work resumes', async () => {
        vi.useFakeTimers()
        const fixture = {
            name: 'timed-out-v21',
            version: '2.1' as const,
            enabled: true,
            arguments: {},
            realArg: { lateMutation: 0 },
            customLink: [],
            argMeta: {},
            script: `
                const getScopedGlobal = SafeFunction()
                const capturedDatabase = Risuai.getDatabase()
                const reflectedLocalStorageSetItem = Object.getOwnPropertyDescriptor(
                    Object.getPrototypeOf(safeLocalStorage),
                    'setItem'
                ).value
                await new Promise(resolve => globalThis.setTimeout(resolve, 61_000))
                const attempts = [
                    () => setChar({ name: 'late character mutation' }),
                    () => setDatabaseLite({ temperature: 999 }),
                    () => setDatabase({ temperature: 999 }),
                    () => setArg('timed-out-v21::lateMutation', 1),
                    () => saveAsset(new Uint8Array([1, 2, 3])),
                    () => readImage('assets/late.png'),
                    () => risuFetch('https://example.com/late'),
                    () => nativeFetch('https://example.com/late'),
                    () => safeLocalStorage.setItem('late', 'mutation'),
                    () => reflectedLocalStorageSetItem.call(safeLocalStorage, 'late', 'reflected-mutation'),
                    () => safeIdbFactory.open('late'),
                    () => safeDocument.createElement('div'),
                    () => Risuai.pluginStorage.setItem('late', 'mutation'),
                    () => { capturedDatabase.temperature = 999 },
                    () => globalThis.localStorage.setItem('late', 'mutation'),
                    () => globalThis.indexedDB.open('late'),
                    () => globalThis.document.createElement('div'),
                    () => getScopedGlobal().__pluginApis__.addProvider(
                        'late-provider',
                        async () => ({ success: true, content: 'late' })
                    )
                ]
                for (const attempt of attempts) {
                    try { attempt() } catch (_) {}
                }
                console.log('__timed_out_v21_attempts_finished__')
            `,
        }
        mocks.db.plugins = [fixture]
        mocks.db.temperature = 1
        const consoleLog = vi.spyOn(console, 'log')
        const loading = loadV2Plugin([fixture])

        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(60_000)
        await loading
        expect(pluginV2.providers.has('late-provider')).toBe(false)

        await vi.advanceTimersByTimeAsync(1_000)
        await Promise.resolve()
        expect(consoleLog).toHaveBeenCalledWith('__timed_out_v21_attempts_finished__')
        expect(pluginV2.providers.has('late-provider')).toBe(false)
        expect(mocks.setDatabaseLite).not.toHaveBeenCalled()
        expect(mocks.setDatabase).not.toHaveBeenCalled()
        expect(mocks.globalFetch).not.toHaveBeenCalled()
        expect(mocks.fetchNative).not.toHaveBeenCalled()
        expect(mocks.saveAsset).not.toHaveBeenCalled()
        expect(mocks.readImage).not.toHaveBeenCalled()
        expect(mocks.safeLocalStorageSetItem).not.toHaveBeenCalled()
        expect(mocks.safeIdbOpen).not.toHaveBeenCalled()
        expect(mocks.safeDocumentCreateElement).not.toHaveBeenCalled()
        expect(fixture.realArg.lateMutation).toBe(0)
        expect(mocks.db.temperature).toBe(1)
        expect(mocks.db.pluginCustomStorage).toEqual({})
        expect(localStorage.getItem('late')).toBeNull()
        consoleLog.mockRestore()
    })

    it('fences the database commit when an install confirmation resolves after timeout', async () => {
        vi.useFakeTimers()
        const confirmation = deferred<boolean>()
        mocks.alertConfirm.mockReturnValueOnce(confirmation.promise)
        const latePlugin = {
            name: 'late-installed-v3',
            version: '3.0',
            enabled: true,
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            script: 'console.log("late plugin")',
        }
        const fixture = {
            name: 'timed-out-database-v21',
            version: '2.1' as const,
            enabled: true,
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            script: `
                try {
                    await setDatabase({
                        plugins: [${JSON.stringify(latePlugin)}],
                        temperature: 999
                    })
                } catch (_) {
                    console.log('__late_database_commit_fenced__')
                }
            `,
        }
        mocks.db.plugins = [fixture]
        mocks.db.temperature = 1
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const consoleLog = vi.spyOn(console, 'log')

        const loading = loadV2Plugin([fixture])
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.alertConfirm).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(60_000)
        await loading

        confirmation.resolve(true)
        await vi.advanceTimersByTimeAsync(0)
        await Promise.resolve()

        expect(consoleLog).toHaveBeenCalledWith('__late_database_commit_fenced__')
        expect(mocks.db.plugins).toEqual([fixture])
        expect(mocks.db.temperature).toBe(1)
        expect(mocks.db.pluginCustomStorage).toEqual({})
        expect(mocks.setDatabase).not.toHaveBeenCalled()
        consoleLog.mockRestore()
        consoleError.mockRestore()
    })

    it('commits a database update while the plugin remains active', async () => {
        const fixture = {
            name: 'active-database-v21',
            version: '2.1' as const,
            enabled: true,
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            script: `
                await setDatabase({
                    temperature: 7,
                    fixtureCustomValue: 'saved'
                })
            `,
        }
        mocks.db.plugins = [fixture]
        mocks.db.temperature = 1

        await loadV2Plugin([fixture])

        expect(mocks.db.temperature).toBe(7)
        expect(mocks.db.pluginCustomStorage).toEqual({ fixtureCustomValue: 'saved' })
        expect(mocks.setDatabase).toHaveBeenCalledOnce()
        expect(mocks.setDatabase).toHaveBeenCalledWith(mocks.db)
    })

    it('continues normal reload cleanup when an unload callback throws or self-registers', async () => {
        const staleUnload = vi.fn()
        pluginV2.loaded = true
        pluginV2.providers.set('old-provider', vi.fn() as never)
        pluginV2.unload.add(() => {
            pluginV2.unload.add(staleUnload)
            throw new Error('broken unload callback')
        })

        await expect(loadV2Plugin([])).resolves.toBeUndefined()
        expect(pluginV2.providers.size).toBe(0)
        expect(pluginV2.unload.size).toBe(0)
        expect(staleUnload).not.toHaveBeenCalled()
    })

    it('keeps cleanup capabilities usable during normal unload but rejects new registrations', async () => {
        const fixture = {
            name: 'normal-unload-v21',
            version: '2.1' as const,
            enabled: true,
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            script: `
                onUnload(() => {
                    safeLocalStorage.setItem('cleanup', 'completed')
                    try {
                        onUnload(() => console.log('__stale_unload__'))
                    } catch (_) {
                        console.log('__unload_callback_registration_rejected__')
                    }
                    try {
                        addProvider('stale-unload-provider', async () => ({
                            success: true,
                            content: 'stale'
                        }))
                    } catch (_) {
                        console.log('__unload_provider_registration_rejected__')
                    }
                    try {
                        setDatabase({ temperature: 999 })
                    } catch (_) {
                        console.log('__unload_database_commit_rejected__')
                    }
                })
            `,
        }

        mocks.db.temperature = 1
        const consoleLog = vi.spyOn(console, 'log')
        await loadV2Plugin([fixture])
        await loadV2Plugin([])

        expect(mocks.safeLocalStorageSetItem).toHaveBeenCalledOnce()
        expect(mocks.safeLocalStorageSetItem).toHaveBeenCalledWith('cleanup', 'completed')
        expect(consoleLog).toHaveBeenCalledWith('__unload_callback_registration_rejected__')
        expect(consoleLog).toHaveBeenCalledWith('__unload_provider_registration_rejected__')
        expect(consoleLog).toHaveBeenCalledWith('__unload_database_commit_rejected__')
        expect(pluginV2.providers.has('stale-unload-provider')).toBe(false)
        expect(pluginV2.unload.size).toBe(0)
        expect(mocks.db.temperature).toBe(1)
        expect(mocks.setDatabase).not.toHaveBeenCalled()
        consoleLog.mockRestore()
    })
})
