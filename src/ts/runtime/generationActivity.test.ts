import { get } from 'svelte/store'
import { afterEach, describe, expect, it } from 'vitest'
import {
    activeRuntimeGenerationCommands,
    clearRuntimeGenerationPendingIntent,
    getRuntimeGenerationTargetActivity,
    publishRuntimeGenerationCommands,
    registerRuntimeGenerationPendingIntent,
    runtimeGenerationActive,
    runtimeGenerationPendingIntents,
} from './generationActivity.svelte'
import type { RuntimeGenerationCommand } from './generationClient'

const REQUEST_IDS = [
    'pending-mobile-request',
    'duplicate-mobile-request',
    'failed-foreground-request',
]

afterEach(() => {
    for (const requestId of REQUEST_IDS) {
        clearRuntimeGenerationPendingIntent(requestId)
    }
    publishRuntimeGenerationCommands([])
})

function command(action: RuntimeGenerationCommand['action']): RuntimeGenerationCommand {
    return {
        commandId: `${action}-command`,
        requestId: `${action}-request`,
        action,
        characterId: 'character-1',
        chatId: 'chat-1',
        state: 'running',
        createdAt: 1,
        updatedAt: 1,
        startedAt: 1,
        finishedAt: null,
        interruptedAt: null,
        cancelRequestedAt: null,
        executorId: 'resident',
        fencingToken: 1,
        leaseExpiresAt: 2,
        result: null,
        error: null,
        lastSequence: 1,
    }
}

describe('runtime generation pending intent activity', () => {
    it('keeps suggestion commands observable but excludes them from foreground admission', () => {
        publishRuntimeGenerationCommands([command('suggest')])

        expect(get(activeRuntimeGenerationCommands)).toHaveLength(1)
        expect(get(runtimeGenerationActive)).toBe(false)
        expect(getRuntimeGenerationTargetActivity(
            get(activeRuntimeGenerationCommands),
            { characterId: 'character-1', chatId: 'chat-1' },
        )).toEqual({
            activeCommand: null,
            anyActive: false,
            activeElsewhere: false,
        })

        publishRuntimeGenerationCommands([command('suggest'), command('send')])
        expect(get(runtimeGenerationActive)).toBe(true)
        expect(getRuntimeGenerationTargetActivity(
            get(activeRuntimeGenerationCommands),
            { characterId: 'character-1', chatId: 'chat-1' },
        ).activeCommand?.action).toBe('send')
    })

    it('does not restore the foreground lock after a failed send clears its intent beside a suggestion', () => {
        publishRuntimeGenerationCommands([command('suggest')])
        registerRuntimeGenerationPendingIntent({
            requestId: REQUEST_IDS[2],
            characterId: 'character-1',
            chatId: 'chat-1',
            controller: new AbortController(),
            input: 'foreground draft',
            files: [],
            createdAt: 123,
        })

        // A delegated foreground send marks doingChat while its browser-local
        // admission exists. Its failure clears that intent before
        // restoreDelegatedGenerationActivity recomputes the global lock.
        expect(get(runtimeGenerationPendingIntents)).toHaveLength(1)
        clearRuntimeGenerationPendingIntent(REQUEST_IDS[2])
        const restoredDoingChat = get(runtimeGenerationActive)
            || get(runtimeGenerationPendingIntents).length > 0

        expect(get(activeRuntimeGenerationCommands).map((entry) => entry.action)).toEqual(['suggest'])
        expect(restoredDoingChat).toBe(false)
    })

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
