import { describe, expect, it } from 'vitest'
import { beginChatMarkupPending } from './chatMarkupPending'

describe('community HTML pending feedback', () => {
    it('responds synchronously, prevents repeated admission and restores attributes on failure', () => {
        const button = document.createElement('button')
        button.setAttribute('aria-busy', 'false')
        button.setAttribute('aria-pressed', 'false')
        const finish = beginChatMarkupPending(button)!
        expect(button.getAttribute('aria-busy')).toBe('true')
        expect(beginChatMarkupPending(button)).toBeNull()
        finish() // the same cleanup runs for a failed callback
        expect(button.getAttribute('aria-busy')).toBe('false')
        expect(button.getAttribute('aria-pressed')).toBe('false')
        expect(button.hasAttribute('data-risu-interaction-pending')).toBe(false)
    })

    it('does not invent selection or overwrite native radio state', () => {
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.checked = true
        const finish = beginChatMarkupPending(radio)!
        finish()
        expect(radio.checked).toBe(true)
        expect(radio.hasAttribute('aria-busy')).toBe(false)
    })
})
