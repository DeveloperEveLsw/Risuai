'use strict';

/**
 * Real Chromium E2E for the resident generation hand-off.
 *
 * This is deliberately an opt-in executable instead of part of the fast Node
 * test suite. It builds the real Svelte UI, starts the production Node server
 * in a temporary cwd, and gives every browser role its own incognito storage
 * partition. No save/profile/port from a running Risu installation is read.
 *
 * Run:
 *   node server/node/runtimeGenerations/browserE2E.cjs
 *
 * Set RISU_BROWSER_E2E_SKIP_BUILD=1 to reuse an already-built dist directory.
 * Set RISU_BROWSER_E2E_CHROMIUM=/path/to/chromium to override auto-detection.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { Packr, Unpackr } = require('msgpackr');
const WebSocket = require('ws');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_SCRIPT = path.join(REPOSITORY_ROOT, 'server', 'node', 'server.cjs');
const DATABASE_STORAGE_KEY = 'database/database.bin';
const DATABASE_FILE_NAME = Buffer.from(DATABASE_STORAGE_KEY, 'utf8').toString('hex');
const LEGACY_SAVE_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);
const BLOCK_SAVE_HEADER = Buffer.from('RISUSAVE\0', 'utf8');
const CHARACTER_ID = 'e2e-character';
const CHAT_ID = 'e2e-chat';
const CLEAR_PASSWORD = 'risu-browser-e2e-password';
const PASSWORD_HASH = crypto.createHash('sha256').update(CLEAR_PASSWORD).digest('hex');
const NORMAL_INPUT = 'handoff from desktop';
const CANCEL_INPUT = 'cancel safely from phone';
const NORMAL_PARTIAL = 'E2E partial';
const NORMAL_PROVIDER_FINAL = 'E2E complete';
const NORMAL_FINAL = 'E2E_FINAL_OK';
const CANCEL_PARTIAL = 'E2E cancel partial';
const LUA_SUFFIX = '::LUA_OK';
const V21_SUFFIX = '::V21_OK';
const MODULE_ID = 'e2e-compat-module';
const DEFAULT_TIMEOUT_MS = 30_000;

const childProcesses = new Set();
let temporaryRoot = null;
let mockProvider = null;
let cdp = null;

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function eventually(operation, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? 75;
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const value = await operation();
            if (value) {
                return value;
            }
        }
        catch (error) {
            lastError = error;
        }
        await sleep(intervalMs);
    }
    const suffix = lastError ? ` Last error: ${lastError.stack ?? lastError}` : '';
    throw new Error(`Timed out after ${timeoutMs}ms.${suffix}`);
}

async function getUnusedPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function run(command, args, options = {}) {
    const child = spawn(command, args, {
        cwd: options.cwd ?? REPOSITORY_ROOT,
        env: { ...process.env, ...options.env },
        stdio: options.stdio ?? 'inherit',
    });
    childProcesses.add(child);
    const [exitCode, signal] = await once(child, 'exit');
    childProcesses.delete(child);
    if (exitCode !== 0) {
        throw new Error(`${command} exited with ${exitCode ?? signal}`);
    }
}

async function buildApplication() {
    if (process.env.RISU_BROWSER_E2E_SKIP_BUILD === '1') {
        await fs.access(path.join(REPOSITORY_ROOT, 'dist', 'index.html'));
        return;
    }
    console.log('[browser-e2e] Building the real UI with private self-host legal acknowledgement...');
    await run('pnpm', ['exec', 'vite', 'build', '--sourcemap'], {
        env: { VITE_RISU_LEGAL_CONFIGURED: 'TRUE' },
    });
}

function createSeedDatabase(providerPort) {
    return {
        didFirstSetup: true,
        formatversion: 5,
        language: 'en',
        characters: [{
            type: 'character',
            name: 'Runtime E2E Character',
            image: '',
            firstMessage: 'Ready for an isolated browser test.',
            desc: 'A fixture that exists only in the temporary E2E save.',
            notes: '',
            chats: [{
                id: CHAT_ID,
                message: [],
                note: '',
                name: 'E2E Chat',
                localLore: [],
                fmIndex: -1,
            }],
            chatFolders: [],
            chatPage: 0,
            viewScreen: 'none',
            bias: [],
            emotionImages: [],
            globalLore: [],
            chaId: CHARACTER_ID,
            sdData: [],
            customscript: [],
            // The production regression was caused by display preprocessing
            // assigning lowLevelAccess=false to every live character trigger.
            // Keep this trigger permission intentionally undefined so an open
            // follower would create a stale CAS save if rendering ever mutates
            // the canonical database again.
            triggerscript: [{
                comment: 'Display immutability regression sentinel',
                type: 'manual',
                conditions: [],
                effect: [],
            }],
            utilityBot: false,
            exampleMessage: '',
            creatorNotes: '',
            systemPrompt: '',
            postHistoryInstructions: '',
            alternateGreetings: [],
            tags: [],
            creator: 'browser-e2e',
            characterVersion: '1',
            personality: '',
            scenario: '',
            firstMsgIndex: -1,
            replaceGlobalNote: '',
            additionalText: '',
            reloadKeys: 0,
        }],
        characterOrder: [CHARACTER_ID],
        plugins: [{
            name: 'E2E V2.1 output fixture',
            version: '2.1',
            enabled: true,
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            script: `addRisuScriptHandler('output', async (value) => value + ${JSON.stringify(V21_SUFFIX)})`,
        }],
        pluginV2: [],
        pluginCustomStorage: {},
        modules: [{
            id: MODULE_ID,
            name: 'E2E Lua and regex compatibility fixture',
            description: 'Proves the original module post-processing pipeline inside the resident browser.',
            lowLevelAccess: false,
            lorebook: [],
            trigger: [{
                comment: 'Append a marker from the module Lua editOutput hook',
                type: 'manual',
                conditions: [],
                effect: [{
                    type: 'triggerlua',
                    code: `listenEdit('editOutput', function(id, value, meta) return value .. ${JSON.stringify(LUA_SUFFIX)} end)`,
                }],
            }],
            regex: [{
                comment: 'Require both Lua and V2.1 markers before producing the final E2E marker',
                type: 'editoutput',
                in: `^${NORMAL_PARTIAL} ${NORMAL_PROVIDER_FINAL}${LUA_SUFFIX}${V21_SUFFIX}$`,
                out: NORMAL_FINAL,
                ableFlag: true,
                flag: 'u',
            }],
        }],
        enabledModules: [MODULE_ID],
        loadouts: [],
        aiModel: 'reverse_proxy',
        subModel: 'reverse_proxy',
        apiType: 'reverse_proxy',
        useStreaming: true,
        forceReplaceUrl: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
        autofillRequestUrl: false,
        proxyKey: 'e2e-mock-key',
        proxyRequestModel: 'custom',
        customProxyRequestModel: 'e2e-stream-model',
        customAPIFormat: 0,
        localNetworkMode: true,
        localNetworkTimeoutSec: 30,
        genTime: 1,
        requestRetrys: 0,
        maxContext: 4096,
        maxResponse: 128,
        temperature: 70,
        frequencyPenalty: 0,
        PresensePenalty: 0,
        top_p: 1,
        formatingOrder: [
            'main',
            'description',
            'personaPrompt',
            'chats',
            'lastChat',
            'jailbreak',
            'lorebook',
            'globalNote',
            'authorNote',
        ],
        mainPrompt: 'Write the next response as {{char}}.',
        jailbreak: '',
        globalNote: '',
        additionalPrompt: '',
        promptSettings: {
            assistantPrefill: '',
            postEndInnerFormat: '',
            sendChatAsSystem: false,
            sendName: false,
            utilOverride: false,
            customChainOfThought: false,
            maxThoughtTagDepth: -1,
        },
        username: 'E2E User',
        userIcon: '',
        userNote: '',
        personas: [{
            id: 'e2e-persona',
            name: 'E2E User',
            personaPrompt: '',
            icon: '',
            note: '',
            largePortrait: false,
        }],
        selectedPersona: 0,
        playMessage: false,
        notification: false,
        betaMobileGUI: false,
        hideRealm: true,
        roundIcons: false,
        removeIncompleteResponse: false,
        streamingDisplayOptimizationMode: 'off',
        enableRemoteSaving: false,
        coldstorage: false,
        sendWithEnter: true,
        useSayNothing: true,
        promptInfoInsideChat: false,
        promptTextInfoInsideChat: false,
        heightMode: 'dvh',
    };
}

function encodeLegacySave(database) {
    const packr = new Packr({ useRecords: false });
    return Buffer.concat([LEGACY_SAVE_HEADER, Buffer.from(packr.encode(database))]);
}

function decodeCanonicalDatabase(data) {
    if (data.subarray(0, LEGACY_SAVE_HEADER.length).equals(LEGACY_SAVE_HEADER)) {
        const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false });
        return unpackr.decode(data.subarray(LEGACY_SAVE_HEADER.length));
    }
    assert.ok(
        data.subarray(0, BLOCK_SAVE_HEADER.length).equals(BLOCK_SAVE_HEADER),
        'canonical database has an unknown RisuSave header',
    );
    let offset = BLOCK_SAVE_HEADER.length;
    const database = { characters: [] };
    while (offset < data.length) {
        assert.ok(offset + 7 <= data.length, 'truncated RisuSave block header');
        const type = data[offset];
        const compressed = data[offset + 1] === 1;
        const nameLength = data[offset + 2];
        offset += 3;
        const name = data.subarray(offset, offset + nameLength).toString('utf8');
        offset += nameLength;
        const length = data.readUInt32LE(offset);
        offset += 4;
        let content = data.subarray(offset, offset + length);
        assert.equal(content.length, length, `truncated RisuSave block ${name}`);
        offset += length;
        if (compressed) {
            content = zlib.gunzipSync(content);
        }
        if (type === 1) {
            Object.assign(database, JSON.parse(content.toString('utf8')));
        }
        else if (type === 2 || type === 7) {
            database.characters.push(JSON.parse(content.toString('utf8')));
        }
        else if (type === 3) {
            database.chats = JSON.parse(content.toString('utf8'));
        }
        else if (type === 4) {
            database.botPresets = JSON.parse(content.toString('utf8'));
        }
        else if (type === 5) {
            database.modules = JSON.parse(content.toString('utf8'));
        }
        else if (type === 9) {
            database.plugins = JSON.parse(content.toString('utf8'));
        }
        else if (type === 10) {
            database.loadouts = JSON.parse(content.toString('utf8'));
        }
        else if (type === 11) {
            database.pluginCustomStorage = JSON.parse(content.toString('utf8'));
        }
    }
    return database;
}

async function createIsolatedFixture(providerPort) {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'risu-browser-e2e-'));
    const resolvedTemporaryRoot = await fs.realpath(temporaryRoot);
    assert.ok(
        resolvedTemporaryRoot.startsWith(`${await fs.realpath(os.tmpdir())}${path.sep}`),
        'browser E2E fixture must live below the operating-system temp directory',
    );
    const savePath = path.join(temporaryRoot, 'save');
    await fs.mkdir(savePath, { recursive: true });
    await fs.writeFile(path.join(savePath, '__password'), PASSWORD_HASH, { mode: 0o600 });
    await fs.writeFile(
        path.join(savePath, DATABASE_FILE_NAME),
        encodeLegacySave(createSeedDatabase(providerPort)),
    );
    await fs.symlink(path.join(REPOSITORY_ROOT, 'dist'), path.join(temporaryRoot, 'dist'), 'dir');
    return { savePath };
}

function writeSse(response, content, finishReason = null) {
    response.write(`data: ${JSON.stringify({
        id: 'e2e-stream',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
    })}\n\n`);
}

async function startMockStreamingProvider() {
    const requests = [];
    const server = http.createServer(async (request, response) => {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
            response.writeHead(404).end();
            return;
        }
        const chunks = [];
        for await (const chunk of request) {
            chunks.push(chunk);
        }
        let body;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
            response.writeHead(400).end();
            return;
        }
        const userMessages = (body.messages ?? []).filter((message) => message.role === 'user');
        const lastUserContent = String(userMessages.at(-1)?.content ?? '');
        const record = {
            body,
            lastUserContent,
            aborted: false,
            completed: false,
        };
        requests.push(record);
        response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        });
        response.flushHeaders();
        response.once('close', () => {
            if (!record.completed) {
                record.aborted = true;
            }
        });

        if (lastUserContent.includes(CANCEL_INPUT)) {
            await sleep(250);
            if (!response.destroyed) {
                writeSse(response, CANCEL_PARTIAL);
            }
            const keepAlive = setInterval(() => {
                if (!response.destroyed) {
                    response.write(': e2e keep-alive\n\n');
                }
            }, 500);
            response.once('close', () => clearInterval(keepAlive));
            return;
        }

        await sleep(250);
        if (!response.destroyed) {
            writeSse(response, NORMAL_PARTIAL);
        }
        // Keep the command running long enough for the independent phone
        // follower's normal two-second observer loop to render progress.
        await sleep(5_000);
        if (!response.destroyed) {
            writeSse(response, ` ${NORMAL_PROVIDER_FINAL}`);
        }
        await sleep(750);
        if (!response.destroyed) {
            writeSse(response, '', 'stop');
            response.write('data: [DONE]\n\n');
            record.completed = true;
            response.end();
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        server,
        port: server.address().port,
        requests,
        async close() {
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

async function startRisuServer() {
    const port = await getUnusedPort();
    const output = [];
    const child = spawn(process.execPath, [SERVER_SCRIPT], {
        cwd: temporaryRoot,
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'test',
            RISU_RUNTIME_EXECUTOR_IP: '127.0.0.1',
            RISU_SAVE_MIN_FREE_BYTES: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    childProcesses.add(child);
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await eventually(async () => {
            if (child.exitCode !== null) {
                throw new Error(`Risu server exited early (${child.exitCode}):\n${output.join('')}`);
            }
            try {
                const response = await fetch(`${baseUrl}/runtime-generations`, {
                    headers: { 'risu-auth': PASSWORD_HASH },
                });
                return response.status === 200;
            }
            catch {
                return false;
            }
        }, { timeoutMs: 15_000 });
    }
    catch (error) {
        throw new Error(`${error.message}\nServer output:\n${output.join('')}`);
    }
    return { child, port, baseUrl, output };
}

function findChromium() {
    const candidates = [
        process.env.RISU_BROWSER_E2E_CHROMIUM,
        '/snap/bin/chromium',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
    ].filter(Boolean);
    return candidates.reduce(async (foundPromise, candidate) => {
        const found = await foundPromise;
        if (found) {
            return found;
        }
        try {
            await fs.access(candidate);
            return candidate;
        }
        catch {
            return null;
        }
    }, Promise.resolve(null));
}

class CdpConnection {
    constructor(webSocket, chromium) {
        this.webSocket = webSocket;
        this.chromium = chromium;
        this.nextId = 1;
        this.pending = new Map();
        this.sessionListeners = new Map();
        webSocket.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())));
        webSocket.on('close', () => {
            for (const { reject } of this.pending.values()) {
                reject(new Error('Chromium DevTools connection closed'));
            }
            this.pending.clear();
        });
    }

    onMessage(message) {
        if (message.id !== undefined) {
            const pending = this.pending.get(message.id);
            if (!pending) {
                return;
            }
            this.pending.delete(message.id);
            if (message.error) {
                pending.reject(new Error(`${pending.method}: ${message.error.message}`));
            }
            else {
                pending.resolve(message.result ?? {});
            }
            return;
        }
        if (message.sessionId) {
            for (const listener of this.sessionListeners.get(message.sessionId) ?? []) {
                listener(message.method, message.params ?? {});
            }
        }
    }

    send(method, params = {}, sessionId = undefined) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, method });
            this.webSocket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
    }

    async createPage({ width, height, mobile = false, name }) {
        const { browserContextId } = await this.send('Target.createBrowserContext');
        const { targetId } = await this.send('Target.createTarget', {
            url: 'about:blank',
            browserContextId,
        });
        const { sessionId } = await this.send('Target.attachToTarget', {
            targetId,
            flatten: true,
        });
        const page = new CdpPage(this, { browserContextId, targetId, sessionId, name });
        this.sessionListeners.set(sessionId, new Set([(method, params) => page.onEvent(method, params)]));
        await Promise.all([
            this.send('Page.enable', {}, sessionId),
            this.send('Runtime.enable', {}, sessionId),
            this.send('Network.enable', {}, sessionId),
            this.send('Log.enable', {}, sessionId),
        ]);
        await this.send('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: mobile ? 3 : 1,
            mobile,
        }, sessionId);
        if (mobile) {
            await this.send('Emulation.setTouchEmulationEnabled', {
                enabled: true,
                maxTouchPoints: 5,
            }, sessionId);
            await this.send('Network.setUserAgentOverride', {
                userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/138 Mobile Safari/537.36',
                platform: 'Android',
            }, sessionId);
        }
        await this.send('Page.addScriptToEvaluateOnNewDocument', {
            source: "try { localStorage.setItem('tos4', 'true'); } catch {}",
        }, sessionId);
        return page;
    }

    async close() {
        if (this.webSocket.readyState === WebSocket.OPEN) {
            this.webSocket.close();
            await once(this.webSocket, 'close').catch(() => {});
        }
        await stopChild(this.chromium);
    }
}

class CdpPage {
    constructor(connection, options) {
        this.connection = connection;
        Object.assign(this, options);
        this.diagnostics = [];
        this.closed = false;
    }

    onEvent(method, params) {
        if (method === 'Runtime.exceptionThrown') {
            this.diagnostics.push(`exception: ${params.exceptionDetails?.text ?? 'unknown'}`);
        }
        else if (method === 'Log.entryAdded' && params.entry?.level === 'error') {
            this.diagnostics.push(`log: ${params.entry.text}`);
        }
        else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
            this.diagnostics.push(`console: ${(params.args ?? []).map((value) => value.value ?? value.description).join(' ')}`);
        }
        if (this.diagnostics.length > 100) {
            this.diagnostics.shift();
        }
    }

    command(method, params = {}) {
        return this.connection.send(method, params, this.sessionId);
    }

    async evaluate(expression) {
        const result = await this.command('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
        });
        if (result.exceptionDetails) {
            throw new Error(
                result.exceptionDetails.exception?.description
                ?? result.exceptionDetails.text
                ?? 'Runtime.evaluate failed',
            );
        }
        return result.result?.value;
    }

    async navigate(url) {
        const result = await this.command('Page.navigate', { url });
        if (result.errorText) {
            throw new Error(`${this.name} navigation failed: ${result.errorText}`);
        }
    }

    async waitFor(expression, options = {}) {
        return eventually(async () => await this.evaluate(expression), options);
    }

    async setInput(selector, value) {
        const expression = `(() => {
            const element = document.querySelector(${JSON.stringify(selector)});
            if (!element) return false;
            const prototype = element instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)});
            element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return element.value === ${JSON.stringify(value)};
        })()`;
        assert.equal(await this.evaluate(expression), true, `${this.name} could not fill ${selector}`);
    }

    async clickSelector(selector) {
        const clicked = await this.evaluate(`(() => {
            const element = document.querySelector(${JSON.stringify(selector)});
            if (!element) return false;
            element.click();
            return true;
        })()`);
        assert.equal(clicked, true, `${this.name} could not click ${selector}`);
    }

    async clickButtonText(text) {
        const clicked = await this.evaluate(`(() => {
            const element = [...document.querySelectorAll('button')]
                .find((button) => button.textContent.trim() === ${JSON.stringify(text)});
            if (!element) return false;
            element.click();
            return true;
        })()`);
        assert.equal(clicked, true, `${this.name} could not click button ${text}`);
    }

    async bodyText() {
        return await this.evaluate('document.body?.innerText ?? ""');
    }

    async storageMetrics() {
        return await this.evaluate(`(async () => {
            const estimate = await navigator.storage.estimate();
            const databases = typeof indexedDB.databases === 'function'
                ? await indexedDB.databases()
                : [];
            const inspectDatabase = (databaseInfo) => new Promise((resolve) => {
                const request = indexedDB.open(databaseInfo.name);
                request.onerror = () => resolve({
                    name: databaseInfo.name,
                    version: databaseInfo.version ?? null,
                    error: request.error?.message ?? 'open failed',
                    stores: [],
                    recordCount: null,
                });
                request.onsuccess = () => {
                    const database = request.result;
                    const storeNames = [...database.objectStoreNames];
                    if (storeNames.length === 0) {
                        database.close();
                        resolve({
                            name: databaseInfo.name,
                            version: database.version,
                            stores: [],
                            recordCount: 0,
                        });
                        return;
                    }
                    const transaction = database.transaction(storeNames, 'readonly');
                    const stores = [];
                    for (const storeName of storeNames) {
                        const countRequest = transaction.objectStore(storeName).count();
                        countRequest.onsuccess = () => stores.push({
                            name: storeName,
                            recordCount: countRequest.result,
                        });
                        countRequest.onerror = () => stores.push({
                            name: storeName,
                            recordCount: null,
                            error: countRequest.error?.message ?? 'count failed',
                        });
                    }
                    transaction.oncomplete = () => {
                        database.close();
                        resolve({
                            name: databaseInfo.name,
                            version: database.version,
                            stores: stores.sort((left, right) => left.name.localeCompare(right.name)),
                            recordCount: stores.every((store) => Number.isSafeInteger(store.recordCount))
                                ? stores.reduce((total, store) => total + store.recordCount, 0)
                                : null,
                        });
                    };
                    transaction.onerror = () => {
                        database.close();
                        resolve({
                            name: databaseInfo.name,
                            version: database.version,
                            error: transaction.error?.message ?? 'transaction failed',
                            stores,
                            recordCount: null,
                        });
                    };
                };
            });
            const byteLength = (value) => new TextEncoder().encode(value).byteLength;
            const storageBytes = (storage) => {
                let bytes = 0;
                for (let index = 0; index < storage.length; index += 1) {
                    const key = storage.key(index) ?? '';
                    bytes += byteLength(key) + byteLength(storage.getItem(key) ?? '');
                }
                return bytes;
            };
            const indexedDatabases = (await Promise.all(databases
                .filter((database) => database.name)
                .map(inspectDatabase)))
                .sort((left, right) => left.name.localeCompare(right.name));
            const cacheNames = 'caches' in globalThis ? (await caches.keys()).sort() : [];
            const serviceWorkerScriptUrls = navigator.serviceWorker?.getRegistrations
                ? (await navigator.serviceWorker.getRegistrations())
                    .map((registration) => registration.active?.scriptURL
                        ?? registration.waiting?.scriptURL
                        ?? registration.installing?.scriptURL)
                    .filter(Boolean)
                    .sort()
                : [];
            return {
                usageBytes: estimate.usage ?? null,
                quotaBytes: estimate.quota ?? null,
                usageDetails: estimate.usageDetails ?? {},
                indexedDatabases,
                cacheNames,
                serviceWorkerScriptUrls,
                localStorageKeys: Object.keys(localStorage).sort(),
                localStorageBytes: storageBytes(localStorage),
                sessionStorageKeys: Object.keys(sessionStorage).sort(),
                sessionStorageBytes: storageBytes(sessionStorage),
            };
        })()`);
    }

    async closePage() {
        if (this.closed) {
            return;
        }
        const { success } = await this.connection.send('Target.closeTarget', { targetId: this.targetId });
        assert.equal(success, true, `${this.name} target did not close`);
        this.closed = true;
    }

    async disposeContext() {
        if (this.closed) {
            await this.connection.send('Target.disposeBrowserContext', {
                browserContextId: this.browserContextId,
            }).catch(() => {});
            return;
        }
        await this.connection.send('Target.disposeBrowserContext', {
            browserContextId: this.browserContextId,
        });
        this.closed = true;
    }
}

async function launchChromium() {
    const executable = await findChromium();
    if (!executable) {
        throw new Error('Chromium was not found. Set RISU_BROWSER_E2E_CHROMIUM to its executable path.');
    }
    const profilePath = path.join(temporaryRoot, 'chromium-profile');
    await fs.mkdir(profilePath, { recursive: true });
    const child = spawn(executable, [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
        '--remote-debugging-port=0',
        `--user-data-dir=${profilePath}`,
        'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    childProcesses.add(child);
    let stderr = '';
    const endpoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Chromium DevTools endpoint timed out:\n${stderr}`)), 15_000);
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
            const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Chromium exited early (${code}):\n${stderr}`));
        });
    });
    const webSocket = new WebSocket(endpoint);
    await once(webSocket, 'open');
    console.log(`[browser-e2e] Chromium: ${executable}`);
    return new CdpConnection(webSocket, child);
}

async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        childProcesses.delete(child);
        return;
    }
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    if (await Promise.race([exited.then(() => true), sleep(2_000).then(() => false)])) {
        childProcesses.delete(child);
        return;
    }
    child.kill('SIGKILL');
    await once(child, 'exit').catch(() => {});
    childProcesses.delete(child);
}

async function authenticateAndOpenCharacter(page, baseUrl) {
    await page.navigate(baseUrl);
    await page.waitFor(`document.querySelector('#alert-input') !== null`, { timeoutMs: 20_000 });
    await page.setInput('#alert-input', CLEAR_PASSWORD);
    await page.clickButtonText('OK');
    await page.waitFor(
        `document.querySelector('[data-char-id="${CHARACTER_ID}"]') !== null && document.querySelector('#alert-input') === null`,
        { timeoutMs: 20_000 },
    );
    await page.clickSelector(`[data-char-id="${CHARACTER_ID}"]`);
    await page.waitFor(`document.querySelector('textarea.text-input-area') !== null`, { timeoutMs: 10_000 });
}

async function waitForResident(server, residentPage) {
    await residentPage.navigate(`${server.baseUrl}/?risu-runtime=executor`);
    await eventually(async () => {
        const response = await fetch(`${server.baseUrl}/runtime-generations/executor/health`);
        if (!response.ok) {
            return false;
        }
        const body = await response.json();
        return body.ready === true;
    }, { timeoutMs: 30_000, intervalMs: 150 });
}

async function listCommands(baseUrl) {
    const response = await fetch(`${baseUrl}/runtime-generations`, {
        headers: { 'risu-auth': PASSWORD_HASH },
    });
    assert.equal(response.status, 200, 'runtime generation list must be authenticated');
    return (await response.json()).commands;
}

async function listDatabaseConflicts(baseUrl) {
    const response = await fetch(`${baseUrl}/api/sync/database/conflicts`, {
        headers: { 'risu-auth': PASSWORD_HASH },
    });
    assert.equal(response.status, 200, 'database conflict list must be authenticated');
    const body = await response.json();
    assert.ok(Array.isArray(body.conflicts), 'database conflict list must contain an array');
    return body.conflicts;
}

async function waitForNewCommand(baseUrl, knownCommandIds) {
    return eventually(async () => {
        const commands = await listCommands(baseUrl);
        return commands.find((command) => !knownCommandIds.has(command.commandId)) ?? false;
    }, { timeoutMs: 15_000 });
}

async function waitForTerminal(baseUrl, commandId) {
    return eventually(async () => {
        const response = await fetch(`${baseUrl}/runtime-generations/${encodeURIComponent(commandId)}`, {
            headers: { 'risu-auth': PASSWORD_HASH },
        });
        assert.equal(response.status, 200);
        const command = await response.json();
        return ['completed', 'failed', 'cancelled', 'interrupted'].includes(command.state)
            ? command
            : false;
    }, { timeoutMs: 30_000, intervalMs: 125 });
}

async function loadCanonicalDatabase(baseUrl) {
    const response = await fetch(`${baseUrl}/api/sync/database`, {
        headers: { 'risu-auth': PASSWORD_HASH },
    });
    assert.equal(response.status, 200);
    const revision = Number(response.headers.get('x-risu-revision'));
    assert.ok(Number.isSafeInteger(revision) && revision >= 0);
    const encoded = Buffer.from(await response.arrayBuffer());
    return {
        revision,
        encodedBytes: encoded.byteLength,
        database: decodeCanonicalDatabase(encoded),
    };
}

async function waitForStableCanonicalRevision(baseUrl, stableMs = 2_000) {
    let observedRevision = -1;
    let unchangedSince = 0;
    return eventually(async () => {
        const response = await fetch(`${baseUrl}/api/sync/database`, {
            headers: { 'risu-auth': PASSWORD_HASH },
        });
        assert.equal(response.status, 200);
        const revision = Number(response.headers.get('x-risu-revision'));
        assert.ok(Number.isSafeInteger(revision) && revision >= 0);
        if (revision !== observedRevision) {
            observedRevision = revision;
            unchangedSince = Date.now();
            return false;
        }
        return Date.now() - unchangedSince >= stableMs ? revision : false;
    }, { timeoutMs: 20_000, intervalMs: 150 });
}

function getFixtureMessages(database) {
    const character = database.characters.find((candidate) => candidate.chaId === CHARACTER_ID);
    assert.ok(character, 'canonical DB must retain the E2E character');
    const chat = character.chats.find((candidate) => candidate.id === CHAT_ID);
    assert.ok(chat, 'canonical DB must retain the E2E chat');
    return chat.message;
}

function assertDisplayTriggerStayedImmutable(database, label) {
    const character = database.characters.find((candidate) => candidate.chaId === CHARACTER_ID);
    assert.ok(character, `${label} must retain the E2E character`);
    const sentinel = character.triggerscript.find(
        (trigger) => trigger.comment === 'Display immutability regression sentinel',
    );
    assert.ok(sentinel, `${label} must retain the display immutability sentinel`);
    assert.equal(
        Object.prototype.hasOwnProperty.call(sentinel, 'lowLevelAccess'),
        false,
        `${label} rendering must not normalize lowLevelAccess into the canonical database`,
    );
}

function assertDirectClientStorage(metrics, label) {
    assert.deepEqual(
        metrics.cacheNames.filter((name) => name === 'risuCache'),
        [],
        `${label} must not retain the Risu service-worker cache`,
    );
    assert.deepEqual(
        metrics.serviceWorkerScriptUrls.filter((url) => new URL(url).pathname.endsWith('/sw.js')),
        [],
        `${label} must not run the Risu service worker in Node self-host mode`,
    );
    assert.deepEqual(
        metrics.localStorageKeys.filter((key) => [
            'database/database.bin',
            'risuCache',
            'risuSave',
        ].includes(key)),
        [],
        `${label} must not put canonical save data in localStorage`,
    );

    const indexedByName = new Map(metrics.indexedDatabases
        .map((database) => [database.name, database]));
    assert.equal(indexedByName.has('risuai'), false, `${label} must not create the canonical browser DB`);
    const mcpDatabases = metrics.indexedDatabases
        .filter((database) => /mcp|google-search-credentials/i.test(database.name));
    assert.deepEqual(mcpDatabases, [], `${label} must not create browser-side MCP databases`);

    // These localforage instances are constructed by imported compatibility
    // modules, so Chromium may retain an empty database shell. In Node mode
    // all content must remain server-side: zero records is the meaningful
    // invariant and prevents a second copy of the save/inlays/LLM cache.
    for (const databaseName of ['risuSaveCache', 'LLMTranslateCache', 'inlay']) {
        const database = indexedByName.get(databaseName);
        if (database) {
            assert.equal(
                database.recordCount,
                0,
                `${label} ${databaseName} browser DB must contain zero records`,
            );
        }
    }
}

async function runScenario() {
    await buildApplication();
    mockProvider = await startMockStreamingProvider();
    const fixture = await createIsolatedFixture(mockProvider.port);
    assert.equal(path.dirname(path.join(fixture.savePath, DATABASE_FILE_NAME)), fixture.savePath);
    const server = await startRisuServer();
    cdp = await launchChromium();

    const resident = await cdp.createPage({ width: 1280, height: 900, name: 'resident' });
    const desktop = await cdp.createPage({ width: 1280, height: 900, name: 'desktop A' });
    const phone = await cdp.createPage({ width: 390, height: 844, mobile: true, name: 'phone B' });

    try {
        await waitForResident(server, resident);
        await Promise.all([
            authenticateAndOpenCharacter(desktop, server.baseUrl),
            authenticateAndOpenCharacter(phone, server.baseUrl),
        ]);
        assert.equal(await resident.evaluate("new URL(location.href).searchParams.get('risu-runtime')"), 'executor');
        assert.equal(await desktop.evaluate('location.search'), '', 'desktop A must remain a follower');
        assert.equal(await phone.evaluate('location.search'), '', 'phone B must remain a follower');
        assert.equal(await desktop.evaluate('window.innerWidth'), 1280);
        assert.equal(await phone.evaluate('window.innerWidth'), 390);
        assert.match(await phone.evaluate('navigator.userAgent'), /Mobile/);
        assert.notEqual(
            desktop.browserContextId,
            phone.browserContextId,
            'desktop and phone must use separate browser storage partitions',
        );

        // Opening a character updates last-interaction metadata. Let both
        // follower writes settle before measuring generation behavior so a
        // fixture-only CAS race cannot masquerade as a hand-off failure.
        const settledRevision = await waitForStableCanonicalRevision(server.baseUrl);
        const settledSnapshot = await loadCanonicalDatabase(server.baseUrl);
        assertDisplayTriggerStayedImmutable(settledSnapshot.database, 'initial follower render');
        const initialConflictIds = new Set(
            (await listDatabaseConflicts(server.baseUrl)).map((conflict) => conflict.conflictId),
        );
        const desktopStorageBeforeClose = await desktop.storageMetrics();
        assert.ok(desktopStorageBeforeClose.usageBytes === null
            || Number.isSafeInteger(desktopStorageBeforeClose.usageBytes));
        assertDirectClientStorage(desktopStorageBeforeClose, 'desktop A');

        const initialCommands = await listCommands(server.baseUrl);
        const initialIds = new Set(initialCommands.map((command) => command.commandId));
        await desktop.setInput('textarea.text-input-area', NORMAL_INPUT);
        await desktop.clickSelector('.button-icon-send');

        await eventually(() => mockProvider.requests.length === 1, { timeoutMs: 15_000 });
        assert.match(mockProvider.requests[0].lastUserContent, new RegExp(NORMAL_INPUT));
        const completedCommandPromise = waitForNewCommand(server.baseUrl, initialIds);

        // This is the core hand-off: the initiating desktop page is actually
        // closed while the server-resident provider stream is still running.
        await desktop.closePage();
        const completedCommand = await completedCommandPromise;
        await phone.waitFor(`document.querySelector('button[aria-labelledby="cancel"]') !== null`, {
            timeoutMs: 20_000,
        });
        assert.equal(
            mockProvider.requests[0].completed,
            false,
            'phone B must observe the original running UI before the provider completes',
        );
        const phoneObservedPartialBeforeCompletion = await phone.evaluate(
            `(document.body?.innerText ?? '').includes(${JSON.stringify(NORMAL_PARTIAL)})`,
        );

        const completedTerminal = await waitForTerminal(server.baseUrl, completedCommand.commandId);
        assert.equal(completedTerminal.state, 'completed', completedTerminal.error ?? 'generation failed');
        await phone.waitFor(`(document.body?.innerText ?? '').includes(${JSON.stringify(NORMAL_FINAL)})`, {
            timeoutMs: 15_000,
        });
        assert.equal(mockProvider.requests.length, 1, 'desktop hand-off must not duplicate the upstream generation');
        assert.equal(mockProvider.requests[0].completed, true);

        const afterCompletion = await loadCanonicalDatabase(server.baseUrl);
        const completedMessages = getFixtureMessages(afterCompletion.database);
        assert.equal(completedMessages.filter((message) => message.role === 'user' && message.data === NORMAL_INPUT).length, 1);
        assert.equal(completedMessages.filter((message) => (
            message.role === 'char'
            && message.data === NORMAL_FINAL
        )).length, 1, 'canonical DB must contain exactly one completed assistant response');
        assert.equal(
            completedMessages.some((message) => message.role === 'char'
                && (message.data.includes(LUA_SUFFIX) || message.data.includes(V21_SUFFIX))),
            false,
            'module regex must consume the Lua and V2.1 compatibility markers',
        );
        const completedAssistant = completedMessages.find((message) => message.role === 'char');
        assert.ok(completedAssistant?.generationInfo?.generationId, 'canonical assistant must retain its generation ID');

        const beforeCancelIds = new Set((await listCommands(server.baseUrl)).map((command) => command.commandId));
        await phone.setInput('textarea.text-input-area', CANCEL_INPUT);
        await phone.clickSelector('.button-icon-send');
        await phone.waitFor(
            `document.querySelector('.runtime-chat-presentation') !== null`,
            { timeoutMs: 2_000, intervalMs: 25 },
        );
        await eventually(() => mockProvider.requests.length === 2, { timeoutMs: 15_000 });
        assert.match(mockProvider.requests[1].lastUserContent, new RegExp(CANCEL_INPUT));
        const cancelCommand = await waitForNewCommand(server.baseUrl, beforeCancelIds);
        await phone.waitFor(`(document.body?.innerText ?? '').includes(${JSON.stringify(CANCEL_PARTIAL)})`, {
            timeoutMs: 15_000,
        });
        await phone.waitFor(`document.querySelector('button[aria-labelledby="cancel"]') !== null`, {
            timeoutMs: 10_000,
        });
        await phone.clickSelector('button[aria-labelledby="cancel"]');

        const cancelledTerminal = await waitForTerminal(server.baseUrl, cancelCommand.commandId);
        assert.equal(cancelledTerminal.state, 'cancelled');
        await eventually(() => mockProvider.requests[1].aborted, { timeoutMs: 10_000 });
        await phone.waitFor(`document.querySelector('.button-icon-send') !== null
            && document.querySelector('button[aria-labelledby="cancel"]') === null
            && document.querySelector('.runtime-chat-presentation') === null`, {
            timeoutMs: 15_000,
        });

        const finalSnapshot = await loadCanonicalDatabase(server.baseUrl);
        assertDisplayTriggerStayedImmutable(finalSnapshot.database, 'completed/cancelled chat render');
        const finalMessages = getFixtureMessages(finalSnapshot.database);
        assert.equal(
            finalMessages.some((message) => (
                Object.prototype.hasOwnProperty.call(message, '__risuRuntimeOptimisticId')
            )),
            false,
            'presentation-only messages must never enter the canonical database',
        );
        assert.equal(finalMessages.filter((message) => message.role === 'user' && message.data === NORMAL_INPUT).length, 1);
        assert.equal(finalMessages.filter((message) => message.role === 'user' && message.data === CANCEL_INPUT).length, 1);
        assert.ok(
            finalMessages.filter((message) => message.role === 'char' && message.data.includes(CANCEL_PARTIAL)).length <= 1,
            'Stop must not duplicate a partially generated assistant message',
        );
        const generationIds = finalMessages
            .filter((message) => message.role === 'char')
            .map((message) => message.generationInfo?.generationId)
            .filter(Boolean);
        assert.equal(new Set(generationIds).size, generationIds.length, 'canonical generation IDs must be unique');
        assert.equal(mockProvider.requests.length, 2, 'each user send must reach the mock provider exactly once');
        const finalConflicts = await listDatabaseConflicts(server.baseUrl);
        assert.deepEqual(
            finalConflicts.filter((conflict) => !initialConflictIds.has(conflict.conflictId)),
            [],
            'presentation rendering must not produce a stale canonical database save',
        );

        const allCommands = await listCommands(server.baseUrl);
        const scenarioCommands = allCommands.filter((command) => !initialIds.has(command.commandId));
        assert.equal(scenarioCommands.length, 2);
        assert.deepEqual(
            scenarioCommands.map((command) => command.state).sort(),
            ['cancelled', 'completed'],
        );
        assert.equal(
            scenarioCommands.filter((command) => command.state === 'queued' || command.state === 'running').length,
            0,
        );
        const phoneStorageFinal = await phone.storageMetrics();
        assert.ok(phoneStorageFinal.usageBytes === null || Number.isSafeInteger(phoneStorageFinal.usageBytes));
        assertDirectClientStorage(phoneStorageFinal, 'phone B');
        for (const [label, metrics] of [
            ['desktop A', desktopStorageBeforeClose],
            ['phone B', phoneStorageFinal],
        ]) {
            if (metrics.usageBytes !== null) {
                assert.ok(
                    metrics.usageBytes < finalSnapshot.encodedBytes,
                    `${label} browser storage must remain smaller than the canonical database`,
                );
            }
        }

        console.log('[browser-e2e] PASS');
        console.log(JSON.stringify({
            isolatedRoot: temporaryRoot,
            settledRevisionBeforeSend: settledRevision,
            desktopClosedDuringStream: true,
            phoneObservedRunningBeforeCompletion: true,
            phoneObservedPartialBeforeCompletion,
            compatibilityPipeline: ['module-lua', 'plugin-v2.1', 'module-regex'],
            compatibilityFinalMarker: NORMAL_FINAL,
            canonicalRevision: finalSnapshot.revision,
            canonicalDatabaseBytes: finalSnapshot.encodedBytes,
            canonicalMessageCount: finalMessages.length,
            providerRequests: mockProvider.requests.length,
            commandStates: scenarioCommands.map((command) => command.state).sort(),
            stopAbortedProvider: mockProvider.requests[1].aborted,
            directClientStorage: {
                desktopBeforeClose: desktopStorageBeforeClose,
                phoneFinal: phoneStorageFinal,
                comparedWithCanonical: {
                    canonicalBytes: finalSnapshot.encodedBytes,
                    desktopUsageRatio: desktopStorageBeforeClose.usageBytes === null
                        ? null
                        : desktopStorageBeforeClose.usageBytes / finalSnapshot.encodedBytes,
                    phoneUsageRatio: phoneStorageFinal.usageBytes === null
                        ? null
                        : phoneStorageFinal.usageBytes / finalSnapshot.encodedBytes,
                },
            },
        }, null, 2));
    }
    catch (error) {
        const diagnostics = [resident, desktop, phone]
            .flatMap((page) => page.diagnostics.map((line) => `[${page.name}] ${line}`));
        throw new Error([
            error.stack ?? String(error),
            diagnostics.length ? `Browser diagnostics:\n${diagnostics.join('\n')}` : '',
            server.output.length ? `Server output:\n${server.output.join('')}` : '',
        ].filter(Boolean).join('\n\n'));
    }
    finally {
        await Promise.all([
            resident.disposeContext().catch(() => {}),
            desktop.disposeContext().catch(() => {}),
            phone.disposeContext().catch(() => {}),
        ]);
        await stopChild(server.child);
    }
}

async function cleanup() {
    if (cdp) {
        await cdp.close().catch(() => {});
        cdp = null;
    }
    if (mockProvider) {
        await mockProvider.close().catch(() => {});
        mockProvider = null;
    }
    await Promise.all([...childProcesses].map(stopChild));
    if (temporaryRoot && process.env.RISU_BROWSER_E2E_KEEP !== '1') {
        const resolved = path.resolve(temporaryRoot);
        const tempPrefix = `${path.resolve(os.tmpdir())}${path.sep}risu-browser-e2e-`;
        assert.ok(resolved.startsWith(tempPrefix), `refusing to remove non-E2E path: ${resolved}`);
        await fs.rm(resolved, { recursive: true, force: true });
    }
}

(async () => {
    try {
        await runScenario();
    }
    finally {
        await cleanup();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
