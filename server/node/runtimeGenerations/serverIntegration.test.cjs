'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const WebSocket = require('ws');

const serverScript = path.resolve(__dirname, '..', 'server.cjs');
const temporaryDirectories = new Set();
const childProcesses = new Set();
const sockets = new Set();

afterEach(async () => {
    for (const socket of sockets) {
        socket.terminate();
    }
    sockets.clear();
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

async function claimNext(fixture, executorId, leaseDurationMs = 5_000) {
    return await requestJson(fixture, '/runtime-generations/executor/claim-next', {
        body: { executorId, leaseDurationMs },
    });
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
