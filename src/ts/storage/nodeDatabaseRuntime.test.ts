import { describe, expect, it, vi } from 'vitest'
import {
    NodeDatabaseRuntime,
    getNodeDatabaseCommitKind,
    type RuntimeDatabase,
} from './nodeDatabaseRuntime'
import {
    NodeDatabaseConflictError,
    type NodeDatabaseCommittedEvent,
    type NodeDatabaseHead,
    type NodeDatabaseHelloEvent,
    type NodeDatabaseSnapshot,
} from './nodeDatabaseSync'

const sha1 = '1'.repeat(64)
const sha2 = '2'.repeat(64)
const sha3 = '3'.repeat(64)

function head(revision: number, sha256: string): NodeDatabaseHead {
    return { revision, sha256, etag: `"risu-${revision}-${sha256}"` }
}

function database(chatPage = 0): RuntimeDatabase {
    return {
        characters: [{
            chaId: 'character-a',
            chatPage,
            chats: [
                { id: 'chat-a' },
                { id: 'chat-b' },
            ],
        }],
    }
}

class FakeSync {
    loadedSnapshotHead: NodeDatabaseHead | null = head(1, sha1)
    observedServerHead: NodeDatabaseHead | null = head(1, sha1)
    readSnapshot = vi.fn<() => Promise<NodeDatabaseSnapshot | null>>()
    adoptSnapshot = vi.fn((snapshot: NodeDatabaseSnapshot) => {
        this.loadedSnapshotHead = snapshot.head
        this.observedServerHead = snapshot.head
    })
    connect = vi.fn(async () => {})
    disconnect = vi.fn()
    private helloListeners = new Set<(event: NodeDatabaseHelloEvent) => void>()
    private committedListeners = new Set<(event: NodeDatabaseCommittedEvent) => void>()
    private errorListeners = new Set<(error: Error) => void>()

    async getIdentity() {
        return {
            deviceId: 'device-a',
            pageClientId: 'page-a',
            clientId: 'device-a.page-a',
        }
    }

    onHello(listener: (event: NodeDatabaseHelloEvent) => void) {
        this.helloListeners.add(listener)
        return () => this.helloListeners.delete(listener)
    }

    onCommitted(listener: (event: NodeDatabaseCommittedEvent) => void) {
        this.committedListeners.add(listener)
        return () => this.committedListeners.delete(listener)
    }

    onError(listener: (error: Error) => void) {
        this.errorListeners.add(listener)
        return () => this.errorListeners.delete(listener)
    }

    emitHello(revision: number, sha256: string) {
        const event = { type: 'hello' as const, ...head(revision, sha256), clientId: 'device-a.page-a' }
        this.observedServerHead = event
        for (const listener of this.helloListeners) listener(event)
    }

    emitCommitted(
        revision: number,
        sha256: string,
        clientId = 'other-device',
        kind: 'stable' | 'streaming' = 'stable',
    ) {
        const event = {
            type: 'committed' as const,
            ...head(revision, sha256),
            clientId,
            kind,
            idempotencyKey: `save-${revision}`,
            committedAt: revision,
        }
        this.observedServerHead = event
        for (const listener of this.committedListeners) listener(event)
    }
}

function makeRuntime(options: {
    sync?: FakeSync
    initial?: RuntimeDatabase
    decode?: (data: Uint8Array) => Promise<RuntimeDatabase>
    selectedIndex?: number
    refreshRetryBaseMs?: number
    refreshRetryMaxMs?: number
} = {}) {
    const sync = options.sync ?? new FakeSync()
    let current = options.initial ?? database()
    let selectedIndex = options.selectedIndex ?? 0
    const applied: RuntimeDatabase[] = []
    let runtime: NodeDatabaseRuntime<RuntimeDatabase>
    runtime = new NodeDatabaseRuntime({
        sync: sync as any,
        decode: options.decode ?? (async () => database()),
        getDatabase: () => current,
        setDatabase: (next) => {
            current = next
            applied.push(next)
            runtime.recordDatabaseUpdate({
                path: [], value: next, oldValue: null, type: 'set',
            })
        },
        getSelectedCharacterIndex: () => selectedIndex,
        setSelectedCharacterIndex: (index) => { selectedIndex = index },
        randomUUID: () => 'fixed-id',
        refreshRetryBaseMs: options.refreshRetryBaseMs,
        refreshRetryMaxMs: options.refreshRetryMaxMs,
    })
    return {
        sync,
        runtime,
        applied,
        get current() { return current },
        get selectedIndex() { return selectedIndex },
    }
}

describe('NodeDatabaseRuntime', () => {
    it('installs listeners before connect and holds a startup hello until initial dirty state is saved', async () => {
        const sync = new FakeSync()
        sync.readSnapshot.mockResolvedValue({ head: head(2, sha2), data: Uint8Array.from([2]) })
        const fixture = makeRuntime({ sync, decode: async () => database() })
        sync.connect.mockImplementation(async () => {
            sync.emitHello(2, sha2)
        })
        fixture.runtime.markDirty()

        await fixture.runtime.start()
        expect(sync.readSnapshot).not.toHaveBeenCalled()

        const initialSave = fixture.runtime.beginSave('stable')
        fixture.runtime.finishSave(initialSave)
        await fixture.runtime.waitForIdle()

        expect(sync.readSnapshot).toHaveBeenCalledOnce()
        expect(sync.adoptSnapshot).toHaveBeenCalledOnce()
    })

    it('applies a remote stable snapshot to a clean follower without echo-dirtying it', async () => {
        const sync = new FakeSync()
        const remote = database(1)
        const snapshot = { head: head(2, sha2), data: Uint8Array.from([2]) }
        sync.readSnapshot.mockResolvedValue(snapshot)
        const fixture = makeRuntime({ sync, decode: async () => remote })
        await fixture.runtime.start()

        sync.emitCommitted(2, sha2)
        await fixture.runtime.waitForIdle()

        expect(sync.readSnapshot).toHaveBeenCalledOnce()
        expect(sync.adoptSnapshot).toHaveBeenCalledWith(snapshot)
        expect(fixture.applied).toHaveLength(1)
        expect(fixture.runtime.isDirty).toBe(false)
    })

    it('can force adoption of a command prerequisite revision after a missed socket notice', async () => {
        const sync = new FakeSync()
        const snapshot = { head: head(3, sha3), data: Uint8Array.from([3]) }
        sync.readSnapshot.mockResolvedValue(snapshot)
        const fixture = makeRuntime({ sync, decode: async () => database(1) })
        await fixture.runtime.start()

        fixture.runtime.requestRevision(3)
        await fixture.runtime.waitForIdle()

        expect(sync.readSnapshot).toHaveBeenCalledOnce()
        expect(sync.adoptSnapshot).toHaveBeenCalledWith(snapshot)
        expect(fixture.runtime.loadedSnapshotHead?.revision).toBe(3)
        expect(() => fixture.runtime.requestRevision(-1)).toThrow(TypeError)
    })

    it.each(['read', 'decode', 'adopt'] as const)(
        'retries a failed %s for the same command prerequisite revision without another commit',
        async (failureStage) => {
            vi.useFakeTimers()
            try {
                const sync = new FakeSync()
                const snapshot = { head: head(3, sha3), data: Uint8Array.from([3]) }
                const decode = vi.fn(async () => database(1))
                sync.readSnapshot.mockResolvedValue(snapshot)
                if (failureStage === 'read') {
                    sync.readSnapshot.mockRejectedValueOnce(new Error('temporary read failure'))
                }
                else if (failureStage === 'decode') {
                    decode.mockRejectedValueOnce(new Error('temporary decode failure'))
                }
                else {
                    sync.adoptSnapshot.mockImplementationOnce(() => {
                        throw new Error('temporary adopt failure')
                    })
                }
                const fixture = makeRuntime({
                    sync,
                    decode,
                    refreshRetryBaseMs: 100,
                    refreshRetryMaxMs: 400,
                })
                await fixture.runtime.start()

                fixture.runtime.requestRevision(3)
                await fixture.runtime.waitForIdle()
                expect(sync.readSnapshot).toHaveBeenCalledOnce()
                expect(fixture.runtime.loadedSnapshotHead?.revision).toBe(1)

                await vi.advanceTimersByTimeAsync(99)
                expect(sync.readSnapshot).toHaveBeenCalledOnce()
                await vi.advanceTimersByTimeAsync(1)
                await fixture.runtime.waitForIdle()

                expect(sync.readSnapshot).toHaveBeenCalledTimes(2)
                expect(sync.adoptSnapshot).toHaveBeenCalled()
                expect(fixture.runtime.loadedSnapshotHead?.revision).toBe(3)
                fixture.runtime.stop()
            }
            finally {
                vi.useRealTimers()
            }
        },
    )

    it('backs failed refreshes off to a bounded delay and stop cancels the pending retry', async () => {
        vi.useFakeTimers()
        try {
            const sync = new FakeSync()
            sync.readSnapshot.mockRejectedValue(new Error('offline'))
            const fixture = makeRuntime({
                sync,
                refreshRetryBaseMs: 10,
                refreshRetryMaxMs: 20,
            })
            await fixture.runtime.start()

            fixture.runtime.requestRevision(3)
            await fixture.runtime.waitForIdle()
            expect(sync.readSnapshot).toHaveBeenCalledTimes(1)

            await vi.advanceTimersByTimeAsync(9)
            expect(sync.readSnapshot).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(1)
            expect(sync.readSnapshot).toHaveBeenCalledTimes(2)

            await vi.advanceTimersByTimeAsync(19)
            expect(sync.readSnapshot).toHaveBeenCalledTimes(2)
            await vi.advanceTimersByTimeAsync(1)
            expect(sync.readSnapshot).toHaveBeenCalledTimes(3)

            // The third retry remains capped at 20ms instead of growing to 40ms.
            await vi.advanceTimersByTimeAsync(20)
            expect(sync.readSnapshot).toHaveBeenCalledTimes(4)
            fixture.runtime.stop()
            await vi.advanceTimersByTimeAsync(1_000)
            expect(sync.readSnapshot).toHaveBeenCalledTimes(4)
        }
        finally {
            vi.useRealTimers()
        }
    })

    it('defers remote refresh while dirty, preserves a conflict, then adopts the canonical head', async () => {
        const sync = new FakeSync()
        const snapshot = { head: head(2, sha2), data: Uint8Array.from([2]) }
        sync.readSnapshot.mockResolvedValue(snapshot)
        const fixture = makeRuntime({ sync, decode: async () => database(1) })
        await fixture.runtime.start()
        expect(fixture.runtime.recordDatabaseUpdate({
            path: ['characters', 0, 'name'], value: 'changed', oldValue: 'old', type: 'set',
        })).toBe(true)

        sync.emitCommitted(2, sha2)
        await fixture.runtime.waitForIdle()
        expect(sync.readSnapshot).not.toHaveBeenCalled()

        const attempt = fixture.runtime.beginSave('stable')
        const conflict = new NodeDatabaseConflictError({
            status: 409,
            conflictId: 'preserved-conflict',
            reason: 'stale_base',
            currentHead: head(2, sha2),
        })
        fixture.runtime.failSaveWithConflict(attempt, conflict)

        expect(fixture.runtime.conflict).toBe(conflict)
        expect(fixture.runtime.isDirty).toBe(true)
        expect(fixture.runtime.isSaveInFlight).toBe(false)
        expect(sync.readSnapshot).not.toHaveBeenCalled()

        fixture.runtime.recoverFromConflict(conflict)
        await fixture.runtime.waitForIdle()

        expect(fixture.runtime.conflict).toBeNull()
        expect(fixture.runtime.persistenceError).toBeNull()
        expect(fixture.runtime.isDirty).toBe(false)
        expect(sync.adoptSnapshot).toHaveBeenCalledWith(snapshot)
        expect(fixture.runtime.loadedSnapshotHead?.revision).toBe(2)
    })

    it('blocks all later persistence after a stale executor save is rejected', () => {
        const fixture = makeRuntime()
        fixture.runtime.markDirty()
        const attempt = fixture.runtime.beginSave('streaming')
        const staleFence = new Error('stale executor fence')

        fixture.runtime.failSaveTerminal(attempt, staleFence)

        expect(fixture.runtime.persistenceError).toBe(staleFence)
        expect(fixture.runtime.conflict).toBeNull()
        expect(fixture.runtime.isDirty).toBe(true)
        expect(fixture.runtime.isSaveInFlight).toBe(false)
    })

    it('does not adopt a fetched snapshot when a local edit wins the fetch race', async () => {
        const sync = new FakeSync()
        let resolveSnapshot: (snapshot: NodeDatabaseSnapshot) => void
        sync.readSnapshot.mockImplementation(() => new Promise((resolve) => {
            resolveSnapshot = resolve
        }))
        const fixture = makeRuntime({ sync, decode: async () => database() })
        await fixture.runtime.start()

        sync.emitCommitted(2, sha2)
        fixture.runtime.recordDatabaseUpdate({
            path: ['characters', 0, 'name'], value: 'local', oldValue: 'old', type: 'set',
        })
        resolveSnapshot!({ head: head(2, sha2), data: Uint8Array.from([2]) })
        await fixture.runtime.waitForIdle()

        expect(sync.adoptSnapshot).not.toHaveBeenCalled()
        expect(fixture.applied).toHaveLength(0)
        expect(sync.loadedSnapshotHead?.revision).toBe(1)
        expect(fixture.runtime.isDirty).toBe(true)
    })

    it('ignores own commits and coalesces a burst of remote stable commits', async () => {
        const sync = new FakeSync()
        let resolveSnapshot: (snapshot: NodeDatabaseSnapshot) => void
        sync.readSnapshot.mockImplementation(() => new Promise((resolve) => {
            resolveSnapshot = resolve
        }))
        const fixture = makeRuntime({ sync, decode: async () => database() })
        await fixture.runtime.start()

        sync.emitCommitted(2, sha2, 'device-a.page-a')
        expect(sync.readSnapshot).not.toHaveBeenCalled()

        sync.emitCommitted(2, sha2)
        sync.emitCommitted(3, sha3)
        expect(sync.readSnapshot).toHaveBeenCalledOnce()
        resolveSnapshot!({ head: head(3, sha3), data: Uint8Array.from([3]) })
        await fixture.runtime.waitForIdle()

        expect(sync.readSnapshot).toHaveBeenCalledOnce()
        expect(sync.adoptSnapshot).toHaveBeenCalledOnce()
        expect(sync.loadedSnapshotHead?.revision).toBe(3)
    })

    it('coalesces remote streaming snapshots so followers see progress without decoding every commit', async () => {
        vi.useFakeTimers()
        try {
            const sync = new FakeSync()
            sync.readSnapshot.mockResolvedValue({ head: head(3, sha3), data: Uint8Array.from([3]) })
            const fixture = makeRuntime({ sync, decode: async () => database() })
            await fixture.runtime.start()

            sync.emitCommitted(2, sha2, 'other-device', 'streaming')
            sync.emitCommitted(3, sha3, 'other-device', 'streaming')
            expect(sync.readSnapshot).not.toHaveBeenCalled()

            await vi.advanceTimersByTimeAsync(750)
            await fixture.runtime.waitForIdle()

            expect(sync.readSnapshot).toHaveBeenCalledOnce()
            expect(sync.loadedSnapshotHead?.revision).toBe(3)
            fixture.runtime.stop()
        }
        finally {
            vi.useRealTimers()
        }
    })

    it('keeps chatPage navigation local and restores chat/character selection by IDs', async () => {
        const initial: RuntimeDatabase = {
            characters: [
                { chaId: 'character-a', chatPage: 0, chats: [{ id: 'chat-a' }, { id: 'chat-b' }] },
                { chaId: 'character-b', chatPage: 0, chats: [{ id: 'chat-c' }] },
            ],
        }
        const sync = new FakeSync()
        const remote: RuntimeDatabase = {
            characters: [
                { chaId: 'character-b', chatPage: 0, chats: [{ id: 'chat-c' }] },
                { chaId: 'character-a', chatPage: 0, chats: [{ id: 'chat-b' }, { id: 'chat-a' }] },
            ],
        }
        sync.readSnapshot.mockResolvedValue({ head: head(2, sha2), data: Uint8Array.from([2]) })
        const fixture = makeRuntime({ sync, initial, decode: async () => remote, selectedIndex: 0 })
        await fixture.runtime.start()

        initial.characters![0].chatPage = 1
        expect(fixture.runtime.recordDatabaseUpdate({
            path: ['characters', 0, 'chatPage'], value: 1, oldValue: 0, type: 'set',
        })).toBe(false)
        expect(fixture.runtime.isDirty).toBe(false)

        const canonical = fixture.runtime.makeCanonicalSnapshot(structuredClone(initial))
        expect(canonical.characters?.[0].chatPage).toBe(0)

        sync.emitCommitted(2, sha2)
        await fixture.runtime.waitForIdle()

        expect(fixture.selectedIndex).toBe(1)
        expect(fixture.current.characters?.[1].chaId).toBe('character-a')
        expect(fixture.current.characters?.[1].chats?.[fixture.current.characters[1].chatPage!]?.id)
            .toBe('chat-b')
        expect(fixture.runtime.isDirty).toBe(false)
    })

    it('labels only snapshots containing active chat output as streaming', () => {
        expect(getNodeDatabaseCommitKind(database())).toBe('stable')
        const streaming = database()
        streaming.characters![0].chats![0].isStreaming = true
        expect(getNodeDatabaseCommitKind(streaming)).toBe('streaming')
    })

    it('stays clean when a best-effort backup fails after the canonical commit finished', async () => {
        const fixture = makeRuntime()
        fixture.runtime.markDirty()
        const attempt = fixture.runtime.beginSave('stable')
        const canonicalCommit = vi.fn(async () => {})
        const backup = vi.fn(async () => { throw new Error('backup failed') })

        await canonicalCommit()
        fixture.runtime.finishSave(attempt)
        await expect(backup()).rejects.toThrow('backup failed')

        expect(canonicalCommit).toHaveBeenCalledOnce()
        expect(fixture.runtime.isDirty).toBe(false)
        expect(fixture.runtime.isSaveInFlight).toBe(false)
    })

    it('does not mark edits made during encoding as saved by the older snapshot', () => {
        const fixture = makeRuntime()
        fixture.runtime.markDirty()
        const encodedSnapshotEpoch = fixture.runtime.captureSaveEpoch()
        fixture.runtime.markDirty()

        const attempt = fixture.runtime.beginSave('stable', 'same-logical-save', encodedSnapshotEpoch)
        fixture.runtime.finishSave(attempt)

        expect(fixture.runtime.isDirty).toBe(true)
    })
})
