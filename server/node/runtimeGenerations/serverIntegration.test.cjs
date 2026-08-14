'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const express = require('express');
const WebSocket = require('ws');

const { RuntimeGenerationStore } = require('./commandStore.cjs');
const { createRuntimeGenerationServer } = require('./serverApi.cjs');

const serverScript = path.resolve(__dirname, '..', 'server.cjs');
const temporaryDirectories = new Set();
const childProcesses = new Set();
const inProcessServers = new Set();
const sockets = new Set();

afterEach(async () => {
    for (const socket of sockets) {
        socket.terminate();
    }
    sockets.clear();
    await Promise.all([...inProcessServers].map((server) => {
        return new Promise((resolve) => server.close(() => resolve()));
    }));
    inProcessServers.clear();
    await Promise.all([...childProcesses].map(stopChild));
    childProcesses.clear();
    await Promise.all(
        [...temporaryDirectories].map((directoryPath) =>
            fs.rm(directoryPath, { recursive: true, force: true })
        )
    );
    temporaryDirectories.clear();
});

async function getUnusedPort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = new Promise((resolve) => setTimeout(resolve, 1_500, 'timeout'));
    if (await Promise.race([exited, timeout]) === 'timeout') {
        child.kill('SIGKILL');
        await once(child, 'exit').catch(() => {});
    }
}

async function createFixtureDirectory() {
    const temporaryRoot = process.platform === 'linux' ? '/tmp' : os.tmpdir();
    const directoryPath = await fs.mkdtemp(path.join(temporaryRoot, 'risu-generation-api-'));
    temporaryDirectories.add(directoryPath);
    const savePath = path.join(directoryPath, 'save');
    const password = 'integration-secret';
    await fs.mkdir(savePath, { recursive: true });
    await fs.writeFile(path.join(savePath, '__password'), password);
    return { directoryPath, savePath, password };
}

async function readDirectoryText(directoryPath) {
    const chunks = [];
    for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            chunks.push(await readDirectoryText(entryPath));
        }
        else if (entry.isFile()) {
            chunks.push(await fs.readFile(entryPath, 'utf8'));
        }
    }
    return chunks.join('\n');
}

async function startServerFixture(directoryFixture = null, environment = {}) {
    const fixture = directoryFixture ?? await createFixtureDirectory();
    const port = await getUnusedPort();
    const output = [];
    const child = spawn(process.execPath, [serverScript], {
        cwd: fixture.directoryPath,
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'test',
            ...environment,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    childProcesses.add(child);
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10_000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited early (${child.exitCode}):\n${output.join('')}`);
        }
        try {
            const response = await fetch(`${baseUrl}/runtime-generations`, {
                headers: { 'risu-auth': fixture.password },
            });
            if (response.status === 200) {
                return { ...fixture, child, port, baseUrl, output };
            }
        }
        catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Server did not become ready: ${lastError}\n${output.join('')}`);
}

async function startInProcessServerFixture(runtimeServerOptions = {}) {
    const fixture = await createFixtureDirectory();
    const store = new RuntimeGenerationStore({
        rootDir: path.join(fixture.savePath, '__runtime_generations'),
        defaultLeaseDurationMs: 5_000,
        maxLeaseDurationMs: 60_000,
    });
    await store.open();
    const {
        decorateStore,
        ...serverOptions
    } = runtimeServerOptions;
    const runtimeStore = typeof decorateStore === 'function'
        ? decorateStore(store)
        : store;
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    const runtimeServer = createRuntimeGenerationServer({
        store: runtimeStore,
        authenticate: async (req, res) => {
            if (req.headers['risu-auth'] === fixture.password) {
                return true;
            }
            res.status(401).send({ error: 'Unauthorized' });
            return false;
        },
        ...serverOptions,
    });
    runtimeServer.registerRoutes(app);
    const server = http.createServer(app);
    runtimeServer.setupWebSocket(server);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    inProcessServers.add(server);
    const address = server.address();
    return {
        ...fixture,
        store,
        server,
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
    };
}

async function requestJson(fixture, requestPath, options = {}) {
    const headers = {
        'risu-auth': fixture.password,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
    };
    const response = await fetch(`${fixture.baseUrl}${requestPath}`, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const raw = await response.text();
    return {
        response,
        body: raw ? JSON.parse(raw) : null,
    };
}

async function createCommand(fixture, suffix, overrides = {}) {
    return await requestJson(fixture, '/runtime-generations', {
        body: {
            requestId: `request-${suffix}`,
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: {
                message: `message-${suffix}`,
                settings: { stream: true, temperature: 0.7 },
            },
            ...overrides,
        },
    });
}

async function cancelCommandByRequest(fixture, suffix, overrides = {}) {
    const requestId = overrides.requestId ?? `request-${suffix}`;
    return await requestJson(
        fixture,
        `/runtime-generations/by-request/${encodeURIComponent(requestId)}`,
        {
            method: 'DELETE',
            headers: { 'Idempotency-Key': requestId },
            body: {
                requestId,
                action: 'send',
                characterId: 'character-1',
                chatId: 'chat-1',
                payload: {
                    message: `message-${suffix}`,
                    settings: { stream: true, temperature: 0.7 },
                },
                ...overrides,
            },
        },
    );
}

async function claimNext(fixture, executorId, leaseDurationMs = 5_000) {
    return await requestJson(fixture, '/runtime-generations/executor/claim-next', {
        body: { executorId, leaseDurationMs },
    });
}

function generationOutputMessage(version, overrides = {}) {
    return {
        messageId: 'assistant-message-1',
        messageIndex: 1,
        data: `assistant-partial-${version}`,
        createdAt: 1_700_000_000_100,
        generationInfo: {
            generationId: 'generation-output-1',
            model: 'integration-model',
        },
        optimizationMode: 'balanced',
        ...overrides,
    };
}

function generationOutputBody(credentials, version, overrides = {}) {
    const { messages, ...messageOverrides } = overrides;
    return {
        executorId: credentials.executorId,
        fencingToken: credentials.fencingToken,
        version,
        messages: messages ?? [generationOutputMessage(version, messageOverrides)],
    };
}

function createMessageCollector(ws) {
    const messages = [];
    const waiters = new Set();
    ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        messages.push(message);
        for (const waiter of waiters) {
            if (waiter.predicate(message)) {
                waiters.delete(waiter);
                clearTimeout(waiter.timer);
                waiter.resolve(message);
            }
        }
    });
    const waitFor = (predicate, timeoutMs = 6_000) => {
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
                    reject(new Error('Timed out waiting for runtime generation WebSocket event'));
                }, timeoutMs),
            };
            waiters.add(waiter);
        });
    };
    return { messages, waitFor };
}

async function issueSocketTicket(fixture, commandId, clientId) {
    const ticketResponse = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/socket-ticket`,
        { body: { clientId } },
    );
    assert.equal(ticketResponse.response.status, 200);
    return ticketResponse.body;
}

async function openCommandSocket(fixture, commandId, clientId, afterSequence = 0) {
    const ticket = await issueSocketTicket(fixture, commandId, clientId);
    const url = `ws://127.0.0.1:${fixture.port}${ticket.path}`
        + `?ticket=${encodeURIComponent(ticket.ticket)}&afterSequence=${afterSequence}`;
    const ws = new WebSocket(url);
    sockets.add(ws);
    const collector = createMessageCollector(ws);
    await once(ws, 'open');
    return { ws, ticket, ...collector };
}

async function closeSocket(ws) {
    if (ws.readyState === WebSocket.CLOSED) {
        sockets.delete(ws);
        return;
    }
    const closed = once(ws, 'close');
    ws.terminate();
    sockets.delete(ws);
    await closed;
}

async function expectWebSocketRejection(url, expectedStatus) {
    await new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
            ws.terminate();
            reject(new Error('WebSocket upgrade was not rejected'));
        }, 5_000);
        ws.once('open', () => {
            clearTimeout(timer);
            ws.terminate();
            reject(new Error('WebSocket unexpectedly opened'));
        });
        ws.once('unexpected-response', (_request, response) => {
            clearTimeout(timer);
            response.resume();
            ws.terminate();
            try {
                assert.equal(response.statusCode, expectedStatus);
                resolve();
            }
            catch (error) {
                reject(error);
            }
        });
        ws.once('error', () => {});
    });
}

function generationEvents(connection) {
    return connection.messages.filter((message) => message.type === 'generation_event');
}

test('generate fallback commands retain normal create, list, get, and replay semantics', {
    timeout: 15_000,
}, async () => {
    const fixture = await startServerFixture();
    const created = await createCommand(fixture, 'direct-generate', {
        action: 'generate',
        payload: { source: 'direct-sendChat-fallback' },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.action, 'generate');
    assert.equal(created.body.state, 'queued');

    const listed = await requestJson(fixture, '/runtime-generations?action=generate');
    assert.equal(listed.response.status, 200);
    assert.deepEqual(listed.body.commands.map((command) => command.commandId), [created.body.commandId]);
    assert.equal(listed.body.commands[0].action, 'generate');

    const loaded = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(created.body.commandId)}`,
    );
    assert.equal(loaded.body.action, 'generate');
    assert.deepEqual(loaded.body.payload, { source: 'direct-sendChat-fallback' });

    const replay = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(created.body.commandId)}/events?afterSequence=0`,
    );
    assert.deepEqual(replay.body.events.map((event) => event.sequence), [1]);
    assert.equal(replay.body.events[0].eventType, 'created');
    assert.equal(replay.body.events[0].payload.action, 'generate');

    const unreroll = await createCommand(fixture, 'direct-unreroll', {
        action: 'unreroll',
        payload: { source: 'direct-unreroll-button' },
    });
    assert.equal(unreroll.response.status, 201);
    assert.equal(unreroll.body.action, 'unreroll');

    const manualTrigger = await createCommand(fixture, 'manual-trigger', {
        action: 'manual-trigger',
        payload: { manualName: 'community-action', triggerId: 'trigger-7' },
    });
    assert.equal(manualTrigger.response.status, 201);
    assert.equal(manualTrigger.body.action, 'manual-trigger');
    const loadedManualTrigger = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(manualTrigger.body.commandId)}`,
    );
    assert.deepEqual(loadedManualTrigger.body.payload, {
        manualName: 'community-action',
        triggerId: 'trigger-7',
    });

    const luaButton = await createCommand(fixture, 'lua-button', {
        action: 'lua-button',
        payload: { data: 'community-button-payload' },
    });
    assert.equal(luaButton.response.status, 201);
    assert.equal(luaButton.body.action, 'lua-button');
    const loadedLuaButton = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(luaButton.body.commandId)}`,
    );
    assert.deepEqual(loadedLuaButton.body.payload, { data: 'community-button-payload' });

    const suggestion = await createCommand(fixture, 'suggest', {
        action: 'suggest',
        payload: { databaseRevision: 7, force: false },
    });
    assert.equal(suggestion.response.status, 201);
    assert.equal(suggestion.body.action, 'suggest');
    const loadedSuggestion = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(suggestion.body.commandId)}`,
    );
    assert.deepEqual(loadedSuggestion.body.payload, { databaseRevision: 7, force: false });
});

test('cancel-by-request durably linearizes Stop before create and rejects payload collisions', {
    timeout: 20_000,
}, async () => {
    const directoryFixture = await createFixtureDirectory();
    const fixture = await startServerFixture(directoryFixture);

    const cancellation = await cancelCommandByRequest(fixture, 'ambiguous-create');
    assert.equal(cancellation.response.status, 200);
    assert.equal(cancellation.body.created, true);
    assert.equal(cancellation.body.command.state, 'cancelled');
    assert.deepEqual(cancellation.body.command.payload, {
        message: 'message-ambiguous-create',
        settings: { stream: true, temperature: 0.7 },
    });

    const delayedCreate = await createCommand(fixture, 'ambiguous-create');
    assert.equal(delayedCreate.response.status, 200);
    assert.equal(delayedCreate.body.reused, true);
    assert.equal(delayedCreate.body.commandId, cancellation.body.command.commandId);
    assert.equal(delayedCreate.body.state, 'cancelled');
    assert.deepEqual((await claimNext(fixture, 'resident-after-stop')).body, { claimed: false });

    const replay = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(delayedCreate.body.commandId)}/events?afterSequence=0`,
    );
    assert.deepEqual(replay.body.events.map((event) => event.eventType), ['cancelled']);
    assert.equal(replay.body.events[0].payload.previousState, 'unadmitted');

    const conflict = await cancelCommandByRequest(fixture, 'ambiguous-create', {
        payload: { message: 'different payload' },
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(conflict.body.existingCommandId, delayedCreate.body.commandId);

    await stopChild(fixture.child);
    const restarted = await startServerFixture(directoryFixture);
    const afterRestart = await createCommand(restarted, 'ambiguous-create');
    assert.equal(afterRestart.response.status, 200);
    assert.equal(afterRestart.body.reused, true);
    assert.equal(afterRestart.body.commandId, delayedCreate.body.commandId);
    assert.equal(afterRestart.body.state, 'cancelled');
    assert.deepEqual((await claimNext(restarted, 'resident-after-restart')).body, { claimed: false });
});

test('duplicate creation, a single global claimant, fencing, heartbeat, and two observers compose', {
    timeout: 25_000,
}, async () => {
    const fixture = await startServerFixture(null, {
        RISU_RUNTIME_EXECUTOR_IP: '127.0.0.1',
    });
    const roleScript = await fetch(`${fixture.baseUrl}/api/runtime-role.js`);
    assert.equal(roleScript.status, 200);
    assert.equal(
        await roleScript.text(),
        'globalThis.__RISU_RUNTIME_EXECUTOR_ATTESTED__=true;',
    );
    const healthBeforeClaim = await fetch(
        `${fixture.baseUrl}/runtime-generations/executor/health`,
    );
    assert.equal(healthBeforeClaim.status, 503);
    assert.deepEqual(await healthBeforeClaim.json(), { ready: false, ageMs: null });
    const first = await createCommand(fixture, 'shared');
    assert.equal(first.response.status, 201);
    assert.equal(first.body.state, 'queued');
    assert.equal(first.body.reused, false);

    const duplicate = await createCommand(fixture, 'shared', {
        payload: {
            settings: { temperature: 0.7, stream: true },
            message: 'message-shared',
        },
    });
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.reused, true);
    assert.equal(duplicate.body.commandId, first.body.commandId);

    const conflict = await createCommand(fixture, 'shared', {
        payload: { message: 'different' },
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(conflict.body.existingCommandId, first.body.commandId);

    const [desktop, phone] = await Promise.all([
        openCommandSocket(fixture, first.body.commandId, 'desktop'),
        openCommandSocket(fixture, first.body.commandId, 'phone'),
    ]);
    await Promise.all([
        desktop.waitFor((message) => message.eventType === 'created'),
        phone.waitFor((message) => message.eventType === 'created'),
    ]);
    const reusedTicketUrl = `ws://127.0.0.1:${fixture.port}${desktop.ticket.path}`
        + `?ticket=${encodeURIComponent(desktop.ticket.ticket)}&afterSequence=0`;
    await expectWebSocketRejection(reusedTicketUrl, 401);

    const [claimA, claimB] = await Promise.all([
        claimNext(fixture, 'executor-a'),
        claimNext(fixture, 'executor-b'),
    ]);
    const claims = [claimA.body, claimB.body];
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    const winner = claims.find((claim) => claim.claimed);
    const loserExecutor = winner.lease.executorId === 'executor-a' ? 'executor-b' : 'executor-a';
    assert.equal(winner.command.commandId, first.body.commandId);
    assert.equal(winner.command.payload.message, 'message-shared');
    assert.equal(winner.command.executorId, null);
    assert.equal(winner.command.fencingToken, null);
    assert.equal(winner.command.leaseExpiresAt, null);
    assert.ok(Number.isSafeInteger(winner.lease.fencingToken));
    const healthAfterClaim = await fetch(
        `${fixture.baseUrl}/runtime-generations/executor/health`,
    );
    assert.equal(healthAfterClaim.status, 200);
    assert.equal((await healthAfterClaim.json()).ready, true);

    const publicRunning = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(first.body.commandId)}`,
        { method: 'GET' },
    );
    assert.equal(publicRunning.response.status, 200);
    assert.equal(publicRunning.body.executorId, null);
    assert.equal(publicRunning.body.fencingToken, null);
    assert.equal(publicRunning.body.leaseExpiresAt, null);

    const runningEvents = await Promise.all([
        desktop.waitFor((message) => message.eventType === 'running'),
        phone.waitFor((message) => message.eventType === 'running'),
    ]);
    for (const event of runningEvents) {
        assert.equal(event.payload.executorId, undefined);
        assert.equal(event.payload.fencingToken, undefined);
        assert.equal(event.payload.leaseExpiresAt, undefined);
    }

    const heartbeat = await requestJson(fixture, '/runtime-generations/executor/heartbeat', {
        body: {
            commandId: first.body.commandId,
            executorId: winner.lease.executorId,
            fencingToken: winner.lease.fencingToken,
            leaseDurationMs: 8_000,
        },
    });
    assert.equal(heartbeat.response.status, 200);
    assert.ok(heartbeat.body.lease.expiresAt > winner.lease.expiresAt);

    const stale = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(first.body.commandId)}/progress`,
        {
            body: {
                executorId: loserExecutor,
                fencingToken: winner.lease.fencingToken,
                eventType: 'token',
                payload: { text: 'forged' },
            },
        },
    );
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.code, 'STALE_EXECUTOR_FENCE');

    const progress = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(first.body.commandId)}/progress`,
        {
            body: {
                executorId: winner.lease.executorId,
                fencingToken: winner.lease.fencingToken,
                eventType: 'token',
                payload: { text: 'hello' },
            },
        },
    );
    assert.equal(progress.response.status, 200);

    const completed = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(first.body.commandId)}/complete`,
        {
            body: {
                executorId: winner.lease.executorId,
                fencingToken: winner.lease.fencingToken,
                result: { messageId: 'message-final', text: 'hello' },
            },
        },
    );
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.command.state, 'completed');

    await Promise.all([
        desktop.waitFor((message) => message.eventType === 'completed'),
        phone.waitFor((message) => message.eventType === 'completed'),
    ]);
    for (const observer of [desktop, phone]) {
        const events = generationEvents(observer);
        assert.deepEqual(events.map((event) => event.eventType), [
            'created',
            'running',
            'token',
            'completed',
        ]);
        assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
        await closeSocket(observer.ws);
    }

    const replayA = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(first.body.commandId)}/events?afterSequence=0`,
    );
    const replayB = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(first.body.commandId)}/events?afterSequence=0`,
    );
    assert.deepEqual(replayA.body, replayB.body);
    assert.deepEqual(replayA.body.events.map((event) => event.sequence), [1, 2, 3, 4]);
    for (const event of replayA.body.events) {
        assert.equal(event.payload.executorId, undefined);
        assert.equal(event.payload.fencingToken, undefined);
        assert.equal(event.payload.leaseExpiresAt, undefined);
    }
});

test('claim-next expires a lease, broadcasts interruption, advances the fence, and never requeues it', {
    timeout: 20_000,
}, async () => {
    const fixture = await startServerFixture();
    const first = await createCommand(fixture, 'expires-first');
    const second = await createCommand(fixture, 'expires-second');
    const observer = await openCommandSocket(fixture, first.body.commandId, 'observer');
    const firstClaim = await claimNext(fixture, 'old-executor', 100);
    assert.equal(firstClaim.body.claimed, true);

    await new Promise((resolve) => setTimeout(resolve, 140));
    const secondClaim = await claimNext(fixture, 'new-executor', 5_000);
    assert.equal(secondClaim.body.claimed, true);
    assert.equal(secondClaim.body.command.commandId, second.body.commandId);
    assert.ok(secondClaim.body.lease.fencingToken > firstClaim.body.lease.fencingToken);
    const secondObserver = await openCommandSocket(fixture, second.body.commandId, 'second-observer');

    const interruptedEvent = await observer.waitFor((message) => message.eventType === 'interrupted');
    assert.equal(interruptedEvent.payload.reason, 'lease_expired');
    assert.equal(interruptedEvent.payload.executorId, undefined);
    assert.equal(interruptedEvent.payload.fencingToken, undefined);
    assert.equal(interruptedEvent.payload.leaseExpiresAt, undefined);
    const interrupted = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(first.body.commandId)}`,
    );
    assert.equal(interrupted.body.state, 'interrupted');

    const staleProgress = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(first.body.commandId)}/progress`,
        {
            body: {
                executorId: 'old-executor',
                fencingToken: firstClaim.body.lease.fencingToken,
                eventType: 'token',
                payload: { text: 'late' },
            },
        },
    );
    assert.equal(staleProgress.response.status, 409);
    assert.equal(staleProgress.body.reason, 'command_interrupted');

    const listed = await requestJson(fixture, '/runtime-generations?state=queued');
    assert.equal(listed.body.commands.some((command) => command.commandId === first.body.commandId), false);

    const cancelled = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(second.body.commandId)}`,
        { method: 'DELETE' },
    );
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.body.command.state, 'running');
    assert.notEqual(cancelled.body.command.cancelRequestedAt, null);
    const cancelRequestedEvent = await secondObserver.waitFor(
        (message) => message.eventType === 'cancel_requested',
    );
    assert.equal(cancelRequestedEvent.payload.reason, 'user_cancel');
    const blockedReplacement = await claimNext(fixture, 'replacement-before-cancel-complete');
    assert.deepEqual(blockedReplacement.body, { claimed: false });

    const fencedAfterCancel = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(second.body.commandId)}/complete`,
        {
            body: {
                executorId: secondClaim.body.lease.executorId,
                fencingToken: secondClaim.body.lease.fencingToken,
                result: {},
            },
        },
    );
    assert.equal(fencedAfterCancel.response.status, 409);
    assert.equal(fencedAfterCancel.body.code, 'INVALID_COMMAND_STATE');

    const cancelComplete = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(second.body.commandId)}/cancel-complete`,
        {
            body: {
                executorId: secondClaim.body.lease.executorId,
                fencingToken: secondClaim.body.lease.fencingToken,
                result: { databaseRevision: 9, canonicalMutationPersisted: true },
            },
        },
    );
    assert.equal(cancelComplete.response.status, 200);
    assert.equal(cancelComplete.body.command.state, 'cancelled');
    assert.deepEqual(cancelComplete.body.command.result, {
        databaseRevision: 9,
        canonicalMutationPersisted: true,
    });
    await secondObserver.waitFor((message) => message.eventType === 'cancelled');
    await closeSocket(observer.ws);
    await closeSocket(secondObserver.ws);
});

test('input_committed is validated, replayable, idempotent, and survives cancel_requested', {
    timeout: 20_000,
}, async () => {
    const fixture = await startServerFixture();
    const created = await createCommand(fixture, 'input-committed', {
        payload: { input: 'hello', databaseRevision: 12 },
    });
    const commandId = created.body.commandId;
    const observer = await openCommandSocket(fixture, commandId, 'input-observer');
    const claim = await claimNext(fixture, 'resident-input');
    const credentials = claim.body.lease;

    const executionStarted = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/progress`,
        {
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                eventType: 'execution_started',
                payload: { databaseRevision: 12 },
            },
        },
    );
    assert.equal(executionStarted.response.status, 200);
    const cancelRequested = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}`,
        { method: 'DELETE' },
    );
    assert.equal(cancelRequested.body.command.state, 'running');

    const marker = {
        databaseRevision: 13,
        messageIndex: 4,
        messageId: 'request-input-committed',
    };
    const committed = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/progress`,
        {
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                eventType: 'input_committed',
                payload: marker,
            },
        },
    );
    assert.equal(committed.response.status, 200);
    assert.equal(committed.body.reused, false);
    assert.deepEqual(committed.body.event.payload, marker);

    const duplicate = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/progress`,
        {
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                eventType: 'input_committed',
                payload: marker,
            },
        },
    );
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.reused, true);
    assert.equal(duplicate.body.event.sequence, committed.body.event.sequence);

    const conflicting = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/progress`,
        {
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                eventType: 'input_committed',
                payload: { ...marker, messageIndex: marker.messageIndex + 1 },
            },
        },
    );
    assert.equal(conflicting.response.status, 409);
    assert.equal(conflicting.body.code, 'INPUT_COMMIT_CONFLICT');
    const malformed = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/progress`,
        {
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                eventType: 'input_committed',
                payload: { ...marker, messageIndex: -1 },
            },
        },
    );
    assert.equal(malformed.response.status, 400);

    const observed = await observer.waitFor((message) => message.eventType === 'input_committed');
    assert.deepEqual(observed.payload, marker);
    assert.deepEqual(
        generationEvents(observer).map((event) => event.eventType),
        ['created', 'running', 'execution_started', 'cancel_requested', 'input_committed'],
    );
    const cancelled = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/cancel-complete`,
        {
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                result: { databaseRevision: 13, canonicalMutationPersisted: true },
            },
        },
    );
    assert.equal(cancelled.response.status, 200);
    await closeSocket(observer.ws);
});

test('resident UI prompts are validated, replayable, and accept only the first device response', {
    timeout: 20_000,
}, async () => {
    const fixture = await startServerFixture();
    const created = await createCommand(fixture, 'ui-prompt');
    const commandId = created.body.commandId;
    const [desktop, phone] = await Promise.all([
        openCommandSocket(fixture, commandId, 'desktop-prompt'),
        openCommandSocket(fixture, commandId, 'phone-prompt'),
    ]);
    const claim = await claimNext(fixture, 'resident-ui');
    const credentials = claim.body.lease;

    const errorNotice = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/progress`,
        {
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                eventType: 'ui_notice',
                payload: { notice: { type: 'error', msg: 'Plugin warning' } },
            },
        },
    );
    assert.equal(errorNotice.response.status, 200);

    const invalidPrompt = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/progress`,
        {
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                eventType: 'ui_prompt',
                payload: {
                    promptId: 'prompt-invalid',
                    prompt: { type: 'toast', msg: 'not interactive' },
                },
            },
        },
    );
    assert.equal(invalidPrompt.response.status, 400);

    const issued = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/progress`,
        {
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                eventType: 'ui_prompt',
                payload: {
                    promptId: 'prompt-shared',
                    prompt: {
                        type: 'input',
                        msg: 'Enter low-level value',
                        defaultValue: 'seed',
                        datalist: [['a', 'A']],
                    },
                },
            },
        },
    );
    assert.equal(issued.response.status, 200);
    assert.equal(issued.body.reused, false);
    const prompts = await Promise.all([
        desktop.waitFor((message) => message.eventType === 'ui_prompt'),
        phone.waitFor((message) => message.eventType === 'ui_prompt'),
    ]);
    for (const prompt of prompts) {
        assert.equal(prompt.payload.promptId, 'prompt-shared');
        assert.equal(prompt.payload.prompt.type, 'input');
        assert.equal(prompt.payload.executorId, undefined);
        assert.equal(prompt.payload.fencingToken, undefined);
    }

    const unauthenticated = await fetch(
        `${fixture.baseUrl}/runtime-generations/${encodeURIComponent(commandId)}`
        + '/ui-prompts/prompt-shared/response',
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ response: 'stolen' }),
        },
    );
    assert.ok([400, 401].includes(unauthenticated.status));

    const responsePath = `/runtime-generations/${encodeURIComponent(commandId)}`
        + '/ui-prompts/prompt-shared/response';
    const canarySecret = 'SENSITIVE-MCP-API-KEY-canary-9f8d7c';
    const [desktopResponse, phoneResponse] = await Promise.all([
        requestJson(fixture, responsePath, { body: { response: canarySecret } }),
        requestJson(fixture, responsePath, { body: { response: canarySecret } }),
    ]);
    assert.equal(desktopResponse.response.status, 200);
    assert.equal(phoneResponse.response.status, 200);
    assert.equal(
        [desktopResponse.body, phoneResponse.body].filter((body) => body.accepted).length,
        1,
    );
    assert.deepEqual(desktopResponse.body.event.payload, {
        promptId: 'prompt-shared',
        responded: true,
    });
    assert.deepEqual(phoneResponse.body.event.payload, desktopResponse.body.event.payload);
    assert.equal(JSON.stringify(desktopResponse.body).includes(canarySecret), false);
    assert.equal(JSON.stringify(phoneResponse.body).includes(canarySecret), false);

    const responseEvents = await Promise.all([
        desktop.waitFor((message) => message.eventType === 'ui_prompt_response'),
        phone.waitFor((message) => message.eventType === 'ui_prompt_response'),
    ]);
    for (const responseEvent of responseEvents) {
        assert.deepEqual(responseEvent.payload, {
            promptId: 'prompt-shared',
            responded: true,
        });
        assert.equal(JSON.stringify(responseEvent).includes(canarySecret), false);
    }

    const mailboxPath = `/runtime-generations/${encodeURIComponent(commandId)}`
        + '/ui-prompts/prompt-shared/consume-response';
    const forgedMailboxRead = await requestJson(fixture, mailboxPath, {
        body: {
            executorId: 'forged-resident',
            fencingToken: credentials.fencingToken,
        },
    });
    assert.equal(forgedMailboxRead.response.status, 409);
    const mailboxRead = await requestJson(fixture, mailboxPath, {
        body: {
            executorId: credentials.executorId,
            fencingToken: credentials.fencingToken,
        },
    });
    assert.equal(mailboxRead.response.status, 200);
    assert.equal(mailboxRead.body.response, canarySecret);
    const mailboxRetry = await requestJson(fixture, mailboxPath, {
        body: {
            executorId: credentials.executorId,
            fencingToken: credentials.fencingToken,
        },
    });
    assert.equal(mailboxRetry.body.response, canarySecret);

    const replay = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/events?afterSequence=0`,
    );
    assert.deepEqual(
        replay.body.events.map((event) => event.eventType),
        ['created', 'running', 'ui_notice', 'ui_prompt', 'ui_prompt_response'],
    );
    assert.equal(JSON.stringify(replay.body).includes(canarySecret), false);
    const persistedEvents = await fs.readFile(path.join(
        fixture.savePath,
        '__runtime_generations',
        commandId,
        'events.ndjson',
    ), 'utf8');
    assert.equal(persistedEvents.includes(canarySecret), false);
    await Promise.all([closeSocket(desktop.ws), closeSocket(phone.ws)]);
});

test('private TTS presentation is claim-race safe, journal-free, and consumed once by its admitting client', {
    timeout: 20_000,
}, async () => {
    let releaseCreateRoute;
    const createRouteBarrier = new Promise((resolve) => {
        releaseCreateRoute = resolve;
    });
    let underlyingCreateCommitted;
    const underlyingCreateCommit = new Promise((resolve) => {
        underlyingCreateCommitted = resolve;
    });
    const fixture = await startInProcessServerFixture({
        decorateStore: (store) => new Proxy(store, {
            get(target, property) {
                if (property === 'create') {
                    return async (input) => {
                        const created = await target.create(input);
                        underlyingCreateCommitted();
                        await createRouteBarrier;
                        return created;
                    };
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }),
    });
    const token = 'presentation-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const otherToken = 'presentation-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const slashSecret = 'slash-speech-canary-DO-NOT-PERSIST';
    const actionSecret = 'resolved-speech-canary-DO-NOT-PERSIST';
    const requestBody = {
        requestId: 'request-private-presentation',
        action: 'send',
        characterId: 'character-1',
        chatId: 'chat-1',
        payload: {
            input: `/pass ${slashSecret} | /speak`,
            databaseRevision: 7,
        },
    };

    // Start claim while create still owns the store operation. The mailbox is
    // provisioned before durable create, so whichever continuation resumes
    // first cannot expose a false presentationChannel to the executor.
    const createPending = requestJson(fixture, '/runtime-generations', {
        headers: { 'X-Risu-Runtime-Presentation-Token': token },
        body: requestBody,
    });
    await underlyingCreateCommit;
    const conflictingPrivateInput = await requestJson(fixture, '/runtime-generations', {
        headers: { 'X-Risu-Runtime-Presentation-Token': otherToken },
        body: {
            ...requestBody,
            payload: {
                ...requestBody.payload,
                input: '/speak conflicting-private-input-must-not-run',
            },
        },
    });
    assert.equal(conflictingPrivateInput.response.status, 409);
    assert.equal(conflictingPrivateInput.body.code, 'IDEMPOTENCY_CONFLICT');
    const claim = await claimNext(fixture, 'resident-private-presentation');
    releaseCreateRoute();
    const created = await createPending;
    assert.equal(created.response.status, 201);
    assert.equal(created.body.presentationChannel, true);
    assert.equal(claim.body.claimed, true);
    assert.equal(claim.body.command.presentationChannel, true);
    assert.equal(claim.body.command.payload.input, requestBody.payload.input);
    const commandId = created.body.commandId;
    const credentials = claim.body.lease;

    const duplicate = await requestJson(fixture, '/runtime-generations', {
        headers: { 'X-Risu-Runtime-Presentation-Token': otherToken },
        body: requestBody,
    });
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.reused, true);
    assert.equal(duplicate.body.presentationChannel, false);

    const observer = await openCommandSocket(fixture, commandId, 'presentation-follower');
    const published = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}`
            + '/presentation/action-1',
        {
            method: 'PUT',
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                action: {
                    type: 'speak',
                    characterId: 'character-1',
                    text: actionSecret,
                },
            },
        },
    );
    assert.equal(published.response.status, 201);

    const publicRunning = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}`,
    );
    assert.equal(publicRunning.body.payload.input, '');
    assert.equal(JSON.stringify(publicRunning.body).includes(slashSecret), false);
    assert.equal(JSON.stringify(publicRunning.body).includes(actionSecret), false);

    const completed = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/complete`,
        {
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                result: {
                    generated: false,
                    commandProcessed: true,
                    databaseRevision: 7,
                    canonicalMutationPersisted: false,
                },
            },
        },
    );
    assert.equal(completed.response.status, 200);
    await observer.waitFor((message) => message.eventType === 'completed');

    const replay = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/events?afterSequence=0`,
    );
    for (const publicValue of [
        created.body,
        completed.body,
        replay.body,
        observer.messages,
    ]) {
        const serialized = JSON.stringify(publicValue);
        assert.equal(serialized.includes(slashSecret), false);
        assert.equal(serialized.includes(actionSecret), false);
    }
    const durableGenerationFiles = await readDirectoryText(
        path.join(fixture.savePath, '__runtime_generations'),
    );
    assert.equal(durableGenerationFiles.includes(slashSecret), false);
    assert.equal(durableGenerationFiles.includes(actionSecret), false);

    const wrongConsumer = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/presentation/consume`,
        {
            headers: { 'X-Risu-Runtime-Presentation-Token': otherToken },
            body: {},
        },
    );
    assert.equal(wrongConsumer.response.status, 404);

    const consumeOptions = {
        headers: { 'X-Risu-Runtime-Presentation-Token': token },
        body: {},
    };
    const consumed = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/presentation/consume`,
        consumeOptions,
    );
    assert.equal(consumed.response.status, 200);
    assert.deepEqual(consumed.body.actions, [{
        type: 'speak',
        characterId: 'character-1',
        text: actionSecret,
    }]);
    const responseLossRetry = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/presentation/consume`,
        consumeOptions,
    );
    assert.deepEqual(responseLossRetry.body, consumed.body);

    const acknowledged = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/presentation/consume`,
        {
            method: 'DELETE',
            headers: { 'X-Risu-Runtime-Presentation-Token': token },
        },
    );
    assert.equal(acknowledged.response.status, 200);
    const consumedAgain = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/presentation/consume`,
        consumeOptions,
    );
    assert.equal(consumedAgain.response.status, 404);

    const noTokenSecret = 'headerless-speech-canary-DO-NOT-PERSIST';
    const noTokenCreate = await requestJson(fixture, '/runtime-generations', {
        body: {
            requestId: 'request-headerless-private-presentation',
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: {
                input: `/speak ${noTokenSecret}`,
                databaseRevision: 7,
            },
        },
    });
    assert.equal(noTokenCreate.response.status, 201);
    assert.equal(JSON.stringify(noTokenCreate.body).includes(noTokenSecret), false);
    const noTokenClaim = await claimNext(fixture, 'resident-headerless-private');
    assert.equal(noTokenClaim.body.command.payload.input, `/speak ${noTokenSecret}`);
    assert.equal(noTokenClaim.body.command.presentationChannel, false);
    await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(noTokenCreate.body.commandId)}/complete`,
        {
            body: {
                executorId: noTokenClaim.body.lease.executorId,
                fencingToken: noTokenClaim.body.lease.fencingToken,
                result: { databaseRevision: 7, canonicalMutationPersisted: false },
            },
        },
    );
    const durableAfterHeaderless = await readDirectoryText(
        path.join(fixture.savePath, '__runtime_generations'),
    );
    assert.equal(durableAfterHeaderless.includes(noTokenSecret), false);
    await closeSocket(observer.ws);
});

test('failed and expired presentation mailboxes drop audio, and private slash input fails closed after restart', {
    timeout: 25_000,
}, async () => {
    const token = 'presentation-token-cccccccccccccccccccccccccccccccc';
    const failedFixture = await startInProcessServerFixture({
        presentationMailboxTtlMs: 25,
    });
    const failedCreate = await requestJson(failedFixture, '/runtime-generations', {
        headers: { 'X-Risu-Runtime-Presentation-Token': token },
        body: {
            requestId: 'request-failed-presentation',
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'ordinary input', databaseRevision: 4 },
        },
    });
    const failedClaim = await claimNext(failedFixture, 'resident-failed-presentation');
    const failedId = failedCreate.body.commandId;
    const failedCredentials = failedClaim.body.lease;
    await requestJson(
        failedFixture,
        `/runtime-generations/${encodeURIComponent(failedId)}/presentation/action-failed`,
        {
            method: 'PUT',
            body: {
                executorId: failedCredentials.executorId,
                fencingToken: failedCredentials.fencingToken,
                action: {
                    type: 'speak',
                    characterId: 'character-1',
                    text: 'must-never-play-after-failure',
                },
            },
        },
    );
    await requestJson(
        failedFixture,
        `/runtime-generations/${encodeURIComponent(failedId)}/fail`,
        {
            body: {
                executorId: failedCredentials.executorId,
                fencingToken: failedCredentials.fencingToken,
                error: 'provider failed',
                details: { databaseRevision: 4, canonicalMutationPersisted: false },
            },
        },
    );
    const afterFailure = await requestJson(
        failedFixture,
        `/runtime-generations/${encodeURIComponent(failedId)}/presentation/consume`,
        {
            headers: { 'X-Risu-Runtime-Presentation-Token': token },
            body: {},
        },
    );
    assert.equal(afterFailure.response.status, 404);

    const expiringCreate = await requestJson(failedFixture, '/runtime-generations', {
        headers: { 'X-Risu-Runtime-Presentation-Token': token },
        body: {
            requestId: 'request-expiring-presentation',
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'ordinary input 2', databaseRevision: 4 },
        },
    });
    const expiringClaim = await claimNext(failedFixture, 'resident-expiring-presentation');
    await requestJson(
        failedFixture,
        `/runtime-generations/${encodeURIComponent(expiringCreate.body.commandId)}/complete`,
        {
            body: {
                executorId: expiringClaim.body.lease.executorId,
                fencingToken: expiringClaim.body.lease.fencingToken,
                result: { databaseRevision: 4, canonicalMutationPersisted: false },
            },
        },
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const afterExpiry = await requestJson(
        failedFixture,
        `/runtime-generations/${encodeURIComponent(expiringCreate.body.commandId)}`
            + '/presentation/consume',
        {
            headers: { 'X-Risu-Runtime-Presentation-Token': token },
            body: {},
        },
    );
    assert.equal(afterExpiry.response.status, 404);

    const directoryFixture = await createFixtureDirectory();
    const firstServer = await startServerFixture(directoryFixture);
    const restartSecret = 'restart-private-speech-DO-NOT-PERSIST';
    const beforeRestart = await requestJson(firstServer, '/runtime-generations', {
        headers: { 'X-Risu-Runtime-Presentation-Token': token },
        body: {
            requestId: 'request-restart-private-input',
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: {
                input: `/speak ${restartSecret}`,
                databaseRevision: 9,
            },
        },
    });
    await stopChild(firstServer.child);
    const restarted = await startServerFixture(directoryFixture);
    const restartedClaim = await claimNext(restarted, 'resident-after-private-restart');
    assert.deepEqual(restartedClaim.body, { claimed: false });
    const failedAfterRestart = await requestJson(
        restarted,
        `/runtime-generations/${encodeURIComponent(beforeRestart.body.commandId)}`,
    );
    assert.equal(failedAfterRestart.body.state, 'failed');
    assert.equal(JSON.stringify(failedAfterRestart.body).includes(restartSecret), false);
    assert.equal(firstServer.output.join('').includes(restartSecret), false);
    assert.equal(restarted.output.join('').includes(restartSecret), false);
    const restartedDurableFiles = await readDirectoryText(
        path.join(directoryFixture.savePath, '__runtime_generations'),
    );
    assert.equal(restartedDurableFiles.includes(restartSecret), false);
});

test('assistant output snapshots are fenced, monotonic, active-only, and kept outside the event log', {
    timeout: 30_000,
}, async () => {
    const directoryFixture = await createFixtureDirectory();
    const fixture = await startServerFixture(directoryFixture);
    const created = await createCommand(fixture, 'assistant-output');
    const commandId = created.body.commandId;
    const outputPath = `/runtime-generations/${encodeURIComponent(commandId)}/output`;

    const unauthenticated = await fetch(`${fixture.baseUrl}${outputPath}`);
    assert.ok([400, 401].includes(unauthenticated.status));
    const empty = await requestJson(fixture, outputPath);
    assert.equal(empty.response.status, 200);
    assert.deepEqual(empty.body, { output: null });

    const observer = await openCommandSocket(fixture, commandId, 'assistant-output-observer');
    const claim = await claimNext(fixture, 'resident-assistant-output', 60_000);
    const credentials = claim.body.lease;
    await observer.waitFor((message) => message.eventType === 'running');

    const forged = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: generationOutputBody({
            executorId: 'forged-resident',
            fencingToken: credentials.fencingToken,
        }, 1),
    });
    assert.equal(forged.response.status, 409);
    assert.equal(forged.body.code, 'STALE_EXECUTOR_FENCE');

    const firstBody = generationOutputBody(credentials, 1, {
        messages: [
            generationOutputMessage(1),
            generationOutputMessage(1, {
                messageId: 'assistant-message-2',
                messageIndex: 2,
                data: 'second assistant partial',
                generationInfo: {
                    generationId: 'generation-output-2',
                    model: 'integration-model',
                },
            }),
        ],
    });
    const first = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: firstBody,
    });
    assert.equal(first.response.status, 201);
    assert.equal(first.body.reused, false);
    assert.deepEqual(first.body.output, {
        type: 'generation_output',
        commandId,
        version: firstBody.version,
        messages: firstBody.messages,
        timestamp: first.body.output.timestamp,
    });
    assert.ok(Number.isFinite(first.body.output.timestamp));
    const observedFirst = await observer.waitFor(
        (message) => message.type === 'generation_output' && message.version === 1,
    );
    assert.equal(observedFirst.sequence, undefined);
    assert.deepEqual(observedFirst.messages, firstBody.messages);

    const retry = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: firstBody,
    });
    assert.equal(retry.response.status, 200);
    assert.equal(retry.body.reused, true);
    assert.deepEqual(retry.body.output, first.body.output);

    const conflict = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: {
            ...firstBody,
            messages: firstBody.messages.map((message, index) => index === 0
                ? { ...message, data: 'same-version-conflict' }
                : message),
        },
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, 'OUTPUT_VERSION_CONFLICT');
    assert.equal(conflict.body.version, 1);
    assert.equal(conflict.body.currentVersion, 1);

    const thirdBody = generationOutputBody(credentials, 3, {
        data: 'assistant-version-three',
        optimizationMode: 'strong',
    });
    const third = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: thirdBody,
    });
    assert.equal(third.response.status, 201);
    const observedThird = await observer.waitFor(
        (message) => message.type === 'generation_output' && message.version === 3,
    );
    assert.equal(observedThird.messages[0].data, thirdBody.messages[0].data);

    const stale = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: generationOutputBody(credentials, 2),
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.code, 'STALE_OUTPUT_VERSION');
    assert.equal(stale.body.currentVersion, 3);

    const oversized = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: generationOutputBody(credentials, 4, {
            data: 'x'.repeat((2 * 1024 * 1024) + 1),
        }),
    });
    assert.equal(oversized.response.status, 413);

    const loaded = await requestJson(fixture, outputPath);
    assert.deepEqual(loaded.body.output, third.body.output);
    const replay = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/events?afterSequence=0`,
    );
    assert.deepEqual(
        replay.body.events.map((event) => event.eventType),
        ['created', 'running'],
    );
    const persistedEvents = await fs.readFile(path.join(
        fixture.savePath,
        '__runtime_generations',
        commandId,
        'events.ndjson',
    ), 'utf8');
    assert.equal(persistedEvents.includes(thirdBody.messages[0].data), false);

    const cancelRequested = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}`,
        { method: 'DELETE' },
    );
    assert.notEqual(cancelRequested.body.command.cancelRequestedAt, null);
    const afterCancel = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: generationOutputBody(credentials, 4, { data: 'final-cancelled-partial' }),
    });
    assert.equal(afterCancel.response.status, 201);
    const observedAfterCancel = await observer.waitFor(
        (message) => message.type === 'generation_output' && message.version === 4,
    );
    assert.equal(observedAfterCancel.messages[0].data, 'final-cancelled-partial');
    assert.deepEqual((await requestJson(fixture, outputPath)).body.output, afterCancel.body.output);
    const cancelled = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/cancel-complete`,
        {
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                result: { canonicalMutationPersisted: true },
            },
        },
    );
    assert.equal(cancelled.response.status, 200);
    const afterTerminal = await requestJson(fixture, outputPath);
    assert.deepEqual(afterTerminal.body, { output: null });
    await assert.rejects(fs.stat(path.join(
        fixture.savePath,
        '__runtime_generations',
        commandId,
        'output.json',
    )), { code: 'ENOENT' });
    await closeSocket(observer.ws);

    await stopChild(fixture.child);
    const restarted = await startServerFixture(directoryFixture);
    const recovered = await requestJson(restarted, outputPath);
    assert.equal(recovered.response.status, 200);
    assert.deepEqual(recovered.body, { output: null });
    const replayConnection = await openCommandSocket(
        restarted,
        commandId,
        'assistant-output-after-restart',
    );
    await replayConnection.waitFor((message) => message.eventType === 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
        replayConnection.messages.some((message) => message.type === 'generation_output'),
        false,
    );
    assert.equal(replayConnection.messages[0].state, 'cancelled');
    await closeSocket(replayConnection.ws);
});

test('WebSocket preparation keeps only the newest assistant output published during replay', {
    timeout: 20_000,
}, async () => {
    const fixture = await startInProcessServerFixture();
    const created = await createCommand(fixture, 'assistant-output-race');
    const commandId = created.body.commandId;
    const outputPath = `/runtime-generations/${encodeURIComponent(commandId)}/output`;
    const claim = await claimNext(fixture, 'resident-output-race');
    const credentials = claim.body.lease;
    const initial = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: generationOutputBody(credentials, 1),
    });
    assert.equal(initial.response.status, 201);

    const originalGetOutput = fixture.store.getOutput.bind(fixture.store);
    let releasePreparation;
    const preparationBarrier = new Promise((resolve) => {
        releasePreparation = resolve;
    });
    let markPreparationStarted;
    const preparationStarted = new Promise((resolve) => {
        markPreparationStarted = resolve;
    });
    let blockNextGetOutput = true;
    fixture.store.getOutput = async (requestedCommandId) => {
        const output = await originalGetOutput(requestedCommandId);
        if (blockNextGetOutput) {
            blockNextGetOutput = false;
            markPreparationStarted();
            await preparationBarrier;
        }
        return output;
    };

    const observer = await openCommandSocket(fixture, commandId, 'output-race-observer');
    await preparationStarted;
    const second = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: generationOutputBody(credentials, 2),
    });
    assert.equal(second.response.status, 201);
    const fifthBody = generationOutputBody(credentials, 5, {
        messages: [
            generationOutputMessage(5),
            generationOutputMessage(5, {
                messageId: 'assistant-message-2',
                messageIndex: 2,
                data: 'second replayed assistant',
            }),
        ],
    });
    const fifth = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: fifthBody,
    });
    assert.equal(fifth.response.status, 201);
    releasePreparation();

    const preparedOutput = await observer.waitFor(
        (message) => message.type === 'generation_output',
    );
    assert.equal(preparedOutput.version, 5);
    assert.deepEqual(preparedOutput.messages, fifthBody.messages);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
        observer.messages
            .filter((message) => message.type === 'generation_output')
            .map((message) => message.version),
        [5],
    );

    const sixth = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: generationOutputBody(credentials, 6),
    });
    assert.equal(sixth.response.status, 201);
    const liveOutput = await observer.waitFor(
        (message) => message.type === 'generation_output' && message.version === 6,
    );
    assert.equal(liveOutput.messages[0].data, 'assistant-partial-6');
    await closeSocket(observer.ws);
});

test('a backpressured output socket closes and recovers from durable latest/terminal state', {
    timeout: 20_000,
}, async () => {
    // Zero is a deterministic fault-injection threshold: the first live output
    // is persisted, but the ready socket must be dropped instead of enqueueing
    // a cumulative frame. Production uses a bounded positive high-water mark.
    const fixture = await startInProcessServerFixture({
        webSocketOutputBufferHighWaterBytes: 0,
    });
    const created = await createCommand(fixture, 'assistant-output-backpressure');
    const commandId = created.body.commandId;
    const outputPath = `/runtime-generations/${encodeURIComponent(commandId)}/output`;
    const observer = await openCommandSocket(fixture, commandId, 'slow-output-observer');
    const claim = await claimNext(fixture, 'resident-output-backpressure');
    const credentials = claim.body.lease;
    await observer.waitFor((message) => message.eventType === 'running');

    const socketClosed = once(observer.ws, 'close');
    const published = await requestJson(fixture, outputPath, {
        method: 'PUT',
        body: generationOutputBody(credentials, 1, {
            messages: [
                generationOutputMessage(1),
                generationOutputMessage(1, {
                    messageId: 'assistant-message-2',
                    messageIndex: 2,
                    data: 'second backpressured assistant',
                }),
            ],
        }),
    });
    assert.equal(published.response.status, 201);
    await socketClosed;
    sockets.delete(observer.ws);

    const hydrated = await requestJson(fixture, outputPath);
    assert.deepEqual(hydrated.body.output, published.body.output);
    assert.equal(hydrated.body.output.messages.length, 2);

    const completed = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(commandId)}/complete`,
        {
            body: {
                executorId: credentials.executorId,
                fencingToken: credentials.fencingToken,
                result: { databaseRevision: 17, canonicalMutationPersisted: true },
            },
        },
    );
    assert.equal(completed.response.status, 200);
    assert.deepEqual((await requestJson(fixture, outputPath)).body, { output: null });

    const recovered = await openCommandSocket(
        fixture,
        commandId,
        'backpressure-terminal-reconnect',
    );
    await recovered.waitFor((message) => message.eventType === 'completed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(recovered.messages[0].state, 'completed');
    assert.equal(
        recovered.messages.some((message) => message.type === 'generation_output'),
        false,
    );
    await closeSocket(recovered.ws);
});

test('restart retains completed commands, interrupts running work, and preserves fencing order', {
    timeout: 25_000,
}, async () => {
    const directoryFixture = await createFixtureDirectory();
    const firstServer = await startServerFixture(directoryFixture);

    const completedInput = await createCommand(firstServer, 'completed-before-restart');
    const completedClaim = await claimNext(firstServer, 'executor-before-complete');
    const completedResponse = await requestJson(
        firstServer,
        `/runtime-generations/${encodeURIComponent(completedInput.body.commandId)}/complete`,
        {
            body: {
                executorId: completedClaim.body.lease.executorId,
                fencingToken: completedClaim.body.lease.fencingToken,
                result: { durable: true },
            },
        },
    );
    assert.equal(completedResponse.response.status, 200);

    const runningInput = await createCommand(firstServer, 'running-at-restart');
    const runningClaim = await claimNext(firstServer, 'executor-before-restart', 60_000);
    assert.equal(runningClaim.body.command.commandId, runningInput.body.commandId);

    await stopChild(firstServer.child);
    const restarted = await startServerFixture(directoryFixture);

    const completed = await requestJson(
        restarted,
        `/runtime-generations/${encodeURIComponent(completedInput.body.commandId)}`,
    );
    assert.equal(completed.body.state, 'completed');
    assert.deepEqual(completed.body.result, { durable: true });

    const interrupted = await requestJson(
        restarted,
        `/runtime-generations/${encodeURIComponent(runningInput.body.commandId)}`,
    );
    assert.equal(interrupted.body.state, 'interrupted');
    const interruptedReplay = await requestJson(
        restarted,
        `/runtime-generations/${encodeURIComponent(runningInput.body.commandId)}/events?afterSequence=0`,
    );
    assert.equal(interruptedReplay.body.events.at(-1).eventType, 'interrupted');
    assert.equal(interruptedReplay.body.events.at(-1).payload.reason, 'server_restart');

    const noAutomaticRetry = await claimNext(restarted, 'executor-after-restart');
    assert.deepEqual(noAutomaticRetry.body, { claimed: false });

    const nextInput = await createCommand(restarted, 'after-restart');
    const nextClaim = await claimNext(restarted, 'executor-after-restart');
    assert.equal(nextClaim.body.command.commandId, nextInput.body.commandId);
    assert.ok(nextClaim.body.lease.fencingToken > runningClaim.body.lease.fencingToken);

    const completedReplay = await openCommandSocket(
        restarted,
        completedInput.body.commandId,
        'replay-after-restart',
    );
    const terminal = await completedReplay.waitFor((message) => message.eventType === 'completed');
    assert.deepEqual(terminal.payload.result, { durable: true });
    assert.equal(completedReplay.messages[0].state, 'completed');
    await closeSocket(completedReplay.ws);
});

test('configured executor IP rejects authenticated claim requests from any other address', {
    timeout: 15_000,
}, async () => {
    const fixture = await startServerFixture(null, {
        RISU_RUNTIME_EXECUTOR_IP: '192.0.2.55',
    });
    const roleScript = await fetch(`${fixture.baseUrl}/api/runtime-role.js`);
    assert.equal(roleScript.status, 200);
    assert.equal(
        await roleScript.text(),
        'globalThis.__RISU_RUNTIME_EXECUTOR_ATTESTED__=false;',
    );
    const created = await createCommand(fixture, 'ip-gate');
    assert.equal(created.response.status, 201);

    const forbidden = await claimNext(fixture, 'forbidden-executor');
    assert.equal(forbidden.response.status, 403);
    assert.equal(forbidden.body.code, 'EXECUTOR_IP_FORBIDDEN');

    const queued = await requestJson(
        fixture,
        `/runtime-generations/${encodeURIComponent(created.body.commandId)}`,
    );
    assert.equal(queued.body.state, 'queued');
});
