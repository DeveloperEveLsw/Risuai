import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    emitRuntimeStreamingOutput,
    installRuntimeStreamingOutputPublisher,
    type RuntimeStreamingOutputSnapshot,
} from './runtimeStreamingOutput.svelte'

function snapshot(data = 'processed output'): RuntimeStreamingOutputSnapshot {
    return {
        messageId: 'message-1',
        messageIndex: 2,
        data,
        createdAt: 123,
        generationInfo: {
            generationId: 'generation-1',
            stageTiming: { stage1: 10 },
        },
        optimizationMode: 'balanced',
    }
}

describe('runtime streaming output boundary', () => {
    beforeEach(() => {
        // A test that fails before restoring must not leak its command scope.
        const restore = installRuntimeStreamingOutputPublisher(() => {})
        restore()
    })

    it('is a no-op without a resident publisher in direct mode', () => {
        expect(() => emitRuntimeStreamingOutput(snapshot())).not.toThrow()
    })

    it('publishes an immutable processed snapshot', () => {
        const publisher = vi.fn()
        const source = snapshot()
        const restore = installRuntimeStreamingOutputPublisher(publisher)
        try {
            emitRuntimeStreamingOutput(source)
            source.generationInfo!.stageTiming!.stage1 = 99

            expect(publisher).toHaveBeenCalledOnce()
            expect(publisher).toHaveBeenCalledWith({
                ...snapshot(),
                generationInfo: {
                    generationId: 'generation-1',
                    stageTiming: { stage1: 10 },
                },
            })
        }
        finally {
            restore()
        }
    })

    it('publishes a nonempty-to-empty transition so followers clear stale text', () => {
        const publisher = vi.fn()
        const restore = installRuntimeStreamingOutputPublisher(publisher)
        try {
            emitRuntimeStreamingOutput(snapshot('text that must be cleared'))
            emitRuntimeStreamingOutput(snapshot(''))

            expect(publisher.mock.calls.map(([value]) => value.data)).toEqual([
                'text that must be cleared',
                '',
            ])
        }
        finally {
            restore()
        }
    })

    it('restores the previous command-scoped publisher', () => {
        const outer = vi.fn()
        const inner = vi.fn()
        const restoreOuter = installRuntimeStreamingOutputPublisher(outer)
        const restoreInner = installRuntimeStreamingOutputPublisher(inner)
        try {
            emitRuntimeStreamingOutput(snapshot('inner'))
            restoreInner()
            emitRuntimeStreamingOutput(snapshot('outer'))

            expect(inner).toHaveBeenCalledWith(expect.objectContaining({ data: 'inner' }))
            expect(outer).toHaveBeenCalledWith(expect.objectContaining({ data: 'outer' }))
        }
        finally {
            restoreInner()
            restoreOuter()
        }
    })

    it('does not resurrect a stale outer scope restored out of order', () => {
        const outer = vi.fn()
        const inner = vi.fn()
        const restoreOuter = installRuntimeStreamingOutputPublisher(outer)
        const restoreInner = installRuntimeStreamingOutputPublisher(inner)

        restoreOuter()
        emitRuntimeStreamingOutput(snapshot('inner remains active'))
        restoreInner()
        emitRuntimeStreamingOutput(snapshot('no resurrected outer'))

        expect(inner).toHaveBeenCalledOnce()
        expect(outer).not.toHaveBeenCalled()
    })
})
