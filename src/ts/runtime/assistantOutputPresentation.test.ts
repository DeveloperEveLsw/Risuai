import { beforeEach, describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import {
    clearRuntimeAssistantOutputPresentations,
    getRuntimeAssistantOutputPresentation,
    getRuntimeAssistantOutputPresentations,
    removeRuntimeAssistantOutputPresentation,
    runtimeAssistantOutputPresentations,
    upsertRuntimeAssistantOutputPresentation,
    type RuntimeAssistantOutputSnapshot,
} from './assistantOutputPresentation.svelte'

const target = {
    commandId: 'command-1',
    requestId: 'request-1',
    characterId: 'character-1',
    chatId: 'chat-1',
}

function snapshot(
    version: number,
    data: string,
    overrides: Partial<RuntimeAssistantOutputSnapshot> = {},
): RuntimeAssistantOutputSnapshot {
    return {
        type: 'generation_output',
        commandId: 'command-1',
        version,
        messages: [{
            messageId: 'message-1',
            messageIndex: 2,
            data,
            createdAt: 100,
            generationInfo: null,
            optimizationMode: 'off',
        }],
        timestamp: 100 + version,
        ...overrides,
    }
}

describe('runtime assistant output presentation', () => {
    beforeEach(() => clearRuntimeAssistantOutputPresentations())

    it('keeps only the newest cumulative version and permits gaps', () => {
        upsertRuntimeAssistantOutputPresentation(target, snapshot(1, 'a'))
        upsertRuntimeAssistantOutputPresentation(target, snapshot(4, 'abcd'))
        upsertRuntimeAssistantOutputPresentation(target, snapshot(2, 'ab'))

        expect(get(runtimeAssistantOutputPresentations)).toEqual([
            expect.objectContaining({
                commandId: 'command-1',
                version: 4,
                data: 'abcd',
            }),
        ])
    })

    it('accepts an identical transport replay but rejects conflicting reuse', () => {
        const output = snapshot(1, 'partial')
        const first = upsertRuntimeAssistantOutputPresentation(target, output)
        expect(upsertRuntimeAssistantOutputPresentation(target, output)).toEqual(first)
        expect(() => upsertRuntimeAssistantOutputPresentation(
            target,
            snapshot(1, 'different'),
        )).toThrow(/version was reused/)
    })

    it('rejects command target changes and retains every auto-iteration message', () => {
        expect(() => upsertRuntimeAssistantOutputPresentation(
            target,
            snapshot(1, 'partial', { commandId: 'other-command' }),
        )).toThrow(/command identity/)

        upsertRuntimeAssistantOutputPresentation(target, snapshot(1, 'partial'))
        expect(() => upsertRuntimeAssistantOutputPresentation(
            { ...target, chatId: 'other-chat' },
            snapshot(2, 'next'),
        )).toThrow(/identity changed/)
        expect(upsertRuntimeAssistantOutputPresentation(
            target,
            snapshot(2, 'next', {
                messages: [{
                    messageId: 'message-1',
                    messageIndex: 2,
                    data: 'first complete',
                    createdAt: 100,
                    generationInfo: null,
                    optimizationMode: 'off',
                }, {
                    messageId: 'other-message',
                    messageIndex: 3,
                    data: 'next',
                    createdAt: 200,
                    generationInfo: null,
                    optimizationMode: 'off',
                }],
            }),
        )).toEqual([
            expect.objectContaining({ messageId: 'message-1', data: 'first complete' }),
            expect.objectContaining({ messageId: 'other-message', data: 'next' }),
        ])
        expect(getRuntimeAssistantOutputPresentations('command-1')).toHaveLength(2)
    })

    it('atomically removes a message omitted by a newer aggregate', () => {
        upsertRuntimeAssistantOutputPresentation(target, snapshot(1, 'first', {
            messages: [{
                messageId: 'message-1', messageIndex: 2, data: 'first', createdAt: 100,
                generationInfo: null, optimizationMode: 'off',
            }, {
                messageId: 'message-2', messageIndex: 3, data: 'second', createdAt: 101,
                generationInfo: null, optimizationMode: 'off',
            }],
        }))
        upsertRuntimeAssistantOutputPresentation(target, snapshot(2, 'first final'))

        expect(getRuntimeAssistantOutputPresentations('command-1')).toEqual([
            expect.objectContaining({ messageId: 'message-1', data: 'first final' }),
        ])
    })

    it('removes the presentation independently of canonical chat data', () => {
        const canonicalMessages = [{ role: 'user', data: 'hello' }]
        upsertRuntimeAssistantOutputPresentation(target, snapshot(1, 'partial'))
        removeRuntimeAssistantOutputPresentation('command-1')

        expect(getRuntimeAssistantOutputPresentation('command-1')).toBeNull()
        expect(canonicalMessages).toEqual([{ role: 'user', data: 'hello' }])
    })
})
