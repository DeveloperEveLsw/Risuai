import { describe, expect, it } from 'vitest'

import {
    ProxyJobStreamProtocolError,
    createProxyJobStreamCursorState,
    decodeProxyJobWsChunk,
    formatProxyStreamErrorMessage,
    parseProxyJobReplayPage,
    parseProxyJobWsEvent,
    reduceProxyJobStreamEvent,
    type ProxyJobChunkEvent,
    type ProxyJobStreamCursorState,
} from './proxyJobWs'

const base64 = (value: string) => Buffer.from(value, 'utf-8').toString('base64')

describe('parseProxyJobWsEvent', () => {
    it('preserves valid legacy proxy job events', () => {
        expect(parseProxyJobWsEvent(JSON.stringify({
            type: 'job_accepted',
            jobId: 'job-1',
        }))).toEqual({ type: 'job_accepted', jobId: 'job-1' })

        expect(parseProxyJobWsEvent(JSON.stringify({
            type: 'chunk',
            dataBase64: base64('hello'),
        }))).toEqual({ type: 'chunk', dataBase64: base64('hello') })

        expect(parseProxyJobWsEvent(JSON.stringify({ type: 'done' }))).toEqual({ type: 'done' })
    })

    it('parses typed durable events', () => {
        expect(parseProxyJobWsEvent(JSON.stringify({
            type: 'job_snapshot',
            jobId: 'job-1',
            state: 'running',
            lastSequence: 4,
            cursor: 5,
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        }))).toMatchObject({ type: 'job_snapshot', lastSequence: 4, cursor: 5 })

        expect(parseProxyJobWsEvent(JSON.stringify({
            type: 'chunk',
            sequence: 5,
            offset: 5,
            endOffset: 10,
            dataBase64: base64('world'),
        }))).toMatchObject({ type: 'chunk', sequence: 5, offset: 5, endOffset: 10 })

        expect(parseProxyJobWsEvent(JSON.stringify({
            type: 'done',
            sequence: 6,
            finalSequence: 6,
            finalOffset: 10,
        }))).toMatchObject({ type: 'done', finalOffset: 10 })
    })

    it('returns null for unknown, malformed, or structurally invalid events', () => {
        const invalid = [
            'not-json',
            JSON.stringify({ nope: 1 }),
            JSON.stringify({ type: 'unknown' }),
            JSON.stringify({ type: 'job_accepted', jobId: '' }),
            JSON.stringify({ type: 'upstream_headers', status: 200, headers: { bad: 1 } }),
            JSON.stringify({ type: 'chunk', dataBase64: 'not base64' }),
            JSON.stringify({ type: 'chunk', dataBase64: base64('a'), offset: -1 }),
            JSON.stringify({ type: 'chunk', dataBase64: base64('a'), endOffset: 1 }),
            JSON.stringify({ type: 'chunk', dataBase64: base64('a'), offset: 2, endOffset: 1 }),
            JSON.stringify({ type: 'chunk', dataBase64: base64('a'), offset: 2, endOffset: 4 }),
            JSON.stringify({ type: 'error', message: 1 }),
            JSON.stringify({ type: 'done', finalOffset: 1.5 }),
            JSON.stringify({ type: 'ping', ts: Number.NaN }),
            JSON.stringify({ type: 'job_snapshot', jobId: 'job-1', state: 'mystery', lastSequence: 0 }),
        ]

        for (const value of invalid) {
            expect(parseProxyJobWsEvent(value)).toBeNull()
        }
    })
})

describe('parseProxyJobReplayPage', () => {
    it('validates a complete replay page and its nested events', () => {
        const page = parseProxyJobReplayPage({
            events: [
                { type: 'upstream_headers', sequence: 1, status: 200, headers: {} },
                { type: 'chunk', sequence: 2, offset: 0, dataBase64: base64('abc') },
            ],
            nextCursor: 2,
            hasMore: false,
        })

        expect(page?.events).toHaveLength(2)
        expect(page?.nextCursor).toBe(2)
    })

    it('rejects invalid cursors and any invalid nested event', () => {
        expect(parseProxyJobReplayPage({ events: [], nextCursor: -1, hasMore: false })).toBeNull()
        expect(parseProxyJobReplayPage({
            events: [{ type: 'chunk', dataBase64: 'bad' }],
            nextCursor: 0,
            hasMore: false,
        })).toBeNull()
    })
})

describe('decodeProxyJobWsChunk', () => {
    it('decodes canonical base64 payload into bytes', () => {
        const bytes = decodeProxyJobWsChunk(base64('abc'))
        expect(new TextDecoder().decode(bytes)).toBe('abc')
    })

    it('rejects malformed and non-canonical base64', () => {
        expect(() => decodeProxyJobWsChunk('%%%')).toThrow('Invalid proxy stream base64 payload')
        expect(() => decodeProxyJobWsChunk('YQ')).toThrow('Invalid proxy stream base64 payload')
    })
})

describe('reduceProxyJobStreamEvent', () => {
    const chunk = (offset: number, value: string, endOffset?: number): ProxyJobChunkEvent => ({
        type: 'chunk',
        offset,
        ...(endOffset === undefined ? {} : { endOffset }),
        dataBase64: base64(value),
    })

    const errorCode = (fn: () => unknown) => {
        try {
            fn()
        } catch (error) {
            expect(error).toBeInstanceOf(ProxyJobStreamProtocolError)
            return (error as ProxyJobStreamProtocolError).code
        }
        throw new Error('Expected ProxyJobStreamProtocolError')
    }

    it('accepts only the exact next chunk and advances by decoded bytes', () => {
        const initial = createProxyJobStreamCursorState()
        const first = reduceProxyJobStreamEvent(initial, chunk(0, 'abc'))

        expect(first.action).toBe('append')
        expect(first.state).toEqual({ cursor: 3, terminal: null })
        expect(initial).toEqual({ cursor: 0, terminal: null })
        if (first.action === 'append') {
            expect(new TextDecoder().decode(first.bytes)).toBe('abc')
        }

        const second = reduceProxyJobStreamEvent(first.state, chunk(3, 'de', 5))
        expect(second.action).toBe('append')
        expect(second.state.cursor).toBe(5)
    })

    it('keeps legacy offset-less live chunks compatible', () => {
        const state = createProxyJobStreamCursorState(4)
        const result = reduceProxyJobStreamEvent(state, {
            type: 'chunk',
            dataBase64: base64('xy'),
        })

        expect(result.action).toBe('append')
        expect(result.state.cursor).toBe(6)
    })

    it('skips a fully duplicated range without moving the cursor', () => {
        const state: ProxyJobStreamCursorState = { cursor: 8, terminal: null }

        expect(reduceProxyJobStreamEvent(state, chunk(0, 'abc')).action).toBe('skip_duplicate')
        expect(reduceProxyJobStreamEvent(state, chunk(5, 'xyz')).state.cursor).toBe(8)
    })

    it('rejects gaps and partial overlaps', () => {
        const state: ProxyJobStreamCursorState = { cursor: 5, terminal: null }

        expect(errorCode(() => reduceProxyJobStreamEvent(state, chunk(6, 'x')))).toBe('gap')
        expect(errorCode(() => reduceProxyJobStreamEvent(state, chunk(3, 'abcd')))).toBe('partial_overlap')
    })

    it('rejects a declared end offset that disagrees with decoded length', () => {
        const state = createProxyJobStreamCursorState()
        expect(errorCode(() => reduceProxyJobStreamEvent(state, chunk(0, 'abc', 4)))).toBe('invalid_chunk_length')
    })

    it('accepts a terminal event only when finalOffset equals the cursor', () => {
        const state: ProxyJobStreamCursorState = { cursor: 5, terminal: null }
        const result = reduceProxyJobStreamEvent(state, { type: 'done', finalOffset: 5 })

        expect(result).toEqual({
            action: 'terminal',
            state: { cursor: 5, terminal: 'done' },
        })
        expect(errorCode(() => reduceProxyJobStreamEvent(state, { type: 'done', finalOffset: 4 })))
            .toBe('terminal_offset_mismatch')
        expect(errorCode(() => reduceProxyJobStreamEvent(state, { type: 'error', message: 'failed', finalOffset: 6 })))
            .toBe('terminal_offset_mismatch')
    })

    it('makes duplicate terminal delivery idempotent and rejects later chunks', () => {
        const done: ProxyJobStreamCursorState = { cursor: 3, terminal: 'done' }
        expect(reduceProxyJobStreamEvent(done, { type: 'done', finalOffset: 3 }).action).toBe('skip_duplicate')
        expect(errorCode(() => reduceProxyJobStreamEvent(done, chunk(3, 'x')))).toBe('after_terminal')
        expect(errorCode(() => reduceProxyJobStreamEvent(done, { type: 'error', message: 'late', finalOffset: 3 })))
            .toBe('after_terminal')
    })

    it('does not change the byte cursor for control events', () => {
        const state: ProxyJobStreamCursorState = { cursor: 7, terminal: null }
        const result = reduceProxyJobStreamEvent(state, { type: 'ping', ts: 1, cursor: 7 })

        expect(result).toEqual({ action: 'control', state: { cursor: 7, terminal: null } })
    })
})

describe('formatProxyStreamErrorMessage', () => {
    it('maps cloudflare/origin timeout errors to clear message', () => {
        const msg = formatProxyStreamErrorMessage(504, '<!DOCTYPE html><title>Gateway time-out</title>')
        expect(msg).toContain('Cloudflare/origin timeout')
    })

    it('passes through non-timeout messages', () => {
        expect(formatProxyStreamErrorMessage(400, 'bad request')).toBe('bad request')
    })
})
