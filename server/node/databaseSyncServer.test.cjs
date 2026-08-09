'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const WebSocket = require('ws');

const serverScript = path.resolve(__dirname, 'server.cjs');
const databaseFileName = Buffer.from('database/database.bin', 'utf8').toString('hex');
const temporaryDirectories = new Set();
const childProcesses = new Set();

afterEach(async () => {
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
    const address = server.address();
    const port = address.port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    child.kill('SIGTERM');
    const exited = once(child, 'exit');
    const timeout = new Promise((resolve) => setTimeout(resolve, 1500, 'timeout'));
    if (await Promise.race([exited, timeout]) === 'timeout') {
        child.kill('SIGKILL');
        await once(child, 'exit').catch(() => {});
    }
}

async function createJwtCredential() {
    const keyPair = await crypto.webcrypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
    );
    const publicKey = await crypto.webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
    const publicKeyHash = crypto.createHash('sha256')
        .update(JSON.stringify(publicKey))
        .digest('hex');
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))
        .toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        iat: now,
        exp: now + 60,
        pub: publicKey,
    })).toString('base64url');
    const signingInput = `${header}.${payload}`;
    const signature = await crypto.webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        Buffer.from(signingInput),
    );
    return {
        publicKey,
        publicKeyHash,
        token: `${signingInput}.${Buffer.from(signature).toString('base64url')}`,
    };
}

async function createAuthorizedJwt(savePath) {
    const credential = await createJwtCredential();
    await fs.writeFile(
        path.join(savePath, '__known_public_key_hashes.json'),
        JSON.stringify([credential.publicKeyHash]),
    );
    return credential.token;
}

async function startServerFixture({
    initialData,
    withJwt = false,
    bootstrapPassword = null,
    executorIp = '',
} = {}) {
    const directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'risu-sync-server-'));
    temporaryDirectories.add(directoryPath);
    const savePath = path.join(directoryPath, 'save');
    await fs.mkdir(savePath, { recursive: true });
    const password = bootstrapPassword === null
        ? 'integration-secret'
        : crypto.createHash('sha256').update(bootstrapPassword).digest('hex');
    if (bootstrapPassword === null) {
        await fs.writeFile(path.join(savePath, '__password'), password);
    }
    const jwt = withJwt ? await createAuthorizedJwt(savePath) : null;
    if (initialData !== undefined) {
        await fs.writeFile(path.join(savePath, databaseFileName), initialData);
    }

    const port = await getUnusedPort();
    const output = [];
    const child = spawn(process.execPath, [serverScript], {
        cwd: directoryPath,
        env: {
            ...process.env,
            PORT: String(port),
            NODE_ENV: 'test',
            RISU_RUNTIME_EXECUTOR_IP: executorIp,
            ...(bootstrapPassword === null
                ? {}
                : { RISU_NODE_BOOTSTRAP_PASSWORD: bootstrapPassword }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    childProcesses.add(child);
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));

    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited early (${child.exitCode}):\n${output.join('')}`);
        }
        try {
            const response = await fetch(`${baseUrl}/api/sync/database`, {
                headers: { 'risu-auth': password },
            });
            if (response.status === 200 || response.status === 404) {
                return { child, directoryPath, savePath, password, jwt, port, baseUrl, output };
            }
        }
        catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Server did not become ready: ${lastError}\n${output.join('')}`);
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
    return (predicate, timeoutMs = 5000) => {
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
}

function assertDatabaseHeadHeaders(response, expected) {
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
    assert.equal(response.headers.get('x-risu-revision'), String(expected.revision));
    assert.equal(response.headers.get('x-risu-sha256'), expected.sha256);
    assert.equal(response.headers.get('etag'), expected.etag);
    assert.equal(response.headers.get('x-risu-etag'), expected.etag);
}

async function expectTicketRejection(url) {
    await new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
            ws.terminate();
            reject(new Error('Reused ticket was not rejected'));
        }, 5000);
        ws.once('open', () => {
            clearTimeout(timer);
            ws.terminate();
            reject(new Error('Reused ticket unexpectedly opened a socket'));
        });
        ws.once('unexpected-response', (_request, response) => {
            clearTimeout(timer);
            response.resume();
            ws.terminate();
            try {
                assert.equal(response.statusCode, 401);
                resolve();
            }
            catch (error) {
                reject(error);
            }
        });
        ws.once('error', () => {});
    });
}

test('database sync HTTP and WebSocket endpoints enforce CAS and preserve conflicts', {
    timeout: 20000,
}, async () => {
    const initialData = Buffer.from([0, 82, 73, 83, 85, 0, 1, 255]);
    const fixture = await startServerFixture({ initialData });
    const authHeaders = { 'risu-auth': fixture.password };

    const unauthorized = await fetch(`${fixture.baseUrl}/api/sync/database`);
    assert.notEqual(unauthorized.status, 200);

    const initialResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        headers: authHeaders,
    });
    assert.equal(initialResponse.status, 200);
    const initialEtag = initialResponse.headers.get('etag');
    assert.match(initialEtag, /^"risu-0-[a-f0-9]{64}"$/);
    const initialHead = {
        revision: 0,
        sha256: initialResponse.headers.get('x-risu-sha256'),
        etag: initialEtag,
    };
    assert.match(initialHead.sha256, /^[a-f0-9]{64}$/);
    assertDatabaseHeadHeaders(initialResponse, initialHead);
    assert.deepEqual(Buffer.from(await initialResponse.arrayBuffer()), initialData);

    const ticketResponse = await fetch(`${fixture.baseUrl}/api/sync/socket-ticket`, {
        method: 'POST',
        headers: {
            ...authHeaders,
            'content-type': 'application/json',
        },
        body: JSON.stringify({ clientId: 'phone-browser' }),
    });
    assert.equal(ticketResponse.status, 200);
    const ticket = await ticketResponse.json();
    assert.equal(ticket.path, '/api/sync/database/ws');
    assert.ok(ticket.expiresAt > Date.now());

    const socketUrl = `ws://127.0.0.1:${fixture.port}${ticket.path}?ticket=${encodeURIComponent(ticket.ticket)}`;
    const ws = new WebSocket(socketUrl);
    const nextMessage = createMessageCollector(ws);
    await once(ws, 'open');
    const hello = await nextMessage((message) => message.type === 'hello');
    assert.equal(hello.revision, 0);
    assert.equal(hello.etag, initialEtag);
    assert.equal(hello.clientId, 'phone-browser');
    await expectTicketRejection(socketUrl);

    const committedData = Buffer.from('opaque-committed-database');
    const committedMessagePromise = nextMessage(
        (message) => message.type === 'committed' && message.idempotencyKey === 'commit-1'
    );
    const commitResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        method: 'PUT',
        headers: {
            ...authHeaders,
            'content-type': 'application/octet-stream',
            'if-match': initialEtag,
            'idempotency-key': 'commit-1',
            'x-risu-client-id': 'desktop-browser',
            'x-risu-commit-kind': 'stable',
        },
        body: committedData,
    });
    assert.equal(commitResponse.status, 200);
    const committed = await commitResponse.json();
    assert.equal(committed.ok, true);
    assert.equal(committed.duplicate, false);
    assertDatabaseHeadHeaders(commitResponse, committed);
    const committedEvent = await committedMessagePromise;
    assert.equal(committedEvent.revision, 1);
    assert.equal(committedEvent.clientId, 'desktop-browser');
    assert.equal(committedEvent.kind, 'stable');

    const secondData = Buffer.from('newer-opaque-database');
    const secondResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        method: 'PUT',
        headers: {
            ...authHeaders,
            'content-type': 'application/octet-stream',
            'if-match': committed.etag,
            'idempotency-key': 'commit-2',
            'x-risu-client-id': 'phone-browser',
        },
        body: secondData,
    });
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(second.revision, 2);
    assertDatabaseHeadHeaders(secondResponse, second);

    const duplicateResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        method: 'PUT',
        headers: {
            ...authHeaders,
            'content-type': 'application/octet-stream',
            'if-match': initialEtag,
            'idempotency-key': 'commit-1',
        },
        body: committedData,
    });
    assert.equal(duplicateResponse.status, 200);
    const duplicate = await duplicateResponse.json();
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.revision, 1, 'body retains the originally accepted commit');
    assert.equal(duplicate.sha256, committed.sha256);
    assert.equal(duplicate.etag, committed.etag);
    assert.equal(duplicate.currentRevision, 2);
    assert.equal(duplicate.currentSha256, second.sha256);
    assert.equal(duplicate.currentEtag, second.etag);
    assertDatabaseHeadHeaders(duplicateResponse, {
        revision: duplicate.currentRevision,
        sha256: duplicate.currentSha256,
        etag: duplicate.currentEtag,
    });

    const staleData = Buffer.from([7, 0, 7, 1, 9]);
    const staleResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        method: 'PUT',
        headers: {
            ...authHeaders,
            'content-type': 'application/octet-stream',
            'if-match': initialEtag,
            'idempotency-key': 'stale-commit',
        },
        body: staleData,
    });
    assert.equal(staleResponse.status, 409);
    const stale = await staleResponse.json();
    assert.equal(stale.reason, 'stale_base');
    assert.ok(stale.conflictId);
    assertDatabaseHeadHeaders(staleResponse, stale);

    const conflictsResponse = await fetch(
        `${fixture.baseUrl}/api/sync/database/conflicts`,
        { headers: authHeaders }
    );
    assert.equal(conflictsResponse.status, 200);
    const conflicts = (await conflictsResponse.json()).conflicts;
    assert.ok(conflicts.some((conflict) => conflict.conflictId === stale.conflictId));

    const conflictResponse = await fetch(
        `${fixture.baseUrl}/api/sync/database/conflicts/${encodeURIComponent(stale.conflictId)}`,
        { headers: authHeaders }
    );
    assert.equal(conflictResponse.status, 200);
    assert.equal(conflictResponse.headers.get('x-risu-conflict-reason'), 'stale_base');
    assert.deepEqual(Buffer.from(await conflictResponse.arrayBuffer()), staleData);

    const finalResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        headers: authHeaders,
    });
    assertDatabaseHeadHeaders(finalResponse, second);
    assert.deepEqual(Buffer.from(await finalResponse.arrayBuffer()), secondData);
    ws.close();
    await once(ws, 'close');
});

test('a fresh server accepts one idempotent If-Match star initialization', {
    timeout: 15000,
}, async () => {
    const fixture = await startServerFixture();
    const authHeaders = { 'risu-auth': fixture.password };
    const absent = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        headers: authHeaders,
    });
    assert.equal(absent.status, 404);

    const initialData = Buffer.from('first-opaque-save');
    const firstPut = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        method: 'PUT',
        headers: {
            ...authHeaders,
            'content-type': 'application/octet-stream',
            'if-match': '*',
            'idempotency-key': 'initialize-1',
            'x-risu-client-id': 'new-browser',
        },
        body: initialData,
    });
    assert.equal(firstPut.status, 200);
    const initialized = await firstPut.json();
    assert.equal(initialized.revision, 1);
    assert.equal(initialized.duplicate, false);

    const retry = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        method: 'PUT',
        headers: {
            ...authHeaders,
            'content-type': 'application/octet-stream',
            'if-match': '*',
            'idempotency-key': 'initialize-1',
        },
        body: initialData,
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).duplicate, true);

    const loaded = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        headers: authHeaders,
    });
    assert.equal(loaded.headers.get('x-risu-revision'), '1');
    assert.deepEqual(Buffer.from(await loaded.arrayBuffer()), initialData);
});

test('hub proxy requires device authentication and rejects caller-selected targets', {
    timeout: 15000,
}, async () => {
    const fixture = await startServerFixture({ initialData: Buffer.from('opaque-db') });
    const maliciousTarget = 'http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F';

    const unauthenticated = await fetch(`${fixture.baseUrl}/hub-proxy/x`, {
        headers: { 'x-risu-node-path': maliciousTarget },
    });
    assert.notEqual(unauthenticated.status, 200);

    const rejected = await fetch(`${fixture.baseUrl}/hub-proxy/x`, {
        headers: {
            'risu-auth': fixture.password,
            'x-risu-node-path': maliciousTarget,
        },
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {
        error: 'x-risu-node-path is not supported',
        code: 'HUB_PROXY_POLICY_REJECTED',
    });

    const sessionResponse = await fetch(`${fixture.baseUrl}/api/hub-session`, {
        method: 'POST',
        headers: { 'risu-auth': fixture.password },
    });
    assert.equal(sessionResponse.status, 200);
    assert.ok((await sessionResponse.json()).expiresAt > Date.now());
    const cookie = sessionResponse.headers.get('set-cookie');
    assert.match(cookie, /^risu-hub-session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Path=\/hub-proxy/);
    const cookiePair = cookie.split(';', 1)[0];

    const resourceStyleRequest = await fetch(`${fixture.baseUrl}/hub-proxy/x`, {
        headers: {
            cookie: cookiePair,
            'x-risu-node-path': maliciousTarget,
        },
    });
    assert.equal(resourceStyleRequest.status, 400);
    assert.equal((await resourceStyleRequest.json()).code, 'HUB_PROXY_POLICY_REJECTED');

    const tamperedCookieRequest = await fetch(`${fixture.baseUrl}/hub-proxy/x`, {
        headers: {
            cookie: cookiePair.slice(0, -1) + (cookiePair.endsWith('x') ? 'y' : 'x'),
            'x-risu-node-path': maliciousTarget,
        },
    });
    assert.equal((await tamperedCookieRequest.json()).error, 'No auth header');
});

test('fresh volumes bootstrap before listen and enroll only the fixed resident executor', {
    timeout: 15000,
}, async () => {
    const fixture = await startServerFixture({
        initialData: Buffer.from('opaque-db'),
        bootstrapPassword: 'cold-volume-secret',
        executorIp: '127.0.0.1',
    });
    assert.equal(
        await fs.readFile(path.join(fixture.savePath, '__password'), 'utf8'),
        crypto.createHash('sha256').update('cold-volume-secret').digest('hex'),
    );

    const credential = await createJwtCredential();
    const enrollment = await fetch(`${fixture.baseUrl}/api/executor_login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicKey: credential.publicKey }),
    });
    assert.equal(enrollment.status, 200);
    assert.equal((await enrollment.json()).status, 'success');

    const authenticated = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        headers: { 'risu-auth': credential.token },
    });
    assert.equal(authenticated.status, 200);

    const knownHashes = JSON.parse(await fs.readFile(
        path.join(fixture.savePath, '__known_public_key_hashes.json'),
        'utf8',
    ));
    assert.deepEqual(knownHashes, [credential.publicKeyHash]);
});

test('runtime generation leases fence canonical database commits', {
    timeout: 20000,
}, async () => {
    const initialData = Buffer.from('canonical-database-before-generation');
    const fixture = await startServerFixture({ initialData });
    const authHeaders = { 'risu-auth': fixture.password };

    const initialResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        headers: authHeaders,
    });
    assert.equal(initialResponse.status, 200);
    const initialEtag = initialResponse.headers.get('etag');

    const createResponse = await fetch(`${fixture.baseUrl}/runtime-generations`, {
        method: 'POST',
        headers: {
            ...authHeaders,
            'content-type': 'application/json',
            'idempotency-key': 'database-fence-generation-1',
        },
        body: JSON.stringify({
            requestId: 'database-fence-generation-1',
            action: 'send',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: { input: 'hello' },
        }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.state, 'queued');
    assert.ok(created.commandId);

    const executorId = 'resident-executor-integration-test';
    const claimResponse = await fetch(
        `${fixture.baseUrl}/runtime-generations/executor/claim-next`,
        {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ executorId, leaseDurationMs: 5000 }),
        }
    );
    assert.equal(claimResponse.status, 200);
    const claimed = await claimResponse.json();
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.command.commandId, created.commandId);
    assert.equal(claimed.command.state, 'running');
    assert.equal(claimed.lease.executorId, executorId);
    assert.ok(Number.isSafeInteger(claimed.lease.fencingToken));

    const unfencedResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        method: 'PUT',
        headers: {
            ...authHeaders,
            'content-type': 'application/octet-stream',
            'if-match': initialEtag,
            'idempotency-key': 'unfenced-during-generation',
        },
        body: Buffer.from('unfenced-write-must-not-commit'),
    });
    assert.equal(unfencedResponse.status, 423);
    assert.equal((await unfencedResponse.json()).code, 'GENERATION_WRITE_LEASE_ACTIVE');

    const partialFenceResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        method: 'PUT',
        headers: {
            ...authHeaders,
            'content-type': 'application/octet-stream',
            'if-match': initialEtag,
            'idempotency-key': 'partial-generation-fence',
            'x-risu-generation-id': created.commandId,
        },
        body: Buffer.from('partial-fence-must-not-commit'),
    });
    assert.equal(partialFenceResponse.status, 400);

    const staleTokenResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        method: 'PUT',
        headers: {
            ...authHeaders,
            'content-type': 'application/octet-stream',
            'if-match': initialEtag,
            'idempotency-key': 'incorrect-generation-fence',
            'x-risu-generation-id': created.commandId,
            'x-risu-executor-id': executorId,
            'x-risu-fencing-token': String(claimed.lease.fencingToken + 1),
        },
        body: Buffer.from('incorrect-fence-must-not-commit'),
    });
    assert.equal(staleTokenResponse.status, 409);
    assert.equal((await staleTokenResponse.json()).code, 'STALE_EXECUTOR_FENCE');

    const committedData = Buffer.from('canonical-database-written-by-current-executor');
    const fencedResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        method: 'PUT',
        headers: {
            ...authHeaders,
            'content-type': 'application/octet-stream',
            'if-match': initialEtag,
            'idempotency-key': 'current-generation-fence',
            'x-risu-generation-id': created.commandId,
            'x-risu-executor-id': executorId,
            'x-risu-fencing-token': String(claimed.lease.fencingToken),
        },
        body: committedData,
    });
    assert.equal(fencedResponse.status, 200);
    const committed = await fencedResponse.json();
    assert.equal(committed.revision, 1);

    const completeResponse = await fetch(
        `${fixture.baseUrl}/runtime-generations/${encodeURIComponent(created.commandId)}/complete`,
        {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                executorId,
                fencingToken: claimed.lease.fencingToken,
                result: { revision: committed.revision },
            }),
        }
    );
    assert.equal(completeResponse.status, 200);

    const expiringCreateResponse = await fetch(`${fixture.baseUrl}/runtime-generations`, {
        method: 'POST',
        headers: {
            ...authHeaders,
            'content-type': 'application/json',
            'idempotency-key': 'database-fence-generation-2',
        },
        body: JSON.stringify({
            requestId: 'database-fence-generation-2',
            action: 'continue',
            characterId: 'character-1',
            chatId: 'chat-1',
            payload: {},
        }),
    });
    assert.equal(expiringCreateResponse.status, 201);
    const expiringGeneration = await expiringCreateResponse.json();

    const expiringClaimResponse = await fetch(
        `${fixture.baseUrl}/runtime-generations/executor/claim-next`,
        {
            method: 'POST',
            headers: {
                ...authHeaders,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ executorId, leaseDurationMs: 25 }),
        }
    );
    assert.equal(expiringClaimResponse.status, 200);
    const expiringClaim = await expiringClaimResponse.json();
    assert.equal(expiringClaim.claimed, true);
    assert.equal(expiringClaim.command.commandId, expiringGeneration.commandId);
    await new Promise((resolve) => setTimeout(resolve, 75));

    const expiredFenceResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        method: 'PUT',
        headers: {
            ...authHeaders,
            'content-type': 'application/octet-stream',
            'if-match': committed.etag,
            'idempotency-key': 'expired-generation-fence',
            'x-risu-generation-id': expiringGeneration.commandId,
            'x-risu-executor-id': executorId,
            'x-risu-fencing-token': String(expiringClaim.lease.fencingToken),
        },
        body: Buffer.from('expired-fence-must-not-commit'),
    });
    assert.equal(expiredFenceResponse.status, 409);
    assert.equal((await expiredFenceResponse.json()).code, 'STALE_EXECUTOR_FENCE');

    const finalResponse = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        headers: authHeaders,
    });
    assert.equal(finalResponse.status, 200);
    assert.equal(finalResponse.headers.get('x-risu-revision'), '1');
    assert.deepEqual(Buffer.from(await finalResponse.arrayBuffer()), committedData);
});

test('legacy write and remove endpoints cannot mutate the canonical database', {
    timeout: 15000,
}, async () => {
    const initialData = Buffer.from('canonical-database-protected-from-legacy-routes');
    const fixture = await startServerFixture({ initialData, withJwt: true });
    const authHeaders = { 'risu-auth': fixture.jwt };

    const writeResponse = await fetch(`${fixture.baseUrl}/api/write`, {
        method: 'POST',
        headers: {
            ...authHeaders,
            'content-type': 'application/octet-stream',
            'file-path': databaseFileName,
        },
        body: Buffer.from('legacy-overwrite-must-be-rejected'),
    });
    assert.equal(writeResponse.status, 409);
    assert.equal((await writeResponse.json()).code, 'VERSIONED_DATABASE_REQUIRED');

    const removeResponse = await fetch(`${fixture.baseUrl}/api/remove`, {
        headers: {
            ...authHeaders,
            'file-path': databaseFileName,
        },
    });
    assert.equal(removeResponse.status, 409);
    assert.equal((await removeResponse.json()).code, 'VERSIONED_DATABASE_REQUIRED');

    const loaded = await fetch(`${fixture.baseUrl}/api/sync/database`, {
        headers: authHeaders,
    });
    assert.equal(loaded.status, 200);
    assert.equal(loaded.headers.get('x-risu-revision'), '0');
    assert.deepEqual(Buffer.from(await loaded.arrayBuffer()), initialData);
});
