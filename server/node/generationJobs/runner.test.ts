import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { GenerationRunner } = require('./runner.cjs')
const { validateProviderRequest } = require('./providers/index.cjs')

describe('GenerationRunner', () => {
    const originalFetch = global.fetch

    beforeEach(() => {
        global.fetch = vi.fn(async () => {
            const encoder = new TextEncoder()
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'))
                    controller.close()
                },
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                },
            })
        }) as typeof fetch
    })

    afterEach(() => {
        global.fetch = originalFetch
        vi.restoreAllMocks()
    })

    test('validateProviderRequest rejects unsupported tool-calling bodies', () => {
        expect(validateProviderRequest({
            type: 'openai-compatible',
            request: {
                url: 'https://api.openai.com/v1/chat/completions',
                body: {
                    messages: [],
                    tools: [{ type: 'function' }],
                },
            },
        })).toBe('Server-owned generation does not support tool-calling requests yet.')
    })

    test('run accumulates multiple streaming chunks before completion', async () => {
        const encoder = new TextEncoder()
        global.fetch = vi.fn(async () => {
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'))
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n\n'))
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                    controller.close()
                },
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                },
            })
        }) as typeof fetch

        let sequence = 0
        const patches: string[] = []
        const job = {
            job_id: 'job-1',
            status: 'queued',
            session_key: 'session-1',
            request_payload: {
                provider: {
                    type: 'openai-compatible',
                    request: {
                        url: 'https://api.openai.com/v1/chat/completions',
                        method: 'POST',
                        headers: {},
                        body: {
                            stream: true,
                            messages: [],
                        },
                        stream: true,
                    },
                },
                target: {
                    characterId: 'character-1',
                    chatId: 'chat-1',
                    assistantMessageChatId: 'assistant-1',
                },
            },
        }

        const jobRepository = {
            getJob: vi.fn(async () => ({ ...job, cancel_requested_at: null })),
            updateJobStatus: vi.fn(async (_jobId, status, patch) => ({
                ...job,
                status,
                ...patch,
            })),
            appendEvent: vi.fn(async () => ({
                sequence_no: ++sequence,
            })),
        }

        const chatService = {
            patchChatDocument: vi.fn(async ({ mutate }) => {
                const chatPayload = {
                    message: [
                        { role: 'char', data: '', chatId: 'assistant-1' },
                    ],
                    isStreaming: false,
                }
                mutate(chatPayload)
                patches.push(chatPayload.message[0].data)
                return {
                    document: {
                        revision: sequence + 1,
                    },
                }
            }),
            constructor: {
                ensureMessageArray(chatPayload) {
                    chatPayload.message ??= []
                    return chatPayload.message
                },
            },
        }

        const runner = new GenerationRunner({
            jobRepository,
            chatService,
            eventHub: {
                publish: vi.fn(),
            },
        })

        await runner.run(job.job_id)

        expect(patches).toContain('hello')
        expect(patches).toContain('hello world')
        expect(jobRepository.updateJobStatus).toHaveBeenCalledWith(job.job_id, 'completed', expect.objectContaining({
            resultPayload: {
                text: 'hello world',
                model: null,
            },
        }))
    })

    test('run applies server-safe preset editoutput regex before publishing snapshots', async () => {
        const encoder = new TextEncoder()
        global.fetch = vi.fn(async () => {
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"alpha<stats>beta<!-- #End of previous response -->"}}]}\n\n'))
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                    controller.close()
                },
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                },
            })
        }) as typeof fetch

        let sequence = 0
        const patches: string[] = []
        const job = {
            job_id: 'job-1',
            status: 'queued',
            session_key: 'session-1',
            request_payload: {
                provider: {
                    type: 'openai-compatible',
                    request: {
                        url: 'https://api.openai.com/v1/chat/completions',
                        method: 'POST',
                        headers: {},
                        body: {
                            stream: true,
                            messages: [],
                        },
                        stream: true,
                    },
                },
                outputMutators: {
                    presetEditOutputRegex: [
                        {
                            type: 'editoutput',
                            in: '(<stats>)([^\\n])',
                            out: '$1$n$2',
                        },
                        {
                            type: 'editoutput',
                            in: '([^\\n])<stats>',
                            out: '$1$n<stats>',
                        },
                        {
                            type: 'editoutput',
                            in: '<!-- #End of previous response -->',
                            out: '',
                        },
                    ],
                },
                target: {
                    characterId: 'character-1',
                    chatId: 'chat-1',
                    assistantMessageChatId: 'assistant-1',
                },
            },
        }

        const jobRepository = {
            getJob: vi.fn(async () => ({ ...job, cancel_requested_at: null })),
            updateJobStatus: vi.fn(async (_jobId, status, patch) => ({
                ...job,
                status,
                ...patch,
            })),
            appendEvent: vi.fn(async () => ({
                sequence_no: ++sequence,
            })),
        }

        const chatService = {
            patchChatDocument: vi.fn(async ({ mutate }) => {
                const chatPayload = {
                    message: [
                        { role: 'char', data: '', chatId: 'assistant-1' },
                    ],
                    isStreaming: false,
                }
                mutate(chatPayload)
                patches.push(chatPayload.message[0].data)
                return {
                    document: {
                        revision: sequence + 1,
                    },
                }
            }),
            constructor: {
                ensureMessageArray(chatPayload) {
                    chatPayload.message ??= []
                    return chatPayload.message
                },
            },
        }

        const runner = new GenerationRunner({
            jobRepository,
            chatService,
            eventHub: {
                publish: vi.fn(),
            },
        })

        await runner.run(job.job_id)

        expect(patches).toContain('alpha\n<stats>\n\nbeta')
        expect(jobRepository.updateJobStatus).toHaveBeenCalledWith(job.job_id, 'completed', expect.objectContaining({
            resultPayload: {
                text: 'alpha\n<stats>\n\nbeta',
                model: null,
            },
        }))
    })

    test('run marks a job as cancelled when cancel is observed during streaming', async () => {
        let sequence = 0
        let readCount = 0
        const job = {
            job_id: 'job-1',
            status: 'queued',
            session_key: 'session-1',
            request_payload: {
                provider: {
                    type: 'openai-compatible',
                    request: {
                        url: 'https://api.openai.com/v1/chat/completions',
                        method: 'POST',
                        headers: {},
                        body: {
                            stream: true,
                            messages: [],
                        },
                        stream: true,
                    },
                },
                target: {
                    characterId: 'character-1',
                    chatId: 'chat-1',
                    assistantMessageChatId: 'assistant-1',
                },
            },
        }

        const jobRepository = {
            getJob: vi.fn(async () => {
                readCount += 1
                if (readCount >= 2) {
                    return {
                        ...job,
                        cancel_requested_at: new Date().toISOString(),
                    }
                }
                return { ...job, cancel_requested_at: null }
            }),
            updateJobStatus: vi.fn(async (_jobId, status, patch) => ({
                ...job,
                status,
                ...patch,
            })),
            appendEvent: vi.fn(async () => ({
                sequence_no: ++sequence,
            })),
        }

        const chatService = {
            patchChatDocument: vi.fn(async () => ({
                document: {
                    revision: 1,
                },
            })),
        }

        const eventHub = {
            publish: vi.fn(),
        }

        const runner = new GenerationRunner({
            jobRepository,
            chatService,
            eventHub,
        })

        await runner.run(job.job_id)

        expect(jobRepository.updateJobStatus).toHaveBeenCalledWith(job.job_id, 'running', expect.any(Object))
        expect(jobRepository.updateJobStatus).toHaveBeenCalledWith(job.job_id, 'cancelled', expect.objectContaining({
            finishedAt: expect.any(Date),
        }))
        expect(chatService.patchChatDocument).toHaveBeenCalled()
    })

    test('run treats Gemini SSE urls as streaming even when the request stream flag is false', async () => {
        const encoder = new TextEncoder()
        global.fetch = vi.fn(async () => {
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}]}\n\n'))
                    controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}\n\n'))
                    controller.close()
                },
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                },
            })
        }) as typeof fetch

        let sequence = 0
        const patches: string[] = []
        const job = {
            job_id: 'job-1',
            status: 'queued',
            session_key: 'session-1',
            request_payload: {
                provider: {
                    type: 'google',
                    request: {
                        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0:streamGenerateContent?alt=sse',
                        method: 'POST',
                        headers: {},
                        body: {
                            contents: [],
                        },
                        stream: false,
                    },
                },
                target: {
                    characterId: 'character-1',
                    chatId: 'chat-1',
                    assistantMessageChatId: 'assistant-1',
                },
            },
        }

        const jobRepository = {
            getJob: vi.fn(async () => ({ ...job, cancel_requested_at: null })),
            updateJobStatus: vi.fn(async (_jobId, status, patch) => ({
                ...job,
                status,
                ...patch,
            })),
            appendEvent: vi.fn(async () => ({
                sequence_no: ++sequence,
            })),
        }

        const chatService = {
            patchChatDocument: vi.fn(async ({ mutate }) => {
                const chatPayload = {
                    message: [
                        { role: 'char', data: '', chatId: 'assistant-1' },
                    ],
                    isStreaming: false,
                }
                mutate(chatPayload)
                patches.push(chatPayload.message[0].data)
                return {
                    document: {
                        revision: sequence + 1,
                    },
                }
            }),
            constructor: {
                ensureMessageArray(chatPayload) {
                    chatPayload.message ??= []
                    return chatPayload.message
                },
            },
        }

        const runner = new GenerationRunner({
            jobRepository,
            chatService,
            eventHub: {
                publish: vi.fn(),
            },
        })

        await runner.run(job.job_id)

        expect(patches).toContain('hello')
        expect(patches).toContain('hello world')
        expect(jobRepository.updateJobStatus).toHaveBeenCalledWith(job.job_id, 'completed', expect.objectContaining({
            resultPayload: {
                text: 'hello world',
                model: null,
            },
        }))
    })

    test('run mirrors Gemini thought accumulation like the client stream parser', async () => {
        const encoder = new TextEncoder()
        global.fetch = vi.fn(async () => {
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"reason 1","thought":true}]}}]}\n\n'))
                    controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"reason 2","thought":true}]}}]}\n\n'))
                    controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"answer"}]}}]}\n\n'))
                    controller.close()
                },
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                },
            })
        }) as typeof fetch

        let sequence = 0
        const patches: string[] = []
        const job = {
            job_id: 'job-1',
            status: 'queued',
            session_key: 'session-1',
            request_payload: {
                provider: {
                    type: 'google',
                    request: {
                        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0:streamGenerateContent?alt=sse',
                        method: 'POST',
                        headers: {},
                        body: {
                            contents: [],
                        },
                        stream: true,
                    },
                },
                target: {
                    characterId: 'character-1',
                    chatId: 'chat-1',
                    assistantMessageChatId: 'assistant-1',
                },
            },
        }

        const jobRepository = {
            getJob: vi.fn(async () => ({ ...job, cancel_requested_at: null })),
            updateJobStatus: vi.fn(async (_jobId, status, patch) => ({
                ...job,
                status,
                ...patch,
            })),
            appendEvent: vi.fn(async () => ({
                sequence_no: ++sequence,
            })),
        }

        const chatService = {
            patchChatDocument: vi.fn(async ({ mutate }) => {
                const chatPayload = {
                    message: [
                        { role: 'char', data: '', chatId: 'assistant-1' },
                    ],
                    isStreaming: false,
                }
                mutate(chatPayload)
                patches.push(chatPayload.message[0].data)
                return {
                    document: {
                        revision: sequence + 1,
                    },
                }
            }),
            constructor: {
                ensureMessageArray(chatPayload) {
                    chatPayload.message ??= []
                    return chatPayload.message
                },
            },
        }

        const runner = new GenerationRunner({
            jobRepository,
            chatService,
            eventHub: {
                publish: vi.fn(),
            },
        })

        await runner.run(job.job_id)

        expect(patches).toContain('<Thoughts>\n\nreason 1reason 2\n\n</Thoughts>\n\n')
        expect(patches).toContain('<Thoughts>\n\nreason 1reason 2\n\n</Thoughts>\n\nanswer')
        expect(jobRepository.updateJobStatus).toHaveBeenCalledWith(job.job_id, 'completed', expect.objectContaining({
            resultPayload: {
                text: '<Thoughts>\n\nreason 1reason 2\n\n</Thoughts>\n\nanswer',
                model: null,
            },
        }))
    })

    test('run respects streamGeminiThoughts when serializing Gemini streams', async () => {
        const encoder = new TextEncoder()
        global.fetch = vi.fn(async () => {
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"reason 1","thought":true}]}}]}\n\n'))
                    controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"reason 2","thought":true}]}}]}\n\n'))
                    controller.enqueue(encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"answer"}]}}]}\n\n'))
                    controller.close()
                },
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'text/event-stream',
                },
            })
        }) as typeof fetch

        let sequence = 0
        const patches: string[] = []
        const job = {
            job_id: 'job-1',
            status: 'queued',
            session_key: 'session-1',
            request_payload: {
                provider: {
                    type: 'google',
                    request: {
                        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0:streamGenerateContent?alt=sse',
                        method: 'POST',
                        headers: {},
                        body: {
                            contents: [],
                        },
                        stream: true,
                    },
                    streamOptions: {
                        streamGeminiThoughts: true,
                    },
                },
                target: {
                    characterId: 'character-1',
                    chatId: 'chat-1',
                    assistantMessageChatId: 'assistant-1',
                },
            },
        }

        const jobRepository = {
            getJob: vi.fn(async () => ({ ...job, cancel_requested_at: null })),
            updateJobStatus: vi.fn(async (_jobId, status, patch) => ({
                ...job,
                status,
                ...patch,
            })),
            appendEvent: vi.fn(async () => ({
                sequence_no: ++sequence,
            })),
        }

        const chatService = {
            patchChatDocument: vi.fn(async ({ mutate }) => {
                const chatPayload = {
                    message: [
                        { role: 'char', data: '', chatId: 'assistant-1' },
                    ],
                    isStreaming: false,
                }
                mutate(chatPayload)
                patches.push(chatPayload.message[0].data)
                return {
                    document: {
                        revision: sequence + 1,
                    },
                }
            }),
            constructor: {
                ensureMessageArray(chatPayload) {
                    chatPayload.message ??= []
                    return chatPayload.message
                },
            },
        }

        const runner = new GenerationRunner({
            jobRepository,
            chatService,
            eventHub: {
                publish: vi.fn(),
            },
        })

        await runner.run(job.job_id)

        expect(patches).toContain('<Thoughts>\n\nreason 1\n\n</Thoughts>\n\nreason 2\n\n')
        expect(patches).not.toContain('<Thoughts>\n\nreason 1reason 2\n\n</Thoughts>\n\n')
        expect(patches).toContain('<Thoughts>\n\nreason 1reason 2\n\n</Thoughts>\n\nanswer')
    })
})
