import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    database: {} as any,
    sayTTS: vi.fn(),
    parser: vi.fn((value: string) => value.replace('{{secret}}', 'resolved-secret')),
}))

vi.mock('../storage/database.svelte', () => ({
    getCurrentCharacter: vi.fn(() => mocks.database.characters[0]),
    getCurrentChat: vi.fn(() => mocks.database.characters[0].chats[0]),
    getDatabase: vi.fn(() => mocks.database),
    setCurrentChat: vi.fn(),
    setDatabase: vi.fn(),
}))
vi.mock('../stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return { selectedCharID: writable(0) }
})
vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    alertMd: vi.fn(),
    alertNormal: vi.fn(),
    alertSelect: vi.fn(),
}))
vi.mock('./tts', () => ({ sayTTS: mocks.sayTTS }))
vi.mock('../parser/parser.svelte', () => ({ risuChatParser: mocks.parser }))
vi.mock('./index.svelte', () => ({ sendChat: vi.fn() }))
vi.mock('./lorebook.svelte', () => ({ loadLoreBookV3Prompt: vi.fn() }))
vi.mock('./triggers', () => ({ runTrigger: vi.fn() }))

import { processMultiCommand } from './command'

describe('slash speak command compatibility', () => {
    beforeEach(() => {
        mocks.database = {
            characters: [{
                type: 'character',
                chaId: 'character-1',
                chatPage: 0,
                chats: [{ id: 'chat-1', message: [] }],
            }],
        }
        mocks.sayTTS.mockReset().mockResolvedValue(undefined)
        mocks.parser.mockClear()
    })

    it('preserves pipe and parser resolution while invoking TTS once without logging text', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})

        await expect(processMultiCommand('/pass {{secret}} | /speak')).resolves.toBe('resolved-secret')

        expect(mocks.sayTTS).toHaveBeenCalledOnce()
        expect(mocks.sayTTS).toHaveBeenCalledWith(
            mocks.database.characters[0],
            'resolved-secret',
        )
        expect(log).not.toHaveBeenCalled()
        log.mockRestore()
    })

    it('does not split a quoted pipe into another command', async () => {
        await processMultiCommand('/pass "left|right" | /speak')

        expect(mocks.sayTTS).toHaveBeenCalledOnce()
        expect(mocks.sayTTS.mock.calls[0][1]).toBe('"left|right"')
    })

    it('keeps group speak as an upstream-compatible no-op', async () => {
        mocks.database.characters[0].type = 'group'

        await processMultiCommand('/speak group text')

        expect(mocks.sayTTS).not.toHaveBeenCalled()
    })
})
