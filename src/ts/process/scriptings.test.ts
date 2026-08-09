// @vitest-environment node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, expect, test, vi } from 'vitest'
import {
  DBState as trackedDatabaseState,
  onDatabaseUpdate,
  setDatabaseLite,
} from '../storage/databaseState.svelte'

const moduleMocks = vi.hoisted(() => ({
  withTriggerLowLevelAccess: vi.fn(<T extends { lowLevelAccess?: boolean }>(
    trigger: T,
    lowLevelAccess: boolean | undefined,
  ) => ({ ...trigger, lowLevelAccess })),
}))

vi.mock('../parser/parser.svelte', () => ({
  hasher: vi.fn(),
  risuChatParser: vi.fn(),
}))

vi.mock('../alert', () => ({
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  alertInput: vi.fn(),
  alertNormal: vi.fn(),
  alertSelect: vi.fn(),
}))

vi.mock('../globalApi.svelte', () => ({ fetchNative: vi.fn(), readImage: vi.fn() }))
vi.mock('../tokenizer', () => ({ tokenize: vi.fn() }))
vi.mock('../util', () => ({
  asBuffer: vi.fn(),
  getPersonaPrompt: vi.fn(),
  getUserIcon: vi.fn(),
  getUserName: vi.fn(),
}))

vi.mock('../storage/database.svelte', () => ({
  getCurrentCharacter: vi.fn(() => ({})),
  getCurrentChat: vi.fn(() => ({ message: [] })),
  getDatabase: vi.fn(() => ({ characters: [] })),
  setDatabase: vi.fn(),
}))

vi.mock('../stores.svelte', () => ({
  DBState: { db: {} },
  ReloadChatPointer: { update: vi.fn() },
  ReloadGUIPointer: { update: vi.fn() },
  selectedCharID: { subscribe: (run: (value: number) => void) => (run(0), () => undefined) },
}))

vi.mock('./modules', () => ({
  getModuleLorebooks: vi.fn(() => []),
  getModuleTriggers: vi.fn(() => []),
  withTriggerLowLevelAccess: moduleMocks.withTriggerLowLevelAccess,
}))

vi.mock('./files/inlays', () => ({ getInlayAsset: vi.fn(), writeInlayImage: vi.fn() }))
vi.mock('./lorebook.svelte', () => ({ loadLoreBookV3Prompt: vi.fn() }))
vi.mock('./memory/hypamemory', () => ({ HypaProcesser: vi.fn() }))
vi.mock('./request/request', () => ({ requestChatData: vi.fn() }))
vi.mock('./stableDiff', () => ({ generateAIImage: vi.fn() }))

let runScripted: typeof import('./scriptings').runScripted
let runLuaEditTrigger: typeof import('./scriptings').runLuaEditTrigger

beforeAll(async () => {
  const jsonLua = await readFile(resolve(process.cwd(), 'public/lua/json.lua'), 'utf8')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(jsonLua, { status: 200 })))
  const scriptings = await import('./scriptings')
  runScripted = scriptings.runScripted
  runLuaEditTrigger = scriptings.runLuaEditTrigger
})

test('prepares edit-display trigger permissions without mutating the tracked database', async () => {
  const trigger = {
    comment: 'display trigger',
    type: 'display',
    conditions: [],
    effect: [],
    lowLevelAccess: true,
  }
  setDatabaseLite({
    characters: [{
      type: 'character',
      chaId: 'character-a',
      triggerscript: [trigger],
    }],
  } as never)
  const updates: unknown[] = []
  const unsubscribe = onDatabaseUpdate((update) => updates.push(update))
  moduleMocks.withTriggerLowLevelAccess.mockClear()

  try {
    const liveCharacter = trackedDatabaseState.db.characters[0]
    if (liveCharacter.type === 'group') {
      throw new Error('Expected a character fixture')
    }
    await runLuaEditTrigger(liveCharacter as never, 'editdisplay', 'visible text')

    expect(updates).toEqual([])
    expect(liveCharacter.triggerscript[0].lowLevelAccess).toBe(true)
    expect(moduleMocks.withTriggerLowLevelAccess).toHaveBeenCalledWith(
      liveCharacter.triggerscript[0],
      false,
    )
  }
  finally {
    unsubscribe()
  }
})

test('does not stop generation when setStateChanged is a no-op', async () => {
  const result = await runScripted(
    `
      function onStart(id)
        return setStateChanged(id, "unchanged", "value")
      end
    `,
    {
      char: {} as never,
      chat: { message: [] } as never,
      setVar: () => false,
      getVar: () => 'null',
      mode: 'start',
    }
  )

  expect(result.stopSending).toBe(false)
  expect(result.res).toBeNull()
})

test('keeps explicit false as the generation stop signal', async () => {
  const result = await runScripted('function onStart() return false end', {
    char: {} as never,
    chat: { message: [] } as never,
    mode: 'start',
  })

  expect(result.res).toBe(false)
  expect(result.stopSending).toBe(true)
})
