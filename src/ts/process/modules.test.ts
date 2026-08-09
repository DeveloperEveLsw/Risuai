// @vitest-environment node

import { expect, test, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
    database: {
        modules: [] as Array<Record<string, unknown>>,
        enabledModules: [] as string[],
    },
}))

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({}))
vi.mock('../storage/database.svelte', () => ({
    getCurrentCharacter: vi.fn(() => null),
    getCurrentChat: vi.fn(() => null),
    getDatabase: vi.fn(() => fixture.database),
}))
vi.mock('../globalApi.svelte', () => ({}))
vi.mock('../util', () => ({
    checkPersonaBinded: vi.fn(() => null),
}))
vi.mock('./lorebook.svelte', () => ({}))
vi.mock('../media', () => ({}))
vi.mock('../rpack/rpack_js', () => ({}))
vi.mock('../stores.svelte', () => ({}))
vi.mock('../interchangeability', () => ({}))
vi.mock('../characterCards', () => ({}))

import { getModuleTriggers, withTriggerLowLevelAccess } from './modules'

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
