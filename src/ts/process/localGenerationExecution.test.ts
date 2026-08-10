import { get } from 'svelte/store'
import { describe, expect, it, vi } from 'vitest'
import {
    localGenerationExecutionActive,
    runDelegatedOrLocalGeneration,
    runWithLocalGenerationExecution,
} from './localGenerationExecution.svelte'

describe('local generation execution activity', () => {
    it('stays active until every nested local execution has settled', async () => {
        let releaseInner!: () => void
        const innerBarrier = new Promise<void>((resolve) => {
            releaseInner = resolve
        })

        const outer = runWithLocalGenerationExecution(async () => {
            expect(get(localGenerationExecutionActive)).toBe(true)
            const inner = runWithLocalGenerationExecution(async () => {
                expect(get(localGenerationExecutionActive)).toBe(true)
                await innerBarrier
            })
            expect(get(localGenerationExecutionActive)).toBe(true)
            releaseInner()
            await inner
            expect(get(localGenerationExecutionActive)).toBe(true)
        })

        expect(get(localGenerationExecutionActive)).toBe(true)
        await outer
        expect(get(localGenerationExecutionActive)).toBe(false)
    })

    it('always releases the local execution lock when the pipeline throws', async () => {
        await expect(runWithLocalGenerationExecution(async () => {
            expect(get(localGenerationExecutionActive)).toBe(true)
            throw new Error('local pipeline failed')
        })).rejects.toThrow('local pipeline failed')

        expect(get(localGenerationExecutionActive)).toBe(false)
    })

    it('does not acquire the local lock when a delegate handles the request', async () => {
        const localOperation = vi.fn(async () => false)
        const delegate = vi.fn(async () => {
            expect(get(localGenerationExecutionActive)).toBe(false)
            return true
        })

        await expect(runDelegatedOrLocalGeneration(delegate, localOperation)).resolves.toBe(true)
        expect(localOperation).not.toHaveBeenCalled()
        expect(get(localGenerationExecutionActive)).toBe(false)
    })

    it('acquires the local lock only after a delegate requests local fallback', async () => {
        const delegate = vi.fn(async () => {
            expect(get(localGenerationExecutionActive)).toBe(false)
            return null
        })
        const localOperation = vi.fn(async () => {
            expect(get(localGenerationExecutionActive)).toBe(true)
            return true
        })

        await expect(runDelegatedOrLocalGeneration(delegate, localOperation)).resolves.toBe(true)
        expect(localOperation).toHaveBeenCalledOnce()
        expect(get(localGenerationExecutionActive)).toBe(false)
    })
})
