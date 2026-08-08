import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    db: {
        plugins: [],
        pluginCustomStorage: {},
        characters: [],
    } as Record<string, any>,
    runtimeAlert: vi.fn(),
    runtimePrompt: vi.fn(),
}))

vi.mock('../../lang', () => ({ language: {} }))
vi.mock('../storage/database.svelte', () => ({
    getCurrentCharacter: vi.fn(() => null),
    getDatabase: vi.fn(() => mocks.db),
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
}))
vi.mock('../alert', () => ({
    alertConfirm: vi.fn(),
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
    fetchNative: vi.fn(),
    globalFetch: vi.fn(),
    readImage: vi.fn(),
    saveAsset: vi.fn(),
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
    hasher: vi.fn(async () => 'fixture-v21-hash'),
}))
vi.mock('./pluginSafeClass', () => ({
    SafeDocument: {},
    SafeIdbFactory: {},
    SafeLocalStorage: class SafeLocalStorage {},
}))
vi.mock('./apiV3/v3.svelte', () => ({ loadV3Plugins: vi.fn() }))
vi.mock('./apiV3/transpiler', () => ({ pluginCodeTranspiler: vi.fn() }))

import { loadV2Plugin, pluginV2 } from './plugins.svelte'

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
        mocks.runtimeAlert.mockReset().mockResolvedValue(undefined)
        mocks.runtimePrompt.mockReset()
        pluginV2.providers.clear()
        pluginV2.providerOptions.clear()
        pluginV2.replacerbeforeRequest.clear()
        pluginV2.replacerafterRequest.clear()
        pluginV2.loaded = false
    })

    afterEach(() => {
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
})
