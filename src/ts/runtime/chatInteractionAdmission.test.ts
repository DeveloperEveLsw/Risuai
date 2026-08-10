import { describe, expect, it, vi } from 'vitest'
import { admitRuntimeChatInteraction } from './chatInteractionAdmission'

describe('runtime chat interaction admission', () => {
    it.each([
        { generationActive: true, runtimeGenerationActive: false },
        { generationActive: false, runtimeGenerationActive: true },
        { generationActive: true, runtimeGenerationActive: true },
    ])('does not invoke a delegated manual/Lua operation while busy', (activity) => {
        const operation = vi.fn(() => 'queued')

        expect(admitRuntimeChatInteraction({
            delegated: true,
            ...activity,
        }, operation)).toEqual({ blocked: true })
        expect(operation).not.toHaveBeenCalled()
    })

    it('invokes an idle delegated interaction exactly once', async () => {
        const operation = vi.fn(async () => 'completed')
        const admitted = admitRuntimeChatInteraction({
            delegated: true,
            generationActive: false,
            runtimeGenerationActive: false,
        }, operation)

        expect(admitted.blocked).toBe(false)
        if ('result' in admitted) {
            await expect(admitted.result).resolves.toBe('completed')
        }
        expect(operation).toHaveBeenCalledOnce()
    })

    it('preserves the upstream local trigger path', () => {
        const operation = vi.fn(() => 'local trigger result')

        expect(admitRuntimeChatInteraction({
            delegated: false,
            generationActive: true,
            runtimeGenerationActive: true,
        }, operation)).toEqual({
            blocked: false,
            result: 'local trigger result',
        })
        expect(operation).toHaveBeenCalledOnce()
    })
})
