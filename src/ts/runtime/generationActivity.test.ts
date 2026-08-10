import { get } from 'svelte/store'
import { afterEach, describe, expect, it } from 'vitest'
import {
    clearRuntimeGenerationPendingIntent,
    registerRuntimeGenerationPendingIntent,
    runtimeGenerationPendingIntents,
} from './generationActivity.svelte'

const REQUEST_IDS = ['pending-mobile-request', 'duplicate-mobile-request']

afterEach(() => {
    for (const requestId of REQUEST_IDS) {
        clearRuntimeGenerationPendingIntent(requestId)
    }
})

describe('runtime generation pending intent activity', () => {
    it('survives component-local ownership and exposes the exact abort controller', () => {
        const controller = new AbortController()
        registerRuntimeGenerationPendingIntent({
            requestId: REQUEST_IDS[0],
            characterId: 'character-1',
            chatId: 'chat-1',
            controller,
            input: 'draft survives mobile teardown',
            files: ['asset://pending-image'],
            createdAt: 123,
        })

        const restored = get(runtimeGenerationPendingIntents)[0]
        expect(restored).toMatchObject({
            requestId: REQUEST_IDS[0],
            characterId: 'character-1',
            chatId: 'chat-1',
            input: 'draft survives mobile teardown',
            files: ['asset://pending-image'],
            createdAt: 123,
        })
        restored.controller.abort('stop after mobile re-entry')
        expect(controller.signal.aborted).toBe(true)
        expect(controller.signal.reason).toBe('stop after mobile re-entry')

        clearRuntimeGenerationPendingIntent(REQUEST_IDS[0])
        expect(get(runtimeGenerationPendingIntents)).toEqual([])
    })

    it('rejects a duplicate request identifier instead of replacing ownership', () => {
        const input = {
            requestId: REQUEST_IDS[1],
            characterId: 'character-1',
            chatId: 'chat-1',
            controller: new AbortController(),
            input: 'duplicate',
            files: [],
            createdAt: 123,
        }
        registerRuntimeGenerationPendingIntent(input)

        expect(() => registerRuntimeGenerationPendingIntent(input)).toThrow(
            `Runtime generation intent ${REQUEST_IDS[1]} already exists`,
        )
        expect(get(runtimeGenerationPendingIntents)).toHaveLength(1)
    })
})
