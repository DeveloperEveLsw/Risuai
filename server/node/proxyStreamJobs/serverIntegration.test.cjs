'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { afterEach, test } = require('node:test');
const WebSocket = require('ws');

const serverScript = path.resolve(__dirname, '..', 'server.cjs');
const temporaryDirectories = new Set();
const childProcesses = new Set();
const upstreamServers = new Set();
const sockets = new Set();

afterEach(async () => {
    for (const socket of sockets) {
        socket.terminate();
    }
    sockets.clear();

    await Promise.all([...childProcesses].map(stopChild));
    childProcesses.clear();

    await Promise.all([...upstreamServers].map(closeServer));
    upstreamServers.clear();

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

async function closeServer(server) {
    server.closeAllConnections?.();
    if (!server.listening) {
        return;
    }
    await new Promise((resolve) => server.close(resolve));
}

async function startUpstream(handler) {
    const server = http.createServer(handler);
    upstreamServers.add(server);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        server,
        url: `http://127.0.0.1:${server.address().port}/stream`,
    };
}

async function createFixtureDirectory() {
    const nativeTemporaryRoot = process.platform === 'linux' ? '/tmp' : os.tmpdir();
    const directoryPath = await fs.mkdtemp(path.join(nativeTemporaryRoot, 'risu-proxy-jobs-'));
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
            const response = await fetch(`${baseUrl}/proxy-stream-jobs`, {
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

async function postJob(fixture, upstreamUrl, overrides = {}) {
    const request = {
        requestId: 'request-default',
        generationId: 'generation-1',
        chatId: 'chat-1',
        stepId: 'step-1',
        context: { source: 'integration-test' },
        url: upstreamUrl,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from('{"prompt":"hello"}').toString('base64'),
        timeoutMs: 10_000,
        heartbeatSec: 5,
        ...overrides,
    };
    const response = await fetch(`${fixture.baseUrl}/proxy-stream-jobs`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'risu-auth': fixture.password,
        },
        body: JSON.stringify(request),
    });
    const body = await response.json();
    return { response, body, request };
}

async function getJob(fixture, jobId) {
    const response = await fetch(`${fixture.baseUrl}/proxy-stream-jobs/${encodeURIComponent(jobId)}`, {
        headers: { 'risu-auth': fixture.password },
    });
    assert.equal(response.status, 200);
    return await response.json();
}

async function waitForJobState(fixture, jobId, expectedState, timeoutMs = 8_000) {
    const deadline = Date.now() + timeoutMs;
    let job;
    while (Date.now() < deadline) {
        job = await getJob(fixture, jobId);
        if (job.state === expectedState) {
            return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out waiting for job ${jobId} to become ${expectedState}; current=${job?.state}`);
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
                    reject(new Error('Timed out waiting for WebSocket message'));
                }, timeoutMs),
            };
            waiters.add(waiter);
        });
    };
    return { messages, waitFor };
}

async function issueJobSocketTicket(fixture, jobId) {
    const response = await fetch(
        `${fixture.baseUrl}/proxy-stream-jobs/${encodeURIComponent(jobId)}/socket-ticket`,
        {
            method: 'POST',
            headers: { 'risu-auth': fixture.password },
        },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    return await response.json();
}

async function openJobSocket(fixture, jobId, afterSequence = 0) {
    const ticket = await issueJobSocketTicket(fixture, jobId);
    const socketUrl = `ws://127.0.0.1:${fixture.port}${ticket.path}`
        + `?ticket=${encodeURIComponent(ticket.ticket)}&afterSequence=${afterSequence}`;
    const ws = new WebSocket(socketUrl);
    sockets.add(ws);
    const collector = createMessageCollector(ws);
    await once(ws, 'open');
    return { ws, ticket, ...collector };
}

async function expectWebSocketRejection(url, expectedStatus, options = undefined) {
    await new Promise((resolve, reject) => {
        const ws = new WebSocket(url, options);
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

function closeSocket(ws) {
    if (ws.readyState === WebSocket.CLOSED) {
        sockets.delete(ws);
        return Promise.resolve();
    }
    const closed = once(ws, 'close');
    ws.terminate();
    sockets.delete(ws);
    return closed;
}

function bodyFromEvents(messages) {
    const chunks = messages
        .filter((message) => message.type === 'chunk')
        .sort((left, right) => left.offset - right.offset);
    let expectedOffset = 0;
    const buffers = chunks.map((chunk) => {
        const bytes = Buffer.from(chunk.dataBase64, 'base64');
        assert.equal(chunk.offset, expectedOffset);
        assert.equal(chunk.endOffset, chunk.offset + bytes.length);
        expectedOffset = chunk.endOffset;
        return bytes;
    });
    return Buffer.concat(buffers);
}

async function collectCompletedReplay(fixture, jobId, afterSequence = 0) {
    const connection = await openJobSocket(fixture, jobId, afterSequence);
    const terminal = await connection.waitFor(
        (message) => message.type === 'done' || message.type === 'error'
    );
    return { ...connection, terminal };
}

async function fetchAllTransportEvents(fixture, jobId) {
    const events = [];
    let afterSequence = 0;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
        const response = await fetch(
            `${fixture.baseUrl}/proxy-stream-jobs/${encodeURIComponent(jobId)}/events`
                + `?afterSequence=${afterSequence}&limit=2`,
            { headers: { 'risu-auth': fixture.password } },
        );
        assert.equal(response.status, 200);
        const page = await response.json();
        assert.ok(page.nextCursor >= afterSequence);
        events.push(...page.events);
        afterSequence = page.nextCursor;
        if (!page.hasMore) {
            return { events, nextCursor: afterSequence };
        }
    }
    throw new Error('Replay pagination did not terminate');
}

test('proxy WebSockets require a short-lived one-use ticket bound to the requested job', {
    timeout: 20_000,
}, async () => {
    const upstream = await startUpstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ticket security');
    });
    const fixture = await startServerFixture();
    const first = await postJob(fixture, upstream.url, { requestId: 'ticket-first' });
    const second = await postJob(fixture, upstream.url, { requestId: 'ticket-second' });
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);

    const legacyAuthUrl = `ws://127.0.0.1:${fixture.port}`
        + `/proxy-stream-jobs/${encodeURIComponent(first.body.jobId)}/ws`
        + `?risu-auth=${encodeURIComponent(fixture.password)}&afterSequence=0`;
    await expectWebSocketRejection(legacyAuthUrl, 401);
    await expectWebSocketRejection(
        `ws://127.0.0.1:${fixture.port}/proxy-stream-jobs/${encodeURIComponent(first.body.jobId)}/ws`
            + '?afterSequence=0',
        401,
        { headers: { 'risu-auth': fixture.password } },
    );

    const wrongJobTicket = await issueJobSocketTicket(fixture, first.body.jobId);
    assert.equal(
        wrongJobTicket.path,
        `/proxy-stream-jobs/${encodeURIComponent(first.body.jobId)}/ws`,
    );
    assert.equal(typeof wrongJobTicket.ticket, 'string');
    assert.ok(wrongJobTicket.ticket.length >= 40);
    assert.ok(wrongJobTicket.expiresAt > Date.now());
    assert.ok(wrongJobTicket.expiresAt <= Date.now() + 30_000);
    const wrongJobUrl = `ws://127.0.0.1:${fixture.port}`
        + `/proxy-stream-jobs/${encodeURIComponent(second.body.jobId)}/ws`
        + `?ticket=${encodeURIComponent(wrongJobTicket.ticket)}&afterSequence=0`;
    await expectWebSocketRejection(wrongJobUrl, 401);
    const burnedTicketUrl = `ws://127.0.0.1:${fixture.port}${wrongJobTicket.path}`
        + `?ticket=${encodeURIComponent(wrongJobTicket.ticket)}&afterSequence=0`;
    await expectWebSocketRejection(burnedTicketUrl, 401);

    const connection = await openJobSocket(fixture, first.body.jobId);
    await connection.waitFor((message) => message.type === 'done');
    await closeSocket(connection.ws);
    const replayedTicketUrl = `ws://127.0.0.1:${fixture.port}${connection.ticket.path}`
        + `?ticket=${encodeURIComponent(connection.ticket.ticket)}&afterSequence=0`;
    await expectWebSocketRejection(replayedTicketUrl, 401);
});

test('a disconnected browser does not cancel upstream generation and can replay the complete stream', {
    timeout: 20_000,
}, async () => {
    let markFirstChunk;
    const firstChunkSent = new Promise((resolve) => {
        markFirstChunk = resolve;
    });
    let releaseUpstream;
    const canFinish = new Promise((resolve) => {
        releaseUpstream = resolve;
    });
    let upstreamRequests = 0;
    const upstream = await startUpstream(async (_req, res) => {
        upstreamRequests += 1;
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'x-upstream-test': 'disconnect',
        });
        res.write('first-part|');
        markFirstChunk();
        await canFinish;
        res.end('second-part');
    });
    const fixture = await startServerFixture();

    const created = await postJob(fixture, upstream.url, { requestId: 'disconnect-job' });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.reused, false);
    await firstChunkSent;

    const firstConnection = await openJobSocket(fixture, created.body.jobId);
    await firstConnection.waitFor((message) => message.type === 'chunk');
    await closeSocket(firstConnection.ws);

    releaseUpstream();
    const completed = await waitForJobState(fixture, created.body.jobId, 'completed');
    assert.equal(completed.terminal, 'done');
    assert.equal(upstreamRequests, 1);

    const replay = await collectCompletedReplay(fixture, created.body.jobId);
    assert.equal(replay.messages[0].type, 'job_snapshot');
    assert.equal(replay.messages[0].state, 'completed');
    assert.equal(replay.messages.some((message) => message.type === 'upstream_headers'), true);
    assert.equal(bodyFromEvents(replay.messages).toString(), 'first-part|second-part');
    assert.equal(replay.terminal.finalOffset, Buffer.byteLength('first-part|second-part'));
    await closeSocket(replay.ws);

    const stillPresent = await getJob(fixture, created.body.jobId);
    assert.equal(stillPresent.state, 'completed');
});

test('idempotent creation starts one upstream request and two clients independently replay it', {
    timeout: 20_000,
}, async () => {
    let upstreamRequests = 0;
    const upstream = await startUpstream((_req, res) => {
        upstreamRequests += 1;
        res.writeHead(201, { 'content-type': 'text/plain' });
        res.end('shared durable response');
    });
    const fixture = await startServerFixture();

    const first = await postJob(fixture, upstream.url, { requestId: 'shared-idempotency-key' });
    const duplicate = await postJob(fixture, upstream.url, { requestId: 'shared-idempotency-key' });
    assert.equal(first.response.status, 201);
    assert.equal(duplicate.response.status, 200);
    assert.equal(duplicate.body.reused, true);
    assert.equal(duplicate.body.jobId, first.body.jobId);

    const conflict = await postJob(fixture, upstream.url, {
        requestId: 'shared-idempotency-key',
        bodyBase64: Buffer.from('different request').toString('base64'),
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(conflict.body.existingJobId, first.body.jobId);

    await waitForJobState(fixture, first.body.jobId, 'completed');
    assert.equal(upstreamRequests, 1);

    const [desktop, phone] = await Promise.all([
        collectCompletedReplay(fixture, first.body.jobId),
        collectCompletedReplay(fixture, first.body.jobId),
    ]);
    for (const connection of [desktop, phone]) {
        assert.equal(connection.terminal.type, 'done');
        assert.equal(bodyFromEvents(connection.messages).toString(), 'shared durable response');
        const sequences = connection.messages
            .filter((message) => Number.isSafeInteger(message.sequence))
            .map((message) => message.sequence);
        assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
        await closeSocket(connection.ws);
    }
});

test('a completed job survives server restart with HTTP/WS replay, listing, and acknowledgement', {
    timeout: 25_000,
}, async () => {
    let upstreamRequests = 0;
    const upstream = await startUpstream((_req, res) => {
        upstreamRequests += 1;
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.from([0, 1, 2, 127, 128, 254, 255]));
    });
    const directoryFixture = await createFixtureDirectory();
    const firstServer = await startServerFixture(directoryFixture);
    const created = await postJob(firstServer, upstream.url, { requestId: 'restart-completed' });
    assert.equal(created.response.status, 201);
    await waitForJobState(firstServer, created.body.jobId, 'completed');
    assert.equal(upstreamRequests, 1);

    await stopChild(firstServer.child);
    const restarted = await startServerFixture(directoryFixture);
    const recovered = await getJob(restarted, created.body.jobId);
    assert.equal(recovered.state, 'completed');
    assert.equal(recovered.requestId, 'restart-completed');

    const replayPage = await fetchAllTransportEvents(restarted, created.body.jobId);
    assert.equal(replayPage.events.some((event) => event.type === 'upstream_headers'), true);
    assert.equal(replayPage.events.at(-1).type, 'done');
    assert.deepEqual(bodyFromEvents(replayPage.events), Buffer.from([0, 1, 2, 127, 128, 254, 255]));

    const replay = await collectCompletedReplay(restarted, created.body.jobId);
    assert.equal(replay.messages[0].state, 'completed');
    assert.deepEqual(bodyFromEvents(replay.messages), Buffer.from([0, 1, 2, 127, 128, 254, 255]));
    await closeSocket(replay.ws);

    const acknowledgementResponse = await fetch(
        `${restarted.baseUrl}/proxy-stream-jobs/${encodeURIComponent(created.body.jobId)}/ack`,
        {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'risu-auth': restarted.password,
            },
            body: JSON.stringify({ deviceId: 'phone-browser' }),
        },
    );
    assert.equal(acknowledgementResponse.status, 200);
    const acknowledgement = await acknowledgementResponse.json();
    assert.equal(acknowledgement.job.acknowledgement.deviceId, 'phone-browser');

    const listResponse = await fetch(`${restarted.baseUrl}/proxy-stream-jobs?acknowledged=true`, {
        headers: { 'risu-auth': restarted.password },
    });
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    assert.deepEqual(listed.jobs.map((job) => job.jobId), [created.body.jobId]);
    assert.equal(upstreamRequests, 1);
});

test('compressed upstream bytes are persisted in browser-decoded form with coherent headers', {
    timeout: 20_000,
}, async () => {
    const plainBody = Buffer.from('data: {"token":"hello"}\n\ndata: [DONE]\n\n');
    const compressedBody = zlib.gzipSync(plainBody);
    let requestedEncoding = null;
    const upstream = await startUpstream((req, res) => {
        requestedEncoding = req.headers['accept-encoding'];
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'content-encoding': 'gzip',
            'content-length': String(compressedBody.length),
        });
        res.end(compressedBody);
    });
    const fixture = await startServerFixture();

    const created = await postJob(fixture, upstream.url, { requestId: 'compressed-stream' });
    assert.equal(created.response.status, 201);
    await waitForJobState(fixture, created.body.jobId, 'completed');
    const replay = await collectCompletedReplay(fixture, created.body.jobId);
    const headers = replay.messages.find((message) => message.type === 'upstream_headers');

    assert.equal(requestedEncoding, 'identity');
    assert.equal(headers.headers['content-encoding'], undefined);
    assert.equal(headers.headers['content-length'], undefined);
    assert.deepEqual(bodyFromEvents(replay.messages), plainBody);
    await closeSocket(replay.ws);
});

test('an oversized upstream response fails durably before exceeding the spool quota', {
    timeout: 15_000,
}, async () => {
    const upstream = await startUpstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.alloc(64, 7));
    });
    const fixture = await startServerFixture(null, {
        RISU_PROXY_STREAM_MAX_RESPONSE_BYTES: '16',
    });

    const created = await postJob(fixture, upstream.url, { requestId: 'response-quota' });
    assert.equal(created.response.status, 201);
    const failed = await waitForJobState(fixture, created.body.jobId, 'failed');

    assert.match(failed.error, /exceeded 16 bytes/);
    assert.equal(failed.terminal, 'error');
    assert.equal(failed.cursor, 0);
});

test('the global disk spool quota fails durably and restart/idempotent retry never calls upstream twice', {
    timeout: 25_000,
}, async () => {
    let upstreamRequests = 0;
    const upstream = await startUpstream((_req, res) => {
        upstreamRequests += 1;
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(Buffer.alloc(64 * 1024, 9));
    });
    const directoryFixture = await createFixtureDirectory();
    const environment = {
        RISU_PROXY_STREAM_MAX_RESPONSE_BYTES: String(1024 * 1024),
        RISU_PROXY_STREAM_MAX_SPOOL_BYTES: '12000',
    };
    const firstServer = await startServerFixture(directoryFixture, environment);

    const created = await postJob(firstServer, upstream.url, { requestId: 'global-spool-quota' });
    assert.equal(created.response.status, 201);
    const failed = await waitForJobState(firstServer, created.body.jobId, 'failed');
    assert.match(failed.error, /global proxy stream spool quota/i);
    assert.equal(failed.terminal, 'error');
    assert.equal(failed.cursor, 0);
    assert.equal(upstreamRequests, 1);

    const eventPath = path.join(
        directoryFixture.savePath,
        '__proxy_stream_jobs',
        created.body.jobId,
        'events.ndjson',
    );
    assert.ok((await fs.stat(eventPath)).size <= 12_000);

    await stopChild(firstServer.child);
    const restarted = await startServerFixture(directoryFixture, environment);
    const recovered = await getJob(restarted, created.body.jobId);
    assert.equal(recovered.state, 'failed');
    assert.equal(recovered.terminal, 'error');

    const retried = await postJob(restarted, upstream.url, { requestId: 'global-spool-quota' });
    assert.equal(retried.response.status, 200);
    assert.equal(retried.body.reused, true);
    assert.equal(retried.body.jobId, created.body.jobId);
    assert.equal(retried.body.state, 'failed');
    assert.equal(upstreamRequests, 1);
});
