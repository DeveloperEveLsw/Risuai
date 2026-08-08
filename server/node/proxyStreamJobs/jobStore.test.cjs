const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test } = require('node:test');

const {
    IdempotencyConflictError,
    InvalidStateTransitionError,
    JobStoreCorruptionError,
    ProxyStreamJobStore,
    SpoolQuotaExceededError,
} = require('./jobStore.cjs');

const temporaryDirectories = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => {
        return fs.rm(directory, { recursive: true, force: true });
    }));
});

async function makeStore(options = {}) {
    // This development environment can inherit a Windows TEMP path mounted
    // without POSIX mode metadata. Use the native Linux temporary filesystem
    // when available so the security assertions exercise real chmod behavior.
    const temporaryRoot = process.platform === 'linux' ? '/tmp' : os.tmpdir();
    const temporaryDirectory = await fs.mkdtemp(path.join(temporaryRoot, 'risu-proxy-jobs-'));
    temporaryDirectories.push(temporaryDirectory);
    const rootDir = path.join(temporaryDirectory, 'jobs');
    let id = 0;
    let time = 1_700_000_000_000;
    const store = new ProxyStreamJobStore({
        rootDir,
        idFactory: options.idFactory ?? (() => `job-${++id}`),
        now: options.now ?? (() => ++time),
        ...(options.maxSpoolBytes === undefined ? {} : { maxSpoolBytes: options.maxSpoolBytes }),
        ...(options.runningTerminalReserveBytes === undefined
            ? {}
            : { runningTerminalReserveBytes: options.runningTerminalReserveBytes }),
        ...(options.queuedTerminalReserveBytes === undefined
            ? {}
            : { queuedTerminalReserveBytes: options.queuedTerminalReserveBytes }),
        ...(options.observeEventRead === undefined
            ? {}
            : { observeEventRead: options.observeEventRead }),
    });
    await store.open();
    return { store, rootDir };
}

function permissions(stat) {
    return stat.mode & 0o777;
}

describe('ProxyStreamJobStore persistence and replay', () => {
    test('persists secure metadata and monotonically sequenced replay events', async () => {
        const { store, rootDir } = await makeStore();
        const created = await store.create({
            requestId: 'device-a:generation-1:step-1',
            requestHash: 'sha256:request-one',
            generationId: 'generation-1',
            stepId: 'step-1',
            context: { interceptor: 'openai_streaming' },
        });

        assert.equal(created.created, true);
        assert.equal(created.job.state, 'queued');
        assert.equal(created.job.lastSequence, 1);
        await store.start(created.job.id);

        await store.appendEvent(created.job.id, 'upstream_headers', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        });
        await store.appendEvent(created.job.id, 'chunk', {
            offset: 0,
            endOffset: 3,
            dataBase64: Buffer.from('abc').toString('base64'),
        });
        await store.appendEvent(created.job.id, 'chunk', {
            offset: 3,
            endOffset: 6,
            dataBase64: Buffer.from('def').toString('base64'),
        });
        await store.appendEvent(created.job.id, 'done', { finalOffset: 6 });
        await store.complete(created.job.id, { finalOffset: 6 });

        const firstPage = await store.replay(created.job.id, { afterSequence: 2, limit: 2 });
        assert.deepEqual(firstPage.events.map((event) => event.sequence), [3, 4]);
        assert.equal(firstPage.nextCursor, 4);
        assert.equal(firstPage.hasMore, true);

        const secondPage = await store.replay(created.job.id, { afterSequence: firstPage.nextCursor });
        assert.deepEqual(secondPage.events.map((event) => event.sequence), [5, 6, 7]);
        assert.equal(secondPage.nextCursor, 7);
        assert.equal(secondPage.hasMore, false);
        assert.equal(secondPage.events[1].payload.finalOffset, 6);

        const current = await store.get(created.job.id);
        assert.deepEqual(current.transportSummary, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            cursor: 6,
            terminal: 'done',
        });

        const jobDirectory = path.join(rootDir, created.job.id);
        assert.equal(permissions(await fs.stat(rootDir)), 0o700);
        assert.equal(permissions(await fs.stat(jobDirectory)), 0o700);
        assert.equal(permissions(await fs.stat(path.join(jobDirectory, 'meta.json'))), 0o600);
        assert.equal(permissions(await fs.stat(path.join(jobDirectory, 'events.ndjson'))), 0o600);

        const reopened = new ProxyStreamJobStore({ rootDir });
        const summary = await reopened.open();
        assert.deepEqual(summary, { jobs: 1, recoveredInterrupted: 0 });
        const replayed = await reopened.replay(created.job.id);
        assert.deepEqual(replayed.events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
        const reopenedJob = await reopened.get(created.job.id);
        assert.equal(reopenedJob.lastSequence, 7);
        assert.deepEqual(reopenedJob.transportSummary, current.transportSummary);
    });

    test('repairs an incomplete trailing append without discarding committed events', async () => {
        const { store, rootDir } = await makeStore();
        const { job } = await store.create({ requestId: 'request-1', requestHash: 'hash-1' });
        await store.start(job.id);
        await store.appendEvent(job.id, 'chunk', {
            offset: 0,
            endOffset: 2,
            dataBase64: Buffer.from('ok').toString('base64'),
        });
        await store.complete(job.id);

        const eventPath = path.join(rootDir, job.id, 'events.ndjson');
        await fs.appendFile(eventPath, '{"sequence":5,"type":"chunk"');

        const reopened = new ProxyStreamJobStore({ rootDir });
        await reopened.open();
        const replayed = await reopened.replay(job.id);
        assert.deepEqual(replayed.events.map((event) => event.sequence), [1, 2, 3, 4]);
        const repaired = await fs.readFile(eventPath, 'utf8');
        assert.equal(repaired.endsWith('\n'), true);
        assert.equal(repaired.includes('"sequence":5'), false);
    });

    test('serializes concurrent appenders into one gap-free event sequence', async () => {
        const { store } = await makeStore();
        const { job } = await store.create({ requestId: 'concurrent-events', requestHash: 'hash' });

        await Promise.all(Array.from({ length: 40 }, (_, index) => {
            return store.appendEvent(job.id, 'chunk', {
                offset: index,
                endOffset: index + 1,
                dataBase64: Buffer.from([index]).toString('base64'),
            });
        }));

        const replayed = await store.replay(job.id);
        assert.deepEqual(
            replayed.events.map((event) => event.sequence),
            Array.from({ length: 41 }, (_, index) => index + 1),
        );
    });
});

describe('ProxyStreamJobStore idempotency', () => {
    test('returns one job for concurrent matching request ids and rejects hash conflicts', async () => {
        const { store } = await makeStore();
        const attempts = await Promise.all(Array.from({ length: 8 }, () => {
            return store.create({ requestId: 'stable-request-id', requestHash: 'same-hash' });
        }));

        assert.equal(attempts.filter((attempt) => attempt.created).length, 1);
        assert.equal(new Set(attempts.map((attempt) => attempt.job.id)).size, 1);
        assert.equal((await store.list()).length, 1);

        await assert.rejects(
            store.create({ requestId: 'stable-request-id', requestHash: 'different-hash' }),
            (error) => {
                assert.equal(error instanceof IdempotencyConflictError, true);
                assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
                assert.equal(error.statusCode, 409);
                assert.equal(error.existingJobId, attempts[0].job.id);
                return true;
            },
        );
    });

    test('rebuilds the idempotency index when reopened', async () => {
        const { store, rootDir } = await makeStore();
        const original = await store.create({ requestId: 'request-after-restart', requestHash: 'hash-a' });

        const reopened = new ProxyStreamJobStore({ rootDir });
        await reopened.open();
        const reused = await reopened.create({ requestId: 'request-after-restart', requestHash: 'hash-a' });
        assert.equal(reused.created, false);
        assert.equal(reused.job.id, original.job.id);
        await assert.rejects(
            reopened.create({ requestId: 'request-after-restart', requestHash: 'hash-b' }),
            { code: 'IDEMPOTENCY_CONFLICT' },
        );
    });
});

describe('ProxyStreamJobStore recovery and lifecycle primitives', () => {
    test('fails an undispatched queued job on reopen and idempotent retry never reissues it', async () => {
        const { store, rootDir } = await makeStore();
        const created = await store.create({
            requestId: 'crash-before-dispatch',
            requestHash: 'same-request-envelope-hash',
        });
        assert.equal(created.job.state, 'queued');

        const reopened = new ProxyStreamJobStore({
            rootDir,
            now: () => 1_800_000_000_000,
        });
        const summary = await reopened.open();
        assert.deepEqual(summary, { jobs: 1, recoveredInterrupted: 0 });
        const failed = await reopened.get(created.job.id);
        assert.equal(failed.state, 'failed');
        assert.match(failed.error, /request envelope was not persisted/i);
        assert.deepEqual(failed.transportSummary, {
            cursor: 0,
            terminal: 'error',
        });
        const events = (await reopened.replay(created.job.id)).events;
        assert.deepEqual(events.map((event) => event.type), ['created', 'error', 'failed']);
        assert.equal(events[1].payload.status, 503);
        assert.equal(events[2].payload.reason, 'server_restart_before_dispatch');
        assert.equal(events[2].payload.providerRetried, false);

        const retry = await reopened.create({
            requestId: 'crash-before-dispatch',
            requestHash: 'same-request-envelope-hash',
        });
        assert.equal(retry.created, false);
        assert.equal(retry.job.id, created.job.id);
        assert.equal(retry.job.state, 'failed');
        assert.equal(retry.job.lastSequence, 3);

        const reopenedAgain = new ProxyStreamJobStore({ rootDir });
        await reopenedAgain.open();
        const afterSecondRestart = await reopenedAgain.get(created.job.id);
        assert.equal(afterSecondRestart.state, 'failed');
        assert.equal(afterSecondRestart.lastSequence, 3);
    });

    test('marks a running job interrupted exactly once when reopened', async () => {
        const { store, rootDir } = await makeStore();
        const { job } = await store.create({ requestId: 'running-request', requestHash: 'hash' });
        const running = await store.start(job.id, { worker: 'node-a' });
        assert.equal(running.state, 'running');
        assert.equal(running.attempt, 1);
        assert.equal(running.lastSequence, 2);

        const reopened = new ProxyStreamJobStore({ rootDir, now: () => 1_800_000_000_000 });
        const summary = await reopened.open();
        assert.deepEqual(summary, { jobs: 1, recoveredInterrupted: 1 });
        const interrupted = await reopened.get(job.id);
        assert.equal(interrupted.state, 'interrupted');
        assert.equal(interrupted.lastSequence, 3);
        assert.equal(interrupted.interruptedAt, 1_800_000_000_000);

        const reopenedAgain = new ProxyStreamJobStore({ rootDir });
        const secondSummary = await reopenedAgain.open();
        assert.deepEqual(secondSummary, { jobs: 1, recoveredInterrupted: 0 });
        assert.equal((await reopenedAgain.get(job.id)).lastSequence, 3);
        const events = (await reopenedAgain.replay(job.id)).events;
        assert.deepEqual(events.map((event) => event.type), ['created', 'running', 'interrupted']);
        assert.equal(events[2].payload.reason, 'server_restart');
    });

    test('supports list, get, cancel and terminal acknowledgement without changing terminal state', async () => {
        const { store, rootDir } = await makeStore();
        const first = await store.create({
            requestId: 'first',
            requestHash: 'hash-first',
            generationId: 'generation-a',
        });
        const second = await store.create({
            requestId: 'second',
            requestHash: 'hash-second',
            generationId: 'generation-b',
        });

        await store.start(first.job.id);
        const cancelled = await store.cancel(first.job.id, { reason: 'user_requested' });
        assert.equal(cancelled.state, 'cancelled');
        const cancelledAgain = await store.cancel(first.job.id);
        assert.equal(cancelledAgain.lastSequence, cancelled.lastSequence);

        await store.start(second.job.id);
        const completed = await store.complete(second.job.id, { finalOffset: 42 });
        assert.equal(completed.state, 'completed');
        const acknowledged = await store.ack(second.job.id, { databaseRevision: 9 });
        assert.equal(acknowledged.state, 'completed');
        assert.deepEqual(acknowledged.acknowledgement, { databaseRevision: 9 });
        const acknowledgedAgain = await store.ack(second.job.id, { databaseRevision: 10 });
        assert.equal(acknowledgedAgain.lastSequence, acknowledged.lastSequence);
        assert.deepEqual(acknowledgedAgain.acknowledgement, { databaseRevision: 9 });

        assert.deepEqual((await store.list({ state: 'cancelled' })).map((job) => job.id), [first.job.id]);
        assert.deepEqual((await store.list({ generationId: 'generation-b' })).map((job) => job.id), [second.job.id]);
        assert.deepEqual((await store.list({ acknowledged: true })).map((job) => job.id), [second.job.id]);
        assert.equal((await store.get(first.job.id)).cancelRequestedAt !== null, true);

        const reopened = new ProxyStreamJobStore({ rootDir });
        await reopened.open();
        const persistedAcknowledgement = await reopened.get(second.job.id);
        assert.equal(persistedAcknowledgement.state, 'completed');
        assert.deepEqual(persistedAcknowledgement.acknowledgement, { databaseRevision: 9 });
    });

    test('rejects acknowledgement of active jobs and illegal terminal transitions', async () => {
        const { store } = await makeStore();
        const { job } = await store.create({ requestId: 'active', requestHash: 'hash' });

        await assert.rejects(store.ack(job.id), InvalidStateTransitionError);
        await assert.rejects(
            store.appendEvent(job.id, 'completed', { state: 'completed' }),
            /reserved for job lifecycle operations/,
        );
        await store.start(job.id);
        await store.complete(job.id);
        await assert.rejects(store.transition(job.id, 'running'), InvalidStateTransitionError);
    });
});

describe('ProxyStreamJobStore global spool accounting and indexed replay', () => {
    test('serializes quota reservations, fails the rejected job durably, and prune releases bytes', async () => {
        const { store, rootDir } = await makeStore({
            maxSpoolBytes: 5_000,
            runningTerminalReserveBytes: 512,
            queuedTerminalReserveBytes: 1_024,
        });
        const first = await store.create({ requestId: 'quota-first', requestHash: 'hash-first' });
        const second = await store.create({ requestId: 'quota-second', requestHash: 'hash-second' });
        await store.start(first.job.id);
        await store.start(second.job.id);

        const payload = {
            offset: 0,
            endOffset: 1_500,
            dataBase64: Buffer.alloc(1_500, 7).toString('base64'),
        };
        const attempts = await Promise.allSettled([
            store.appendEvent(first.job.id, 'chunk', payload),
            store.appendEvent(second.job.id, 'chunk', payload),
        ]);
        assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
        const rejected = attempts.find((attempt) => attempt.status === 'rejected');
        assert.equal(rejected.reason instanceof SpoolQuotaExceededError, true);
        assert.equal(rejected.reason.code, 'SPOOL_QUOTA_EXCEEDED');

        const rejectedJobId = attempts[0].status === 'rejected' ? first.job.id : second.job.id;
        const acceptedJobId = rejectedJobId === first.job.id ? second.job.id : first.job.id;
        await store.finishWithError(rejectedJobId, {
            status: 507,
            message: rejected.reason.message,
            finalOffset: 0,
        }, {
            error: rejected.reason,
            details: { status: 507, reason: 'global_spool_quota' },
        });
        await store.complete(acceptedJobId);

        const failed = await store.get(rejectedJobId);
        assert.equal(failed.state, 'failed');
        assert.equal(failed.transportSummary.terminal, 'error');
        assert.equal((await store.get(acceptedJobId)).state, 'completed');
        const usageBeforeRestart = await store.usage();
        assert.ok(usageBeforeRestart.spoolBytes <= usageBeforeRestart.maxSpoolBytes);
        assert.equal(usageBeforeRestart.reservedBytes, 0);

        const reopened = new ProxyStreamJobStore({
            rootDir,
            maxSpoolBytes: 5_000,
            runningTerminalReserveBytes: 512,
            queuedTerminalReserveBytes: 1_024,
        });
        await reopened.open();
        assert.deepEqual(await reopened.usage(), usageBeforeRestart);
        assert.equal((await reopened.get(rejectedJobId)).state, 'failed');

        const pruned = await reopened.prune({ maxTerminalCount: 0 });
        assert.equal(pruned.removedCount, 2);
        assert.deepEqual(await reopened.usage(), {
            spoolBytes: 0,
            maxSpoolBytes: 5_000,
            reservedBytes: 0,
            availableBytes: 5_000,
        });
        const replacement = await reopened.create({
            requestId: 'quota-after-prune',
            requestHash: 'hash-after-prune',
        });
        assert.equal(replacement.created, true);
    });

    test('reads a large paginated replay once by indexed byte ranges and keeps summary in metadata', async () => {
        const reads = [];
        const { store, rootDir } = await makeStore({
            observeEventRead: (entry) => reads.push(entry),
        });
        const { job } = await store.create({ requestId: 'linear-replay', requestHash: 'hash' });
        await store.start(job.id);
        await store.appendEvent(job.id, 'upstream_headers', {
            status: 206,
            headers: { 'content-type': 'application/octet-stream' },
        });
        let offset = 0;
        for (let index = 0; index < 128; index += 1) {
            const chunk = Buffer.alloc(16 * 1024, index);
            await store.appendEvent(job.id, 'chunk', {
                offset,
                endOffset: offset + chunk.length,
                dataBase64: chunk.toString('base64'),
            });
            offset += chunk.length;
        }
        await store.appendEvent(job.id, 'done', { finalOffset: offset });
        await store.complete(job.id, { finalOffset: offset });
        const usage = await store.usage();
        assert.ok(usage.spoolBytes > 2 * 1024 * 1024);

        const sequences = [];
        let afterSequence = 0;
        while (true) {
            const page = await store.replay(job.id, { afterSequence, limit: 11 });
            sequences.push(...page.events.map((event) => event.sequence));
            afterSequence = page.nextCursor;
            if (!page.hasMore) {
                break;
            }
        }
        assert.deepEqual(
            sequences,
            Array.from({ length: 133 }, (_, index) => index + 1),
        );
        const replayBytes = reads
            .filter((entry) => entry.reason === 'replay')
            .reduce((total, entry) => total + entry.bytes, 0);
        assert.equal(replayBytes, usage.spoolBytes);

        reads.length = 0;
        const reopened = new ProxyStreamJobStore({
            rootDir,
            observeEventRead: (entry) => reads.push(entry),
        });
        await reopened.open();
        const recoveryBytes = reads
            .filter((entry) => entry.reason === 'recovery')
            .reduce((total, entry) => total + entry.bytes, 0);
        assert.equal(recoveryBytes, usage.spoolBytes);
        const recovered = await reopened.get(job.id);
        assert.deepEqual(recovered.transportSummary, {
            status: 206,
            headers: { 'content-type': 'application/octet-stream' },
            cursor: offset,
            terminal: 'done',
        });
    });
});

describe('ProxyStreamJobStore bounded terminal retention', () => {
    test('applies distinct strict cutoffs to acknowledged and unacknowledged terminal jobs', async () => {
        let timestamp = 1_000;
        const { store } = await makeStore({ now: () => timestamp });

        const acknowledgedOld = await store.create({
            requestId: 'acknowledged-old',
            requestHash: 'hash-acknowledged-old',
        });
        timestamp = 1_010;
        await store.start(acknowledgedOld.job.id);
        timestamp = 1_020;
        await store.complete(acknowledgedOld.job.id);
        timestamp = 1_030;
        await store.ack(acknowledgedOld.job.id);

        timestamp = 1_100;
        const acknowledgedBoundary = await store.create({
            requestId: 'acknowledged-boundary',
            requestHash: 'hash-acknowledged-boundary',
        });
        timestamp = 1_110;
        await store.start(acknowledgedBoundary.job.id);
        timestamp = 1_120;
        await store.complete(acknowledgedBoundary.job.id);
        timestamp = 1_200;
        await store.ack(acknowledgedBoundary.job.id);

        timestamp = 1_300;
        const unacknowledgedOld = await store.create({
            requestId: 'unacknowledged-old',
            requestHash: 'hash-unacknowledged-old',
        });
        timestamp = 1_310;
        await store.start(unacknowledgedOld.job.id);
        timestamp = 1_320;
        await store.fail(unacknowledgedOld.job.id, 'upstream failed');

        timestamp = 1_400;
        const unacknowledgedBoundary = await store.create({
            requestId: 'unacknowledged-boundary',
            requestHash: 'hash-unacknowledged-boundary',
        });
        timestamp = 1_410;
        await store.start(unacknowledgedBoundary.job.id);
        timestamp = 1_500;
        await store.complete(unacknowledgedBoundary.job.id);

        const result = await store.prune({
            acknowledgedBefore: 1_200,
            unacknowledgedBefore: 1_500,
        });

        assert.deepEqual(
            result.removed.map(({ id, reason }) => ({ id, reason })),
            [
                { id: acknowledgedOld.job.id, reason: 'acknowledged_cutoff' },
                { id: unacknowledgedOld.job.id, reason: 'unacknowledged_cutoff' },
            ],
        );
        assert.equal(result.removedCount, 2);
        assert.equal(result.remainingJobCount, 2);
        assert.equal(result.remainingTerminalCount, 2);
        assert.deepEqual(
            (await store.list()).map((job) => job.id),
            [acknowledgedBoundary.job.id, unacknowledgedBoundary.job.id],
        );
    });

    test('enforces the terminal count bound by age while preserving queued and running jobs', async () => {
        let timestamp = 2_000;
        const { store } = await makeStore({ now: () => timestamp });
        const terminalJobs = [];
        for (let index = 0; index < 4; index += 1) {
            timestamp += 10;
            const created = await store.create({
                requestId: `terminal-${index}`,
                requestHash: `hash-terminal-${index}`,
            });
            timestamp += 10;
            await store.start(created.job.id);
            timestamp += 10;
            await store.complete(created.job.id);
            terminalJobs.push(created.job.id);
        }

        timestamp += 10;
        const queued = await store.create({ requestId: 'still-queued', requestHash: 'hash-queued' });
        timestamp += 10;
        const running = await store.create({ requestId: 'still-running', requestHash: 'hash-running' });
        timestamp += 10;
        await store.start(running.job.id);

        const result = await store.prune({ maxTerminalCount: 2 });
        assert.deepEqual(
            result.removed.map(({ id, reason }) => ({ id, reason })),
            terminalJobs.slice(0, 2).map((id) => ({ id, reason: 'max_terminal_count' })),
        );
        assert.equal(result.remainingTerminalCount, 2);
        assert.deepEqual(
            (await store.list()).map((job) => job.id),
            [...terminalJobs.slice(2), queued.job.id, running.job.id],
        );
        assert.equal((await store.get(queued.job.id)).state, 'queued');
        assert.equal((await store.get(running.job.id)).state, 'running');
    });

    test('cleans the idempotency index and remains purged after reopen', async () => {
        let timestamp = 3_000;
        const { store, rootDir } = await makeStore({ now: () => timestamp });
        const original = await store.create({
            requestId: 'reusable-after-prune',
            requestHash: 'original-hash',
        });
        timestamp += 10;
        await store.start(original.job.id);
        timestamp += 10;
        await store.complete(original.job.id);

        const result = await store.prune({ maxTerminalCount: 0 });
        assert.deepEqual(result.removed.map((job) => job.id), [original.job.id]);
        await assert.rejects(store.get(original.job.id), { code: 'JOB_NOT_FOUND' });
        await assert.rejects(fs.stat(path.join(rootDir, original.job.id)), { code: 'ENOENT' });

        timestamp += 10;
        const replacement = await store.create({
            requestId: 'reusable-after-prune',
            requestHash: 'replacement-hash',
        });
        assert.equal(replacement.created, true);
        assert.notEqual(replacement.job.id, original.job.id);

        const reopened = new ProxyStreamJobStore({ rootDir });
        const summary = await reopened.open();
        assert.deepEqual(summary, { jobs: 1, recoveredInterrupted: 0 });
        const reused = await reopened.create({
            requestId: 'reusable-after-prune',
            requestHash: 'replacement-hash',
        });
        assert.equal(reused.created, false);
        assert.equal(reused.job.id, replacement.job.id);
        assert.deepEqual(
            (await fs.readdir(rootDir)).filter((entry) => entry.startsWith('.purge.')),
            [],
        );
    });

    test('finishes cleanup of an atomically renamed purge tombstone on reopen', async () => {
        const { store, rootDir } = await makeStore();
        const { job } = await store.create({
            requestId: 'crash-during-purge',
            requestHash: 'hash-before-crash',
        });
        await store.start(job.id);
        await store.complete(job.id);

        const tombstoneName = `.purge.${job.id}.${'a'.repeat(32)}`;
        await fs.rename(path.join(rootDir, job.id), path.join(rootDir, tombstoneName));

        const reopened = new ProxyStreamJobStore({ rootDir });
        const summary = await reopened.open();
        assert.deepEqual(summary, { jobs: 0, recoveredInterrupted: 0 });
        await assert.rejects(fs.stat(path.join(rootDir, tombstoneName)), { code: 'ENOENT' });

        const replacement = await reopened.create({
            requestId: 'crash-during-purge',
            requestHash: 'hash-after-crash',
        });
        assert.equal(replacement.created, true);
    });

    test('rejects invalid policies and refuses to follow a replaced job-directory symlink', async () => {
        const { store, rootDir } = await makeStore();
        await assert.rejects(store.prune({ acknowledgedBefore: -1 }), TypeError);
        await assert.rejects(store.prune({ unacknowledgedBefore: 1.5 }), TypeError);
        await assert.rejects(store.prune({ maxTerminalCount: -1 }), TypeError);

        const { job } = await store.create({ requestId: 'symlink-job', requestHash: 'symlink-hash' });
        await store.start(job.id);
        await store.complete(job.id);

        const jobDirectory = path.join(rootDir, job.id);
        const originalDirectory = path.join(rootDir, '.original-job-directory');
        const victimDirectory = path.join(path.dirname(rootDir), 'outside-victim');
        await fs.rename(jobDirectory, originalDirectory);
        await fs.mkdir(victimDirectory);
        const markerPath = path.join(victimDirectory, 'must-survive.txt');
        await fs.writeFile(markerPath, 'safe');
        await fs.symlink(victimDirectory, jobDirectory, 'dir');

        await assert.rejects(
            store.prune({ maxTerminalCount: 0 }),
            (error) => error instanceof JobStoreCorruptionError,
        );
        assert.equal(await fs.readFile(markerPath, 'utf8'), 'safe');
        assert.equal((await store.get(job.id)).state, 'completed');
    });
});
