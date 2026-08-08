const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const JOB_SCHEMA_VERSION = 1;
const JOB_DIRECTORY_MODE = 0o700;
const JOB_FILE_MODE = 0o600;
const DEFAULT_REPLAY_LIMIT = 1_000;
const MAX_REPLAY_LIMIT = 10_000;
const DEFAULT_MAX_SPOOL_BYTES = Number.MAX_SAFE_INTEGER;
const DEFAULT_RUNNING_TERMINAL_RESERVE_BYTES = 4 * 1024;
const DEFAULT_QUEUED_TERMINAL_RESERVE_BYTES = 8 * 1024;
const MAX_REPLAY_PAGE_BYTES = 8 * 1024 * 1024;
const EVENT_SCAN_BUFFER_BYTES = 64 * 1024;
const PURGE_TOMBSTONE_PATTERN = /^\.purge\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.[a-f0-9]{32}$/;
const METADATA_TEMPORARY_FILE_PATTERN = /^\.meta\.\d+\.[a-f0-9]{16}\.tmp$/;

const JOB_STATES = Object.freeze([
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
]);

const JOB_STATE_SET = new Set(JOB_STATES);
const ACTIVE_JOB_STATES = new Set(['queued', 'running']);
const ACKNOWLEDGEABLE_JOB_STATES = new Set([
    'completed',
    'failed',
    'cancelled',
    'interrupted',
]);
const LIFECYCLE_EVENT_TYPES = new Set([
    'created',
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
]);

const ALLOWED_TRANSITIONS = Object.freeze({
    queued: new Set(['running', 'failed', 'cancelled']),
    running: new Set(['completed', 'failed', 'cancelled', 'interrupted']),
    interrupted: new Set(['queued', 'running', 'failed', 'cancelled']),
    completed: new Set(),
    failed: new Set(),
    cancelled: new Set(),
});

class JobStoreError extends Error {
    constructor(message, code, details = {}) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        Object.assign(this, details);
    }
}

class JobNotFoundError extends JobStoreError {
    constructor(jobId) {
        super(`Proxy stream job not found: ${jobId}`, 'JOB_NOT_FOUND', { jobId });
    }
}

class IdempotencyConflictError extends JobStoreError {
    constructor(requestId, existingJobId) {
        super(
            `requestId ${requestId} is already associated with a different request`,
            'IDEMPOTENCY_CONFLICT',
            { requestId, existingJobId, statusCode: 409 },
        );
    }
}

class InvalidStateTransitionError extends JobStoreError {
    constructor(jobId, currentState, nextState) {
        super(
            `Cannot transition proxy stream job ${jobId} from ${currentState} to ${nextState}`,
            'INVALID_STATE_TRANSITION',
            { jobId, currentState, nextState },
        );
    }
}

class JobStoreCorruptionError extends JobStoreError {
    constructor(message, details = {}) {
        super(message, 'JOB_STORE_CORRUPTION', details);
    }
}

class SpoolQuotaExceededError extends JobStoreError {
    constructor(maxSpoolBytes, spoolBytes, requestedBytes) {
        super(
            `Global proxy stream spool quota of ${maxSpoolBytes} bytes is exhausted`,
            'SPOOL_QUOTA_EXCEEDED',
            {
                maxSpoolBytes,
                spoolBytes,
                requestedBytes,
                statusCode: 507,
            },
        );
    }
}

function cloneJson(value) {
    if (value === undefined) {
        return undefined;
    }
    return JSON.parse(JSON.stringify(value));
}

function assertNonEmptyString(value, field, maxLength = 512) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${field} must be a non-empty string`);
    }
    if (value.length > maxLength) {
        throw new TypeError(`${field} must be at most ${maxLength} characters`);
    }
}

function assertSafeJobId(jobId) {
    assertNonEmptyString(jobId, 'jobId', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(jobId)) {
        throw new TypeError('jobId contains unsafe path characters');
    }
}

function normalizeReplayCursor(value) {
    const parsed = Number(value ?? 0);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError('afterSequence must be a non-negative safe integer');
    }
    return parsed;
}

function normalizeReplayLimit(value) {
    if (value === undefined) {
        return DEFAULT_REPLAY_LIMIT;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_REPLAY_LIMIT) {
        throw new TypeError(`limit must be an integer between 1 and ${MAX_REPLAY_LIMIT}`);
    }
    return parsed;
}

function normalizeOptionalCutoff(value, field) {
    if (value === undefined) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError(`${field} must be a non-negative safe integer`);
    }
    return parsed;
}

function normalizeOptionalTerminalCount(value) {
    if (value === undefined) {
        return undefined;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new TypeError('maxTerminalCount must be a non-negative safe integer');
    }
    return parsed;
}

function normalizePositiveSafeInteger(value, field, fallback) {
    if (value === undefined) {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new TypeError(`${field} must be a positive safe integer`);
    }
    return parsed;
}

function emptyTransportSummary() {
    return {
        cursor: 0,
        terminal: null,
    };
}

function applyTransportSummary(summary, event) {
    if (event.type === 'upstream_headers') {
        summary.status = event.payload.status;
        summary.headers = cloneJson(event.payload.headers);
    }
    else if (event.type === 'chunk') {
        summary.cursor = Math.max(summary.cursor, Number(event.payload.endOffset) || 0);
    }
    else if (event.type === 'done' || event.type === 'error') {
        summary.cursor = Math.max(summary.cursor, Number(event.payload.finalOffset) || 0);
        summary.terminal = event.type;
    }
    return summary;
}

function terminalTimestamp(job) {
    const timestamp = job.finishedAt ?? job.updatedAt ?? job.createdAt;
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new JobStoreCorruptionError('Terminal job has an invalid retention timestamp', {
            jobId: job.id,
            timestamp,
        });
    }
    return timestamp;
}

function validateMetadata(metadata, expectedJobId = null) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new JobStoreCorruptionError('Job metadata must be an object', { jobId: expectedJobId });
    }
    if (metadata.schemaVersion !== JOB_SCHEMA_VERSION) {
        throw new JobStoreCorruptionError(
            `Unsupported job metadata schema version: ${metadata.schemaVersion}`,
            { jobId: expectedJobId },
        );
    }
    assertSafeJobId(metadata.id);
    if (expectedJobId !== null && metadata.id !== expectedJobId) {
        throw new JobStoreCorruptionError('Job directory and metadata id do not match', {
            jobId: expectedJobId,
            metadataJobId: metadata.id,
        });
    }
    assertNonEmptyString(metadata.requestId, 'requestId');
    assertNonEmptyString(metadata.requestHash, 'requestHash');
    if (!JOB_STATE_SET.has(metadata.state)) {
        throw new JobStoreCorruptionError(`Unknown job state: ${metadata.state}`, { jobId: metadata.id });
    }
    if (!Number.isSafeInteger(metadata.lastSequence) || metadata.lastSequence < 0) {
        throw new JobStoreCorruptionError('lastSequence must be a non-negative safe integer', {
            jobId: metadata.id,
        });
    }
    return metadata;
}

function validateEvent(event, expectedSequence, jobId) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new JobStoreCorruptionError('Event record must be an object', { jobId, expectedSequence });
    }
    if (event.sequence !== expectedSequence) {
        throw new JobStoreCorruptionError(
            `Expected event sequence ${expectedSequence}, received ${event.sequence}`,
            { jobId, expectedSequence, actualSequence: event.sequence },
        );
    }
    assertNonEmptyString(event.type, 'event.type', 128);
    if (!Number.isFinite(event.timestamp)) {
        throw new JobStoreCorruptionError('Event timestamp must be finite', {
            jobId,
            sequence: event.sequence,
        });
    }
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
        throw new JobStoreCorruptionError('Event payload must be an object', {
            jobId,
            sequence: event.sequence,
        });
    }
    return event;
}

class ProxyStreamJobStore {
    constructor(options = {}) {
        assertNonEmptyString(options.rootDir, 'rootDir', 4_096);
        this.rootDir = path.resolve(options.rootDir);
        this.now = options.now ?? (() => Date.now());
        this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
        this.maxSpoolBytes = normalizePositiveSafeInteger(
            options.maxSpoolBytes,
            'maxSpoolBytes',
            DEFAULT_MAX_SPOOL_BYTES,
        );
        this.runningTerminalReserveBytes = normalizePositiveSafeInteger(
            options.runningTerminalReserveBytes,
            'runningTerminalReserveBytes',
            DEFAULT_RUNNING_TERMINAL_RESERVE_BYTES,
        );
        this.queuedTerminalReserveBytes = normalizePositiveSafeInteger(
            options.queuedTerminalReserveBytes,
            'queuedTerminalReserveBytes',
            DEFAULT_QUEUED_TERMINAL_RESERVE_BYTES,
        );
        if (this.queuedTerminalReserveBytes < this.runningTerminalReserveBytes) {
            throw new TypeError('queuedTerminalReserveBytes must be at least runningTerminalReserveBytes');
        }
        this.observeEventRead = typeof options.observeEventRead === 'function'
            ? options.observeEventRead
            : null;
        this.jobs = new Map();
        this.requestIndex = new Map();
        this.eventIndexes = new Map();
        this.jobSpoolBytes = new Map();
        this.spoolBytes = 0;
        this.opened = false;
        this.operationTail = Promise.resolve();
    }

    async open() {
        return await this.#exclusive(async () => {
            if (this.opened) {
                return { jobs: this.jobs.size, recoveredInterrupted: 0 };
            }

            await this.#ensureSecureDirectory(this.rootDir);
            // A tombstone means a previous prune already atomically removed
            // the job from the live namespace and the process stopped during
            // physical cleanup. Completing that cleanup is transaction
            // recovery, not a new retention decision.
            await this.#removeStalePurgeTombstonesLocked();
            const entries = await fsp.readdir(this.rootDir, { withFileTypes: true });
            const loadedRecords = [];

            for (const entry of entries) {
                if (entry.name.startsWith('.')) {
                    continue;
                }
                if (!entry.isDirectory() || entry.isSymbolicLink()) {
                    continue;
                }
                assertSafeJobId(entry.name);
                loadedRecords.push(await this.#loadJob(entry.name));
            }

            loadedRecords.sort((left, right) => {
                return left.job.createdAt - right.job.createdAt
                    || left.job.id.localeCompare(right.job.id);
            });

            const loadedJobMap = new Map();
            const loadedRequestIndex = new Map();
            const loadedEventIndexes = new Map();
            const loadedJobSpoolBytes = new Map();
            let loadedSpoolBytes = 0;
            for (const record of loadedRecords) {
                const { job } = record;
                const indexed = loadedRequestIndex.get(job.requestId);
                if (indexed) {
                    throw new JobStoreCorruptionError(
                        `Duplicate requestId ${job.requestId} in persisted jobs`,
                        { requestId: job.requestId, jobIds: [indexed.jobId, job.id] },
                    );
                }
                loadedJobMap.set(job.id, job);
                loadedRequestIndex.set(job.requestId, {
                    jobId: job.id,
                    requestHash: job.requestHash,
                });
                loadedEventIndexes.set(job.id, record.eventIndex);
                loadedJobSpoolBytes.set(job.id, record.spoolBytes);
                loadedSpoolBytes += record.spoolBytes;
            }

            this.jobs = loadedJobMap;
            this.requestIndex = loadedRequestIndex;
            this.eventIndexes = loadedEventIndexes;
            this.jobSpoolBytes = loadedJobSpoolBytes;
            this.spoolBytes = loadedSpoolBytes;
            let recoveredInterrupted = 0;
            for (const { job } of loadedRecords) {
                if (job.state === 'queued') {
                    const message = 'Proxy stream job was not dispatched before server restart; the request envelope was not persisted and the provider was not retried';
                    await this.#finishWithErrorLocked(job, {
                        status: 503,
                        message,
                        finalOffset: job.transportSummary?.cursor ?? 0,
                    }, {
                        nextState: 'failed',
                        error: message,
                        details: {
                            status: 503,
                            reason: 'server_restart_before_dispatch',
                            providerRetried: false,
                        },
                        timestamp: this.now(),
                    });
                }
                else if (job.state === 'running') {
                    recoveredInterrupted += 1;
                    await this.#transitionLocked(job, 'interrupted', {
                        eventType: 'interrupted',
                        details: { reason: 'server_restart' },
                        timestamp: this.now(),
                    });
                }
            }

            this.opened = true;
            return { jobs: this.jobs.size, recoveredInterrupted };
        });
    }

    async create(input) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            assertNonEmptyString(input?.requestId, 'requestId');
            assertNonEmptyString(input?.requestHash, 'requestHash');

            const existing = this.requestIndex.get(input.requestId);
            if (existing) {
                if (existing.requestHash !== input.requestHash) {
                    throw new IdempotencyConflictError(input.requestId, existing.jobId);
                }
                return {
                    created: false,
                    job: cloneJson(this.jobs.get(existing.jobId)),
                };
            }

            const id = this.idFactory();
            assertSafeJobId(id);
            if (this.jobs.has(id)) {
                throw new JobStoreError(`Generated duplicate job id: ${id}`, 'DUPLICATE_JOB_ID', { jobId: id });
            }

            const timestamp = this.now();
            const context = input.context === undefined ? {} : cloneJson(input.context);
            if (!context || typeof context !== 'object' || Array.isArray(context)) {
                throw new TypeError('context must be a JSON object');
            }
            const job = {
                schemaVersion: JOB_SCHEMA_VERSION,
                id,
                requestId: input.requestId,
                requestHash: input.requestHash,
                generationId: typeof input.generationId === 'string' ? input.generationId : null,
                stepId: typeof input.stepId === 'string' ? input.stepId : null,
                state: 'queued',
                attempt: 0,
                context,
                createdAt: timestamp,
                updatedAt: timestamp,
                startedAt: null,
                finishedAt: null,
                interruptedAt: null,
                cancelRequestedAt: null,
                acknowledgedAt: null,
                acknowledgement: null,
                error: null,
                lastSequence: 0,
                transportSummary: emptyTransportSummary(),
            };

            const createdEvent = this.#makeEvent(job, 'created', {
                state: 'queued',
                requestId: job.requestId,
                requestHash: job.requestHash,
            }, timestamp);
            this.#assertSpoolCapacity(this.#eventRecordBytes(createdEvent).length, {
                additionalActiveState: 'queued',
            });

            const paths = this.#jobPaths(id);
            await this.#ensureSecureDirectory(paths.directory, { mustNotExist: true });
            await this.#ensureSecureEventFile(paths.events);
            await this.#writeMetadataAtomic(paths, job);

            this.jobs.set(id, job);
            this.requestIndex.set(job.requestId, { jobId: id, requestHash: job.requestHash });
            this.eventIndexes.set(id, []);
            this.jobSpoolBytes.set(id, 0);

            await this.#appendEventLocked(job, 'created', {
                state: 'queued',
                requestId: job.requestId,
                requestHash: job.requestHash,
            }, timestamp);

            return { created: true, job: cloneJson(job) };
        });
    }

    async get(jobId) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            return cloneJson(this.#requireJob(jobId));
        });
    }

    async list(filter = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            if (filter.state !== undefined && !JOB_STATE_SET.has(filter.state)) {
                throw new TypeError(`Unknown job state filter: ${filter.state}`);
            }

            const jobs = [...this.jobs.values()].filter((job) => {
                if (filter.state !== undefined && job.state !== filter.state) {
                    return false;
                }
                if (filter.requestId !== undefined && job.requestId !== filter.requestId) {
                    return false;
                }
                if (filter.generationId !== undefined && job.generationId !== filter.generationId) {
                    return false;
                }
                if (filter.acknowledged === true && job.acknowledgedAt === null) {
                    return false;
                }
                if (filter.acknowledged === false && job.acknowledgedAt !== null) {
                    return false;
                }
                return true;
            });

            jobs.sort((left, right) => {
                return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
            });
            return cloneJson(jobs);
        });
    }

    async usage() {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const reservedBytes = this.#reservedSpoolBytes();
            return {
                spoolBytes: this.spoolBytes,
                maxSpoolBytes: this.maxSpoolBytes,
                reservedBytes,
                availableBytes: Math.max(0, this.maxSpoolBytes - this.spoolBytes - reservedBytes),
            };
        });
    }

    /**
     * Explicitly remove terminal jobs according to a bounded retention policy.
     *
     * `acknowledgedBefore` is compared to `acknowledgedAt`, while
     * `unacknowledgedBefore` is compared to the terminal timestamp. Both are
     * strict cutoffs: a job exactly on the boundary is retained. After those
     * cutoffs are applied, `maxTerminalCount` removes the oldest remaining
     * terminal jobs until the requested bound is met. Queued and running jobs
     * are never candidates.
     */
    async prune(options = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            if (!options || typeof options !== 'object' || Array.isArray(options)) {
                throw new TypeError('prune options must be an object');
            }

            const policy = {
                acknowledgedBefore: normalizeOptionalCutoff(
                    options.acknowledgedBefore,
                    'acknowledgedBefore',
                ),
                unacknowledgedBefore: normalizeOptionalCutoff(
                    options.unacknowledgedBefore,
                    'unacknowledgedBefore',
                ),
                maxTerminalCount: normalizeOptionalTerminalCount(options.maxTerminalCount),
            };

            await this.#removeStalePurgeTombstonesLocked();

            const terminalJobs = [...this.jobs.values()].filter((job) => {
                return ACKNOWLEDGEABLE_JOB_STATES.has(job.state);
            });
            const candidates = new Map();

            for (const job of terminalJobs) {
                const finishedTimestamp = terminalTimestamp(job);
                if (
                    job.acknowledgedAt !== null
                    && policy.acknowledgedBefore !== undefined
                ) {
                    if (!Number.isSafeInteger(job.acknowledgedAt) || job.acknowledgedAt < 0) {
                        throw new JobStoreCorruptionError('Job has an invalid acknowledgement timestamp', {
                            jobId: job.id,
                            acknowledgedAt: job.acknowledgedAt,
                        });
                    }
                    if (job.acknowledgedAt < policy.acknowledgedBefore) {
                        candidates.set(job.id, {
                            job,
                            reason: 'acknowledged_cutoff',
                            terminalTimestamp: finishedTimestamp,
                        });
                    }
                }
                else if (
                    job.acknowledgedAt === null
                    && policy.unacknowledgedBefore !== undefined
                    && finishedTimestamp < policy.unacknowledgedBefore
                ) {
                    candidates.set(job.id, {
                        job,
                        reason: 'unacknowledged_cutoff',
                        terminalTimestamp: finishedTimestamp,
                    });
                }
            }

            if (policy.maxTerminalCount !== undefined) {
                const remainingTerminalJobs = terminalJobs
                    .filter((job) => !candidates.has(job.id))
                    .sort((left, right) => {
                        return terminalTimestamp(left) - terminalTimestamp(right)
                            || left.createdAt - right.createdAt
                            || left.id.localeCompare(right.id);
                    });
                const overflow = Math.max(
                    0,
                    remainingTerminalJobs.length - policy.maxTerminalCount,
                );
                for (const job of remainingTerminalJobs.slice(0, overflow)) {
                    candidates.set(job.id, {
                        job,
                        reason: 'max_terminal_count',
                        terminalTimestamp: terminalTimestamp(job),
                    });
                }
            }

            const orderedCandidates = [...candidates.values()].sort((left, right) => {
                return left.terminalTimestamp - right.terminalTimestamp
                    || left.job.createdAt - right.job.createdAt
                    || left.job.id.localeCompare(right.job.id);
            });
            const removed = [];
            for (const candidate of orderedCandidates) {
                const { job } = candidate;
                // Re-check under the serialized store lock immediately before
                // touching the filesystem. This makes the invariant explicit
                // if candidate selection changes in the future.
                if (!ACKNOWLEDGEABLE_JOB_STATES.has(job.state)) {
                    continue;
                }
                await this.#deleteJobDirectoryLocked(job);
                const releasedSpoolBytes = this.jobSpoolBytes.get(job.id) ?? 0;
                this.spoolBytes -= releasedSpoolBytes;
                this.jobSpoolBytes.delete(job.id);
                this.eventIndexes.delete(job.id);
                this.jobs.delete(job.id);
                const indexedRequest = this.requestIndex.get(job.requestId);
                if (indexedRequest?.jobId === job.id) {
                    this.requestIndex.delete(job.requestId);
                }
                removed.push({
                    id: job.id,
                    requestId: job.requestId,
                    state: job.state,
                    acknowledged: job.acknowledgedAt !== null,
                    reason: candidate.reason,
                    terminalTimestamp: candidate.terminalTimestamp,
                });
            }

            const remainingTerminalCount = [...this.jobs.values()].filter((job) => {
                return ACKNOWLEDGEABLE_JOB_STATES.has(job.state);
            }).length;
            return {
                policy,
                removed,
                removedCount: removed.length,
                remainingJobCount: this.jobs.size,
                remainingTerminalCount,
            };
        });
    }

    async appendEvent(jobId, type, payload = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            if (LIFECYCLE_EVENT_TYPES.has(type) || type === 'acknowledged') {
                throw new TypeError(`Event type ${type} is reserved for job lifecycle operations`);
            }
            const job = this.#requireJob(jobId);
            return cloneJson(await this.#appendEventLocked(job, type, payload, this.now()));
        });
    }

    async replay(jobId, options = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const job = this.#requireJob(jobId);
            const afterSequence = normalizeReplayCursor(options.afterSequence);
            const limit = normalizeReplayLimit(options.limit);
            const eventIndex = this.eventIndexes.get(job.id) ?? [];
            const startIndex = Math.min(afterSequence, eventIndex.length);
            const selectedIndex = [];
            let selectedBytes = 0;
            for (let index = startIndex; index < eventIndex.length && selectedIndex.length < limit; index += 1) {
                const entry = eventIndex[index];
                if (
                    selectedIndex.length > 0
                    && selectedBytes + entry.length > MAX_REPLAY_PAGE_BYTES
                ) {
                    break;
                }
                selectedIndex.push(entry);
                selectedBytes += entry.length;
            }
            const events = selectedIndex.length === 0
                ? []
                : await this.#readIndexedEvents(this.#jobPaths(job.id), selectedIndex);
            const nextCursor = events.length > 0
                ? events[events.length - 1].sequence
                : afterSequence;
            return {
                events: cloneJson(events),
                nextCursor,
                hasMore: eventIndex.length > nextCursor,
            };
        });
    }

    async transition(jobId, nextState, options = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            if (!JOB_STATE_SET.has(nextState)) {
                throw new TypeError(`Unknown job state: ${nextState}`);
            }
            const job = this.#requireJob(jobId);
            return cloneJson(await this.#transitionLocked(job, nextState, {
                ...options,
                eventType: nextState,
            }));
        });
    }

    async start(jobId, details = {}) {
        return await this.transition(jobId, 'running', {
            eventType: 'running',
            details,
            incrementAttempt: true,
        });
    }

    async complete(jobId, details = {}) {
        return await this.transition(jobId, 'completed', {
            eventType: 'completed',
            details,
        });
    }

    async fail(jobId, error, details = {}) {
        const errorText = error instanceof Error ? (error.message || error.name) : String(error ?? 'Unknown error');
        return await this.transition(jobId, 'failed', {
            eventType: 'failed',
            details: { ...cloneJson(details), error: errorText },
            error: errorText,
        });
    }

    async finishWithError(jobId, transportError, options = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const job = this.#requireJob(jobId);
            return cloneJson(await this.#finishWithErrorLocked(job, transportError, options));
        });
    }

    async interrupt(jobId, reason = 'interrupted') {
        return await this.transition(jobId, 'interrupted', {
            eventType: 'interrupted',
            details: { reason },
        });
    }

    async retry(jobId, details = {}) {
        return await this.transition(jobId, 'queued', {
            eventType: 'queued',
            details,
        });
    }

    async cancel(jobId, details = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const job = this.#requireJob(jobId);
            if (job.state === 'cancelled' || (!ACTIVE_JOB_STATES.has(job.state) && job.state !== 'interrupted')) {
                return cloneJson(job);
            }
            return cloneJson(await this.#transitionLocked(job, 'cancelled', {
                eventType: 'cancelled',
                details,
            }));
        });
    }

    async ack(jobId, acknowledgement = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const job = this.#requireJob(jobId);
            if (job.acknowledgedAt !== null) {
                return cloneJson(job);
            }
            if (!ACKNOWLEDGEABLE_JOB_STATES.has(job.state)) {
                throw new InvalidStateTransitionError(job.id, job.state, 'acknowledged');
            }
            const timestamp = this.now();
            const normalizedAcknowledgement = cloneJson(acknowledgement ?? {});
            if (!normalizedAcknowledgement || typeof normalizedAcknowledgement !== 'object' || Array.isArray(normalizedAcknowledgement)) {
                throw new TypeError('acknowledgement must be a JSON object');
            }
            job.acknowledgedAt = timestamp;
            job.acknowledgement = normalizedAcknowledgement;
            try {
                await this.#appendEventLocked(job, 'acknowledged', {
                    acknowledgedAt: timestamp,
                    acknowledgement: normalizedAcknowledgement,
                }, timestamp);
            }
            catch (error) {
                if (error instanceof SpoolQuotaExceededError) {
                    job.acknowledgedAt = null;
                    job.acknowledgement = null;
                }
                throw error;
            }
            return cloneJson(job);
        });
    }

    async #finishWithErrorLocked(job, transportError, options = {}) {
        const nextState = options.nextState ?? 'failed';
        if (nextState !== 'failed' && nextState !== 'cancelled') {
            throw new TypeError('finishWithError nextState must be failed or cancelled');
        }
        if (!ALLOWED_TRANSITIONS[job.state]?.has(nextState)) {
            throw new InvalidStateTransitionError(job.id, job.state, nextState);
        }

        const payload = cloneJson(transportError ?? {});
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new TypeError('transportError must be a JSON object');
        }
        const details = cloneJson(options.details ?? {});
        if (!details || typeof details !== 'object' || Array.isArray(details)) {
            throw new TypeError('finishWithError details must be a JSON object');
        }
        const timestamp = options.timestamp ?? this.now();
        const previousState = job.state;
        const errorText = options.error instanceof Error
            ? (options.error.message || options.error.name)
            : String(options.error ?? payload.message ?? 'Unknown error');
        const errorEvent = this.#makeEvent(job, 'error', payload, timestamp);
        const lifecycleEvent = this.#makeEvent(job, nextState, {
            ...details,
            ...(nextState === 'failed' ? { error: errorText } : {}),
            state: nextState,
            previousState,
            attempt: job.attempt,
        }, timestamp, errorEvent.sequence + 1);
        const errorRecord = this.#eventRecordBytes(errorEvent);
        const lifecycleRecord = this.#eventRecordBytes(lifecycleEvent);
        this.#assertSpoolCapacity(errorRecord.length + lifecycleRecord.length, {
            stateOverrides: new Map([[job.id, nextState]]),
        });

        const paths = this.#jobPaths(job.id);
        await this.#appendPreparedEventRecordLocked(job, paths, errorEvent, errorRecord);
        await this.#appendPreparedEventRecordLocked(job, paths, lifecycleEvent, lifecycleRecord);
        job.state = nextState;
        job.updatedAt = timestamp;
        job.finishedAt = timestamp;
        if (nextState === 'cancelled') {
            job.cancelRequestedAt = timestamp;
        }
        else {
            job.error = errorText;
        }
        await this.#writeMetadataAtomic(paths, job);
        return { job, event: errorEvent };
    }

    async #transitionLocked(job, nextState, options = {}) {
        if (job.state === nextState) {
            return job;
        }
        if (!ALLOWED_TRANSITIONS[job.state]?.has(nextState)) {
            throw new InvalidStateTransitionError(job.id, job.state, nextState);
        }

        const details = options.details === undefined ? {} : cloneJson(options.details);
        if (!details || typeof details !== 'object' || Array.isArray(details)) {
            throw new TypeError('transition details must be a JSON object');
        }

        const timestamp = options.timestamp ?? this.now();
        const previousJob = cloneJson(job);
        const previousState = job.state;
        job.state = nextState;
        job.updatedAt = timestamp;
        if (nextState === 'running') {
            job.startedAt = timestamp;
            job.finishedAt = null;
            job.interruptedAt = null;
            job.cancelRequestedAt = null;
            job.error = null;
            if (options.incrementAttempt) {
                job.attempt += 1;
            }
        }
        if (nextState === 'interrupted') {
            job.interruptedAt = timestamp;
            job.finishedAt = timestamp;
        }
        if (nextState === 'cancelled') {
            job.cancelRequestedAt = timestamp;
            job.finishedAt = timestamp;
        }
        if (nextState === 'completed' || nextState === 'failed') {
            job.finishedAt = timestamp;
        }
        if (options.error !== undefined) {
            job.error = options.error;
        }

        try {
            await this.#appendEventLocked(job, options.eventType ?? 'state_changed', {
                ...details,
                state: nextState,
                previousState,
                attempt: job.attempt,
            }, timestamp);
        }
        catch (error) {
            if (error instanceof SpoolQuotaExceededError) {
                Object.assign(job, previousJob);
            }
            throw error;
        }
        return job;
    }

    async #appendEventLocked(job, type, payload, timestamp) {
        assertNonEmptyString(type, 'event.type', 128);
        const normalizedPayload = cloneJson(payload ?? {});
        if (!normalizedPayload || typeof normalizedPayload !== 'object' || Array.isArray(normalizedPayload)) {
            throw new TypeError('event payload must be a JSON object');
        }
        const event = this.#makeEvent(job, type, normalizedPayload, timestamp);
        const record = this.#eventRecordBytes(event);
        this.#assertSpoolCapacity(record.length);
        const paths = this.#jobPaths(job.id);
        await this.#appendPreparedEventRecordLocked(job, paths, event, record);
        await this.#writeMetadataAtomic(paths, job);
        return event;
    }

    async #loadJob(jobId) {
        const paths = this.#jobPaths(jobId);
        await this.#assertSecureDirectory(paths.directory);
        await this.#assertRegularFile(paths.metadata);
        const metadataRaw = await fsp.readFile(paths.metadata, 'utf8').catch((error) => {
            throw new JobStoreCorruptionError(`Unable to read metadata for job ${jobId}: ${error.message}`, {
                jobId,
                cause: error,
            });
        });

        let metadata;
        try {
            metadata = JSON.parse(metadataRaw);
        }
        catch (error) {
            throw new JobStoreCorruptionError(`Invalid metadata JSON for job ${jobId}`, {
                jobId,
                cause: error,
            });
        }
        validateMetadata(metadata, jobId);
        await this.#enforceMode(paths.metadata, JOB_FILE_MODE);
        await this.#ensureSecureEventFile(paths.events);
        const persistedLastSequence = metadata.lastSequence;
        metadata.state = 'queued';
        metadata.attempt = 0;
        metadata.startedAt = null;
        metadata.finishedAt = null;
        metadata.interruptedAt = null;
        metadata.cancelRequestedAt = null;
        metadata.acknowledgedAt = null;
        metadata.acknowledgement = null;
        metadata.error = null;
        metadata.lastSequence = 0;
        metadata.transportSummary = emptyTransportSummary();
        const scanned = await this.#scanEventFile(paths, {
            repairTrailingRecord: true,
            onEvent: (event) => {
                metadata.lastSequence = event.sequence;
                metadata.updatedAt = event.timestamp;
                applyTransportSummary(metadata.transportSummary, event);
                const eventState = event.payload?.state;
                if (
                    LIFECYCLE_EVENT_TYPES.has(event.type)
                    && typeof eventState === 'string'
                    && JOB_STATE_SET.has(eventState)
                ) {
                    metadata.state = eventState;
                }
                if (event.type === 'created' || event.type === 'queued') {
                    metadata.startedAt = null;
                    metadata.finishedAt = null;
                    metadata.interruptedAt = null;
                    metadata.cancelRequestedAt = null;
                    metadata.error = null;
                }
                if (event.type === 'running') {
                    metadata.startedAt = event.timestamp;
                    metadata.finishedAt = null;
                    metadata.interruptedAt = null;
                    metadata.cancelRequestedAt = null;
                    metadata.error = null;
                    if (Number.isSafeInteger(event.payload?.attempt) && event.payload.attempt >= 0) {
                        metadata.attempt = event.payload.attempt;
                    }
                }
                if (event.type === 'interrupted') {
                    metadata.interruptedAt = event.timestamp;
                    metadata.finishedAt = event.timestamp;
                }
                if (event.type === 'cancelled') {
                    metadata.cancelRequestedAt = event.timestamp;
                    metadata.finishedAt = event.timestamp;
                }
                if (event.type === 'completed' || event.type === 'failed') {
                    metadata.finishedAt = event.timestamp;
                }
                if (event.type === 'failed' && typeof event.payload?.error === 'string') {
                    metadata.error = event.payload.error;
                }
                if (event.type === 'acknowledged') {
                    metadata.acknowledgedAt = event.payload.acknowledgedAt ?? event.timestamp;
                    metadata.acknowledgement = cloneJson(event.payload.acknowledgement ?? {});
                }
            },
        });

        const spoolLastSequence = metadata.lastSequence;
        if (persistedLastSequence > spoolLastSequence) {
            throw new JobStoreCorruptionError('Metadata references events missing from the spool', {
                jobId,
                metadataLastSequence: persistedLastSequence,
                spoolLastSequence,
            });
        }
        validateMetadata(metadata, jobId);
        await this.#writeMetadataAtomic(paths, metadata);
        return {
            job: metadata,
            eventIndex: scanned.eventIndex,
            spoolBytes: scanned.spoolBytes,
        };
    }

    async #scanEventFile(paths, options = {}) {
        await this.#assertRegularFile(paths.events);
        const flags = (options.repairTrailingRecord ? fs.constants.O_RDWR : fs.constants.O_RDONLY)
            | (fs.constants.O_NOFOLLOW ?? 0);
        const handle = await fsp.open(paths.events, flags, JOB_FILE_MODE);
        const eventIndex = [];
        const buffer = Buffer.allocUnsafe(EVENT_SCAN_BUFFER_BYTES);
        let fileOffset = 0;
        let recordStartOffset = 0;
        let lastGoodOffset = 0;
        let expectedSequence = 1;
        let recordParts = [];
        let recordBytes = 0;

        try {
            while (true) {
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, fileOffset);
                if (bytesRead === 0) {
                    break;
                }
                this.observeEventRead?.({ jobId: paths.jobId, reason: 'recovery', bytes: bytesRead });
                let chunkCursor = 0;
                while (chunkCursor < bytesRead) {
                    const newline = buffer.indexOf(0x0a, chunkCursor);
                    if (newline === -1 || newline >= bytesRead) {
                        const part = Buffer.from(buffer.subarray(chunkCursor, bytesRead));
                        recordParts.push(part);
                        recordBytes += part.length;
                        break;
                    }

                    const part = Buffer.from(buffer.subarray(chunkCursor, newline));
                    recordParts.push(part);
                    recordBytes += part.length;
                    if (recordBytes === 0) {
                        throw new JobStoreCorruptionError('Event spool contains an empty record', {
                            jobId: paths.jobId,
                            offset: recordStartOffset,
                        });
                    }

                    let event;
                    try {
                        event = JSON.parse(Buffer.concat(recordParts, recordBytes).toString('utf8'));
                    }
                    catch (error) {
                        throw new JobStoreCorruptionError('Event spool contains invalid JSON', {
                            jobId: paths.jobId,
                            offset: recordStartOffset,
                            cause: error,
                        });
                    }
                    validateEvent(event, expectedSequence, paths.jobId);
                    const recordLength = recordBytes + 1;
                    eventIndex.push({
                        sequence: event.sequence,
                        offset: recordStartOffset,
                        length: recordLength,
                    });
                    options.onEvent?.(event);
                    expectedSequence += 1;
                    lastGoodOffset = recordStartOffset + recordLength;
                    recordStartOffset = lastGoodOffset;
                    recordParts = [];
                    recordBytes = 0;
                    chunkCursor = newline + 1;
                }
                fileOffset += bytesRead;
            }

            if (recordBytes > 0) {
                if (!options.repairTrailingRecord) {
                    throw new JobStoreCorruptionError('Event spool has an incomplete trailing record', {
                        jobId: paths.jobId,
                        offset: recordStartOffset,
                    });
                }
                await handle.truncate(lastGoodOffset);
                await handle.sync();
            }
        }
        finally {
            await handle.close();
        }
        await this.#enforceMode(paths.events, JOB_FILE_MODE);
        return {
            eventIndex,
            spoolBytes: lastGoodOffset,
        };
    }

    async #readIndexedEvents(paths, selectedIndex) {
        const first = selectedIndex[0];
        const last = selectedIndex[selectedIndex.length - 1];
        const startOffset = first.offset;
        const byteLength = (last.offset + last.length) - startOffset;
        const data = Buffer.allocUnsafe(byteLength);
        const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
        const handle = await fsp.open(paths.events, flags, JOB_FILE_MODE);
        let bytesReadTotal = 0;
        try {
            while (bytesReadTotal < byteLength) {
                const { bytesRead } = await handle.read(
                    data,
                    bytesReadTotal,
                    byteLength - bytesReadTotal,
                    startOffset + bytesReadTotal,
                );
                if (bytesRead === 0) {
                    throw new JobStoreCorruptionError('Event spool ended before the indexed replay page', {
                        jobId: paths.jobId,
                        offset: startOffset + bytesReadTotal,
                    });
                }
                bytesReadTotal += bytesRead;
                this.observeEventRead?.({ jobId: paths.jobId, reason: 'replay', bytes: bytesRead });
            }
        }
        finally {
            await handle.close();
        }

        return selectedIndex.map((entry) => {
            const relativeOffset = entry.offset - startOffset;
            const record = data.subarray(relativeOffset, relativeOffset + entry.length);
            if (record[record.length - 1] !== 0x0a) {
                throw new JobStoreCorruptionError('Indexed event record is not newline terminated', {
                    jobId: paths.jobId,
                    sequence: entry.sequence,
                });
            }
            let event;
            try {
                event = JSON.parse(record.subarray(0, record.length - 1).toString('utf8'));
            }
            catch (error) {
                throw new JobStoreCorruptionError('Indexed event record contains invalid JSON', {
                    jobId: paths.jobId,
                    sequence: entry.sequence,
                    cause: error,
                });
            }
            return validateEvent(event, entry.sequence, paths.jobId);
        });
    }

    async #appendEventRecord(paths, record) {
        await this.#assertRegularFile(paths.events);
        const flags = fs.constants.O_WRONLY
            | fs.constants.O_APPEND
            | (fs.constants.O_NOFOLLOW ?? 0);
        const handle = await fsp.open(paths.events, flags, JOB_FILE_MODE);
        try {
            await handle.writeFile(record);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await this.#enforceMode(paths.events, JOB_FILE_MODE);
    }

    async #appendPreparedEventRecordLocked(job, paths, event, record) {
        if (event.sequence !== job.lastSequence + 1) {
            throw new JobStoreCorruptionError('Prepared event sequence is not contiguous', {
                jobId: job.id,
                expectedSequence: job.lastSequence + 1,
                actualSequence: event.sequence,
            });
        }
        const offset = this.jobSpoolBytes.get(job.id) ?? 0;
        await this.#appendEventRecord(paths, record);
        const eventIndex = this.eventIndexes.get(job.id);
        if (!eventIndex) {
            throw new JobStoreCorruptionError('Missing in-memory event index', { jobId: job.id });
        }
        eventIndex.push({
            sequence: event.sequence,
            offset,
            length: record.length,
        });
        this.jobSpoolBytes.set(job.id, offset + record.length);
        this.spoolBytes += record.length;
        job.lastSequence = event.sequence;
        job.updatedAt = event.timestamp;
        job.transportSummary ??= emptyTransportSummary();
        applyTransportSummary(job.transportSummary, event);
    }

    #makeEvent(job, type, payload, timestamp, sequence = job.lastSequence + 1) {
        return {
            sequence,
            type,
            timestamp,
            payload,
        };
    }

    #eventRecordBytes(event) {
        return Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
    }

    #reserveForState(state) {
        if (state === 'queued') {
            return this.queuedTerminalReserveBytes;
        }
        if (state === 'running') {
            return this.runningTerminalReserveBytes;
        }
        return 0;
    }

    #reservedSpoolBytes(stateOverrides = null) {
        let reservedBytes = 0;
        for (const job of this.jobs.values()) {
            const state = stateOverrides?.get(job.id) ?? job.state;
            reservedBytes += this.#reserveForState(state);
        }
        return reservedBytes;
    }

    #assertSpoolCapacity(additionalBytes, options = {}) {
        if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) {
            throw new TypeError('additional spool bytes must be a non-negative safe integer');
        }
        let reservedBytes = this.#reservedSpoolBytes(options.stateOverrides);
        if (options.additionalActiveState) {
            reservedBytes += this.#reserveForState(options.additionalActiveState);
        }
        if (this.spoolBytes + additionalBytes + reservedBytes > this.maxSpoolBytes) {
            throw new SpoolQuotaExceededError(
                this.maxSpoolBytes,
                this.spoolBytes,
                additionalBytes,
            );
        }
    }

    async #writeMetadataAtomic(paths, metadata) {
        const temporaryPath = path.join(
            paths.directory,
            `.meta.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
        );
        let handle;
        try {
            handle = await fsp.open(temporaryPath, 'wx', JOB_FILE_MODE);
            await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            await fsp.rename(temporaryPath, paths.metadata);
            await this.#enforceMode(paths.metadata, JOB_FILE_MODE);
            await this.#syncDirectory(paths.directory);
        }
        catch (error) {
            if (handle) {
                await handle.close().catch(() => {});
            }
            await fsp.unlink(temporaryPath).catch(() => {});
            throw error;
        }
    }

    async #deleteJobDirectoryLocked(job) {
        const paths = this.#jobPaths(job.id);
        await this.#assertSecureDirectory(this.rootDir);
        await this.#assertSecureDirectory(paths.directory);
        await this.#assertRegularFile(paths.metadata);
        await this.#assertRegularFile(paths.events);

        const tombstoneName = `.purge.${job.id}.${crypto.randomBytes(16).toString('hex')}`;
        const tombstonePath = path.join(this.rootDir, tombstoneName);
        this.#assertDirectRootChild(tombstonePath);
        if (!PURGE_TOMBSTONE_PATTERN.test(tombstoneName)) {
            throw new JobStoreCorruptionError('Generated an invalid purge tombstone name', {
                jobId: job.id,
            });
        }

        try {
            await fsp.lstat(tombstonePath);
            throw new JobStoreCorruptionError('Purge tombstone path unexpectedly exists', {
                jobId: job.id,
                tombstoneName,
            });
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }

        // Renaming within the store root atomically removes the job from the
        // live namespace. A crash after this point leaves a recognizable hidden
        // tombstone that the next prune call can safely finish deleting.
        await fsp.rename(paths.directory, tombstonePath);
        await this.#syncDirectory(this.rootDir);
        await this.#removePurgeTombstoneLocked(tombstonePath);
        await this.#syncDirectory(this.rootDir);
    }

    async #removeStalePurgeTombstonesLocked() {
        await this.#assertSecureDirectory(this.rootDir);
        const entries = await fsp.readdir(this.rootDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!PURGE_TOMBSTONE_PATTERN.test(entry.name)) {
                continue;
            }
            if (!entry.isDirectory() || entry.isSymbolicLink()) {
                throw new JobStoreCorruptionError('Purge tombstone is not a real directory', {
                    tombstoneName: entry.name,
                });
            }
            await this.#removePurgeTombstoneLocked(path.join(this.rootDir, entry.name));
        }
        await this.#syncDirectory(this.rootDir);
    }

    async #removePurgeTombstoneLocked(tombstonePath) {
        this.#assertDirectRootChild(tombstonePath);
        const tombstoneName = path.basename(tombstonePath);
        if (!PURGE_TOMBSTONE_PATTERN.test(tombstoneName)) {
            throw new JobStoreCorruptionError('Refusing to remove an invalid purge tombstone path', {
                tombstoneName,
            });
        }
        await this.#assertSecureDirectory(tombstonePath);
        const entries = await fsp.readdir(tombstonePath, { withFileTypes: true });
        for (const entry of entries) {
            const expectedFile = entry.name === 'meta.json'
                || entry.name === 'events.ndjson'
                || METADATA_TEMPORARY_FILE_PATTERN.test(entry.name);
            if (!expectedFile || !entry.isFile() || entry.isSymbolicLink()) {
                throw new JobStoreCorruptionError('Refusing to remove unsafe purge tombstone contents', {
                    tombstoneName,
                    entryName: entry.name,
                });
            }
        }
        for (const entry of entries) {
            await fsp.unlink(path.join(tombstonePath, entry.name));
        }
        await this.#syncDirectory(tombstonePath);
        await fsp.rmdir(tombstonePath);
    }

    async #ensureSecureDirectory(directory, options = {}) {
        if (options.mustNotExist) {
            await fsp.mkdir(directory, { mode: JOB_DIRECTORY_MODE });
        }
        else {
            await fsp.mkdir(directory, { recursive: true, mode: JOB_DIRECTORY_MODE });
        }
        await this.#assertSecureDirectory(directory);
        await this.#enforceMode(directory, JOB_DIRECTORY_MODE);
    }

    async #assertSecureDirectory(directory) {
        const stat = await fsp.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new JobStoreCorruptionError(`Expected a real directory: ${directory}`);
        }
    }

    async #ensureSecureEventFile(eventPath) {
        try {
            await this.#assertRegularFile(eventPath);
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
            const flags = fs.constants.O_WRONLY
                | fs.constants.O_CREAT
                | fs.constants.O_EXCL
                | (fs.constants.O_NOFOLLOW ?? 0);
            const handle = await fsp.open(eventPath, flags, JOB_FILE_MODE);
            await handle.close();
        }
        await this.#assertRegularFile(eventPath);
        await this.#enforceMode(eventPath, JOB_FILE_MODE);
    }

    async #assertRegularFile(filePath) {
        const stat = await fsp.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new JobStoreCorruptionError(`Expected a regular file: ${filePath}`);
        }
    }

    async #enforceMode(targetPath, expectedMode) {
        await fsp.chmod(targetPath, expectedMode);
        // POSIX filesystems apply these modes exactly. Windows and some WSL
        // mounts expose synthetic mode bits, so chmod is deliberately
        // best-effort there instead of making the self-hosted server unusable.
    }

    async #syncDirectory(directory) {
        let handle;
        try {
            handle = await fsp.open(directory, 'r');
            await handle.sync();
        }
        catch (error) {
            if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) {
                throw error;
            }
        }
        finally {
            await handle?.close().catch(() => {});
        }
    }

    #jobPaths(jobId) {
        assertSafeJobId(jobId);
        const directory = path.join(this.rootDir, jobId);
        return {
            jobId,
            directory,
            metadata: path.join(directory, 'meta.json'),
            events: path.join(directory, 'events.ndjson'),
        };
    }

    #assertDirectRootChild(targetPath) {
        const resolvedTarget = path.resolve(targetPath);
        if (path.dirname(resolvedTarget) !== this.rootDir) {
            throw new JobStoreCorruptionError('Path escapes the proxy job store root', {
                targetPath: resolvedTarget,
            });
        }
    }

    #requireJob(jobId) {
        assertSafeJobId(jobId);
        const job = this.jobs.get(jobId);
        if (!job) {
            throw new JobNotFoundError(jobId);
        }
        return job;
    }

    #assertOpen() {
        if (!this.opened) {
            throw new JobStoreError('Proxy stream job store is not open', 'JOB_STORE_NOT_OPEN');
        }
    }

    #exclusive(operation) {
        const run = this.operationTail.then(operation, operation);
        this.operationTail = run.catch(() => {});
        return run;
    }
}

module.exports = {
    ACKNOWLEDGEABLE_JOB_STATES,
    ACTIVE_JOB_STATES,
    IdempotencyConflictError,
    InvalidStateTransitionError,
    JOB_DIRECTORY_MODE,
    JOB_FILE_MODE,
    JOB_SCHEMA_VERSION,
    JOB_STATES,
    JobNotFoundError,
    JobStoreCorruptionError,
    JobStoreError,
    ProxyStreamJobStore,
    SpoolQuotaExceededError,
};
