import { describe, expect, it } from 'vitest'
import { shouldShowChatTtsControl } from './chatTtsControl'

describe('shouldShowChatTtsControl', () => {
    it('stays hidden while mobile navigation has cleared the selected character', () => {
        expect(shouldShowChatTtsControl(undefined)).toBe(false)
        expect(shouldShowChatTtsControl(null)).toBe(false)
    })

    it('only shows TTS for a selected non-group character with an enabled mode', () => {
        expect(shouldShowChatTtsControl({ type: 'character', ttsMode: 'webspeech' })).toBe(true)
        expect(shouldShowChatTtsControl({ ttsMode: 'openai' })).toBe(true)
        expect(shouldShowChatTtsControl({ type: 'group', ttsMode: 'webspeech' })).toBe(false)
        expect(shouldShowChatTtsControl({ type: 'character', ttsMode: 'none' })).toBe(false)
        expect(shouldShowChatTtsControl({ type: 'character', ttsMode: '' })).toBe(false)
    })
})
