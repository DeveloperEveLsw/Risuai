const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const STORE_SCHEMA_VERSION = 1;
const COMMAND_SCHEMA_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_REPLAY_LIMIT = 1_000;
const MAX_REPLAY_LIMIT = 10_000;
const DEFAULT_LEASE_DURATION_MS = 15_000;
const MAX_LEASE_DURATION_MS = 5 * 60_000;
const PRUNE_TOMBSTONE_PATTERN = /^\.prune-[a-f0-9]{32}\.tombstone$/;

const COMMAND_STATES = Object.freeze([
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
]);
const COMMAND_STATE_SET = new Set(COMMAND_STATES);
const TERMINAL_COMMAND_STATES = new Set([
    'completed',
    'failed',
    'cancelled',
    'interrupted',
]);
const LIFECYCLE_EVENT_TYPES = new Set([
    'created',
    'running',
    'cancel_requested',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
]);
const UI_PROMPT_EVENT_TYPE = 'ui_prompt';
const UI_PROMPT_RESPONSE_EVENT_TYPE = 'ui_prompt_response';
const UI_PROMPT_EVENT_TYPES = new Set([
    UI_PROMPT_EVENT_TYPE,
    UI_PROMPT_RESPONSE_EVENT_TYPE,
]);

class RuntimeGenerationStoreError extends Error {
    constructor(message, code, details = {}) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        Object.assign(this, details);
    }
}

class CommandNotFoundError extends RuntimeGenerationStoreError {
    constructor(commandId) {
        super(`Runtime generation command not found: ${commandId}`, 'COMMAND_NOT_FOUND', {
            commandId,
            statusCode: 404,
        });
    }
}

class IdempotencyConflictError extends RuntimeGenerationStoreError {
    constructor(requestId, existingCommandId) {
        super(
            `requestId ${requestId} is already associated with a different request`,
            'IDEMPOTENCY_CONFLICT',
            { requestId, existingCommandId, statusCode: 409 },
        );
    }
}

class InvalidCommandStateError extends RuntimeGenerationStoreError {
    constructor(commandId, currentState, operation) {
        super(
            `Cannot ${operation} runtime generation command ${commandId} while it is ${currentState}`,
            'INVALID_COMMAND_STATE',
            { commandId, currentState, operation, statusCode: 409 },
        );
    }
}

class StaleExecutorFenceError extends RuntimeGenerationStoreError {
    constructor(commandId, executorId, fencingToken, reason = 'not_current_lease') {
        super(
            `Executor lease is not current for runtime generation command ${commandId}`,
            'STALE_EXECUTOR_FENCE',
            { commandId, executorId, fencingToken, reason, statusCode: 409 },
        );
    }
}

class ActiveGenerationWriteLeaseError extends RuntimeGenerationStoreError {
    constructor(commandId, leaseExpiresAt) {
        super(
            'The canonical database is being updated by the resident runtime',
            'GENERATION_WRITE_LEASE_ACTIVE',
            { commandId, leaseExpiresAt, statusCode: 423 },
        );
    }
}

class RuntimeGenerationStoreCorruptionError extends RuntimeGenerationStoreError {
    constructor(message, details = {}) {
        super(message, 'RUNTIME_GENERATION_STORE_CORRUPTION', details);
    }
}

function cloneJson(value) {
    if (value === undefined) {
        return undefined;
    }
    return JSON.parse(JSON.stringify(value));
}

function cloneJsonObject(value, field, defaultValue = undefined) {
    const candidate = value === undefined ? defaultValue : value;
    const cloned = cloneJson(candidate);
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
        throw new TypeError(`${field} must be a JSON object`);
    }
    return cloned;
}

function assertNonEmptyString(value, field, maxLength = 512) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${field} must be a non-empty string`);
    }
    if (value.length > maxLength) {
        throw new TypeError(`${field} must be at most ${maxLength} characters`);
    }
}

function assertSafeCommandId(commandId) {
    assertNonEmptyString(commandId, 'commandId', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(commandId)) {
        throw new TypeError('commandId contains unsafe path characters');
    }
}

function assertSafePromptId(promptId) {
    assertNonEmptyString(promptId, 'promptId', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(promptId)) {
        throw new TypeError('promptId contains unsupported characters');
    }
}

function normalizeOptionalId(value, field) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    assertNonEmptyString(value, field, 512);
    return value;
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

function normalizeLeaseDuration(value, fallback, maximum) {
    const duration = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(duration) || duration <= 0 || duration > maximum) {
        throw new TypeError(`leaseDurationMs must be an integer between 1 and ${maximum}`);
    }
    return duration;
}

function normalizeLeaseCredential(value) {
    assertNonEmptyString(value?.executorId, 'executorId', 512);
    if (!Number.isSafeInteger(value?.fencingToken) || value.fencingToken <= 0) {
        throw new TypeError('fencingToken must be a positive safe integer');
    }
    return {
        executorId: value.executorId,
        fencingToken: value.fencingToken,
    };
}

function normalizePruneOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('prune options must be an object');
    }
    if (options.terminalBefore === undefined && options.maxTerminalCount === undefined) {
        throw new TypeError('prune requires terminalBefore or maxTerminalCount');
    }

    let terminalBefore = null;
    if (options.terminalBefore !== undefined) {
        terminalBefore = Number(options.terminalBefore);
        if (!Number.isSafeInteger(terminalBefore) || terminalBefore < 0) {
            throw new TypeError('terminalBefore must be a non-negative safe integer');
        }
    }

    let maxTerminalCount = null;
    if (options.maxTerminalCount !== undefined) {
        maxTerminalCount = Number(options.maxTerminalCount);
        if (!Number.isSafeInteger(maxTerminalCount) || maxTerminalCount < 0) {
            throw new TypeError('maxTerminalCount must be a non-negative safe integer');
        }
    }

    return { terminalBefore, maxTerminalCount };
}

function canonicalJsonStringify(value) {
    const ancestors = new Set();

    function encode(candidate, location) {
        if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
            return JSON.stringify(candidate);
        }
        if (typeof candidate === 'number') {
            if (!Number.isFinite(candidate)) {
                throw new TypeError(`Canonical JSON contains a non-finite number at ${location}`);
            }
            return JSON.stringify(candidate);
        }
        if (!candidate || typeof candidate !== 'object') {
            throw new TypeError(`Canonical JSON contains an unsupported value at ${location}`);
        }
        if (ancestors.has(candidate)) {
            throw new TypeError(`Canonical JSON contains a cycle at ${location}`);
        }

        ancestors.add(candidate);
        try {
            if (Array.isArray(candidate)) {
                return `[${candidate.map((item, index) => encode(item, `${location}[${index}]`)).join(',')}]`;
            }
            const prototype = Object.getPrototypeOf(candidate);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new TypeError(`Canonical JSON contains a non-plain object at ${location}`);
            }
            return `{${Object.keys(candidate).sort().map((key) => {
                return `${JSON.stringify(key)}:${encode(candidate[key], `${location}.${key}`)}`;
            }).join(',')}}`;
        }
        finally {
            ancestors.delete(candidate);
        }
    }

    return encode(value, '$');
}

function hashCanonicalRequest(value) {
    return crypto.createHash('sha256').update(canonicalJsonStringify(value)).digest('hex');
}

function validateEvent(event, expectedSequence, commandId) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new RuntimeGenerationStoreCorruptionError('Event record must be an object', {
            commandId,
            expectedSequence,
        });
    }
    if (event.sequence !== expectedSequence) {
        throw new RuntimeGenerationStoreCorruptionError(
            `Expected event sequence ${expectedSequence}, received ${event.sequence}`,
            { commandId, expectedSequence, actualSequence: event.sequence },
        );
    }
    assertNonEmptyString(event.type, 'event.type', 128);
    if (!Number.isFinite(event.timestamp)) {
        throw new RuntimeGenerationStoreCorruptionError('Event timestamp must be finite', {
            commandId,
            sequence: event.sequence,
        });
    }
    if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
        throw new RuntimeGenerationStoreCorruptionError('Event payload must be an object', {
            commandId,
            sequence: event.sequence,
        });
    }
    return event;
}

function validateCommandMetadata(command, expectedCommandId = null) {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
        throw new RuntimeGenerationStoreCorruptionError('Command metadata must be an object', {
            commandId: expectedCommandId,
        });
    }
    if (command.schemaVersion !== COMMAND_SCHEMA_VERSION) {
        throw new RuntimeGenerationStoreCorruptionError(
            `Unsupported command metadata schema version: ${command.schemaVersion}`,
            { commandId: expectedCommandId },
        );
    }
    assertSafeCommandId(command.id);
    if (expectedCommandId !== null && command.id !== expectedCommandId) {
        throw new RuntimeGenerationStoreCorruptionError('Command directory and metadata id do not match', {
            commandId: expectedCommandId,
            metadataCommandId: command.id,
        });
    }
    assertNonEmptyString(command.requestId, 'requestId');
    assertNonEmptyString(command.requestHash, 'requestHash');
    assertNonEmptyString(command.action, 'action', 128);
    if (!COMMAND_STATE_SET.has(command.state)) {
        throw new RuntimeGenerationStoreCorruptionError(`Unknown command state: ${command.state}`, {
            commandId: command.id,
        });
    }
    if (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) {
        throw new RuntimeGenerationStoreCorruptionError('Command payload must be a JSON object', {
            commandId: command.id,
        });
    }
    if (!Number.isSafeInteger(command.lastSequence) || command.lastSequence < 0) {
        throw new RuntimeGenerationStoreCorruptionError('lastSequence must be a non-negative safe integer', {
            commandId: command.id,
        });
    }
    if (!Number.isSafeInteger(command.attempt) || command.attempt < 0) {
        throw new RuntimeGenerationStoreCorruptionError('attempt must be a non-negative safe integer', {
            commandId: command.id,
        });
    }
    if (command.fencingToken !== null
        && (!Number.isSafeInteger(command.fencingToken) || command.fencingToken <= 0)) {
        throw new RuntimeGenerationStoreCorruptionError('fencingToken must be null or a positive safe integer', {
            commandId: command.id,
        });
    }
    return command;
}

function validateStoreMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new RuntimeGenerationStoreCorruptionError('Store metadata must be an object');
    }
    if (metadata.schemaVersion !== STORE_SCHEMA_VERSION) {
        throw new RuntimeGenerationStoreCorruptionError(
            `Unsupported store metadata schema version: ${metadata.schemaVersion}`,
        );
    }
    if (!Number.isSafeInteger(metadata.lastFencingToken) || metadata.lastFencingToken < 0) {
        throw new RuntimeGenerationStoreCorruptionError(
            'lastFencingToken must be a non-negative safe integer',
        );
    }
    if (metadata.lease !== null) {
        assertNonEmptyString(metadata.lease?.commandId, 'lease.commandId', 128);
        assertNonEmptyString(metadata.lease?.executorId, 'lease.executorId');
        if (!Number.isSafeInteger(metadata.lease?.fencingToken) || metadata.lease.fencingToken <= 0) {
            throw new RuntimeGenerationStoreCorruptionError('lease.fencingToken must be a positive safe integer');
        }
        if (!Number.isFinite(metadata.lease?.expiresAt)) {
            throw new RuntimeGenerationStoreCorruptionError('lease.expiresAt must be finite');
        }
    }
    return metadata;
}

class RuntimeGenerationStore {
    constructor(options = {}) {
        assertNonEmptyString(options.rootDir, 'rootDir', 4_096);
        this.rootDir = path.resolve(options.rootDir);
        this.now = options.now ?? (() => Date.now());
        this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
        this.maxLeaseDurationMs = options.maxLeaseDurationMs ?? MAX_LEASE_DURATION_MS;
        if (!Number.isSafeInteger(this.maxLeaseDurationMs) || this.maxLeaseDurationMs <= 0) {
            throw new TypeError('maxLeaseDurationMs must be a positive safe integer');
        }
        this.defaultLeaseDurationMs = normalizeLeaseDuration(
            options.defaultLeaseDurationMs,
            DEFAULT_LEASE_DURATION_MS,
            this.maxLeaseDurationMs,
        );
        this.commands = new Map();
        this.requestIndex = new Map();
        this.storeMetadata = null;
        this.opened = false;
        this.operationTail = Promise.resolve();
    }

    async open() {
        return await this.#exclusive(async () => {
            if (this.opened) {
                return {
                    commands: this.commands.size,
                    recoveredInterrupted: 0,
                    lastFencingToken: this.storeMetadata.lastFencingToken,
                };
            }

            await this.#ensureSecureDirectory(this.rootDir);
            this.storeMetadata = await this.#loadOrCreateStoreMetadata();

            const entries = await fsp.readdir(this.rootDir, { withFileTypes: true });
            await this.#cleanupPruneTombstones(entries);
            const loadedCommands = [];
            for (const entry of entries) {
                if (entry.name.startsWith('.') || entry.name === 'store.json') {
                    continue;
                }
                if (!entry.isDirectory() || entry.isSymbolicLink()) {
                    continue;
                }
                assertSafeCommandId(entry.name);
                loadedCommands.push(await this.#loadCommand(entry.name));
            }

            loadedCommands.sort((left, right) => {
                return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
            });
            const commands = new Map();
            const requestIndex = new Map();
            let observedFencingToken = this.storeMetadata.lastFencingToken;
            for (const command of loadedCommands) {
                const indexed = requestIndex.get(command.requestId);
                if (indexed) {
                    throw new RuntimeGenerationStoreCorruptionError(
                        `Duplicate requestId ${command.requestId} in persisted commands`,
                        { requestId: command.requestId, commandIds: [indexed.commandId, command.id] },
                    );
                }
                commands.set(command.id, command);
                requestIndex.set(command.requestId, {
                    commandId: command.id,
                    requestHash: command.requestHash,
                });
                if (Number.isSafeInteger(command.fencingToken)) {
                    observedFencingToken = Math.max(observedFencingToken, command.fencingToken);
                }
            }
            if (this.storeMetadata.lease) {
                observedFencingToken = Math.max(
                    observedFencingToken,
                    this.storeMetadata.lease.fencingToken,
                );
            }

            this.commands = commands;
            this.requestIndex = requestIndex;
            this.storeMetadata.lastFencingToken = observedFencingToken;

            let recoveredInterrupted = 0;
            for (const command of loadedCommands) {
                if (command.state !== 'running') {
                    continue;
                }
                recoveredInterrupted += 1;
                await this.#interruptLocked(command, 'server_restart', this.now());
            }
            this.storeMetadata.lease = null;
            this.storeMetadata.updatedAt = this.now();
            await this.#writeStoreMetadataAtomic();

            this.opened = true;
            return {
                commands: this.commands.size,
                recoveredInterrupted,
                lastFencingToken: this.storeMetadata.lastFencingToken,
            };
        });
    }

    async create(input) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            assertNonEmptyString(input?.requestId, 'requestId');
            assertNonEmptyString(input?.requestHash, 'requestHash');
            assertNonEmptyString(input?.action, 'action', 128);

            const existing = this.requestIndex.get(input.requestId);
            if (existing) {
                if (existing.requestHash !== input.requestHash) {
                    throw new IdempotencyConflictError(input.requestId, existing.commandId);
                }
                return {
                    created: false,
                    command: cloneJson(this.commands.get(existing.commandId)),
                };
            }

            const id = this.idFactory();
            assertSafeCommandId(id);
            if (this.commands.has(id)) {
                throw new RuntimeGenerationStoreError(
                    `Generated duplicate command id: ${id}`,
                    'DUPLICATE_COMMAND_ID',
                    { commandId: id },
                );
            }

            const timestamp = this.now();
            const command = {
                schemaVersion: COMMAND_SCHEMA_VERSION,
                id,
                requestId: input.requestId,
                requestHash: input.requestHash,
                action: input.action,
                characterId: normalizeOptionalId(input.characterId, 'characterId'),
                chatId: normalizeOptionalId(input.chatId, 'chatId'),
                payload: cloneJsonObject(input.payload, 'payload', {}),
                state: 'queued',
                attempt: 0,
                executorId: null,
                fencingToken: null,
                leaseExpiresAt: null,
                result: null,
                error: null,
                createdAt: timestamp,
                updatedAt: timestamp,
                startedAt: null,
                finishedAt: null,
                interruptedAt: null,
                cancelRequestedAt: null,
                lastSequence: 0,
            };

            const paths = this.#commandPaths(id);
            await this.#ensureSecureDirectory(paths.directory, { mustNotExist: true });
            await this.#ensureSecureEventFile(paths.events);
            await this.#writeCommandMetadataAtomic(paths, command);
            this.commands.set(id, command);
            this.requestIndex.set(command.requestId, {
                commandId: id,
                requestHash: command.requestHash,
            });
            await this.#appendEventLocked(command, 'created', {
                state: 'queued',
                requestId: command.requestId,
                requestHash: command.requestHash,
                action: command.action,
                characterId: command.characterId,
                chatId: command.chatId,
            }, timestamp);

            return { created: true, command: cloneJson(command) };
        });
    }

    async get(commandId) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            return cloneJson(this.#requireCommand(commandId));
        });
    }

    async list(filter = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            if (filter.state !== undefined && !COMMAND_STATE_SET.has(filter.state)) {
                throw new TypeError(`Unknown command state filter: ${filter.state}`);
            }
            const commands = [...this.commands.values()].filter((command) => {
                if (filter.state !== undefined && command.state !== filter.state) {
                    return false;
                }
                if (filter.requestId !== undefined && command.requestId !== filter.requestId) {
                    return false;
                }
                if (filter.action !== undefined && command.action !== filter.action) {
                    return false;
                }
                if (filter.characterId !== undefined && command.characterId !== filter.characterId) {
                    return false;
                }
                if (filter.chatId !== undefined && command.chatId !== filter.chatId) {
                    return false;
                }
                return true;
            });
            commands.sort((left, right) => {
                return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
            });
            return cloneJson(commands);
        });
    }

    async replay(commandId, options = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const command = this.#requireCommand(commandId);
            const afterSequence = normalizeReplayCursor(options.afterSequence);
            const limit = normalizeReplayLimit(options.limit);
            const events = await this.#readEvents(this.#commandPaths(command.id), {
                repairTrailingRecord: false,
            });
            const selected = events.filter((event) => event.sequence > afterSequence).slice(0, limit);
            const nextCursor = selected.length > 0
                ? selected[selected.length - 1].sequence
                : afterSequence;
            return {
                events: cloneJson(selected),
                nextCursor,
                hasMore: events.some((event) => event.sequence > nextCursor),
            };
        });
    }

    async prune(options = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const { terminalBefore, maxTerminalCount } = normalizePruneOptions(options);
            await this.#assertSecureDirectory(this.rootDir);

            const currentLeaseCommandId = this.storeMetadata.lease?.commandId ?? null;
            const terminalCommands = [...this.commands.values()]
                .filter((command) => TERMINAL_COMMAND_STATES.has(command.state))
                .sort((left, right) => {
                    return this.#terminalTimestamp(left) - this.#terminalTimestamp(right)
                        || left.createdAt - right.createdAt
                        || left.id.localeCompare(right.id);
                });

            const selectedIds = new Set();
            if (terminalBefore !== null) {
                for (const command of terminalCommands) {
                    if (command.id !== currentLeaseCommandId
                        && this.#terminalTimestamp(command) < terminalBefore) {
                        selectedIds.add(command.id);
                    }
                }
            }

            if (maxTerminalCount !== null) {
                let retainedCount = terminalCommands.length - selectedIds.size;
                for (const command of terminalCommands) {
                    if (retainedCount <= maxTerminalCount) {
                        break;
                    }
                    if (command.id === currentLeaseCommandId || selectedIds.has(command.id)) {
                        continue;
                    }
                    selectedIds.add(command.id);
                    retainedCount -= 1;
                }
            }

            const selected = terminalCommands.filter((command) => selectedIds.has(command.id));

            // Preflight every selected directory and index entry before the first
            // rename so a path substitution or corrupt index cannot cause a
            // partially applied policy sweep.
            for (const command of selected) {
                const paths = this.#commandPaths(command.id);
                await this.#assertSecureDirectory(paths.directory);
                await this.#assertRegularFile(paths.metadata);
                await this.#assertRegularFile(paths.events);
                const indexed = this.requestIndex.get(command.requestId);
                if (!indexed
                    || indexed.commandId !== command.id
                    || indexed.requestHash !== command.requestHash) {
                    throw new RuntimeGenerationStoreCorruptionError(
                        `Request index does not match command ${command.id}`,
                        { commandId: command.id, requestId: command.requestId },
                    );
                }
            }

            const pruned = [];
            let cleanupPending = 0;
            for (const command of selected) {
                const paths = this.#commandPaths(command.id);
                const tombstonePath = path.join(
                    this.rootDir,
                    `.prune-${crypto.randomBytes(16).toString('hex')}.tombstone`,
                );

                // Renaming within the store directory is the logical deletion
                // commit point. A crash after this point leaves a hidden,
                // recognizable tombstone which open() removes before indexing.
                await fsp.rename(paths.directory, tombstonePath);
                this.commands.delete(command.id);
                this.requestIndex.delete(command.requestId);
                await this.#syncDirectory(this.rootDir);

                try {
                    await this.#removePruneTombstone(tombstonePath);
                    await this.#syncDirectory(this.rootDir);
                }
                catch {
                    cleanupPending += 1;
                }

                pruned.push({
                    id: command.id,
                    requestId: command.requestId,
                    requestHash: command.requestHash,
                    action: command.action,
                    state: command.state,
                    createdAt: command.createdAt,
                    finishedAt: command.finishedAt,
                    lastSequence: command.lastSequence,
                });
            }

            const retainedTerminalCount = [...this.commands.values()]
                .filter((command) => TERMINAL_COMMAND_STATES.has(command.state))
                .length;
            return cloneJson({
                pruned,
                prunedCount: pruned.length,
                retainedTerminalCount,
                cleanupPending,
            });
        });
    }

    async claimNext(options = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            assertNonEmptyString(options.executorId, 'executorId', 512);
            const leaseDurationMs = normalizeLeaseDuration(
                options.leaseDurationMs,
                this.defaultLeaseDurationMs,
                this.maxLeaseDurationMs,
            );
            const timestamp = this.now();

            if (this.storeMetadata.lease) {
                if (timestamp >= this.storeMetadata.lease.expiresAt) {
                    return null;
                }
                if (this.storeMetadata.lease.executorId === options.executorId) {
                    const command = this.#requireCommand(this.storeMetadata.lease.commandId);
                    return {
                        command: cloneJson(command),
                        lease: this.#publicLease(this.storeMetadata.lease),
                    };
                }
                return null;
            }

            const running = [...this.commands.values()].find((command) => command.state === 'running');
            if (running) {
                throw new RuntimeGenerationStoreCorruptionError(
                    `Running command ${running.id} has no global executor lease`,
                    { commandId: running.id },
                );
            }

            const command = [...this.commands.values()]
                .filter((candidate) => candidate.state === 'queued')
                .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0];
            if (!command) {
                return null;
            }
            if (this.storeMetadata.lastFencingToken >= Number.MAX_SAFE_INTEGER) {
                throw new RuntimeGenerationStoreError(
                    'The executor fencing token space is exhausted',
                    'FENCING_TOKEN_EXHAUSTED',
                );
            }

            const fencingToken = this.storeMetadata.lastFencingToken + 1;
            const lease = {
                commandId: command.id,
                executorId: options.executorId,
                fencingToken,
                acquiredAt: timestamp,
                heartbeatAt: timestamp,
                expiresAt: timestamp + leaseDurationMs,
            };
            this.storeMetadata.lastFencingToken = fencingToken;
            this.storeMetadata.lease = lease;
            this.storeMetadata.updatedAt = timestamp;
            await this.#writeStoreMetadataAtomic();

            try {
                command.state = 'running';
                command.attempt += 1;
                command.executorId = lease.executorId;
                command.fencingToken = lease.fencingToken;
                command.leaseExpiresAt = lease.expiresAt;
                command.result = null;
                command.error = null;
                command.startedAt = timestamp;
                command.finishedAt = null;
                command.interruptedAt = null;
                command.cancelRequestedAt = null;
                await this.#appendEventLocked(command, 'running', {
                    state: 'running',
                    previousState: 'queued',
                    attempt: command.attempt,
                    executorId: lease.executorId,
                    fencingToken: lease.fencingToken,
                    leaseExpiresAt: lease.expiresAt,
                }, timestamp);
            }
            catch (error) {
                this.storeMetadata.lease = null;
                this.storeMetadata.updatedAt = this.now();
                await this.#writeStoreMetadataAtomic().catch(() => {});
                throw error;
            }

            return {
                command: cloneJson(command),
                lease: this.#publicLease(lease),
            };
        });
    }

    async heartbeat(commandId, options = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const credential = normalizeLeaseCredential(options);
            const leaseDurationMs = normalizeLeaseDuration(
                options.leaseDurationMs,
                this.defaultLeaseDurationMs,
                this.maxLeaseDurationMs,
            );
            const timestamp = this.now();
            const { command, lease } = this.#requireCurrentLease(commandId, credential, timestamp);

            lease.heartbeatAt = timestamp;
            lease.expiresAt = timestamp + leaseDurationMs;
            command.leaseExpiresAt = lease.expiresAt;
            command.updatedAt = timestamp;
            this.storeMetadata.updatedAt = timestamp;
            await this.#writeStoreMetadataAtomic();
            await this.#writeCommandMetadataAtomic(this.#commandPaths(command.id), command);

            return {
                command: cloneJson(command),
                lease: this.#publicLease(lease),
            };
        });
    }

    async assertCurrentLease(commandId, credentialInput = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const credential = normalizeLeaseCredential(credentialInput);
            const { command, lease } = this.#requireCurrentLease(
                commandId,
                credential,
                this.now(),
            );
            return {
                command: cloneJson(command),
                lease: this.#publicLease(lease),
            };
        });
    }

    /** Linearizes a canonical database commit with executor claim, cancel,
     * heartbeat and terminal transitions. The operation runs while the store
     * lock is held, so a fence that was current at commit start cannot be
     * revoked and replaced before the CAS reaches disk. */
    async runWithDatabaseWriteFence(fenceInput, operation) {
        if (typeof operation !== 'function') {
            throw new TypeError('database write operation must be a function');
        }
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const timestamp = this.now();
            if (fenceInput) {
                assertNonEmptyString(fenceInput.commandId, 'commandId', 128);
                const credential = normalizeLeaseCredential(fenceInput);
                const { command, lease } = this.#requireCurrentLease(
                    fenceInput.commandId,
                    credential,
                    timestamp,
                );
                return await operation({
                    command: cloneJson(command),
                    lease: this.#publicLease(lease),
                });
            }

            const lease = this.storeMetadata.lease;
            if (lease && timestamp < lease.expiresAt) {
                throw new ActiveGenerationWriteLeaseError(lease.commandId, lease.expiresAt);
            }
            return await operation(null);
        });
    }

    async appendProgress(commandId, credentialInput, type = 'progress', payload = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const credential = normalizeLeaseCredential(credentialInput);
            assertNonEmptyString(type, 'event.type', 128);
            if (LIFECYCLE_EVENT_TYPES.has(type) || UI_PROMPT_EVENT_TYPES.has(type)) {
                throw new TypeError(`Event type ${type} is reserved for runtime protocol operations`);
            }
            const normalizedPayload = cloneJsonObject(payload, 'event payload', {});
            const timestamp = this.now();
            const { command } = this.#requireCurrentLease(commandId, credential, timestamp);
            if (command.cancelRequestedAt !== null) {
                throw new InvalidCommandStateError(command.id, command.state, 'append progress to');
            }
            return cloneJson(await this.#appendEventLocked(command, type, normalizedPayload, timestamp));
        });
    }

    async issueUiPrompt(commandId, credentialInput, promptId, prompt) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const credential = normalizeLeaseCredential(credentialInput);
            assertSafePromptId(promptId);
            const normalizedPrompt = cloneJsonObject(prompt, 'UI prompt', {});
            const timestamp = this.now();
            const { command } = this.#requireCurrentLease(commandId, credential, timestamp);
            if (command.cancelRequestedAt !== null) {
                throw new InvalidCommandStateError(command.id, command.state, 'issue a UI prompt for');
            }
            const events = await this.#readEvents(this.#commandPaths(command.id), {
                repairTrailingRecord: false,
            });
            const existing = events.find((event) => {
                return event.type === UI_PROMPT_EVENT_TYPE
                    && event.payload.promptId === promptId;
            });
            if (existing) {
                const sameIssuer = existing.payload.executorId === credential.executorId
                    && existing.payload.fencingToken === credential.fencingToken;
                const samePrompt = canonicalJsonStringify(existing.payload.prompt)
                    === canonicalJsonStringify(normalizedPrompt);
                if (!sameIssuer || !samePrompt) {
                    throw new RuntimeGenerationStoreError(
                        `UI prompt ${promptId} conflicts with an existing prompt`,
                        'UI_PROMPT_CONFLICT',
                        { commandId, promptId, statusCode: 409 },
                    );
                }
                return { created: false, record: cloneJson(existing) };
            }
            const record = await this.#appendEventLocked(command, UI_PROMPT_EVENT_TYPE, {
                promptId,
                prompt: normalizedPrompt,
                executorId: credential.executorId,
                fencingToken: credential.fencingToken,
            }, timestamp);
            return { created: true, record: cloneJson(record) };
        });
    }

    async respondToUiPrompt(commandId, promptId) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            assertSafePromptId(promptId);
            const command = this.#requireCommand(commandId);
            const events = await this.#readEvents(this.#commandPaths(command.id), {
                repairTrailingRecord: false,
            });
            const existingResponse = events.find((event) => {
                return event.type === UI_PROMPT_RESPONSE_EVENT_TYPE
                    && event.payload.promptId === promptId;
            });
            // A retry after a lost HTTP response remains idempotent even if the
            // resident completed the command immediately after consuming it.
            if (existingResponse) {
                return { created: false, record: cloneJson(existingResponse) };
            }
            if (command.state !== 'running' || command.cancelRequestedAt !== null) {
                throw new InvalidCommandStateError(command.id, command.state, 'respond to a UI prompt for');
            }
            const promptEvent = events.findLast((event) => {
                return event.type === UI_PROMPT_EVENT_TYPE
                    && event.payload.promptId === promptId;
            });
            if (!promptEvent) {
                throw new RuntimeGenerationStoreError(
                    `UI prompt not found: ${promptId}`,
                    'UI_PROMPT_NOT_FOUND',
                    { commandId, promptId, statusCode: 404 },
                );
            }
            const lease = this.storeMetadata.lease;
            if (!lease
                || this.now() >= lease.expiresAt
                || lease.commandId !== command.id
                || promptEvent.payload.executorId !== lease.executorId
                || promptEvent.payload.fencingToken !== lease.fencingToken
                || command.executorId !== lease.executorId
                || command.fencingToken !== lease.fencingToken) {
                throw new RuntimeGenerationStoreError(
                    `UI prompt ${promptId} was not issued by the current executor`,
                    'UI_PROMPT_STALE',
                    { commandId, promptId, statusCode: 409 },
                );
            }
            const record = await this.#appendEventLocked(command, UI_PROMPT_RESPONSE_EVENT_TYPE, {
                promptId,
                responded: true,
            }, this.now());
            return { created: true, record: cloneJson(record) };
        });
    }

    async complete(commandId, credentialInput, result = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const credential = normalizeLeaseCredential(credentialInput);
            const normalizedResult = cloneJsonObject(result, 'result', {});
            const timestamp = this.now();
            const { command } = this.#requireCurrentLease(commandId, credential, timestamp);
            if (command.cancelRequestedAt !== null) {
                throw new InvalidCommandStateError(command.id, command.state, 'complete');
            }

            const previousState = command.state;
            command.state = 'completed';
            command.result = normalizedResult;
            command.error = null;
            command.finishedAt = timestamp;
            command.executorId = null;
            command.fencingToken = null;
            command.leaseExpiresAt = null;
            await this.#appendEventLocked(command, 'completed', {
                state: 'completed',
                previousState,
                result: normalizedResult,
                executorId: credential.executorId,
                fencingToken: credential.fencingToken,
            }, timestamp);
            await this.#clearLeaseLocked(timestamp);
            return cloneJson(command);
        });
    }

    async fail(commandId, credentialInput, error, details = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const credential = normalizeLeaseCredential(credentialInput);
            const normalizedDetails = cloneJsonObject(details, 'failure details', {});
            const errorText = error instanceof Error
                ? (error.message || error.name)
                : String(error ?? 'Unknown error');
            const timestamp = this.now();
            const { command } = this.#requireCurrentLease(commandId, credential, timestamp);
            if (command.cancelRequestedAt !== null) {
                throw new InvalidCommandStateError(command.id, command.state, 'fail');
            }

            const previousState = command.state;
            command.state = 'failed';
            command.result = normalizedDetails;
            command.error = errorText;
            command.finishedAt = timestamp;
            command.executorId = null;
            command.fencingToken = null;
            command.leaseExpiresAt = null;
            await this.#appendEventLocked(command, 'failed', {
                ...normalizedDetails,
                state: 'failed',
                previousState,
                error: errorText,
                result: normalizedDetails,
                executorId: credential.executorId,
                fencingToken: credential.fencingToken,
            }, timestamp);
            await this.#clearLeaseLocked(timestamp);
            return cloneJson(command);
        });
    }

    async cancel(commandId, details = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const normalizedDetails = cloneJsonObject(details, 'cancellation details', {});
            const timestamp = this.now();
            const command = this.#requireCommand(commandId);
            if (command.state === 'cancelled' || TERMINAL_COMMAND_STATES.has(command.state)) {
                return cloneJson(command);
            }
            if (command.state !== 'queued' && command.state !== 'running') {
                throw new InvalidCommandStateError(command.id, command.state, 'cancel');
            }

            if (command.state === 'running') {
                if (command.cancelRequestedAt !== null) {
                    return cloneJson(command);
                }
                command.cancelRequestedAt = timestamp;
                await this.#appendEventLocked(command, 'cancel_requested', {
                    ...normalizedDetails,
                    state: 'running',
                }, timestamp);
                return cloneJson(command);
            }

            command.state = 'cancelled';
            command.cancelRequestedAt = timestamp;
            command.finishedAt = timestamp;
            command.executorId = null;
            command.fencingToken = null;
            command.leaseExpiresAt = null;
            await this.#appendEventLocked(command, 'cancelled', {
                ...normalizedDetails,
                state: 'cancelled',
                previousState: 'queued',
                result: null,
            }, timestamp);
            return cloneJson(command);
        });
    }

    async completeCancellation(commandId, credentialInput, result = {}) {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            const credential = normalizeLeaseCredential(credentialInput);
            const normalizedResult = cloneJsonObject(result, 'cancellation result', {});
            const timestamp = this.now();
            const { command } = this.#requireCurrentLease(commandId, credential, timestamp);
            if (command.cancelRequestedAt === null) {
                throw new InvalidCommandStateError(command.id, command.state, 'complete cancellation of');
            }

            command.state = 'cancelled';
            command.result = normalizedResult;
            command.error = null;
            command.finishedAt = timestamp;
            command.executorId = null;
            command.fencingToken = null;
            command.leaseExpiresAt = null;
            await this.#appendEventLocked(command, 'cancelled', {
                state: 'cancelled',
                previousState: 'running',
                result: normalizedResult,
                executorId: credential.executorId,
                fencingToken: credential.fencingToken,
            }, timestamp);
            await this.#clearLeaseLocked(timestamp);
            return cloneJson(command);
        });
    }

    async expireLease() {
        return await this.#exclusive(async () => {
            this.#assertOpen();
            return cloneJson(await this.#expireLeaseLocked(this.now()));
        });
    }

    async #expireLeaseLocked(timestamp) {
        const lease = this.storeMetadata.lease;
        if (!lease || timestamp < lease.expiresAt) {
            return null;
        }

        const command = this.commands.get(lease.commandId);
        if (command?.state === 'running') {
            await this.#interruptLocked(command, 'lease_expired', timestamp, {
                executorId: lease.executorId,
                fencingToken: lease.fencingToken,
                leaseExpiresAt: lease.expiresAt,
            });
        }
        await this.#clearLeaseLocked(timestamp);
        return command ?? null;
    }

    async #interruptLocked(command, reason, timestamp, details = {}) {
        const previousState = command.state;
        const executorId = command.executorId;
        const fencingToken = command.fencingToken;
        command.state = 'interrupted';
        command.interruptedAt = timestamp;
        command.finishedAt = timestamp;
        command.executorId = null;
        command.fencingToken = null;
        command.leaseExpiresAt = null;
        await this.#appendEventLocked(command, 'interrupted', {
            ...cloneJson(details),
            state: 'interrupted',
            previousState,
            reason,
            executorId,
            fencingToken,
        }, timestamp);
        return command;
    }

    #requireCurrentLease(commandId, credential, timestamp) {
        const command = this.#requireCommand(commandId);
        const lease = this.storeMetadata.lease;
        if (lease
            && lease.commandId === command.id
            && lease.executorId === credential.executorId
            && lease.fencingToken === credential.fencingToken
            && timestamp >= lease.expiresAt) {
            throw new StaleExecutorFenceError(
                command.id,
                credential.executorId,
                credential.fencingToken,
                'lease_expired',
            );
        }
        if (command.state !== 'running'
            || !lease
            || lease.commandId !== command.id
            || lease.executorId !== credential.executorId
            || lease.fencingToken !== credential.fencingToken
            || command.executorId !== credential.executorId
            || command.fencingToken !== credential.fencingToken) {
            throw new StaleExecutorFenceError(
                command.id,
                credential.executorId,
                credential.fencingToken,
                command.state !== 'running' ? `command_${command.state}` : 'not_current_lease',
            );
        }
        return { command, lease };
    }

    async #clearLeaseLocked(timestamp) {
        if (!this.storeMetadata.lease) {
            return;
        }
        this.storeMetadata.lease = null;
        this.storeMetadata.updatedAt = timestamp;
        await this.#writeStoreMetadataAtomic();
    }

    #publicLease(lease) {
        return cloneJson({
            executorId: lease.executorId,
            fencingToken: lease.fencingToken,
            expiresAt: lease.expiresAt,
        });
    }

    async #appendEventLocked(command, type, payload, timestamp) {
        assertNonEmptyString(type, 'event.type', 128);
        const normalizedPayload = cloneJsonObject(payload, 'event payload', {});
        const event = {
            sequence: command.lastSequence + 1,
            type,
            timestamp,
            payload: normalizedPayload,
        };
        const paths = this.#commandPaths(command.id);
        await this.#appendEventRecord(paths, event);
        command.lastSequence = event.sequence;
        command.updatedAt = timestamp;
        await this.#writeCommandMetadataAtomic(paths, command);
        return event;
    }

    async #loadCommand(commandId) {
        const paths = this.#commandPaths(commandId);
        await this.#assertSecureDirectory(paths.directory);
        await this.#assertRegularFile(paths.metadata);
        let command;
        try {
            command = JSON.parse(await fsp.readFile(paths.metadata, 'utf8'));
        }
        catch (error) {
            throw new RuntimeGenerationStoreCorruptionError(
                `Invalid metadata JSON for command ${commandId}`,
                { commandId, cause: error },
            );
        }
        validateCommandMetadata(command, commandId);
        await this.#enforceMode(paths.metadata, FILE_MODE);
        await this.#ensureSecureEventFile(paths.events);
        const events = await this.#readEvents(paths, { repairTrailingRecord: true });

        const spoolLastSequence = events.length > 0 ? events[events.length - 1].sequence : 0;
        if (command.lastSequence > spoolLastSequence) {
            throw new RuntimeGenerationStoreCorruptionError(
                'Command metadata references events missing from the spool',
                {
                    commandId,
                    metadataLastSequence: command.lastSequence,
                    spoolLastSequence,
                },
            );
        }
        for (const event of events) {
            this.#applyLifecycleEvent(command, event);
        }
        command.lastSequence = spoolLastSequence;
        validateCommandMetadata(command, commandId);
        await this.#writeCommandMetadataAtomic(paths, command);
        return command;
    }

    #applyLifecycleEvent(command, event) {
        if (!LIFECYCLE_EVENT_TYPES.has(event.type)) {
            return;
        }
        command.updatedAt = event.timestamp;
        if (event.type === 'created') {
            command.state = 'queued';
            return;
        }
        if (event.type === 'running') {
            command.state = 'running';
            command.startedAt = event.timestamp;
            command.finishedAt = null;
            command.interruptedAt = null;
            command.cancelRequestedAt = null;
            command.result = null;
            command.error = null;
            command.executorId = event.payload.executorId ?? null;
            command.fencingToken = event.payload.fencingToken ?? null;
            command.leaseExpiresAt = event.payload.leaseExpiresAt ?? null;
            if (Number.isSafeInteger(event.payload.attempt) && event.payload.attempt >= 0) {
                command.attempt = event.payload.attempt;
            }
            return;
        }
        if (event.type === 'cancel_requested') {
            command.state = 'running';
            command.cancelRequestedAt = event.timestamp;
            return;
        }

        command.state = event.type;
        command.finishedAt = event.timestamp;
        command.executorId = null;
        command.fencingToken = null;
        command.leaseExpiresAt = null;
        if (event.type === 'completed') {
            command.result = cloneJson(event.payload.result ?? {});
            command.error = null;
        }
        if (event.type === 'failed') {
            if (event.payload.result
                && typeof event.payload.result === 'object'
                && !Array.isArray(event.payload.result)) {
                command.result = cloneJson(event.payload.result);
            }
            else {
                // Older schema-v1 events stored failure details only as
                // top-level event fields. Preserve those details when
                // rebuilding metadata after an upgrade.
                const legacyDetails = { ...event.payload };
                for (const field of [
                    'state',
                    'previousState',
                    'error',
                    'executorId',
                    'fencingToken',
                ]) {
                    delete legacyDetails[field];
                }
                command.result = cloneJson(legacyDetails);
            }
            command.error = typeof event.payload.error === 'string' ? event.payload.error : 'Unknown error';
        }
        if (event.type === 'cancelled') {
            command.cancelRequestedAt ??= event.timestamp;
            command.result = event.payload.result === null
                ? null
                : cloneJson(event.payload.result ?? {});
            command.error = null;
        }
        if (event.type === 'interrupted') {
            command.interruptedAt = event.timestamp;
        }
    }

    async #loadOrCreateStoreMetadata() {
        const metadataPath = this.#storeMetadataPath();
        try {
            await this.#assertRegularFile(metadataPath);
        }
        catch (error) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
            const timestamp = this.now();
            const metadata = {
                schemaVersion: STORE_SCHEMA_VERSION,
                lastFencingToken: 0,
                lease: null,
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            this.storeMetadata = metadata;
            await this.#writeStoreMetadataAtomic();
            return metadata;
        }

        let metadata;
        try {
            metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
        }
        catch (error) {
            throw new RuntimeGenerationStoreCorruptionError('Invalid store metadata JSON', {
                cause: error,
            });
        }
        validateStoreMetadata(metadata);
        await this.#enforceMode(metadataPath, FILE_MODE);
        return metadata;
    }

    async #readEvents(paths, options = {}) {
        await this.#assertRegularFile(paths.events);
        const data = await fsp.readFile(paths.events);
        const events = [];
        let cursor = 0;
        let lastGoodOffset = 0;
        let expectedSequence = 1;
        while (cursor < data.length) {
            const newline = data.indexOf(0x0a, cursor);
            if (newline === -1) {
                if (options.repairTrailingRecord) {
                    await fsp.truncate(paths.events, lastGoodOffset);
                    await this.#enforceMode(paths.events, FILE_MODE);
                    return events;
                }
                throw new RuntimeGenerationStoreCorruptionError(
                    'Event spool has an incomplete trailing record',
                    { commandId: paths.commandId, offset: cursor },
                );
            }
            const line = data.subarray(cursor, newline).toString('utf8');
            cursor = newline + 1;
            if (line.trim() === '') {
                throw new RuntimeGenerationStoreCorruptionError(
                    'Event spool contains an empty record',
                    { commandId: paths.commandId, offset: lastGoodOffset },
                );
            }
            let event;
            try {
                event = JSON.parse(line);
            }
            catch (error) {
                throw new RuntimeGenerationStoreCorruptionError(
                    'Event spool contains invalid JSON',
                    { commandId: paths.commandId, offset: lastGoodOffset, cause: error },
                );
            }
            validateEvent(event, expectedSequence, paths.commandId);
            events.push(event);
            expectedSequence += 1;
            lastGoodOffset = cursor;
        }
        return events;
    }

    async #appendEventRecord(paths, event) {
        await this.#assertRegularFile(paths.events);
        const flags = fs.constants.O_WRONLY
            | fs.constants.O_APPEND
            | (fs.constants.O_NOFOLLOW ?? 0);
        const handle = await fsp.open(paths.events, flags, FILE_MODE);
        try {
            await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await this.#enforceMode(paths.events, FILE_MODE);
    }

    #terminalTimestamp(command) {
        if (!Number.isSafeInteger(command.finishedAt) || command.finishedAt < 0) {
            throw new RuntimeGenerationStoreCorruptionError(
                `Terminal command ${command.id} has an invalid finishedAt timestamp`,
                { commandId: command.id, state: command.state, finishedAt: command.finishedAt },
            );
        }
        return command.finishedAt;
    }

    async #cleanupPruneTombstones(entries) {
        let removed = false;
        for (const entry of entries) {
            if (!PRUNE_TOMBSTONE_PATTERN.test(entry.name)) {
                continue;
            }
            const tombstonePath = path.join(this.rootDir, entry.name);
            await this.#assertSecureDirectory(tombstonePath);
            await this.#removePruneTombstone(tombstonePath);
            removed = true;
        }
        if (removed) {
            await this.#syncDirectory(this.rootDir);
        }
    }

    async #removePruneTombstone(tombstonePath) {
        if (path.dirname(tombstonePath) !== this.rootDir
            || !PRUNE_TOMBSTONE_PATTERN.test(path.basename(tombstonePath))) {
            throw new RuntimeGenerationStoreCorruptionError(
                `Refusing to remove an invalid prune tombstone path: ${tombstonePath}`,
            );
        }
        await this.#assertSecureDirectory(tombstonePath);
        await fsp.rm(tombstonePath, { recursive: true, force: false });
    }

    async #writeCommandMetadataAtomic(paths, command) {
        await this.#writeJsonAtomic(paths.directory, paths.metadata, command);
    }

    async #writeStoreMetadataAtomic() {
        validateStoreMetadata(this.storeMetadata);
        await this.#writeJsonAtomic(this.rootDir, this.#storeMetadataPath(), this.storeMetadata);
    }

    async #writeJsonAtomic(directory, targetPath, value) {
        const temporaryPath = path.join(
            directory,
            `.metadata.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
        );
        let handle;
        try {
            handle = await fsp.open(temporaryPath, 'wx', FILE_MODE);
            await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
            await handle.sync();
            await handle.close();
            handle = null;
            await fsp.rename(temporaryPath, targetPath);
            await this.#enforceMode(targetPath, FILE_MODE);
            await this.#syncDirectory(directory);
        }
        catch (error) {
            if (handle) {
                await handle.close().catch(() => {});
            }
            await fsp.unlink(temporaryPath).catch(() => {});
            throw error;
        }
    }

    async #ensureSecureDirectory(directory, options = {}) {
        if (options.mustNotExist) {
            await fsp.mkdir(directory, { mode: DIRECTORY_MODE });
        }
        else {
            await fsp.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
        }
        await this.#assertSecureDirectory(directory);
        await this.#enforceMode(directory, DIRECTORY_MODE);
    }

    async #assertSecureDirectory(directory) {
        const stat = await fsp.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new RuntimeGenerationStoreCorruptionError(`Expected a real directory: ${directory}`);
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
            const handle = await fsp.open(eventPath, flags, FILE_MODE);
            await handle.close();
        }
        await this.#assertRegularFile(eventPath);
        await this.#enforceMode(eventPath, FILE_MODE);
    }

    async #assertRegularFile(filePath) {
        const stat = await fsp.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new RuntimeGenerationStoreCorruptionError(`Expected a regular file: ${filePath}`);
        }
    }

    async #enforceMode(targetPath, expectedMode) {
        await fsp.chmod(targetPath, expectedMode);
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

    #commandPaths(commandId) {
        assertSafeCommandId(commandId);
        const directory = path.join(this.rootDir, commandId);
        return {
            commandId,
            directory,
            metadata: path.join(directory, 'meta.json'),
            events: path.join(directory, 'events.ndjson'),
        };
    }

    #storeMetadataPath() {
        return path.join(this.rootDir, 'store.json');
    }

    #requireCommand(commandId) {
        assertSafeCommandId(commandId);
        const command = this.commands.get(commandId);
        if (!command) {
            throw new CommandNotFoundError(commandId);
        }
        return command;
    }

    #assertOpen() {
        if (!this.opened) {
            throw new RuntimeGenerationStoreError(
                'Runtime generation store is not open',
                'RUNTIME_GENERATION_STORE_NOT_OPEN',
            );
        }
    }

    #exclusive(operation) {
        const run = this.operationTail.then(operation, operation);
        this.operationTail = run.catch(() => {});
        return run;
    }
}

module.exports = {
    ActiveGenerationWriteLeaseError,
    COMMAND_SCHEMA_VERSION,
    COMMAND_STATES,
    CommandNotFoundError,
    DEFAULT_LEASE_DURATION_MS,
    DIRECTORY_MODE,
    FILE_MODE,
    IdempotencyConflictError,
    InvalidCommandStateError,
    MAX_LEASE_DURATION_MS,
    RuntimeGenerationStore,
    RuntimeGenerationStoreCorruptionError,
    RuntimeGenerationStoreError,
    STORE_SCHEMA_VERSION,
    StaleExecutorFenceError,
    canonicalJsonStringify,
    hashCanonicalRequest,
};
