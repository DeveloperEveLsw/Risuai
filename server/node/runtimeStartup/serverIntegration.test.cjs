'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { afterEach, test } = require('node:test');
const express = require('express');
const WebSocket = require('ws');

const { createRuntimeStartupServer } = require('./serverApi.cjs');

const fixtures = new Set();

afterEach(async () => {
    await Promise.all([...fixtures].map(async (fixture) => {
        for (const socket of fixture.sockets) {
            socket.terminate();
        }
        fixture.runtime.dispose();
        await new Promise((resolve) => fixture.server.close(resolve));
    }));
    fixtures.clear();
});

async function startFixture(options = {}) {
    const password = 'startup-integration-secret';
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const executorHealth = options.executorHealth ?? { ready: false, ageMs: null };
    const runtime = createRuntimeStartupServer({
        authenticate: async (req, res) => {
            if (req.headers['risu-auth'] === password) {
                return true;
            }
            res.status(401).send({ error: 'Unauthorized' });
            return false;
        },
        executorIp: options.executorIp ?? '127.0.0.1',
        getExecutorHealth: () => executorHealth,
        now: options.now,
        sessionTtlMs: options.sessionTtlMs,
        promptTtlMs: options.promptTtlMs,
        responseTtlMs: options.responseTtlMs,
        contactFreshMs: options.contactFreshMs,
        permissionStore: options.permissionStore,
        permissionPeriodMs: options.permissionPeriodMs,
        maxPendingPermissionPrompts: options.maxPendingPermissionPrompts,
    });
    runtime.registerRoutes(app);
    app.use((error, _req, res, _next) => {
        res.status(500).send({ error: error.message, code: error.code ?? 'TEST_INTERNAL_ERROR' });
    });
    const server = http.createServer(app);
    runtime.setupWebSocket(server);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const fixture = {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        executorHealth,
        password,
        runtime,
        server,
        sockets: new Set(),
    };
    fixtures.add(fixture);
    return fixture;
}

class MemoryPermissionStore {
    constructor() {
        this.grants = new Map();
        this.recordCalls = [];
        this.onRecord = null;
    }

    async getGrant(key) {
        return this.grants.get(key) ?? null;
    }

    async recordGrant(key, grantedAt) {
        this.recordCalls.push({ key, grantedAt });
        await this.onRecord?.(key, grantedAt);
        this.grants.set(key, grantedAt);
        return grantedAt;
    }
}

async function request(fixture, path, options = {}) {
    const response = await fetch(`${fixture.baseUrl}${path}`, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: {
            'risu-auth': fixture.password,
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return {
        response,
        body: text ? JSON.parse(text) : null,
    };
}

async function beginSession(fixture, requestId = 'startup-session-1', producerId = 'resident-1') {
    return await request(fixture, '/runtime-startup/session', {
        body: { requestId, producerId },
    });
}

function sessionCredentials(session) {
    return {
        producerId: session.producerId,
        fencingToken: session.fencingToken,
    };
}

async function createPrompt(fixture, session, requestId = 'prompt-request-1', overrides = {}) {
    return await request(
        fixture,
        `/runtime-startup/session/${encodeURIComponent(session.sessionId)}/prompts`,
        {
            body: {
                ...sessionCredentials(session),
                requestId,
                prompt: {
                    type: 'input',
                    msg: 'Enter provider key',
                    defaultValue: '',
                },
                source: {
                    kind: 'v2_dialog',
                    pluginName: 'fixture-plugin',
                },
                ...overrides,
            },
        },
    );
}

async function createPermissionRequest(
    fixture,
    requesterId,
    requestId,
    overrides = {},
) {
    return await request(fixture, '/runtime-plugin-permissions/requests', {
        body: {
            requesterId,
            requestId,
            principal: {
                name: 'permission-fixture',
                scriptHash: 'a'.repeat(64),
            },
            capability: 'db',
            policy: 'periodically',
            prompt: {
                type: 'ask',
                msg: 'Allow database access?',
            },
            ...overrides,
        },
    });
}

async function pollPermission(fixture, requestToken) {
    return await request(fixture, '/runtime-plugin-permissions/poll', {
        body: { requestToken },
    });
}

function collector(ws) {
    const messages = [];
    const waiters = new Set();
    ws.on('message', (raw) => {
        const value = JSON.parse(raw.toString());
        messages.push(value);
        for (const waiter of waiters) {
            if (waiter.predicate(value)) {
                waiters.delete(waiter);
                clearTimeout(waiter.timer);
                waiter.resolve(value);
            }
        }
    });
    return {
        messages,
        waitFor(predicate, timeoutMs = 3_000) {
            const existing = messages.find(predicate);
            if (existing) {
                return Promise.resolve(existing);
            }
            return new Promise((resolve, reject) => {
                const waiter = {
                    predicate,
                    resolve,
                    timer: setTimeout(() => {
                        waiters.delete(waiter);
                        reject(new Error('Timed out waiting for startup WebSocket event'));
                    }, timeoutMs),
                };
                waiters.add(waiter);
            });
        },
    };
}

async function openSocket(fixture, clientId) {
    const ticket = await request(fixture, '/runtime-startup/socket-ticket', {
        body: { clientId },
    });
    assert.equal(ticket.response.status, 200);
    const url = new URL(ticket.body.path, fixture.baseUrl);
    url.protocol = 'ws:';
    url.searchParams.set('ticket', ticket.body.ticket);
    const ws = new WebSocket(url);
    fixture.sockets.add(ws);
    const messages = collector(ws);
    await once(ws, 'open');
    return { ws, ticket: ticket.body, ...messages };
}

test('startup liveness is distinct from strict executor claim readiness', async () => {
    const fixture = await startFixture();
    const before = await fetch(`${fixture.baseUrl}/runtime-startup/liveness`);
    assert.equal(before.status, 503);
    assert.deepEqual(await before.json(), {
        alive: false,
        ready: false,
        phase: 'unavailable',
        ageMs: null,
        pendingPromptCount: 0,
    });

    const started = await beginSession(fixture);
    assert.equal(started.response.status, 201);
    assert.equal(started.body.phase, 'loading_data');

    const duringStartup = await fetch(`${fixture.baseUrl}/runtime-startup/liveness`);
    assert.equal(duringStartup.status, 200);
    const duringStartupBody = await duringStartup.json();
    assert.equal(duringStartupBody.alive, true);
    assert.equal(duringStartupBody.ready, false);
    assert.equal(duringStartupBody.phase, 'loading_data');
    assert.ok(duringStartupBody.ageMs >= 0 && duringStartupBody.ageMs <= 10_000);
    assert.equal(duringStartupBody.pendingPromptCount, 0);
    assert.equal(fixture.executorHealth.ready, false);

    fixture.executorHealth.ready = true;
    fixture.executorHealth.ageMs = 1;
    const claimReady = await fetch(`${fixture.baseUrl}/runtime-startup/liveness`);
    assert.equal(claimReady.status, 200);
    assert.deepEqual(await claimReady.json(), {
        alive: true,
        ready: true,
        phase: 'claim_ready',
        ageMs: 1,
        pendingPromptCount: 0,
    });
});

test('a claim-ready resident keeps a sliding startup lease for later plugin prompts', async () => {
    let timestamp = 1_000;
    const fixture = await startFixture({
        now: () => timestamp,
        sessionTtlMs: 100,
        contactFreshMs: 20,
    });
    const started = await beginSession(fixture);
    fixture.executorHealth.ready = true;
    fixture.executorHealth.ageMs = 1;

    timestamp = 5_000;
    const refreshed = await request(
        fixture,
        `/runtime-startup/session/${encodeURIComponent(started.body.sessionId)}/heartbeat`,
        {
            body: {
                ...sessionCredentials(started.body),
                phase: 'starting_executor',
            },
        },
    );
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.body.expiresAt, 5_100);

    fixture.executorHealth.ready = false;
    fixture.executorHealth.ageMs = null;
    timestamp = 5_001;
    const fallback = await fetch(`${fixture.baseUrl}/runtime-startup/liveness`);
    assert.equal(fallback.status, 200);
    assert.equal((await fallback.json()).phase, 'starting_executor');

    const prompt = await createPrompt(fixture, started.body, 'late-plugin-prompt', {
        prompt: { type: 'selectModule', msg: '' },
        source: { kind: 'v2_dialog', pluginName: 'late-plugin' },
    });
    assert.equal(prompt.response.status, 201);
    const snapshot = await request(fixture, '/runtime-startup');
    assert.equal(snapshot.body.phase, 'waiting_for_ui');
    assert.equal(snapshot.body.prompts[0].prompt.type, 'selectModule');
});

test('two authenticated observers see one redacted prompt and only the first answer wins', async () => {
    const fixture = await startFixture();
    const started = await beginSession(fixture);
    const [desktop, phone] = await Promise.all([
        openSocket(fixture, 'desktop'),
        openSocket(fixture, 'phone'),
    ]);
    await Promise.all([
        desktop.waitFor((message) => message.type === 'runtime_startup_snapshot'),
        phone.waitFor((message) => message.type === 'runtime_startup_snapshot'),
    ]);

    const notice = await request(
        fixture,
        `/runtime-startup/session/${encodeURIComponent(started.body.sessionId)}/notices`,
        {
            body: {
                ...sessionCredentials(started.body),
                notice: { type: 'markdown', msg: '**Plugin loaded**' },
                source: { kind: 'runtime_notice', pluginName: 'fixture-plugin' },
            },
        },
    );
    assert.equal(notice.response.status, 201);
    const noticeEvent = await desktop.waitFor((message) => (
        message.eventType === 'notice_created'
        && message.notice.noticeId === notice.body.noticeId
    ));
    assert.deepEqual(noticeEvent.notice.notice, {
        type: 'markdown',
        msg: '**Plugin loaded**',
    });
    assert.equal(Object.hasOwn(noticeEvent, 'response'), false);

    const created = await createPrompt(fixture, started.body);
    assert.equal(created.response.status, 201);
    const promptId = created.body.promptId;
    const promptEvents = await Promise.all([
        desktop.waitFor((message) => (
            message.eventType === 'prompt_created' && message.prompt.promptId === promptId
        )),
        phone.waitFor((message) => (
            message.eventType === 'prompt_created' && message.prompt.promptId === promptId
        )),
    ]);
    assert.equal(promptEvents[0].prompt.prompt.type, 'input');
    assert.equal(promptEvents[0].prompt.source.pluginName, 'fixture-plugin');

    const secret = 'phone-only-api-key';
    const [desktopResponse, phoneResponse] = await Promise.all([
        request(fixture, `/runtime-startup/prompts/${promptId}/response`, {
            body: { response: 'desktop-answer' },
        }),
        request(fixture, `/runtime-startup/prompts/${promptId}/response`, {
            body: { response: secret },
        }),
    ]);
    const answers = [desktopResponse.body, phoneResponse.body];
    assert.equal(answers.filter((answer) => answer.accepted).length, 1);
    assert.equal(answers.filter((answer) => answer.reused).length, 1);

    const settled = await Promise.all([
        desktop.waitFor((message) => (
            message.eventType === 'prompt_settled' && message.promptId === promptId
        )),
        phone.waitFor((message) => (
            message.eventType === 'prompt_settled' && message.promptId === promptId
        )),
    ]);
    for (const event of settled) {
        assert.equal(event.state, 'answered');
        assert.equal(Object.hasOwn(event, 'response'), false);
    }

    const snapshot = await request(fixture, '/runtime-startup');
    assert.equal(snapshot.body.prompts.length, 0);
    assert.equal(snapshot.body.notices.length, 1);
    const publicWire = JSON.stringify({
        snapshot: snapshot.body,
        desktop: desktop.messages,
        phone: phone.messages,
    });
    assert.equal(publicWire.includes(secret), false);
    assert.equal(publicWire.includes('desktop-answer'), false);

    const pollPath = `/runtime-startup/session/${encodeURIComponent(started.body.sessionId)}`
        + `/prompts/${encodeURIComponent(promptId)}/poll`;
    const polled = await request(fixture, pollPath, {
        body: sessionCredentials(started.body),
    });
    assert.equal(polled.response.status, 200);
    assert.ok(['desktop-answer', secret].includes(polled.body.response));
    const repeated = await request(fixture, pollPath, {
        body: sessionCredentials(started.body),
    });
    assert.deepEqual(repeated.body, polled.body);

    const closed = await request(
        fixture,
        `/runtime-startup/session/${encodeURIComponent(started.body.sessionId)}`
            + `/prompts/${encodeURIComponent(promptId)}`,
        {
            method: 'DELETE',
            body: sessionCredentials(started.body),
        },
    );
    assert.equal(closed.body.success, true);
    const unavailable = await request(fixture, pollPath, {
        body: sessionCredentials(started.body),
    });
    assert.equal(unavailable.response.status, 404);
});

test('a replacement startup session fences the old producer and dismisses its prompts', async () => {
    const fixture = await startFixture();
    const first = await beginSession(fixture, 'boot-a', 'resident-a');
    const prompt = await createPrompt(fixture, first.body, 'prompt-a');
    const observer = await openSocket(fixture, 'observer');
    await observer.waitFor((message) => message.type === 'runtime_startup_snapshot');

    const second = await beginSession(fixture, 'boot-b', 'resident-b');
    assert.equal(second.response.status, 201);
    assert.ok(second.body.fencingToken > first.body.fencingToken);

    const delayedFirstRetry = await beginSession(fixture, 'boot-a', 'resident-a');
    assert.equal(delayedFirstRetry.response.status, 409);
    assert.equal(delayedFirstRetry.body.code, 'STALE_STARTUP_SESSION');
    const currentSnapshot = await request(fixture, '/runtime-startup');
    assert.equal(currentSnapshot.body.sessionId, second.body.sessionId);
    const fencedEvent = await observer.waitFor((message) => (
        message.eventType === 'prompt_settled'
        && message.promptId === prompt.body.promptId
    ));
    assert.equal(fencedEvent.state, 'fenced');
    assert.equal(Object.hasOwn(fencedEvent, 'response'), false);

    const staleHeartbeat = await request(
        fixture,
        `/runtime-startup/session/${encodeURIComponent(first.body.sessionId)}/heartbeat`,
        {
            body: {
                ...sessionCredentials(first.body),
                phase: 'loading_plugins',
            },
        },
    );
    assert.equal(staleHeartbeat.response.status, 409);
    assert.equal(staleHeartbeat.body.code, 'STALE_STARTUP_SESSION');

    const staleAnswer = await request(
        fixture,
        `/runtime-startup/prompts/${encodeURIComponent(prompt.body.promptId)}/response`,
        { body: { response: 'must-not-land' } },
    );
    assert.equal(staleAnswer.response.status, 404);
});

test('prompt and startup heartbeat expiry fail closed and redact an accepted response', async () => {
    let timestamp = 1_000;
    const fixture = await startFixture({
        now: () => timestamp,
        sessionTtlMs: 100,
        promptTtlMs: 50,
        responseTtlMs: 20,
        contactFreshMs: 10,
    });
    const started = await beginSession(fixture);
    const prompt = await createPrompt(fixture, started.body);
    const answered = await request(
        fixture,
        `/runtime-startup/prompts/${encodeURIComponent(prompt.body.promptId)}/response`,
        { body: { response: 'ephemeral-secret' } },
    );
    assert.equal(answered.body.accepted, true);

    timestamp += 21;
    const expiredResponse = await request(
        fixture,
        `/runtime-startup/session/${encodeURIComponent(started.body.sessionId)}`
            + `/prompts/${encodeURIComponent(prompt.body.promptId)}/poll`,
        { body: sessionCredentials(started.body) },
    );
    assert.equal(expiredResponse.response.status, 410);
    assert.equal(expiredResponse.body.code, 'STARTUP_PROMPT_UNAVAILABLE');

    timestamp += 11;
    const staleLiveness = await fetch(`${fixture.baseUrl}/runtime-startup/liveness`);
    assert.equal(staleLiveness.status, 503);
    assert.equal((await staleLiveness.json()).alive, false);

    timestamp = 1_122;
    const expiredSession = await request(
        fixture,
        `/runtime-startup/session/${encodeURIComponent(started.body.sessionId)}/heartbeat`,
        {
            body: {
                ...sessionCredentials(started.body),
                phase: 'loading_plugins',
            },
        },
    );
    assert.equal(expiredSession.response.status, 409);
    assert.equal(expiredSession.body.code, 'STALE_STARTUP_SESSION');
});

test('startup producer routes enforce the fixed executor source independently of observer auth', async () => {
    const fixture = await startFixture({ executorIp: '192.0.2.50' });
    const denied = await beginSession(fixture);
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.code, 'STARTUP_PRODUCER_IP_FORBIDDEN');

    const snapshot = await request(fixture, '/runtime-startup');
    assert.equal(snapshot.response.status, 200);
    assert.equal(snapshot.body.phase, 'unavailable');
});

test('resident and public permission requests share one prompt and one durable first decision', async () => {
    const permissionStore = new MemoryPermissionStore();
    const fixture = await startFixture({ permissionStore });
    const observer = await openSocket(fixture, 'permission-observer');

    const [resident, publicClient] = await Promise.all([
        createPermissionRequest(fixture, 'resident', 'resident-request'),
        createPermissionRequest(fixture, 'public', 'public-request'),
    ]);
    assert.equal(resident.response.status, 202);
    assert.equal(publicClient.response.status, 202);
    assert.notEqual(resident.body.requestToken, publicClient.body.requestToken);
    assert.deepEqual(new Set([resident.body.reused, publicClient.body.reused]), new Set([false, true]));

    const created = await observer.waitFor((message) => (
        message.eventType === 'prompt_created'
        && message.prompt.source.kind === 'plugin_permission'
    ));
    assert.deepEqual(created.prompt.source, {
        kind: 'plugin_permission',
        pluginName: 'permission-fixture',
        permission: 'db',
        pluginScriptHash: 'a'.repeat(64),
        permissionPolicy: 'periodically',
    });
    const snapshot = await request(fixture, '/runtime-startup');
    assert.equal(snapshot.body.sessionId, null);
    assert.equal(snapshot.body.phase, 'waiting_for_ui');
    assert.equal(snapshot.body.prompts.length, 1);
    assert.doesNotMatch(JSON.stringify(snapshot.body), /resident-request|public-request|requestToken/);

    const invalid = await request(
        fixture,
        `/runtime-startup/prompts/${created.prompt.promptId}/response`,
        { body: { response: 'true' } },
    );
    assert.equal(invalid.response.status, 400);
    assert.equal((await pollPermission(fixture, resident.body.requestToken)).response.status, 202);

    let enteredResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    let releaseRecord;
    const recordGate = new Promise((resolve) => { releaseRecord = resolve; });
    permissionStore.onRecord = async () => {
        enteredResolve();
        await recordGate;
    };
    const first = request(
        fixture,
        `/runtime-startup/prompts/${created.prompt.promptId}/response`,
        { body: { response: 'yes' } },
    );
    await entered;
    const joinedDuringFsync = await createPermissionRequest(
        fixture,
        'during-fsync',
        'during-fsync-request',
    );
    assert.equal(joinedDuringFsync.response.status, 202);
    assert.equal(joinedDuringFsync.body.state, 'pending');
    const second = request(
        fixture,
        `/runtime-startup/prompts/${created.prompt.promptId}/response`,
        { body: { response: 'no' } },
    );
    releaseRecord();
    const [firstAnswer, secondAnswer] = await Promise.all([first, second]);
    assert.deepEqual(firstAnswer.body, { success: true, accepted: true, reused: false });
    assert.deepEqual(secondAnswer.body, { success: true, accepted: false, reused: true });
    assert.equal(permissionStore.recordCalls.length, 1);
    assert.equal((await pollPermission(fixture, resident.body.requestToken)).body.state, 'granted');
    assert.equal((await pollPermission(fixture, publicClient.body.requestToken)).body.state, 'granted');
    assert.equal((await pollPermission(
        fixture,
        joinedDuringFsync.body.requestToken,
    )).body.state, 'granted');

    const settledEvents = observer.messages.filter((message) => (
        message.eventType === 'prompt_settled'
        && message.promptId === created.prompt.promptId
    ));
    assert.equal(settledEvents.length, 1);
    assert.doesNotMatch(JSON.stringify(settledEvents), /"yes"|"no"|granted|denied|requestToken/);

    const cached = await createPermissionRequest(fixture, 'third', 'cached-request');
    assert.equal(cached.response.status, 200);
    assert.deepEqual(cached.body, {
        state: 'granted',
        grantedAt: permissionStore.recordCalls[0].grantedAt,
        cached: true,
        reused: false,
    });
    assert.equal(observer.messages.filter((message) => (
        message.eventType === 'prompt_created'
        && message.prompt?.source?.kind === 'plugin_permission'
    )).length, 1);
});

test('the first authenticated requester supplies display copy but cannot alter permission identity', async () => {
    const fixture = await startFixture();
    const first = await createPermissionRequest(fixture, 'copy-a', 'copy-a', {
        prompt: { type: 'ask', msg: 'Localized consent copy A' },
    });
    const second = await createPermissionRequest(fixture, 'copy-b', 'copy-b', {
        prompt: { type: 'ask', msg: 'Localized consent copy B' },
    });
    assert.equal(first.response.status, 202);
    assert.equal(second.response.status, 202);
    assert.equal(second.body.reused, true);

    const snapshot = await request(fixture, '/runtime-startup');
    assert.equal(snapshot.body.prompts.length, 1);
    assert.equal(snapshot.body.prompts[0].prompt.msg, 'Localized consent copy A');
    assert.deepEqual(snapshot.body.prompts[0].source, {
        kind: 'plugin_permission',
        pluginName: 'permission-fixture',
        permission: 'db',
        pluginScriptHash: 'a'.repeat(64),
        permissionPolicy: 'periodically',
    });
});

test('always grants are not cached, while denies live only for one server instance', async () => {
    const permissionStore = new MemoryPermissionStore();
    const fixture = await startFixture({ permissionStore });

    const alwaysFirst = await createPermissionRequest(fixture, 'always-a', 'always-a', {
        policy: 'always',
    });
    const snapshot = await request(fixture, '/runtime-startup');
    const firstPromptId = snapshot.body.prompts[0].promptId;
    await request(fixture, `/runtime-startup/prompts/${firstPromptId}/response`, {
        body: { response: 'yes' },
    });
    assert.equal((await pollPermission(fixture, alwaysFirst.body.requestToken)).body.state, 'granted');
    assert.equal(permissionStore.recordCalls.length, 0);

    const alwaysSecond = await createPermissionRequest(fixture, 'always-b', 'always-b', {
        policy: 'always',
    });
    assert.equal(alwaysSecond.response.status, 202);
    const secondSnapshot = await request(fixture, '/runtime-startup');
    assert.notEqual(secondSnapshot.body.prompts[0].promptId, firstPromptId);

    const deniedRequest = await createPermissionRequest(fixture, 'deny-a', 'deny-a', {
        principal: { name: 'denied-fixture', scriptHash: 'b'.repeat(64) },
        policy: 'persistent',
    });
    const deniedSnapshot = await request(fixture, '/runtime-startup');
    const deniedPrompt = deniedSnapshot.body.prompts.find((entry) => (
        entry.source.pluginName === 'denied-fixture'
    ));
    await request(fixture, `/runtime-startup/prompts/${deniedPrompt.promptId}/response`, {
        body: { response: 'no' },
    });
    assert.equal((await pollPermission(fixture, deniedRequest.body.requestToken)).body.state, 'denied');
    const deniedAgain = await createPermissionRequest(fixture, 'deny-b', 'deny-b', {
        principal: { name: 'denied-fixture', scriptHash: 'b'.repeat(64) },
        policy: 'persistent',
    });
    assert.deepEqual(deniedAgain.body, {
        state: 'denied', cached: true, reused: false,
    });

    const restarted = await startFixture({ permissionStore });
    const afterRestart = await createPermissionRequest(restarted, 'deny-c', 'deny-c', {
        principal: { name: 'denied-fixture', scriptHash: 'b'.repeat(64) },
        policy: 'persistent',
    });
    assert.equal(afterRestart.response.status, 202);
    assert.equal(afterRestart.body.state, 'pending');
});

test('periodic grants expire after three days and script changes require fresh consent', async () => {
    let timestamp = 10_000;
    const permissionStore = new MemoryPermissionStore();
    const fixture = await startFixture({
        permissionStore,
        now: () => timestamp,
        permissionPeriodMs: 300,
    });
    const initial = await createPermissionRequest(fixture, 'periodic-a', 'periodic-a');
    const initialSnapshot = await request(fixture, '/runtime-startup');
    await request(
        fixture,
        `/runtime-startup/prompts/${initialSnapshot.body.prompts[0].promptId}/response`,
        { body: { response: 'yes' } },
    );
    assert.equal((await pollPermission(fixture, initial.body.requestToken)).body.state, 'granted');

    timestamp += 300;
    assert.equal(
        (await createPermissionRequest(fixture, 'periodic-b', 'periodic-b')).body.state,
        'granted',
    );
    timestamp += 1;
    assert.equal(
        (await createPermissionRequest(fixture, 'periodic-c', 'periodic-c')).body.state,
        'pending',
    );
    const changedScript = await createPermissionRequest(fixture, 'periodic-d', 'periodic-d', {
        principal: {
            name: 'permission-fixture',
            scriptHash: 'c'.repeat(64),
        },
    });
    assert.equal(changedScript.body.state, 'pending');
    const changedSnapshot = await request(fixture, '/runtime-startup');
    assert.equal(changedSnapshot.body.prompts.length, 2);
});

test('a failed durable allow remains pending and emits no accepted decision', async () => {
    const permissionStore = new MemoryPermissionStore();
    let failRecord = true;
    permissionStore.onRecord = async () => {
        if (failRecord) {
            throw new Error('simulated fsync failure');
        }
    };
    const fixture = await startFixture({ permissionStore });
    const observer = await openSocket(fixture, 'fsync-observer');
    const created = await createPermissionRequest(fixture, 'fsync', 'fsync');
    const promptEvent = await observer.waitFor((message) => (
        message.eventType === 'prompt_created'
        && message.prompt.source.kind === 'plugin_permission'
    ));

    const failed = await request(
        fixture,
        `/runtime-startup/prompts/${promptEvent.prompt.promptId}/response`,
        { body: { response: 'yes' } },
    );
    assert.equal(failed.response.status, 500);
    assert.equal((await pollPermission(fixture, created.body.requestToken)).response.status, 202);
    assert.equal(observer.messages.some((message) => (
        message.eventType === 'prompt_settled'
        && message.promptId === promptEvent.prompt.promptId
    )), false);

    failRecord = false;
    const retried = await request(
        fixture,
        `/runtime-startup/prompts/${promptEvent.prompt.promptId}/response`,
        { body: { response: 'yes' } },
    );
    assert.equal(retried.body.accepted, true);
    assert.equal((await pollPermission(fixture, created.body.requestToken)).body.state, 'granted');
    assert.equal(permissionStore.recordCalls.length, 2);
});

test('global permission prompts survive startup session replacement and enforce bounds', async () => {
    const fixture = await startFixture({ maxPendingPermissionPrompts: 1 });
    const globalRequest = await createPermissionRequest(fixture, 'bounded-a', 'bounded-a');
    assert.equal(globalRequest.response.status, 202);
    const firstSession = await beginSession(fixture, 'session-a', 'resident-a');
    await beginSession(fixture, 'session-b', 'resident-b');
    const afterReplacement = await request(fixture, '/runtime-startup');
    assert.equal(afterReplacement.body.sessionId === firstSession.body.sessionId, false);
    assert.equal(afterReplacement.body.prompts.length, 1);
    assert.equal(afterReplacement.body.prompts[0].source.kind, 'plugin_permission');

    const overLimit = await createPermissionRequest(fixture, 'bounded-b', 'bounded-b', {
        principal: { name: 'other-fixture', scriptHash: 'd'.repeat(64) },
    });
    assert.equal(overLimit.response.status, 429);
    assert.equal(overLimit.body.code, 'PLUGIN_PERMISSION_PROMPT_LIMIT');

    const malformed = await createPermissionRequest(fixture, 'bad', 'bad', {
        principal: { name: 'bad-fixture', scriptHash: 'not-a-sha256' },
    });
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.code, 'INVALID_PLUGIN_PERMISSION_REQUEST');
});

test('an expired pending permission can be recreated with the same idempotency request', async () => {
    let timestamp = 1_000;
    const fixture = await startFixture({
        now: () => timestamp,
        promptTtlMs: 10,
        responseTtlMs: 10,
    });
    const first = await createPermissionRequest(fixture, 'stale-client', 'stale-request');
    timestamp += 11;
    const stalePoll = await pollPermission(fixture, first.body.requestToken);
    assert.equal(stalePoll.response.status, 410);

    const recreated = await createPermissionRequest(
        fixture,
        'stale-client',
        'stale-request',
    );
    assert.equal(recreated.response.status, 202);
    assert.equal(recreated.body.state, 'pending');
    assert.notEqual(recreated.body.requestToken, first.body.requestToken);
    const snapshot = await request(fixture, '/runtime-startup');
    assert.equal(snapshot.body.prompts.length, 1);
});
