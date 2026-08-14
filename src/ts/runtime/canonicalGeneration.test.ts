import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    dbState: { db: {} as any },
    sendChat: vi.fn(),
    processMultiCommand: vi.fn(),
    processScript: vi.fn(),
    requestChatData: vi.fn(),
    runTrigger: vi.fn(),
    runLuaButtonTrigger: vi.fn(),
    prereroll: vi.fn(),
    preUnreroll: vi.fn(),
}))

vi.mock('../stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return {
        CurrentTriggerIdStore: writable<string | null>(null),
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
vi.mock('../process/request/request', () => ({ requestChatData: mocks.requestChatData }))
vi.mock('../process/triggers', () => ({ runTrigger: mocks.runTrigger }))
vi.mock('../process/scriptings', () => ({ runLuaButtonTrigger: mocks.runLuaButtonTrigger }))
vi.mock('../process/prereroll', () => ({
    Prereroll: mocks.prereroll,
    PreUnreroll: mocks.preUnreroll,
}))
vi.mock('../util', () => ({
    getUserName: vi.fn(() => 'User'),
    replacePlaceholders: vi.fn((value: string, characterName: string) => (
        value.replaceAll('{{char}}', characterName)
    )),
    sleep: vi.fn(async () => {}),
}))

import { get } from 'svelte/store'
import { selectedCharID } from '../stores.svelte'
import { doingChat } from '../process/index.svelte'
import {
    CanonicalGenerationTargetError,
    executeCanonicalGenerate,
    executeCanonicalAuto,
    executeCanonicalLuaButton,
    executeCanonicalManualTrigger,
    executeCanonicalReroll,
    executeCanonicalSend,
    executeCanonicalSuggestion,
    executeCanonicalUnreroll,
} from './canonicalGeneration.svelte'

function setDatabase() {
    mocks.dbState.db = {
        username: 'User',
        useSayNothing: true,
        autoSuggestPrompt: 'Suggest for {{char}}',
        subModel: 'reverse_proxy',
        characters: [
            {
                type: 'character',
                chaId: 'character-a',
                name: 'Character A',
                chatPage: 0,
                chats: [
                    { id: 'chat-a', message: [] },
                    { id: 'chat-b', message: [] },
                ],
            },
            {
                type: 'group',
                chaId: 'group-a',
                name: 'Group A',
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
        mocks.requestChatData.mockReset().mockResolvedValue({
            type: 'success',
            result: '- First suggestion\nnot a suggestion\n- Second suggestion',
        })
        mocks.runTrigger.mockReset().mockResolvedValue(null)
        mocks.runLuaButtonTrigger.mockReset().mockResolvedValue(null)
        mocks.prereroll.mockReset().mockReturnValue(null)
        mocks.preUnreroll.mockReset().mockReturnValue(null)
    })

    it('selects the command target by stable IDs and runs the existing input pipeline', async () => {
        const onInputAppended = vi.fn(async () => {
            expect(mocks.sendChat).not.toHaveBeenCalled()
        })
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
            canonicalInputMessageId: 'request-1',
            onInputAppended,
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
            expect.objectContaining({
                role: 'user',
                data: 'edited:hello{{inlayed::assets/file.png}}',
                chatId: 'request-1',
            }),
            expect.objectContaining({
                role: 'char',
                data: 'response',
                chatId: expect.any(String),
            }),
        ])
        expect(onInputAppended).toHaveBeenCalledWith({
            messageIndex: 0,
            messageId: mocks.dbState.db.characters[0].chats[1].message[0].chatId,
        })
        expect(mocks.dbState.db.characters[0].chats[1].message[0]).not.toHaveProperty('commandId')
        expect(result).toMatchObject({ generated: true, previousLength: 1, currentLength: 2 })
    })

    it('appends input to the live chat when an input trigger replaces the DB root', async () => {
        mocks.runTrigger.mockImplementationOnce(async () => {
            mocks.dbState.db = structuredClone(mocks.dbState.db)
            return null
        })
        mocks.sendChat.mockImplementationOnce(async () => {
            const liveChat = mocks.dbState.db.characters[0].chats[0]
            liveChat.message.push({ role: 'char', data: 'live response' })
            return true
        })

        const result = await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        const liveChat = mocks.dbState.db.characters[0].chats[0]

        expect(liveChat.message.map((message: any) => message.data)).toEqual([
            'edited:question',
            'live response',
        ])
        expect(result.currentLength).toBe(2)
    })

    it('preserves a live chat mutation when editinput replaces the DB root', async () => {
        mocks.dbState.db.characters[0].chats[0].message.push({
            role: 'char',
            data: 'old context',
        })
        mocks.processScript.mockImplementationOnce(async () => {
            mocks.dbState.db = structuredClone(mocks.dbState.db)
            mocks.dbState.db.characters[0].chats[0].message[0].data = 'hook-edited context'
            return 'edited input'
        })
        mocks.sendChat.mockImplementationOnce(async () => {
            mocks.dbState.db.characters[0].chats[0].message.push({
                role: 'char',
                data: 'live response',
            })
            return true
        })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })

        expect(mocks.dbState.db.characters[0].chats[0].message.map(
            (message: any) => message.data,
        )).toEqual([
            'hook-edited context',
            'edited input',
            'live response',
        ])
    })

    it('executes slash commands before generation without calling the provider path', async () => {
        mocks.processMultiCommand.mockResolvedValue(true)
        const onInputAppended = vi.fn()

        const result = await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: '/command',
            onInputAppended,
        })

        expect(result.commandProcessed).toBe(true)
        expect(mocks.processScript).not.toHaveBeenCalled()
        expect(mocks.sendChat).not.toHaveBeenCalled()
        expect(onInputAppended).not.toHaveBeenCalled()
    })

    it('reports a canonical chat mutation made before a later slash command fails', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.processMultiCommand.mockImplementation(async () => {
            chat.message.push({ role: 'user', data: 'slash mutation' })
            throw new Error('later slash prompt cancelled')
        })
        const onCanonicalMutation = vi.fn()

        await expect(executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: '/send slash mutation | /input wait',
            onCanonicalMutation,
        })).rejects.toThrow('later slash prompt cancelled')

        expect(onCanonicalMutation).toHaveBeenCalledOnce()
        expect(chat.message).toEqual([{ role: 'user', data: 'slash mutation' }])
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

    it('runs a manual trigger against the canonical resident chat and keeps its mutation', async () => {
        const mutatedChat = {
            id: 'chat-a',
            message: [{ role: 'char', data: 'manual LLM result' }],
        }
        mocks.runTrigger.mockResolvedValue({
            chat: mutatedChat,
            additonalSysPrompt: { start: '', historyend: '', promptend: '' },
            stopSending: false,
        })

        const result = await executeCanonicalManualTrigger({
            characterId: 'character-a',
            chatId: 'chat-a',
            manualName: 'community-action',
            triggerId: 'trigger-7',
        })

        expect(mocks.runTrigger).toHaveBeenCalledWith(
            mocks.dbState.db.characters[0],
            'manual',
            {
                chat: expect.objectContaining({ id: 'chat-a' }),
                manualName: 'community-action',
                triggerId: 'trigger-7',
            },
        )
        expect(mocks.dbState.db.characters[0].chats[0]).toBe(mutatedChat)
        expect(result).toEqual({ generated: false, previousLength: 0, currentLength: 1 })
    })

    it('applies a manual trigger result to the live target after a DB root replacement', async () => {
        const mutatedChat = {
            id: 'chat-a',
            message: [{ role: 'char', data: 'live manual result' }],
        }
        mocks.runTrigger.mockImplementationOnce(async () => {
            mocks.dbState.db = structuredClone(mocks.dbState.db)
            return {
                chat: mutatedChat,
                additonalSysPrompt: { start: '', historyend: '', promptend: '' },
                stopSending: false,
            }
        })

        const result = await executeCanonicalManualTrigger({
            characterId: 'character-a',
            chatId: 'chat-a',
            manualName: 'root-replacing-action',
        })

        expect(mocks.dbState.db.characters[0].chats[0]).toBe(mutatedChat)
        expect(result.currentLength).toBe(1)
    })

    it('runs a Lua chat button against the canonical resident chat', async () => {
        const mutatedChat = {
            id: 'chat-b',
            message: [{ role: 'char', data: 'Lua LLM result' }],
        }
        mocks.runLuaButtonTrigger.mockResolvedValue({ chat: mutatedChat })

        const result = await executeCanonicalLuaButton({
            characterId: 'character-a',
            chatId: 'chat-b',
            data: 'community-button-payload',
        })

        expect(mocks.runLuaButtonTrigger).toHaveBeenCalledWith(
            mocks.dbState.db.characters[0],
            'community-button-payload',
        )
        expect(mocks.dbState.db.characters[0].chats[1]).toBe(mutatedChat)
        expect(result).toEqual({ generated: false, previousLength: 0, currentLength: 1 })
    })

    it('applies a Lua button result to the live target after a DB root replacement', async () => {
        const mutatedChat = {
            id: 'chat-b',
            message: [{ role: 'char', data: 'live Lua result' }],
        }
        mocks.runLuaButtonTrigger.mockImplementationOnce(async () => {
            mocks.dbState.db = structuredClone(mocks.dbState.db)
            return { chat: mutatedChat }
        })

        const result = await executeCanonicalLuaButton({
            characterId: 'character-a',
            chatId: 'chat-b',
            data: 'root-replacing-button',
        })

        expect(mocks.dbState.db.characters[0].chats[1]).toBe(mutatedChat)
        expect(result.currentLength).toBe(1)
    })

    it('runs a module Lua chat button against a canonical group chat', async () => {
        const mutatedChat = {
            id: 'group-chat',
            message: [{ role: 'char', data: 'group module Lua result' }],
        }
        mocks.runLuaButtonTrigger.mockResolvedValue({ chat: mutatedChat })

        const result = await executeCanonicalLuaButton({
            characterId: 'group-a',
            chatId: 'group-chat',
            data: 'group-module-button-payload',
        })

        expect(mocks.runLuaButtonTrigger).toHaveBeenCalledWith(
            mocks.dbState.db.characters[1],
            'group-module-button-payload',
        )
        expect(mocks.dbState.db.characters[1].chats[0]).toBe(mutatedChat)
        expect(result).toEqual({ generated: false, previousLength: 0, currentLength: 1 })
    })

    it('generates and stores canonical suggestions without returning their text', async () => {
        const chat = mocks.dbState.db.characters[0].chats[1]
        chat.message.push(
            { role: 'user', data: 'question' },
            { role: 'char', data: 'answer' },
        )

        const result = await executeCanonicalSuggestion({
            characterId: 'character-a',
            chatId: 'chat-b',
        })

        expect(mocks.requestChatData).toHaveBeenCalledWith({
            formated: [
                { role: 'system', content: 'Suggest for Character A' },
                { role: 'user', content: 'User:question,Character A:answer' },
            ],
            bias: {},
            currentChar: mocks.dbState.db.characters[0],
        }, 'submodel', null)
        expect(chat.suggestMessages).toEqual(['First suggestion', 'Second suggestion'])
        expect(result).toEqual({
            generated: false,
            suggestionsUpdated: true,
            suggestionCount: 2,
            previousLength: 2,
            currentLength: 2,
        })
        expect(JSON.stringify(result)).not.toContain('First suggestion')
    })

    it('stores suggestions on the live chat when the provider pipeline replaces the DB root', async () => {
        let chat = mocks.dbState.db.characters[0].chats[1]
        chat.message.push({ role: 'user', data: 'question' })
        mocks.requestChatData.mockImplementationOnce(async () => {
            mocks.dbState.db = structuredClone(mocks.dbState.db)
            chat = mocks.dbState.db.characters[0].chats[1]
            return { type: 'success', result: '- Live suggestion' }
        })

        const result = await executeCanonicalSuggestion({
            characterId: 'character-a',
            chatId: 'chat-b',
        })

        expect(chat.suggestMessages).toEqual(['Live suggestion'])
        expect(result).toEqual({
            generated: false,
            suggestionsUpdated: true,
            suggestionCount: 1,
            previousLength: 1,
            currentLength: 1,
        })
    })

    it('does not mutate canonical suggestions when the suggestion provider fails', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        chat.message.push({ role: 'user', data: 'question' })
        chat.suggestMessages = ['existing']
        mocks.requestChatData.mockResolvedValue({ type: 'fail', result: 'provider detail' })

        const result = await executeCanonicalSuggestion({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.suggestMessages).toEqual(['existing'])
        expect(result).toEqual({
            generated: false,
            suggestionsUpdated: false,
            suggestionCount: 1,
            previousLength: 1,
            currentLength: 1,
        })
        expect(JSON.stringify(result)).not.toContain('provider detail')
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

    it('navigates a differently sized normal response without replacing its user boundary', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'original response' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push(
                    { role: 'char', data: 'rerolled response A' },
                    { role: 'char', data: 'rerolled response B' },
                    { role: 'char', data: 'rerolled response C' },
                )
                return true
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })

        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'edited:question',
            'rerolled response A',
            'rerolled response B',
            'rerolled response C',
        ])

        executeCanonicalUnreroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'edited:question',
            'original response',
        ])

        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'edited:question',
            'rerolled response A',
            'rerolled response B',
            'rerolled response C',
        ])
        expect(mocks.sendChat).toHaveBeenCalledTimes(2)
    })

    it('records the complete group speaker slice from send for reroll navigation', async () => {
        const chat = mocks.dbState.db.characters[1].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push(
                    { role: 'char', data: 'old speaker A', saying: 'speaker-a' },
                    { role: 'char', data: 'old speaker B', saying: 'speaker-b' },
                )
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push(
                    { role: 'char', data: 'new speaker A', saying: 'speaker-a' },
                    { role: 'char', data: 'new speaker B', saying: 'speaker-b' },
                )
                return true
            })

        await executeCanonicalSend({
            characterId: 'group-a',
            chatId: 'group-chat',
            input: 'question',
        })
        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'question',
            'new speaker A',
            'new speaker B',
        ])

        executeCanonicalUnreroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'question',
            'old speaker A',
            'old speaker B',
        ])

        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'question',
            'new speaker A',
            'new speaker B',
        ])
        expect(mocks.sendChat).toHaveBeenCalledTimes(2)
    })

    it('records a group send from the live target after a start trigger replaces the DB root', async () => {
        let chat = mocks.dbState.db.characters[1].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                mocks.dbState.db = structuredClone(mocks.dbState.db)
                chat = mocks.dbState.db.characters[1].chats[0]
                chat.message.push(
                    { role: 'char', data: 'old live A', saying: 'speaker-a' },
                    { role: 'char', data: 'old live B', saying: 'speaker-b' },
                )
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'live reroll', saying: 'speaker-a' })
                return true
            })

        const sent = await executeCanonicalSend({
            characterId: 'group-a',
            chatId: 'group-chat',
            input: 'question',
        })
        expect(sent.currentLength).toBe(3)
        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        chat = mocks.dbState.db.characters[1].chats[0]
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'question',
            'live reroll',
        ])

        executeCanonicalUnreroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'question',
            'old live A',
            'old live B',
        ])
    })

    it('records a partial group send before rethrowing a provider error', async () => {
        let chat = mocks.dbState.db.characters[1].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                mocks.dbState.db = structuredClone(mocks.dbState.db)
                chat = mocks.dbState.db.characters[1].chats[0]
                chat.message.push(
                    { role: 'char', data: 'partial send A', saying: 'speaker-a' },
                    { role: 'char', data: 'partial send B', saying: 'speaker-b' },
                )
                throw new Error('send failed after partial output')
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'replacement send', saying: 'speaker-a' })
                return true
            })

        await expect(executeCanonicalSend({
            characterId: 'group-a',
            chatId: 'group-chat',
            input: 'question',
        })).rejects.toThrow('send failed after partial output')
        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })

        chat = mocks.dbState.db.characters[1].chats[0]
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'question',
            'replacement send',
        ])
    })

    it('replaces a differently sized reroll slice without overwriting the user message', async () => {
        const chat = mocks.dbState.db.characters[1].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push(
                    { role: 'char', data: 'old speaker A', saying: 'speaker-a' },
                    { role: 'char', data: 'old speaker B', saying: 'speaker-b' },
                )
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'short replacement', saying: 'speaker-a' })
                return true
            })

        await executeCanonicalSend({
            characterId: 'group-a',
            chatId: 'group-chat',
            input: 'question',
        })
        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'question',
            'short replacement',
        ])

        executeCanonicalUnreroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'question',
            'old speaker A',
            'old speaker B',
        ])

        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'question',
            'short replacement',
        ])
        expect(mocks.sendChat).toHaveBeenCalledTimes(2)
    })

    it('drops stale resident history instead of replacing a newly appended user message', async () => {
        const chat = mocks.dbState.db.characters[1].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push(
                    { role: 'char', data: 'old speaker A', saying: 'speaker-a' },
                    { role: 'char', data: 'old speaker B', saying: 'speaker-b' },
                )
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'short replacement', saying: 'speaker-a' })
                return true
            })

        await executeCanonicalSend({
            characterId: 'group-a',
            chatId: 'group-chat',
            input: 'question',
        })
        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        chat.message.push({ role: 'user', data: 'newer question' })
        const before = structuredClone(chat.message)

        executeCanonicalUnreroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })

        expect(chat.message).toEqual(before)
        expect(chat.message.at(-1)).toEqual({ role: 'user', data: 'newer question' })
    })

    it('drops reroll history when the canonical prefix changes under an identical tail', async () => {
        const chat = mocks.dbState.db.characters[1].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old answer', saying: 'speaker-a' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'new answer', saying: 'speaker-a' })
                return true
            })

        await executeCanonicalSend({
            characterId: 'group-a',
            chatId: 'group-chat',
            input: 'original question',
        })
        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        chat.message[0].data = 'edited question'
        const before = structuredClone(chat.message)

        executeCanonicalUnreroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })

        expect(chat.message).toEqual(before)
    })

    it('restores the previous response when a reroll returns no replacement', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockResolvedValueOnce(false)

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        const result = await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'edited:question',
            'old response',
        ])
        expect(result.currentLength).toBe(2)
    })

    it('restores the previous response when sendChat reports success without changing the base', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockResolvedValueOnce(true)

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        const result = await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'edited:question',
            'old response',
        ])
        expect(result.currentLength).toBe(2)
    })

    it('restores the previous response when a zero-output reroll throws', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockRejectedValueOnce(new Error('provider failed before output'))

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        await expect(executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })).rejects.toThrow('provider failed before output')

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'edited:question',
            'old response',
        ])
    })

    it('preserves failed-hook prefix edits while restoring the previous response tail', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message[0].data = 'plugin-edited question'
                return false
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'plugin-edited question',
            'old response',
        ])
    })

    it('rebases a partial failed reroll after a prefix edit without losing the old response', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message[0].data = 'plugin-edited question'
                chat.message.push({ role: 'char', data: 'partial replacement' })
                return false
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'plugin-edited question',
            'partial replacement',
        ])

        executeCanonicalUnreroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'plugin-edited question',
            'old response',
        ])
    })

    it('tracks an inserted prefix by identity when rebasing a partial failed reroll', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.unshift({ role: 'user', data: 'hook prefix insert' })
                chat.message.push({ role: 'char', data: 'partial replacement' })
                return false
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'hook prefix insert',
            'edited:question',
            'partial replacement',
        ])

        executeCanonicalUnreroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'hook prefix insert',
            'edited:question',
            'old response',
        ])
    })

    it('keeps all transcript data and clears history when a destructive prefix change loses the boundary', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.splice(0, 1)
                chat.message.push({ role: 'char', data: 'partial replacement' })
                return false
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.map((message: any) => message.data).sort()).toEqual([
            'old response',
            'partial replacement',
        ])
        const before = structuredClone(chat.message)
        executeCanonicalUnreroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message).toEqual(before)
    })

    it('rebases a partial throwing reroll after a prefix edit without losing the old response', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message[0].data = 'plugin-edited question'
                chat.message.push({ role: 'char', data: 'partial replacement' })
                throw new Error('provider failed after partial output')
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        await expect(executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })).rejects.toThrow('provider failed after partial output')
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'plugin-edited question',
            'partial replacement',
        ])

        executeCanonicalUnreroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'plugin-edited question',
            'old response',
        ])
    })

    it('relocates a moved old response ahead of a concurrent user suffix without duplication', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response', chatId: 'old-response' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'user', data: 'concurrent user turn' })
                chat.message.push({ role: 'char', data: 'old response', chatId: 'old-response' })
                return false
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'edited:question',
            'old response',
            'concurrent user turn',
        ])
        expect(chat.message.filter((message: any) => message.chatId === 'old-response')).toHaveLength(1)
    })

    it('does not delete an id-less retained prefix message that equals the old response', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        chat.message.push(
            { role: 'char', data: 'same response' },
            { role: 'user', data: 'question' },
            { role: 'char', data: 'same response' },
        )
        mocks.sendChat.mockResolvedValueOnce(false)

        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'same response',
            'question',
            'same response',
        ])
    })

    it('repairs duplicate imported message IDs before relocating an old response tail', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        chat.message.push(
            { role: 'char', data: 'retained prefix', chatId: 'duplicate-id' },
            { role: 'user', data: 'question', chatId: 'question-id' },
            { role: 'char', data: 'old response', chatId: 'duplicate-id' },
        )
        mocks.sendChat.mockResolvedValueOnce(false)

        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'retained prefix',
            'question',
            'old response',
        ])
        expect(new Set(chat.message.map((message: any) => message.chatId)).size).toBe(3)
    })

    it('relocates discontiguous group-tail fragments without duplicating either speaker', async () => {
        const chat = mocks.dbState.db.characters[1].chats[0]
        chat.message.push({ role: 'user', data: 'group question', chatId: 'group-user' })
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push(
                    { role: 'char', data: 'speaker A old', saying: 'a', chatId: 'old-a' },
                    { role: 'char', data: 'speaker B old', saying: 'b', chatId: 'old-b' },
                )
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push(
                    { role: 'char', data: 'speaker A old', saying: 'a', chatId: 'old-a' },
                    { role: 'user', data: 'concurrent group user', chatId: 'new-user' },
                    { role: 'char', data: 'speaker B old', saying: 'b', chatId: 'old-b' },
                )
                return false
            })

        await executeCanonicalGenerate({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'group question',
            'speaker A old',
            'speaker B old',
            'concurrent group user',
        ])
        expect(chat.message.filter((message: any) => message.chatId === 'old-a')).toHaveLength(1)
        expect(chat.message.filter((message: any) => message.chatId === 'old-b')).toHaveLength(1)
    })

    it('keeps a successful output-hook transcript truncation instead of restoring old messages', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.splice(0, chat.message.length)
                return true
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        const result = await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.message).toEqual([])
        expect(result).toEqual({ generated: true, previousLength: 1, currentLength: 0 })
        executeCanonicalUnreroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message).toEqual([])
    })

    it('keeps a partial failed reroll and can still restore the old response', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'partial replacement' })
                return false
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.at(-1)?.data).toBe('partial replacement')

        executeCanonicalUnreroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'edited:question',
            'old response',
        ])
    })

    it('keeps reroll history when a community trigger clones the chat before appending output', async () => {
        const character = mocks.dbState.db.characters[0]
        let chat = character.chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat = structuredClone(chat)
                character.chats[0] = chat
                chat.message.push({ role: 'char', data: 'trigger-cloned replacement' })
                return true
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.at(-1)?.data).toBe('trigger-cloned replacement')

        executeCanonicalUnreroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'edited:question',
            'old response',
        ])
    })

    it('re-resolves the live target when a trigger replaces the root database during reroll', async () => {
        let chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockImplementationOnce(async () => {
                mocks.dbState.db = structuredClone(mocks.dbState.db)
                chat = mocks.dbState.db.characters[0].chats[0]
                chat.message[0].data = 'root-replaced question'
                chat.message.push({ role: 'char', data: 'partial replacement' })
                return false
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'root-replaced question',
            'partial replacement',
        ])

        executeCanonicalUnreroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        chat = mocks.dbState.db.characters[0].chats[0]
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'root-replaced question',
            'old response',
        ])
    })

    it('restores the live target after a throwing trigger replaces the root database', async () => {
        let chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockImplementationOnce(async () => {
                mocks.dbState.db = structuredClone(mocks.dbState.db)
                chat = mocks.dbState.db.characters[0].chats[0]
                chat.message[0].data = 'root-replaced question'
                throw new Error('root replacement failure')
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        await expect(executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })).rejects.toThrow('root replacement failure')

        chat = mocks.dbState.db.characters[0].chats[0]
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'root-replaced question',
            'old response',
        ])
    })

    it('keeps a concurrent user suffix without sacrificing the old response on failed reroll', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'user', data: 'concurrent user turn' })
                return false
            })

        await executeCanonicalSend({
            characterId: 'character-a',
            chatId: 'chat-a',
            input: 'question',
        })
        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'edited:question',
            'old response',
            'concurrent user turn',
        ])
        const before = structuredClone(chat.message)
        executeCanonicalUnreroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        expect(chat.message).toEqual(before)
    })

    it('does not discard a concurrent user that reuses the removed response ID', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        chat.message.push({ role: 'user', data: 'question', chatId: 'question-id' })
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response', chatId: 'reused-id' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push({
                    role: 'user',
                    data: 'concurrent user turn',
                    chatId: 'reused-id',
                })
                return false
            })

        await executeCanonicalGenerate({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'question',
            'old response',
            'concurrent user turn',
        ])
        expect(new Set(chat.message.map((message: any) => message.chatId)).size).toBe(chat.message.length)
    })

    it('preserves a modified partial response that reuses the removed response ID', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        chat.message.push({ role: 'user', data: 'question', chatId: 'question-id' })
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({
                    role: 'char',
                    data: 'old response',
                    chatId: 'reused-id',
                    saying: 'speaker-a',
                })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push(
                    {
                        role: 'char',
                        data: 'modified partial response',
                        chatId: 'reused-id',
                        saying: 'speaker-a',
                    },
                    { role: 'user', data: 'concurrent user turn', chatId: 'concurrent-id' },
                )
                return false
            })

        await executeCanonicalGenerate({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'question',
            'old response',
            'modified partial response',
            'concurrent user turn',
        ])
        expect(new Set(chat.message.map((message: any) => message.chatId)).size).toBe(chat.message.length)
    })

    it('restores the old response before a concurrent user when a prefix anchor is deleted', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        chat.message.push(
            { role: 'char', data: 'older context', chatId: 'older-id' },
            { role: 'user', data: 'question', chatId: 'question-id' },
        )
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old response', chatId: 'old-id' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.splice(0, 1)
                chat.message.push({ role: 'user', data: 'concurrent user', chatId: 'new-user' })
                return false
            })

        await executeCanonicalGenerate({
            characterId: 'character-a',
            chatId: 'chat-a',
        })
        await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'question',
            'old response',
            'concurrent user',
        ])
    })

    it('records the complete group speaker slice from low-level generate calls', async () => {
        const chat = mocks.dbState.db.characters[1].chats[0]
        chat.message.push({ role: 'user', data: 'plugin question' })
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'old generated', saying: 'speaker-a' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push(
                    { role: 'char', data: 'new generated A', saying: 'speaker-a' },
                    { role: 'char', data: 'new generated B', saying: 'speaker-b' },
                    { role: 'char', data: 'new generated C', saying: 'speaker-c' },
                )
                return true
            })

        await executeCanonicalGenerate({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'plugin question',
            'new generated A',
            'new generated B',
            'new generated C',
        ])

        executeCanonicalUnreroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'plugin question',
            'old generated',
        ])

        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'plugin question',
            'new generated A',
            'new generated B',
            'new generated C',
        ])
    })

    it('records low-level generation from the live target after a DB root replacement', async () => {
        let chat = mocks.dbState.db.characters[1].chats[0]
        chat.message.push({ role: 'user', data: 'plugin question' })
        mocks.sendChat
            .mockImplementationOnce(async () => {
                mocks.dbState.db = structuredClone(mocks.dbState.db)
                chat = mocks.dbState.db.characters[1].chats[0]
                chat.message.push(
                    { role: 'char', data: 'old generated A', saying: 'speaker-a' },
                    { role: 'char', data: 'old generated B', saying: 'speaker-b' },
                )
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'new generated', saying: 'speaker-a' })
                return true
            })

        const generated = await executeCanonicalGenerate({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(generated.currentLength).toBe(3)
        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        chat = mocks.dbState.db.characters[1].chats[0]
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'plugin question',
            'new generated',
        ])

        executeCanonicalUnreroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'plugin question',
            'old generated A',
            'old generated B',
        ])
    })

    it('records partial low-level output before rethrowing a provider error', async () => {
        const chat = mocks.dbState.db.characters[1].chats[0]
        chat.message.push({ role: 'user', data: 'plugin question' })
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push(
                    { role: 'char', data: 'partial generate A', saying: 'speaker-a' },
                    { role: 'char', data: 'partial generate B', saying: 'speaker-b' },
                )
                throw new Error('generate failed after partial output')
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'replacement generate', saying: 'speaker-a' })
                return true
            })

        await expect(executeCanonicalGenerate({
            characterId: 'group-a',
            chatId: 'group-chat',
        })).rejects.toThrow('generate failed after partial output')
        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'plugin question',
            'replacement generate',
        ])
    })

    it('keeps auto iterations as consecutive turns and rerolls only the latest one', async () => {
        const chat = mocks.dbState.db.characters[1].chats[0]
        const controller = new AbortController()
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'auto one', saying: 'speaker-a' })
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push(
                    { role: 'char', data: 'auto two A', saying: 'speaker-a' },
                    { role: 'char', data: 'auto two B', saying: 'speaker-b' },
                    { role: 'char', data: 'auto two C', saying: 'speaker-c' },
                )
                controller.abort()
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'auto two rerolled', saying: 'speaker-a' })
                return true
            })

        await executeCanonicalAuto({
            characterId: 'group-a',
            chatId: 'group-chat',
            signal: controller.signal,
        })
        executeCanonicalUnreroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'auto one',
            'auto two A',
            'auto two B',
            'auto two C',
        ])

        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'auto one',
            'auto two rerolled',
        ])

        executeCanonicalUnreroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'auto one',
            'auto two A',
            'auto two B',
            'auto two C',
        ])
        expect(mocks.sendChat).toHaveBeenCalledTimes(3)
    })

    it('keeps auto iteration history on the live target across DB root replacements', async () => {
        let chat = mocks.dbState.db.characters[1].chats[0]
        const controller = new AbortController()
        mocks.sendChat
            .mockImplementationOnce(async () => {
                mocks.dbState.db = structuredClone(mocks.dbState.db)
                chat = mocks.dbState.db.characters[1].chats[0]
                chat.message.push({ role: 'char', data: 'auto live one', saying: 'speaker-a' })
                return true
            })
            .mockImplementationOnce(async () => {
                mocks.dbState.db = structuredClone(mocks.dbState.db)
                chat = mocks.dbState.db.characters[1].chats[0]
                chat.message.push(
                    { role: 'char', data: 'auto live two A', saying: 'speaker-a' },
                    { role: 'char', data: 'auto live two B', saying: 'speaker-b' },
                )
                controller.abort()
                return true
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'auto live rerolled', saying: 'speaker-a' })
                return true
            })

        const auto = await executeCanonicalAuto({
            characterId: 'group-a',
            chatId: 'group-chat',
            signal: controller.signal,
        })
        expect(auto).toEqual({ generated: true, previousLength: 0, currentLength: 3 })

        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        chat = mocks.dbState.db.characters[1].chats[0]
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'auto live one',
            'auto live rerolled',
        ])

        executeCanonicalUnreroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })
        expect(chat.message.map((message: any) => message.data)).toEqual([
            'auto live one',
            'auto live two A',
            'auto live two B',
        ])
    })

    it('records a partial auto iteration before rethrowing a provider error', async () => {
        const chat = mocks.dbState.db.characters[1].chats[0]
        const controller = new AbortController()
        mocks.sendChat
            .mockImplementationOnce(async () => {
                chat.message.push(
                    { role: 'char', data: 'partial auto A', saying: 'speaker-a' },
                    { role: 'char', data: 'partial auto B', saying: 'speaker-b' },
                )
                throw new Error('auto failed after partial output')
            })
            .mockImplementationOnce(async () => {
                chat.message.push({ role: 'char', data: 'replacement auto', saying: 'speaker-a' })
                return true
            })

        await expect(executeCanonicalAuto({
            characterId: 'group-a',
            chatId: 'group-chat',
            signal: controller.signal,
        })).rejects.toThrow('auto failed after partial output')
        await executeCanonicalReroll({
            characterId: 'group-a',
            chatId: 'group-chat',
        })

        expect(chat.message.map((message: any) => message.data)).toEqual([
            'replacement auto',
        ])
    })

    it('keeps an assistant-only chat unchanged when reroll has no safe boundary', async () => {
        const chat = mocks.dbState.db.characters[0].chats[0]
        chat.message.push({
            role: 'char',
            data: 'assistant-only response',
            saying: 'character-a',
        })
        const before = structuredClone(chat.message)

        const result = await executeCanonicalReroll({
            characterId: 'character-a',
            chatId: 'chat-a',
        })

        expect(chat.message).toEqual(before)
        expect(mocks.sendChat).not.toHaveBeenCalled()
        expect(result).toEqual({
            generated: false,
            previousLength: 1,
            currentLength: 1,
        })
    })
})
