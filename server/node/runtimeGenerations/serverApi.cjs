'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const DEFAULT_SOCKET_TICKET_TTL_MS = 30_000;
const DEFAULT_SOCKET_TICKET_LIMIT = 512;
const DEFAULT_REPLAY_PAGE_SIZE = 1_000;
const DEFAULT_MAX_REQUEST_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_PROGRESS_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_MAX_TERMINAL_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_MAX_UI_PROMPT_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_UI_PROMPT_RESPONSE_TTL_MS = 35 * 60_000;
const DEFAULT_UI_PROMPT_RESPONSE_LIMIT = 512;
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
]);
const RUNTIME_GENERATION_ACTION_SET = new Set(RUNTIME_GENERATION_ACTIONS);

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
    const maxUiPromptResponseBytes = options.maxUiPromptResponseBytes
        ?? DEFAULT_MAX_UI_PROMPT_RESPONSE_BYTES;
    const uiPromptResponseTtlMs = options.uiPromptResponseTtlMs
        ?? DEFAULT_UI_PROMPT_RESPONSE_TTL_MS;
    const uiPromptResponseLimit = options.uiPromptResponseLimit
        ?? DEFAULT_UI_PROMPT_RESPONSE_LIMIT;
    const socketTickets = new Map();
    const subscribers = new Map();
    const uiPromptResponses = new Map();
    let lastExecutorContactAt = 0;

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

    function sendRouteError(error, res, next) {
        const statusCode = Number(error?.statusCode);
        if (Number.isSafeInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
            res.status(statusCode).send({
                error: error.message,
                ...(error.code ? { code: error.code } : {}),
                ...(error.existingCommandId ? { existingCommandId: error.existingCommandId } : {}),
                ...(error.reason ? { reason: error.reason } : {}),
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

    function broadcastRecord(commandId, record) {
        const clients = subscribers.get(commandId);
        if (!clients) {
            return;
        }
        const event = wireGenerationEvent(commandId, record);
        for (const subscriber of clients) {
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
            subscriber.ws.send(JSON.stringify(event));
            subscriber.lastSequence = event.sequence;
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

    function registerRoutes(app) {
        // This endpoint deliberately exposes only liveness, not credentials or
        // command data. The Chromium container uses it to prove that the
        // authenticated resident JavaScript executor has actually entered its
        // claim loop; merely loading a logo or opening a CDP target is not
        // sufficient readiness.
        registerRoute(app, 'get', '/runtime-generations/executor/health', (_req, res) => {
            const timestamp = now();
            const ageMs = lastExecutorContactAt > 0
                ? Math.max(0, timestamp - lastExecutorContactAt)
                : null;
            const ready = ageMs !== null && ageMs <= 10_000;
            res.status(ready ? 200 : 503).send({ ready, ageMs });
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
                const runningBeforeClaim = (await store.list({ state: 'running' }))[0] ?? null;
                const claimed = await store.claimNext({ executorId, leaseDurationMs });
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
                res.send({
                    claimed: true,
                    command: publicCommand(claimed.command, { includePayload: true }),
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
            try {
                const bodyRequestId = typeof req.body?.requestId === 'string' ? req.body.requestId : '';
                const bodyIdempotencyKey = typeof req.body?.idempotencyKey === 'string'
                    ? req.body.idempotencyKey
                    : '';
                const headerIdempotencyKey = normalizeHeader(req.headers['idempotency-key']);
                const suppliedKeys = [bodyRequestId, bodyIdempotencyKey, headerIdempotencyKey].filter(Boolean);
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
                const created = await store.create({
                    requestId,
                    requestHash: hashRuntimeGenerationRequest(requestEnvelope),
                    action,
                    characterId,
                    chatId,
                    payload,
                });
                const responseBody = {
                    ...publicCommand(created.command),
                    reused: !created.created,
                };
                res.status(created.created ? 201 : 200).send(responseBody);
            }
            catch (error) {
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
                await broadcastRecordsAfter(command.id, before.lastSequence);
                res.send({ success: true, command: publicCommand(command) });
            }
            catch (error) {
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
                pendingEvents: [],
                lastSequence: afterSequence,
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
                while (ws.readyState === ws.OPEN) {
                    const page = await store.replay(commandId, {
                        afterSequence: replayCursor,
                        limit: replayPageSize,
                    });
                    for (const record of page.events) {
                        if (ws.readyState === ws.OPEN) {
                            ws.send(JSON.stringify(wireGenerationEvent(commandId, record)));
                        }
                    }
                    replayCursor = page.nextCursor;
                    if (!page.hasMore) {
                        break;
                    }
                }

                subscriber.pendingEvents.sort((left, right) => left.sequence - right.sequence);
                for (const event of subscriber.pendingEvents) {
                    if (event.sequence > replayCursor && ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify(event));
                        replayCursor = event.sequence;
                    }
                }
                subscriber.pendingEvents = [];
                subscriber.lastSequence = replayCursor;
                subscriber.ready = true;
                pingTimer = setInterval(() => {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ type: 'generation_ping', ts: now() }));
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
