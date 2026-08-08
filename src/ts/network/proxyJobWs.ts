export type ProxyJobLifecycleState =
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';

export type ProxyJobAcceptedEvent = {
    type: 'job_accepted';
    jobId: string;
    /** Byte cursor accepted by a durable stream endpoint. */
    cursor?: number;
    /** Durable event-log sequence, when the server exposes one. */
    sequence?: number;
    lastSequence?: number;
};

export type ProxyJobSnapshotEvent = {
    type: 'job_snapshot';
    jobId: string;
    state: ProxyJobLifecycleState;
    lastSequence: number;
    /** Current response-body byte cursor, if response bytes are available. */
    cursor?: number;
    status?: number;
    headers?: Record<string, string>;
};

export type ProxyJobUpstreamHeadersEvent = {
    type: 'upstream_headers';
    status: number;
    headers: Record<string, string>;
    sequence?: number;
};

export type ProxyJobChunkEvent = {
    type: 'chunk';
    dataBase64: string;
    /** Inclusive byte offset of the first decoded byte. */
    offset?: number;
    /** Exclusive byte offset. When present it must match offset + byte length. */
    endOffset?: number;
    sequence?: number;
};

export type DurableProxyJobChunkEvent = ProxyJobChunkEvent & {
    offset: number;
};

export type ProxyJobErrorEvent = {
    type: 'error';
    status?: number;
    message: string;
    /** Total durable response-body byte length at the terminal event. */
    finalOffset?: number;
    sequence?: number;
};

export type ProxyJobDoneEvent = {
    type: 'done';
    /** Total durable response-body byte length at completion. */
    finalOffset?: number;
    sequence?: number;
    /** Final event-log sequence. This is distinct from the byte offset. */
    finalSequence?: number;
};

export type ProxyJobPingEvent = {
    type: 'ping';
    ts: number;
    cursor?: number;
    sequence?: number;
};

export type ProxyJobWsEvent =
    | ProxyJobAcceptedEvent
    | ProxyJobSnapshotEvent
    | ProxyJobUpstreamHeadersEvent
    | ProxyJobChunkEvent
    | ProxyJobErrorEvent
    | ProxyJobDoneEvent
    | ProxyJobPingEvent;

export type DurableProxyJobWsEvent =
    | ProxyJobSnapshotEvent
    | (ProxyJobUpstreamHeadersEvent & { sequence: number })
    | (DurableProxyJobChunkEvent & { sequence: number })
    | (ProxyJobErrorEvent & { sequence: number, finalOffset: number })
    | (ProxyJobDoneEvent & { sequence: number, finalOffset: number });

export interface ProxyJobReplayPage {
    events: ProxyJobWsEvent[];
    /** Event-log sequence to use as the next `afterSequence` value. */
    nextCursor: number;
    hasMore: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isOptionalSafeIntegerAtLeast(value: unknown, minimum: number): value is number | undefined {
    return value === undefined || isSafeIntegerAtLeast(value, minimum);
}

function isHttpStatus(value: unknown): value is number {
    return isSafeIntegerAtLeast(value, 100) && value <= 599;
}

function isOptionalHttpStatus(value: unknown): value is number | undefined {
    return value === undefined || isHttpStatus(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
    return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isOptionalStringRecord(value: unknown): value is Record<string, string> | undefined {
    return value === undefined || isStringRecord(value);
}

const lifecycleStates = new Set<ProxyJobLifecycleState>([
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
]);

function isLifecycleState(value: unknown): value is ProxyJobLifecycleState {
    return typeof value === 'string' && lifecycleStates.has(value as ProxyJobLifecycleState);
}

function isCanonicalBase64(value: unknown): value is string {
    if (typeof value !== 'string') {
        return false;
    }
    if (value === '') {
        return true;
    }
    if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        return false;
    }
    try {
        return Buffer.from(value, 'base64').toString('base64') === value;
    } catch {
        return false;
    }
}

function parseProxyJobWsEventValue(parsed: unknown): ProxyJobWsEvent | null {
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
        return null;
    }

    switch (parsed.type) {
        case 'job_accepted':
            if (
                !isNonEmptyString(parsed.jobId)
                || !isOptionalSafeIntegerAtLeast(parsed.cursor, 0)
                || !isOptionalSafeIntegerAtLeast(parsed.sequence, 1)
                || !isOptionalSafeIntegerAtLeast(parsed.lastSequence, 0)
            ) {
                return null;
            }
            return parsed as ProxyJobAcceptedEvent;

        case 'job_snapshot':
            if (
                !isNonEmptyString(parsed.jobId)
                || !isLifecycleState(parsed.state)
                || !isSafeIntegerAtLeast(parsed.lastSequence, 0)
                || !isOptionalSafeIntegerAtLeast(parsed.cursor, 0)
                || !isOptionalHttpStatus(parsed.status)
                || !isOptionalStringRecord(parsed.headers)
            ) {
                return null;
            }
            return parsed as ProxyJobSnapshotEvent;

        case 'upstream_headers':
            if (
                !isHttpStatus(parsed.status)
                || !isStringRecord(parsed.headers)
                || !isOptionalSafeIntegerAtLeast(parsed.sequence, 1)
            ) {
                return null;
            }
            return parsed as ProxyJobUpstreamHeadersEvent;

        case 'chunk':
            if (
                !isCanonicalBase64(parsed.dataBase64)
                || !isOptionalSafeIntegerAtLeast(parsed.offset, 0)
                || !isOptionalSafeIntegerAtLeast(parsed.endOffset, 0)
                || !isOptionalSafeIntegerAtLeast(parsed.sequence, 1)
                || (parsed.endOffset !== undefined && parsed.offset === undefined)
                || (
                    parsed.offset !== undefined
                    && parsed.endOffset !== undefined
                    && parsed.endOffset < parsed.offset
                )
            ) {
                return null;
            }
            if (
                parsed.offset !== undefined
                && parsed.endOffset !== undefined
                && parsed.endOffset !== parsed.offset + Buffer.from(parsed.dataBase64, 'base64').byteLength
            ) {
                return null;
            }
            return parsed as ProxyJobChunkEvent;

        case 'error':
            if (
                typeof parsed.message !== 'string'
                || !isOptionalHttpStatus(parsed.status)
                || !isOptionalSafeIntegerAtLeast(parsed.finalOffset, 0)
                || !isOptionalSafeIntegerAtLeast(parsed.sequence, 1)
            ) {
                return null;
            }
            return parsed as ProxyJobErrorEvent;

        case 'done':
            if (
                !isOptionalSafeIntegerAtLeast(parsed.finalOffset, 0)
                || !isOptionalSafeIntegerAtLeast(parsed.sequence, 1)
                || !isOptionalSafeIntegerAtLeast(parsed.finalSequence, 0)
            ) {
                return null;
            }
            return parsed as ProxyJobDoneEvent;

        case 'ping':
            if (
                !isSafeIntegerAtLeast(parsed.ts, 0)
                || !isOptionalSafeIntegerAtLeast(parsed.cursor, 0)
                || !isOptionalSafeIntegerAtLeast(parsed.sequence, 1)
            ) {
                return null;
            }
            return parsed as ProxyJobPingEvent;

        default:
            return null;
    }
}

/** Parse and validate a websocket event while retaining all legacy event shapes. */
export function parseProxyJobWsEvent(raw: string): ProxyJobWsEvent | null {
    try {
        return parseProxyJobWsEventValue(JSON.parse(raw));
    } catch {
        return null;
    }
}

/** Parse the paginated durable replay envelope used by the HTTP replay endpoint. */
export function parseProxyJobReplayPage(raw: string | unknown): ProxyJobReplayPage | null {
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    if (
        !isRecord(parsed)
        || !Array.isArray(parsed.events)
        || !isSafeIntegerAtLeast(parsed.nextCursor, 0)
        || typeof parsed.hasMore !== 'boolean'
    ) {
        return null;
    }
    const events: ProxyJobWsEvent[] = [];
    for (const value of parsed.events) {
        const event = parseProxyJobWsEventValue(value);
        if (!event) {
            return null;
        }
        events.push(event);
    }
    return {
        events,
        nextCursor: parsed.nextCursor,
        hasMore: parsed.hasMore,
    };
}

export function decodeProxyJobWsChunk(dataBase64: string): Uint8Array {
    if (!isCanonicalBase64(dataBase64)) {
        throw new Error('Invalid proxy stream base64 payload');
    }
    return Buffer.from(dataBase64, 'base64');
}

export type ProxyJobStreamTerminal = 'done' | 'error';

export interface ProxyJobStreamCursorState {
    /** Exclusive byte offset already accepted by the client. */
    cursor: number;
    terminal: ProxyJobStreamTerminal | null;
}

export type ProxyJobStreamProtocolErrorCode =
    | 'invalid_cursor'
    | 'invalid_chunk_length'
    | 'gap'
    | 'partial_overlap'
    | 'terminal_offset_mismatch'
    | 'after_terminal';

export class ProxyJobStreamProtocolError extends Error {
    readonly code: ProxyJobStreamProtocolErrorCode;
    readonly expectedOffset: number;
    readonly actualOffset?: number;

    constructor(
        code: ProxyJobStreamProtocolErrorCode,
        message: string,
        expectedOffset: number,
        actualOffset?: number,
    ) {
        super(message);
        this.name = 'ProxyJobStreamProtocolError';
        this.code = code;
        this.expectedOffset = expectedOffset;
        this.actualOffset = actualOffset;
    }
}

export type ProxyJobStreamReduction =
    | {
        action: 'append';
        state: ProxyJobStreamCursorState;
        bytes: Uint8Array;
        offset: number;
    }
    | {
        action: 'skip_duplicate';
        state: ProxyJobStreamCursorState;
    }
    | {
        action: 'control';
        state: ProxyJobStreamCursorState;
    }
    | {
        action: 'terminal';
        state: ProxyJobStreamCursorState;
    };

export function createProxyJobStreamCursorState(cursor = 0): ProxyJobStreamCursorState {
    if (!isSafeIntegerAtLeast(cursor, 0)) {
        throw new ProxyJobStreamProtocolError('invalid_cursor', 'Proxy stream cursor must be a non-negative safe integer', 0, cursor);
    }
    return { cursor, terminal: null };
}

/**
 * Reduces durable stream events without mutating the previous state.
 *
 * A chunk is appended only when its start offset equals the current cursor.
 * A range entirely before the cursor is an idempotent replay and is skipped.
 * Gaps and partial overlaps are protocol errors because accepting either would
 * silently corrupt the reconstructed response body.
 */
export function reduceProxyJobStreamEvent(
    state: ProxyJobStreamCursorState,
    event: ProxyJobWsEvent,
): ProxyJobStreamReduction {
    if (!isSafeIntegerAtLeast(state.cursor, 0)) {
        throw new ProxyJobStreamProtocolError('invalid_cursor', 'Proxy stream cursor must be a non-negative safe integer', 0, state.cursor);
    }
    if (state.terminal !== null && state.terminal !== 'done' && state.terminal !== 'error') {
        throw new ProxyJobStreamProtocolError('invalid_cursor', 'Proxy stream terminal state is invalid', state.cursor);
    }

    if (event.type === 'chunk') {
        const bytes = decodeProxyJobWsChunk(event.dataBase64);
        // Offset-less chunks are the legacy live-only protocol. They can still
        // be consumed, but cannot provide replay de-duplication by themselves.
        const offset = event.offset ?? state.cursor;
        const endOffset = offset + bytes.byteLength;
        if (!Number.isSafeInteger(endOffset)) {
            throw new ProxyJobStreamProtocolError('invalid_chunk_length', 'Proxy stream chunk end offset exceeds the safe integer range', state.cursor, offset);
        }
        if (event.endOffset !== undefined && event.endOffset !== endOffset) {
            throw new ProxyJobStreamProtocolError(
                'invalid_chunk_length',
                `Proxy stream chunk end offset ${event.endOffset} does not match decoded end offset ${endOffset}`,
                endOffset,
                event.endOffset,
            );
        }

        if (state.terminal !== null) {
            throw new ProxyJobStreamProtocolError('after_terminal', 'Proxy stream chunk arrived after a terminal event', state.cursor, offset);
        }
        if (offset === state.cursor) {
            return {
                action: 'append',
                state: { cursor: endOffset, terminal: null },
                bytes,
                offset,
            };
        }
        if (endOffset <= state.cursor) {
            return { action: 'skip_duplicate', state: { ...state } };
        }
        if (offset > state.cursor) {
            throw new ProxyJobStreamProtocolError(
                'gap',
                `Proxy stream gap: expected byte offset ${state.cursor}, received ${offset}`,
                state.cursor,
                offset,
            );
        }
        throw new ProxyJobStreamProtocolError(
            'partial_overlap',
            `Proxy stream chunk partially overlaps cursor ${state.cursor}: received [${offset}, ${endOffset})`,
            state.cursor,
            offset,
        );
    }

    if (event.type === 'done' || event.type === 'error') {
        const finalOffset = event.finalOffset ?? state.cursor;
        if (finalOffset !== state.cursor) {
            throw new ProxyJobStreamProtocolError(
                'terminal_offset_mismatch',
                `Proxy stream terminal offset ${finalOffset} does not match cursor ${state.cursor}`,
                state.cursor,
                finalOffset,
            );
        }
        if (state.terminal !== null) {
            if (state.terminal === event.type) {
                return { action: 'skip_duplicate', state: { ...state } };
            }
            throw new ProxyJobStreamProtocolError('after_terminal', 'Proxy stream received conflicting terminal events', state.cursor, finalOffset);
        }
        return {
            action: 'terminal',
            state: { cursor: state.cursor, terminal: event.type },
        };
    }

    return { action: 'control', state: { ...state } };
}

export function formatProxyStreamErrorMessage(status: number | undefined, message: string): string {
    const text = message ?? '';
    if (status === 504 || status === 524 || text.includes('Cloudflare') || text.includes('Gateway time-out') || text.includes('A timeout occurred')) {
        return `Cloudflare/origin timeout (${status ?? 'unknown'}). The origin server did not start sending response in time.`;
    }
    return text || `Proxy stream failed (${status ?? 'unknown'})`;
}
