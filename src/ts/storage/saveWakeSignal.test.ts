import { describe, expect, it } from 'vitest'
import { SaveWakeSignal } from './saveWakeSignal'

describe('save worker wake signal', () => {
    it('retains a save requested before waiting and coalesces multiple requests', async () => {
        const signal = new SaveWakeSignal()
        signal.notify()
        signal.notify()
        await signal.wait()
        let resumed = false
        const waiting = signal.wait().then(() => {
            resumed = true
        })
        await Promise.resolve()
        expect(resumed).toBe(false)
        signal.notify()
        await waiting
        expect(resumed).toBe(true)
    })

    it('wakes the sleeping worker without polling', async () => {
        const signal = new SaveWakeSignal()
        let resumed = false
        const waiting = signal.wait().then(() => {
            resumed = true
        })
        expect(resumed).toBe(false)
        signal.notify()
        await waiting
        expect(resumed).toBe(true)
    })
})
