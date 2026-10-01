'use strict';

/**
 * Real Chromium acceptance coverage for cold resident startup prompts.
 *
 * This executable intentionally owns a temporary Node cwd, save directory,
 * Chromium profile, and browser contexts. It never reads a running RisuAI
 * installation. The scenarios are split because arbitrary V2.1 prompts are
 * profile-local, while V3 permission decisions are server-shared:
 *
 *   A. already-loaded public observers answer a resident-only V2.1 awaited
 *      prompt while the resident remains alive but has made zero claim calls;
 *   B. resident, PC, and phone cold-load the same V3 plugin and join one
 *      server-side permission decision.
 *
 * Run:
 *   node server/node/runtimeStartup/browserE2E.cjs
 *
 * Set RISU_STARTUP_BROWSER_E2E_SKIP_BUILD=1 to reuse dist.
 * Set RISU_BROWSER_E2E_CHROMIUM=/path/to/chromium to override detection.
 * Set RISU_STARTUP_BROWSER_E2E_SCENARIO=v21 or v3 to run one scenario.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { Unpackr } = require('msgpackr');
const { encodeFixtureSave } = require('../runtimeGenerations/fixtureSave.cjs');
const WebSocket = require('ws');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_SCRIPT = path.join(REPOSITORY_ROOT, 'server', 'node', 'server.cjs');
const DATABASE_STORAGE_KEY = 'database/database.bin';
const DATABASE_FILE_NAME = Buffer.from(DATABASE_STORAGE_KEY, 'utf8').toString('hex');
const LEGACY_SAVE_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);
const BLOCK_SAVE_HEADER = Buffer.from('RISUSAVE\0', 'utf8');
const CLEAR_PASSWORD = 'risu-startup-browser-e2e-password';
const PASSWORD_HASH = crypto.createHash('sha256').update(CLEAR_PASSWORD).digest('hex');
const V21_PLUGIN_NAME = 'E2E cold awaited V2.1 plugin';
const V21_PROMPT_TEXT = 'E2E resident V2.1 startup provider secret';
const V21_REGISTERED_MARKER = 'E2E_COLD_V21_REGISTERED';
const V21_SECRET = 'e2e-v21-secret-must-not-leak-7f6e11';
const V3_PLUGIN_NAME = 'E2E shared cold V3 permission plugin';
const STARTUP_PERMISSION_DIR = '__runtime_plugin_permissions';
const STARTUP_PERMISSION_FILE = 'grants.json';
const DEFAULT_TIMEOUT_MS = 30_000;
// WSL commonly points os.tmpdir() at DrvFS, where POSIX chmod bits report as
// 0777. Use the real Linux temp filesystem so the 0700/0600 contract is tested.
const TEMPORARY_BASE = process.platform === 'linux' ? '/tmp' : os.tmpdir();
const V21_LIVENESS_WAIT_MS = Number(
    process.env.RISU_STARTUP_BROWSER_E2E_LIVENESS_MS ?? 31_000,
);

const childProcesses = new Set();

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
    if (process.env.RISU_STARTUP_BROWSER_E2E_SKIP_BUILD === '1') {
        await fs.access(path.join(REPOSITORY_ROOT, 'dist', 'index.html'));
        return;
    }
    console.log('[startup-browser-e2e] Building the real UI...');
    await run('pnpm', ['exec', 'vite', 'build', '--sourcemap'], {
        env: { VITE_RISU_LEGAL_CONFIGURED: 'TRUE' },
    });
}

function createBaseDatabase(plugins = []) {
    return {
        didFirstSetup: true,
        formatversion: 5,
        language: 'en',
        characters: [],
        characterOrder: [],
        plugins,
        pluginV2: [],
        pluginCustomStorage: {},
        modules: [],
        enabledModules: [],
        loadouts: [],
        personas: [],
        selectedPersona: 0,
        betaMobileGUI: true,
        hideRealm: true,
        heightMode: 'dvh',
        playMessage: false,
        notification: false,
        useSayNothing: true,
        enableRemoteSaving: false,
        coldstorage: false,
    };
}

function createV21Plugin() {
    return {
        name: V21_PLUGIN_NAME,
        version: '2.1',
        enabled: true,
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
        script: `
            const startupSecret = await globalThis.prompt(
                ${JSON.stringify(V21_PROMPT_TEXT)},
                'fixture-default'
            );
            addRisuScriptHandler('input', async (value) => value + '::COLD_V21');
            await nativeFetch('/logo_32.png?e2e-v21-registered=1', {
                method: 'GET',
                logFetch: false
            });
            globalThis.console.log(${JSON.stringify(V21_REGISTERED_MARKER)});
            void startupSecret;
        `,
    };
}

function createV3Plugin() {
    return {
        name: V3_PLUGIN_NAME,
        version: '3.0',
        enabled: true,
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
        script: `
            const allowed = await Risuai.requestPluginPermission('db');
            if (!allowed) throw new Error('E2E shared V3 permission was denied');
            await Risuai.nativeFetch('/logo_32.png?e2e-v3-registered=1', {
                method: 'GET',
                logFetch: false
            });
        `,
    };
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
        offset += 3 + nameLength;
        const length = data.readUInt32LE(offset);
        offset += 4;
        let content = data.subarray(offset, offset + length);
        assert.equal(content.length, length, `truncated RisuSave block type ${type}`);
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

async function createIsolatedRoot(label, database) {
    const temporaryRoot = await fs.mkdtemp(path.join(TEMPORARY_BASE, `risu-startup-${label}-`));
    const resolvedTemporaryRoot = await fs.realpath(temporaryRoot);
    assert.ok(
        resolvedTemporaryRoot.startsWith(`${await fs.realpath(TEMPORARY_BASE)}${path.sep}`),
        'browser E2E fixture must live below the operating-system temp directory',
    );
    const savePath = path.join(temporaryRoot, 'save');
    await fs.mkdir(savePath, { recursive: true });
    await fs.writeFile(path.join(savePath, '__password'), PASSWORD_HASH, { mode: 0o600 });
    await fs.writeFile(
        path.join(savePath, DATABASE_FILE_NAME),
        encodeFixtureSave(database),
    );
    await fs.symlink(path.join(REPOSITORY_ROOT, 'dist'), path.join(temporaryRoot, 'dist'), 'dir');
    return { temporaryRoot, savePath };
}

async function startRisuServer(temporaryRoot) {
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
                return (await fetch(`${baseUrl}/logo_32.png`)).ok;
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

async function authenticatedJson(baseUrl, pathname, init = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers: {
            'risu-auth': PASSWORD_HASH,
            ...(init.headers ?? {}),
        },
    });
    const text = await response.text();
    let body = null;
    if (text) {
        body = JSON.parse(text);
    }
    return { response, body, text };
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
        etag: response.headers.get('etag'),
        database: decodeCanonicalDatabase(encoded),
    };
}

async function waitForStableCanonicalRevision(baseUrl, stableMs = 1_500) {
    let observedRevision = -1;
    let unchangedSince = 0;
    return eventually(async () => {
        const snapshot = await loadCanonicalDatabase(baseUrl);
        if (snapshot.revision !== observedRevision) {
            observedRevision = snapshot.revision;
            unchangedSince = Date.now();
            return false;
        }
        return Date.now() - unchangedSince >= stableMs ? snapshot : false;
    }, { timeoutMs: 20_000, intervalMs: 150 });
}

async function replaceCanonicalPlugins(baseUrl, plugins) {
    const snapshot = await waitForStableCanonicalRevision(baseUrl);
    const database = structuredClone(snapshot.database);
    database.plugins = plugins;
    const response = await fetch(`${baseUrl}/api/sync/database`, {
        method: 'PUT',
        body: encodeFixtureSave(database),
        headers: {
            'content-type': 'application/octet-stream',
            'risu-auth': PASSWORD_HASH,
            'if-match': snapshot.etag,
            'x-risu-base-revision': String(snapshot.revision),
            'x-risu-client-id': 'startup-browser-e2e-fixture',
            'x-risu-commit-kind': 'stable',
            'idempotency-key': crypto.randomUUID(),
        },
    });
    const responseText = await response.text();
    assert.equal(
        response.status,
        200,
        `fixture plugin CAS failed (${response.status}): ${responseText}`,
    );
    return JSON.parse(responseText);
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
        if (found) return found;
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
            if (!pending) return;
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
            this.webSocket.send(JSON.stringify({
                id,
                method,
                params,
                ...(sessionId ? { sessionId } : {}),
            }));
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
        const page = new CdpPage(this, {
            browserContextId,
            targetId,
            sessionId,
            name,
        });
        this.sessionListeners.set(sessionId, new Set([
            (method, params) => page.onEvent(method, params),
        ]));
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
        this.consoleMessages = [];
        this.startupSocketFrames = [];
        this.startupHttpEvents = [];
        this.closed = false;
    }

    onEvent(method, params) {
        if (method === 'Runtime.exceptionThrown') {
            this.diagnostics.push(`exception: ${
                params.exceptionDetails?.exception?.description
                ?? params.exceptionDetails?.text
                ?? 'unknown'
            }`);
        }
        else if (method === 'Log.entryAdded') {
            const text = String(params.entry?.text ?? '');
            if (text) this.consoleMessages.push(text);
            if (params.entry?.level === 'error') this.diagnostics.push(`log: ${text}`);
        }
        else if (method === 'Runtime.consoleAPICalled') {
            const text = (params.args ?? [])
                .map((value) => value.value ?? value.description ?? '')
                .join(' ');
            if (text) this.consoleMessages.push(text);
            if (params.type === 'error') this.diagnostics.push(`console: ${text}`);
        }
        else if (method === 'Network.webSocketFrameReceived') {
            const raw = String(params.response?.payloadData ?? '');
            try {
                const message = JSON.parse(raw);
                if (typeof message?.type === 'string' && message.type.startsWith('runtime_startup_')) {
                    this.startupSocketFrames.push({ raw, message });
                }
            }
            catch {
                // Other application sockets may carry non-JSON frames.
            }
        }
        else if (method === 'Network.requestWillBeSent') {
            try {
                const url = new URL(params.request?.url ?? '');
                if (url.pathname.startsWith('/runtime-startup')
                    || url.pathname.startsWith('/runtime-plugin-permissions')
                    || url.searchParams.has('e2e-v21-registered')
                    || url.searchParams.has('e2e-v3-registered')) {
                    this.startupHttpEvents.push({
                        kind: 'request',
                        requestId: params.requestId,
                        method: params.request?.method,
                        pathname: url.pathname,
                    });
                }
            }
            catch {}
        }
        else if (method === 'Network.responseReceived') {
            try {
                const url = new URL(params.response?.url ?? '');
                if (url.pathname.startsWith('/runtime-startup')
                    || url.pathname.startsWith('/runtime-plugin-permissions')
                    || url.searchParams.has('e2e-v21-registered')
                    || url.searchParams.has('e2e-v3-registered')) {
                    this.startupHttpEvents.push({
                        kind: 'response',
                        requestId: params.requestId,
                        status: params.response?.status,
                        pathname: url.pathname,
                    });
                }
            }
            catch {}
        }
        if (this.diagnostics.length > 200) this.diagnostics.shift();
        if (this.consoleMessages.length > 500) this.consoleMessages.shift();
        if (this.startupSocketFrames.length > 500) this.startupSocketFrames.shift();
        if (this.startupHttpEvents.length > 500) this.startupHttpEvents.shift();
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

    async blockUrls(patterns) {
        await this.command('Network.setBlockedURLs', { urls: patterns });
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
            Object.getOwnPropertyDescriptor(prototype, 'value').set.call(
                element,
                ${JSON.stringify(value)}
            );
            element.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                inputType: 'insertText',
                data: ${JSON.stringify(value)},
            }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return element.value === ${JSON.stringify(value)};
        })()`;
        assert.equal(await this.evaluate(expression), true, `${this.name} could not fill ${selector}`);
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

    async clickAlertButton(text) {
        const clicked = await this.evaluate(`(() => {
            const input = document.querySelector('#alert-input');
            const dialog = input?.closest('div.bg-darkbg')
                ?? [...document.querySelectorAll('div.bg-darkbg')].find((element) => (
                    element.querySelector('h2') !== null
                ));
            const button = [...(dialog?.querySelectorAll('button') ?? [])]
                .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)});
            if (!button) return false;
            button.click();
            return true;
        })()`);
        assert.equal(clicked, true, `${this.name} could not click alert button ${text}`);
    }

    async setInputPhysical(selector, value) {
        const selected = await this.evaluate(`(() => {
            const input = document.querySelector(${JSON.stringify(selector)});
            if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
                return false;
            }
            input.focus();
            input.select();
            return true;
        })()`);
        assert.equal(selected, true, `${this.name} could not focus ${selector}`);
        await this.command('Input.insertText', { text: value });
        await this.waitFor(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`, {
            timeoutMs: 2_000,
        });
    }

    async clickAlertButtonPhysical(text) {
        const point = await this.evaluate(`(() => {
            const input = document.querySelector('#alert-input');
            const dialog = input?.closest('div.bg-darkbg')
                ?? [...document.querySelectorAll('div.bg-darkbg')].find((element) => (
                    element.querySelector('h2') !== null
                ));
            const button = [...(dialog?.querySelectorAll('button') ?? [])]
                .find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)});
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`);
        assert.ok(point, `${this.name} could not locate alert button ${text}`);
        await this.command('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: point.x,
            y: point.y,
            button: 'left',
            clickCount: 1,
        });
        await this.command('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: point.x,
            y: point.y,
            button: 'left',
            clickCount: 1,
        });
    }

    async submitAlertInput(value) {
        const submitted = await this.evaluate(`(() => {
            const input = document.querySelector('#alert-input');
            if (!(input instanceof HTMLInputElement)) return false;
            const dialog = input.closest('div.bg-darkbg');
            const button = [...(dialog?.querySelectorAll('button') ?? [])]
                .find((candidate) => candidate.textContent.trim() === 'OK');
            if (!button) return false;
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
                input,
                ${JSON.stringify(value)}
            );
            input.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                inputType: 'insertText',
                data: ${JSON.stringify(value)},
            }));
            button.click();
            return true;
        })()`);
        assert.equal(submitted, true, `${this.name} could not submit alert input`);
    }

    async disposeContext() {
        if (this.closed) return;
        await this.connection.send('Target.disposeBrowserContext', {
            browserContextId: this.browserContextId,
        }).catch(() => {});
        this.closed = true;
    }
}

async function launchChromium(temporaryRoot) {
    const executable = await findChromium();
    if (!executable) {
        throw new Error('Chromium was not found. Set RISU_BROWSER_E2E_CHROMIUM.');
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
        const timer = setTimeout(() => reject(
            new Error(`Chromium DevTools endpoint timed out:\n${stderr}`),
        ), 15_000);
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
    console.log(`[startup-browser-e2e] Chromium: ${executable}`);
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

async function authenticateViewer(page, baseUrl) {
    await page.navigate(baseUrl);
    await page.waitFor(`document.querySelector('#alert-input') !== null`, {
        timeoutMs: 20_000,
    });
    await page.setInput('#alert-input', CLEAR_PASSWORD);
    await page.clickAlertButton('OK');
    await page.waitFor(`document.querySelector('#alert-input') === null`, {
        timeoutMs: 20_000,
    });
    await eventually(
        () => page.startupSocketFrames.some(
            ({ message }) => message.type === 'runtime_startup_snapshot',
        ),
        { timeoutMs: 20_000 },
    );
}

function startupPromptsObserved(page, predicate = () => true) {
    const byId = new Map();
    for (const { message } of page.startupSocketFrames) {
        if (message.type === 'runtime_startup_snapshot') {
            for (const prompt of message.prompts ?? []) {
                if (predicate(prompt)) byId.set(prompt.promptId, prompt);
            }
        }
        else if (message.type === 'runtime_startup_event'
            && message.eventType === 'prompt_created'
            && message.prompt
            && predicate(message.prompt)) {
            byId.set(message.prompt.promptId, message.prompt);
        }
    }
    return [...byId.values()];
}

function settledPromptIds(page) {
    return new Set(page.startupSocketFrames
        .map(({ message }) => message)
        .filter((message) => (
            message.type === 'runtime_startup_event'
            && message.eventType === 'prompt_settled'
            && typeof message.promptId === 'string'
        ))
        .map((message) => message.promptId));
}

async function waitForStartupPromptUi(page, text) {
    await page.waitFor(`(() => {
        const body = document.body?.innerText ?? '';
        return body.includes(${JSON.stringify(text)})
            && document.querySelectorAll('#alert-input').length === 1;
    })()`, { timeoutMs: 30_000 });
}

async function waitForStartupConfirmUi(page, text) {
    await page.waitFor(`(() => {
        const body = document.body?.innerText ?? '';
        const labels = [...document.querySelectorAll('button')]
            .map((button) => button.textContent.trim());
        return body.includes(${JSON.stringify(text)})
            && labels.includes('YES')
            && labels.includes('NO');
    })()`, { timeoutMs: 30_000 });
}

async function strictExecutorHealth(baseUrl) {
    const response = await fetch(`${baseUrl}/runtime-generations/executor/health`);
    return { status: response.status, body: await response.json() };
}

async function startupLiveness(baseUrl) {
    const response = await fetch(`${baseUrl}/runtime-startup/liveness`);
    return { status: response.status, body: await response.json() };
}

async function waitForClaimReady(baseUrl) {
    return eventually(async () => {
        const health = await strictExecutorHealth(baseUrl);
        return health.status === 200 && health.body.ready === true ? health : false;
    }, { timeoutMs: 30_000, intervalMs: 125 });
}

async function assertNoDatabaseConflicts(baseUrl) {
    const { response, body } = await authenticatedJson(
        baseUrl,
        '/api/sync/database/conflicts',
    );
    assert.equal(response.status, 200);
    assert.deepEqual(body.conflicts, []);
}

async function removeTemporaryRoot(temporaryRoot) {
    if (!temporaryRoot || process.env.RISU_STARTUP_BROWSER_E2E_KEEP === '1') return;
    const resolved = path.resolve(temporaryRoot);
    const prefix = `${path.resolve(TEMPORARY_BASE)}${path.sep}risu-startup-`;
    assert.ok(resolved.startsWith(prefix), `refusing to remove non-E2E path: ${resolved}`);
    await fs.rm(resolved, { recursive: true, force: true });
}

async function cleanupScenario({ cdp, pages, server, temporaryRoot }) {
    await Promise.all((pages ?? []).map((page) => page.disposeContext().catch(() => {})));
    if (cdp) await cdp.close().catch(() => {});
    if (server) await stopChild(server.child);
    await removeTemporaryRoot(temporaryRoot);
}

async function runV21StartupRelayScenario() {
    const root = await createIsolatedRoot('v21', createBaseDatabase());
    let server = null;
    let cdp = null;
    const pages = [];
    try {
        server = await startRisuServer(root.temporaryRoot);
        cdp = await launchChromium(root.temporaryRoot);
        const pc = await cdp.createPage({ width: 1100, height: 800, name: 'V2.1 public PC' });
        const phone = await cdp.createPage({
            width: 390,
            height: 844,
            mobile: true,
            name: 'V2.1 public phone',
        });
        pages.push(pc, phone);
        await Promise.all([
            authenticateViewer(pc, server.baseUrl),
            authenticateViewer(phone, server.baseUrl),
        ]);
        // Scenario A covers a resident-only arbitrary V2.1 prompt. Freeze the
        // already-loaded public database before injecting the resident plugin;
        // otherwise the normal canonical DB follower also loads that plugin
        // locally and presents an indistinguishable profile-local prompt first.
        await Promise.all([
            pc.blockUrls(['*://*/api/sync/database*']),
            phone.blockUrls(['*://*/api/sync/database*']),
        ]);
        await replaceCanonicalPlugins(server.baseUrl, [createV21Plugin()]);

        const resident = await cdp.createPage({
            width: 1280,
            height: 900,
            name: 'V2.1 cold resident',
        });
        pages.push(resident);
        await resident.navigate(`${server.baseUrl}/?risu-runtime=executor`);

        await Promise.all([
            waitForStartupPromptUi(pc, V21_PROMPT_TEXT),
            waitForStartupPromptUi(phone, V21_PROMPT_TEXT),
        ]);
        const predicate = (prompt) => prompt.prompt?.msg === V21_PROMPT_TEXT;
        const [pcPrompts, phonePrompts] = await eventually(() => {
            const left = startupPromptsObserved(pc, predicate);
            const right = startupPromptsObserved(phone, predicate);
            return left.length === 1 && right.length === 1 ? [left, right] : false;
        });
        assert.equal(pcPrompts[0].promptId, phonePrompts[0].promptId);
        const promptId = pcPrompts[0].promptId;

        const initialStrictHealth = await strictExecutorHealth(server.baseUrl);
        assert.deepEqual(initialStrictHealth, {
            status: 503,
            body: { ready: false, ageMs: null },
        });
        const serverPid = server.child.pid;
        const chromiumPid = cdp.chromium.pid;
        const livenessSamples = [];
        assert.ok(Number.isSafeInteger(V21_LIVENESS_WAIT_MS) && V21_LIVENESS_WAIT_MS >= 0);
        const livenessDeadline = Date.now() + V21_LIVENESS_WAIT_MS;
        while (Date.now() < livenessDeadline) {
            const [liveness, strictHealth] = await Promise.all([
                startupLiveness(server.baseUrl),
                strictExecutorHealth(server.baseUrl),
            ]);
            livenessSamples.push(liveness.body.ageMs);
            assert.equal(liveness.status, 200);
            assert.equal(liveness.body.alive, true);
            assert.equal(liveness.body.ready, false);
            assert.equal(liveness.body.phase, 'waiting_for_ui');
            assert.equal(liveness.body.pendingPromptCount, 1);
            assert.deepEqual(strictHealth, {
                status: 503,
                body: { ready: false, ageMs: null },
            });
            assert.equal(server.child.pid, serverPid);
            assert.equal(server.child.exitCode, null);
            assert.equal(cdp.chromium.pid, chromiumPid);
            assert.equal(cdp.chromium.exitCode, null);
            await sleep(2_000);
        }

        await pc.setInputPhysical('#alert-input', V21_SECRET);
        await pc.clickAlertButtonPhysical('OK');
        try {
            await pc.waitFor(`!(document.body?.innerText ?? '').includes(${JSON.stringify(V21_PROMPT_TEXT)})`, {
                timeoutMs: 5_000,
            });
        }
        catch (error) {
            const snapshot = await pc.evaluate(`(() => {
                const input = document.querySelector('#alert-input');
                const dialog = input?.closest('div.bg-darkbg');
                return {
                    href: location.href,
                    inputCount: document.querySelectorAll('#alert-input').length,
                    inputLength: input?.value?.length ?? null,
                    dialogText: dialog?.innerText ?? null,
                    buttons: [...(dialog?.querySelectorAll('button') ?? [])].map((button) => ({
                        text: button.textContent.trim(),
                        disabled: button.disabled,
                        onclick: typeof button.onclick,
                        ownProperties: Object.getOwnPropertyNames(button).filter((name) => (
                            name.toLowerCase().includes('click')
                            || name.toLowerCase().includes('event')
                        )),
                    })),
                };
            })()`);
            throw new Error(`V2.1 alert did not close: ${JSON.stringify(snapshot)}`, {
                cause: error,
            });
        }
        await eventually(async () => {
            const snapshot = await authenticatedJson(server.baseUrl, '/runtime-startup');
            return snapshot.response.status === 200
                && !(snapshot.body.prompts ?? []).some((prompt) => prompt.promptId === promptId);
        });
        await Promise.all([
            pc.waitFor(`!(document.body?.innerText ?? '').includes(${JSON.stringify(V21_PROMPT_TEXT)})`),
            phone.waitFor(`!(document.body?.innerText ?? '').includes(${JSON.stringify(V21_PROMPT_TEXT)})`),
        ]);
        await eventually(() => resident.startupHttpEvents.some((event) => (
            event.kind === 'response'
            && event.status === 200
            && event.pathname === '/logo_32.png'
        )), { timeoutMs: 20_000 });
        await waitForClaimReady(server.baseUrl);

        const snapshot = await authenticatedJson(server.baseUrl, '/runtime-startup');
        assert.equal(snapshot.response.status, 200);
        const publicWire = [
            snapshot.text,
            ...pc.startupSocketFrames.map((frame) => frame.raw),
            ...phone.startupSocketFrames.map((frame) => frame.raw),
        ].join('\n');
        assert.equal(publicWire.includes(V21_SECRET), false);
        assert.equal(server.output.join('').includes(V21_SECRET), false);
        for (const page of pages) {
            assert.equal(page.consoleMessages.join('\n').includes(V21_SECRET), false);
        }
        await assertNoDatabaseConflicts(server.baseUrl);

        console.log('[startup-browser-e2e] V2.1 relay PASS');
        return {
            promptId,
            livenessDurationMs: V21_LIVENESS_WAIT_MS,
            livenessSamples,
            zeroClaimContactBeforeAnswer: initialStrictHealth.body.ageMs === null,
            serverPidStable: true,
            chromiumPidStable: true,
            settledEventsObserved: {
                pc: settledPromptIds(pc).has(promptId),
                phone: settledPromptIds(phone).has(promptId),
            },
            secretRedacted: true,
        };
    }
    catch (error) {
        const diagnostics = pages.flatMap((page) => (
            page.diagnostics.map((line) => `[${page.name}] ${line}`)
        ));
        const consoleTail = pages.flatMap((page) => (
            page.consoleMessages.slice(-30).map((line) => `[${page.name}] ${line}`)
        ));
        const startupFrameTail = pages.flatMap((page) => (
            page.startupSocketFrames.slice(-20).map((frame) => (
                `[${page.name}] ${frame.raw}`
            ))
        ));
        const startupHttpTail = pages.flatMap((page) => (
            page.startupHttpEvents.slice(-30).map((event) => (
                `[${page.name}] ${JSON.stringify(event)}`
            ))
        ));
        throw new Error([
            error.stack ?? String(error),
            diagnostics.length ? `Browser diagnostics:\n${diagnostics.join('\n')}` : '',
            consoleTail.length ? `Browser console tail:\n${consoleTail.join('\n')}` : '',
            startupFrameTail.length
                ? `Startup WS frame tail:\n${startupFrameTail.join('\n')}`
                : '',
            startupHttpTail.length
                ? `Startup HTTP tail:\n${startupHttpTail.join('\n')}`
                : '',
            server?.output.length ? `Server output:\n${server.output.join('')}` : '',
        ].filter(Boolean).join('\n\n'));
    }
    finally {
        await cleanupScenario({
            cdp,
            pages,
            server,
            temporaryRoot: root.temporaryRoot,
        });
    }
}

async function runSharedV3PermissionScenario() {
    const root = await createIsolatedRoot(
        'v3',
        createBaseDatabase([createV3Plugin()]),
    );
    const permissionDirectory = path.join(root.savePath, STARTUP_PERMISSION_DIR);
    const permissionFile = path.join(permissionDirectory, STARTUP_PERMISSION_FILE);
    let server = null;
    let cdp = null;
    const pages = [];
    try {
        await assert.rejects(fs.access(permissionDirectory), { code: 'ENOENT' });
        await assert.rejects(fs.access(permissionFile), { code: 'ENOENT' });

        server = await startRisuServer(root.temporaryRoot);
        cdp = await launchChromium(root.temporaryRoot);
        const resident = await cdp.createPage({
            width: 1280,
            height: 900,
            name: 'V3 cold resident',
        });
        pages.push(resident);
        await resident.navigate(`${server.baseUrl}/?risu-runtime=executor`);

        const pendingSnapshot = await eventually(async () => {
            const snapshot = await authenticatedJson(server.baseUrl, '/runtime-startup');
            const prompts = (snapshot.body?.prompts ?? []).filter(
                (prompt) => prompt.source?.kind === 'plugin_permission'
                    && prompt.source?.pluginName === V3_PLUGIN_NAME,
            );
            return snapshot.response.status === 200 && prompts.length === 1
                ? { snapshot, prompt: prompts[0] }
                : false;
        }, { timeoutMs: 30_000 });
        const permissionPrompt = pendingSnapshot.prompt;
        assert.equal(pendingSnapshot.snapshot.body.phase, 'waiting_for_ui');
        assert.deepEqual(permissionPrompt.source, {
            kind: 'plugin_permission',
            pluginName: V3_PLUGIN_NAME,
            permission: 'db',
            pluginScriptHash: permissionPrompt.source.pluginScriptHash,
            permissionPolicy: 'persistent',
        });
        assert.match(permissionPrompt.source.pluginScriptHash, /^[a-f0-9]{64}$/);
        assert.equal(permissionPrompt.prompt.type, 'ask');
        assert.ok(permissionPrompt.prompt.msg.includes(V3_PLUGIN_NAME));
        assert.deepEqual(await strictExecutorHealth(server.baseUrl), {
            status: 503,
            body: { ready: false, ageMs: null },
        });
        const directoryBeforeDecision = await fs.stat(permissionDirectory);
        assert.equal(directoryBeforeDecision.mode & 0o777, 0o700);
        await assert.rejects(fs.access(permissionFile), { code: 'ENOENT' });

        // Load two genuinely independent public profiles after the resident is
        // already blocked. Each page starts the startup follower before its own
        // V3 top-level permission request, then joins the same server decision.
        const pc = await cdp.createPage({ width: 1100, height: 800, name: 'V3 public PC' });
        const phone = await cdp.createPage({
            width: 390,
            height: 844,
            mobile: true,
            name: 'V3 public phone',
        });
        pages.push(pc, phone);
        await Promise.all([
            authenticateViewer(pc, server.baseUrl),
            authenticateViewer(phone, server.baseUrl),
        ]);
        await Promise.all([
            waitForStartupConfirmUi(pc, V3_PLUGIN_NAME),
            waitForStartupConfirmUi(phone, V3_PLUGIN_NAME),
        ]);

        const promptPredicate = (prompt) => (
            prompt.source?.kind === 'plugin_permission'
            && prompt.source?.pluginName === V3_PLUGIN_NAME
        );
        const [pcPrompts, phonePrompts] = await eventually(() => {
            const left = startupPromptsObserved(pc, promptPredicate);
            const right = startupPromptsObserved(phone, promptPredicate);
            return left.length === 1 && right.length === 1 ? [left, right] : false;
        });
        assert.equal(pcPrompts[0].promptId, permissionPrompt.promptId);
        assert.equal(phonePrompts[0].promptId, permissionPrompt.promptId);
        await eventually(() => pages.every((page) => page.startupHttpEvents.some(
            (event) => event.kind === 'request'
                && event.method === 'POST'
                && event.pathname === '/runtime-plugin-permissions/requests',
        )));
        for (const page of pages) {
            assert.equal(page.startupHttpEvents.filter((event) => (
                event.kind === 'request'
                && event.method === 'POST'
                && event.pathname === '/runtime-plugin-permissions/requests'
            )).length, 1, `${page.name} should create one shared permission request`);
        }

        await phone.clickAlertButtonPhysical('YES');
        await eventually(async () => {
            const snapshot = await authenticatedJson(server.baseUrl, '/runtime-startup');
            return snapshot.response.status === 200
                && !(snapshot.body.prompts ?? []).some(
                    (prompt) => prompt.promptId === permissionPrompt.promptId,
                );
        });
        await Promise.all([
            pc.waitFor(`!(document.body?.innerText ?? '').includes(${JSON.stringify(V3_PLUGIN_NAME)})`),
            phone.waitFor(`!(document.body?.innerText ?? '').includes(${JSON.stringify(V3_PLUGIN_NAME)})`),
        ]);
        await eventually(() => pages.every((page) => page.startupHttpEvents.some(
            (event) => event.kind === 'response'
                && event.status === 200
                && event.pathname === '/logo_32.png',
        )), { timeoutMs: 30_000, intervalMs: 125 });
        assert.equal(settledPromptIds(pc).has(permissionPrompt.promptId), true);
        assert.equal(settledPromptIds(phone).has(permissionPrompt.promptId), true);
        await waitForClaimReady(server.baseUrl);

        const [directoryStat, fileStat, encodedGrant] = await Promise.all([
            fs.stat(permissionDirectory),
            fs.stat(permissionFile),
            fs.readFile(permissionFile, 'utf8'),
        ]);
        assert.equal(directoryStat.mode & 0o777, 0o700);
        assert.equal(fileStat.mode & 0o777, 0o600);
        const grantDocument = JSON.parse(encodedGrant);
        assert.equal(grantDocument.schemaVersion, 1);
        const grantEntries = Object.entries(grantDocument.grants ?? {});
        assert.equal(grantEntries.length, 1);
        const [grantDigest, grant] = grantEntries[0];
        assert.equal(
            crypto.createHash('sha256').update(grant.key, 'utf8').digest('hex'),
            grantDigest,
        );
        assert.ok(Number.isSafeInteger(grant.grantedAt) && grant.grantedAt > 0);
        assert.deepEqual(JSON.parse(grant.key), {
            capability: 'db',
            name: V3_PLUGIN_NAME,
            policy: 'persistent',
            scriptHash: permissionPrompt.source.pluginScriptHash,
        });
        assert.doesNotMatch(encodedGrant, /"(?:yes|no)"|requestToken|requesterId|requestId/);

        const settledSnapshot = await authenticatedJson(server.baseUrl, '/runtime-startup');
        assert.equal(settledSnapshot.response.status, 200);
        const publicWire = [
            settledSnapshot.text,
            ...pc.startupSocketFrames.map((frame) => frame.raw),
            ...phone.startupSocketFrames.map((frame) => frame.raw),
        ].join('\n');
        assert.doesNotMatch(publicWire, /"(?:yes|no)"|requestToken/);
        assert.doesNotMatch(server.output.join(''), /"(?:yes|no)"|requestToken/);
        await assertNoDatabaseConflicts(server.baseUrl);

        console.log('[startup-browser-e2e] shared V3 permission PASS');
        return {
            promptId: permissionPrompt.promptId,
            promptCount: 1,
            joinedProcesses: pages.map((page) => page.name),
            registrationComplete: true,
            zeroClaimContactBeforeAnswer: true,
            settledEventsObserved: {
                pc: settledPromptIds(pc).has(permissionPrompt.promptId),
                phone: settledPromptIds(phone).has(permissionPrompt.promptId),
            },
            grantCount: grantEntries.length,
            grantDirectoryMode: '0700',
            grantFileMode: '0600',
            responseRedacted: true,
        };
    }
    catch (error) {
        const diagnostics = pages.flatMap((page) => (
            page.diagnostics.map((line) => `[${page.name}] ${line}`)
        ));
        const consoleTail = pages.flatMap((page) => (
            page.consoleMessages.slice(-30).map((line) => `[${page.name}] ${line}`)
        ));
        const startupFrameTail = pages.flatMap((page) => (
            page.startupSocketFrames.slice(-20).map((frame) => (
                `[${page.name}] ${frame.raw}`
            ))
        ));
        const startupHttpTail = pages.flatMap((page) => (
            page.startupHttpEvents.slice(-30).map((event) => (
                `[${page.name}] ${JSON.stringify(event)}`
            ))
        ));
        throw new Error([
            error.stack ?? String(error),
            diagnostics.length ? `Browser diagnostics:\n${diagnostics.join('\n')}` : '',
            consoleTail.length ? `Browser console tail:\n${consoleTail.join('\n')}` : '',
            startupFrameTail.length
                ? `Startup WS frame tail:\n${startupFrameTail.join('\n')}`
                : '',
            startupHttpTail.length
                ? `Startup HTTP tail:\n${startupHttpTail.join('\n')}`
                : '',
            server?.output.length ? `Server output:\n${server.output.join('')}` : '',
        ].filter(Boolean).join('\n\n'));
    }
    finally {
        await cleanupScenario({
            cdp,
            pages,
            server,
            temporaryRoot: root.temporaryRoot,
        });
    }
}

async function cleanup() {
    await Promise.all([...childProcesses].map(stopChild));
}

(async () => {
    try {
        await buildApplication();
        const selectedScenario = process.env.RISU_STARTUP_BROWSER_E2E_SCENARIO ?? 'all';
        assert.ok(
            ['all', 'v21', 'v3'].includes(selectedScenario),
            'RISU_STARTUP_BROWSER_E2E_SCENARIO must be all, v21, or v3',
        );
        const v21 = selectedScenario === 'all' || selectedScenario === 'v21'
            ? await runV21StartupRelayScenario()
            : null;
        const v3 = selectedScenario === 'all' || selectedScenario === 'v3'
            ? await runSharedV3PermissionScenario()
            : null;
        console.log('[startup-browser-e2e] PASS');
        console.log(JSON.stringify({ v21, v3 }, null, 2));
    }
    finally {
        await cleanup();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
