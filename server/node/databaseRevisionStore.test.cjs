'use strict';

const assert = require('node:assert/strict');
const { afterEach, describe, test } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const {
    DatabaseRevisionStore,
    makeDatabaseEtag,
    sha256DatabaseBlob,
} = require('./databaseRevisionStore.cjs');

const temporaryDirectories = new Set();

afterEach(async () => {
    await Promise.all(
        [...temporaryDirectories].map((directoryPath) =>
            fs.rm(directoryPath, { recursive: true, force: true })
        )
    );
    temporaryDirectories.clear();
});

async function makeFixture(options = {}) {
    const directoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'risu-db-revision-'));
    temporaryDirectories.add(directoryPath);
    const databasePath = path.join(directoryPath, 'database.bin');
    const stateDir = path.join(directoryPath, 'sync-state');
    const store = new DatabaseRevisionStore({
        databasePath,
        stateDir,
        ...options,
    });
    return { directoryPath, databasePath, stateDir, store };
}

function commitOptions(data, baseRevision, idempotencyKey, extra = {}) {
    return {
        data,
        baseRevision,
        idempotencyKey,
        clientId: 'test-client',
        kind: 'stable',
        ...extra,
    };
}

describe('DatabaseRevisionStore', () => {
    test('initializes and reopens an arbitrary opaque blob with stable hash metadata', async () => {
        const fixture = await makeFixture();
        const opaqueBlob = Buffer.from([0, 255, 4, 9, 0, 88, 17, 222]);

        const opened = await fixture.store.open(opaqueBlob);
        const expectedHash = sha256DatabaseBlob(opaqueBlob);
        assert.deepEqual(opened, {
            revision: 0,
            sha256: expectedHash,
            etag: makeDatabaseEtag(0, expectedHash),
            updatedAt: opened.updatedAt,
        });

        const firstRead = await fixture.store.read();
        assert.deepEqual(firstRead.data, opaqueBlob);
        firstRead.data[0] = 123;
        assert.deepEqual((await fixture.store.read()).data, opaqueBlob, 'read returns a defensive copy');

        const reopened = new DatabaseRevisionStore({
            databasePath: fixture.databasePath,
            stateDir: fixture.stateDir,
        });
        const reopenedHead = await reopened.open();
        assert.equal(reopenedHead.revision, 0);
        assert.equal(reopenedHead.sha256, expectedHash);
        assert.deepEqual((await reopened.read()).data, opaqueBlob);
    });

    test('requires initial bytes when no canonical blob exists', async () => {
        const fixture = await makeFixture();
        await assert.rejects(
            fixture.store.open(),
            (error) => error && error.code === 'ENOENT'
        );
    });

    test('serializes concurrent CAS commits so exactly one writer wins a revision', async () => {
        const fixture = await makeFixture({ maxConflicts: 32 });
        await fixture.store.open(Buffer.from('base'));

        const attempts = Array.from({ length: 20 }, (_, index) => {
            const data = Buffer.from(`writer-${index}`);
            return fixture.store.commit(commitOptions(data, 0, `key-${index}`));
        });
        const results = await Promise.all(attempts);
        const accepted = results.filter((result) => result.ok);
        const rejected = results.filter((result) => !result.ok);

        assert.equal(accepted.length, 1);
        assert.equal(rejected.length, 19);
        assert.ok(rejected.every((result) => result.reason === 'stale_base'));
        assert.equal((await fixture.store.getHead()).revision, 1);

        const winningIndex = results.findIndex((result) => result.ok);
        assert.deepEqual(
            (await fixture.store.read()).data,
            Buffer.from(`writer-${winningIndex}`)
        );
        assert.equal((await fixture.store.listConflicts()).length, 19);
    });

    test('returns the original result for the same idempotency key and identical bytes', async () => {
        const fixture = await makeFixture();
        await fixture.store.open(Buffer.from('base'));
        const events = [];
        fixture.store.subscribe((event) => events.push(event));

        const first = await fixture.store.commit(
            commitOptions(Buffer.from('committed'), 0, 'request-1')
        );
        const duplicate = await fixture.store.commit(
            commitOptions(Buffer.from('committed'), 0, 'request-1')
        );

        assert.equal(first.ok, true);
        assert.equal(first.duplicate, false);
        assert.deepEqual(duplicate, {
            ok: true,
            duplicate: true,
            revision: first.revision,
            sha256: first.sha256,
            etag: first.etag,
            currentRevision: first.revision,
            currentSha256: first.sha256,
            currentEtag: first.etag,
        });
        assert.equal((await fixture.store.getHead()).revision, 1);
        assert.equal(events.length, 1, 'an idempotent replay does not emit another commit');

        const reopened = new DatabaseRevisionStore({
            databasePath: fixture.databasePath,
            stateDir: fixture.stateDir,
        });
        await reopened.open();
        const duplicateAfterReopen = await reopened.commit(
            commitOptions(Buffer.from('committed'), 0, 'request-1')
        );
        assert.equal(duplicateAfterReopen.ok, true);
        assert.equal(duplicateAfterReopen.duplicate, true);
        assert.equal(duplicateAfterReopen.revision, 1);
    });

    test('rejects reuse of an idempotency key for different bytes and preserves them', async () => {
        const fixture = await makeFixture();
        await fixture.store.open(Buffer.from('base'));
        await fixture.store.commit(commitOptions(Buffer.from('first'), 0, 'request-1'));
        const different = Buffer.from([9, 8, 7, 0, 6]);

        const result = await fixture.store.commit(
            commitOptions(different, 1, 'request-1')
        );

        assert.equal(result.ok, false);
        assert.equal(result.reason, 'idempotency_key_reused');
        assert.equal((await fixture.store.getHead()).revision, 1);
        assert.deepEqual((await fixture.store.read()).data, Buffer.from('first'));
        const conflict = await fixture.store.readConflict(result.conflictId);
        assert.equal(conflict.reason, 'idempotency_key_reused');
        assert.equal(conflict.incomingSha256, sha256DatabaseBlob(different));
        assert.deepEqual(conflict.data, different);
    });

    test('rejects a stale base without changing head and preserves exact incoming bytes', async () => {
        const fixture = await makeFixture();
        await fixture.store.open(Buffer.from('base'));
        const committed = Buffer.from('new-head');
        await fixture.store.commit(commitOptions(committed, 0, 'winner'));
        const staleBytes = Buffer.from([0, 1, 0, 2, 255, 3, 0]);

        const stale = await fixture.store.commit(
            commitOptions(staleBytes, 0, 'stale-writer', { baseEtag: undefined })
        );

        assert.equal(stale.ok, false);
        assert.equal(stale.reason, 'stale_base');
        assert.equal(stale.revision, 1);
        assert.deepEqual((await fixture.store.read()).data, committed);
        assert.deepEqual((await fixture.store.readConflict(stale.conflictId)).data, staleBytes);
    });

    test('accepts an exact ETag base and rejects a mismatched ETag', async () => {
        const fixture = await makeFixture();
        const initial = await fixture.store.open(Buffer.from('base'));

        const accepted = await fixture.store.commit({
            data: Buffer.from('etag-commit'),
            baseEtag: initial.etag,
            idempotencyKey: 'etag-1',
        });
        assert.equal(accepted.ok, true);

        const rejected = await fixture.store.commit({
            data: Buffer.from('stale-etag'),
            baseEtag: initial.etag,
            idempotencyKey: 'etag-2',
        });
        assert.equal(rejected.ok, false);
        assert.equal(rejected.reason, 'stale_base');
    });

    test('persists commits by temp-file fsync and rename without leftover temp files', async () => {
        const fixture = await makeFixture();
        await fixture.store.open(Buffer.from('base'));
        const value = Buffer.alloc(64 * 1024, 0xa5);

        const result = await fixture.store.commit(commitOptions(value, 0, 'atomic-1'));
        assert.equal(result.ok, true);
        assert.deepEqual(await fs.readFile(fixture.databasePath), value);

        const databaseDirectoryNames = await fs.readdir(path.dirname(fixture.databasePath));
        const stateDirectoryNames = await fs.readdir(fixture.stateDir);
        assert.equal(
            databaseDirectoryNames.some((name) => name.includes('.tmp-')),
            false
        );
        assert.equal(stateDirectoryNames.some((name) => name.includes('.tmp-')), false);
        assert.equal(stateDirectoryNames.includes('pending.json'), false);
    });

    test('recovers a canonical blob changed after persisted metadata without reusing revision', async () => {
        const fixture = await makeFixture();
        await fixture.store.open(Buffer.from('base'));
        await fixture.store.commit(commitOptions(Buffer.from('revision-one'), 0, 'first'));

        const externallyPromoted = Buffer.from('promoted-before-head-metadata');
        const tempPath = path.join(fixture.directoryPath, '.external-temp');
        await fs.writeFile(tempPath, externallyPromoted);
        await fs.rename(tempPath, fixture.databasePath);

        const reopened = new DatabaseRevisionStore({
            databasePath: fixture.databasePath,
            stateDir: fixture.stateDir,
        });
        const recovered = await reopened.open();
        assert.equal(recovered.revision, 2);
        assert.equal(recovered.sha256, sha256DatabaseBlob(externallyPromoted));
        assert.deepEqual((await reopened.read()).data, externallyPromoted);

        const reopenedAgain = new DatabaseRevisionStore({
            databasePath: fixture.databasePath,
            stateDir: fixture.stateDir,
        });
        assert.equal((await reopenedAgain.open()).revision, 2);
    });

    test('detects an external canonical replacement before CAS and never overwrites it', async () => {
        const fixture = await makeFixture();
        await fixture.store.open(Buffer.from('base'));
        const externallyWritten = Buffer.from('legacy-route-write');
        await fs.writeFile(fixture.databasePath, externallyWritten);

        const attempted = await fixture.store.commit(
            commitOptions(Buffer.from('would-overwrite'), 0, 'stale-after-external-write')
        );

        assert.equal(attempted.ok, false);
        assert.equal(attempted.reason, 'stale_base');
        assert.equal(attempted.revision, 1);
        assert.deepEqual((await fixture.store.read()).data, externallyWritten);
        assert.deepEqual(
            (await fixture.store.readConflict(attempted.conflictId)).data,
            Buffer.from('would-overwrite')
        );
    });

    test('captures caller-owned buffers before queued commits can observe mutation', async () => {
        const fixture = await makeFixture({ maxConflicts: 4 });
        await fixture.store.open(Buffer.from('base'));
        const firstInput = Buffer.from('first-writer');
        const queuedInput = new Uint8Array(Buffer.from('queued-original'));

        const firstPromise = fixture.store.commit(commitOptions(firstInput, 0, 'capture-first'));
        const queuedPromise = fixture.store.commit(
            commitOptions(queuedInput, 0, 'capture-queued')
        );
        queuedInput.fill('x'.charCodeAt(0));

        assert.equal((await firstPromise).ok, true);
        const queued = await queuedPromise;
        assert.equal(queued.ok, false);
        assert.deepEqual(
            (await fixture.store.readConflict(queued.conflictId)).data,
            Buffer.from('queued-original')
        );
    });

    test('finalizes a promoted pending transaction during reopen recovery', async () => {
        const fixture = await makeFixture();
        const initial = await fixture.store.open(Buffer.from('base'));
        const promoted = Buffer.from('promoted-transaction');
        const promotedHash = sha256DatabaseBlob(promoted);
        const transactionTempName = '.database.bin.tmp-simulated-crash';

        await fs.writeFile(fixture.databasePath, promoted);
        await fs.writeFile(
            fixture.store.paths.pending,
            `${JSON.stringify({
                formatVersion: 1,
                revision: initial.revision + 1,
                sha256: promotedHash,
                committedAt: 123456,
                idempotencyKey: 'crash-request',
                clientId: 'crashed-client',
                kind: 'stable',
                tempFile: transactionTempName,
            })}\n`
        );

        const reopened = new DatabaseRevisionStore({
            databasePath: fixture.databasePath,
            stateDir: fixture.stateDir,
        });
        const recovered = await reopened.open();
        assert.equal(recovered.revision, 1);
        assert.equal(recovered.sha256, promotedHash);
        assert.equal(await fs.stat(reopened.paths.pending).then(() => true, () => false), false);

        const duplicate = await reopened.commit(
            commitOptions(promoted, 0, 'crash-request')
        );
        assert.equal(duplicate.ok, true);
        assert.equal(duplicate.duplicate, true);
        assert.equal(duplicate.revision, 1);
    });

    test('notifies subscribers once per accepted commit and isolates listener failures', async () => {
        const fixture = await makeFixture();
        await fixture.store.open(Buffer.from('base'));
        const events = [];
        const unsubscribe = fixture.store.subscribe((event) => events.push(event));
        const unsubscribeFailing = fixture.store.subscribe(() => {
            throw new Error('listener failure');
        });

        const originalConsoleError = console.error;
        let first;
        try {
            console.error = () => {};
            first = await fixture.store.commit(
                commitOptions(Buffer.from('one'), 0, 'event-1', {
                    clientId: 'phone',
                    kind: 'streaming',
                })
            );
        }
        finally {
            console.error = originalConsoleError;
            unsubscribeFailing();
        }
        assert.equal(first.ok, true, 'a listener error does not fail the commit');
        assert.equal(events.length, 1);
        assert.deepEqual(events[0], {
            type: 'committed',
            revision: 1,
            sha256: first.sha256,
            etag: first.etag,
            clientId: 'phone',
            kind: 'streaming',
            idempotencyKey: 'event-1',
            committedAt: events[0].committedAt,
        });

        unsubscribe();
        await fixture.store.commit(commitOptions(Buffer.from('two'), 1, 'event-2'));
        assert.equal(events.length, 1);
    });

    test('retains only the newest configured number of conflict blob/metadata pairs', async () => {
        let clock = 1000;
        const fixture = await makeFixture({
            maxConflicts: 2,
            now: () => ++clock,
        });
        await fixture.store.open(Buffer.from('base'));
        await fixture.store.commit(commitOptions(Buffer.from('head'), 0, 'winner'));

        const first = await fixture.store.commit(
            commitOptions(Buffer.from('conflict-one'), 0, 'conflict-1')
        );
        const second = await fixture.store.commit(
            commitOptions(Buffer.from('conflict-two'), 0, 'conflict-2')
        );
        const third = await fixture.store.commit(
            commitOptions(Buffer.from('conflict-three'), 0, 'conflict-3')
        );

        const conflicts = await fixture.store.listConflicts();
        assert.deepEqual(
            conflicts.map((conflict) => conflict.conflictId),
            [third.conflictId, second.conflictId]
        );
        assert.equal(await fixture.store.readConflict(first.conflictId), null);
        assert.deepEqual(
            (await fixture.store.readConflict(second.conflictId)).data,
            Buffer.from('conflict-two')
        );
        assert.deepEqual(
            (await fixture.store.readConflict(third.conflictId)).data,
            Buffer.from('conflict-three')
        );

        const retainedFiles = (await fs.readdir(fixture.store.paths.conflicts)).sort();
        assert.equal(retainedFiles.length, 4);
        assert.ok(retainedFiles.every((name) =>
            name.startsWith(second.conflictId) || name.startsWith(third.conflictId)
        ));
    });
});
