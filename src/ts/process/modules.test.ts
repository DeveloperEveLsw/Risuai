// @vitest-environment node

import { expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
    database: {
        modules: [] as Array<Record<string, unknown>>,
        enabledModules: [] as string[],
    },
    alertClear: vi.fn(),
    alertWait: vi.fn(),
    saveAsset: vi.fn(async (_data: Uint8Array, _customId = '', extension = '') => (
        `assets/imported.${extension || 'png'}`
    )),
}))

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({
    alertClear: fixture.alertClear,
    alertWait: fixture.alertWait,
}))
vi.mock('../storage/database.svelte', () => ({
    getCurrentCharacter: vi.fn(() => null),
    getCurrentChat: vi.fn(() => null),
    getDatabase: vi.fn(() => fixture.database),
}))
vi.mock('../globalApi.svelte', () => ({ saveAsset: fixture.saveAsset }))
vi.mock('../util', () => ({
    checkPersonaBinded: vi.fn(() => null),
    sleep: vi.fn(async () => {}),
}))
vi.mock('./lorebook.svelte', () => ({}))
vi.mock('../media', () => ({}))
vi.mock('../rpack/rpack_js', () => ({
    decodeRPack: vi.fn(async (data: Uint8Array) => data),
}))
vi.mock('../stores.svelte', () => ({}))
vi.mock('../interchangeability', () => ({}))
vi.mock('../characterCards', () => ({}))

import { getModuleTriggers, readModule, withTriggerLowLevelAccess } from './modules'

function uint32(value: number) {
    const result = Buffer.alloc(4)
    result.writeUInt32LE(value)
    return result
}

test.each([true, false, undefined])(
    'copies effective module low-level permission %s without changing definitions',
    (modulePermission) => {
    const trigger = {
        comment: 'module trigger',
        type: 'manual' as const,
        conditions: [],
        effect: [],
        lowLevelAccess: modulePermission !== true,
    }
    fixture.database.modules = [{
        id: `module-${String(modulePermission)}`,
        name: 'Module A',
        description: '',
        lowLevelAccess: modulePermission,
        trigger: [trigger],
    }]
    fixture.database.enabledModules = [`module-${String(modulePermission)}`]

    const [effective] = getModuleTriggers()

    expect(effective).not.toBe(trigger)
    expect(effective.lowLevelAccess).toBe(modulePermission)
    expect(trigger.lowLevelAccess).toBe(modulePermission !== true)

    const characterEffective = withTriggerLowLevelAccess(trigger, false)
    expect(characterEffective).not.toBe(trigger)
    expect(characterEffective.lowLevelAccess).toBe(false)
    expect(trigger.lowLevelAccess).toBe(modulePermission !== true)
    },
)

test('legacy module import stores new assets with their metadata extensions', async () => {
    fixture.saveAsset.mockClear()
    fixture.alertClear.mockClear()
    const mainData = Buffer.from(JSON.stringify({
        type: 'risuModule',
        module: {
            id: 'legacy-module',
            name: 'Legacy media module',
            description: '',
            assets: [
                ['sound', '', 'wav'],
                ['clip', '', 'mp4'],
            ],
        },
    }))
    const wavData = Buffer.from('RIFF0000WAVE')
    const mp4Data = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
    const moduleBuffer = Buffer.concat([
        Buffer.from([111, 0]),
        uint32(mainData.length),
        mainData,
        Buffer.from([1]),
        uint32(wavData.length),
        wavData,
        Buffer.from([1]),
        uint32(mp4Data.length),
        mp4Data,
        Buffer.from([0]),
    ])

    const imported = await readModule(moduleBuffer)

    expect(fixture.saveAsset).toHaveBeenCalledTimes(2)
    expect(fixture.saveAsset.mock.calls.map((call) => call.slice(1))).toEqual([
        ['', 'wav'],
        ['', 'mp4'],
    ])
    expect(imported.assets).toEqual([
        ['sound', 'assets/imported.wav', 'wav'],
        ['clip', 'assets/imported.mp4', 'mp4'],
    ])
    expect(fixture.alertClear).toHaveBeenCalledOnce()
})
