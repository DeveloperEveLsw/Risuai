// @vitest-environment node

import { beforeAll, expect, test, vi } from 'vitest'
import {
    DBState as trackedDatabaseState,
    onDatabaseUpdate,
    setDatabaseLite,
} from '../storage/databaseState.svelte'

const mocks = vi.hoisted(() => {
    const store = <T>(initial: T) => {
        let value = initial
        return {
            subscribe(run: (next: T) => void) {
                run(value)
                return () => undefined
            },
            set(next: T) {
                value = next
            },
            update(updater: (current: T) => T) {
                value = updater(value)
            },
        }
    }
    return {
        database: {
            templateDefaultVariables: '',
            characters: [],
        },
        withTriggerLowLevelAccess: vi.fn(<T extends { lowLevelAccess?: boolean }>(
            trigger: T,
            lowLevelAccess: boolean | undefined,
        ) => ({ ...trigger, lowLevelAccess })),
        selectedCharID: store(0),
        currentTriggerId: store<string | null>(null),
        reloadGuiPointer: store(0),
    }
})

vi.mock('../parser/chatML', () => ({ parseChatML: vi.fn() }))
vi.mock('../parser/parser.svelte', () => ({
    risuChatParser: vi.fn((value: string) => value),
}))
vi.mock('../storage/database.svelte', () => ({
    getCurrentCharacter: vi.fn(() => null),
    getCurrentChat: vi.fn(() => ({ message: [] })),
    getDatabase: vi.fn(() => mocks.database),
    setCurrentCharacter: vi.fn(),
    setDatabase: vi.fn(),
}))
vi.mock('../tokenizer', () => ({ tokenize: vi.fn(async () => 0) }))
vi.mock('./modules', () => ({
    getModuleTriggers: vi.fn(() => []),
    withTriggerLowLevelAccess: mocks.withTriggerLowLevelAccess,
}))
vi.mock('../stores.svelte', () => ({
    CurrentTriggerIdStore: mocks.currentTriggerId,
    DBState: { db: mocks.database },
    ReloadChatPointer: { update: vi.fn() },
    ReloadGUIPointer: mocks.reloadGuiPointer,
    selectedCharID: mocks.selectedCharID,
}))
vi.mock('./command', () => ({ processMultiCommand: vi.fn() }))
vi.mock('../util', () => ({
    parseKeyValue: vi.fn(() => []),
    sleep: vi.fn(async () => {}),
}))
vi.mock('../alert', () => ({
    alertError: vi.fn(),
    alertInput: vi.fn(),
    alertNormal: vi.fn(),
    alertSelect: vi.fn(),
}))
vi.mock('./memory/hypamemory', () => ({ HypaProcesser: vi.fn() }))
vi.mock('./request/request', () => ({ requestChatData: vi.fn() }))
vi.mock('./stableDiff', () => ({ generateAIImage: vi.fn() }))
vi.mock('./files/inlays', () => ({ writeInlayImage: vi.fn() }))
vi.mock('./scriptings', () => ({ runScripted: vi.fn() }))
vi.mock('./infunctions', () => ({ calcString: vi.fn() }))

let runTrigger: typeof import('./triggers').runTrigger

beforeAll(async () => {
    runTrigger = (await import('./triggers')).runTrigger
})

test.each([
    { characterPermission: true, storedPermission: false, effectivePermission: true },
    { characterPermission: false, storedPermission: true, effectivePermission: false },
    { characterPermission: undefined, storedPermission: true, effectivePermission: false },
])(
    'display-mode trigger uses permission $effectivePermission without mutating live input',
    async ({ characterPermission, storedPermission, effectivePermission }) => {
        setDatabaseLite({
            characters: [{
                type: 'character',
                chaId: 'character-a',
                defaultVariables: '',
                lowLevelAccess: characterPermission,
                chatPage: 0,
                chats: [{ id: 'chat-a', message: [] }],
                triggerscript: [{
                    comment: 'non-display trigger',
                    type: 'manual',
                    conditions: [],
                    effect: [],
                    lowLevelAccess: storedPermission,
                }],
            }],
        } as never)
        const liveBefore = JSON.stringify(trackedDatabaseState.db)
        const updates: unknown[] = []
        const unsubscribe = onDatabaseUpdate((update) => updates.push(update))
        mocks.withTriggerLowLevelAccess.mockClear()

        try {
            const liveCharacter = trackedDatabaseState.db.characters[0]
            await runTrigger(liveCharacter as never, 'display', {
                chat: liveCharacter.chats[0] as never,
                displayMode: true,
                displayData: 'visible text',
            })

            expect(updates).toEqual([])
            expect(JSON.stringify(trackedDatabaseState.db)).toBe(liveBefore)
            expect(mocks.withTriggerLowLevelAccess).toHaveBeenCalledWith(
                liveCharacter.type === 'group' ? undefined : liveCharacter.triggerscript[0],
                effectivePermission,
            )
        }
        finally {
            unsubscribe()
        }
    },
)
