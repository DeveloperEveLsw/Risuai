const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test } = require('node:test');

const {
    IdempotencyConflictError,
    RuntimeGenerationStore,
    RuntimeGenerationStoreCorruptionError,
    StaleExecutorFenceError,
    canonicalJsonStringify,
    hashCanonicalRequest,
} = require('./commandStore.cjs');

const temporaryDirectories = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => {
        return fs.rm(directory, { recursive: true, force: true });
    }));
});

function createClock(initial = 1_700_000_000_000) {
    let value = initial;
    return {
        now: () => value,
        advance(milliseconds) {
            value += milliseconds;
            return value;
        },
    };
}

async function makeFixture(options = {}) {
    const temporaryRoot = process.platform === 'linux' ? '/tmp' : os.tmpdir();
    const temporaryDirectory = await fs.mkdtemp(path.join(temporaryRoot, 'risu-runtime-generations-'));
    temporaryDirectories.push(temporaryDirectory);
    const rootDir = path.join(temporaryDirectory, 'commands');
    const clock = options.clock ?? createClock();
    let nextId = 0;
    const store = new RuntimeGenerationStore({
        rootDir,
        now: clock.now,
        idFactory: options.idFactory ?? (() => `command-${++nextId}`),
        defaultLeaseDurationMs: options.defaultLeaseDurationMs ?? 1_000,
        maxLeaseDurationMs: options.maxLeaseDurationMs ?? 60_000,
    });
    await store.open();
    return { clock, rootDir, store };
}

function commandInput(suffix, overrides = {}) {
    const payload = overrides.payload ?? {
        message: `message-${suffix}`,
        settings: { stream: true, temperature: 0.7 },
    };
    return {
        requestId: `request-${suffix}`,
        requestHash: hashCanonicalRequest({
            action: overrides.action ?? 'send',
            characterId: overrides.characterId ?? 'character-1',
            chatId: overrides.chatId ?? 'chat-1',
            payload,
        }),
        action: overrides.action ?? 'send',
        characterId: overrides.characterId ?? 'character-1',
        chatId: overrides.chatId ?? 'chat-1',
        payload,
        ...overrides,
    };
}

function permissions(stat) {
    return stat.mode & 0o777;
}

describe('RuntimeGenerationStore command persistence and idempotency', () => {
    test('hashes canonical JSON and returns one durable command for duplicate creates', async () => {
        assert.equal(
            canonicalJsonStringify({ z: 1, a: { y: 2, x: [true, null] } }),
            '{"a":{"x":[true,null],"y":2},"z":1}',
        );
        assert.equal(
            hashCanonicalRequest({ z: 1, a: { y: 2, x: true } }),
            hashCanonicalRequest({ a: { x: true, y: 2 }, z: 1 }),
        );

        const { rootDir, store } = await makeFixture();
        const input = commandInput('duplicate');
        const attempts = await Promise.all(Array.from({ length: 12 }, () => store.create(input)));
        assert.equal(attempts.filter((attempt) => attempt.created).length, 1);
        assert.equal(new Set(attempts.map((attempt) => attempt.command.id)).size, 1);

        const command = attempts[0].command;
        assert.equal(command.state, 'queued');
        assert.equal(command.action, 'send');
        assert.equal(command.characterId, 'character-1');
        assert.equal(command.chatId, 'chat-1');
        assert.deepEqual(command.payload, input.payload);
        assert.equal(command.executorId, null);
        assert.equal(command.fencingToken, null);
        assert.equal(command.leaseExpiresAt, null);
        assert.equal(command.result, null);
        assert.equal(command.error, null);

        input.payload.settings.temperature = 1;
        assert.equal((await store.get(command.id)).payload.settings.temperature, 0.7);

        await assert.rejects(
            store.create({ ...commandInput('conflict'), requestId: input.requestId }),
            (error) => {
                assert.equal(error instanceof IdempotencyConflictError, true);
                assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
                assert.equal(error.statusCode, 409);
                assert.equal(error.existingCommandId, command.id);
                return true;
            },
        );

        const commandDirectory = path.join(rootDir, command.id);
        assert.equal(permissions(await fs.stat(rootDir)), 0o700);
        assert.equal(permissions(await fs.stat(commandDirectory)), 0o700);
        assert.equal(permissions(await fs.stat(path.join(rootDir, 'store.json'))), 0o600);
        assert.equal(permissions(await fs.stat(path.join(commandDirectory, 'meta.json'))), 0o600);
        assert.equal(permissions(await fs.stat(path.join(commandDirectory, 'events.ndjson'))), 0o600);
    });

    test('persists explicit command fields and supports list, get, and cancel', async () => {
        const { store } = await makeFixture();
        const first = await store.create(commandInput('first', {
            action: 'send',
            characterId: 'character-a',
            chatId: 'chat-a',
        }));
        const second = await store.create(commandInput('second', {
            action: 'regenerate',
            characterId: 'character-b',
            chatId: 'chat-b',
        }));

        const cancelled = await store.cancel(first.command.id, { deviceId: 'phone' });
        assert.equal(cancelled.state, 'cancelled');
        assert.equal(cancelled.cancelRequestedAt !== null, true);
        assert.equal(cancelled.finishedAt !== null, true);
        assert.equal((await store.cancel(first.command.id)).lastSequence, cancelled.lastSequence);

        assert.deepEqual(
            (await store.list({ state: 'cancelled' })).map((command) => command.id),
            [first.command.id],
        );
        assert.deepEqual(
            (await store.list({ action: 'regenerate', characterId: 'character-b', chatId: 'chat-b' }))
                .map((command) => command.id),
            [second.command.id],
        );
        assert.equal((await store.get(second.command.id)).state, 'queued');
        assert.deepEqual(
            (await store.replay(first.command.id)).events.map((event) => event.type),
            ['created', 'cancelled'],
        );
    });
});

describe('RuntimeGenerationStore terminal command retention', () => {
    test('prunes only commands finished before the cutoff and releases their request ids', async () => {
        const clock = createClock(1_000);
        const { rootDir, store } = await makeFixture({ clock });
        const completedInput = commandInput('prune-completed');
        const failedInput = commandInput('prune-failed');
        const cancelledInput = commandInput('prune-cancelled');
        const runningInput = commandInput('prune-running');
        const queuedInput = commandInput('prune-queued');

        const completed = await store.create(completedInput);
        const completedLease = await store.claimNext({ executorId: 'resident-completed' });
        await store.complete(completed.command.id, completedLease.lease, { text: 'done' });

        clock.advance(10);
        const failed = await store.create(failedInput);
        const failedLease = await store.claimNext({ executorId: 'resident-failed' });
        const failedTerminal = await store.fail(
            failed.command.id,
            failedLease.lease,
            new Error('provider failed'),
            { databaseRevision: 3, canonicalMutationPersisted: true },
        );
        assert.deepEqual(failedTerminal.result, {
            databaseRevision: 3,
            canonicalMutationPersisted: true,
        });

        clock.advance(10);
        const cancelled = await store.create(cancelledInput);
        await store.cancel(cancelled.command.id, { reason: 'test' });

        const running = await store.create(runningInput);
        const runningLease = await store.claimNext({ executorId: 'resident-running' });
        assert.equal(runningLease.command.id, running.command.id);
        const queued = await store.create(queuedInput);

        await assert.rejects(store.prune(), /requires terminalBefore or maxTerminalCount/);
        await assert.rejects(store.prune({ terminalBefore: -1 }), /terminalBefore/);
        await assert.rejects(store.prune({ maxTerminalCount: 1.5 }), /maxTerminalCount/);

        // `before` is strict: the cancellation finished exactly at the cutoff.
        const audit = await store.prune({ terminalBefore: clock.now() });
        assert.deepEqual(audit, {
            pruned: [
                {
                    id: completed.command.id,
                    requestId: completedInput.requestId,
                    requestHash: completedInput.requestHash,
                    action: completedInput.action,
                    state: 'completed',
                    createdAt: 1_000,
                    finishedAt: 1_000,
                    lastSequence: 3,
                },
                {
                    id: failed.command.id,
                    requestId: failedInput.requestId,
                    requestHash: failedInput.requestHash,
                    action: failedInput.action,
                    state: 'failed',
                    createdAt: 1_010,
                    finishedAt: 1_010,
                    lastSequence: 3,
                },
            ],
            prunedCount: 2,
            retainedTerminalCount: 1,
            cleanupPending: 0,
        });

        await assert.rejects(store.get(completed.command.id), { code: 'COMMAND_NOT_FOUND' });
        await assert.rejects(store.get(failed.command.id), { code: 'COMMAND_NOT_FOUND' });
        assert.equal((await store.get(cancelled.command.id)).state, 'cancelled');
        assert.equal((await store.get(running.command.id)).state, 'running');
        assert.equal((await store.get(queued.command.id)).state, 'queued');
        await assert.rejects(fs.access(path.join(rootDir, completed.command.id)), { code: 'ENOENT' });
        await assert.rejects(fs.access(path.join(rootDir, failed.command.id)), { code: 'ENOENT' });

        const reused = await store.create(completedInput);
        assert.equal(reused.created, true);
        assert.notEqual(reused.command.id, completed.command.id);
        assert.equal(reused.command.state, 'queued');
    });

    test('enforces the terminal count by removing oldest states, including interrupted work', async () => {
        const clock = createClock(2_000);
        const { store } = await makeFixture({ clock });

        const completed = await store.create(commandInput('count-completed'));
        let lease = await store.claimNext({ executorId: 'resident-1', leaseDurationMs: 100 });
        await store.complete(completed.command.id, lease.lease, {});

        clock.advance(10);
        const failed = await store.create(commandInput('count-failed'));
        lease = await store.claimNext({ executorId: 'resident-2', leaseDurationMs: 100 });
        await store.fail(failed.command.id, lease.lease, new Error('failed'));

        clock.advance(10);
        const cancelled = await store.create(commandInput('count-cancelled'));
        await store.cancel(cancelled.command.id);

        clock.advance(10);
        const interrupted = await store.create(commandInput('count-interrupted'));
        lease = await store.claimNext({ executorId: 'resident-3', leaseDurationMs: 100 });
        clock.advance(100);
        await store.expireLease();

        clock.advance(10);
        const newest = await store.create(commandInput('count-newest'));
        lease = await store.claimNext({ executorId: 'resident-4', leaseDurationMs: 100 });
        await store.complete(newest.command.id, lease.lease, {});

        const firstAudit = await store.prune({ maxTerminalCount: 2 });
        assert.deepEqual(
            firstAudit.pruned.map((command) => [command.id, command.state]),
            [
                [completed.command.id, 'completed'],
                [failed.command.id, 'failed'],
                [cancelled.command.id, 'cancelled'],
            ],
        );
        assert.equal(firstAudit.prunedCount, 3);
        assert.equal(firstAudit.retainedTerminalCount, 2);
        assert.equal(firstAudit.cleanupPending, 0);
        assert.deepEqual(
            (await store.list()).map((command) => [command.id, command.state]),
            [
                [interrupted.command.id, 'interrupted'],
                [newest.command.id, 'completed'],
            ],
        );

        const secondAudit = await store.prune({ maxTerminalCount: 0 });
        assert.deepEqual(
            secondAudit.pruned.map((command) => [command.id, command.state]),
            [
                [interrupted.command.id, 'interrupted'],
                [newest.command.id, 'completed'],
            ],
        );
        assert.equal(secondAudit.retainedTerminalCount, 0);
        assert.deepEqual(await store.list(), []);
    });

    test('cleans a crash-left tombstone on reopen without indexing the deleted command', async () => {
        const { rootDir, store } = await makeFixture();
        const input = commandInput('crash-tombstone');
        const { command } = await store.create(input);
        await store.cancel(command.id);

        const tombstonePath = path.join(rootDir, `.prune-${'a'.repeat(32)}.tombstone`);
        await fs.rename(path.join(rootDir, command.id), tombstonePath);
        const unrelatedDotDirectory = path.join(rootDir, '.prune-not-a-tombstone');
        await fs.mkdir(unrelatedDotDirectory);

        const reopened = new RuntimeGenerationStore({ rootDir });
        const summary = await reopened.open();
        assert.equal(summary.commands, 0);
        assert.deepEqual(await reopened.list(), []);
        await assert.rejects(fs.access(tombstonePath), { code: 'ENOENT' });
        assert.equal((await fs.stat(unrelatedDotDirectory)).isDirectory(), true);

        const recreated = await reopened.create(input);
        assert.equal(recreated.created, true);
        assert.notEqual(recreated.command.id, command.id);
    });

    test('rejects a command-directory symlink without deleting its target or changing indexes', async () => {
        const { rootDir, store } = await makeFixture();
        const input = commandInput('prune-symlink');
        const { command } = await store.create(input);
        await store.cancel(command.id);

        const commandPath = path.join(rootDir, command.id);
        const originalPath = path.join(rootDir, '.original-command-directory');
        const outsidePath = path.join(path.dirname(rootDir), 'outside-prune-target');
        const markerPath = path.join(outsidePath, 'marker.txt');
        await fs.mkdir(outsidePath);
        await fs.writeFile(markerPath, 'must survive');
        await fs.rename(commandPath, originalPath);
        await fs.symlink(outsidePath, commandPath, 'dir');

        await assert.rejects(
            store.prune({ maxTerminalCount: 0 }),
            (error) => {
                assert.equal(error instanceof RuntimeGenerationStoreCorruptionError, true);
                assert.equal(error.code, 'RUNTIME_GENERATION_STORE_CORRUPTION');
                return true;
            },
        );
        assert.equal(await fs.readFile(markerPath, 'utf8'), 'must survive');
        assert.equal((await fs.lstat(commandPath)).isSymbolicLink(), true);
        assert.equal((await store.get(command.id)).state, 'cancelled');
        const duplicate = await store.create(input);
        assert.equal(duplicate.created, false);
        assert.equal(duplicate.command.id, command.id);
    });
});

describe('RuntimeGenerationStore global executor fencing', () => {
    test('allows only one concurrent claimant and fences every non-owner mutation', async () => {
        const { clock, store } = await makeFixture();
        const { command } = await store.create(commandInput('claim-race'));

        const [claimA, claimB] = await Promise.all([
            store.claimNext({ executorId: 'executor-a', leaseDurationMs: 500 }),
            store.claimNext({ executorId: 'executor-b', leaseDurationMs: 500 }),
        ]);
        assert.notEqual(claimA, null);
        assert.equal(claimB, null);
        assert.equal(claimA.command.id, command.id);
        assert.equal(claimA.command.state, 'running');
        assert.equal(claimA.command.executorId, 'executor-a');
        assert.equal(claimA.command.fencingToken, 1);
        assert.equal(claimA.command.leaseExpiresAt, claimA.lease.expiresAt);
        const assertedLease = await store.assertCurrentLease(command.id, claimA.lease);
        assert.equal(assertedLease.command.id, command.id);
        assert.deepEqual(assertedLease.lease, claimA.lease);

        const duplicateClaim = await store.claimNext({ executorId: 'executor-a' });
        assert.equal(duplicateClaim.command.id, command.id);
        assert.equal(duplicateClaim.lease.fencingToken, claimA.lease.fencingToken);

        const staleCredential = { executorId: 'executor-b', fencingToken: claimA.lease.fencingToken };
        for (const operation of [
            () => store.appendProgress(command.id, staleCredential, 'token', { text: 'forged' }),
            () => store.heartbeat(command.id, { ...staleCredential, leaseDurationMs: 500 }),
            () => store.complete(command.id, staleCredential, { text: 'forged' }),
            () => store.fail(command.id, staleCredential, new Error('forged')),
        ]) {
            await assert.rejects(operation(), (error) => {
                assert.equal(error instanceof StaleExecutorFenceError, true);
                assert.equal(error.code, 'STALE_EXECUTOR_FENCE');
                return true;
            });
        }

        clock.advance(100);
        const heartbeat = await store.heartbeat(command.id, {
            executorId: 'executor-a',
            fencingToken: claimA.lease.fencingToken,
            leaseDurationMs: 900,
        });
        assert.equal(heartbeat.lease.expiresAt, clock.now() + 900);
        assert.equal(heartbeat.command.leaseExpiresAt, heartbeat.lease.expiresAt);

        await store.appendProgress(command.id, claimA.lease, 'token', { text: 'hello' });
        const completed = await store.complete(command.id, claimA.lease, { text: 'hello' });
        assert.equal(completed.state, 'completed');
        assert.deepEqual(completed.result, { text: 'hello' });
        assert.equal(completed.executorId, null);
        assert.equal(completed.fencingToken, null);
        assert.equal(completed.leaseExpiresAt, null);

        await assert.rejects(
            store.appendProgress(command.id, claimA.lease, 'token', { text: 'late' }),
            { code: 'STALE_EXECUTOR_FENCE' },
        );

        const next = await store.create(commandInput('next-fence'));
        const nextClaim = await store.claimNext({ executorId: 'executor-b' });
        assert.equal(nextClaim.command.id, next.command.id);
        assert.equal(nextClaim.lease.fencingToken, 2);
    });

    test('interrupts an expired lease only when explicitly swept and never reclaims it', async () => {
        const { clock, store } = await makeFixture();
        const first = await store.create(commandInput('expires-first'));
        const second = await store.create(commandInput('expires-second'));
        const claim = await store.claimNext({ executorId: 'resident', leaseDurationMs: 100 });
        assert.equal(claim.command.id, first.command.id);

        clock.advance(100);
        await assert.rejects(
            store.assertCurrentLease(first.command.id, claim.lease),
            { code: 'STALE_EXECUTOR_FENCE', reason: 'lease_expired' },
        );
        await assert.rejects(
            store.appendProgress(first.command.id, claim.lease, 'token', { text: 'too late' }),
            (error) => {
                assert.equal(error.code, 'STALE_EXECUTOR_FENCE');
                assert.equal(error.reason, 'lease_expired');
                return true;
            },
        );

        // Reads do not silently transition state, so an adapter can broadcast
        // the explicit expiry result exactly once.
        assert.equal((await store.get(first.command.id)).state, 'running');
        assert.equal(await store.claimNext({ executorId: 'other' }), null);

        const expired = await store.expireLease();
        assert.equal(expired.id, first.command.id);
        assert.equal(expired.state, 'interrupted');
        assert.equal(expired.executorId, null);
        assert.equal(expired.fencingToken, null);
        assert.equal(expired.leaseExpiresAt, null);
        assert.equal(await store.expireLease(), null);

        const nextClaim = await store.claimNext({ executorId: 'other', leaseDurationMs: 100 });
        assert.equal(nextClaim.command.id, second.command.id);
        assert.equal(nextClaim.lease.fencingToken, claim.lease.fencingToken + 1);
        await store.complete(second.command.id, nextClaim.lease, { ok: true });

        // Interrupted commands are terminal for scheduling and are never
        // automatically placed back on the queue.
        assert.equal(await store.claimNext({ executorId: 'third' }), null);
        assert.deepEqual(
            (await store.replay(first.command.id)).events.map((event) => event.type),
            ['created', 'running', 'interrupted'],
        );
        assert.equal(
            (await store.replay(first.command.id)).events.at(-1).payload.reason,
            'lease_expired',
        );
    });

    test('running cancellation stays fenced until the executor persists and completes it', async () => {
        const { store } = await makeFixture();
        const first = await store.create(commandInput('cancel-running'));
        const second = await store.create(commandInput('after-cancel'));
        const claim = await store.claimNext({ executorId: 'resident' });

        const requested = await store.cancel(first.command.id, { reason: 'user_requested' });
        assert.equal(requested.state, 'running');
        assert.notEqual(requested.cancelRequestedAt, null);
        assert.equal(requested.finishedAt, null);
        assert.equal(requested.executorId, claim.lease.executorId);
        assert.equal(requested.fencingToken, claim.lease.fencingToken);
        assert.equal(requested.leaseExpiresAt, claim.lease.expiresAt);
        const duplicate = await store.cancel(first.command.id, { reason: 'duplicate' });
        assert.equal(duplicate.lastSequence, requested.lastSequence);

        await assert.rejects(
            store.fail(first.command.id, claim.lease, new Error('late failure')),
            { code: 'INVALID_COMMAND_STATE' },
        );
        await assert.rejects(
            store.complete(first.command.id, claim.lease, { generated: true }),
            { code: 'INVALID_COMMAND_STATE' },
        );
        assert.equal(await store.claimNext({ executorId: 'replacement' }), null);

        await assert.rejects(
            store.completeCancellation(first.command.id, {
                executorId: 'forged',
                fencingToken: claim.lease.fencingToken,
            }, { databaseRevision: 8 }),
            { code: 'STALE_EXECUTOR_FENCE' },
        );
        const cancelled = await store.completeCancellation(first.command.id, claim.lease, {
            databaseRevision: 8,
            canonicalMutationPersisted: true,
        });
        assert.equal(cancelled.state, 'cancelled');
        assert.deepEqual(cancelled.result, {
            databaseRevision: 8,
            canonicalMutationPersisted: true,
        });
        assert.deepEqual(
            (await store.replay(first.command.id)).events.map((event) => event.type),
            ['created', 'running', 'cancel_requested', 'cancelled'],
        );

        const nextClaim = await store.claimNext({ executorId: 'replacement' });
        assert.equal(nextClaim.command.id, second.command.id);
        assert.equal(nextClaim.lease.fencingToken, claim.lease.fencingToken + 1);
    });

    test('linearizes a fenced database write against cancellation and new claims', async () => {
        const { store } = await makeFixture();
        const first = await store.create(commandInput('database-write'));
        const second = await store.create(commandInput('after-database-write'));
        const claim = await store.claimNext({ executorId: 'resident' });

        await assert.rejects(
            store.runWithDatabaseWriteFence(null, async () => 'unfenced'),
            { code: 'GENERATION_WRITE_LEASE_ACTIVE', statusCode: 423 },
        );

        let enterWrite;
        const entered = new Promise((resolve) => { enterWrite = resolve; });
        let releaseWrite;
        const release = new Promise((resolve) => { releaseWrite = resolve; });
        let cancellationFinished = false;
        const write = store.runWithDatabaseWriteFence({
            commandId: first.command.id,
            ...claim.lease,
        }, async () => {
            enterWrite();
            await release;
            return 'committed';
        });
        await entered;

        const cancellation = store.cancel(first.command.id, { reason: 'raced' })
            .then((value) => {
                cancellationFinished = true;
                return value;
            });
        let replacementClaimFinished = false;
        const replacementClaim = store.claimNext({ executorId: 'replacement' })
            .then((value) => {
                replacementClaimFinished = true;
                return value;
            });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(cancellationFinished, false);
        assert.equal(replacementClaimFinished, false);

        releaseWrite();
        assert.equal(await write, 'committed');
        const requested = await cancellation;
        assert.equal(requested.state, 'running');
        assert.notEqual(requested.cancelRequestedAt, null);

        assert.equal(await store.runWithDatabaseWriteFence({
            commandId: first.command.id,
            ...claim.lease,
        }, async () => 'persisted-after-cancel'), 'persisted-after-cancel');
        assert.equal(await replacementClaim, null);
        await store.completeCancellation(first.command.id, claim.lease, { databaseRevision: 4 });
        const nextClaim = await store.claimNext({ executorId: 'replacement' });
        assert.equal(nextClaim.command.id, second.command.id);
    });
});

describe('RuntimeGenerationStore event replay and restart recovery', () => {
    test('durably fences UI prompts and commits exactly one observer response', async () => {
        const { store } = await makeFixture();
        const { command } = await store.create(commandInput('ui-prompt'));
        const claim = await store.claimNext({ executorId: 'resident' });
        const prompt = {
            type: 'input',
            msg: 'Low-level plugin input',
            defaultValue: 'seed',
        };

        await assert.rejects(
            store.appendProgress(command.id, claim.lease, 'ui_prompt', {
                promptId: 'forged',
                prompt,
            }),
            /reserved/,
        );
        const issued = await store.issueUiPrompt(
            command.id,
            claim.lease,
            'prompt-1',
            prompt,
        );
        assert.equal(issued.created, true);
        const duplicateIssue = await store.issueUiPrompt(
            command.id,
            claim.lease,
            'prompt-1',
            prompt,
        );
        assert.equal(duplicateIssue.created, false);
        assert.equal(duplicateIssue.record.sequence, issued.record.sequence);

        const [desktop, phone] = await Promise.all([
            store.respondToUiPrompt(command.id, 'prompt-1'),
            store.respondToUiPrompt(command.id, 'prompt-1'),
        ]);
        assert.equal([desktop, phone].filter((result) => result.created).length, 1);
        assert.equal(desktop.record.sequence, phone.record.sequence);
        assert.deepEqual(desktop.record.payload, { promptId: 'prompt-1', responded: true });

        await store.complete(command.id, claim.lease, { generated: true });
        const retryAfterTerminal = await store.respondToUiPrompt(
            command.id,
            'prompt-1',
        );
        assert.equal(retryAfterTerminal.created, false);
        assert.deepEqual(retryAfterTerminal.record.payload, desktop.record.payload);
        const replay = await store.replay(command.id);
        assert.deepEqual(
            replay.events.map((event) => event.type),
            ['created', 'running', 'ui_prompt', 'ui_prompt_response', 'completed'],
        );
    });

    test('rejects responses to prompts that were never issued by a running executor', async () => {
        const { store } = await makeFixture();
        const { command } = await store.create(commandInput('missing-ui-prompt'));
        const claim = await store.claimNext({ executorId: 'resident' });

        await assert.rejects(
            store.respondToUiPrompt(command.id, 'not-issued'),
            { code: 'UI_PROMPT_NOT_FOUND' },
        );
        await store.cancel(command.id);
        await assert.rejects(
            store.respondToUiPrompt(command.id, 'not-issued'),
            { code: 'INVALID_COMMAND_STATE' },
        );
        assert.equal(claim.command.id, command.id);
    });

    test('provides independent, non-destructive replay readers over gap-free JSONL events', async () => {
        const { store } = await makeFixture();
        const { command } = await store.create(commandInput('replay'));
        const claim = await store.claimNext({ executorId: 'resident' });

        await Promise.all(Array.from({ length: 30 }, (_, index) => {
            return store.appendProgress(command.id, claim.lease, 'token', {
                index,
                text: String.fromCharCode(65 + (index % 26)),
            });
        }));
        await store.complete(command.id, claim.lease, { tokenCount: 30 });

        const [readerA, readerB] = await Promise.all([
            store.replay(command.id, { afterSequence: 1, limit: 7 }),
            store.replay(command.id, { afterSequence: 1, limit: 7 }),
        ]);
        assert.deepEqual(readerA, readerB);
        assert.deepEqual(readerA.events.map((event) => event.sequence), [2, 3, 4, 5, 6, 7, 8]);
        assert.equal(readerA.hasMore, true);

        const allEvents = [];
        let cursor = 0;
        let hasMore = true;
        while (hasMore) {
            const page = await store.replay(command.id, { afterSequence: cursor, limit: 5 });
            allEvents.push(...page.events);
            cursor = page.nextCursor;
            hasMore = page.hasMore;
        }
        assert.deepEqual(
            allEvents.map((event) => event.sequence),
            Array.from({ length: 33 }, (_, index) => index + 1),
        );
        assert.equal(allEvents[0].type, 'created');
        assert.equal(allEvents[1].type, 'running');
        assert.equal(allEvents.at(-1).type, 'completed');
        assert.equal((await store.get(command.id)).lastSequence, 33);
    });

    test('retains completed work, interrupts running work on reopen, and preserves fencing order', async () => {
        const clock = createClock();
        const { rootDir, store } = await makeFixture({ clock });
        const completedInput = commandInput('completed');
        const runningInput = commandInput('running');
        const queuedInput = commandInput('queued');
        const completed = await store.create(completedInput);
        const running = await store.create(runningInput);
        const queued = await store.create(queuedInput);

        const firstLease = await store.claimNext({ executorId: 'resident-a' });
        await store.appendProgress(completed.command.id, firstLease.lease, 'token', { text: 'done' });
        await store.complete(completed.command.id, firstLease.lease, { text: 'done' });

        const secondLease = await store.claimNext({ executorId: 'resident-b' });
        assert.equal(secondLease.command.id, running.command.id);
        await store.appendProgress(running.command.id, secondLease.lease, 'token', { text: 'partial' });

        clock.advance(25);
        let nextGeneratedId = 100;
        const reopened = new RuntimeGenerationStore({
            rootDir,
            now: clock.now,
            idFactory: () => `command-${++nextGeneratedId}`,
            defaultLeaseDurationMs: 1_000,
            maxLeaseDurationMs: 60_000,
        });
        const summary = await reopened.open();
        assert.deepEqual(summary, {
            commands: 3,
            recoveredInterrupted: 1,
            lastFencingToken: 2,
        });

        const retained = await reopened.get(completed.command.id);
        assert.equal(retained.state, 'completed');
        assert.deepEqual(retained.result, { text: 'done' });
        assert.deepEqual(
            (await reopened.replay(completed.command.id)).events.map((event) => event.type),
            ['created', 'running', 'token', 'completed'],
        );

        const interrupted = await reopened.get(running.command.id);
        assert.equal(interrupted.state, 'interrupted');
        assert.deepEqual(
            (await reopened.replay(running.command.id)).events.map((event) => event.type),
            ['created', 'running', 'token', 'interrupted'],
        );
        assert.equal(
            (await reopened.replay(running.command.id)).events.at(-1).payload.reason,
            'server_restart',
        );

        const thirdLease = await reopened.claimNext({ executorId: 'resident-c' });
        assert.equal(thirdLease.command.id, queued.command.id);
        assert.equal(thirdLease.lease.fencingToken, 3);
        await reopened.fail(queued.command.id, thirdLease.lease, new Error('provider failed'), {
            provider: 'test',
            databaseRevision: 12,
            canonicalMutationPersisted: true,
        });
        assert.equal((await reopened.get(queued.command.id)).error, 'provider failed');

        const reopenedAgain = new RuntimeGenerationStore({
            rootDir,
            now: clock.now,
            defaultLeaseDurationMs: 1_000,
        });
        const secondSummary = await reopenedAgain.open();
        assert.deepEqual(secondSummary, {
            commands: 3,
            recoveredInterrupted: 0,
            lastFencingToken: 3,
        });
        assert.equal((await reopenedAgain.get(running.command.id)).lastSequence, 4);
        assert.deepEqual((await reopenedAgain.get(queued.command.id)).result, {
            provider: 'test',
            databaseRevision: 12,
            canonicalMutationPersisted: true,
        });
        assert.equal(await reopenedAgain.claimNext({ executorId: 'nobody' }), null);
    });

    test('repairs an incomplete trailing JSONL append on reopen', async () => {
        const { rootDir, store } = await makeFixture();
        const { command } = await store.create(commandInput('repair'));
        const eventsPath = path.join(rootDir, command.id, 'events.ndjson');
        await fs.appendFile(eventsPath, '{"sequence":2,"type":"progress"');

        const reopened = new RuntimeGenerationStore({ rootDir });
        const summary = await reopened.open();
        assert.equal(summary.commands, 1);
        assert.deepEqual(
            (await reopened.replay(command.id)).events.map((event) => event.sequence),
            [1],
        );
        const repaired = await fs.readFile(eventsPath, 'utf8');
        assert.equal(repaired.endsWith('\n'), true);
        assert.equal(repaired.includes('"sequence":2'), false);
    });
});
