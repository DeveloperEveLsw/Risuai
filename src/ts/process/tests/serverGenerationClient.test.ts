import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type MockDatabase = {
    language?: string
    username?: string
    presetRegex?: any[]
    characters: any[]
}

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json',
        },
    })
}

async function setupModule(database: MockDatabase) {
    vi.resetModules()

    const mockDBState = {
        db: database as any,
    }

    vi.doMock('src/ts/stores.svelte', () => ({
        DBState: mockDBState,
    }))
    vi.doMock('src/ts/platform', () => ({
        isNodeServer: true,
    }))
    vi.doMock('src/ts/storage/nodeStorage', () => ({
        NodeStorage: class {
            async getAuthHeader() {
                return 'test-auth'
            }
        },
    }))

    const mod = await import('../serverGeneration.svelte')
    return {
        mod,
        mockDBState,
    }
}

describe('serverGeneration live client flow', () => {
    const originalFetch = global.fetch

    beforeEach(() => {
        vi.restoreAllMocks()
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.resetModules()
        vi.clearAllMocks()
    })

    test('syncLiveChatDocumentsFromServer overlays root, character, and chat documents on reload', async () => {
        const { mod, mockDBState } = await setupModule({
            language: 'en',
            characters: [
                {
                    chaId: 'char-1',
                    name: 'Local Character',
                    chats: [],
                    chatFolders: [],
                    chatPage: 0,
                },
            ],
        })

        global.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            if (url === '/healthz') {
                return jsonResponse({ storage: 'postgres' })
            }
            if (url.includes('/api/live/root')) {
                return jsonResponse({
                    document: {
                        revision: 3,
                        payload: {
                            language: 'ko',
                            characters: [
                                {
                                    chaId: 'char-1',
                                    name: 'Remote Root Character',
                                    chats: [],
                                    chatFolders: [],
                                    chatPage: 0,
                                },
                            ],
                        },
                    },
                })
            }
            if (url.includes('/api/live/characters/character%3Achar-1')) {
                return jsonResponse({
                    document: {
                        revision: 4,
                        payload: {
                            chaId: 'char-1',
                            name: 'Remote Character',
                            firstMessage: 'hello',
                            desc: 'remote desc',
                            notes: '',
                            chats: [],
                            chatFolders: [],
                            chatPage: 0,
                            viewScreen: 'none',
                            bias: [],
                            emotionImages: [],
                            globalLore: [],
                            sdData: [],
                            customscript: [],
                            triggerscript: [],
                            utilityBot: false,
                            exampleMessage: '',
                            creatorNotes: '',
                            systemPrompt: '',
                            postHistoryInstructions: '',
                            alternateGreetings: [],
                            tags: [],
                            creator: '',
                            characterVersion: '',
                            personality: '',
                            scenario: '',
                            firstMsgIndex: 0,
                            additionalText: '',
                        },
                    },
                })
            }
            if (url.includes('/api/live/chats')) {
                return jsonResponse({
                    documents: [
                        {
                            document_key: 'chat:char-1:chat-1',
                            revision: 8,
                            payload: {
                                id: 'chat-1',
                                name: 'Remote Chat',
                                note: 'from server',
                                localLore: [],
                                message: [
                                    { role: 'user', data: 'hello', chatId: 'user-1' },
                                ],
                            },
                            metadata: {
                                lastJobStatus: 'completed',
                            },
                        },
                    ],
                })
            }
            throw new Error(`Unexpected fetch: ${url}`)
        }) as typeof fetch

        await mod.syncLiveChatDocumentsFromServer()

        expect(mockDBState.db.language).toBe('ko')
        expect(mockDBState.db.characters[0].name).toBe('Remote Character')
        expect(mockDBState.db.characters[0].chats).toHaveLength(1)
        expect(mockDBState.db.characters[0].chats[0].name).toBe('Remote Chat')
        expect(mod.getLiveChatMetadata('chat:char-1:chat-1')?.lastJobStatus).toBe('completed')
    })

    test('recoverLiveServerState replays missed terminal events after reconnect', async () => {
        const { mod, mockDBState } = await setupModule({
            language: 'en',
            characters: [
                {
                    chaId: 'char-1',
                    name: 'Character',
                    chats: [
                        {
                            id: 'chat-1',
                            name: 'Chat',
                            note: '',
                            localLore: [],
                            message: [{ role: 'char', data: '', chatId: 'assistant-1' }],
                            isStreaming: true,
                        },
                    ],
                    chatFolders: [],
                    chatPage: 0,
                },
            ],
        })
        let jobListCalls = 0

        global.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            if (url === '/healthz') {
                return jsonResponse({ storage: 'postgres' })
            }
            if (url.includes('/api/generation-jobs?status=queued,running')) {
                jobListCalls += 1
                return jsonResponse({
                    jobs: jobListCalls === 1
                        ? [
                            {
                                job_id: 'job-1',
                                session_key: 'database/database.bin',
                                chat_document_key: 'chat:char-1:chat-1',
                                status: 'running',
                            },
                        ]
                        : [],
                })
            }
            if (url.includes('/api/live/root')) {
                return jsonResponse({ error: 'not found' }, 404)
            }
            if (url.includes('/api/live/characters/character%3Achar-1')) {
                return jsonResponse({ error: 'not found' }, 404)
            }
            if (url.includes('/api/generation-jobs/job-1/events?after=0')) {
                return jsonResponse({
                    events: [
                        {
                            sequence_no: 2,
                            event_type: 'generation_completed',
                            payload: {
                                text: 'done',
                                model: 'gpt-test',
                            },
                        },
                    ],
                })
            }
            if (url.includes('/api/live/chats')) {
                return jsonResponse({
                    documents: [
                        {
                            document_key: 'chat:char-1:chat-1',
                            revision: 9,
                            payload: {
                                id: 'chat-1',
                                name: 'Chat',
                                note: '',
                                localLore: [],
                                message: [{ role: 'char', data: 'done', chatId: 'assistant-1' }],
                                isStreaming: false,
                            },
                            metadata: {
                                lastJobStatus: 'completed',
                                lastJobId: 'job-1',
                            },
                        },
                    ],
                })
            }
            throw new Error(`Unexpected fetch: ${url}`)
        }) as typeof fetch

        await mod.loadActiveServerGenerationJobs()
        await mod.recoverLiveServerState()

        expect(mod.getActiveServerJobForChat('char-1', 'chat-1')).toBe(null)
        expect(mockDBState.db.characters[0].chats[0].isStreaming).toBe(false)
        expect(mockDBState.db.characters[0].chats[0].message[0].data).toBe('done')
        expect(mod.getLiveChatMetadata('chat:char-1:chat-1')?.lastJobStatus).toBe('completed')
    })

    test('submitServerGenerationJob accepts duplicate submit responses without creating a second placeholder', async () => {
        const { mod, mockDBState } = await setupModule({
            language: 'en',
            characters: [
                {
                    chaId: 'char-1',
                    name: 'Character',
                    chats: [
                        {
                            id: 'chat-1',
                            name: 'Chat',
                            note: '',
                            localLore: [],
                            message: [{ role: 'user', data: 'hello', chatId: 'user-1' }],
                        },
                    ],
                    chatFolders: [],
                    chatPage: 0,
                },
            ],
        })

        global.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            if (url === '/api/generation-jobs') {
                return jsonResponse({
                    duplicated: true,
                    job: {
                        job_id: 'job-1',
                        session_key: 'database/database.bin',
                        chat_document_key: 'chat:char-1:chat-1',
                        status: 'running',
                    },
                    chat: {
                        document_key: 'chat:char-1:chat-1',
                        revision: 5,
                        payload: {
                            id: 'chat-1',
                            name: 'Chat',
                            note: '',
                            localLore: [],
                            message: [
                                { role: 'user', data: 'hello', chatId: 'user-1' },
                                { role: 'char', data: '', chatId: 'assistant-1' },
                            ],
                            isStreaming: true,
                        },
                        metadata: {
                            lastJobStatus: 'running',
                            activeJobId: 'job-1',
                        },
                    },
                })
            }
            throw new Error(`Unexpected fetch: ${url}`)
        }) as typeof fetch

        const result = await mod.submitServerGenerationJob({
            characterId: 'char-1',
            chatId: 'chat-1',
            chatSnapshot: mockDBState.db.characters[0].chats[0],
            userMessage: { role: 'user', data: 'hello', chatId: 'user-1' },
            assistantMessage: { role: 'char', data: '', chatId: 'assistant-1' },
            clientRequestId: 'assistant-1',
            provider: {
                type: 'openai-compatible',
                request: {
                    url: 'https://api.openai.com/v1/chat/completions',
                    headers: {},
                    body: {
                        messages: [],
                    },
                    stream: true,
                },
            },
        })

        expect(result.duplicated).toBe(true)
        expect(mockDBState.db.characters[0].chats[0].message).toHaveLength(2)
        expect(mod.getActiveServerJobForChat('char-1', 'chat-1')?.job_id).toBe('job-1')
    })

    test('ensureLiveServerSubscription applies multiple streamed chat updates', async () => {
        const { mod, mockDBState } = await setupModule({
            language: 'en',
            presetRegex: [
                {
                    type: 'editoutput',
                    in: 'foo',
                    out: 'foo!',
                },
            ],
            characters: [
                {
                    chaId: 'char-1',
                    name: 'Character',
                    chats: [
                        {
                            id: 'chat-1',
                            name: 'Chat',
                            note: '',
                            localLore: [],
                            message: [{ role: 'char', data: '', chatId: 'assistant-1' }],
                            isStreaming: true,
                        },
                    ],
                    chatFolders: [],
                    chatPage: 0,
                },
            ],
        })

        global.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            if (url === '/healthz') {
                return jsonResponse({ storage: 'postgres' })
            }
            if (url.startsWith('/api/live/events?session_key=')) {
                const encoder = new TextEncoder()
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode('event: ready\ndata: {"type":"ready","sessionKey":"database/database.bin"}\n\n'))
                        controller.enqueue(encoder.encode('event: chat_updated\ndata: {"type":"chat_updated","chatKey":"chat:char-1:chat-1","revision":2,"payload":{"id":"chat-1","name":"Chat","note":"","localLore":[],"message":[{"role":"char","data":"hello","chatId":"assistant-1"}],"isStreaming":true},"metadata":{"lastJobStatus":"running"}}\n\n'))
                        controller.enqueue(encoder.encode('event: chat_updated\ndata: {"type":"chat_updated","chatKey":"chat:char-1:chat-1","revision":3,"payload":{"id":"chat-1","name":"Chat","note":"","localLore":[],"message":[{"role":"char","data":"hello world","chatId":"assistant-1"}],"isStreaming":false},"metadata":{"lastJobStatus":"completed"}}\n\n'))
                        controller.close()
                    },
                }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'text/event-stream',
                    },
                })
            }
            throw new Error(`Unexpected fetch: ${url}`)
        }) as typeof fetch

        await mod.ensureLiveServerSubscription()
        mod.stopLiveServerSubscription()

        expect(mockDBState.db.characters[0].chats[0].message[0].data).toBe('hello world')
        expect(mockDBState.db.characters[0].chats[0].isStreaming).toBe(false)
        expect(mod.getLiveChatRevision('chat:char-1:chat-1')).toBe(3)
        expect(mod.getLiveChatMetadata('chat:char-1:chat-1')?.lastJobStatus).toBe('completed')
    })

    test('applyLiveChatDocument does not reapply local preset editoutput to server-mutated text', async () => {
        const { mod, mockDBState } = await setupModule({
            language: 'en',
            presetRegex: [
                {
                    type: 'editoutput',
                    in: 'foo',
                    out: 'foo!',
                },
            ],
            characters: [
                {
                    chaId: 'char-1',
                    name: 'Character',
                    chats: [
                        {
                            id: 'chat-1',
                            name: 'Chat',
                            note: '',
                            localLore: [],
                            message: [{ role: 'char', data: '', chatId: 'assistant-1' }],
                            isStreaming: true,
                        },
                    ],
                    chatFolders: [],
                    chatPage: 0,
                },
            ],
        })

        global.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
            if (url === '/healthz') {
                return jsonResponse({ storage: 'postgres' })
            }
            if (url.startsWith('/api/live/events?session_key=')) {
                const encoder = new TextEncoder()
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode('event: ready\ndata: {"type":"ready","sessionKey":"database/database.bin"}\n\n'))
                        controller.enqueue(encoder.encode('event: chat_updated\ndata: {"type":"chat_updated","chatKey":"chat:char-1:chat-1","revision":2,"payload":{"id":"chat-1","name":"Chat","note":"","localLore":[],"message":[{"role":"char","data":"foo!","chatId":"assistant-1","generationInfo":{"serverOutputMutators":{"presetEditOutput":true}}}],"isStreaming":false},"metadata":{"lastJobStatus":"completed"}}\n\n'))
                        controller.close()
                    },
                }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'text/event-stream',
                    },
                })
            }
            throw new Error(`Unexpected fetch: ${url}`)
        }) as typeof fetch

        await mod.ensureLiveServerSubscription()
        mod.stopLiveServerSubscription()

        expect(mockDBState.db.characters[0].chats[0].message[0].data).toBe('foo!')
    })
})
