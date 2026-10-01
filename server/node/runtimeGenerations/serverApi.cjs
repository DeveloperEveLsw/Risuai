'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const DEFAULT_SOCKET_TICKET_TTL_MS = 30_000;
const DEFAULT_SOCKET_TICKET_LIMIT = 512;
const DEFAULT_REPLAY_PAGE_SIZE = 1_000;
const DEFAULT_MAX_REQUEST_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_PROGRESS_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_MAX_TERMINAL_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_PAYLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_WEBSOCKET_OUTPUT_BUFFER_HIGH_WATER_BYTES = 512 * 1024;
const DEFAULT_MAX_UI_PROMPT_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_UI_PROMPT_RESPONSE_TTL_MS = 35 * 60_000;
const DEFAULT_UI_PROMPT_RESPONSE_LIMIT = 512;
const DEFAULT_PRESENTATION_MAILBOX_TTL_MS = 35 * 60_000;
const DEFAULT_PRESENTATION_MAILBOX_LIMIT = 512;
const DEFAULT_PRESENTATION_MAILBOX_MAX_ACTIONS = 64;
const DEFAULT_PRESENTATION_ACTION_MAX_BYTES = 64 * 1024;
const PRESENTATION_TOKEN_HEADER = 'x-risu-runtime-presentation-token';
const PRIVATE_INPUT_MARKER = '__runtimePrivateInput';
const UI_PROMPT_TYPES = new Set([
    'error',
    'normal',
    'ask',
    'input',
    'markdown',
    'select',
    'pluginconfirm',
    'selectChar',
    'login',
    'tos',
    'cardexport',
    'addchar',
    'selectModule',
    'chatOptions',
]);
const RUNTIME_GENERATION_ACTIONS = Object.freeze([
    'send',
    'continue',
    'reroll',
    'unreroll',
    'auto',
    'generate',
    'manual-trigger',
    'lua-button',
    'suggest',
]);
const RUNTIME_GENERATION_ACTION_SET = new Set(RUNTIME_GENERATION_ACTIONS);
const TERMINAL_RUNTIME_GENERATION_STATES = new Set([
    'completed',
    'failed',
    'cancelled',
    'interrupted',
]);
const GENERATION_OUTPUT_OPTIMIZATION_MODES = new Set([
    'off',
    'balanced',
    'strong',
]);

function stableJsonStringify(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError('Generation command payload cannot contain non-finite numbers');
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableJsonStringify(entry ?? null)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(',')}}`;
    }
    throw new TypeError(`Unsupported generation command value: ${typeof value}`);
}

function hashRuntimeGenerationRequest(request) {
    return crypto.createHash('sha256').update(stableJsonStringify(request)).digest('hex');
}

function normalizeHeader(value) {
    if (Array.isArray(value)) {
        return value[0] || '';
    }
    return typeof value === 'string' ? value : '';
}

function normalizeExecutorIp(value) {
    if (typeof value !== 'string') {
        return '';
    }
    let normalized = value.trim().toLowerCase();
    if (normalized.startsWith('[') && normalized.endsWith(']')) {
        normalized = normalized.slice(1, -1);
    }
    if (normalized.startsWith('::ffff:')) {
        normalized = normalized.slice('::ffff:'.length);
    }
    return normalized;
}

function assertNonEmptyString(value, field, maxLength = 512) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${field} must be a non-empty string`);
    }
    if (value.length > maxLength) {
        throw new TypeError(`${field} must be at most ${maxLength} characters`);
    }
    return value;
}

function assertString(value, field, maxLength) {
    if (typeof value !== 'string') {
        throw new TypeError(`${field} must be a string`);
    }
    if (value.length > maxLength) {
        throw new TypeError(`${field} must be at most ${maxLength} characters`);
    }
    return value;
}

function assertPromptId(value) {
    const promptId = assertNonEmptyString(value, 'promptId', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(promptId)) {
        throw new TypeError('promptId contains unsupported characters');
    }
    return promptId;
}

function normalizeUiPrompt(value) {
    const prompt = assertJsonObject(value, 'prompt');
    const type = assertNonEmptyString(prompt.type, 'prompt.type', 32);
    if (!UI_PROMPT_TYPES.has(type)) {
        throw new TypeError(`Unsupported UI prompt type: ${type}`);
    }
    const normalized = {
        type,
        msg: assertString(prompt.msg, 'prompt.msg', 32_768),
    };
    for (const [field, maximum] of [
        ['submsg', 8_192],
        ['stackTrace', 32_768],
        ['defaultValue', 32_768],
    ]) {
        if (prompt[field] !== undefined) {
            normalized[field] = assertString(prompt[field], `prompt.${field}`, maximum);
        }
    }
    if (prompt.datalist !== undefined) {
        if (!Array.isArray(prompt.datalist) || prompt.datalist.length > 256) {
            throw new TypeError('prompt.datalist must contain at most 256 entries');
        }
        normalized.datalist = prompt.datalist.map((entry, index) => {
            if (!Array.isArray(entry) || entry.length !== 2) {
                throw new TypeError(`prompt.datalist[${index}] must contain a value and label`);
            }
            return [
                assertString(entry[0], `prompt.datalist[${index}][0]`, 4_096),
                assertString(entry[1], `prompt.datalist[${index}][1]`, 4_096),
            ];
        });
    }
    return normalized;
}

function assertJsonObject(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${field} must be a JSON object`);
    }
    return value;
}

function assertSerializedLimit(value, field, maxBytes) {
    const serialized = stableJsonStringify(value);
    if (Buffer.byteLength(serialized) > maxBytes) {
        const error = new TypeError(`${field} exceeds the ${maxBytes} byte limit`);
        error.statusCode = 413;
        throw error;
    }
    return serialized;
}

function parseNonNegativeSafeInteger(value, field, defaultValue) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError(`${field} must be a non-negative safe integer`);
    }
    return parsed;
}

function parsePositiveSafeInteger(value, field, defaultValue) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new TypeError(`${field} must be a positive safe integer`);
    }
    return parsed;
}

function publicCommand(command, options = {}) {
    return {
        commandId: command.id,
        requestId: command.requestId,
        action: command.action,
        characterId: command.characterId,
        chatId: command.chatId,
        state: command.state,
        createdAt: command.createdAt,
        updatedAt: command.updatedAt,
        startedAt: command.startedAt,
        finishedAt: command.finishedAt,
        interruptedAt: command.interruptedAt,
        cancelRequestedAt: command.cancelRequestedAt,
        // Lease credentials are returned only in the executor-only `lease`
        // envelope. Observer/list/get/WS payloads must never reveal a token
        // that could be replayed in a fenced database commit.
        executorId: null,
        fencingToken: null,
        leaseExpiresAt: null,
        result: command.result,
        error: command.error,
        lastSequence: command.lastSequence,
        ...(options.includePayload ? { payload: command.payload } : {}),
    };
}

function wireGenerationEvent(commandId, record) {
    const payload = { ...(record.payload ?? {}) };
    // Executor lease values are capabilities, not observer state. The store
    // keeps them in its audit log, but public HTTP/WebSocket replay must not
    // expose them to direct browsers or same-origin community plugins.
    delete payload.executorId;
    delete payload.fencingToken;
    delete payload.leaseExpiresAt;
    if (record.type === 'ui_prompt_response') {
        // Defense in depth for any event created by an older development
        // build: observer replay must never expose a prompt answer.
        delete payload.response;
        payload.responded = true;
    }
    return {
        type: 'generation_event',
        commandId,
        sequence: record.sequence,
        eventType: record.type,
        timestamp: record.timestamp,
        payload,
    };
}

function wireGenerationOutput(output) {
    return {
        type: 'generation_output',
        commandId: output.commandId,
        version: output.version,
        messages: output.messages.map((message) => ({
            messageId: message.messageId,
            messageIndex: message.messageIndex,
            data: message.data,
            createdAt: message.createdAt,
            generationInfo: message.generationInfo,
            optimizationMode: message.optimizationMode,
        })),
        timestamp: output.timestamp,
    };
}

function rejectWebSocketUpgrade(socket, status, message) {
    if (socket.destroyed) {
        return;
    }
    socket.write(
        `HTTP/1.1 ${status} ${message}\r\n`
        + 'Connection: close\r\n'
        + 'Content-Length: 0\r\n'
        + '\r\n'
    );
    socket.destroy();
}

function createRuntimeGenerationServer(options) {
    if (!options?.store) {
        throw new TypeError('store is required');
    }
    if (typeof options.authenticate !== 'function') {
        throw new TypeError('authenticate is required');
    }

    const store = options.store;
    const authenticate = options.authenticate;
    const routeMiddleware = options.routeMiddleware;
    const executorIp = normalizeExecutorIp(options.executorIp || '');
    const now = options.now ?? (() => Date.now());
    const socketTicketTtlMs = options.socketTicketTtlMs ?? DEFAULT_SOCKET_TICKET_TTL_MS;
    const socketTicketLimit = options.socketTicketLimit ?? DEFAULT_SOCKET_TICKET_LIMIT;
    const replayPageSize = options.replayPageSize ?? DEFAULT_REPLAY_PAGE_SIZE;
    const maxRequestPayloadBytes = options.maxRequestPayloadBytes ?? DEFAULT_MAX_REQUEST_PAYLOAD_BYTES;
    const maxProgressPayloadBytes = options.maxProgressPayloadBytes ?? DEFAULT_MAX_PROGRESS_PAYLOAD_BYTES;
    const maxTerminalPayloadBytes = options.maxTerminalPayloadBytes ?? DEFAULT_MAX_TERMINAL_PAYLOAD_BYTES;
    const maxOutputPayloadBytes = options.maxOutputPayloadBytes ?? DEFAULT_MAX_OUTPUT_PAYLOAD_BYTES;
    const webSocketOutputBufferHighWaterBytes = options.webSocketOutputBufferHighWaterBytes
        ?? DEFAULT_WEBSOCKET_OUTPUT_BUFFER_HIGH_WATER_BYTES;
    if (!Number.isSafeInteger(webSocketOutputBufferHighWaterBytes)
        || webSocketOutputBufferHighWaterBytes < 0) {
        throw new TypeError(
            'webSocketOutputBufferHighWaterBytes must be a non-negative safe integer',
        );
    }
    const maxUiPromptResponseBytes = options.maxUiPromptResponseBytes
        ?? DEFAULT_MAX_UI_PROMPT_RESPONSE_BYTES;
    const uiPromptResponseTtlMs = options.uiPromptResponseTtlMs
        ?? DEFAULT_UI_PROMPT_RESPONSE_TTL_MS;
    const uiPromptResponseLimit = options.uiPromptResponseLimit
        ?? DEFAULT_UI_PROMPT_RESPONSE_LIMIT;
    const presentationMailboxTtlMs = options.presentationMailboxTtlMs
        ?? DEFAULT_PRESENTATION_MAILBOX_TTL_MS;
    const presentationMailboxLimit = options.presentationMailboxLimit
        ?? DEFAULT_PRESENTATION_MAILBOX_LIMIT;
    const presentationMailboxMaxActions = options.presentationMailboxMaxActions
        ?? DEFAULT_PRESENTATION_MAILBOX_MAX_ACTIONS;
    const presentationActionMaxBytes = options.presentationActionMaxBytes
        ?? DEFAULT_PRESENTATION_ACTION_MAX_BYTES;
    for (const [field, value] of [
        ['presentationMailboxTtlMs', presentationMailboxTtlMs],
        ['presentationMailboxLimit', presentationMailboxLimit],
        ['presentationMailboxMaxActions', presentationMailboxMaxActions],
        ['presentationActionMaxBytes', presentationActionMaxBytes],
    ]) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new TypeError(`${field} must be a positive safe integer`);
        }
    }
    const socketTickets = new Map();
    const subscribers = new Map();
    const uiPromptResponses = new Map();
    // Presentation effects are deliberately outside the durable command store.
    // Only the browser that supplied the unlogged capability on admission can
    // consume them, so raw TTS text never enters command/event/snapshot/WS data.
    const presentationMailboxes = new Map();
    // Admission is provisioned before the durable create. A concurrent claim
    // can therefore attach the channel by requestId without observing a gap.
    const pendingPresentationMailboxes = new Map();
    const claimWaiters = new Set();
    let lastExecutorContactAt = 0;

    function getExecutorHealth() {
        const timestamp = now();
        const ageMs = lastExecutorContactAt > 0
            ? Math.max(0, timestamp - lastExecutorContactAt)
            : null;
        return {
            ready: ageMs !== null && ageMs <= 10_000,
            ageMs,
        };
    }

    function uiPromptResponseKey(commandId, promptId) {
        return `${commandId}\0${promptId}`;
    }

    function pruneUiPromptResponses(timestamp = now()) {
        for (const [key, mailbox] of uiPromptResponses) {
            if (mailbox.expiresAt <= timestamp) {
                uiPromptResponses.delete(key);
            }
        }
    }

    function clearUiPromptResponses(commandId) {
        for (const [key, mailbox] of uiPromptResponses) {
            if (mailbox.commandId === commandId) {
                uiPromptResponses.delete(key);
            }
        }
    }

    function storeUiPromptResponse(commandId, promptId, response) {
        const timestamp = now();
        pruneUiPromptResponses(timestamp);
        while (uiPromptResponses.size >= uiPromptResponseLimit) {
            const oldest = uiPromptResponses.keys().next().value;
            if (!oldest) {
                break;
            }
            uiPromptResponses.delete(oldest);
        }
        uiPromptResponses.set(uiPromptResponseKey(commandId, promptId), {
            commandId,
            promptId,
            response,
            expiresAt: timestamp + uiPromptResponseTtlMs,
        });
    }

    function presentationTokenFromRequest(req) {
        const token = normalizeHeader(req.headers[PRESENTATION_TOKEN_HEADER]);
        if (!token) {
            return null;
        }
        if (token.length < 32 || token.length > 256 || !/^[A-Za-z0-9._~-]+$/.test(token)) {
            throw new TypeError('Runtime presentation token is malformed');
        }
        return token;
    }

    function presentationTokenHash(token) {
        return crypto.createHash('sha256').update(token).digest();
    }

    function presentationTokenMatches(mailbox, token) {
        if (!mailbox.tokenHash || !token) {
            return false;
        }
        const candidate = presentationTokenHash(token);
        return candidate.length === mailbox.tokenHash.length
            && crypto.timingSafeEqual(candidate, mailbox.tokenHash);
    }

    function prunePresentationMailboxes(timestamp = now()) {
        for (const [commandId, mailbox] of presentationMailboxes) {
            if (mailbox.expiresAt <= timestamp) {
                presentationMailboxes.delete(commandId);
            }
        }
        for (const [requestId, mailbox] of pendingPresentationMailboxes) {
            if (mailbox.expiresAt <= timestamp) {
                pendingPresentationMailboxes.delete(requestId);
            }
        }
    }

    function presentationMailboxCapacity() {
        return presentationMailboxes.size + pendingPresentationMailboxes.size;
    }

    function reservePresentationCapacity() {
        while (presentationMailboxCapacity() >= presentationMailboxLimit) {
            const oldestPending = pendingPresentationMailboxes.keys().next().value;
            if (oldestPending) {
                pendingPresentationMailboxes.delete(oldestPending);
                continue;
            }
            const oldestActive = presentationMailboxes.keys().next().value;
            if (!oldestActive) {
                break;
            }
            presentationMailboxes.delete(oldestActive);
        }
    }

    function privateInputEnvelope(request) {
        const input = request.payload?.input;
        if ((request.action !== 'send' && request.action !== 'continue')
            || typeof input !== 'string'
            || !input.startsWith('/')) {
            return { request, privateInput: null };
        }
        const inputBytes = Buffer.from(input);
        const marker = {
            sha256: crypto.createHash('sha256').update(inputBytes).digest('hex'),
            byteLength: inputBytes.byteLength,
        };
        return {
            request: {
                ...request,
                payload: {
                    ...request.payload,
                    input: '',
                    [PRIVATE_INPUT_MARKER]: marker,
                },
            },
            privateInput: input,
        };
    }

    function preparePresentationAdmission(request, token) {
        const prepared = privateInputEnvelope(request);
        if (!token && prepared.privateInput === null) {
            return request;
        }
        const timestamp = now();
        prunePresentationMailboxes(timestamp);
        const existing = pendingPresentationMailboxes.get(request.requestId);
        if (existing) {
            // A same-token retry must keep the exact private value. A different
            // token can still resolve the durable idempotent command, but it
            // never becomes a presentation consumer.
            const sameOwner = token
                ? presentationTokenMatches(existing, token)
                : existing.tokenHash === null;
            if (sameOwner && (
                existing.expectedRequestHash !== request.requestHash
                || existing.privateInput !== prepared.privateInput
            )) {
                throw new TypeError('Runtime presentation retry changed its private input');
            }
            return prepared.request;
        }
        reservePresentationCapacity();
        pendingPresentationMailboxes.set(request.requestId, {
            commandId: null,
            requestId: request.requestId,
            tokenHash: token ? presentationTokenHash(token) : null,
            expectedRequestHash: request.requestHash,
            actions: new Map(),
            privateInput: prepared.privateInput,
            expiresAt: timestamp + presentationMailboxTtlMs,
        });
        return prepared.request;
    }

    function ensurePresentationMailbox(command) {
        prunePresentationMailboxes();
        const existing = presentationMailboxes.get(command.id);
        if (existing) {
            pendingPresentationMailboxes.delete(command.requestId);
            return existing;
        }
        const pending = pendingPresentationMailboxes.get(command.requestId);
        if (!pending) {
            return null;
        }
        pendingPresentationMailboxes.delete(command.requestId);
        if (command.state !== 'queued' && command.state !== 'running') {
            return null;
        }
        const marker = privateInputMarker(command);
        const privateInput = pending.privateInput;
        const privateBytes = typeof privateInput === 'string'
            ? Buffer.from(privateInput)
            : null;
        const privateInputValid = !marker
            ? privateInput === null
            : !!privateBytes
                && marker.byteLength === privateBytes.byteLength
                && marker.sha256 === crypto.createHash('sha256')
                    .update(privateBytes)
                    .digest('hex');
        if (
            pending.expectedRequestHash !== command.requestHash
            || !privateInputValid
        ) {
            return null;
        }
        pending.commandId = command.id;
        presentationMailboxes.set(command.id, pending);
        return pending;
    }

    function presentationChannelForToken(command, token) {
        if (!token) {
            return false;
        }
        const mailbox = ensurePresentationMailbox(command);
        return !!mailbox && presentationTokenMatches(mailbox, token);
    }

    function discardRejectedPresentationAdmission(request, token) {
        if (!request) {
            return;
        }
        const pending = pendingPresentationMailboxes.get(request.requestId);
        if (!pending || pending.expectedRequestHash !== request.requestHash) {
            return;
        }
        const sameOwner = token
            ? presentationTokenMatches(pending, token)
            : pending.tokenHash === null;
        if (sameOwner) {
            pendingPresentationMailboxes.delete(request.requestId);
        }
    }

    function privateInputMarker(command) {
        const marker = command.payload?.[PRIVATE_INPUT_MARKER];
        return marker && typeof marker === 'object' && !Array.isArray(marker)
            ? marker
            : null;
    }

    function executorCommand(command, mailbox) {
        const publicValue = publicCommand(command, { includePayload: true });
        const marker = privateInputMarker(command);
        if (!marker) {
            return {
                ...publicValue,
                presentationChannel: !!mailbox?.tokenHash,
            };
        }
        if (!mailbox || typeof mailbox.privateInput !== 'string') {
            return null;
        }
        const payload = { ...publicValue.payload, input: mailbox.privateInput };
        delete payload[PRIVATE_INPUT_MARKER];
        return {
            ...publicValue,
            payload,
            presentationChannel: !!mailbox.tokenHash,
        };
    }

    function clearPresentationMailbox(commandId, requestId = null) {
        presentationMailboxes.delete(commandId);
        if (requestId) {
            pendingPresentationMailboxes.delete(requestId);
        }
    }

    function presentationAction(body) {
        const actionId = assertNonEmptyString(body?.actionId, 'actionId', 128);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(actionId)) {
            throw new TypeError('actionId contains unsupported characters');
        }
        const rawAction = assertJsonObject(body?.action, 'action');
        const type = assertNonEmptyString(rawAction.type, 'action.type', 32);
        if (type !== 'speak') {
            throw new TypeError(`Unsupported runtime presentation action: ${type}`);
        }
        const action = {
            type,
            characterId: assertNonEmptyString(
                rawAction.characterId,
                'action.characterId',
                512,
            ),
            text: assertString(rawAction.text, 'action.text', 32_768),
        };
        assertSerializedLimit(action, 'presentation action', presentationActionMaxBytes);
        return { actionId, action };
    }

    function registerRoute(app, method, routePath, handler) {
        if (routeMiddleware) {
            app[method](routePath, routeMiddleware, handler);
        }
        else {
            app[method](routePath, handler);
        }
    }

    async function requireObserverAuth(req, res) {
        return await authenticate(req, res);
    }

    async function requireExecutorAuth(req, res) {
        if (!await authenticate(req, res)) {
            return false;
        }
        const sourceIp = normalizeExecutorIp(req.socket?.remoteAddress || req.ip);
        if (executorIp && sourceIp !== executorIp) {
            res.status(403).send({
                error: 'Runtime generation executor is not allowed from this IP',
                code: 'EXECUTOR_IP_FORBIDDEN',
            });
            return false;
        }
        lastExecutorContactAt = now();
        return true;
    }

    function runtimeGenerationRequest(req, pathRequestId = '') {
        const bodyRequestId = typeof req.body?.requestId === 'string' ? req.body.requestId : '';
        const bodyIdempotencyKey = typeof req.body?.idempotencyKey === 'string'
            ? req.body.idempotencyKey
            : '';
        const headerIdempotencyKey = normalizeHeader(req.headers['idempotency-key']);
        const suppliedKeys = [
            pathRequestId,
            bodyRequestId,
            bodyIdempotencyKey,
            headerIdempotencyKey,
        ].filter(Boolean);
        if (suppliedKeys.length === 0) {
            throw new TypeError('requestId or Idempotency-Key is required');
        }
        if (new Set(suppliedKeys).size > 1) {
            throw new TypeError('requestId and idempotencyKey values must match');
        }
        const requestId = assertNonEmptyString(suppliedKeys[0], 'requestId');
        const action = assertNonEmptyString(req.body?.action, 'action', 32);
        if (!RUNTIME_GENERATION_ACTION_SET.has(action)) {
            throw new TypeError(`action must be one of: ${RUNTIME_GENERATION_ACTIONS.join(', ')}`);
        }
        const characterId = assertNonEmptyString(req.body?.characterId, 'characterId');
        const chatId = assertNonEmptyString(req.body?.chatId, 'chatId');
        const payload = req.body?.payload === undefined ? {} : assertJsonObject(req.body.payload, 'payload');
        assertSerializedLimit(payload, 'payload', maxRequestPayloadBytes);
        const requestEnvelope = {
            schemaVersion: 1,
            action,
            characterId,
            chatId,
            payload,
        };
        return {
            requestId,
            requestHash: hashRuntimeGenerationRequest(requestEnvelope),
            action,
            characterId,
            chatId,
            payload,
        };
    }

    function sendRouteError(error, res, next) {
        const statusCode = Number(error?.statusCode);
        if (Number.isSafeInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
            res.status(statusCode).send({
                error: error.message,
                ...(error.code ? { code: error.code } : {}),
                ...(error.existingCommandId ? { existingCommandId: error.existingCommandId } : {}),
                ...(error.reason ? { reason: error.reason } : {}),
                ...(Number.isSafeInteger(error.version) ? { version: error.version } : {}),
                ...(Number.isSafeInteger(error.currentVersion)
                    ? { currentVersion: error.currentVersion }
                    : {}),
            });
            return;
        }
        if (error?.code === 'COMMAND_NOT_FOUND') {
            res.status(404).send({ error: error.message, code: error.code });
            return;
        }
        if (
            error?.code === 'IDEMPOTENCY_CONFLICT'
            || error?.code === 'INVALID_COMMAND_STATE'
            || error?.code === 'STALE_EXECUTOR_FENCE'
        ) {
            res.status(409).send({
                error: error.message,
                code: error.code,
                ...(error.existingCommandId ? { existingCommandId: error.existingCommandId } : {}),
                ...(error.reason ? { reason: error.reason } : {}),
            });
            return;
        }
        if (error instanceof TypeError) {
            res.status(400).send({ error: error.message });
            return;
        }
        next(error);
    }

    function pruneExpiredSocketTickets(timestamp = now()) {
        for (const [ticket, value] of socketTickets) {
            if (value.expiresAt <= timestamp) {
                socketTickets.delete(ticket);
            }
        }
    }

    function pruneSocketTicketCapacity() {
        while (socketTickets.size >= socketTicketLimit) {
            const oldest = socketTickets.keys().next().value;
            if (!oldest) {
                break;
            }
            socketTickets.delete(oldest);
        }
    }

    function createSocketTicket(commandId, clientId) {
        const timestamp = now();
        pruneExpiredSocketTickets(timestamp);
        pruneSocketTicketCapacity();
        const ticket = crypto.randomBytes(32).toString('base64url');
        const value = {
            commandId,
            clientId,
            expiresAt: timestamp + socketTicketTtlMs,
        };
        socketTickets.set(ticket, value);
        return { ticket, ...value };
    }

    function consumeSocketTicket(ticket, commandId) {
        const timestamp = now();
        pruneExpiredSocketTickets(timestamp);
        const value = socketTickets.get(ticket);
        if (ticket) {
            socketTickets.delete(ticket);
        }
        if (!value || value.expiresAt <= timestamp || value.commandId !== commandId) {
            return null;
        }
        return value;
    }

    function closeBackpressuredSubscriber(subscriber) {
        if (subscriber.closing) {
            return;
        }
        subscriber.closing = true;
        subscriber.pendingOutput = null;
        try {
            // A graceful close frame would sit behind the very output backlog
            // we are trying to discard. Termination makes the browser reconnect
            // immediately, where the durable latest aggregate is replayed.
            if (typeof subscriber.ws.terminate === 'function') {
                subscriber.ws.terminate();
            }
            else {
                subscriber.ws.close(1013, 'Runtime output backpressure');
            }
        }
        catch {
            // The close/error listener performs subscriber cleanup. If the
            // transport has already failed there is nothing left to enqueue.
        }
    }

    function outputBufferAtHighWater(subscriber) {
        const bufferedAmount = Number(subscriber.ws.bufferedAmount ?? 0);
        return Number.isFinite(bufferedAmount)
            && bufferedAmount >= webSocketOutputBufferHighWaterBytes;
    }

    function drainSubscriberOutput(subscriber) {
        if (subscriber.closing
            || subscriber.terminalObserved
            || !subscriber.ready
            || subscriber.outputSendInFlight
            || !subscriber.pendingOutput
            || subscriber.ws.readyState !== subscriber.ws.OPEN) {
            return;
        }
        if (outputBufferAtHighWater(subscriber)) {
            closeBackpressuredSubscriber(subscriber);
            return;
        }

        const output = subscriber.pendingOutput;
        subscriber.pendingOutput = null;
        subscriber.outputSendInFlight = true;
        subscriber.lastOutputVersion = output.version;
        try {
            subscriber.ws.send(JSON.stringify(output), (error) => {
                subscriber.outputSendInFlight = false;
                if (error) {
                    closeBackpressuredSubscriber(subscriber);
                    return;
                }
                // At most one full aggregate is handed to ws at a time. Any
                // number of intermediate cumulative versions collapse into the
                // single newest pending value while a slow send is in flight.
                drainSubscriberOutput(subscriber);
            });
        }
        catch {
            subscriber.outputSendInFlight = false;
            closeBackpressuredSubscriber(subscriber);
        }
    }

    function queueSubscriberOutput(subscriber, output) {
        if (subscriber.closing
            || subscriber.terminalObserved
            || output.version <= subscriber.lastOutputVersion
            || (subscriber.pendingOutput
                && output.version <= subscriber.pendingOutput.version)) {
            return;
        }
        if (subscriber.ready && outputBufferAtHighWater(subscriber)) {
            closeBackpressuredSubscriber(subscriber);
            return;
        }
        subscriber.pendingOutput = output;
        drainSubscriberOutput(subscriber);
    }

    function broadcastRecord(commandId, record) {
        const clients = subscribers.get(commandId);
        if (!clients) {
            return;
        }
        const event = wireGenerationEvent(commandId, record);
        const terminal = TERMINAL_RUNTIME_GENERATION_STATES.has(record.type);
        for (const subscriber of clients) {
            if (terminal) {
                // Mark terminal before touching the transport so an in-flight
                // output callback can never drain a newer presentation frame
                // after the lifecycle event.
                subscriber.terminalObserved = true;
                subscriber.pendingOutput = null;
            }
            if (subscriber.ws.readyState !== subscriber.ws.OPEN) {
                continue;
            }
            if (!subscriber.ready) {
                subscriber.pendingEvents.push(event);
                continue;
            }
            if (event.sequence <= subscriber.lastSequence) {
                continue;
            }
            if (terminal && subscriber.outputSendInFlight && outputBufferAtHighWater(subscriber)) {
                // Do not put the terminal marker behind an output backlog. A
                // reconnect replays the durable terminal record by sequence.
                closeBackpressuredSubscriber(subscriber);
                continue;
            }
            try {
                subscriber.ws.send(JSON.stringify(event));
                subscriber.lastSequence = event.sequence;
            }
            catch {
                closeBackpressuredSubscriber(subscriber);
            }
        }
    }

    function broadcastOutput(commandId, outputRecord) {
        const clients = subscribers.get(commandId);
        if (!clients) {
            return;
        }
        const output = wireGenerationOutput(outputRecord);
        for (const subscriber of clients) {
            if (subscriber.ws.readyState !== subscriber.ws.OPEN) {
                continue;
            }
            queueSubscriberOutput(subscriber, output);
        }
    }

    async function broadcastRecordsAfter(commandId, afterSequence) {
        let cursor = afterSequence;
        while (true) {
            const page = await store.replay(commandId, {
                afterSequence: cursor,
                limit: replayPageSize,
            });
            for (const record of page.events) {
                broadcastRecord(commandId, record);
            }
            cursor = page.nextCursor;
            if (!page.hasMore) {
                return cursor;
            }
        }
    }

    async function broadcastLatestTransition(command) {
        if (command.lastSequence > 0) {
            await broadcastRecordsAfter(command.id, command.lastSequence - 1);
        }
    }

    async function expireLeaseAndBroadcast() {
        const interrupted = await store.expireLease();
        if (interrupted) {
            clearUiPromptResponses(interrupted.id);
            clearPresentationMailbox(interrupted.id, interrupted.requestId);
            await broadcastLatestTransition(interrupted);
        }
        return interrupted;
    }

    function executorCredentials(body) {
        return {
            executorId: assertNonEmptyString(body?.executorId, 'executorId', 256),
            fencingToken: parsePositiveSafeInteger(body?.fencingToken, 'fencingToken'),
        };
    }

    function generationOutputPayload(body) {
        const version = parsePositiveSafeInteger(body?.version, 'version');
        if (!Array.isArray(body?.messages) || body.messages.length === 0) {
            throw new TypeError('messages must be a non-empty array');
        }
        const messageIds = new Set();
        let previousMessageIndex = -1;
        const messages = body.messages.map((rawMessage, index) => {
            const field = `messages[${index}]`;
            const message = assertJsonObject(rawMessage, field);
            const messageId = assertNonEmptyString(message.messageId, `${field}.messageId`, 512);
            if (messageIds.has(messageId)) {
                throw new TypeError('messages must contain unique messageId values');
            }
            messageIds.add(messageId);
            const messageIndex = parseNonNegativeSafeInteger(
                message.messageIndex,
                `${field}.messageIndex`,
            );
            if (!Number.isSafeInteger(messageIndex)) {
                throw new TypeError(`${field}.messageIndex must be a non-negative safe integer`);
            }
            if (messageIndex <= previousMessageIndex) {
                throw new TypeError('messages must be ordered by strictly increasing messageIndex');
            }
            previousMessageIndex = messageIndex;
            if (typeof message.data !== 'string') {
                throw new TypeError(`${field}.data must be a string`);
            }
            if (!Number.isFinite(message.createdAt) || message.createdAt < 0) {
                throw new TypeError(`${field}.createdAt must be a non-negative finite number`);
            }
            const generationInfo = message.generationInfo === null
                ? null
                : assertJsonObject(message.generationInfo, `${field}.generationInfo`);
            const optimizationMode = assertNonEmptyString(
                message.optimizationMode,
                `${field}.optimizationMode`,
                16,
            );
            if (!GENERATION_OUTPUT_OPTIMIZATION_MODES.has(optimizationMode)) {
                throw new TypeError(
                    `${field}.optimizationMode must be off, balanced, or strong`,
                );
            }
            return {
                messageId,
                messageIndex,
                data: message.data,
                createdAt: message.createdAt,
                generationInfo,
                optimizationMode,
            };
        });
        const payload = {
            version,
            messages,
        };
        assertSerializedLimit(payload, 'output payload', maxOutputPayloadBytes);
        return payload;
    }

    function registerRoutes(app) {
        // This endpoint deliberately exposes only liveness, not credentials or
        // command data. The Chromium container uses it to prove that the
        // authenticated resident JavaScript executor has actually entered its
        // claim loop; merely loading a logo or opening a CDP target is not
        // sufficient readiness.
        registerRoute(app, 'get', '/runtime-generations/executor/health', (_req, res) => {
            const health = getExecutorHealth();
            res.status(health.ready ? 200 : 503).send(health);
        });

        registerRoute(app, 'post', '/runtime-generations/executor/claim-next', async (req, res, next) => {
            if (!await requireExecutorAuth(req, res)) {
                return;
            }
            try {
                await expireLeaseAndBroadcast();
                const executorId = assertNonEmptyString(req.body?.executorId, 'executorId', 256);
                const leaseDurationMs = parsePositiveSafeInteger(
                    req.body?.leaseDurationMs,
                    'leaseDurationMs',
                    undefined,
                );
                const waitMs = req.body?.waitMs === undefined
                    ? 0 : parseNonNegativeSafeInteger(req.body.waitMs, 'waitMs');
                if (waitMs > 1000) throw new TypeError('waitMs must be at most 1000');
                let runningBeforeClaim = (await store.list({ state: 'running' }))[0] ?? null;
                // Subscribe before checking the queue so a create between the
                // check and wait cannot be lost. No store lock is held waiting.
                let wake;
                const queued = new Promise(resolve => { wake = resolve; });
                if (waitMs) claimWaiters.add(wake);
                let claimed;
                let timer;
                const disconnect = () => wake();
                try {
                    claimed = await store.claimNext({ executorId, leaseDurationMs });
                    if (!claimed && waitMs) {
                        res.once('close', disconnect);
                        timer = setTimeout(wake, waitMs);
                        await queued;
                        if (res.destroyed) return;
                        await expireLeaseAndBroadcast();
                        runningBeforeClaim = (await store.list({ state: 'running' }))[0] ?? null;
                        claimed = await store.claimNext({ executorId, leaseDurationMs });
                    }
                }
                finally {
                    clearTimeout(timer);
                    claimWaiters.delete(wake);
                    res.removeListener('close', disconnect);
                }
                if (!claimed) {
                    res.send({ claimed: false });
                    return;
                }
                if (
                    !runningBeforeClaim
                    || runningBeforeClaim.id !== claimed.command.id
                    || runningBeforeClaim.lastSequence < claimed.command.lastSequence
                ) {
                    await broadcastLatestTransition(claimed.command);
                }
                const presentationMailbox = ensurePresentationMailbox(claimed.command);
                const claimedCommand = executorCommand(claimed.command, presentationMailbox);
                if (!claimedCommand) {
                    // Private slash input is intentionally memory-only. After
                    // restart/expiry it cannot be reconstructed, so fail the
                    // claimed command closed instead of executing an empty or
                    // partially redacted command.
                    const beforeSequence = claimed.command.lastSequence;
                    const failed = await store.fail(
                        claimed.command.id,
                        claimed.lease,
                        'Private runtime command input is no longer available',
                        {
                            databaseRevision: claimed.command.payload?.databaseRevision ?? null,
                            canonicalMutationPersisted: false,
                        },
                    );
                    clearPresentationMailbox(failed.id, failed.requestId);
                    await broadcastRecordsAfter(failed.id, beforeSequence);
                    res.send({ claimed: false });
                    return;
                }
                res.send({
                    claimed: true,
                    command: claimedCommand,
                    lease: claimed.lease,
                });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(app, 'post', '/runtime-generations/executor/heartbeat', async (req, res, next) => {
            if (!await requireExecutorAuth(req, res)) {
                return;
            }
            try {
                await expireLeaseAndBroadcast();
                const commandId = assertNonEmptyString(req.body?.commandId, 'commandId', 128);
                const credentials = executorCredentials(req.body);
                const leaseDurationMs = parsePositiveSafeInteger(
                    req.body?.leaseDurationMs,
                    'leaseDurationMs',
                    undefined,
                );
                const heartbeat = await store.heartbeat(commandId, {
                    ...credentials,
                    leaseDurationMs,
                });
                res.send({
                    success: true,
                    command: publicCommand(heartbeat.command),
                    lease: heartbeat.lease,
                });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(app, 'post', '/runtime-generations', async (req, res, next) => {
            if (!await requireObserverAuth(req, res)) {
                return;
            }
            let presentationToken = null;
            let request = null;
            try {
                presentationToken = presentationTokenFromRequest(req);
                request = preparePresentationAdmission(
                    runtimeGenerationRequest(req),
                    presentationToken,
                );
                const created = await store.create(request);
                for (const wake of claimWaiters) wake();
                const presentationChannel = presentationChannelForToken(
                    created.command,
                    presentationToken,
                );
                const responseBody = {
                    ...publicCommand(created.command),
                    reused: !created.created,
                    ...(presentationToken ? { presentationChannel } : {}),
                };
                res.status(created.created ? 201 : 200).send(responseBody);
            }
            catch (error) {
                if (error?.code === 'IDEMPOTENCY_CONFLICT') {
                    discardRejectedPresentationAdmission(request, presentationToken);
                }
                sendRouteError(error, res, next);
            }
        });

        registerRoute(app, 'get', '/runtime-generations', async (req, res, next) => {
            if (!await requireObserverAuth(req, res)) {
                return;
            }
            try {
                const filter = {};
                for (const key of ['state', 'requestId', 'action', 'characterId', 'chatId']) {
                    if (typeof req.query[key] === 'string') {
                        filter[key] = req.query[key];
                    }
                }
                const commands = await store.list(filter);
                const updatedAfter = req.query.updatedAfter === undefined
                    ? null
                    : parseNonNegativeSafeInteger(req.query.updatedAfter, 'updatedAfter');
                const limit = req.query.limit === undefined
                    ? null
                    : parsePositiveSafeInteger(req.query.limit, 'limit');
                if (limit !== null && limit > 500) {
                    throw new TypeError('limit must be at most 500');
                }
                const selected = commands
                    .filter((command) => updatedAfter === null || command.updatedAt >= updatedAfter)
                    .slice(limit === null ? 0 : -limit);
                res.setHeader('Cache-Control', 'no-store');
                res.send({ commands: selected.map((command) => publicCommand(command)) });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(app, 'get', '/runtime-generations/:commandId/events', async (req, res, next) => {
            if (!await requireObserverAuth(req, res)) {
                return;
            }
            try {
                const afterSequence = parseNonNegativeSafeInteger(
                    req.query.afterSequence,
                    'afterSequence',
                    0,
                );
                const limit = parsePositiveSafeInteger(req.query.limit, 'limit', replayPageSize);
                if (limit > 10_000) {
                    throw new TypeError('limit must be at most 10000');
                }
                const page = await store.replay(req.params.commandId, { afterSequence, limit });
                res.setHeader('Cache-Control', 'no-store');
                res.send({
                    events: page.events.map((record) => wireGenerationEvent(req.params.commandId, record)),
                    nextCursor: page.nextCursor,
                    hasMore: page.hasMore,
                });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(app, 'get', '/runtime-generations/:commandId', async (req, res, next) => {
            if (!await requireObserverAuth(req, res)) {
                return;
            }
            try {
                const command = await store.get(req.params.commandId);
                res.setHeader('Cache-Control', 'no-store');
                res.send(publicCommand(command, { includePayload: true }));
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(app, 'get', '/runtime-generations/:commandId/output', async (req, res, next) => {
            if (!await requireObserverAuth(req, res)) {
                return;
            }
            try {
                const output = await store.getOutput(req.params.commandId);
                res.setHeader('Cache-Control', 'no-store');
                res.send({ output: output ? wireGenerationOutput(output) : null });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(app, 'put', '/runtime-generations/:commandId/output', async (req, res, next) => {
            if (!await requireExecutorAuth(req, res)) {
                return;
            }
            try {
                await expireLeaseAndBroadcast();
                const credentials = executorCredentials(req.body);
                const payload = generationOutputPayload(req.body);
                const published = await store.publishOutput(
                    req.params.commandId,
                    credentials,
                    payload,
                );
                if (published.created) {
                    broadcastOutput(req.params.commandId, published.output);
                }
                res.setHeader('Cache-Control', 'no-store');
                res.status(published.created ? 201 : 200).send({
                    output: wireGenerationOutput(published.output),
                    reused: !published.created,
                });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(
            app,
            'put',
            '/runtime-generations/:commandId/presentation/:actionId',
            async (req, res, next) => {
                if (!await requireExecutorAuth(req, res)) {
                    return;
                }
                try {
                    await expireLeaseAndBroadcast();
                    const credentials = executorCredentials(req.body);
                    await store.assertCurrentLease(req.params.commandId, credentials);
                    prunePresentationMailboxes();
                    const mailbox = presentationMailboxes.get(req.params.commandId);
                    if (!mailbox) {
                        res.status(404).send({
                            error: 'Runtime presentation mailbox is unavailable',
                            code: 'PRESENTATION_MAILBOX_UNAVAILABLE',
                        });
                        return;
                    }
                    const normalized = presentationAction({
                        actionId: req.params.actionId,
                        action: req.body?.action,
                    });
                    const existing = mailbox.actions.get(normalized.actionId);
                    if (existing
                        && stableJsonStringify(existing) !== stableJsonStringify(normalized.action)) {
                        res.status(409).send({
                            error: 'Runtime presentation action conflicts with its existing value',
                            code: 'PRESENTATION_ACTION_CONFLICT',
                        });
                        return;
                    }
                    if (!existing) {
                        if (mailbox.actions.size >= presentationMailboxMaxActions) {
                            res.status(413).send({
                                error: 'Runtime presentation mailbox action limit exceeded',
                                code: 'PRESENTATION_ACTION_LIMIT',
                            });
                            return;
                        }
                        mailbox.actions.set(normalized.actionId, normalized.action);
                    }
                    mailbox.expiresAt = now() + presentationMailboxTtlMs;
                    res.setHeader('Cache-Control', 'no-store');
                    res.status(existing ? 200 : 201).send({
                        accepted: !existing,
                        reused: !!existing,
                    });
                }
                catch (error) {
                    sendRouteError(error, res, next);
                }
            },
        );

        registerRoute(
            app,
            'post',
            '/runtime-generations/:commandId/presentation/consume',
            async (req, res, next) => {
                if (!await requireObserverAuth(req, res)) {
                    return;
                }
                try {
                    const token = presentationTokenFromRequest(req);
                    prunePresentationMailboxes();
                    const mailbox = token
                        ? presentationMailboxes.get(req.params.commandId)
                        : null;
                    if (!mailbox || !presentationTokenMatches(mailbox, token)) {
                        res.status(404).send({
                            error: 'Runtime presentation mailbox is unavailable',
                            code: 'PRESENTATION_MAILBOX_UNAVAILABLE',
                        });
                        return;
                    }
                    const command = await store.get(req.params.commandId);
                    if (command.state !== 'completed') {
                        // Failed/cancelled/interrupted commands discard effects
                        // at their terminal transition. A running command may
                        // not expose a presentation effect before its outcome.
                        res.status(409).send({
                            error: 'Runtime presentation is not ready',
                            code: 'PRESENTATION_NOT_READY',
                        });
                        return;
                    }
                    const actions = [...mailbox.actions.values()];
                    mailbox.expiresAt = now() + presentationMailboxTtlMs;
                    res.setHeader('Cache-Control', 'no-store');
                    res.send({ actions });
                }
                catch (error) {
                    sendRouteError(error, res, next);
                }
            },
        );

        registerRoute(
            app,
            'delete',
            '/runtime-generations/:commandId/presentation/consume',
            async (req, res, next) => {
                if (!await requireObserverAuth(req, res)) {
                    return;
                }
                try {
                    const token = presentationTokenFromRequest(req);
                    prunePresentationMailboxes();
                    const mailbox = token
                        ? presentationMailboxes.get(req.params.commandId)
                        : null;
                    if (!mailbox || !presentationTokenMatches(mailbox, token)) {
                        res.status(404).send({
                            error: 'Runtime presentation mailbox is unavailable',
                            code: 'PRESENTATION_MAILBOX_UNAVAILABLE',
                        });
                        return;
                    }
                    clearPresentationMailbox(req.params.commandId, mailbox.requestId);
                    res.setHeader('Cache-Control', 'no-store');
                    res.send({ acknowledged: true });
                }
                catch (error) {
                    sendRouteError(error, res, next);
                }
            },
        );

        registerRoute(app, 'post', '/runtime-generations/:commandId/socket-ticket', async (req, res, next) => {
            if (!await requireObserverAuth(req, res)) {
                return;
            }
            try {
                await store.get(req.params.commandId);
                const clientId = req.body?.clientId === undefined
                    ? ''
                    : assertNonEmptyString(req.body.clientId, 'clientId', 256);
                const ticket = createSocketTicket(req.params.commandId, clientId);
                res.setHeader('Cache-Control', 'no-store');
                res.send({
                    ticket: ticket.ticket,
                    expiresAt: ticket.expiresAt,
                    path: `/runtime-generations/${encodeURIComponent(req.params.commandId)}/ws`,
                });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(app, 'post', '/runtime-generations/:commandId/progress', async (req, res, next) => {
            if (!await requireExecutorAuth(req, res)) {
                return;
            }
            try {
                await expireLeaseAndBroadcast();
                const credentials = executorCredentials(req.body);
                const eventType = assertNonEmptyString(req.body?.eventType, 'eventType', 64);
                if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(eventType)) {
                    throw new TypeError('eventType contains unsupported characters');
                }
                const payload = req.body?.payload === undefined
                    ? {}
                    : assertJsonObject(req.body.payload, 'payload');
                assertSerializedLimit(payload, 'payload', maxProgressPayloadBytes);
                if (eventType === 'input_committed') {
                    const committed = await store.recordInputCommitted(
                        req.params.commandId,
                        credentials,
                        payload,
                    );
                    if (committed.created) {
                        broadcastRecord(req.params.commandId, committed.record);
                    }
                    res.send({
                        success: true,
                        reused: !committed.created,
                        event: wireGenerationEvent(req.params.commandId, committed.record),
                    });
                    return;
                }
                if (eventType === 'ui_prompt') {
                    const promptId = assertPromptId(payload.promptId);
                    const prompt = normalizeUiPrompt(payload.prompt);
                    const issued = await store.issueUiPrompt(
                        req.params.commandId,
                        credentials,
                        promptId,
                        prompt,
                    );
                    if (issued.created) {
                        broadcastRecord(req.params.commandId, issued.record);
                    }
                    res.send({
                        success: true,
                        reused: !issued.created,
                        event: wireGenerationEvent(req.params.commandId, issued.record),
                    });
                    return;
                }
                if (eventType === 'ui_notice') {
                    const notice = normalizeUiPrompt(payload.notice);
                    if (notice.type !== 'normal' && notice.type !== 'error' && notice.type !== 'markdown') {
                        throw new TypeError('UI notices must use normal, error, or markdown alerts');
                    }
                    const record = await store.appendProgress(
                        req.params.commandId,
                        credentials,
                        eventType,
                        { notice },
                    );
                    broadcastRecord(req.params.commandId, record);
                    res.send({ success: true, event: wireGenerationEvent(req.params.commandId, record) });
                    return;
                }
                if (eventType === 'ui_prompt_response') {
                    throw new TypeError('eventType ui_prompt_response is reserved for observers');
                }
                const record = await store.appendProgress(
                    req.params.commandId,
                    credentials,
                    eventType,
                    payload,
                );
                broadcastRecord(req.params.commandId, record);
                res.send({ success: true, event: wireGenerationEvent(req.params.commandId, record) });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(
            app,
            'post',
            '/runtime-generations/:commandId/ui-prompts/:promptId/response',
            async (req, res, next) => {
                if (!await requireObserverAuth(req, res)) {
                    return;
                }
                try {
                    const promptId = assertPromptId(req.params.promptId);
                    const response = assertString(
                        req.body?.response,
                        'response',
                        maxUiPromptResponseBytes,
                    );
                    assertSerializedLimit({ promptId, response }, 'UI prompt response', maxUiPromptResponseBytes);
                    const accepted = await store.respondToUiPrompt(
                        req.params.commandId,
                        promptId,
                    );
                    if (accepted.created) {
                        storeUiPromptResponse(req.params.commandId, promptId, response);
                        broadcastRecord(req.params.commandId, accepted.record);
                    }
                    res.send({
                        success: true,
                        accepted: accepted.created,
                        reused: !accepted.created,
                        event: wireGenerationEvent(req.params.commandId, accepted.record),
                    });
                }
                catch (error) {
                    sendRouteError(error, res, next);
                }
            },
        );

        registerRoute(
            app,
            'post',
            '/runtime-generations/:commandId/ui-prompts/:promptId/consume-response',
            async (req, res, next) => {
                if (!await requireExecutorAuth(req, res)) {
                    return;
                }
                try {
                    await expireLeaseAndBroadcast();
                    const promptId = assertPromptId(req.params.promptId);
                    const credentials = executorCredentials(req.body);
                    await store.assertCurrentLease(req.params.commandId, credentials);
                    pruneUiPromptResponses();
                    const mailbox = uiPromptResponses.get(
                        uiPromptResponseKey(req.params.commandId, promptId),
                    );
                    if (!mailbox) {
                        res.status(404).send({
                            error: 'UI prompt response is no longer available',
                            code: 'UI_PROMPT_RESPONSE_UNAVAILABLE',
                        });
                        return;
                    }
                    res.setHeader('Cache-Control', 'no-store');
                    res.send({ response: mailbox.response });
                }
                catch (error) {
                    sendRouteError(error, res, next);
                }
            },
        );

        registerRoute(app, 'post', '/runtime-generations/:commandId/complete', async (req, res, next) => {
            if (!await requireExecutorAuth(req, res)) {
                return;
            }
            try {
                await expireLeaseAndBroadcast();
                const credentials = executorCredentials(req.body);
                const result = req.body?.result === undefined
                    ? {}
                    : assertJsonObject(req.body.result, 'result');
                assertSerializedLimit(result, 'result', maxTerminalPayloadBytes);
                const before = await store.get(req.params.commandId);
                const command = await store.complete(req.params.commandId, credentials, result);
                clearUiPromptResponses(command.id);
                // Idempotent admission retries can briefly reserve a pending
                // entry after the executor already attached the live mailbox.
                // Terminal completion must not retain that duplicate private
                // input for the rest of its TTL.
                pendingPresentationMailboxes.delete(command.requestId);
                if (presentationMailboxes.get(command.id)?.tokenHash === null) {
                    clearPresentationMailbox(command.id, command.requestId);
                }
                await broadcastRecordsAfter(command.id, before.lastSequence);
                res.send({ success: true, command: publicCommand(command) });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(
            app,
            'post',
            '/runtime-generations/:commandId/cancel-complete',
            async (req, res, next) => {
                if (!await requireExecutorAuth(req, res)) {
                    return;
                }
                try {
                    await expireLeaseAndBroadcast();
                    const credentials = executorCredentials(req.body);
                    const result = req.body?.result === undefined
                        ? {}
                        : assertJsonObject(req.body.result, 'result');
                    assertSerializedLimit(result, 'result', maxTerminalPayloadBytes);
                    const before = await store.get(req.params.commandId);
                    const command = await store.completeCancellation(
                        req.params.commandId,
                        credentials,
                        result,
                    );
                    clearUiPromptResponses(command.id);
                    clearPresentationMailbox(command.id, command.requestId);
                    await broadcastRecordsAfter(command.id, before.lastSequence);
                    res.send({ success: true, command: publicCommand(command) });
                }
                catch (error) {
                    sendRouteError(error, res, next);
                }
            },
        );

        registerRoute(app, 'post', '/runtime-generations/:commandId/fail', async (req, res, next) => {
            if (!await requireExecutorAuth(req, res)) {
                return;
            }
            try {
                await expireLeaseAndBroadcast();
                const credentials = executorCredentials(req.body);
                const errorMessage = assertNonEmptyString(req.body?.error, 'error', 8_192);
                const details = req.body?.details === undefined
                    ? {}
                    : assertJsonObject(req.body.details, 'details');
                assertSerializedLimit(details, 'details', maxTerminalPayloadBytes);
                const before = await store.get(req.params.commandId);
                const command = await store.fail(
                    req.params.commandId,
                    credentials,
                    errorMessage,
                    details,
                );
                clearUiPromptResponses(command.id);
                clearPresentationMailbox(command.id, command.requestId);
                await broadcastRecordsAfter(command.id, before.lastSequence);
                res.send({ success: true, command: publicCommand(command) });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(app, 'delete', '/runtime-generations/by-request/:requestId', async (req, res, next) => {
            if (!await requireObserverAuth(req, res)) {
                return;
            }
            let presentationToken = null;
            let request = null;
            try {
                presentationToken = presentationTokenFromRequest(req);
                request = preparePresentationAdmission(
                    runtimeGenerationRequest(req, req.params.requestId),
                    presentationToken,
                );
                const cancellation = await store.cancelByRequest(request, {
                    reason: 'user_cancel_by_request',
                });
                const command = cancellation.command;
                let presentationChannel = presentationChannelForToken(
                    command,
                    presentationToken,
                );
                if (command.state === 'cancelled') {
                    clearUiPromptResponses(command.id);
                    clearPresentationMailbox(command.id, command.requestId);
                    presentationChannel = false;
                }
                if (command.lastSequence > cancellation.previousLastSequence) {
                    await broadcastRecordsAfter(command.id, cancellation.previousLastSequence);
                }
                res.send({
                    success: true,
                    created: cancellation.created,
                    command: {
                        ...publicCommand(command, { includePayload: true }),
                        ...(presentationToken ? { presentationChannel } : {}),
                    },
                });
            }
            catch (error) {
                if (error?.code === 'IDEMPOTENCY_CONFLICT') {
                    discardRejectedPresentationAdmission(request, presentationToken);
                }
                sendRouteError(error, res, next);
            }
        });

        registerRoute(app, 'delete', '/runtime-generations/:commandId', async (req, res, next) => {
            if (!await requireObserverAuth(req, res)) {
                return;
            }
            try {
                const before = await store.get(req.params.commandId);
                const command = await store.cancel(req.params.commandId, { reason: 'user_cancel' });
                if (command.state === 'cancelled') {
                    clearUiPromptResponses(command.id);
                    clearPresentationMailbox(command.id, command.requestId);
                }
                if (command.lastSequence > before.lastSequence) {
                    await broadcastRecordsAfter(command.id, before.lastSequence);
                }
                res.send({ success: true, command: publicCommand(command) });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });
    }

    function setupWebSocket(server) {
        const wsServer = new WebSocketServer({ noServer: true });
        server.on('upgrade', (req, socket, head) => {
            let reqUrl;
            try {
                reqUrl = new URL(req.url, `http://${req.headers.host}`);
            }
            catch {
                return;
            }
            if (!reqUrl.pathname.startsWith('/runtime-generations/') || !reqUrl.pathname.endsWith('/ws')) {
                return;
            }

            void (async () => {
                const pathParts = reqUrl.pathname.split('/').filter(Boolean);
                const commandId = pathParts.length === 3 ? pathParts[1] : '';
                if (!commandId) {
                    rejectWebSocketUpgrade(socket, 400, 'Bad Request');
                    return;
                }
                const ticket = consumeSocketTicket(reqUrl.searchParams.get('ticket'), commandId);
                if (!ticket) {
                    rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
                    return;
                }
                await store.get(commandId);
                const afterSequence = parseNonNegativeSafeInteger(
                    reqUrl.searchParams.get('afterSequence'),
                    'afterSequence',
                    0,
                );
                wsServer.handleUpgrade(req, socket, head, (ws) => {
                    wsServer.emit('connection', ws, req, { commandId, afterSequence, ticket });
                });
            })().catch((error) => {
                if (error?.code === 'COMMAND_NOT_FOUND') {
                    rejectWebSocketUpgrade(socket, 404, 'Not Found');
                    return;
                }
                console.error('[Runtime Generation] WebSocket upgrade failed:', error);
                rejectWebSocketUpgrade(socket, 400, 'Bad Request');
            });
        });

        wsServer.on('connection', async (ws, _req, connection) => {
            const { commandId, afterSequence, ticket } = connection;
            const subscriber = {
                ws,
                ready: false,
                closing: false,
                terminalObserved: false,
                pendingEvents: [],
                pendingOutput: null,
                outputSendInFlight: false,
                lastSequence: afterSequence,
                lastOutputVersion: 0,
            };
            let commandSubscribers = subscribers.get(commandId);
            if (!commandSubscribers) {
                commandSubscribers = new Set();
                subscribers.set(commandId, commandSubscribers);
            }
            commandSubscribers.add(subscriber);
            let pingTimer = null;
            const cleanup = () => {
                if (pingTimer) {
                    clearInterval(pingTimer);
                    pingTimer = null;
                }
                const current = subscribers.get(commandId);
                current?.delete(subscriber);
                if (current?.size === 0) {
                    subscribers.delete(commandId);
                }
            };
            ws.once('close', cleanup);
            ws.once('error', cleanup);

            try {
                const command = await store.get(commandId);
                if (ws.readyState !== ws.OPEN) {
                    cleanup();
                    return;
                }
                ws.send(JSON.stringify({
                    type: 'generation_snapshot',
                    ...publicCommand(command),
                    clientId: ticket.clientId,
                }));

                let replayCursor = afterSequence;
                let terminalObserved = TERMINAL_RUNTIME_GENERATION_STATES.has(command.state);
                subscriber.terminalObserved = terminalObserved;
                while (ws.readyState === ws.OPEN) {
                    const page = await store.replay(commandId, {
                        afterSequence: replayCursor,
                        limit: replayPageSize,
                    });
                    for (const record of page.events) {
                        if (ws.readyState === ws.OPEN) {
                            ws.send(JSON.stringify(wireGenerationEvent(commandId, record)));
                        }
                        terminalObserved ||= TERMINAL_RUNTIME_GENERATION_STATES.has(record.type);
                        subscriber.terminalObserved = terminalObserved;
                    }
                    replayCursor = page.nextCursor;
                    if (!page.hasMore) {
                        break;
                    }
                }

                const persistedOutput = await store.getOutput(commandId);
                const latestCommand = await store.get(commandId);
                terminalObserved ||= TERMINAL_RUNTIME_GENERATION_STATES.has(latestCommand.state);

                subscriber.pendingEvents.sort((left, right) => left.sequence - right.sequence);
                for (const event of subscriber.pendingEvents) {
                    if (event.sequence > replayCursor && ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify(event));
                        replayCursor = event.sequence;
                    }
                    terminalObserved ||= TERMINAL_RUNTIME_GENERATION_STATES.has(event.eventType);
                    subscriber.terminalObserved = terminalObserved;
                }
                subscriber.pendingEvents = [];
                subscriber.lastSequence = replayCursor;
                let latestOutput = null;
                if (!terminalObserved) {
                    const persistedWireOutput = persistedOutput
                        ? wireGenerationOutput(persistedOutput)
                        : null;
                    if (!persistedWireOutput) {
                        latestOutput = subscriber.pendingOutput;
                    }
                    else if (!subscriber.pendingOutput
                        || persistedWireOutput.version >= subscriber.pendingOutput.version) {
                        latestOutput = persistedWireOutput;
                    }
                    else {
                        latestOutput = subscriber.pendingOutput;
                    }
                }
                subscriber.pendingOutput = null;
                subscriber.ready = true;
                subscriber.terminalObserved = terminalObserved;
                if (latestOutput && ws.readyState === ws.OPEN) {
                    queueSubscriberOutput(subscriber, latestOutput);
                }
                if (subscriber.closing || ws.readyState !== ws.OPEN) {
                    return;
                }
                pingTimer = setInterval(() => {
                    if (ws.readyState === ws.OPEN) {
                        try {
                            ws.send(JSON.stringify({ type: 'generation_ping', ts: now() }));
                        }
                        catch {
                            closeBackpressuredSubscriber(subscriber);
                        }
                    }
                }, 15_000);
            }
            catch (error) {
                console.error('[Runtime Generation] WebSocket connection failed:', error);
                if (ws.readyState === ws.OPEN) {
                    ws.close(1011, 'Runtime generation unavailable');
                }
                cleanup();
            }
        });

        return wsServer;
    }

    return {
        expireLeaseAndBroadcast,
        getExecutorHealth,
        registerRoutes,
        setupWebSocket,
    };
}

module.exports = {
    RUNTIME_GENERATION_ACTIONS,
    createRuntimeGenerationServer,
    hashRuntimeGenerationRequest,
    normalizeExecutorIp,
    stableJsonStringify,
};
