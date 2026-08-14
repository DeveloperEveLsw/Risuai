import { describe, expect, it, vi } from 'vitest'

vi.mock('../alert', () => ({ alertError: vi.fn() }))
vi.mock('../storage/database.svelte', () => ({
    getCurrentCharacter: vi.fn(),
    getDatabase: vi.fn(() => ({})),
}))
vi.mock('../translator/translator', () => ({
    runTranslator: vi.fn(),
    translateVox: vi.fn(),
}))
vi.mock('../globalApi.svelte', () => ({
    globalFetch: vi.fn(),
    loadAsset: vi.fn(),
}))
vi.mock('src/lang', () => ({ language: { errors: { httpError: '' } } }))
vi.mock('../util', () => ({ sleep: vi.fn() }))
vi.mock('./transformers', () => ({ runVITS: vi.fn() }))
vi.mock('./ttsHooks', () => ({
    getTTSPreprocessors: vi.fn(() => []),
    getTTSPostprocessors: vi.fn(() => []),
    runHookPipeline: vi.fn(),
}))

import { installRuntimeTTSBridge, sayTTS } from './tts'

describe('runtime TTS presentation bridge', () => {
    it('intercepts the common sayTTS boundary before hidden-browser playback or provider work', async () => {
        const bridge = vi.fn(async () => {})
        const restore = installRuntimeTTSBridge(bridge)
        const character = {
            type: 'character',
            chaId: 'character-1',
            ttsMode: 'webspeech',
        } as any

        await sayTTS(character, 'pipeline-resolved speech')

        expect(bridge).toHaveBeenCalledOnce()
        expect(bridge).toHaveBeenCalledWith({
            type: 'speak',
            characterId: 'character-1',
            text: 'pipeline-resolved speech',
        })
        restore()
    })
})
