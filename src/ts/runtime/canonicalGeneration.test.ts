import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    dbState: { db: {} as any },
    sendChat: vi.fn(),
    processMultiCommand: vi.fn(),
    processScript: vi.fn(),
    runTrigger: vi.fn(),
    prereroll: vi.fn(),
    preUnreroll: vi.fn(),
}))

vi.mock('../stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        DBState: mocks.dbState,
        selectedCharID: writable(-1),
    }
})

vi.mock('../sync/multiuser', async () => {
    const { writable } = await import('svelte/store')
    return { ConnectionOpenStore: writable(false) }
})

vi.mock('../process/index.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        doingChat: writable(false),
        sendChat: mocks.sendChat,
    }
})

vi.mock('../process/command', () => ({ processMultiCommand: mocks.processMultiCommand }))
vi.mock('../process/scripts', () => ({ processScript: mocks.processScript }))
vi.mock('../process/triggers', () => ({ runTrigger: mocks.runTrigger }))
vi.mock('../process/prereroll', () => ({
    Prereroll: mocks.prereroll,
    PreUnreroll: mocks.preUnreroll,
}))
vi.mock('../util', () => ({ sleep: vi.fn(async () => {}) }))

import { get } from 'svelte/store'
import { selectedCharID } from '../stores.svelte'
import { doingChat } from '../process/index.svelte'
import {
    CanonicalGenerationTargetError,
    executeCanonicalGenerate,
    executeCanonicalReroll,
    executeCanonicalSend,
    executeCanonicalUnreroll,
} from './canonicalGeneration.svelte'

function setDatabase() {
    mocks.dbState.db = {
        username: 'User',
        useSayNothing: true,
        characters: [
            {
                type: 'character',
                chaId: 'character-a',
                chatPage: 0,
                chats: [
                    { id: 'chat-a', message: [] },
                    { id: 'chat-b', message: [] },
                ],
            },
            {
                type: 'group',
                chaId: 'group-a',
                chatPage: 0,
                chats: [{ id: 'group-chat', message: [] }],
            },
        ],
    }
}

describe('canonical resident generation boundary', () => {
    beforeEach(() => {
        setDatabase()
        selectedCharID.set(-1)
        doingChat.set(false)
        mocks.sendChat.mockReset().mockResolvedValue(true)
        mocks.processMultiCommand.mockReset().mockResolvedValue(false)
        mocks.processScript.mockReset().mockImplementation(async (_character, input) => `edited:${input}`)
        mocks.runTrigger.mockReset().mockResolvedValue(null)
        mocks.prereroll.mockReset().mockReturnValue(null)
        mocks.preUnreroll.mockReset().mockReturnValue(null)
    })

    it('selects the command target by stable IDs and runs the existing input pipeline', async () => {
        mocks.sendChat.mockImplementation(async () => {
            const character = mocks.dbState.db.characters[0]
            character.chats[1].message.push({ role: 'char', data: 'response' })
            return true
        })

        const result = await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-b',
            input: 'hello',
            files: ['assets/file.png'],
        })

        expect(get(selectedCharID)).toBe(0)
        expect(mocks.dbState.db.characters[0].chatPage).toBe(1)
        expect(mocks.processScript).toHaveBeenCalledWith(
            mocks.dbState.db.characters[0],
            'hello{{inlayed::assets/file.png}}',
            'editinput',
        )
        expect(mocks.sendChat).toHaveBeenCalledWith(-1, {
            signal: undefined,
            continue: undefined,
        })
        expect(mocks.dbState.db.characters[0].chats[1].message).toEqual([
            expect.objectContaining({ role: 'user', data: 'edited:hello{{inlayed::assets/file.png}}' }),
            { role: 'char', data: 'response' },
        ])
        expect(result).toMatchObject({ generated: true, previousLength: 1, currentLength: 2 })
    })

    it('executes slash commands before generation without calling the provider path', async () => {
        mocks.processMultiCommand.mockResolvedValue(true)

        const result = await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: '/command',
        })

        expect(result.commandProcessed).toBe(true)
        expect(mocks.processScript).not.toHaveBeenCalled()
        expect(mocks.sendChat).not.toHaveBeenCalled()
    })

    it('preserves say-nothing behavior for an empty character input', async () => {
        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: '',
        })

        expect(mocks.dbState.db.characters[0].chats[0].message[0]).toMatchObject({
            role: 'user',
            data: '*says nothing*',
        })
        expect(mocks.processScript).not.toHaveBeenCalled()
        expect(mocks.sendChat).toHaveBeenCalledOnce()
    })

    it('fails closed when a queued target was removed before execution', async () => {
        await expect(executeCanonicalSend({
            characterId: 'missing',
            chatId: 'chat-a',
            input: 'hello',
        })).rejects.toBeInstanceOf(CanonicalGenerationTargetError)
        expect(mocks.sendChat).not.toHaveBeenCalled()
    })

    it('always releases doingChat when the upstream generation throws', async () => {
        mocks.sendChat.mockRejectedValue(new Error('provider failed'))

        await expect(executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'hello',
        })).rejects.toThrow('provider failed')
        expect(get(doingChat)).toBe(false)
    })

    it('preserves low-level sendChat arguments for plugin and hotkey fallback calls', async () => {
        mocks.dbState.db.characters[0].chats[0].message.push({ role: 'user', data: 'plugin input' })

        const result = await executeCanonicalGenerate({
            characterId: 'character-a',
            chatId: 'chat-a',
            chatProcessIndex: 3,
            chatAdditonalTokens: 42,
            continue: true,
            usedContinueTokens: 7,
        })

        expect(mocks.sendChat).toHaveBeenCalledWith(3, {
            signal: undefined,
            continue: true,
            chatAdditonalTokens: 42,
            usedContinueTokens: 7,
        })
        expect(result).toMatchObject({ generated: true, previousLength: 1 })
    })

    it('runs unreroll against the resident cache and canonical target', () => {
        mocks.dbState.db.characters[0].chats[1].message.push({
            role: 'char',
            data: 'new response',
            generationInfo: { generationId: 'generation-a' },
        })
        mocks.preUnreroll.mockReturnValue('previous response')

        const result = executeCanonicalUnreroll({
            characterId: 'character-a',
            chatId: 'chat-b',
        })

        expect(get(selectedCharID)).toBe(0)
        expect(mocks.preUnreroll).toHaveBeenCalledWith('generation-a')
        expect(mocks.dbState.db.characters[0].chats[1].message[0].data).toBe('previous response')
        expect(result.generated).toBe(false)
    })

    it('keeps normal reroll history in the resident so either device can navigate it', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        chat.message.push(
            { role: 'user', data: 'question' },
            { role: 'char', data: 'original response' },
        )
        mocks.sendChat.mockImplementation(async () => {
            chat.message.push({ role: 'char', data: 'rerolled response' })
            return true
        })

        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.at(-1)?.data).toBe('rerolled response')
        expect(mocks.sendChat).toHaveBeenCalledOnce()

        executeCanonicalUnreroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.at(-1)?.data).toBe('original response')

        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.at(-1)?.data).toBe('rerolled response')
        expect(mocks.sendChat).toHaveBeenCalledOnce()
    })
})
