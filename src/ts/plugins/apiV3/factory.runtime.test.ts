import { afterEach, describe, expect, it, vi } from 'vitest'
import { SandboxHost } from './factory'

const hosts: SandboxHost[] = []

afterEach(() => {
    for (const host of hosts.splice(0)) {
        host.terminate()
    }
    document.body.replaceChildren()
})

function dispatchPluginMessage(iframe: HTMLIFrameElement, data: Record<string, unknown>) {
    window.dispatchEvent(new MessageEvent('message', {
        data,
        source: iframe.contentWindow,
    }))
}

describe('V3 sandbox initialization compatibility', () => {
    it('waits for the matching iframe PLUGIN_READY handshake', async () => {
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const host = new SandboxHost({})
        hosts.push(host)

        let settled = false
        const pending = host.run(iframe, 'globalThis.fixtureLoaded = true')
            .then((cleanup) => {
                settled = true
                return cleanup
            })
        await Promise.resolve()

        expect(iframe.srcdoc).toContain('globalThis.fixtureLoaded = true')
        expect(iframe.srcdoc).toContain("type: 'PLUGIN_READY'")
        expect(iframe.sandbox.contains('allow-scripts')).toBe(true)

        const unrelated = document.createElement('iframe')
        document.body.appendChild(unrelated)
        dispatchPluginMessage(unrelated, { type: 'PLUGIN_READY' })
        await Promise.resolve()
        expect(settled).toBe(false)

        dispatchPluginMessage(iframe, { type: 'PLUGIN_READY' })
        const cleanup = await pending
        expect(settled).toBe(true)
        cleanup()
    })

    it('surfaces a plugin top-level initialization failure', async () => {
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const host = new SandboxHost({})
        hosts.push(host)

        const pending = host.run(iframe, 'throw new Error("fixture exploded")')
        await Promise.resolve()
        dispatchPluginMessage(iframe, {
            type: 'PLUGIN_ERROR',
            error: 'fixture exploded',
        })

        await expect(pending).rejects.toThrow('fixture exploded')
    })

    it('does not write RPC arguments or results to host logs', async () => {
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const secret = 'fixture-super-secret-value'
        const getSecret = vi.fn(async () => secret)
        const host = new SandboxHost({ getSecret })
        hosts.push(host)
        const pending = host.run(iframe, '')
        await Promise.resolve()
        dispatchPluginMessage(iframe, { type: 'PLUGIN_READY' })
        await pending
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)

        dispatchPluginMessage(iframe, {
            type: 'CALL_ROOT',
            reqId: 'secret-request',
            method: 'getSecret',
            args: [secret],
        })
        await vi.waitFor(() => expect(getSecret).toHaveBeenCalledWith(secret))
        await Promise.resolve()

        expect(consoleLog.mock.calls.flat(Infinity)).not.toContain(secret)
        consoleLog.mockRestore()
    })

    it('rejects an in-flight guest callback and future callback calls when terminated', async () => {
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        let guestCallback: (() => Promise<unknown>) | null = null
        const host = new SandboxHost({
            registerCallback: (callback: () => Promise<unknown>) => {
                guestCallback = callback
            },
        })
        hosts.push(host)
        const loading = host.run(iframe, '')
        await Promise.resolve()
        dispatchPluginMessage(iframe, { type: 'PLUGIN_READY' })
        await loading

        dispatchPluginMessage(iframe, {
            type: 'CALL_ROOT',
            reqId: 'register-callback',
            method: 'registerCallback',
            args: [{ __type: 'CALLBACK_REF', id: 'slow-guest-callback' }],
        })
        await vi.waitFor(() => expect(guestCallback).not.toBeNull())

        const pending = guestCallback!()
        const pendingAssertion = expect(pending).rejects.toThrow('Sandbox terminated')
        host.terminate()
        await pendingAssertion
        await expect(guestCallback!()).rejects.toThrow('Sandbox terminated')
    })

    it('rejects a pending executeInIframe request when terminated', async () => {
        const iframe = document.createElement('iframe')
        document.body.appendChild(iframe)
        const host = new SandboxHost({})
        hosts.push(host)
        const loading = host.run(iframe, '')
        await Promise.resolve()
        dispatchPluginMessage(iframe, { type: 'PLUGIN_READY' })
        await loading

        const pending = host.executeInIframe('await new Promise(() => {})')
        const pendingAssertion = expect(pending).rejects.toThrow('Sandbox terminated')
        host.terminate()
        await pendingAssertion
    })
})
