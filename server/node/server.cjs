const express = require('express');
const app = express();
if (process.env.TRUST_PROXY) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}
const http = require('http');
const path = require('path');
const net = require('net');
const dns = require('node:dns/promises');
const htmlparser = require('node-html-parser');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const fs = require('fs/promises')
const crypto = require('crypto')
const zlib = require('node:zlib')
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const { DatabaseRevisionStore } = require('./databaseRevisionStore.cjs');
const {
    IdempotencyConflictError,
    JobNotFoundError,
    ProxyStreamJobStore,
    SpoolQuotaExceededError,
} = require('./proxyStreamJobs/jobStore.cjs');
const { RuntimeGenerationStore } = require('./runtimeGenerations/commandStore.cjs');
const {
    createRuntimeGenerationServer,
    normalizeExecutorIp,
} = require('./runtimeGenerations/serverApi.cjs');
const {
    HubProxyPolicyError,
    buildHubRequestHeaders,
    resolveHubRedirectTarget,
    resolveHubRequestTarget,
} = require('./hubProxyPolicy.cjs');
const { FlatStorageQuotaError, FlatStorageStore } = require('./flatStorageStore.cjs');
app.use(express.static(path.join(process.cwd(), 'dist'), {index: false}));
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '100mb' }));
app.use(express.text({ limit: '100mb' }));
app.get('/api/runtime-role.js', (req, res) => {
    const expectedExecutorIp = normalizeExecutorIp(process.env.RISU_RUNTIME_EXECUTOR_IP || '');
    const sourceIp = normalizeExecutorIp(req.socket?.remoteAddress || '');
    const attested = Boolean(expectedExecutorIp && sourceIp === expectedExecutorIp);
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/javascript').send(
        `globalThis.__RISU_RUNTIME_EXECUTOR_ATTESTED__=${attested ? 'true' : 'false'};`
    );
});
const {pipeline} = require('stream/promises')
const https = require('https');
const sslPath = path.join(process.cwd(), 'server/node/ssl/certificate');
const hubURL = 'https://sv.risuai.xyz'; 
const openid = require('openid-client');

let password = ''
let knownPublicKeysHashes = []

const savePath = path.join(process.cwd(), "save")
if(!existsSync(savePath)){
    mkdirSync(savePath)
}
const flatStorageStore = new FlatStorageStore({
    rootDir: savePath,
    maxBytes: positiveIntegerEnvironment('RISU_SAVE_MAX_BYTES', 8 * 1024 * 1024 * 1024),
    minFreeBytes: positiveIntegerEnvironment('RISU_SAVE_MIN_FREE_BYTES', 1024 * 1024 * 1024),
})

const passwordPath = path.join(process.cwd(), 'save', '__password')
if(existsSync(passwordPath)){
    password = readFileSync(passwordPath, 'utf-8')
}
else if(process.env.RISU_NODE_BOOTSTRAP_PASSWORD){
    // A public first-visitor password setup endpoint is a takeover race. The
    // private self-host initializes its existing SHA-256 password format from
    // an environment secret before accepting any network request.
    password = crypto.createHash('sha256')
        .update(String(process.env.RISU_NODE_BOOTSTRAP_PASSWORD), 'utf-8')
        .digest('hex')
    writeFileSync(passwordPath, password, { encoding: 'utf-8', mode: 0o600 })
}

const knownPublicKeysPath = path.join(process.cwd(), 'save', '__known_public_key_hashes.json')
if(existsSync(knownPublicKeysPath)){
    const knownPublicKeysRaw = readFileSync(knownPublicKeysPath, 'utf-8');
    knownPublicKeysHashes = JSON.parse(knownPublicKeysRaw);
}

const authCodePath = path.join(process.cwd(), 'save', '__authcode')
const databaseStorageKey = 'database/database.bin';
const databaseStorageFileName = Buffer.from(databaseStorageKey, 'utf-8').toString('hex');
const databaseStoragePath = path.join(savePath, databaseStorageFileName);
const databaseRevisionStateDir = path.join(savePath, '__database_revision');
const DATABASE_SOCKET_TICKET_TTL_MS = 30000;
const DATABASE_SOCKET_MAX_TICKETS = 512;
const DATABASE_SOCKET_HEARTBEAT_MS = 15000;
let databaseRevisionStore = null;
let databaseRevisionStorePromise = null;
const databaseSocketTickets = new Map();
const databaseSyncClients = new Set();
const hexRegex = /^[0-9a-fA-F]+$/;
const PROXY_STREAM_DEFAULT_TIMEOUT_MS = 600000;
const PROXY_STREAM_MAX_TIMEOUT_MS = 3600000;
const PROXY_STREAM_DEFAULT_HEARTBEAT_SEC = 15;
const PROXY_STREAM_HEARTBEAT_MIN_SEC = 5;
const PROXY_STREAM_HEARTBEAT_MAX_SEC = 60;
const PROXY_STREAM_GC_INTERVAL_MS = 60000;
const PROXY_STREAM_MAX_ACTIVE_JOBS = 64;
const PROXY_STREAM_MAX_BODY_BASE64_BYTES = 8 * 1024 * 1024;
const PROXY_STREAM_MAX_RESPONSE_BYTES = positiveIntegerEnvironment(
    'RISU_PROXY_STREAM_MAX_RESPONSE_BYTES',
    256 * 1024 * 1024,
);
const PROXY_STREAM_MAX_SPOOL_BYTES = positiveIntegerEnvironment(
    'RISU_PROXY_STREAM_MAX_SPOOL_BYTES',
    2 * 1024 * 1024 * 1024,
);
const PROXY_STREAM_MAX_CONTEXT_BYTES = 16 * 1024;
const PROXY_STREAM_EVENT_PAGE_SIZE = 1000;
const PROXY_STREAM_SOCKET_TICKET_TTL_MS = 30000;
const PROXY_STREAM_SOCKET_MAX_TICKETS = 512;
const proxyStreamJobStateDir = path.join(savePath, '__proxy_stream_jobs');
const proxyStreamJobStore = new ProxyStreamJobStore({
    rootDir: proxyStreamJobStateDir,
    maxSpoolBytes: PROXY_STREAM_MAX_SPOOL_BYTES,
});
const proxyStreamJobRuntimes = new Map();
const proxyStreamJobSubscribers = new Map();
const proxyStreamSocketTickets = new Map();
const PROXY_STREAM_ACKNOWLEDGED_RETENTION_MS = positiveIntegerEnvironment(
    'RISU_PROXY_STREAM_ACKNOWLEDGED_RETENTION_MS',
    7 * 24 * 60 * 60 * 1000,
);
const PROXY_STREAM_UNACKNOWLEDGED_RETENTION_MS = positiveIntegerEnvironment(
    'RISU_PROXY_STREAM_UNACKNOWLEDGED_RETENTION_MS',
    14 * 24 * 60 * 60 * 1000,
);
const PROXY_STREAM_MAX_TERMINAL_JOBS = positiveIntegerEnvironment(
    'RISU_PROXY_STREAM_MAX_TERMINAL_JOBS',
    2000,
);
let proxyStreamPruneRunning = false;
const RUNTIME_GENERATION_LEASE_SWEEP_MS = 1_000;
const RUNTIME_GENERATION_RETENTION_SWEEP_MS = 5 * 60 * 1000;
const RUNTIME_GENERATION_RETENTION_MS = positiveIntegerEnvironment(
    'RISU_RUNTIME_GENERATION_RETENTION_MS',
    30 * 24 * 60 * 60 * 1000,
);
const RUNTIME_GENERATION_MAX_TERMINAL_COMMANDS = positiveIntegerEnvironment(
    'RISU_RUNTIME_GENERATION_MAX_TERMINAL_COMMANDS',
    2000,
);
const runtimeGenerationStateDir = path.join(savePath, '__runtime_generations');
const runtimeGenerationStore = new RuntimeGenerationStore({
    rootDir: runtimeGenerationStateDir,
});
let runtimeGenerationPruneRunning = false;

function positiveIntegerEnvironment(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        console.warn(`[Server] Ignoring invalid positive integer ${name}=${JSON.stringify(raw)}`);
        return fallback;
    }
    return parsed;
}

async function pruneProxyStreamJobs(now = Date.now()) {
    if (proxyStreamPruneRunning) {
        return null;
    }
    proxyStreamPruneRunning = true;
    try {
        return await proxyStreamJobStore.prune({
            acknowledgedBefore: now - PROXY_STREAM_ACKNOWLEDGED_RETENTION_MS,
            unacknowledgedBefore: now - PROXY_STREAM_UNACKNOWLEDGED_RETENTION_MS,
            maxTerminalCount: PROXY_STREAM_MAX_TERMINAL_JOBS,
        });
    }
    finally {
        proxyStreamPruneRunning = false;
    }
}

async function pruneRuntimeGenerationCommands(now = Date.now()) {
    if (runtimeGenerationPruneRunning) {
        return null;
    }
    runtimeGenerationPruneRunning = true;
    try {
        return await runtimeGenerationStore.prune({
            terminalBefore: now - RUNTIME_GENERATION_RETENTION_MS,
            maxTerminalCount: RUNTIME_GENERATION_MAX_TERMINAL_COMMANDS,
        });
    }
    finally {
        runtimeGenerationPruneRunning = false;
    }
}

function broadcastDatabaseCommit(event) {
    for (const client of databaseSyncClients) {
        if (client.ws.readyState !== client.ws.OPEN) {
            continue;
        }
        if (!client.ready) {
            client.pendingEvents.push(event);
            continue;
        }
        client.ws.send(JSON.stringify(event));
    }
}

async function getDatabaseRevisionStore(initialData) {
    if (databaseRevisionStore) {
        return databaseRevisionStore;
    }
    if (databaseRevisionStorePromise) {
        return await databaseRevisionStorePromise;
    }
    if (!existsSync(databaseStoragePath) && initialData === undefined) {
        const error = new Error('Database has not been initialized');
        error.code = 'ENOENT';
        throw error;
    }

    databaseRevisionStorePromise = (async () => {
        const store = new DatabaseRevisionStore({
            databasePath: databaseStoragePath,
            stateDir: databaseRevisionStateDir,
        });
        await store.open(initialData);
        store.subscribe(broadcastDatabaseCommit);
        databaseRevisionStore = store;
        return store;
    })();

    try {
        return await databaseRevisionStorePromise;
    }
    finally {
        databaseRevisionStorePromise = null;
    }
}

async function openDatabaseRevisionStoreAtStartup() {
    if (!existsSync(databaseStoragePath)) {
        return null;
    }
    return await getDatabaseRevisionStore();
}

function pruneDatabaseSocketTickets(now = Date.now()) {
    for (const [ticket, value] of databaseSocketTickets) {
        if (value.expiresAt <= now) {
            databaseSocketTickets.delete(ticket);
        }
    }
    while (databaseSocketTickets.size >= DATABASE_SOCKET_MAX_TICKETS) {
        const oldestTicket = databaseSocketTickets.keys().next().value;
        if (!oldestTicket) {
            break;
        }
        databaseSocketTickets.delete(oldestTicket);
    }
}

function createDatabaseSocketTicket(clientId) {
    const now = Date.now();
    pruneDatabaseSocketTickets(now);
    const ticket = crypto.randomBytes(32).toString('base64url');
    const value = {
        clientId,
        expiresAt: now + DATABASE_SOCKET_TICKET_TTL_MS,
    };
    databaseSocketTickets.set(ticket, value);
    return { ticket, ...value };
}

function consumeDatabaseSocketTicket(ticket) {
    const now = Date.now();
    pruneDatabaseSocketTickets(now);
    const value = databaseSocketTickets.get(ticket);
    if (!value || value.expiresAt <= now) {
        return null;
    }
    databaseSocketTickets.delete(ticket);
    return value;
}

function pruneProxyStreamSocketTickets(now = Date.now()) {
    for (const [ticket, value] of proxyStreamSocketTickets) {
        if (value.expiresAt <= now) {
            proxyStreamSocketTickets.delete(ticket);
        }
    }
}

function pruneProxyStreamSocketTicketCapacity() {
    while (proxyStreamSocketTickets.size >= PROXY_STREAM_SOCKET_MAX_TICKETS) {
        const oldestTicket = proxyStreamSocketTickets.keys().next().value;
        if (!oldestTicket) {
            break;
        }
        proxyStreamSocketTickets.delete(oldestTicket);
    }
}

function createProxyStreamSocketTicket(jobId) {
    const now = Date.now();
    pruneProxyStreamSocketTickets(now);
    pruneProxyStreamSocketTicketCapacity();
    const ticket = crypto.randomBytes(32).toString('base64url');
    const value = {
        jobId,
        expiresAt: now + PROXY_STREAM_SOCKET_TICKET_TTL_MS,
    };
    proxyStreamSocketTickets.set(ticket, value);
    return { ticket, ...value };
}

function consumeProxyStreamSocketTicket(ticket, jobId) {
    const now = Date.now();
    pruneProxyStreamSocketTickets(now);
    const value = proxyStreamSocketTickets.get(ticket);
    if (ticket) {
        // Consume before any asynchronous work so the capability cannot be
        // raced, replayed, or retried against another job path.
        proxyStreamSocketTickets.delete(ticket);
    }
    if (!value || value.expiresAt <= now || value.jobId !== jobId) {
        return null;
    }
    return value;
}
const authenticatedRouteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 2000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please retry shortly.' }
});
const HUB_SESSION_COOKIE_NAME = 'risu-hub-session';
const HUB_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const authRouteLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 2000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please retry shortly.' }
});
const loginRouteLimiter = rateLimit({
    windowMs: 30 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait and try again later.' }
});
const runtimeGenerationServer = createRuntimeGenerationServer({
    store: runtimeGenerationStore,
    authenticate: checkProxyAuth,
    routeMiddleware: authenticatedRouteLimiter,
    executorIp: process.env.RISU_RUNTIME_EXECUTOR_IP,
});
runtimeGenerationServer.registerRoutes(app);
function isHex(str) {
    return hexRegex.test(str.toUpperCase().trim()) || str === '__password';
}

async function hashJSON(json){
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(json));
    return hash.digest('hex');
}

function isAuthorizedRequest(req) {
    const authHeader = normalizeAuthHeader(req.headers['risu-auth']);
    return !!authHeader && authHeader.trim() === password.trim();
}

function normalizeAuthHeader(authHeader) {
    if (Array.isArray(authHeader)) {
        return authHeader[0] || '';
    }
    return typeof authHeader === 'string' ? authHeader : '';
}

async function checkProxyAuth(req, res) {
    if (isAuthorizedRequest(req)) {
        return true;
    }
    return await checkAuth(req, res);
}

function parseCookieValue(req, name) {
    const cookieHeader = normalizeAuthHeader(req.headers.cookie);
    for (const entry of cookieHeader.split(';')) {
        const separator = entry.indexOf('=');
        if (separator < 0 || entry.slice(0, separator).trim() !== name) {
            continue;
        }
        try {
            return decodeURIComponent(entry.slice(separator + 1).trim());
        } catch {
            return '';
        }
    }
    return '';
}

function createHubSession(expiresAt) {
    const payload = `${expiresAt}.${crypto.randomBytes(24).toString('base64url')}`;
    const signature = crypto.createHmac('sha256', password).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function hasValidHubSession(req) {
    const token = parseCookieValue(req, HUB_SESSION_COOKIE_NAME);
    const [rawExpiresAt, nonce, suppliedSignature, ...extra] = token.split('.');
    const expiresAt = Number(rawExpiresAt);
    if (
        extra.length > 0
        || !nonce
        || !suppliedSignature
        || !Number.isSafeInteger(expiresAt)
        || expiresAt <= Date.now()
        || expiresAt > Date.now() + HUB_SESSION_TTL_MS + 60_000
    ) {
        return false;
    }
    const payload = `${rawExpiresAt}.${nonce}`;
    const expectedSignature = crypto.createHmac('sha256', password)
        .update(payload)
        .digest();
    let signature;
    try {
        signature = Buffer.from(suppliedSignature, 'base64url');
    } catch {
        return false;
    }
    return signature.length === expectedSignature.length
        && crypto.timingSafeEqual(signature, expectedSignature);
}

function hubSessionCookie(req, token) {
    const forwardedProto = normalizeAuthHeader(req.headers['x-forwarded-proto'])
        .split(',')[0]
        .trim()
        .toLowerCase();
    const secure = req.secure || forwardedProto === 'https';
    return `${HUB_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`
        + `; Max-Age=${Math.floor(HUB_SESSION_TTL_MS / 1000)}`
        + '; Path=/hub-proxy; HttpOnly; SameSite=Strict'
        + (secure ? '; Secure' : '');
}

function getRequestTimeoutMs(timeoutHeader) {
    const raw = Array.isArray(timeoutHeader) ? timeoutHeader[0] : timeoutHeader;
    if (!raw) {
        return null;
    }
    const timeoutMs = Number.parseInt(raw, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return null;
    }
    return timeoutMs;
}

function createTimeoutController(timeoutMs) {
    if (!timeoutMs) {
        return {
            signal: undefined,
            cleanup: () => {}
        };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => clearTimeout(timer)
    };
}

function normalizeProxyStreamTimeoutMs(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return PROXY_STREAM_DEFAULT_TIMEOUT_MS;
    }
    const parsed = Math.max(1, Math.floor(timeoutMs));
    return Math.min(PROXY_STREAM_MAX_TIMEOUT_MS, parsed);
}

function normalizeHeartbeatSec(heartbeatSec) {
    if (!Number.isFinite(heartbeatSec)) {
        return PROXY_STREAM_DEFAULT_HEARTBEAT_SEC;
    }
    const parsed = Math.floor(heartbeatSec);
    return Math.min(PROXY_STREAM_HEARTBEAT_MAX_SEC, Math.max(PROXY_STREAM_HEARTBEAT_MIN_SEC, parsed));
}

function isPrivateIPv4Host(hostname) {
    const parts = hostname.split('.');
    if (parts.length !== 4) {
        return false;
    }
    const octets = parts.map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        return false;
    }
    const [a, b] = octets;
    if (a === 10) {
        return true;
    }
    if (a === 127) {
        return true;
    }
    if (a === 0) {
        return true;
    }
    if (a === 192 && b === 168) {
        return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
        return true;
    }
    if (a === 169 && b === 254) {
        return true;
    }
    return false;
}

function isLocalNetworkHost(hostname) {
    if (typeof hostname !== 'string' || hostname.trim() === '') {
        return false;
    }

    let normalizedHost = hostname.toLowerCase().replace(/\.$/, '').split('%')[0];
    if (normalizedHost.startsWith('[') && normalizedHost.endsWith(']')) {
        normalizedHost = normalizedHost.slice(1, -1);
    }
    if (normalizedHost === 'localhost' || normalizedHost === '::1' || normalizedHost.endsWith('.local')) {
        return true;
    }

    if (/^[a-z0-9_-]+$/i.test(normalizedHost) && !normalizedHost.includes('.')) {
        return true;
    }

    if (net.isIP(normalizedHost) === 4) {
        return isPrivateIPv4Host(normalizedHost);
    }

    if (net.isIP(normalizedHost) === 6) {
        if (normalizedHost.startsWith('::ffff:')) {
            const mapped = normalizedHost.substring(7);
            return net.isIP(mapped) === 4 && isPrivateIPv4Host(mapped);
        }
        if (normalizedHost.startsWith('fc') || normalizedHost.startsWith('fd')) {
            return true;
        }
        if (/^fe[89ab]/.test(normalizedHost)) {
            return true;
        }
        return normalizedHost === '::1';
    }

    return false;
}

function isPrivateIpAddress(address) {
    if (net.isIP(address) === 4) {
        return isPrivateIPv4Host(address);
    }
    if (net.isIP(address) !== 6) {
        return false;
    }
    const normalized = address.toLowerCase().split('%')[0];
    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.substring(7);
        return net.isIP(mapped) === 4 && isPrivateIPv4Host(mapped);
    }
    return normalized === '::1'
        || normalized.startsWith('fc')
        || normalized.startsWith('fd')
        || /^fe[89ab]/.test(normalized);
}

function sanitizeTargetUrl(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        return null;
    }
    try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        if (!isLocalNetworkHost(parsed.hostname)) {
            return null;
        }
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch {
        return null;
    } // lgtm[js/request-forgery]
}

async function resolveLocalTarget(raw) {
    const url = sanitizeTargetUrl(raw);
    if (!url) {
        return null;
    }
    const parsed = new URL(url);
    const lookupHostname = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;
    if (net.isIP(lookupHostname)) {
        return isPrivateIpAddress(lookupHostname)
            ? { url, address: lookupHostname, family: net.isIP(lookupHostname) }
            : null;
    }
    try {
        const resolved = await dns.lookup(lookupHostname, { all: true, verbatim: true });
        if (resolved.length === 0 || resolved.some((entry) => !isPrivateIpAddress(entry.address))) {
            return null;
        }
        return { url, address: resolved[0].address, family: resolved[0].family };
    }
    catch {
        return null;
    }
}

function normalizeForwardHeaders(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return {};
    }
    const normalized = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof key !== 'string') {
            continue;
        }
        if (typeof value === 'string') {
            normalized[key.toLowerCase()] = value;
        }
    }
    delete normalized['risu-auth'];
    delete normalized['risu-timeout-ms'];
    delete normalized['host'];
    delete normalized['connection'];
    delete normalized['content-length'];
    delete normalized['proxy-authorization'];
    delete normalized['transfer-encoding'];
    delete normalized['upgrade'];
    return normalized;
}

function normalizeProxyResponseHeaders(headers) {
    const normalized = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined) {
            continue;
        }
        normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return normalized;
}

function requestLocalTargetStream(targetUrl, arg) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(targetUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;
        const headers = normalizeForwardHeaders(arg.headers);
        // Durable jobs persist the bytes a browser Fetch consumer would see.
        // Prefer identity and still decode a server that ignores the request.
        headers['accept-encoding'] = 'identity';
        if (!headers['host']) {
            headers['host'] = parsedUrl.host;
        }
        if (arg.bodyBuffer && !headers['content-length']) {
            headers['content-length'] = String(arg.bodyBuffer.length);
        }

        let settled = false;
        let responseStream = null;
        let cleanupAbort = () => {};
        const finishReject = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanupAbort();
            reject(error);
        };

        const req = client.request(parsedUrl, {
            method: arg.method,
            headers,
            ...(arg.targetAddress ? {
                lookup: (_hostname, _options, callback) => callback(
                    null,
                    arg.targetAddress.address,
                    arg.targetAddress.family,
                ),
            } : {}),
        }, (res) => {
            if (settled) {
                res.destroy();
                return;
            }
            settled = true;
            const responseHeaders = normalizeProxyResponseHeaders(res.headers);
            const contentEncoding = (responseHeaders['content-encoding'] || '').trim().toLowerCase();
            let body = res;
            if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
                body = res.pipe(zlib.createGunzip());
            }
            else if (contentEncoding === 'deflate') {
                body = res.pipe(zlib.createUnzip());
            }
            else if (contentEncoding === 'br') {
                body = res.pipe(zlib.createBrotliDecompress());
            }
            if (body !== res) {
                delete responseHeaders['content-encoding'];
                delete responseHeaders['content-length'];
            }
            responseStream = body;
            body.once('end', cleanupAbort);
            body.once('close', cleanupAbort);
            body.once('error', cleanupAbort);
            resolve({
                status: res.statusCode || 502,
                headers: responseHeaders,
                body
            });
        });

        req.on('error', (error) => {
            finishReject(error);
        });

        req.setTimeout(arg.timeoutMs, () => {
            req.destroy(new Error(`Upstream request timed out after ${arg.timeoutMs}ms`));
        });

        if (arg.signal) {
            const onAbort = () => {
                const abortError = new Error('Proxy stream job aborted');
                abortError.name = 'AbortError';
                req.destroy(abortError);
                responseStream?.destroy(abortError);
            };
            if (arg.signal.aborted) {
                onAbort();
                return;
            }
            arg.signal.addEventListener('abort', onAbort, { once: true });
            cleanupAbort = () => arg.signal.removeEventListener('abort', onAbort);
        }

        if (arg.bodyBuffer && arg.method !== 'GET' && arg.method !== 'HEAD') {
            req.write(arg.bodyBuffer);
        }
        req.end();
    });
}

function stableJsonStringify(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError('Request envelope cannot contain non-finite numbers');
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
    throw new TypeError(`Unsupported request envelope value: ${typeof value}`);
}

function hashProxyStreamRequestEnvelope(envelope) {
    return crypto.createHash('sha256').update(stableJsonStringify(envelope)).digest('hex');
}

function flattenProxyStreamEvent(record) {
    const flattened = {
        ...(record.payload || {}),
        type: record.type,
        sequence: record.sequence,
    };
    if (record.type === 'done') {
        flattened.finalSequence = record.sequence;
    }
    return flattened;
}

function isProxyStreamTransportEvent(record) {
    return record.type === 'upstream_headers'
        || record.type === 'chunk'
        || record.type === 'error'
        || record.type === 'done';
}

function broadcastProxyStreamEvent(jobId, event) {
    const subscribers = proxyStreamJobSubscribers.get(jobId);
    if (!subscribers) {
        return;
    }
    for (const subscriber of subscribers) {
        if (subscriber.ws.readyState !== subscriber.ws.OPEN) {
            continue;
        }
        if (!subscriber.ready) {
            subscriber.pendingEvents.push(event);
            continue;
        }
        subscriber.ws.send(JSON.stringify(event));
    }
}

async function persistProxyStreamEvent(jobId, type, payload) {
    const record = await proxyStreamJobStore.appendEvent(jobId, type, payload);
    return flattenProxyStreamEvent(record);
}

async function getPublicProxyStreamJob(jobOrId) {
    const job = typeof jobOrId === 'string'
        ? await proxyStreamJobStore.get(jobOrId)
        : jobOrId;
    const summary = job.transportSummary ?? { cursor: 0, terminal: null };
    return {
        jobId: job.id,
        requestId: job.requestId,
        generationId: job.generationId,
        chatId: job.context?.chatId ?? null,
        stepId: job.stepId,
        state: job.state,
        attempt: job.attempt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        interruptedAt: job.interruptedAt,
        cancelRequestedAt: job.cancelRequestedAt,
        acknowledgedAt: job.acknowledgedAt,
        acknowledgement: job.acknowledgement,
        error: job.error,
        lastSequence: job.lastSequence,
        heartbeatSec: job.context?.heartbeatSec ?? PROXY_STREAM_DEFAULT_HEARTBEAT_SEC,
        timeoutMs: job.context?.timeoutMs ?? PROXY_STREAM_DEFAULT_TIMEOUT_MS,
        status: summary.status,
        headers: summary.headers,
        cursor: summary.cursor,
        terminal: summary.terminal,
        context: job.context?.client ?? {},
    };
}

async function runProxyStreamJob(job, runtime, arg) {
    const resolvedTarget = arg.targetAddress
        ? { url: arg.targetUrl, ...arg.targetAddress }
        : await resolveLocalTarget(arg.targetUrl);
    if (!resolvedTarget) {
        throw new TypeError('Proxy stream target no longer resolves exclusively to a private address');
    }
    const targetUrl = resolvedTarget.url;
    const headers = normalizeForwardHeaders(arg.headers);
    if (!headers['x-forwarded-for']) {
        headers['x-forwarded-for'] = arg.clientIp;
    }
    const bodyBuffer = arg.bodyBase64 ? Buffer.from(arg.bodyBase64, 'base64') : undefined;

    try {
        const upstreamResponse = await requestLocalTargetStream(targetUrl, {
            method: arg.method,
            headers,
            bodyBuffer,
            timeoutMs: runtime.timeoutMs,
            signal: runtime.abortController.signal,
            targetAddress: resolvedTarget,
        });

        const filteredHeaders = {};
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
            if (key === 'content-security-policy' || key === 'content-security-policy-report-only' || key === 'clear-site-data') {
                continue;
            }
            filteredHeaders[key] = value;
        }

        const headersEvent = await persistProxyStreamEvent(job.id, 'upstream_headers', {
            status: upstreamResponse.status,
            headers: filteredHeaders,
        });
        runtime.status = upstreamResponse.status;
        runtime.headers = filteredHeaders;
        broadcastProxyStreamEvent(job.id, headersEvent);

        if (upstreamResponse.body) {
            for await (const value of upstreamResponse.body) {
                if (runtime.abortController.signal.aborted) {
                    const abortError = new Error('Proxy stream job aborted');
                    abortError.name = 'AbortError';
                    throw abortError;
                }
                if (value && value.length > 0) {
                    const chunk = Buffer.from(value);
                    const offset = runtime.offset;
                    const endOffset = offset + chunk.length;
                    if (endOffset > PROXY_STREAM_MAX_RESPONSE_BYTES) {
                        throw new Error(
                            `Proxy stream response exceeded ${PROXY_STREAM_MAX_RESPONSE_BYTES} bytes`,
                        );
                    }
                    const chunkEvent = await persistProxyStreamEvent(job.id, 'chunk', {
                        offset,
                        endOffset,
                        dataBase64: chunk.toString('base64'),
                    });
                    runtime.offset = endOffset;
                    broadcastProxyStreamEvent(job.id, chunkEvent);
                }
            }
        }
        if (runtime.abortController.signal.aborted) {
            const abortError = new Error('Proxy stream job aborted');
            abortError.name = 'AbortError';
            throw abortError;
        }

        const doneEvent = await persistProxyStreamEvent(job.id, 'done', {
            finalOffset: runtime.offset,
        });
        await proxyStreamJobStore.complete(job.id, { finalOffset: runtime.offset });
        broadcastProxyStreamEvent(job.id, doneEvent);
    } catch (error) {
        const aborted = error?.name === 'AbortError' || runtime.abortController.signal.aborted;
        const timedOut = runtime.abortReason === 'timeout';
        const status = error?.code === 'SPOOL_QUOTA_EXCEEDED'
            ? 507
            : (aborted && !timedOut ? 499 : 504);
        const message = aborted
            ? (timedOut ? 'Proxy stream job timed out' : 'Proxy stream job aborted')
            : `${error}`;
        try {
            const errorPayload = {
                status,
                message,
                finalOffset: runtime.offset,
            };
            const current = await proxyStreamJobStore.get(job.id);
            const errorRecord = current.state === 'running' || current.state === 'queued'
                ? await proxyStreamJobStore.finishWithError(job.id, errorPayload, {
                    nextState: aborted && !timedOut ? 'cancelled' : 'failed',
                    error: message,
                    details: aborted && !timedOut
                        ? { reason: runtime.abortReason ?? 'aborted' }
                        : { status },
                })
                : { event: await proxyStreamJobStore.appendEvent(job.id, 'error', errorPayload) };
            const errorEvent = flattenProxyStreamEvent(errorRecord.event);
            broadcastProxyStreamEvent(job.id, errorEvent);
        }
        catch (persistenceError) {
            console.error('[Proxy Stream] Failed to persist terminal error:', persistenceError);
        }
    } finally {
        if (proxyStreamJobRuntimes.get(job.id) === runtime) {
            proxyStreamJobRuntimes.delete(job.id);
        }
    }
}

async function startProxyStreamJob(job, arg) {
    const timeoutMs = normalizeProxyStreamTimeoutMs(Number(arg.timeoutMs));
    const heartbeatSec = normalizeHeartbeatSec(Number(arg.heartbeatSec));
    const runtime = {
        abortController: new AbortController(),
        abortReason: null,
        deadlineAt: Date.now() + timeoutMs,
        heartbeatSec,
        timeoutMs,
        offset: 0,
        status: undefined,
        headers: undefined,
    };
    proxyStreamJobRuntimes.set(job.id, runtime);
    try {
        await proxyStreamJobStore.start(job.id, { timeoutMs, heartbeatSec });
    }
    catch (error) {
        proxyStreamJobRuntimes.delete(job.id);
        throw error;
    }
    runtime.promise = runProxyStreamJob(job, runtime, arg).catch((error) => {
        console.error('[Proxy Stream] Unhandled job error:', error);
    });
    return runtime;
}

async function forwardUpstreamResponse(originalResponse, res) {
    const head = new Headers(originalResponse.headers);
    head.delete('content-security-policy');
    head.delete('content-security-policy-report-only');
    head.delete('clear-site-data');
    head.delete('Cache-Control');
    head.delete('Content-Encoding');

    const contentType = (head.get('content-type') || '').toLowerCase();
    const isSSE = contentType.includes('text/event-stream');
    if (isSSE) {
        head.set('Cache-Control', 'no-cache, no-transform');
        head.set('Connection', 'keep-alive');
        head.set('X-Accel-Buffering', 'no');
        head.delete('content-length');
    }

    const headObj = {};
    for (const [k, v] of head) {
        headObj[k] = v;
    }

    res.header(headObj);
    res.status(originalResponse.status);

    if (!originalResponse.body) {
        res.end();
        return;
    }

    if (!isSSE) {
        await pipeline(originalResponse.body, res);
        return;
    }

    const reader = originalResponse.body.getReader();

    const onClose = () => {
        reader.cancel().catch(() => {});
    };
    res.on('close', onClose);

    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    try {
        while (!res.writableEnded) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (value && value.length > 0) {
                res.write(Buffer.from(value));
            }
        }
    } catch (error) {
        if (!res.writableEnded) {
            throw error;
        }
    } finally {
        res.off('close', onClose);
        if (!res.writableEnded) {
            res.end();
        }
    }
}

app.get('/', async (req, res, next) => {

    const clientIP = req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'Unknown IP';
    const timestamp = new Date().toISOString();
    console.log(`[Server] ${timestamp} | Connection from: ${clientIP}`);
    
    try {
        const mainIndex = await fs.readFile(path.join(process.cwd(), 'dist', 'index.html'))
        const root = htmlparser.parse(mainIndex)
        const head = root.querySelector('head')
        head.innerHTML = `<script>globalThis.__NODE__ = true</script>` + head.innerHTML
        
        res.send(root.toString())
    } catch (error) {
        console.log(error)
        next(error)
    }
})

async function checkAuth(req, res, returnOnlyStatus = false){
    try {
        const authHeader = normalizeAuthHeader(req.headers['risu-auth']);

        if(!authHeader){
            console.log('No auth header')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'No auth header'
            });
            return false
        }


        //jwt token
        const [
            jsonHeaderB64,
            jsonPayloadB64,
            signatureB64,
        ] = authHeader.split('.');

        //alg, typ
        const jsonHeader = JSON.parse(Buffer.from(jsonHeaderB64, 'base64url').toString('utf-8'));

        //iat, exp, pub
        const jsonPayload = JSON.parse(Buffer.from(jsonPayloadB64, 'base64url').toString('utf-8'));

        //signature
        const signature = Buffer.from(signatureB64, 'base64url');

        
        //check expiration
        const now = Math.floor(Date.now() / 1000);
        if(jsonPayload.exp < now){
            console.log('Token expired')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Token Expired'
            });
            return false
        }

        //check if public key is known
        const pubKeyHash = await hashJSON(jsonPayload.pub)
        if(!knownPublicKeysHashes.includes(pubKeyHash)){
            console.log('Unknown public key')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Unknown Public Key'
            });
            return false
        }

        //check signature
        if(jsonHeader.alg !== "ES256"){
            //only support ECDSA for now
            console.log('Unsupported algorithm')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Unsupported Algorithm'
            });
            return false
        }

        const isValid = await crypto.subtle.verify(
            {
                name: 'ECDSA',
                hash: {name: 'SHA-256'},
            },
            await crypto.subtle.importKey(
                'jwk',
                jsonPayload.pub,
                {
                    name: 'ECDSA',
                    namedCurve: 'P-256',
                },
                false,
                ['verify']
            ),
            signature,
            Buffer.from(`${jsonHeaderB64}.${jsonPayloadB64}`)
        );

        if(!isValid){
            console.log('Invalid signature')
            if(returnOnlyStatus){
                return false;
            }
            res.status(400).send({
                error:'Invalid Signature'
            });
            return false
        }
        
        return true   
    } catch (error) {
        console.log(error)
        if(returnOnlyStatus){
            return false;
        }
        res.status(500).send({
            error:'Internal Server Error'
        });
        return false
    }
}

const reverseProxyFunc = async (req, res, next) => {
    if(!await checkProxyAuth(req, res)){
        return;
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }

    if(req.headers['authorization']?.startsWith('X-SERVER-REGISTER')){
        if(!existsSync(authCodePath)){
            delete header['authorization']
        }
        else{
            const authCode = await fs.readFile(authCodePath, {
                encoding: 'utf-8'
            })
            header['authorization'] = `Bearer ${authCode}`
        }
    }
    const timeoutMs = getRequestTimeoutMs(req.headers['risu-timeout-ms']);
    const timeout = createTimeoutController(timeoutMs);
    let originalResponse;
    try {
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: req.method,
            headers: header,
            body: JSON.stringify(req.body),
            signal: timeout.signal
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);

    }
    catch (err) {
        if (err?.name === 'AbortError') {
            if (!res.headersSent) {
                res.status(504).send({
                    error: timeoutMs
                        ? `Proxy request timed out after ${timeoutMs}ms`
                        : 'Proxy request aborted'
                });
            } else {
                res.end();
            }
            return;
        }
        next(err);
        return;
    } finally {
        timeout.cleanup();
    }
}

const reverseProxyFunc_get = async (req, res, next) => {
    if(!await checkProxyAuth(req, res)){
        return;
    }
    
    const urlParam = req.headers['risu-url'] ? decodeURIComponent(req.headers['risu-url']) : req.query.url;

    if (!urlParam) {
        res.status(400).send({
            error:'URL has no param'
        });
        return;
    }
    const header = req.headers['risu-header'] ? JSON.parse(decodeURIComponent(req.headers['risu-header'])) : req.headers;
    if(!header['x-forwarded-for']){
        header['x-forwarded-for'] = req.ip
    }
    const timeoutMs = getRequestTimeoutMs(req.headers['risu-timeout-ms']);
    const timeout = createTimeoutController(timeoutMs);
    let originalResponse;
    try {
        // make request to original server
        originalResponse = await fetch(urlParam, {
            method: 'GET',
            headers: header,
            signal: timeout.signal
        });
        // get response body as stream
        const originalBody = originalResponse.body;
        // get response headers
        const head = new Headers(originalResponse.headers);
        head.delete('content-security-policy');
        head.delete('content-security-policy-report-only');
        head.delete('clear-site-data');
        head.delete('Cache-Control');
        head.delete('Content-Encoding');
        const headObj = {};
        for (let [k, v] of head) {
            headObj[k] = v;
        }
        // send response headers to client
        res.header(headObj);
        // send response status to client
        res.status(originalResponse.status);
        // send response body to client
        await pipeline(originalResponse.body, res);
    }
    catch (err) {
        if (err?.name === 'AbortError') {
            if (!res.headersSent) {
                res.status(504).send({
                    error: timeoutMs
                        ? `Proxy request timed out after ${timeoutMs}ms`
                        : 'Proxy request aborted'
                });
            } else {
                res.end();
            }
            return;
        }
        next(err);
        return;
    } finally {
        timeout.cleanup();
    }
}

let accessTokenCache = {
    token: null,
    expiry: 0
}
async function getSionywAccessToken() {
    if(accessTokenCache.token && Date.now() < accessTokenCache.expiry){
        return accessTokenCache.token;
    }
    //Schema of the client data file
    // {
    //     refresh_token: string;
    //     client_id: string;
    //     client_secret: string;
    // }
    
    const clientDataPath = path.join(process.cwd(), 'save', '__sionyw_client_data.json');
    let refreshToken = ''
    let clientId = ''
    let clientSecret = ''
    if(!existsSync(clientDataPath)){
        throw new Error('No Sionyw client data found');
    }
    const clientDataRaw = readFileSync(clientDataPath, 'utf-8');
    const clientData = JSON.parse(clientDataRaw);
    refreshToken = clientData.refresh_token;
    clientId = clientData.client_id;
    clientSecret = clientData.client_secret;

    //Oauth Refresh Token Flow
    
    const tokenResponse = await fetch('account.sionyw.com/account/api/oauth/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret
        })
    })

    if(!tokenResponse.ok){
        throw new Error('Failed to refresh Sionyw access token');
    }

    const tokenData = await tokenResponse.json();

    //Update the refresh token in the client data file
    if(tokenData.refresh_token && tokenData.refresh_token !== refreshToken){
        clientData.refresh_token = tokenData.refresh_token;
        writeFileSync(clientDataPath, JSON.stringify(clientData), 'utf-8');
    }

    accessTokenCache.token = tokenData.access_token;
    accessTokenCache.expiry = Date.now() + (tokenData.expires_in * 1000) - (5 * 60 * 1000); //5 minutes early

    return tokenData.access_token;
}


async function hubProxyFunc(req, res) {
    const excludedHeaders = [
        'content-encoding',
        'content-length',
        'transfer-encoding'
    ];

    try {
        if (!hasValidHubSession(req) && !await checkProxyAuth(req, res)) {
            return;
        }
        const externalURL = resolveHubRequestTarget(
            req.originalUrl,
            hubURL,
            req.headers['x-risu-node-path'],
        );
        const headersToSend = buildHubRequestHeaders(req.headers, hubURL);

        //if Authorization header is "Server-Auth, set the token to be Server-Auth
        if(normalizeAuthHeader(req.headers.authorization) === 'X-Node-Server-Auth'){
            headersToSend.authorization = "Bearer " + await getSionywAccessToken();
        }
        
        
        const response = await fetch(externalURL, {
            method: req.method,
            headers: headersToSend,
            body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
            redirect: 'manual',
            duplex: 'half'
        });
        
        for (const [key, value] of response.headers.entries()) {
            // Skip encoding-related headers to prevent double decoding
            if (excludedHeaders.includes(key.toLowerCase())) {
                continue;
            }
            res.setHeader(key, value);
        }
        res.status(response.status);

        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            const redirectUrl = resolveHubRedirectTarget(
                response.headers.get('location'),
                externalURL,
                hubURL,
            );
            const newHeaders = { ...headersToSend };
            const redirectResponse = await fetch(redirectUrl, {
                method: req.method,
                headers: newHeaders,
                body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
                redirect: 'manual',
                duplex: 'half'
            });
            for (const [key, value] of redirectResponse.headers.entries()) {
                if (excludedHeaders.includes(key.toLowerCase())) {
                    continue;
                }
                res.setHeader(key, value);
            }
            res.status(redirectResponse.status);
            if (redirectResponse.body) {
                await pipeline(redirectResponse.body, res);
            } else {
                res.end();
            }
            return;
        }
        
        if (response.body) {
            await pipeline(response.body, res);
        } else {
            res.end();
        }
        
    } catch (error) {
        if (error instanceof HubProxyPolicyError && !res.headersSent) {
            res.status(error.statusCode).send({ error: error.message, code: error.code });
            return;
        }
        console.error("[Hub Proxy] Error:", error);
        if (!res.headersSent) {
            res.status(502).send({ error: 'Proxy request failed: ' + error.message });
        } else {
            res.end();
        }
    }
}

app.post('/api/hub-session', authenticatedRouteLimiter, async (req, res) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    const expiresAt = Date.now() + HUB_SESSION_TTL_MS;
    const token = createHubSession(expiresAt);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', hubSessionCookie(req, token));
    res.send({ expiresAt });
});

app.get('/proxy', authenticatedRouteLimiter, reverseProxyFunc_get);
app.get('/proxy2', authenticatedRouteLimiter, reverseProxyFunc_get);
app.get('/hub-proxy/*', authenticatedRouteLimiter, hubProxyFunc);

app.post('/proxy', authenticatedRouteLimiter, reverseProxyFunc);
app.post('/proxy2', authenticatedRouteLimiter, reverseProxyFunc);
app.post('/hub-proxy/*', authenticatedRouteLimiter, hubProxyFunc);

function sendProxyStreamRouteError(error, res, next) {
    if (error instanceof SpoolQuotaExceededError || error?.code === 'SPOOL_QUOTA_EXCEEDED') {
        res.status(507).send({
            error: error.message,
            code: error.code,
            maxSpoolBytes: error.maxSpoolBytes,
            spoolBytes: error.spoolBytes,
        });
        return;
    }
    if (error instanceof IdempotencyConflictError || error?.code === 'IDEMPOTENCY_CONFLICT') {
        res.status(409).send({
            error: error.message,
            code: error.code,
            existingJobId: error.existingJobId,
        });
        return;
    }
    if (error instanceof JobNotFoundError || error?.code === 'JOB_NOT_FOUND') {
        res.status(404).send({ error: error.message, code: error.code });
        return;
    }
    if (error?.code === 'INVALID_STATE_TRANSITION') {
        res.status(409).send({ error: error.message, code: error.code });
        return;
    }
    if (error instanceof TypeError) {
        res.status(400).send({ error: error.message });
        return;
    }
    next(error);
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

function isCanonicalBase64(value) {
    if (value === '') {
        return true;
    }
    return typeof value === 'string'
        && value.length % 4 === 0
        && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
        && Buffer.from(value, 'base64').toString('base64') === value;
}

app.get('/proxy-stream-jobs', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    try {
        const filter = {};
        if (typeof req.query.state === 'string' && req.query.state) {
            filter.state = req.query.state;
        }
        if (typeof req.query.generationId === 'string') {
            filter.generationId = req.query.generationId;
        }
        if (typeof req.query.requestId === 'string') {
            filter.requestId = req.query.requestId;
        }
        if (req.query.acknowledged === 'true' || req.query.acknowledged === 'false') {
            filter.acknowledged = req.query.acknowledged === 'true';
        }
        const jobs = await proxyStreamJobStore.list(filter);
        res.setHeader('Cache-Control', 'no-store');
        res.send({ jobs: await Promise.all(jobs.map(getPublicProxyStreamJob)) });
    }
    catch (error) {
        sendProxyStreamRouteError(error, res, next);
    }
});

app.get('/proxy-stream-jobs/:jobId/events', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    try {
        await proxyStreamJobStore.get(req.params.jobId);
        const afterSequence = parseNonNegativeSafeInteger(req.query.afterSequence, 'afterSequence', 0);
        const limit = req.query.limit === undefined
            ? PROXY_STREAM_EVENT_PAGE_SIZE
            : parseNonNegativeSafeInteger(req.query.limit, 'limit');
        if (limit < 1 || limit > 10_000) {
            throw new TypeError('limit must be an integer between 1 and 10000');
        }
        const page = await proxyStreamJobStore.replay(req.params.jobId, { afterSequence, limit });
        res.setHeader('Cache-Control', 'no-store');
        res.send({
            events: page.events.filter(isProxyStreamTransportEvent).map(flattenProxyStreamEvent),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
        });
    }
    catch (error) {
        sendProxyStreamRouteError(error, res, next);
    }
});

app.get('/proxy-stream-jobs/:jobId', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    try {
        res.setHeader('Cache-Control', 'no-store');
        res.send(await getPublicProxyStreamJob(req.params.jobId));
    }
    catch (error) {
        sendProxyStreamRouteError(error, res, next);
    }
});

app.post('/proxy-stream-jobs/:jobId/socket-ticket', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    try {
        await proxyStreamJobStore.get(req.params.jobId);
        const ticket = createProxyStreamSocketTicket(req.params.jobId);
        res.setHeader('Cache-Control', 'no-store');
        res.send({
            ticket: ticket.ticket,
            expiresAt: ticket.expiresAt,
            path: `/proxy-stream-jobs/${encodeURIComponent(req.params.jobId)}/ws`,
        });
    }
    catch (error) {
        sendProxyStreamRouteError(error, res, next);
    }
});

app.post('/proxy-stream-jobs', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    try {
        const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
        const encodedUrl = encodeURIComponent(rawUrl);
        const resolvedTarget = await resolveLocalTarget(decodeURIComponent(encodedUrl));
        if (!resolvedTarget) {
            res.status(400).send({ error: 'Invalid target URL. Only local/private network http(s) endpoints are allowed.' });
            return;
        }
        const url = resolvedTarget.url;

        const method = typeof req.body?.method === 'string' ? req.body.method.toUpperCase() : 'POST';
        if (!['POST', 'GET', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
            res.status(400).send({ error: 'Invalid method' });
            return;
        }

        const bodyBase64 = typeof req.body?.bodyBase64 === 'string' ? req.body.bodyBase64 : '';
        if (bodyBase64.length > PROXY_STREAM_MAX_BODY_BASE64_BYTES) {
            res.status(413).send({ error: 'Request body too large' });
            return;
        }
        if (!isCanonicalBase64(bodyBase64)) {
            res.status(400).send({ error: 'bodyBase64 must be canonical base64' });
            return;
        }

        const bodyRequestId = typeof req.body?.requestId === 'string' ? req.body.requestId : '';
        const bodyIdempotencyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : '';
        const headerIdempotencyKey = normalizeAuthHeader(req.headers['idempotency-key']);
        const suppliedKeys = [bodyRequestId, bodyIdempotencyKey, headerIdempotencyKey].filter(Boolean);
        if (new Set(suppliedKeys).size > 1) {
            res.status(400).send({ error: 'requestId and idempotencyKey values must match' });
            return;
        }
        const requestId = suppliedKeys[0] || `legacy:${crypto.randomUUID()}`;
        const generationId = typeof req.body?.generationId === 'string'
            ? req.body.generationId
            : (typeof req.body?.chatId === 'string' ? req.body.chatId : null);
        const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : null;
        const stepId = typeof req.body?.stepId === 'string' ? req.body.stepId : null;
        const clientContext = req.body?.context === undefined ? {} : req.body.context;
        if (!clientContext || typeof clientContext !== 'object' || Array.isArray(clientContext)) {
            throw new TypeError('context must be a JSON object');
        }
        const serializedContext = stableJsonStringify(clientContext);
        if (Buffer.byteLength(serializedContext) > PROXY_STREAM_MAX_CONTEXT_BYTES) {
            res.status(413).send({ error: 'Proxy stream job context is too large' });
            return;
        }

        const headers = normalizeForwardHeaders(req.body?.headers);
        const timeoutMs = normalizeProxyStreamTimeoutMs(Number(req.body?.timeoutMs));
        const heartbeatSec = normalizeHeartbeatSec(Number(req.body?.heartbeatSec));
        const requestEnvelope = {
            url,
            method,
            headers,
            bodyBase64,
            timeoutMs,
            heartbeatSec,
            generationId,
            chatId,
            stepId,
            context: clientContext,
        };
        const requestHash = hashProxyStreamRequestEnvelope(requestEnvelope);
        const created = await proxyStreamJobStore.create({
            requestId,
            requestHash,
            generationId,
            stepId,
            context: {
                heartbeatSec,
                timeoutMs,
                chatId,
                client: clientContext,
            },
        });

        if (!created.created) {
            const existing = await getPublicProxyStreamJob(created.job);
            res.send({ ...existing, reused: true });
            return;
        }
        if (proxyStreamJobRuntimes.size >= PROXY_STREAM_MAX_ACTIVE_JOBS) {
            await proxyStreamJobStore.fail(created.job.id, 'Too many active stream jobs');
            res.status(429).send({
                error: 'Too many active stream jobs. Retry shortly.',
                jobId: created.job.id,
                requestId,
            });
            return;
        }

        await startProxyStreamJob(created.job, {
            targetUrl: url,
            headers,
            method,
            bodyBase64,
            clientIp: req.ip,
            timeoutMs,
            heartbeatSec,
            targetAddress: {
                address: resolvedTarget.address,
                family: resolvedTarget.family,
            },
        });

        res.status(201).send({
            jobId: created.job.id,
            requestId,
            generationId,
            chatId,
            stepId,
            state: 'running',
            heartbeatSec,
            reused: false,
        });
    }
    catch (error) {
        sendProxyStreamRouteError(error, res, next);
    }
});

app.post('/proxy-stream-jobs/:jobId/ack', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    try {
        const acknowledgement = req.body === undefined ? {} : req.body;
        const job = await proxyStreamJobStore.ack(req.params.jobId, acknowledgement);
        res.send({ success: true, job: await getPublicProxyStreamJob(job) });
    }
    catch (error) {
        sendProxyStreamRouteError(error, res, next);
    }
});

app.delete('/proxy-stream-jobs/:jobId', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    try {
        let existing;
        try {
            existing = await proxyStreamJobStore.get(req.params.jobId);
        }
        catch (error) {
            if (error?.code === 'JOB_NOT_FOUND') {
                res.send({ success: true, state: 'missing' });
                return;
            }
            throw error;
        }
        const runtime = proxyStreamJobRuntimes.get(existing.id);
        if (runtime && !runtime.abortController.signal.aborted) {
            runtime.abortReason = 'user_cancel';
            runtime.abortController.abort();
        }
        const job = await proxyStreamJobStore.cancel(existing.id, { reason: 'user_cancel' });
        res.send({ success: true, state: job.state, jobId: job.id });
    }
    catch (error) {
        sendProxyStreamRouteError(error, res, next);
    }
});

// app.get('/api/password', async(req, res)=> {
//     if(password === ''){
//         res.send({status: 'unset'})
//     }
//     else if(req.body.password && req.body.password.trim() === password.trim()){
//         res.send({status:'correct'})
//     }
//     else{
//         res.send({status:'incorrect'})
//     }
// })

app.get('/api/test_auth', authRouteLimiter, async(req, res) => {

    if(!password){
        res.send({status: 'unset'})
    }
    else if(!await checkAuth(req, res, true)){
        res.send({status: 'incorrect'})
    }
    else{
        res.send({status: 'success'})
    }
})

app.post('/api/login', loginRouteLimiter, async (req, res) => {
    if(password === ''){
        res.status(400).send({error: 'Password not set'})
        return;
    }
    if(req.body.password && req.body.password.trim() === password.trim()){
        knownPublicKeysHashes.push(await hashJSON(req.body.publicKey))
        writeFileSync(knownPublicKeysPath, JSON.stringify(knownPublicKeysHashes), 'utf-8')
        res.send({status:'success'})
    }
    else{
        res.status(400).send({error: 'Password incorrect'})
    }
})

app.post('/api/executor_login', loginRouteLimiter, async (req, res) => {
    const expectedExecutorIp = normalizeExecutorIp(process.env.RISU_RUNTIME_EXECUTOR_IP || '')
    const sourceIp = normalizeExecutorIp(req.socket?.remoteAddress || '')
    if(!expectedExecutorIp || sourceIp !== expectedExecutorIp){
        res.status(403).send({error: 'Executor source is not authorized'})
        return
    }
    if(!req.body?.publicKey || typeof req.body.publicKey !== 'object' || Array.isArray(req.body.publicKey)){
        res.status(400).send({error: 'publicKey is required'})
        return
    }
    const publicKeyHash = await hashJSON(req.body.publicKey)
    if(!knownPublicKeysHashes.includes(publicKeyHash)){
        knownPublicKeysHashes.push(publicKeyHash)
        writeFileSync(knownPublicKeysPath, JSON.stringify(knownPublicKeysHashes), {
            encoding: 'utf-8',
            mode: 0o600,
        })
    }
    res.send({status:'success'})
})

app.post('/api/crypto', async (req, res) => {
    try {
        const hash = crypto.createHash('sha256')
        hash.update(Buffer.from(req.body.data, 'utf-8'))
        res.send(hash.digest('hex'))
    } catch (error) {
        res.status(500).send({ error: 'Crypto operation failed' });
    }
})


app.post('/api/set_password', async (req, res) => {
    if(password === '' && process.env.RISU_ALLOW_LEGACY_PASSWORD_SETUP === 'true'){
        if(typeof req.body?.password !== 'string' || !req.body.password){
            res.status(400).send({error: 'Password is required'})
            return
        }
        password = req.body.password
        writeFileSync(passwordPath, password, { encoding: 'utf-8', mode: 0o600 })
        res.send({status: 'success'})
    }
    else if(password === ''){
        res.status(403).send({error: 'Set RISU_NODE_BOOTSTRAP_PASSWORD on the server'})
    }
    else{
        res.status(400).send("already set")
    }
})

function setDatabaseRevisionHeaders(res, value) {
    res.setHeader('ETag', value.etag);
    res.setHeader('X-Risu-Revision', String(value.revision));
    res.setHeader('X-Risu-Sha256', value.sha256);
    res.setHeader('Cache-Control', 'no-store');
}

function parseDatabaseRevisionHeader(value) {
    const normalized = normalizeAuthHeader(value);
    if (!normalized || !/^\d+$/.test(normalized)) {
        return null;
    }
    const revision = Number(normalized);
    return Number.isSafeInteger(revision) ? revision : null;
}

function parseRuntimeGenerationWriteFence(req) {
    const generationId = normalizeAuthHeader(req.headers['x-risu-generation-id']);
    const executorId = normalizeAuthHeader(req.headers['x-risu-executor-id']);
    const rawFencingToken = normalizeAuthHeader(req.headers['x-risu-fencing-token']);
    const suppliedCount = Number(Boolean(generationId))
        + Number(Boolean(executorId))
        + Number(Boolean(rawFencingToken));
    if (suppliedCount === 0) {
        return null;
    }
    if (suppliedCount !== 3) {
        throw new TypeError(
            'X-Risu-Generation-Id, X-Risu-Executor-Id, and X-Risu-Fencing-Token must be supplied together'
        );
    }
    if (generationId.length > 512 || executorId.length > 256) {
        throw new TypeError('Runtime generation write fence header is too long');
    }
    if (!/^\d+$/.test(rawFencingToken)) {
        throw new TypeError('X-Risu-Fencing-Token must be a positive safe integer');
    }
    const fencingToken = Number(rawFencingToken);
    if (!Number.isSafeInteger(fencingToken) || fencingToken <= 0) {
        throw new TypeError('X-Risu-Fencing-Token must be a positive safe integer');
    }
    return { generationId, executorId, fencingToken };
}

function rejectVersionedDatabaseLegacyMutation(res) {
    res.status(409).send({
        error: 'The canonical database must be changed through the versioned sync endpoint',
        code: 'VERSIONED_DATABASE_REQUIRED',
        path: '/api/sync/database',
    });
}

function sendDatabaseSyncRouteError(error, res, next) {
    if (error?.code === 'ENOENT') {
        res.status(404).send({ error: 'Database has not been initialized' });
        return;
    }
    if (error?.code === 'EFBIG') {
        res.status(413).send({ error: error.message });
        return;
    }
    if (error?.code === 'GENERATION_WRITE_LEASE_ACTIVE') {
        res.status(423).send({
            error: error.message,
            code: error.code,
            ...(error.commandId ? { commandId: error.commandId } : {}),
            ...(Number.isSafeInteger(error.leaseExpiresAt)
                ? { leaseExpiresAt: error.leaseExpiresAt }
                : {}),
        });
        return;
    }
    if (error instanceof TypeError) {
        res.status(400).send({ error: error.message });
        return;
    }
    if (error?.code === 'STALE_EXECUTOR_FENCE') {
        res.status(409).send({
            error: error.message,
            code: error.code,
            ...(error.reason ? { reason: error.reason } : {}),
        });
        return;
    }
    next(error);
}

app.get('/api/sync/database', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    try {
        const store = await getDatabaseRevisionStore();
        const snapshot = await store.read();
        setDatabaseRevisionHeaders(res, snapshot);
        res.type('application/octet-stream').send(snapshot.data);
    }
    catch (error) {
        sendDatabaseSyncRouteError(error, res, next);
    }
});

app.put('/api/sync/database', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    try {
        if (!Buffer.isBuffer(req.body)) {
            res.status(415).send({ error: 'Content-Type must be application/octet-stream' });
            return;
        }

        const rawBaseRevision = normalizeAuthHeader(req.headers['x-risu-base-revision']);
        const baseEtag = normalizeAuthHeader(req.headers['if-match']);
        if (!rawBaseRevision && !baseEtag) {
            res.status(428).send({ error: 'If-Match or X-Risu-Base-Revision is required' });
            return;
        }
        const baseRevision = rawBaseRevision
            ? parseDatabaseRevisionHeader(rawBaseRevision)
            : undefined;
        if (rawBaseRevision && baseRevision === null) {
            res.status(400).send({ error: 'X-Risu-Base-Revision must be a non-negative safe integer' });
            return;
        }

        const idempotencyKey = normalizeAuthHeader(req.headers['idempotency-key']);
        if (!idempotencyKey) {
            res.status(400).send({ error: 'Idempotency-Key is required' });
            return;
        }
        const clientId = normalizeAuthHeader(
            req.headers['x-risu-client-id'] || req.headers['x-risu-device-id']
        );
        if (clientId.length > 256) {
            res.status(400).send({ error: 'X-Risu-Client-Id is too long' });
            return;
        }
        const kind = normalizeAuthHeader(req.headers['x-risu-commit-kind']) || 'stable';
        if (kind !== 'stable' && kind !== 'streaming') {
            res.status(400).send({ error: 'X-Risu-Commit-Kind must be stable or streaming' });
            return;
        }

        const generationFence = parseRuntimeGenerationWriteFence(req);
        const writeFence = generationFence
            ? {
                commandId: generationFence.generationId,
                executorId: generationFence.executorId,
                fencingToken: generationFence.fencingToken,
            }
            : null;
        const response = await runtimeGenerationStore.runWithDatabaseWriteFence(
            writeFence,
            async () => {
                const store = await getDatabaseRevisionStore(
                    baseEtag === '*' ? req.body : undefined
                );
                let commitBaseRevision = baseRevision;
                let commitBaseEtag = baseEtag || undefined;
                if (baseEtag === '*') {
                    const head = await store.getHead();
                    const incomingSha256 = crypto.createHash('sha256').update(req.body).digest('hex');
                    if (head.revision === 0 && head.sha256 === incomingSha256) {
                        commitBaseRevision = 0;
                        commitBaseEtag = undefined;
                    }
                }
                const result = await store.commit({
                    data: req.body,
                    baseRevision: commitBaseRevision,
                    baseEtag: commitBaseEtag,
                    idempotencyKey,
                    clientId,
                    kind,
                });
                if (!result.ok) {
                    return { status: 409, headers: result, body: result };
                }
                if (result.duplicate) {
                    const current = await store.getHead();
                    return {
                        status: 200,
                        headers: current,
                        body: {
                            ...result,
                            currentRevision: current.revision,
                            currentSha256: current.sha256,
                            currentEtag: current.etag,
                        },
                    };
                }
                return { status: 200, headers: result, body: result };
            },
        );
        setDatabaseRevisionHeaders(res, response.headers);
        res.status(response.status).send(response.body);
    }
    catch (error) {
        sendDatabaseSyncRouteError(error, res, next);
    }
});

app.get('/api/sync/database/conflicts', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    try {
        const store = await getDatabaseRevisionStore();
        res.setHeader('Cache-Control', 'no-store');
        res.send({ conflicts: await store.listConflicts() });
    }
    catch (error) {
        sendDatabaseSyncRouteError(error, res, next);
    }
});

app.get('/api/sync/database/conflicts/:conflictId', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    try {
        const store = await getDatabaseRevisionStore();
        const conflict = await store.readConflict(req.params.conflictId);
        if (!conflict) {
            res.status(404).send({ error: 'Conflict snapshot not found' });
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Risu-Conflict-Reason', conflict.reason);
        res.setHeader('X-Risu-Incoming-Sha256', conflict.incomingSha256);
        res.setHeader('X-Risu-Current-Revision', String(conflict.currentRevision));
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="risu-conflict-${conflict.conflictId}.bin"`
        );
        res.type('application/octet-stream').send(conflict.data);
    }
    catch (error) {
        sendDatabaseSyncRouteError(error, res, next);
    }
});

app.post('/api/sync/socket-ticket', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkProxyAuth(req, res)) {
        return;
    }
    try {
        await getDatabaseRevisionStore();
        const bodyClientId = typeof req.body?.clientId === 'string' ? req.body.clientId : '';
        const clientId = normalizeAuthHeader(
            req.headers['x-risu-client-id'] || req.headers['x-risu-device-id']
        ) || bodyClientId;
        if (clientId.length > 256) {
            res.status(400).send({ error: 'clientId is too long' });
            return;
        }
        const ticket = createDatabaseSocketTicket(clientId);
        res.setHeader('Cache-Control', 'no-store');
        res.send({
            ticket: ticket.ticket,
            expiresAt: ticket.expiresAt,
            path: '/api/sync/database/ws',
        });
    }
    catch (error) {
        sendDatabaseSyncRouteError(error, res, next);
    }
});

app.get('/api/read', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    if (!filePath) {
        console.log('no path')
        res.status(400).send({
            error:'File path required'
        });
        return;
    }

    if(!isHex(filePath)){
        res.status(400).send({
            error:'Invaild Path'
        });
        return;
    }
    try {
        if(!existsSync(path.join(savePath, filePath))){
            res.setHeader('Cache-Control', 'no-store');
            res.send();
        }
        else{
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('Content-Type','application/octet-stream');
            res.sendFile(path.join(savePath, filePath));
        }
    } catch (error) {
        next(error);
    }
});

app.get('/api/remove', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePaths = req.headers['file-path']?.split('$$') || []

    if (filePaths.includes(databaseStorageFileName)) {
        rejectVersionedDatabaseLegacyMutation(res);
        return;
    }

    for(const filePath of filePaths){
        if (!filePath) {
            res.status(400).send({
                error:'File path required'
            });
            return;
        }
        if(!isHex(filePath)){
            res.status(400).send({
                error:'Invaild Path'
            });
            return;
        }
    }

    try {
        await flatStorageStore.remove(filePaths);
        res.send({ success: true });
    } catch (error) {
        next(error);
    }
});

app.get('/api/list', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    try {
        const data = (await fs.readdir(path.join(savePath), { withFileTypes: true }))
            .filter((entry) => entry.isFile() && isHex(entry.name))
            .map((entry) => {
                return Buffer.from(entry.name, 'hex').toString('utf-8')
            })
        res.setHeader('Cache-Control', 'no-store');
        res.send({
            success: true,
            content: data
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/write', authenticatedRouteLimiter, async (req, res, next) => {
    if(!await checkAuth(req, res)){
        return;
    }
    const filePath = req.headers['file-path'];
    const fileContent = req.body
    if (!filePath || !fileContent) {
        res.status(400).send({
            error:'File path required'
        });
        return;
    }
    if(!isHex(filePath)){
        res.status(400).send({
            error:'Invaild Path'
        });
        return;
    }
    if (filePath === databaseStorageFileName) {
        rejectVersionedDatabaseLegacyMutation(res);
        return;
    }

    try {
        await flatStorageStore.write(filePath, fileContent);
        res.send({
            success: true
        });
    } catch (error) {
        if (error instanceof FlatStorageQuotaError) {
            res.status(507).send({
                error: error.message,
                code: error.code,
                maxBytes: error.maxBytes,
                minFreeBytes: error.minFreeBytes,
            });
            return;
        }
        next(error);
    }
});

const oauthData = {
    client_id: '',
    client_secret: '',
    config: {},
    code_verifier: ''

}
app.get('/api/oauth_login', async (req, res) => {
    const redirect_uri = (new URL (req.url)).host + '/api/oauth_callback'

    if(!redirect_uri){
        res.status(400).send({ error: 'redirect_uri is required' });
        return
    }
    if(!oauthData.client_id || !oauthData.client_secret){
        const discovery = await openid.discovery('https://account.sionyw.com/','','');
        oauthData.config = discovery;

        //oauth dynamic client registration
        //https://datatracker.ietf.org/doc/html/rfc7591

        const serverMeta = discovery.serverMetadata()
        //since we can't find a good library to do this, we will do it manually
        const registrationResponse = await fetch(serverMeta.registration_endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (serverMeta.registration_access_token || '')
            },
            body: JSON.stringify({
                client_id: oauthData.client_id,
                client_secret: oauthData.client_secret,
                redirect_uris: [redirect_uri],
                response_types: ['code'],
                grant_types: ['authorization_code'],
                scope: 'risuai',
                token_endpoint_auth_method: 'client_secret_basic',
                client_name: 'Risuai Node Server',
            })
        });

        if(registrationResponse.status === 201 || registrationResponse.status === 200){
            const registrationData = await registrationResponse.json();
            oauthData.client_id = registrationData.client_id;
            oauthData.client_secret = registrationData.client_secret;
            discovery.clientMetadata().client_id = oauthData.client_id;
            discovery.clientMetadata().client_secret = oauthData.client_secret;
        }
        else{
            console.error('[Server] OAuth2 dynamic client registration failed:', registrationResponse.statusText);
            res.status(500).send({ error: 'OAuth2 client registration failed' });
            return
        }


        //now lets request

        let code_verifier = openid.randomPKCECodeVerifier();
        let code_challenge = await openid.calculatePKCECodeChallenge(code_verifier);

        oauthData.code_verifier = code_verifier;
        let redirectTo = openid.buildAuthorizationUrl(oauthData.config, {
            redirect_uri,
            code_challenge,
            code_challenge_method: 'S256',
            scope: 'risuai',
        })

        res.redirect(redirectTo.toString());

        return;

    }
    
    res.status(500).send({ error: 'OAuth2 login failed' });
});

app.get('/api/oauth_callback', async (req, res) => {

    //since this is a callback we don't need to check password

    const params = (new URL(req.url, `http://${req.headers.host}`)).searchParams;
    const code = params.get('code');

    if(!code){
        res.status(400).send({ error: 'code is required' });
        return
    }
    if(!oauthData.client_id || !oauthData.client_secret || !oauthData.code_verifier){
        res.status(400).send({ error: 'OAuth2 not initialized' });
        return
    }

    let tokens = await openid.authorizationCodeGrant(
        oauthData.config,   
        getCurrentUrl(),
        {
            pkceCodeVerifier: oauthData.code_verifier,
        },
    )

    writeFileSync(authCodePath, tokens.access_token, 'utf-8')

    res.send(tokens)
            
})

async function getHttpsOptions() {

    const keyPath = path.join(sslPath, 'server.key');
    const certPath = path.join(sslPath, 'server.crt');

    try {
 
        await fs.access(keyPath);
        await fs.access(certPath);

        const [key, cert] = await Promise.all([
            fs.readFile(keyPath),
            fs.readFile(certPath)
        ]);
       
        return { key, cert };

    } catch (error) {
        console.error('[Server] SSL setup errors:', error.message);
        console.log('[Server] Start the server with HTTP instead of HTTPS...');
        return null;
    }
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

function setupDatabaseSyncWebSocket(server) {
    const wsServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        let reqUrl;
        try {
            reqUrl = new URL(req.url, `http://${req.headers.host}`);
        }
        catch {
            // Another upgrade handler may own a non-HTTP-shaped target.
            return;
        }
        if (reqUrl.pathname !== '/api/sync/database/ws') {
            return;
        }

        void (async () => {
            const ticketValue = consumeDatabaseSocketTicket(reqUrl.searchParams.get('ticket'));
            if (!ticketValue) {
                rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
                return;
            }
            try {
                await getDatabaseRevisionStore();
            }
            catch (error) {
                if (error?.code === 'ENOENT') {
                    rejectWebSocketUpgrade(socket, 404, 'Not Found');
                    return;
                }
                console.error('[Database Sync] WebSocket setup failed:', error);
                rejectWebSocketUpgrade(socket, 500, 'Internal Server Error');
                return;
            }

            wsServer.handleUpgrade(req, socket, head, (ws) => {
                wsServer.emit('connection', ws, req, ticketValue);
            });
        })().catch((error) => {
            console.error('[Database Sync] WebSocket upgrade failed:', error);
            rejectWebSocketUpgrade(socket, 500, 'Internal Server Error');
        });
    });

    wsServer.on('connection', async (ws, _req, ticketValue) => {
        const client = {
            ws,
            ready: false,
            pendingEvents: [],
        };
        databaseSyncClients.add(client);
        let heartbeatTimer = null;
        const cleanup = () => {
            if (heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
            databaseSyncClients.delete(client);
        };
        ws.once('close', cleanup);
        ws.once('error', cleanup);

        try {
            const store = await getDatabaseRevisionStore();
            const current = await store.getHead();
            if (ws.readyState !== ws.OPEN) {
                cleanup();
                return;
            }
            ws.send(JSON.stringify({
                type: 'hello',
                revision: current.revision,
                sha256: current.sha256,
                etag: current.etag,
                clientId: ticketValue.clientId,
            }));
            for (const event of client.pendingEvents) {
                if (event.revision > current.revision && ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify(event));
                }
            }
            client.pendingEvents = [];
            client.ready = true;
            heartbeatTimer = setInterval(() => {
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
                }
            }, DATABASE_SOCKET_HEARTBEAT_MS);
        }
        catch (error) {
            console.error('[Database Sync] WebSocket connection failed:', error);
            if (ws.readyState === ws.OPEN) {
                ws.close(1011, 'Database sync unavailable');
            }
            cleanup();
        }
    });
}

function setupProxyStreamWebSocket(server) {
    const wsServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
        let reqUrl;
        try {
            reqUrl = new URL(req.url, `http://${req.headers.host}`);
        } catch {
            return;
        }
        if (!reqUrl.pathname.startsWith('/proxy-stream-jobs/') || !reqUrl.pathname.endsWith('/ws')) {
            return;
        }

        void (async () => {
            const pathParts = reqUrl.pathname.split('/').filter(Boolean);
            const jobId = pathParts.length === 3 ? pathParts[1] : '';
            if (!jobId) {
                rejectWebSocketUpgrade(socket, 400, 'Bad Request');
                return;
            }
            const ticket = consumeProxyStreamSocketTicket(
                reqUrl.searchParams.get('ticket'),
                jobId,
            );
            if (!ticket) {
                rejectWebSocketUpgrade(socket, 401, 'Unauthorized');
                return;
            }
            try {
                await proxyStreamJobStore.get(jobId);
            }
            catch (error) {
                if (error?.code === 'JOB_NOT_FOUND') {
                    rejectWebSocketUpgrade(socket, 404, 'Not Found');
                    return;
                }
                throw error;
            }
            const afterSequence = parseNonNegativeSafeInteger(
                reqUrl.searchParams.get('afterSequence'),
                'afterSequence',
                0,
            );

            wsServer.handleUpgrade(req, socket, head, (ws) => {
                wsServer.emit('connection', ws, req, { jobId, afterSequence });
            });
        })().catch((error) => {
            console.error('[Proxy Stream] WebSocket upgrade failed:', error);
            rejectWebSocketUpgrade(socket, 400, 'Bad Request');
        });
    });

    wsServer.on('connection', async (ws, _req, connection) => {
        const { jobId, afterSequence } = connection;
        const subscriber = { ws, ready: false, pendingEvents: [] };
        let subscribers = proxyStreamJobSubscribers.get(jobId);
        if (!subscribers) {
            subscribers = new Set();
            proxyStreamJobSubscribers.set(jobId, subscribers);
        }
        subscribers.add(subscriber);
        let pingTimer = null;
        const cleanup = () => {
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }
            const currentSubscribers = proxyStreamJobSubscribers.get(jobId);
            currentSubscribers?.delete(subscriber);
            if (currentSubscribers?.size === 0) {
                proxyStreamJobSubscribers.delete(jobId);
            }
        };
        ws.once('close', cleanup);
        ws.once('error', cleanup);

        try {
            const job = await proxyStreamJobStore.get(jobId);
            const publicJob = await getPublicProxyStreamJob(job);
            if (ws.readyState !== ws.OPEN) {
                cleanup();
                return;
            }
            ws.send(JSON.stringify({
                type: 'job_snapshot',
                jobId,
                state: publicJob.state,
                lastSequence: publicJob.lastSequence,
                cursor: publicJob.cursor,
                ...(publicJob.status !== undefined ? { status: publicJob.status } : {}),
                ...(publicJob.headers !== undefined ? { headers: publicJob.headers } : {}),
            }));

            let replayCursor = afterSequence;
            while (ws.readyState === ws.OPEN) {
                const page = await proxyStreamJobStore.replay(jobId, {
                    afterSequence: replayCursor,
                    limit: PROXY_STREAM_EVENT_PAGE_SIZE,
                });
                for (const record of page.events) {
                    if (isProxyStreamTransportEvent(record) && ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify(flattenProxyStreamEvent(record)));
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
            subscriber.ready = true;
            pingTimer = setInterval(() => {
                if (ws.readyState !== ws.OPEN) {
                    return;
                }
                const runtime = proxyStreamJobRuntimes.get(jobId);
                ws.send(JSON.stringify({
                    type: 'ping',
                    ts: Date.now(),
                    cursor: runtime?.offset ?? publicJob.cursor,
                }));
            }, publicJob.heartbeatSec * 1000);
        }
        catch (error) {
            console.error('[Proxy Stream] WebSocket connection failed:', error);
            if (ws.readyState === ws.OPEN) {
                ws.close(1011, 'Proxy stream unavailable');
            }
            cleanup();
        }
    });
}

async function startServer() {
    await flatStorageStore.open();
    try {
        await openDatabaseRevisionStoreAtStartup();
        await proxyStreamJobStore.open();
        await pruneProxyStreamJobs();
        await runtimeGenerationStore.open();
        await pruneRuntimeGenerationCommands();
        const port = process.env.PORT || 6001;
        const httpsOptions = await getHttpsOptions();
        let server = null;

        if (httpsOptions) {
            // HTTPS
            server = https.createServer(httpsOptions, app);
            setupDatabaseSyncWebSocket(server);
            setupProxyStreamWebSocket(server);
            runtimeGenerationServer.setupWebSocket(server);
            server.listen(port, () => {
                console.log("[Server] HTTPS server is running.");
                console.log(`[Server] https://localhost:${port}/`);
            });
        } else {
            // HTTP
            server = http.createServer(app);
            setupDatabaseSyncWebSocket(server);
            setupProxyStreamWebSocket(server);
            runtimeGenerationServer.setupWebSocket(server);
            server.listen(port, () => {
                console.log("[Server] HTTP server is running.");
                console.log(`[Server] http://localhost:${port}/`);
            });
        }
    } catch (error) {
        console.error('[Server] Failed to start server :', error);
        process.exit(1);
    }
}

(async () => {
    setInterval(() => {
        const now = Date.now();
        for (const runtime of proxyStreamJobRuntimes.values()) {
            if (now >= runtime.deadlineAt && !runtime.abortController.signal.aborted) {
                runtime.abortReason = 'timeout';
                runtime.abortController.abort();
            }
        }
        void pruneProxyStreamJobs(now).catch((error) => {
            console.error('[Proxy Stream] Retention sweep failed:', error);
        });
    }, PROXY_STREAM_GC_INTERVAL_MS);
    await startServer();
    setInterval(() => {
        void runtimeGenerationServer.expireLeaseAndBroadcast().catch((error) => {
            console.error('[Runtime Generation] Lease sweep failed:', error);
        });
    }, RUNTIME_GENERATION_LEASE_SWEEP_MS);
    setInterval(() => {
        void pruneRuntimeGenerationCommands().catch((error) => {
            console.error('[Runtime Generation] Retention sweep failed:', error);
        });
    }, RUNTIME_GENERATION_RETENTION_SWEEP_MS);
})();
