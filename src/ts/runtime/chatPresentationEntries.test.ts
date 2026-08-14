import { describe, expect, it } from 'vitest'
import type { Message } from '../storage/database.svelte'
import type { RuntimeAssistantOutputPresentation } from './assistantOutputPresentation.svelte'
import type { RuntimeChatPresentationOverlay } from './chatPresentationOverlay.svelte'
import { buildRuntimeChatDisplayEntries } from './chatPresentationEntries'

function assistant(
    overrides: Partial<RuntimeAssistantOutputPresentation> = {},
): RuntimeAssistantOutputPresentation {
    return {
        type: 'generation_output',
        commandId: 'command-1',
        requestId: 'request-1',
        characterId: 'character-1',
        chatId: 'chat-1',
        version: 1,
        messageId: 'assistant-1',
        messageIndex: 1,
        data: 'partial',
        createdAt: 20,
        generationInfo: null,
        optimizationMode: 'off',
        timestamp: 21,
        ...overrides,
    }
}

function pendingInput(): RuntimeChatPresentationOverlay {
    return {
        requestId: 'request-1',
        commandId: 'command-1',
        characterId: 'character-1',
        chatId: 'chat-1',
        input: 'hello',
        files: [],
        displayText: 'hello',
        createdAt: 10,
        baseRevision: 1,
        phase: 'running',
        canonicalRevision: null,
        canonicalMessageId: null,
        terminalState: null,
        terminalRevision: null,
        canonicalMutationPersisted: null,
    }
}

describe('runtime chat presentation entries', () => {
    it('shows pending user input before a future assistant slot without mutating canonical data', () => {
        const messages: Message[] = []
        const entries = buildRuntimeChatDisplayEntries(
            messages,
            [pendingInput()],
            [assistant()],
        )

        expect(entries.map((entry) => [entry.message.role, entry.message.data])).toEqual([
            ['user', 'hello'],
            ['char', 'partial'],
        ])
        expect(messages).toEqual([])
    })

    it('replaces the matching canonical slot once during continue generation', () => {
        const messages: Message[] = [
            { role: 'user', data: 'hello', chatId: 'user-1' },
            {
                role: 'char',
                data: 'old answer',
                chatId: 'assistant-1',
                generationInfo: { generationId: 'old-generation' },
            },
        ]
        const entries = buildRuntimeChatDisplayEntries(
            messages,
            [],
            [assistant({
                messageIndex: 1,
                data: 'old answer continued',
                generationInfo: { generationId: 'new-generation' },
            })],
        )

        expect(entries).toHaveLength(2)
        expect(entries[1]).toEqual(expect.objectContaining({
            canonicalIndex: -1,
            assistantOutput: expect.objectContaining({ commandId: 'command-1' }),
            message: expect.objectContaining({
                chatId: 'assistant-1',
                data: 'old answer continued',
                generationInfo: { generationId: 'new-generation' },
            }),
        }))
        expect(messages[1].data).toBe('old answer')
    })

    it('inserts a reconstructed snapshot at its resident-assigned index', () => {
        const entries = buildRuntimeChatDisplayEntries(
            [{ role: 'user', data: 'hello', chatId: 'user-1' }],
            [],
            [assistant({ messageIndex: 1 })],
        )
        expect(entries.map((entry) => entry.message.chatId)).toEqual([
            'user-1',
            'assistant-1',
        ])
    })

    it('retains every ordered assistant message produced by one auto command', () => {
        const entries = buildRuntimeChatDisplayEntries(
            [{ role: 'user', data: 'hello', chatId: 'user-1' }],
            [],
            [
                assistant({
                    messageId: 'assistant-2',
                    messageIndex: 2,
                    data: 'second partial',
                    createdAt: 30,
                }),
                assistant({
                    messageId: 'assistant-1',
                    messageIndex: 1,
                    data: 'first complete',
                    createdAt: 20,
                }),
            ],
        )

        expect(entries.map((entry) => entry.message.chatId)).toEqual([
            'user-1',
            'assistant-1',
            'assistant-2',
        ])
        expect(entries.slice(1).every((entry) => entry.canonicalIndex === -1)).toBe(true)
    })
})
