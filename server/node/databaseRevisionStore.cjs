'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs/promises');

const METADATA_FORMAT_VERSION = 1;

function toBuffer(value, label = 'data') {
    if (Buffer.isBuffer(value)) {
        return Buffer.from(value);
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value);
    }
    if (value instanceof ArrayBuffer) {
        return Buffer.from(new Uint8Array(value));
    }
    throw new TypeError(`${label} must be a Buffer, Uint8Array, or ArrayBuffer`);
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function makeEtag(revision, digest) {
    return `"risu-${revision}-${digest}"`;
}

function isNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function normalizePositiveInteger(value, fallback, label) {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${label} must be a positive integer`);
    }
    return value;
}

async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch (error) {
        if (error && error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function syncDirectory(directoryPath) {
    let handle;
    try {
        handle = await fs.open(directoryPath, 'r');
        await handle.sync();
    }
    catch (error) {
        // Directory fsync is unsupported on a few platforms. File fsync and
        // rename still provide the strongest primitive available there.
        if (!error || !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) {
            throw error;
        }
    }
    finally {
        await handle?.close().catch(() => {});
    }
}

async function writePreparedTemp(targetPath, data, randomUUID) {
    const directoryPath = path.dirname(targetPath);
    await fs.mkdir(directoryPath, { recursive: true });
    const tempPath = path.join(
        directoryPath,
        `.${path.basename(targetPath)}.tmp-${process.pid}-${randomUUID()}`
    );
    let handle;
    try {
        handle = await fs.open(tempPath, 'wx', 0o600);
        await handle.writeFile(data);
        await handle.sync();
        await handle.close();
        handle = undefined;
        return tempPath;
    }
    catch (error) {
        await handle?.close().catch(() => {});
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }
}

async function promotePreparedTemp(tempPath, targetPath) {
    await fs.rename(tempPath, targetPath);
    await syncDirectory(path.dirname(targetPath));
}

async function atomicWriteFile(targetPath, data, randomUUID) {
    const tempPath = await writePreparedTemp(targetPath, data, randomUUID);
    try {
        await promotePreparedTemp(tempPath, targetPath);
    }
    catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }
}

async function readJsonFile(targetPath) {
    try {
        return JSON.parse(await fs.readFile(targetPath, 'utf8'));
    }
    catch (error) {
        if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) {
            return null;
        }
        throw error;
    }
}

function normalizeIdempotencyRecords(records) {
    if (!Array.isArray(records)) {
        return [];
    }
    const normalized = [];
    for (const record of records) {
        if (
            !record || typeof record !== 'object'
            || typeof record.key !== 'string' || record.key.length === 0
            || !isSha256(record.sha256)
            || !isNonNegativeInteger(record.revision)
        ) {
            continue;
        }
        normalized.push({
            key: record.key,
            sha256: record.sha256,
            revision: record.revision,
            etag: typeof record.etag === 'string'
                ? record.etag
                : makeEtag(record.revision, record.sha256),
            committedAt: Number.isFinite(record.committedAt) ? record.committedAt : 0,
        });
    }
    return normalized;
}

function normalizeMetadata(value) {
    if (
        !value || typeof value !== 'object'
        || value.formatVersion !== METADATA_FORMAT_VERSION
        || !isNonNegativeInteger(value.revision)
        || !isSha256(value.sha256)
    ) {
        return null;
    }
    return {
        formatVersion: METADATA_FORMAT_VERSION,
        revision: value.revision,
        sha256: value.sha256,
        etag: makeEtag(value.revision, value.sha256),
        updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
        idempotency: normalizeIdempotencyRecords(value.idempotency),
    };
}

function normalizePending(value) {
    if (
        !value || typeof value !== 'object'
        || value.formatVersion !== METADATA_FORMAT_VERSION
        || !isNonNegativeInteger(value.revision)
        || !isSha256(value.sha256)
        || typeof value.tempFile !== 'string'
        || path.basename(value.tempFile) !== value.tempFile
    ) {
        return null;
    }
    return {
        formatVersion: METADATA_FORMAT_VERSION,
        revision: value.revision,
        sha256: value.sha256,
        etag: makeEtag(value.revision, value.sha256),
        committedAt: Number.isFinite(value.committedAt) ? value.committedAt : 0,
        idempotencyKey: typeof value.idempotencyKey === 'string' ? value.idempotencyKey : '',
        clientId: typeof value.clientId === 'string' ? value.clientId : '',
        kind: typeof value.kind === 'string' ? value.kind : 'stable',
        tempFile: value.tempFile,
    };
}

class DatabaseRevisionStore {
    constructor(options = {}) {
        if (!options.databasePath || typeof options.databasePath !== 'string') {
            throw new TypeError('databasePath is required');
        }

        this.databasePath = path.resolve(options.databasePath);
        this.stateDir = path.resolve(
            options.stateDir
                || path.join(path.dirname(this.databasePath), '.database-revision')
        );
        this.metadataPath = path.join(this.stateDir, 'head.json');
        this.pendingPath = path.join(this.stateDir, 'pending.json');
        this.conflictDir = path.join(this.stateDir, 'conflicts');
        this.maxConflicts = normalizePositiveInteger(options.maxConflicts, 20, 'maxConflicts');
        this.maxIdempotencyKeys = normalizePositiveInteger(
            options.maxIdempotencyKeys,
            256,
            'maxIdempotencyKeys'
        );
        this.maxBlobBytes = normalizePositiveInteger(
            options.maxBlobBytes,
            100 * 1024 * 1024,
            'maxBlobBytes'
        );
        this.now = typeof options.now === 'function' ? options.now : Date.now;
        this.randomUUID = typeof options.randomUUID === 'function'
            ? options.randomUUID
            : crypto.randomUUID;

        this._opened = false;
        this._head = null;
        this._subscribers = new Set();
        this._queue = Promise.resolve();
    }

    get paths() {
        return Object.freeze({
            database: this.databasePath,
            stateDir: this.stateDir,
            metadata: this.metadataPath,
            pending: this.pendingPath,
            conflicts: this.conflictDir,
        });
    }

    async open(initialData) {
        const capturedInitialData = initialData === undefined
            ? undefined
            : this._normalizeBlob(initialData);
        return await this._enqueue(async () => {
            if (this._opened) {
                return this._publicHead();
            }

            await fs.mkdir(path.dirname(this.databasePath), { recursive: true });
            await fs.mkdir(this.conflictDir, { recursive: true });

            if (!await pathExists(this.databasePath)) {
                if (capturedInitialData === undefined) {
                    const error = new Error(`Database blob does not exist: ${this.databasePath}`);
                    error.code = 'ENOENT';
                    throw error;
                }
                await atomicWriteFile(this.databasePath, capturedInitialData, this.randomUUID);
            }

            await this._recoverLocked();
            await this._pruneConflictsLocked();
            this._opened = true;
            return this._publicHead();
        });
    }

    async read() {
        return await this._enqueue(async () => {
            this._assertOpened();
            const data = await fs.readFile(this.databasePath);
            const digest = sha256(data);
            if (digest !== this._head.sha256) {
                await this._recoverLocked();
                this._opened = true;
                return {
                    ...this._publicHead(),
                    data: Buffer.from(await fs.readFile(this.databasePath)),
                };
            }
            return {
                ...this._publicHead(),
                data: Buffer.from(data),
            };
        });
    }

    async getHead() {
        return await this._enqueue(async () => {
            this._assertOpened();
            return this._publicHead();
        });
    }

    async commit(options = {}) {
        const request = {
            ...options,
            data: this._normalizeBlob(options.data),
        };
        return await this._enqueue(async () => {
            this._assertOpened();
            await this._recoverIfCanonicalChangedLocked();
            const data = request.data;
            const incomingSha256 = sha256(data);
            const idempotencyKey = this._normalizeIdempotencyKey(request.idempotencyKey);
            const existingRecord = this._head.idempotency.find(
                (record) => record.key === idempotencyKey
            );

            if (existingRecord) {
                if (existingRecord.sha256 === incomingSha256) {
                    return {
                        ok: true,
                        duplicate: true,
                        revision: existingRecord.revision,
                        sha256: existingRecord.sha256,
                        etag: existingRecord.etag,
                        currentRevision: this._head.revision,
                        currentSha256: this._head.sha256,
                        currentEtag: this._head.etag,
                    };
                }
                return await this._preserveConflictLocked({
                    reason: 'idempotency_key_reused',
                    data,
                    incomingSha256,
                    options: request,
                    idempotencyKey,
                });
            }

            const baseMatches = this._baseMatches(request);
            if (!baseMatches) {
                return await this._preserveConflictLocked({
                    reason: 'stale_base',
                    data,
                    incomingSha256,
                    options: request,
                    idempotencyKey,
                });
            }

            const committedAt = this.now();
            const revision = this._head.revision + 1;
            const etag = makeEtag(revision, incomingSha256);
            const tempPath = await writePreparedTemp(
                this.databasePath,
                data,
                this.randomUUID
            );
            const pending = {
                formatVersion: METADATA_FORMAT_VERSION,
                revision,
                sha256: incomingSha256,
                etag,
                committedAt,
                idempotencyKey,
                clientId: typeof request.clientId === 'string' ? request.clientId : '',
                kind: typeof request.kind === 'string' ? request.kind : 'stable',
                tempFile: path.basename(tempPath),
            };
            let promoted = false;

            try {
                await this._writeJsonAtomic(this.pendingPath, pending);
                await promotePreparedTemp(tempPath, this.databasePath);
                promoted = true;

                const nextIdempotency = [
                    ...this._head.idempotency.filter((record) => record.key !== idempotencyKey),
                    {
                        key: idempotencyKey,
                        sha256: incomingSha256,
                        revision,
                        etag,
                        committedAt,
                    },
                ].slice(-this.maxIdempotencyKeys);
                const nextHead = {
                    formatVersion: METADATA_FORMAT_VERSION,
                    revision,
                    sha256: incomingSha256,
                    etag,
                    updatedAt: committedAt,
                    idempotency: nextIdempotency,
                };

                await this._persistHeadLocked(nextHead);
                await fs.rm(this.pendingPath, { force: true });
                await syncDirectory(this.stateDir);
                this._head = nextHead;

                const event = Object.freeze({
                    type: 'committed',
                    revision,
                    sha256: incomingSha256,
                    etag,
                    clientId: pending.clientId,
                    kind: pending.kind,
                    idempotencyKey,
                    committedAt,
                });
                this._emit(event);

                return {
                    ok: true,
                    duplicate: false,
                    revision,
                    sha256: incomingSha256,
                    etag,
                };
            }
            catch (error) {
                if (!promoted) {
                    await fs.rm(tempPath, { force: true }).catch(() => {});
                    await fs.rm(this.pendingPath, { force: true }).catch(() => {});
                }
                else {
                    try {
                        await this._recoverLocked();
                        this._opened = true;
                    }
                    catch (recoveryError) {
                        this._opened = false;
                        error.recoveryError = recoveryError;
                    }
                }
                throw error;
            }
        });
    }

    subscribe(listener) {
        if (typeof listener !== 'function') {
            throw new TypeError('listener must be a function');
        }
        this._subscribers.add(listener);
        return () => this._subscribers.delete(listener);
    }

    async listConflicts() {
        return await this._enqueue(async () => {
            this._assertOpened();
            return await this._listConflictsLocked();
        });
    }

    async readConflict(conflictId) {
        return await this._enqueue(async () => {
            this._assertOpened();
            this._assertConflictId(conflictId);
            const metadata = await readJsonFile(
                path.join(this.conflictDir, `${conflictId}.json`)
            );
            if (!metadata) {
                return null;
            }
            const data = await fs.readFile(path.join(this.conflictDir, `${conflictId}.bin`));
            return {
                ...metadata,
                data: Buffer.from(data),
            };
        });
    }

    _enqueue(operation) {
        const result = this._queue.then(operation, operation);
        this._queue = result.catch(() => {});
        return result;
    }

    _assertOpened() {
        if (!this._opened || !this._head) {
            throw new Error('DatabaseRevisionStore is not open');
        }
    }

    _normalizeBlob(data) {
        const result = toBuffer(data);
        if (result.byteLength > this.maxBlobBytes) {
            const error = new Error(`Database blob exceeds ${this.maxBlobBytes} bytes`);
            error.code = 'EFBIG';
            throw error;
        }
        return result;
    }

    _normalizeIdempotencyKey(value) {
        if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
            throw new TypeError('idempotencyKey must be a non-empty string of at most 256 characters');
        }
        return value;
    }

    _baseMatches(options) {
        const hasRevision = options.baseRevision !== undefined;
        const hasEtag = options.baseEtag !== undefined;
        if (!hasRevision && !hasEtag) {
            throw new TypeError('baseRevision or baseEtag is required');
        }
        if (hasRevision && !isNonNegativeInteger(options.baseRevision)) {
            throw new TypeError('baseRevision must be a non-negative safe integer');
        }
        if (hasEtag && typeof options.baseEtag !== 'string') {
            throw new TypeError('baseEtag must be a string');
        }
        return (!hasRevision || options.baseRevision === this._head.revision)
            && (!hasEtag || options.baseEtag === this._head.etag);
    }

    _publicHead() {
        return Object.freeze({
            revision: this._head.revision,
            sha256: this._head.sha256,
            etag: this._head.etag,
            updatedAt: this._head.updatedAt,
        });
    }

    async _recoverIfCanonicalChangedLocked() {
        const canonicalSha256 = sha256(await fs.readFile(this.databasePath));
        if (canonicalSha256 !== this._head.sha256 || await pathExists(this.pendingPath)) {
            await this._recoverLocked();
        }
    }

    async _recoverLocked() {
        const data = await fs.readFile(this.databasePath);
        const databaseSha256 = sha256(data);
        let metadata = normalizeMetadata(await readJsonFile(this.metadataPath));
        const pendingRaw = await readJsonFile(this.pendingPath);
        const pending = normalizePending(pendingRaw);

        if (pending) {
            const pendingTempPath = path.join(path.dirname(this.databasePath), pending.tempFile);
            if (databaseSha256 === pending.sha256) {
                const priorRecords = metadata?.idempotency ?? [];
                const recoveredRecord = pending.idempotencyKey
                    ? [{
                        key: pending.idempotencyKey,
                        sha256: pending.sha256,
                        revision: pending.revision,
                        etag: pending.etag,
                        committedAt: pending.committedAt,
                    }]
                    : [];
                metadata = {
                    formatVersion: METADATA_FORMAT_VERSION,
                    revision: Math.max(metadata?.revision ?? 0, pending.revision),
                    sha256: databaseSha256,
                    etag: makeEtag(
                        Math.max(metadata?.revision ?? 0, pending.revision),
                        databaseSha256
                    ),
                    updatedAt: pending.committedAt || this.now(),
                    idempotency: [
                        ...priorRecords.filter(
                            (record) => record.key !== pending.idempotencyKey
                        ),
                        ...recoveredRecord,
                    ].slice(-this.maxIdempotencyKeys),
                };
                await this._persistHeadLocked(metadata);
            }
            await fs.rm(pendingTempPath, { force: true }).catch(() => {});
            await fs.rm(this.pendingPath, { force: true });
            await syncDirectory(this.stateDir);
        }
        else if (pendingRaw) {
            // Invalid transaction markers must not permanently block startup.
            await fs.rm(this.pendingPath, { force: true });
            await syncDirectory(this.stateDir);
        }

        if (!metadata) {
            metadata = {
                formatVersion: METADATA_FORMAT_VERSION,
                revision: 0,
                sha256: databaseSha256,
                etag: makeEtag(0, databaseSha256),
                updatedAt: this.now(),
                idempotency: [],
            };
            await this._persistHeadLocked(metadata);
        }
        else if (metadata.sha256 !== databaseSha256) {
            // The canonical rename may have completed before metadata was
            // persisted, or an administrator may have replaced the blob. Never
            // reuse the old revision for different bytes.
            const revision = metadata.revision + 1;
            metadata = {
                ...metadata,
                revision,
                sha256: databaseSha256,
                etag: makeEtag(revision, databaseSha256),
                updatedAt: this.now(),
            };
            await this._persistHeadLocked(metadata);
        }

        this._head = metadata;
    }

    async _persistHeadLocked(head) {
        await this._writeJsonAtomic(this.metadataPath, {
            formatVersion: METADATA_FORMAT_VERSION,
            revision: head.revision,
            sha256: head.sha256,
            etag: makeEtag(head.revision, head.sha256),
            updatedAt: head.updatedAt,
            idempotency: head.idempotency.slice(-this.maxIdempotencyKeys),
        });
    }

    async _writeJsonAtomic(targetPath, value) {
        await atomicWriteFile(
            targetPath,
            Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'),
            this.randomUUID
        );
    }

    async _preserveConflictLocked({
        reason,
        data,
        incomingSha256,
        options,
        idempotencyKey,
    }) {
        const createdAt = this.now();
        const conflictId = `${String(createdAt).padStart(16, '0')}-${this.randomUUID()}`;
        const blobPath = path.join(this.conflictDir, `${conflictId}.bin`);
        const metadataPath = path.join(this.conflictDir, `${conflictId}.json`);
        const metadata = {
            formatVersion: METADATA_FORMAT_VERSION,
            conflictId,
            reason,
            createdAt,
            incomingSha256,
            incomingBytes: data.byteLength,
            baseRevision: isNonNegativeInteger(options.baseRevision)
                ? options.baseRevision
                : null,
            baseEtag: typeof options.baseEtag === 'string' ? options.baseEtag : null,
            currentRevision: this._head.revision,
            currentSha256: this._head.sha256,
            currentEtag: this._head.etag,
            idempotencyKey,
            clientId: typeof options.clientId === 'string' ? options.clientId : '',
            kind: typeof options.kind === 'string' ? options.kind : 'stable',
        };

        await atomicWriteFile(blobPath, data, this.randomUUID);
        try {
            await this._writeJsonAtomic(metadataPath, metadata);
        }
        catch (error) {
            await fs.rm(blobPath, { force: true }).catch(() => {});
            throw error;
        }
        await this._pruneConflictsLocked();

        return {
            ok: false,
            conflict: true,
            reason,
            conflictId,
            revision: this._head.revision,
            sha256: this._head.sha256,
            etag: this._head.etag,
        };
    }

    async _listConflictsLocked() {
        let names;
        try {
            names = await fs.readdir(this.conflictDir);
        }
        catch (error) {
            if (error && error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }

        const entries = [];
        for (const name of names) {
            if (!name.endsWith('.json')) {
                continue;
            }
            const conflictId = name.slice(0, -'.json'.length);
            try {
                this._assertConflictId(conflictId);
            }
            catch {
                continue;
            }
            const metadata = await readJsonFile(path.join(this.conflictDir, name));
            if (metadata && metadata.conflictId === conflictId) {
                entries.push(metadata);
            }
        }
        entries.sort((left, right) => {
            const timeDifference = (right.createdAt || 0) - (left.createdAt || 0);
            return timeDifference || right.conflictId.localeCompare(left.conflictId);
        });
        return entries;
    }

    async _pruneConflictsLocked() {
        const conflicts = await this._listConflictsLocked();
        const expired = conflicts.slice(this.maxConflicts);
        for (const conflict of expired) {
            await Promise.all([
                fs.rm(path.join(this.conflictDir, `${conflict.conflictId}.json`), { force: true }),
                fs.rm(path.join(this.conflictDir, `${conflict.conflictId}.bin`), { force: true }),
            ]);
        }
        if (expired.length > 0) {
            await syncDirectory(this.conflictDir);
        }
    }

    _assertConflictId(conflictId) {
        if (
            typeof conflictId !== 'string'
            || conflictId.length === 0
            || conflictId.length > 256
            || !/^[a-zA-Z0-9-]+$/.test(conflictId)
        ) {
            throw new TypeError('Invalid conflictId');
        }
    }

    _emit(event) {
        for (const listener of this._subscribers) {
            try {
                listener(event);
            }
            catch (error) {
                // A notification consumer must not make a committed snapshot
                // appear failed to its writer.
                console.error('[DatabaseRevisionStore] subscriber failed:', error);
            }
        }
    }
}

module.exports = {
    DatabaseRevisionStore,
    makeDatabaseEtag: makeEtag,
    sha256DatabaseBlob: sha256,
};
