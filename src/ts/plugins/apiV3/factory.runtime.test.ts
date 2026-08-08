import { afterEach, describe, expect, it } from 'vitest'
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
})
