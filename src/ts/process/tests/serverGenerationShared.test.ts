import { describe, expect, test } from 'vitest'

import {
    buildGenerationSubmitChat,
    extractServerSafePresetEditOutputRegex,
    getServerGenerationCompatibilityReport,
    getServerGenerationPolicyError,
    inferPreparedRequestStream,
    inferServerGenerationProvider,
    isServerSafePresetEditOutputRegex,
    mergeChatsForLivePatch,
} from '../serverGenerationShared'

describe('serverGenerationShared', () => {
    test('buildGenerationSubmitChat preserves existing assistant output without duplicating placeholder', () => {
        const merged = buildGenerationSubmitChat(
            {
                id: 'chat-1',
                message: [
                    { role: 'user', data: 'hello', chatId: 'user-1' },
                    { role: 'char', data: 'partial reply', chatId: 'assistant-1' },
                ],
                note: '',
                name: 'Chat',
                localLore: [],
            },
            {
                id: 'chat-1',
                message: [
                    { role: 'user', data: 'hello', chatId: 'user-1' },
                    { role: 'char', data: '', chatId: 'assistant-1' },
                ],
                note: '',
                name: 'Chat',
                localLore: [],
            },
            { role: 'user', data: 'hello', chatId: 'user-1' },
            { role: 'char', data: '', chatId: 'assistant-1' }
        )

        expect(merged.isStreaming).toBe(true)
        expect(merged.message).toHaveLength(2)
        expect(merged.message[1].data).toBe('partial reply')
    })

    test('mergeChatsForLivePatch keeps local unsynced messages while preserving non-empty server text', () => {
        const merged = mergeChatsForLivePatch(
            {
                id: 'chat-1',
                message: [
                    { role: 'user', data: 'server user', chatId: 'user-1' },
                    { role: 'char', data: 'server reply', chatId: 'assistant-1' },
                ],
                note: 'server note',
                name: 'Server Chat',
                localLore: [],
            },
            {
                id: 'chat-1',
                message: [
                    { role: 'user', data: 'server user', chatId: 'user-1' },
                    { role: 'char', data: '', chatId: 'assistant-1' },
                    { role: 'user', data: 'local unsynced', chatId: 'user-2' },
                ],
                note: 'local note',
                name: 'Local Chat',
                localLore: [],
            }
        )

        expect(merged.note).toBe('local note')
        expect(merged.name).toBe('Local Chat')
        expect(merged.message.map((message) => message.chatId)).toEqual(['user-1', 'assistant-1', 'user-2'])
        expect(merged.message[1].data).toBe('server reply')
    })

    test('mergeChatsForLivePatch preserves remote scalar edits when the local payload did not change them', () => {
        const merged = mergeChatsForLivePatch(
            {
                id: 'chat-1',
                message: [{ role: 'user', data: 'hello', chatId: 'user-1' }],
                note: 'server note',
                name: 'server name',
                localLore: [{ key: 'remote', secondkey: '', insertorder: 0, comment: '', content: 'remote', mode: 'normal', alwaysActive: false, selective: false }],
                bookmarks: ['assistant-1'],
                bookmarkNames: {
                    'assistant-1': 'Remote bookmark',
                },
            },
            {
                id: 'chat-1',
                message: [{ role: 'user', data: 'hello', chatId: 'user-1' }],
                note: 'local note',
                name: 'base name',
                localLore: [],
                bookmarks: [],
                bookmarkNames: {},
            },
            {
                id: 'chat-1',
                message: [{ role: 'user', data: 'hello', chatId: 'user-1' }],
                note: 'local note',
                name: 'base name',
                localLore: [],
                bookmarks: [],
                bookmarkNames: {},
            }
        )

        expect(merged.note).toBe('server note')
        expect(merged.name).toBe('server name')
        expect(merged.bookmarks).toEqual(['assistant-1'])
        expect(merged.bookmarkNames).toEqual({
            'assistant-1': 'Remote bookmark',
        })
    })

    test('inferServerGenerationProvider classifies supported request families', () => {
        expect(inferServerGenerationProvider({
            url: 'https://api.anthropic.com/v1/messages',
            headers: {
                'anthropic-version': '2023-06-01',
            },
            body: {
                messages: [],
            },
        })?.type).toBe('anthropic')

        expect(inferServerGenerationProvider({
            url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0:streamGenerateContent?alt=sse',
            headers: {},
            body: {
                contents: [],
            },
        })).toMatchObject({
            type: 'google',
            request: {
                stream: true,
            },
        })

        expect(inferServerGenerationProvider({
            url: 'https://api.openai.com/v1/chat/completions',
            headers: {
                authorization: 'Bearer test',
            },
            body: {
                messages: [],
            },
        })?.type).toBe('openai-compatible')
    })

    test('inferPreparedRequestStream detects SSE urls even without body.stream', () => {
        expect(inferPreparedRequestStream({
            url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0:streamGenerateContent?alt=sse',
            headers: {},
            body: {
                contents: [],
            },
            stream: false,
        })).toBe(true)

        expect(inferPreparedRequestStream({
            url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0:generateContent',
            headers: {},
            body: {
                contents: [],
            },
        })).toBe(false)
    })

    test('getServerGenerationPolicyError rejects output hooks and tool calling payloads', () => {
        expect(getServerGenerationPolicyError({
            currentChar: {
                customscript: [],
                triggerscript: [{ type: 'output' } as any],
            },
            pluginState: {
                hasProviderPlugin: false,
                hasEditOutputPlugin: false,
                hasAfterRequestPlugin: false,
            },
            presetRegex: [],
            preparedRequest: {
                url: 'https://api.openai.com/v1/chat/completions',
                headers: {},
                body: {
                    messages: [],
                },
            },
        })).toBe('Server-owned generation is not compatible with output triggers.')

        expect(getServerGenerationPolicyError({
            currentChar: {
                customscript: [],
                triggerscript: [],
            },
            pluginState: {
                hasProviderPlugin: false,
                hasEditOutputPlugin: false,
                hasAfterRequestPlugin: false,
            },
            presetRegex: [],
            preparedRequest: {
                url: 'https://api.openai.com/v1/chat/completions',
                headers: {},
                body: {
                    messages: [],
                    tools: [{ type: 'function' }],
                },
            },
        })).toBe('Server-owned generation does not support tool-calling requests yet.')
    })

    test('getServerGenerationPolicyError allows built-in requests even when plugin metadata is stale elsewhere', () => {
        expect(getServerGenerationPolicyError({
            currentChar: {
                customscript: [],
                triggerscript: [],
            },
            pluginState: {
                hasProviderPlugin: false,
                hasEditOutputPlugin: false,
                hasAfterRequestPlugin: false,
            },
            presetRegex: [
                { type: 'editprocess' } as any,
                { type: 'editdisplay' } as any,
            ],
            preparedRequest: {
                url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0:streamGenerateContent?alt=sse',
                headers: {},
                body: {
                    contents: [],
                },
            },
        })).toBe(null)
    })

    test('getServerGenerationPolicyError allows server-safe preset editoutput regex', () => {
        expect(getServerGenerationPolicyError({
            currentChar: {
                customscript: [],
                triggerscript: [],
            },
            pluginState: {
                hasProviderPlugin: false,
                hasEditOutputPlugin: false,
                hasAfterRequestPlugin: false,
            },
            presetRegex: [
                {
                    type: 'editoutput',
                    in: '<!-- #End of previous response -->',
                    out: '',
                } as any,
            ],
            preparedRequest: {
                url: 'https://api.openai.com/v1/chat/completions',
                headers: {},
                body: {
                    messages: [],
                },
            },
        })).toBe(null)
    })

    test('getServerGenerationPolicyError rejects unsupported preset editoutput regex', () => {
        expect(getServerGenerationPolicyError({
            currentChar: {
                customscript: [],
                triggerscript: [],
            },
            pluginState: {
                hasProviderPlugin: false,
                hasEditOutputPlugin: false,
                hasAfterRequestPlugin: false,
            },
            presetRegex: [
                {
                    type: 'editoutput',
                    in: '(.+)',
                    out: '@@move_top $1',
                } as any,
            ],
            preparedRequest: {
                url: 'https://api.openai.com/v1/chat/completions',
                headers: {},
                body: {
                    messages: [],
                },
            },
        })).toBe('Server-owned generation is not compatible with preset editoutput regex.')
    })

    test('extractServerSafePresetEditOutputRegex keeps only plain regex replacements', () => {
        const scripts = extractServerSafePresetEditOutputRegex([
            {
                type: 'editoutput',
                in: '<stats>',
                out: '<stats>',
            } as any,
            {
                type: 'editoutput',
                in: '(.+)',
                out: '@@inject $1',
            } as any,
            {
                type: 'editprocess',
                in: 'x',
                out: 'y',
            } as any,
            {
                type: 'editoutput',
                in: 'foo',
                out: '{{char}}',
            } as any,
        ])

        expect(scripts).toEqual([
            {
                type: 'editoutput',
                in: '<stats>',
                out: '<stats>',
            },
        ])
        expect(isServerSafePresetEditOutputRegex(scripts[0] as any)).toBe(true)
    })

    test('getServerGenerationCompatibilityReport distinguishes request transforms from plugin executors', () => {
        expect(getServerGenerationCompatibilityReport({
            currentChar: {
                customscript: [],
                triggerscript: [],
            },
            pluginState: {
                hasProviderPlugin: false,
                hasEditOutputPlugin: false,
                hasAfterRequestPlugin: false,
            },
            presetRegex: [
                { type: 'editprocess' } as any,
                { type: 'editdisplay' } as any,
            ],
            preparedRequest: {
                url: 'https://api.openai.com/v1/chat/completions',
                headers: {},
                body: {
                    messages: [],
                },
            },
        })).toMatchObject({
            executionOwner: 'builtin-http',
            hasRequestMutators: true,
            hasDisplayMutators: true,
            hasResponseMutators: false,
            blockers: [],
        })

        expect(getServerGenerationCompatibilityReport({
            currentChar: {
                customscript: [],
                triggerscript: [],
            },
            pluginState: {
                hasProviderPlugin: true,
                hasEditOutputPlugin: false,
                hasAfterRequestPlugin: false,
            },
            presetRegex: [],
            preparedRequest: {
                url: 'https://api.openai.com/v1/chat/completions',
                headers: {},
                body: {
                    messages: [],
                },
            },
        }).executionOwner).toBe('plugin-executor')
    })
})
