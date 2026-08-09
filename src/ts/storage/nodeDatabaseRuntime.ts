import type { DatabaseUpdateInfo } from './databaseState.svelte'
import { NodeDatabaseConflictError } from './nodeDatabaseSync'
import type {
    NodeDatabaseClientIdentity,
    NodeDatabaseCommitKind,
    NodeDatabaseCommittedEvent,
    NodeDatabaseHelloEvent,
    NodeDatabaseSnapshot,
    NodeDatabaseSync,
} from './nodeDatabaseSync'

interface RuntimeChat {
    id?: string
    isStreaming?: boolean
    message?: RuntimeMessage[]
}

interface RuntimeMessage {
    role?: string
    data?: string
    __risuRuntimeOptimisticId?: string
}

function isRuntimeOptimisticMessage(message: RuntimeMessage): boolean {
    return message !== null
        && typeof message === 'object'
        && Object.prototype.hasOwnProperty.call(message, '__risuRuntimeOptimisticId')
}

interface RuntimeCharacter {
    chaId?: string
    chatPage?: number
    chats?: RuntimeChat[]
}

export interface RuntimeDatabase {
    characters?: RuntimeCharacter[]
}

export interface NodeDatabaseSaveAttempt {
    readonly epoch: number
    readonly kind: NodeDatabaseCommitKind
    readonly idempotencyKey: string
}

type RuntimeSync = Pick<
    NodeDatabaseSync,
    | 'loadedSnapshotHead'
    | 'observedServerHead'
    | 'getIdentity'
    | 'readSnapshot'
    | 'adoptSnapshot'
    | 'connect'
    | 'disconnect'
    | 'onHello'
    | 'onCommitted'
    | 'onError'
>

export interface NodeDatabaseRuntimeOptions<TDatabase extends RuntimeDatabase> {
    sync: RuntimeSync
    decode: (data: Uint8Array) => Promise<TDatabase>
    getDatabase: () => TDatabase
    setDatabase: (database: TDatabase) => void
    getSelectedCharacterIndex: () => number
    setSelectedCharacterIndex: (index: number) => void
    onRemoteApplied?: (database: TDatabase) => void
    onError?: (error: Error) => void
    randomUUID?: () => string
    refreshRetryBaseMs?: number
    refreshRetryMaxMs?: number
}

function validChatIndex(character: RuntimeCharacter, value: unknown): value is number {
    return Number.isSafeInteger(value)
        && (value as number) >= 0
        && (value as number) < (character.chats?.length ?? 0)
}

function selectedChatId(character: RuntimeCharacter): string | null {
    if (!validChatIndex(character, character.chatPage)) {
        return null
    }
    const id = character.chats?.[character.chatPage]?.id
    return typeof id === 'string' && id.length > 0 ? id : null
}

function findChatIndex(character: RuntimeCharacter, chatId: string | undefined): number {
    if (!chatId) {
        return -1
    }
    return character.chats?.findIndex((chat) => chat?.id === chatId) ?? -1
}

function isChatPageOnlyUpdate(info: DatabaseUpdateInfo): info is DatabaseUpdateInfo & {
    path: ['characters', number, 'chatPage']
} {
    return info.path.length === 3
        && info.path[0] === 'characters'
        && typeof info.path[1] === 'number'
        && info.path[2] === 'chatPage'
}

export function getNodeDatabaseCommitKind(database: RuntimeDatabase): NodeDatabaseCommitKind {
    return database.characters?.some((character) =>
        character?.chats?.some((chat) => chat?.isStreaming === true)
    ) ? 'streaming' : 'stable'
}

export class NodeDatabaseRuntime<TDatabase extends RuntimeDatabase> {
    private readonly sync: RuntimeSync
    private readonly decode: (data: Uint8Array) => Promise<TDatabase>
    private readonly getDatabase: () => TDatabase
    private readonly setDatabase: (database: TDatabase) => void
    private readonly getSelectedCharacterIndex: () => number
    private readonly setSelectedCharacterIndex: (index: number) => void
    private readonly onRemoteApplied?: (database: TDatabase) => void
    private readonly onError?: (error: Error) => void
    private readonly randomUUID: () => string
    private readonly refreshRetryBaseMs: number
    private readonly refreshRetryMaxMs: number

    private identity: NodeDatabaseClientIdentity | null = null
    private dirtyEpoch = 0
    private localDirty = false
    private saveInFlight = false
    private applyingRemote = false
    private terminalPersistenceError: Error | null = null
    private pendingStableRevision: number | null = null
    private streamingRefreshTimer: ReturnType<typeof setTimeout> | null = null
    private refreshRetryTimer: ReturnType<typeof setTimeout> | null = null
    private refreshRetryAttempt = 0
    private refreshPromise: Promise<void> | null = null
    private stopped = false
    private canonicalChatByCharacter = new Map<string, string | null>()
    private localChatByCharacter = new Map<string, string>()
    private unsubscribers: Array<() => void> = []

    constructor(options: NodeDatabaseRuntimeOptions<TDatabase>) {
        this.sync = options.sync
        this.decode = options.decode
        this.getDatabase = options.getDatabase
        this.setDatabase = options.setDatabase
        this.getSelectedCharacterIndex = options.getSelectedCharacterIndex
        this.setSelectedCharacterIndex = options.setSelectedCharacterIndex
        this.onRemoteApplied = options.onRemoteApplied
        this.onError = options.onError
        this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID())
        this.refreshRetryBaseMs = Math.max(1, options.refreshRetryBaseMs ?? 500)
        this.refreshRetryMaxMs = Math.max(
            this.refreshRetryBaseMs,
            options.refreshRetryMaxMs ?? 30_000,
        )
        this.captureCanonicalNavigation(this.getDatabase())
        this.captureLocalNavigation(this.getDatabase())
    }

    get isDirty() {
        return this.localDirty
    }

    get isSaveInFlight() {
        return this.saveInFlight
    }

    get isApplyingRemote() {
        return this.applyingRemote
    }

    get conflict() {
        return this.terminalPersistenceError instanceof NodeDatabaseConflictError
            ? this.terminalPersistenceError
            : null
    }

    get persistenceError() {
        return this.terminalPersistenceError
    }

    get loadedSnapshotHead() {
        return this.sync.loadedSnapshotHead
    }

    get canApplyEphemeralMutation() {
        return !this.localDirty
            && !this.saveInFlight
            && !this.applyingRemote
            && !this.terminalPersistenceError
            && this.sync.loadedSnapshotHead !== null
    }

    /** Applies a UI-only optimistic mutation without making it a canonical DB
     * write. A later server snapshot replaces it. This is deliberately
     * synchronous so no unrelated user mutation can be accidentally hidden. */
    runEphemeralMutation<TResult>(operation: () => TResult): TResult {
        if (!this.canApplyEphemeralMutation) {
            throw new Error('The canonical database is not clean enough for an optimistic update')
        }
        this.applyingRemote = true
        try {
            return operation()
        }
        finally {
            this.applyingRemote = false
        }
    }

    async start() {
        if (this.identity) {
            return
        }
        this.stopped = false
        this.identity = await this.sync.getIdentity()
        this.unsubscribers.push(
            this.sync.onHello((event) => this.handleHello(event)),
            this.sync.onCommitted((event) => this.handleCommitted(event)),
            this.sync.onError((error) => this.reportError(error)),
        )
        try {
            await this.sync.connect()
        }
        catch {
            // NodeDatabaseSync already reports and schedules ticket reconnects.
        }
    }

    stop() {
        this.stopped = true
        for (const unsubscribe of this.unsubscribers.splice(0)) {
            unsubscribe()
        }
        this.sync.disconnect()
        if (this.streamingRefreshTimer !== null) {
            clearTimeout(this.streamingRefreshTimer)
            this.streamingRefreshTimer = null
        }
        if (this.refreshRetryTimer !== null) {
            clearTimeout(this.refreshRetryTimer)
            this.refreshRetryTimer = null
        }
    }

    /** Returns true only when the canonical database save loop should run. */
    recordDatabaseUpdate(info: DatabaseUpdateInfo): boolean {
        if (this.applyingRemote) {
            return false
        }
        if (isChatPageOnlyUpdate(info)) {
            this.captureCharacterLocalNavigation(this.getDatabase(), info.path[1])
            return false
        }
        this.captureMissingCanonicalNavigation(this.getDatabase())
        this.markDirty()
        return true
    }

    markDirty() {
        this.dirtyEpoch += 1
        this.localDirty = true
    }

    captureSaveEpoch() {
        return this.dirtyEpoch
    }

    beginSave(
        kind: NodeDatabaseCommitKind,
        idempotencyKey?: string,
        epoch = this.dirtyEpoch,
    ): NodeDatabaseSaveAttempt {
        this.saveInFlight = true
        return Object.freeze({
            epoch,
            kind,
            idempotencyKey: idempotencyKey ?? `database-${this.randomUUID()}`,
        })
    }

    finishSave(attempt: NodeDatabaseSaveAttempt) {
        this.saveInFlight = false
        if (attempt.epoch === this.dirtyEpoch) {
            this.localDirty = false
        }
        this.scheduleRefresh()
    }

    failSave(_attempt: NodeDatabaseSaveAttempt) {
        this.saveInFlight = false
    }

    failSaveWithConflict(_attempt: NodeDatabaseSaveAttempt, error: NodeDatabaseConflictError) {
        this.saveInFlight = false
        this.localDirty = true
        this.terminalPersistenceError = error
    }

    /** The server has already preserved the stale opaque blob as a conflict.
     * Drop it as the active browser snapshot and resume from the current head
     * so one simultaneous edit cannot permanently brick this device. */
    recoverFromConflict(error: NodeDatabaseConflictError) {
        if (this.terminalPersistenceError !== error) {
            throw new Error('The database conflict is no longer current')
        }
        this.dirtyEpoch += 1
        this.localDirty = false
        this.saveInFlight = false
        this.terminalPersistenceError = null
        this.pendingStableRevision = Math.max(
            this.pendingStableRevision ?? -1,
            error.currentRevision,
        )
        this.scheduleRefresh()
    }

    failSaveTerminal(_attempt: NodeDatabaseSaveAttempt, error: Error) {
        this.saveInFlight = false
        this.localDirty = true
        this.terminalPersistenceError = error
    }

    /**
     * Replaces each device overlay with the canonical chat id before encoding,
     * so a later character change cannot leak local navigation into the blob.
     */
    makeCanonicalSnapshot(database: TDatabase): TDatabase {
        for (const character of database.characters ?? []) {
            for (const chat of character?.chats ?? []) {
                if (!chat?.message?.some(isRuntimeOptimisticMessage)) {
                    continue
                }
                // The caller supplies a detached database snapshot. Replace the
                // snapshot array rather than touching the live browser database,
                // and discard the whole presentation-only message rather than
                // merely stripping its marker and persisting a duplicate.
                chat.message = chat.message.filter((message) => !isRuntimeOptimisticMessage(message))
            }
            const characterId = character?.chaId
            if (!characterId) {
                continue
            }
            if (!this.canonicalChatByCharacter.has(characterId)) {
                this.canonicalChatByCharacter.set(characterId, selectedChatId(character))
            }
            const canonicalIndex = findChatIndex(
                character,
                this.canonicalChatByCharacter.get(characterId) ?? undefined,
            )
            character.chatPage = canonicalIndex >= 0 ? canonicalIndex : 0
            if (canonicalIndex < 0) {
                this.canonicalChatByCharacter.set(characterId, selectedChatId(character))
            }
        }
        return database
    }

    async waitForIdle() {
        await this.refreshPromise
    }

    /** Ensure a resident executor has adopted at least the revision named by
     * the command it is about to run. This also repairs a missed WS notice by
     * forcing the normal staged GET/adopt path. */
    requestRevision(revision: number) {
        if (!Number.isSafeInteger(revision) || revision < 0) {
            throw new TypeError('Database revision must be a non-negative safe integer')
        }
        if ((this.sync.loadedSnapshotHead?.revision ?? -1) < revision) {
            this.queueStableRevision(revision)
        }
    }

    private handleHello(event: NodeDatabaseHelloEvent) {
        if (event.revision > (this.sync.loadedSnapshotHead?.revision ?? -1)) {
            this.queueStableRevision(event.revision)
        }
    }

    private handleCommitted(event: NodeDatabaseCommittedEvent) {
        if (event.clientId === this.identity?.clientId) {
            return
        }
        if (event.revision > (this.sync.loadedSnapshotHead?.revision ?? -1)) {
            this.pendingStableRevision = Math.max(this.pendingStableRevision ?? -1, event.revision)
            if (event.kind === 'streaming') {
                if (this.streamingRefreshTimer === null) {
                    this.streamingRefreshTimer = setTimeout(() => {
                        this.streamingRefreshTimer = null
                        this.scheduleRefresh()
                    }, 750)
                }
                return
            }
            if (this.streamingRefreshTimer !== null) {
                clearTimeout(this.streamingRefreshTimer)
                this.streamingRefreshTimer = null
            }
            this.scheduleRefresh()
        }
    }

    private queueStableRevision(revision: number) {
        this.pendingStableRevision = Math.max(this.pendingStableRevision ?? -1, revision)
        this.scheduleRefresh()
    }

    private canApplyRemote() {
        return !this.localDirty
            && !this.saveInFlight
            && !this.terminalPersistenceError
            && !this.applyingRemote
    }

    private scheduleRefresh() {
        if (
            this.stopped
            || this.refreshPromise
            || this.refreshRetryTimer !== null
            || this.pendingStableRevision === null
            || !this.canApplyRemote()
        ) {
            return
        }
        this.refreshPromise = this.refreshPending()
            .catch((error) => this.reportError(error))
            .finally(() => {
                this.refreshPromise = null
                if (this.stopped) {
                    return
                }
                if (this.pendingStableRevision === null) {
                    this.refreshRetryAttempt = 0
                    return
                }
                if (this.canApplyRemote()) {
                    this.scheduleRefreshRetry()
                }
            })
    }

    private scheduleRefreshRetry() {
        if (
            this.stopped
            || this.refreshRetryTimer !== null
            || this.pendingStableRevision === null
            || !this.canApplyRemote()
        ) {
            return
        }
        const delay = Math.min(
            this.refreshRetryMaxMs,
            this.refreshRetryBaseMs * (2 ** Math.min(this.refreshRetryAttempt, 30)),
        )
        this.refreshRetryAttempt = Math.min(this.refreshRetryAttempt + 1, 31)
        this.refreshRetryTimer = setTimeout(() => {
            this.refreshRetryTimer = null
            this.scheduleRefresh()
        }, delay)
    }

    private async refreshPending() {
        const requestedRevision = this.pendingStableRevision
        if (requestedRevision === null) {
            return
        }
        if ((this.sync.loadedSnapshotHead?.revision ?? -1) >= requestedRevision) {
            this.pendingStableRevision = null
            return
        }

        const startingEpoch = this.dirtyEpoch
        const candidate = await this.sync.readSnapshot()
        if (!candidate) {
            return
        }
        const decoded = await this.decode(candidate.data)

        // A local edit may have happened while fetch/decode was awaiting. The
        // staged snapshot is then observed but never adopted as its CAS base.
        if (!this.canApplyRemote() || startingEpoch !== this.dirtyEpoch) {
            return
        }
        this.applyRemoteCandidate(candidate, decoded)
        if (
            this.pendingStableRevision !== null
            && candidate.head.revision >= this.pendingStableRevision
        ) {
            this.pendingStableRevision = null
        }
    }

    private applyRemoteCandidate(candidate: NodeDatabaseSnapshot, database: TDatabase) {
        const previousDatabase = this.getDatabase()
        const selectedIndex = this.getSelectedCharacterIndex()
        const selectedCharacterId = previousDatabase.characters?.[selectedIndex]?.chaId
        this.captureLocalNavigation(previousDatabase)
        this.captureCanonicalNavigation(database)
        this.applyLocalNavigation(database)

        this.applyingRemote = true
        try {
            this.setDatabase(database)
            const restoredIndex = selectedCharacterId
                ? database.characters?.findIndex((character) => character?.chaId === selectedCharacterId) ?? -1
                : -1
            this.setSelectedCharacterIndex(restoredIndex)
            this.sync.adoptSnapshot(candidate)
            this.onRemoteApplied?.(database)
        }
        finally {
            this.applyingRemote = false
        }
    }

    private captureCanonicalNavigation(database: RuntimeDatabase) {
        const nextCanonical = new Map<string, string | null>()
        for (const character of database.characters ?? []) {
            if (character?.chaId) {
                nextCanonical.set(character.chaId, selectedChatId(character))
            }
        }
        this.canonicalChatByCharacter = nextCanonical
    }

    private captureMissingCanonicalNavigation(database: RuntimeDatabase) {
        for (const character of database.characters ?? []) {
            if (character?.chaId && !this.canonicalChatByCharacter.has(character.chaId)) {
                this.canonicalChatByCharacter.set(character.chaId, selectedChatId(character))
            }
        }
    }

    private captureLocalNavigation(database: RuntimeDatabase) {
        for (let index = 0; index < (database.characters?.length ?? 0); index += 1) {
            this.captureCharacterLocalNavigation(database, index)
        }
    }

    private captureCharacterLocalNavigation(database: RuntimeDatabase, characterIndex: number) {
        const character = database.characters?.[characterIndex]
        const characterId = character?.chaId
        const chatId = character ? selectedChatId(character) : null
        if (characterId && chatId) {
            this.localChatByCharacter.set(characterId, chatId)
        }
    }

    private applyLocalNavigation(database: RuntimeDatabase) {
        for (const character of database.characters ?? []) {
            const characterId = character?.chaId
            if (!characterId) {
                continue
            }
            const localIndex = findChatIndex(character, this.localChatByCharacter.get(characterId))
            if (localIndex >= 0) {
                character.chatPage = localIndex
                continue
            }
            if (!validChatIndex(character, character.chatPage)) {
                character.chatPage = 0
            }
            const fallbackId = selectedChatId(character)
            if (fallbackId) {
                this.localChatByCharacter.set(characterId, fallbackId)
            }
        }
    }

    private reportError(error: unknown) {
        const normalized = error instanceof Error ? error : new Error(String(error))
        this.onError?.(normalized)
    }
}
