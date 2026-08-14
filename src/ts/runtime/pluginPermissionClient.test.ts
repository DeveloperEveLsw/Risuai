import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../storage/nodeStorage', () => ({
    getNodeServerProxyAuth: vi.fn(async () => 'unused-test-auth'),
}))

import { RuntimePluginPermissionClient } from './pluginPermissionClient'

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    })
}

function fixture(fetchImpl: typeof fetch, requestTimeoutMs = 5) {
    return new RuntimePluginPermissionClient({
        fetchImpl,
        getAuth: async () => 'fixture-auth',
        requesterId: 'fixture-browser',
        cryptoImpl: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
        pollIntervalMs: 1,
        retryIntervalMs: 1,
        requestTimeoutMs,
    })
}

afterEach(() => {
    vi.useRealTimers()
})

describe('RuntimePluginPermissionClient', () => {
    it('polls one opaque request token without exposing the answer in create payloads', async () => {
        vi.useFakeTimers()
        const fetchImpl = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(jsonResponse({
                state: 'pending',
                requestToken: 'opaque-token',
            }, 202))
            .mockResolvedValueOnce(jsonResponse({ state: 'pending' }, 202))
            .mockResolvedValueOnce(jsonResponse({ state: 'granted' }))
        const client = fixture(fetchImpl)

        const result = client.resolve(
            { name: 'fixture', scriptHash: 'a'.repeat(64) },
            'db',
            'periodically',
            'Allow database access?',
        )
        await vi.runAllTimersAsync()
        await expect(result).resolves.toBe(true)

        expect(fetchImpl).toHaveBeenCalledTimes(3)
        const create = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
        expect(create).toEqual({
            requesterId: 'fixture-browser',
            requestId: '00000000-0000-4000-8000-000000000000',
            principal: { name: 'fixture', scriptHash: 'a'.repeat(64) },
            capability: 'db',
            policy: 'periodically',
            prompt: { type: 'ask', msg: 'Allow database access?' },
        })
        expect(JSON.stringify(create)).not.toContain('opaque-token')
        expect(fetchImpl.mock.calls[1][0]).toBe('/runtime-plugin-permissions/poll')
        expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
            requestToken: 'opaque-token',
        })
    })

    it('recreates an undecided request after server restart and remains fail closed', async () => {
        const fetchImpl = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(jsonResponse({
                state: 'pending', requestToken: 'stale-token',
            }, 202))
            .mockResolvedValueOnce(jsonResponse({
                error: 'gone', code: 'PLUGIN_PERMISSION_REQUEST_UNAVAILABLE',
            }, 410))
            .mockResolvedValueOnce(jsonResponse({
                state: 'pending', requestToken: 'replacement-token',
            }, 202))
            .mockResolvedValueOnce(jsonResponse({ state: 'denied' }))
        const client = fixture(fetchImpl)

        await expect(client.resolve(
            { name: 'fixture', scriptHash: 'b'.repeat(64) },
            'provider',
            'persistent',
            'Allow provider access?',
        )).resolves.toBe(false)

        expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
            '/runtime-plugin-permissions/requests',
            '/runtime-plugin-permissions/poll',
            '/runtime-plugin-permissions/requests',
            '/runtime-plugin-permissions/poll',
        ])
        const first = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
        const second = JSON.parse(String(fetchImpl.mock.calls[2][1]?.body))
        expect(second.requestId).toBe(first.requestId)
        expect(second.principal).toEqual(first.principal)
    })

    it('returns a cached exact server decision without creating a local prompt', async () => {
        const fetchImpl = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(jsonResponse({
                state: 'granted', cached: true,
            }))
        const client = fixture(fetchImpl)

        await expect(client.resolve(
            { name: 'fixture', scriptHash: 'c'.repeat(64) },
            'mainDom',
            'persistent',
            'Allow DOM access?',
        )).resolves.toBe(true)
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('aborts an in-flight poll when its plugin activation is unloaded', async () => {
        const controller = new AbortController()
        const fetchImpl = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(jsonResponse({
                state: 'pending', requestToken: 'waiting-token',
            }, 202))
            .mockImplementationOnce(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
            }))
        const client = fixture(fetchImpl, 10_000)
        const pending = client.resolve(
            { name: 'fixture', scriptHash: 'd'.repeat(64) },
            'db',
            'periodically',
            'Allow database access?',
            controller.signal,
        )
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))

        const inactive = new Error('PluginInactiveError: fixture unloaded')
        controller.abort(inactive)
        await expect(pending).rejects.toBe(inactive)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it('times out a half-open attempt and retries the same idempotent create request', async () => {
        vi.useFakeTimers()
        const fetchImpl = vi.fn<typeof fetch>()
            .mockImplementationOnce(async (_url, init) => await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
            }))
            .mockResolvedValueOnce(jsonResponse({ state: 'granted', cached: true }))
        const client = fixture(fetchImpl)
        const pending = client.resolve(
            { name: 'fixture', scriptHash: 'e'.repeat(64) },
            'provider',
            'persistent',
            'Allow provider access?',
        )

        await vi.advanceTimersByTimeAsync(6)
        await expect(pending).resolves.toBe(true)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        const first = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
        const second = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))
        expect(second.requestId).toBe(first.requestId)
    })
})
