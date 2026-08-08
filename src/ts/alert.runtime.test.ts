import { get, type Writable } from 'svelte/store'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    alertStore: null as Writable<Record<string, unknown>> | null,
}))

vi.mock('./stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    const alertStore = writable({ type: 'none', msg: '' })
    mocks.alertStore = alertStore
    return { alertStore }
})

vi.mock('./storage/database.svelte', () => ({
    getDatabase: () => ({ usePlainFetch: false }),
}))

vi.mock('./util', () => ({
    sleep: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}))

vi.mock('../lang', () => ({
    language: {
        addCharacter: 'Add character',
        chatOptions: 'Chat options',
        errors: {
            networkFetchPlain: 'plain',
            networkFetchWeb: 'web',
            networkFetch: 'node',
        },
    },
}))

vi.mock('./platform', () => ({
    isTauri: false,
    isNodeServer: true,
}))

import {
    alertConfirm,
    alertError,
    alertInput,
    alertMd,
    alertNormal,
    dismissRuntimeAlertPrompt,
    installRuntimeAlertBridge,
    presentRuntimeAlertPrompt,
    runtimeAlertGlobals,
} from './alert'

describe('runtime AlertComp bridge', () => {
    beforeEach(() => {
        mocks.alertStore!.set({ type: 'none', msg: '' })
    })

    it('routes resident blocking prompts and notices without opening the hidden store', async () => {
        const prompt = vi.fn(async () => 'from-phone')
        const notice = vi.fn()
        const uninstall = installRuntimeAlertBridge({ prompt, notice })

        await expect(alertInput('Plugin input', [], 'seed')).resolves.toBe('from-phone')
        alertNormal('Plugin notice')
        alertError('Plugin error')
        alertMd('**Plugin markdown**')
        await Promise.resolve()

        expect(prompt).toHaveBeenCalledWith({
            type: 'input',
            msg: 'Plugin input',
            datalist: [],
            defaultValue: 'seed',
        })
        expect(notice).toHaveBeenCalledWith({ type: 'normal', msg: 'Plugin notice' })
        expect(notice).toHaveBeenCalledWith({
            type: 'error',
            msg: 'Plugin error',
            submsg: '',
            stackTrace: undefined,
        })
        expect(notice).toHaveBeenCalledWith({ type: 'markdown', msg: '**Plugin markdown**' })
        expect(get(mocks.alertStore!)).toEqual({ type: 'none', msg: '' })
        uninstall()
    })

    it('uses the unchanged alert store locally after the bridge is removed', async () => {
        const uninstall = installRuntimeAlertBridge({
            prompt: vi.fn(async () => 'no'),
            notice: vi.fn(),
        })
        uninstall()

        const pending = alertConfirm('Continue?')
        await vi.waitFor(() => expect(get(mocks.alertStore!)).toMatchObject({
            type: 'ask',
            msg: 'Continue?',
        }))
        mocks.alertStore!.set({ type: 'none', msg: 'yes' })
        await expect(pending).resolves.toBe(true)
    })

    it('replaces V2.1 native alert, confirm, and prompt globals with relayable dialogs', async () => {
        const prompt = vi.fn(async (data: { type: string }) => {
            if (data.type === 'ask') return 'yes'
            if (data.type === 'input') return 'secret-value'
            return ''
        })
        const uninstall = installRuntimeAlertBridge({ prompt, notice: vi.fn() })

        await expect(runtimeAlertGlobals.confirm('Confirm V2.1')).resolves.toBe(true)
        await expect(runtimeAlertGlobals.prompt('Prompt V2.1', 'seed')).resolves.toBe('secret-value')
        await expect(runtimeAlertGlobals.alert('Alert V2.1')).resolves.toBeUndefined()

        expect(prompt).toHaveBeenNthCalledWith(1, { type: 'ask', msg: 'Confirm V2.1' })
        expect(prompt).toHaveBeenNthCalledWith(2, {
            type: 'input',
            msg: 'Prompt V2.1',
            datalist: [],
            defaultValue: 'seed',
        })
        expect(prompt).toHaveBeenNthCalledWith(3, { type: 'normal', msg: 'Alert V2.1' })
        uninstall()
    })

    it('dismisses a prompt when another device wins without posting a local answer', async () => {
        const pending = presentRuntimeAlertPrompt({
            commandId: 'command-1',
            promptId: 'prompt-phone-wins',
            prompt: { type: 'pluginconfirm', msg: 'Plugin\n\nAllow?' },
        })
        await vi.waitFor(() => expect(get(mocks.alertStore!)).toMatchObject({
            type: 'pluginconfirm',
        }))

        dismissRuntimeAlertPrompt('prompt-phone-wins')

        await expect(pending).resolves.toBeNull()
        expect(get(mocks.alertStore!)).toEqual({ type: 'none', msg: '' })
    })

    it('returns a local runtime answer without retaining the secret in the UI store', async () => {
        const pending = presentRuntimeAlertPrompt({
            commandId: 'command-2',
            promptId: 'prompt-local-secret',
            prompt: { type: 'input', msg: 'API key', defaultValue: '' },
        })
        await vi.waitFor(() => expect(get(mocks.alertStore!)).toMatchObject({ type: 'input' }))
        mocks.alertStore!.set({ type: 'none', msg: 'local-secret-value' })

        await expect(pending).resolves.toBe('local-secret-value')
        expect(get(mocks.alertStore!)).toEqual({ type: 'none', msg: '' })
        dismissRuntimeAlertPrompt('prompt-local-secret')
    })
})
