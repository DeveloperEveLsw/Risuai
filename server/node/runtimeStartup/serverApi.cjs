'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { normalizeExecutorIp } = require('../runtimeGenerations/serverApi.cjs');

const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_PROMPT_TTL_MS = 30 * 60_000;
const DEFAULT_RESPONSE_TTL_MS = 5 * 60_000;
const DEFAULT_NOTICE_TTL_MS = 5 * 60_000;
const DEFAULT_CONTACT_FRESH_MS = 10_000;
const DEFAULT_SOCKET_TICKET_TTL_MS = 30_000;
const DEFAULT_MAX_SOCKET_TICKETS = 512;
const DEFAULT_MAX_SESSION_REQUESTS = 512;
const DEFAULT_MAX_PENDING_PROMPTS = 16;
const DEFAULT_MAX_NOTICES = 32;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_PENDING_PERMISSION_PROMPTS = 16;
const DEFAULT_MAX_PERMISSION_REQUEST_TOKENS = 512;
const DEFAULT_MAX_PERMISSION_IDEMPOTENCY_RECORDS = 1_024;
const DEFAULT_MAX_PERMISSION_RECORDS = 1_024;
const DEFAULT_MAX_DENIED_PERMISSION_KEYS = 4_096;
const DEFAULT_PERMISSION_PERIOD_MS = 3 * 24 * 60 * 60_000;
const STARTUP_PHASES = new Set([
    'loading_data',
    'loading_plugins',
    'starting_executor',
]);
const STARTUP_PROMPT_TYPES = new Set([
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
const STARTUP_NOTICE_TYPES = new Set(['normal', 'error', 'markdown']);
const PLUGIN_PERMISSION_CAPABILITIES = new Set([
    'fetchLogs',
    'db',
    'mainDom',
    'replacer',
    'provider',
    'sendChat',
]);
const PLUGIN_PERMISSION_POLICIES = new Set([
    'persistent',
    'periodically',
    'always',
]);

class RuntimeStartupError extends Error {
    constructor(message, code, statusCode = 400, details = {}) {
        super(message);
        this.name = 'RuntimeStartupError';
        this.code = code;
        this.statusCode = statusCode;
        Object.assign(this, details);
    }
}

function normalizeHeader(value) {
    if (Array.isArray(value)) {
        return value[0] || '';
    }
    return typeof value === 'string' ? value : '';
}

function assertObject(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RuntimeStartupError(`${field} must be a JSON object`, 'INVALID_STARTUP_REQUEST');
    }
    return value;
}

function assertString(value, field, maxLength, allowEmpty = false) {
    if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
        throw new RuntimeStartupError(`${field} must be a string`, 'INVALID_STARTUP_REQUEST');
    }
    if (value.length > maxLength) {
        throw new RuntimeStartupError(
            `${field} must be at most ${maxLength} characters`,
            'INVALID_STARTUP_REQUEST',
        );
    }
    return value;
}

function assertPositiveInteger(value, field) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RuntimeStartupError(
            `${field} must be a positive safe integer`,
            'INVALID_STARTUP_REQUEST',
        );
    }
    return value;
}

function stableJsonStringify(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new RuntimeStartupError(
                'Startup payload cannot contain non-finite numbers',
                'INVALID_STARTUP_REQUEST',
            );
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableJsonStringify(entry ?? null)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
        return `{${keys.map((key) => (
            `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`
        )).join(',')}}`;
    }
    throw new RuntimeStartupError(
        `Unsupported startup payload value: ${typeof value}`,
        'INVALID_STARTUP_REQUEST',
    );
}

function normalizePrompt(value) {
    const prompt = assertObject(value, 'prompt');
    const type = assertString(prompt.type, 'prompt.type', 32);
    if (!STARTUP_PROMPT_TYPES.has(type)) {
        throw new RuntimeStartupError(
            `Unsupported startup prompt type: ${type}`,
            'INVALID_STARTUP_PROMPT',
        );
    }
    const normalized = {
        type,
        msg: assertString(prompt.msg, 'prompt.msg', 32_768, true),
    };
    for (const [field, maximum] of [
        ['submsg', 8_192],
        ['stackTrace', 32_768],
        ['defaultValue', 32_768],
    ]) {
        if (prompt[field] !== undefined) {
            normalized[field] = assertString(
                prompt[field],
                `prompt.${field}`,
                maximum,
                true,
            );
        }
    }
    if (prompt.datalist !== undefined) {
        if (!Array.isArray(prompt.datalist) || prompt.datalist.length > 256) {
            throw new RuntimeStartupError(
                'prompt.datalist must contain at most 256 entries',
                'INVALID_STARTUP_PROMPT',
            );
        }
        normalized.datalist = prompt.datalist.map((entry, index) => {
            if (!Array.isArray(entry) || entry.length !== 2) {
                throw new RuntimeStartupError(
                    `prompt.datalist[${index}] must contain a value and label`,
                    'INVALID_STARTUP_PROMPT',
                );
            }
            return [
                assertString(entry[0], `prompt.datalist[${index}][0]`, 4_096, true),
                assertString(entry[1], `prompt.datalist[${index}][1]`, 4_096, true),
            ];
        });
    }
    return normalized;
}

function normalizeSource(value) {
    if (value === undefined) {
        return { kind: 'runtime_alert' };
    }
    const source = assertObject(value, 'source');
    const normalized = {
        kind: assertString(source.kind, 'source.kind', 64),
    };
    for (const [field, maximum] of [
        ['pluginName', 512],
        ['pluginVersion', 64],
        ['permission', 128],
        ['pluginScriptHash', 64],
        ['permissionPolicy', 32],
    ]) {
        if (source[field] !== undefined) {
            normalized[field] = assertString(source[field], `source.${field}`, maximum, true);
        }
    }
    return normalized;
}

function normalizePermissionRequest(value) {
    const request = assertObject(value, 'permission request');
    const principal = assertObject(request.principal, 'principal');
    const name = assertString(principal.name, 'principal.name', 512);
    const scriptHash = assertString(principal.scriptHash, 'principal.scriptHash', 64);
    if (!/^[a-f0-9]{64}$/.test(scriptHash)) {
        throw new RuntimeStartupError(
            'principal.scriptHash must be a lowercase SHA-256 digest',
            'INVALID_PLUGIN_PERMISSION_REQUEST',
        );
    }
    const capability = assertString(request.capability, 'capability', 128);
    if (!PLUGIN_PERMISSION_CAPABILITIES.has(capability)) {
        throw new RuntimeStartupError(
            `Unsupported plugin permission capability: ${capability}`,
            'INVALID_PLUGIN_PERMISSION_REQUEST',
        );
    }
    const policy = assertString(request.policy, 'policy', 32);
    if (!PLUGIN_PERMISSION_POLICIES.has(policy)) {
        throw new RuntimeStartupError(
            `Unsupported plugin permission policy: ${policy}`,
            'INVALID_PLUGIN_PERMISSION_REQUEST',
        );
    }
    const prompt = normalizePrompt(request.prompt);
    if (prompt.type !== 'ask') {
        throw new RuntimeStartupError(
            'Plugin permission prompts must use the ask prompt type',
            'INVALID_PLUGIN_PERMISSION_REQUEST',
        );
    }
    const requesterId = assertString(request.requesterId, 'requesterId', 256);
    const requestId = assertString(request.requestId, 'requestId', 128);
    const permission = { name, scriptHash, capability, policy };
    return {
        requesterId,
        requestId,
        permission,
        prompt,
        key: stableJsonStringify(permission),
        requestHash: crypto.createHash('sha256')
            .update(stableJsonStringify({ permission, prompt }))
            .digest('hex'),
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
        + '\r\n',
    );
    socket.destroy();
}

function createRuntimeStartupServer(options = {}) {
    if (typeof options.authenticate !== 'function') {
        throw new TypeError('authenticate is required');
    }
    const authenticate = options.authenticate;
    const routeMiddleware = options.routeMiddleware;
    const executorIp = normalizeExecutorIp(options.executorIp || '');
    const getExecutorHealth = options.getExecutorHealth ?? (() => ({ ready: false, ageMs: null }));
    const now = options.now ?? (() => Date.now());
    const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    const promptTtlMs = options.promptTtlMs ?? DEFAULT_PROMPT_TTL_MS;
    const responseTtlMs = options.responseTtlMs ?? DEFAULT_RESPONSE_TTL_MS;
    const noticeTtlMs = options.noticeTtlMs ?? DEFAULT_NOTICE_TTL_MS;
    const contactFreshMs = options.contactFreshMs ?? DEFAULT_CONTACT_FRESH_MS;
    const socketTicketTtlMs = options.socketTicketTtlMs ?? DEFAULT_SOCKET_TICKET_TTL_MS;
    const maxSocketTickets = options.maxSocketTickets ?? DEFAULT_MAX_SOCKET_TICKETS;
    const maxSessionRequests = options.maxSessionRequests ?? DEFAULT_MAX_SESSION_REQUESTS;
    const maxPendingPrompts = options.maxPendingPrompts ?? DEFAULT_MAX_PENDING_PROMPTS;
    const maxNotices = options.maxNotices ?? DEFAULT_MAX_NOTICES;
    const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    const maxPendingPermissionPrompts = options.maxPendingPermissionPrompts
        ?? DEFAULT_MAX_PENDING_PERMISSION_PROMPTS;
    const maxPermissionRequestTokens = options.maxPermissionRequestTokens
        ?? DEFAULT_MAX_PERMISSION_REQUEST_TOKENS;
    const maxPermissionIdempotencyRecords = options.maxPermissionIdempotencyRecords
        ?? DEFAULT_MAX_PERMISSION_IDEMPOTENCY_RECORDS;
    const maxPermissionRecords = options.maxPermissionRecords
        ?? DEFAULT_MAX_PERMISSION_RECORDS;
    const maxDeniedPermissionKeys = options.maxDeniedPermissionKeys
        ?? DEFAULT_MAX_DENIED_PERMISSION_KEYS;
    const permissionPeriodMs = options.permissionPeriodMs ?? DEFAULT_PERMISSION_PERIOD_MS;
    const permissionStore = options.permissionStore ?? {
        async getGrant() { return null; },
        async recordGrant(_key, grantedAt) { return grantedAt; },
    };
    if (typeof permissionStore.getGrant !== 'function'
        || typeof permissionStore.recordGrant !== 'function') {
        throw new TypeError('permissionStore must implement getGrant and recordGrant');
    }
    const socketTickets = new Map();
    const sessionRequests = new Map();
    const permissionRecords = new Map();
    const pendingPermissionByKey = new Map();
    const permissionRequestTokens = new Map();
    const permissionIdempotency = new Map();
    const deniedPermissionKeys = new Set();
    const subscribers = new Set();
    const instanceId = options.instanceId ?? crypto.randomUUID();
    let permissionMutation = Promise.resolve();
    let session = null;
    let lastSessionFence = 0;
    let sequence = 0;

    function sendRouteError(error, res, next) {
        if (error instanceof RuntimeStartupError) {
            res.status(error.statusCode).send({
                error: error.message,
                code: error.code,
            });
            return;
        }
        next(error);
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

    async function requireStartupProducerAuth(req, res) {
        // Deliberately does not update runtime-generation claim contact. A
        // resident that can authenticate and heartbeat while waiting for UI is
        // alive, but it is not claim-ready until claim-next itself is polling.
        if (!await authenticate(req, res)) {
            return false;
        }
        const sourceIp = normalizeExecutorIp(req.socket?.remoteAddress || req.ip);
        if (executorIp && sourceIp !== executorIp) {
            res.status(403).send({
                error: 'Runtime startup producer is not allowed from this IP',
                code: 'STARTUP_PRODUCER_IP_FORBIDDEN',
            });
            return false;
        }
        return true;
    }

    function publicPrompt(prompt) {
        return {
            promptId: prompt.id,
            prompt: prompt.prompt,
            source: prompt.source,
            createdAt: prompt.createdAt,
            expiresAt: prompt.expiresAt,
        };
    }

    function publicNotice(notice) {
        return {
            noticeId: notice.id,
            notice: notice.notice,
            source: notice.source,
            createdAt: notice.createdAt,
            expiresAt: notice.expiresAt,
        };
    }

    function pendingPrompts() {
        if (!session || session.state === 'expired') {
            return [];
        }
        return [...session.prompts.values()]
            .filter((prompt) => prompt.state === 'pending')
            .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    }

    function pendingPermissionPrompts() {
        return [...permissionRecords.values()]
            .filter((prompt) => prompt.state === 'pending' || prompt.state === 'deciding')
            .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    }

    function allPendingPrompts() {
        return [...pendingPrompts(), ...pendingPermissionPrompts()]
            .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    }

    function effectivePhase() {
        if (allPendingPrompts().length > 0) {
            return 'waiting_for_ui';
        }
        if (!session || session.state === 'expired') {
            return 'unavailable';
        }
        return session.phase;
    }

    function publicSnapshot() {
        return {
            type: 'runtime_startup_snapshot',
            instanceId,
            sequence,
            sessionId: session?.state === 'active' ? session.id : null,
            phase: effectivePhase(),
            prompts: allPendingPrompts().map(publicPrompt),
            notices: session?.state === 'active'
                ? [...session.notices.values()]
                    .sort((left, right) => left.createdAt - right.createdAt)
                    .map(publicNotice)
                : [],
        };
    }

    function broadcast(eventType, payload = {}) {
        const event = {
            type: 'runtime_startup_event',
            instanceId,
            sequence: ++sequence,
            eventType,
            timestamp: now(),
            ...payload,
        };
        const serialized = JSON.stringify(event);
        for (const subscriber of subscribers) {
            if (!subscriber.ready) {
                subscriber.pending.push(event);
                continue;
            }
            if (subscriber.ws.readyState === subscriber.ws.OPEN) {
                try {
                    subscriber.ws.send(serialized);
                }
                catch {
                    subscriber.ws.terminate?.();
                }
            }
        }
        return event;
    }

    function settlePrompt(prompt, state, reason) {
        if (prompt.state !== 'pending' && prompt.state !== 'answered') {
            return;
        }
        prompt.state = state;
        prompt.response = null;
        prompt.settledAt = now();
        broadcast('prompt_settled', {
            promptId: prompt.id,
            state,
            reason,
        });
    }

    function settlePermissionPrompt(prompt, state, reason) {
        if (prompt.state !== 'pending') {
            return;
        }
        prompt.state = state;
        prompt.settledAt = now();
        prompt.responseExpiresAt = prompt.settledAt + responseTtlMs;
        if (pendingPermissionByKey.get(prompt.permissionKey) === prompt) {
            pendingPermissionByKey.delete(prompt.permissionKey);
        }
        broadcast('prompt_settled', {
            promptId: prompt.id,
            state: state === 'expired' ? 'expired' : 'answered',
            reason,
        });
    }

    function expirePermissionState(timestamp) {
        for (const [promptId, prompt] of permissionRecords) {
            if (prompt.state === 'pending' && prompt.expiresAt <= timestamp) {
                settlePermissionPrompt(prompt, 'expired', 'prompt_timeout');
            }
            if (prompt.state !== 'pending'
                && prompt.state !== 'deciding'
                && prompt.responseExpiresAt !== null
                && prompt.responseExpiresAt <= timestamp) {
                permissionRecords.delete(promptId);
            }
        }
        for (const [token, entry] of permissionRequestTokens) {
            if (entry.expiresAt <= timestamp || !permissionRecords.has(entry.promptId)) {
                permissionRequestTokens.delete(token);
            }
        }
        for (const [idempotencyKey, entry] of permissionIdempotency) {
            if (entry.expiresAt <= timestamp || !permissionRequestTokens.has(entry.requestToken)) {
                permissionIdempotency.delete(idempotencyKey);
            }
        }
    }

    function expireState() {
        const timestamp = now();
        expirePermissionState(timestamp);
        if (session?.state === 'active') {
            for (const prompt of session.prompts.values()) {
                if (prompt.state === 'pending' && prompt.expiresAt <= timestamp) {
                    settlePrompt(prompt, 'expired', 'prompt_timeout');
                }
                else if (prompt.state === 'answered' && prompt.responseExpiresAt <= timestamp) {
                    settlePrompt(prompt, 'expired', 'response_timeout');
                }
            }
            for (const [noticeId, notice] of session.notices) {
                if (notice.expiresAt <= timestamp) {
                    session.notices.delete(noticeId);
                    broadcast('notice_expired', { noticeId });
                }
            }
            const executorReady = getExecutorHealth()?.ready === true;
            if (!executorReady && session.expiresAt <= timestamp) {
                for (const prompt of session.prompts.values()) {
                    settlePrompt(prompt, 'expired', 'session_timeout');
                }
                session.state = 'expired';
                session.phase = 'expired';
                broadcast('session_expired', { sessionId: session.id });
            }
        }
        for (const [ticket, entry] of socketTickets) {
            if (entry.expiresAt <= timestamp) {
                socketTickets.delete(ticket);
            }
        }
    }

    function sessionEnvelope() {
        return {
            sessionId: session.id,
            producerId: session.producerId,
            fencingToken: session.fencingToken,
            phase: effectivePhase(),
            expiresAt: session.expiresAt,
        };
    }

    function requireCurrentSession(sessionId, body) {
        expireState();
        if (!session || session.id !== sessionId || session.state !== 'active') {
            throw new RuntimeStartupError(
                'Runtime startup session is no longer current',
                'STALE_STARTUP_SESSION',
                409,
            );
        }
        const producerId = assertString(body?.producerId, 'producerId', 256);
        const fencingToken = assertPositiveInteger(body?.fencingToken, 'fencingToken');
        if (producerId !== session.producerId || fencingToken !== session.fencingToken) {
            throw new RuntimeStartupError(
                'Runtime startup session fence is stale',
                'STALE_STARTUP_SESSION',
                409,
            );
        }
        const timestamp = now();
        session.lastContactAt = timestamp;
        // This is an active producer lease, not an absolute boot deadline.
        // Keep it sliding so a healthy resident that has been claim-ready for
        // hours can later fall back to a startup/plugin prompt without finding
        // that its otherwise-current mailbox expired long ago.
        session.expiresAt = timestamp + sessionTtlMs;
        return session;
    }

    function createSocketTicket(clientId) {
        expireState();
        while (socketTickets.size >= maxSocketTickets) {
            const oldest = socketTickets.keys().next().value;
            if (!oldest) {
                break;
            }
            socketTickets.delete(oldest);
        }
        const ticket = crypto.randomBytes(32).toString('base64url');
        const entry = {
            clientId,
            expiresAt: now() + socketTicketTtlMs,
        };
        socketTickets.set(ticket, entry);
        return { ticket, ...entry };
    }

    function consumeSocketTicket(ticket) {
        expireState();
        const entry = socketTickets.get(ticket);
        if (ticket) {
            socketTickets.delete(ticket);
        }
        if (!entry || entry.expiresAt <= now()) {
            return null;
        }
        return entry;
    }

    function rememberSessionRequest(requestId, producerId, sessionId) {
        while (sessionRequests.size >= maxSessionRequests) {
            const oldest = sessionRequests.keys().next().value;
            if (!oldest) {
                break;
            }
            sessionRequests.delete(oldest);
        }
        sessionRequests.set(requestId, { producerId, sessionId });
    }

    function withPermissionMutation(callback) {
        const operation = permissionMutation.then(callback, callback);
        permissionMutation = operation.catch(() => {});
        return operation;
    }

    function prunePermissionCapacity(map, maximum) {
        while (map.size >= maximum) {
            const oldest = map.keys().next().value;
            if (!oldest) {
                break;
            }
            map.delete(oldest);
        }
    }

    function createPermissionRequestToken(promptId) {
        prunePermissionCapacity(permissionRequestTokens, maxPermissionRequestTokens);
        const requestToken = crypto.randomBytes(32).toString('base64url');
        permissionRequestTokens.set(requestToken, {
            promptId,
            expiresAt: now() + promptTtlMs + responseTtlMs,
        });
        return requestToken;
    }

    function ensurePermissionRecordCapacity() {
        while (permissionRecords.size >= maxPermissionRecords) {
            let terminal = null;
            for (const prompt of permissionRecords.values()) {
                if (prompt.state !== 'pending' && prompt.state !== 'deciding') {
                    terminal = prompt;
                    break;
                }
            }
            if (!terminal) {
                throw new RuntimeStartupError(
                    'Runtime plugin permission record capacity is exhausted',
                    'PLUGIN_PERMISSION_RECORD_LIMIT',
                    429,
                );
            }
            permissionRecords.delete(terminal.id);
            for (const [token, entry] of permissionRequestTokens) {
                if (entry.promptId === terminal.id) {
                    permissionRequestTokens.delete(token);
                }
            }
        }
    }

    function permissionRequestResponse(prompt, requestToken, reused) {
        if (prompt.state === 'granted' || prompt.state === 'denied') {
            return {
                state: prompt.state,
                cached: false,
                reused,
            };
        }
        return {
            state: 'pending',
            requestToken,
            expiresAt: prompt.expiresAt,
            cached: false,
            reused,
        };
    }

    async function createPermissionRequest(rawRequest) {
        return await withPermissionMutation(async () => {
            expireState();
            const request = normalizePermissionRequest(rawRequest);
            const idempotencyKey = `${request.requesterId}\0${request.requestId}`;
            const previousRequest = permissionIdempotency.get(idempotencyKey);
            if (previousRequest) {
                if (previousRequest.requestHash !== request.requestHash) {
                    throw new RuntimeStartupError(
                        'Plugin permission requestId was reused with different content',
                        'PLUGIN_PERMISSION_IDEMPOTENCY_CONFLICT',
                        409,
                    );
                }
                const previousToken = permissionRequestTokens.get(previousRequest.requestToken);
                const previousPrompt = previousToken
                    ? permissionRecords.get(previousToken.promptId)
                    : null;
                if (previousPrompt && [
                    'pending',
                    'deciding',
                    'granted',
                    'denied',
                ].includes(previousPrompt.state)) {
                    return permissionRequestResponse(
                        previousPrompt,
                        previousRequest.requestToken,
                        true,
                    );
                }
                permissionIdempotency.delete(idempotencyKey);
                permissionRequestTokens.delete(previousRequest.requestToken);
            }

            if (deniedPermissionKeys.has(request.key)) {
                return { state: 'denied', cached: true, reused: false };
            }

            if (request.permission.policy !== 'always') {
                const grantedAt = await permissionStore.getGrant(request.key);
                const stillGranted = Number.isSafeInteger(grantedAt)
                    && grantedAt > 0
                    && (
                        request.permission.policy === 'persistent'
                        || now() - grantedAt <= permissionPeriodMs
                    );
                if (stillGranted) {
                    return {
                        state: 'granted',
                        grantedAt,
                        cached: true,
                        reused: false,
                    };
                }
            }

            let prompt = pendingPermissionByKey.get(request.key);
            let reused = true;
            if (!prompt) {
                if (pendingPermissionPrompts().length >= maxPendingPermissionPrompts
                    || allPendingPrompts().length >= maxPendingPrompts + maxPendingPermissionPrompts) {
                    throw new RuntimeStartupError(
                        'Too many pending plugin permission prompts',
                        'PLUGIN_PERMISSION_PROMPT_LIMIT',
                        429,
                    );
                }
                ensurePermissionRecordCapacity();
                const timestamp = now();
                // All callers already hold the Node server account credential.
                // The first authenticated requester supplies only localized UI
                // copy; the server derives identity/source metadata from the
                // separately validated principal, capability, and policy.
                prompt = {
                    id: crypto.randomUUID(),
                    kind: 'plugin_permission',
                    state: 'pending',
                    prompt: request.prompt,
                    source: {
                        kind: 'plugin_permission',
                        pluginName: request.permission.name,
                        permission: request.permission.capability,
                        pluginScriptHash: request.permission.scriptHash,
                        permissionPolicy: request.permission.policy,
                    },
                    permission: request.permission,
                    permissionKey: request.key,
                    createdAt: timestamp,
                    expiresAt: timestamp + promptTtlMs,
                    settledAt: null,
                    responseExpiresAt: null,
                    decisionPromise: null,
                };
                permissionRecords.set(prompt.id, prompt);
                pendingPermissionByKey.set(prompt.permissionKey, prompt);
                reused = false;
                broadcast('prompt_created', { prompt: publicPrompt(prompt) });
            }

            const requestToken = createPermissionRequestToken(prompt.id);
            prunePermissionCapacity(permissionIdempotency, maxPermissionIdempotencyRecords);
            permissionIdempotency.set(idempotencyKey, {
                requestHash: request.requestHash,
                requestToken,
                expiresAt: now() + promptTtlMs + responseTtlMs,
            });
            return permissionRequestResponse(prompt, requestToken, reused);
        });
    }

    async function answerPermissionPrompt(prompt, response) {
        if (response !== 'yes' && response !== 'no') {
            throw new RuntimeStartupError(
                'Plugin permission responses must be exactly yes or no',
                'INVALID_PLUGIN_PERMISSION_RESPONSE',
            );
        }
        if (prompt.state === 'deciding') {
            await prompt.decisionPromise;
            return false;
        }
        if (prompt.state === 'granted' || prompt.state === 'denied') {
            return false;
        }
        if (prompt.state !== 'pending') {
            throw new RuntimeStartupError(
                'Plugin permission prompt is no longer available',
                'STARTUP_PROMPT_UNAVAILABLE',
                410,
            );
        }

        prompt.state = 'deciding';
        const decision = response === 'yes' ? 'granted' : 'denied';
        const decisionPromise = (async () => {
            const timestamp = now();
            if (decision === 'granted' && prompt.permission.policy !== 'always') {
                // Do not acknowledge or broadcast the grant before its atomic
                // file write, file fsync, rename, and directory fsync finish.
                await permissionStore.recordGrant(prompt.permissionKey, timestamp);
            }
            if (decision === 'denied') {
                // Match the legacy process-local denial cache without turning
                // one denial into a permanent policy across server restarts.
                deniedPermissionKeys.add(prompt.permissionKey);
                while (deniedPermissionKeys.size > maxDeniedPermissionKeys) {
                    deniedPermissionKeys.delete(deniedPermissionKeys.values().next().value);
                }
            }
            prompt.state = decision;
            prompt.settledAt = timestamp;
            prompt.responseExpiresAt = timestamp + responseTtlMs;
            if (pendingPermissionByKey.get(prompt.permissionKey) === prompt) {
                pendingPermissionByKey.delete(prompt.permissionKey);
            }
            broadcast('prompt_settled', {
                promptId: prompt.id,
                state: 'answered',
                reason: 'observer_response',
            });
        })();
        prompt.decisionPromise = decisionPromise;
        try {
            await decisionPromise;
            return true;
        }
        catch (error) {
            // A failed durable allow is still undecided. Keep the same global
            // prompt pending so an authenticated observer can retry safely.
            prompt.state = 'pending';
            prompt.decisionPromise = null;
            throw error;
        }
    }

    function registerRoutes(app) {
        registerRoute(app, 'get', '/runtime-startup/liveness', (_req, res) => {
            expireState();
            const executorHealth = getExecutorHealth();
            if (executorHealth?.ready === true) {
                res.send({
                    alive: true,
                    ready: true,
                    phase: 'claim_ready',
                    ageMs: executorHealth.ageMs ?? null,
                    pendingPromptCount: allPendingPrompts().length,
                });
                return;
            }
            const ageMs = session?.state === 'active'
                ? Math.max(0, now() - session.lastContactAt)
                : null;
            const alive = ageMs !== null && ageMs <= contactFreshMs;
            res.status(alive ? 200 : 503).send({
                alive,
                ready: false,
                phase: alive ? effectivePhase() : 'unavailable',
                ageMs,
                pendingPromptCount: allPendingPrompts().length,
            });
        });

        registerRoute(app, 'post', '/runtime-startup/session', async (req, res, next) => {
            if (!await requireStartupProducerAuth(req, res)) {
                return;
            }
            try {
                expireState();
                const requestId = assertString(req.body?.requestId, 'requestId', 128);
                const producerId = assertString(req.body?.producerId, 'producerId', 256);
                const previousRequest = sessionRequests.get(requestId);
                if (previousRequest) {
                    if (previousRequest.producerId !== producerId) {
                        throw new RuntimeStartupError(
                            'Runtime startup requestId belongs to another producer',
                            'STARTUP_IDEMPOTENCY_CONFLICT',
                            409,
                        );
                    }
                    if (session?.state === 'active'
                        && session.id === previousRequest.sessionId) {
                        const timestamp = now();
                        session.lastContactAt = timestamp;
                        session.expiresAt = timestamp + sessionTtlMs;
                        res.send({ ...sessionEnvelope(), reused: true });
                        return;
                    }
                    // A delayed retry from a producer whose create response
                    // was lost must never fence a newer resident session.
                    throw new RuntimeStartupError(
                        'Runtime startup request resolved to a superseded session',
                        'STALE_STARTUP_SESSION',
                        409,
                    );
                }
                if (lastSessionFence >= Number.MAX_SAFE_INTEGER) {
                    throw new RuntimeStartupError(
                        'Runtime startup fencing token space is exhausted',
                        'STARTUP_FENCE_EXHAUSTED',
                        503,
                    );
                }
                if (session?.state === 'active') {
                    for (const prompt of session.prompts.values()) {
                        settlePrompt(prompt, 'fenced', 'session_replaced');
                    }
                }
                const timestamp = now();
                session = {
                    id: crypto.randomUUID(),
                    requestId,
                    producerId,
                    fencingToken: ++lastSessionFence,
                    state: 'active',
                    phase: 'loading_data',
                    createdAt: timestamp,
                    lastContactAt: timestamp,
                    expiresAt: timestamp + sessionTtlMs,
                    prompts: new Map(),
                    promptRequests: new Map(),
                    notices: new Map(),
                };
                rememberSessionRequest(requestId, producerId, session.id);
                broadcast('session_started', {
                    sessionId: session.id,
                    phase: session.phase,
                });
                res.status(201).send({ ...sessionEnvelope(), reused: false });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(
            app,
            'post',
            '/runtime-startup/session/:sessionId/heartbeat',
            async (req, res, next) => {
                if (!await requireStartupProducerAuth(req, res)) {
                    return;
                }
                try {
                    const current = requireCurrentSession(req.params.sessionId, req.body);
                    const phase = assertString(req.body?.phase, 'phase', 64);
                    if (!STARTUP_PHASES.has(phase)) {
                        throw new RuntimeStartupError(
                            `Unsupported runtime startup phase: ${phase}`,
                            'INVALID_STARTUP_PHASE',
                        );
                    }
                    if (current.phase !== phase) {
                        current.phase = phase;
                        broadcast('phase_changed', {
                            sessionId: current.id,
                            phase: effectivePhase(),
                        });
                    }
                    res.send({ success: true, ...sessionEnvelope() });
                }
                catch (error) {
                    sendRouteError(error, res, next);
                }
            },
        );

        registerRoute(
            app,
            'post',
            '/runtime-startup/session/:sessionId/prompts',
            async (req, res, next) => {
                if (!await requireStartupProducerAuth(req, res)) {
                    return;
                }
                try {
                    const current = requireCurrentSession(req.params.sessionId, req.body);
                    const requestId = assertString(req.body?.requestId, 'requestId', 128);
                    const prompt = normalizePrompt(req.body?.prompt);
                    const source = normalizeSource(req.body?.source);
                    const requestHash = crypto.createHash('sha256')
                        .update(stableJsonStringify({ prompt, source }))
                        .digest('hex');
                    const existing = current.promptRequests.get(requestId);
                    if (existing) {
                        if (existing.requestHash !== requestHash) {
                            throw new RuntimeStartupError(
                                'Runtime startup prompt requestId was reused with different content',
                                'STARTUP_IDEMPOTENCY_CONFLICT',
                                409,
                            );
                        }
                        const existingPrompt = current.prompts.get(existing.promptId);
                        if (!existingPrompt) {
                            throw new RuntimeStartupError(
                                'Runtime startup prompt request is no longer available',
                                'STARTUP_PROMPT_UNAVAILABLE',
                                410,
                            );
                        }
                        res.send({
                            promptId: existingPrompt.id,
                            state: existingPrompt.state,
                            expiresAt: existingPrompt.expiresAt,
                            reused: true,
                        });
                        return;
                    }
                    if (pendingPrompts().length >= maxPendingPrompts) {
                        throw new RuntimeStartupError(
                            'Too many pending runtime startup prompts',
                            'STARTUP_PROMPT_LIMIT',
                            429,
                        );
                    }
                    const timestamp = now();
                    const executorReady = getExecutorHealth()?.ready === true;
                    const promptRecord = {
                        id: crypto.randomUUID(),
                        requestId,
                        requestHash,
                        state: 'pending',
                        prompt,
                        source,
                        response: null,
                        createdAt: timestamp,
                        expiresAt: executorReady
                            ? timestamp + promptTtlMs
                            : Math.min(timestamp + promptTtlMs, current.expiresAt),
                        answeredAt: null,
                        responseExpiresAt: null,
                        settledAt: null,
                    };
                    current.prompts.set(promptRecord.id, promptRecord);
                    current.promptRequests.set(requestId, {
                        promptId: promptRecord.id,
                        requestHash,
                    });
                    broadcast('prompt_created', { prompt: publicPrompt(promptRecord) });
                    res.status(201).send({
                        promptId: promptRecord.id,
                        state: promptRecord.state,
                        expiresAt: promptRecord.expiresAt,
                        reused: false,
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
            '/runtime-startup/session/:sessionId/notices',
            async (req, res, next) => {
                if (!await requireStartupProducerAuth(req, res)) {
                    return;
                }
                try {
                    const current = requireCurrentSession(req.params.sessionId, req.body);
                    const notice = normalizePrompt(req.body?.notice);
                    if (!STARTUP_NOTICE_TYPES.has(notice.type)) {
                        throw new RuntimeStartupError(
                            'Runtime startup notices must use normal, error, or markdown',
                            'INVALID_STARTUP_NOTICE',
                        );
                    }
                    const source = normalizeSource(req.body?.source);
                    while (current.notices.size >= maxNotices) {
                        const oldest = current.notices.keys().next().value;
                        if (!oldest) {
                            break;
                        }
                        current.notices.delete(oldest);
                    }
                    const timestamp = now();
                    const noticeRecord = {
                        id: crypto.randomUUID(),
                        notice,
                        source,
                        createdAt: timestamp,
                        expiresAt: timestamp + noticeTtlMs,
                    };
                    current.notices.set(noticeRecord.id, noticeRecord);
                    broadcast('notice_created', { notice: publicNotice(noticeRecord) });
                    res.status(201).send({
                        noticeId: noticeRecord.id,
                        expiresAt: noticeRecord.expiresAt,
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
            '/runtime-startup/session/:sessionId/prompts/:promptId/poll',
            async (req, res, next) => {
                if (!await requireStartupProducerAuth(req, res)) {
                    return;
                }
                try {
                    const current = requireCurrentSession(req.params.sessionId, req.body);
                    const prompt = current.prompts.get(req.params.promptId);
                    if (!prompt) {
                        throw new RuntimeStartupError(
                            'Runtime startup prompt was not found',
                            'STARTUP_PROMPT_NOT_FOUND',
                            404,
                        );
                    }
                    if (prompt.state === 'pending') {
                        res.status(202).send({ state: 'pending' });
                        return;
                    }
                    if (prompt.state !== 'answered' || typeof prompt.response !== 'string') {
                        throw new RuntimeStartupError(
                            'Runtime startup prompt is no longer available',
                            'STARTUP_PROMPT_UNAVAILABLE',
                            410,
                        );
                    }
                    res.setHeader('Cache-Control', 'no-store');
                    res.send({ state: 'answered', response: prompt.response });
                }
                catch (error) {
                    sendRouteError(error, res, next);
                }
            },
        );

        registerRoute(
            app,
            'delete',
            '/runtime-startup/session/:sessionId/prompts/:promptId',
            async (req, res, next) => {
                if (!await requireStartupProducerAuth(req, res)) {
                    return;
                }
                try {
                    const current = requireCurrentSession(req.params.sessionId, req.body);
                    const prompt = current.prompts.get(req.params.promptId);
                    if (!prompt) {
                        res.send({ success: true, reused: true });
                        return;
                    }
                    current.prompts.delete(prompt.id);
                    current.promptRequests.delete(prompt.requestId);
                    prompt.response = null;
                    broadcast('prompt_settled', {
                        promptId: prompt.id,
                        state: 'closed',
                        reason: 'producer_closed',
                    });
                    res.send({ success: true, reused: false });
                }
                catch (error) {
                    sendRouteError(error, res, next);
                }
            },
        );

        registerRoute(
            app,
            'post',
            '/runtime-plugin-permissions/requests',
            async (req, res, next) => {
                if (!await requireObserverAuth(req, res)) {
                    return;
                }
                try {
                    const result = await createPermissionRequest(req.body);
                    res.setHeader('Cache-Control', 'no-store');
                    res.status(result.state === 'pending' ? 202 : 200).send(result);
                }
                catch (error) {
                    sendRouteError(error, res, next);
                }
            },
        );

        registerRoute(
            app,
            'post',
            '/runtime-plugin-permissions/poll',
            async (req, res, next) => {
                if (!await requireObserverAuth(req, res)) {
                    return;
                }
                try {
                    expireState();
                    const requestToken = assertString(
                        req.body?.requestToken,
                        'requestToken',
                        64,
                    );
                    const token = permissionRequestTokens.get(requestToken);
                    const prompt = token ? permissionRecords.get(token.promptId) : null;
                    if (!token || !prompt) {
                        throw new RuntimeStartupError(
                            'Plugin permission request is no longer available',
                            'PLUGIN_PERMISSION_REQUEST_UNAVAILABLE',
                            410,
                        );
                    }
                    res.setHeader('Cache-Control', 'no-store');
                    if (prompt.state === 'pending' || prompt.state === 'deciding') {
                        res.status(202).send({ state: 'pending' });
                        return;
                    }
                    if (prompt.state !== 'granted' && prompt.state !== 'denied') {
                        throw new RuntimeStartupError(
                            'Plugin permission request is no longer available',
                            'PLUGIN_PERMISSION_REQUEST_UNAVAILABLE',
                            410,
                        );
                    }
                    res.send({ state: prompt.state });
                }
                catch (error) {
                    sendRouteError(error, res, next);
                }
            },
        );

        registerRoute(app, 'get', '/runtime-startup', async (req, res, next) => {
            if (!await requireObserverAuth(req, res)) {
                return;
            }
            try {
                expireState();
                res.setHeader('Cache-Control', 'no-store');
                res.send(publicSnapshot());
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(app, 'post', '/runtime-startup/socket-ticket', async (req, res, next) => {
            if (!await requireObserverAuth(req, res)) {
                return;
            }
            try {
                const clientId = req.body?.clientId === undefined
                    ? ''
                    : assertString(req.body.clientId, 'clientId', 256);
                const ticket = createSocketTicket(clientId);
                res.setHeader('Cache-Control', 'no-store');
                res.send({
                    ticket: ticket.ticket,
                    expiresAt: ticket.expiresAt,
                    path: '/runtime-startup/ws',
                });
            }
            catch (error) {
                sendRouteError(error, res, next);
            }
        });

        registerRoute(
            app,
            'post',
            '/runtime-startup/prompts/:promptId/response',
            async (req, res, next) => {
                if (!await requireObserverAuth(req, res)) {
                    return;
                }
                try {
                    expireState();
                    const sessionPrompt = session?.state === 'active'
                        ? session.prompts.get(req.params.promptId)
                        : null;
                    const permissionPrompt = permissionRecords.get(req.params.promptId);
                    const prompt = sessionPrompt ?? permissionPrompt;
                    if (!prompt) {
                        throw new RuntimeStartupError(
                            'Runtime startup prompt was not found',
                            'STARTUP_PROMPT_NOT_FOUND',
                            404,
                        );
                    }
                    if (permissionPrompt) {
                        const response = assertString(
                            req.body?.response,
                            'response',
                            3,
                        );
                        const accepted = await answerPermissionPrompt(permissionPrompt, response);
                        res.send({ success: true, accepted, reused: !accepted });
                        return;
                    }
                    if (prompt.state === 'answered') {
                        res.send({ success: true, accepted: false, reused: true });
                        return;
                    }
                    if (prompt.state !== 'pending') {
                        throw new RuntimeStartupError(
                            'Runtime startup prompt is no longer available',
                            'STARTUP_PROMPT_UNAVAILABLE',
                            410,
                        );
                    }
                    const response = assertString(
                        req.body?.response,
                        'response',
                        maxResponseBytes,
                        true,
                    );
                    if (Buffer.byteLength(response, 'utf8') > maxResponseBytes) {
                        throw new RuntimeStartupError(
                            `response exceeds the ${maxResponseBytes} byte limit`,
                            'STARTUP_RESPONSE_TOO_LARGE',
                            413,
                        );
                    }
                    const timestamp = now();
                    prompt.state = 'answered';
                    prompt.response = response;
                    prompt.answeredAt = timestamp;
                    prompt.responseExpiresAt = timestamp + responseTtlMs;
                    broadcast('prompt_settled', {
                        promptId: prompt.id,
                        state: 'answered',
                        reason: 'observer_response',
                    });
                    res.send({ success: true, accepted: true, reused: false });
                }
                catch (error) {
                    sendRouteError(error, res, next);
                }
            },
        );
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
            if (reqUrl.pathname !== '/runtime-startup/ws') {
                return;
            }
            const ticket = consumeSocketTicket(reqUrl.searchParams.get('ticket'));
            if (!ticket) {
                rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
                return;
            }
            wsServer.handleUpgrade(req, socket, head, (ws) => {
                wsServer.emit('connection', ws, req, ticket);
            });
        });

        wsServer.on('connection', (ws, _req, ticket) => {
            const subscriber = {
                ws,
                ready: false,
                pending: [],
            };
            subscribers.add(subscriber);
            const snapshot = publicSnapshot();
            try {
                ws.send(JSON.stringify({ ...snapshot, clientId: ticket.clientId }));
                subscriber.ready = true;
                subscriber.pending.sort((left, right) => left.sequence - right.sequence);
                for (const event of subscriber.pending) {
                    if (event.sequence > snapshot.sequence && ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify(event));
                    }
                }
                subscriber.pending = [];
            }
            catch {
                ws.terminate?.();
            }
            const pingTimer = setInterval(() => {
                if (ws.readyState === ws.OPEN) {
                    try {
                        ws.send(JSON.stringify({ type: 'runtime_startup_ping', ts: now() }));
                    }
                    catch {
                        ws.terminate?.();
                    }
                }
            }, 15_000);
            const cleanup = () => {
                clearInterval(pingTimer);
                subscribers.delete(subscriber);
            };
            ws.once('close', cleanup);
            ws.once('error', cleanup);
        });
        return wsServer;
    }

    const expiryTimer = setInterval(expireState, Math.min(5_000, contactFreshMs));
    expiryTimer.unref?.();

    return {
        dispose() {
            clearInterval(expiryTimer);
            for (const subscriber of subscribers) {
                subscriber.ws.terminate?.();
            }
            subscribers.clear();
        },
        getLiveness() {
            expireState();
            const executorHealth = getExecutorHealth();
            if (executorHealth?.ready === true) {
                return { alive: true, ready: true, phase: 'claim_ready' };
            }
            const ageMs = session?.state === 'active'
                ? Math.max(0, now() - session.lastContactAt)
                : null;
            return {
                alive: ageMs !== null && ageMs <= contactFreshMs,
                ready: false,
                phase: ageMs !== null && ageMs <= contactFreshMs
                    ? effectivePhase()
                    : 'unavailable',
            };
        },
        registerRoutes,
        setupWebSocket,
    };
}

module.exports = {
    RuntimeStartupError,
    createRuntimeStartupServer,
};
