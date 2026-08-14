// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import {
    delegateChatMarkupInteraction,
    resolveChatMarkupInteraction,
} from './chatMarkupInteraction'

function control(attributes: Record<string, string>) {
    return {
        getAttribute(name: string) {
            return attributes[name] ?? null
        },
    }
}

describe('community chat markup interactions', () => {
    it('delegates one group Lua button operation to the canonical target exactly once', async () => {
        const delegate = vi.fn(async () => ({ commandId: 'command-1' }))
        const interaction = resolveChatMarkupInteraction('group', control({
            'risu-btn': 'module-button-payload',
        }))

        await expect(delegateChatMarkupInteraction(interaction, {
            characterId: 'group-1',
            chatId: 'chat-1',
        }, delegate)).resolves.toBe(true)
        expect(delegate).toHaveBeenCalledOnce()
        expect(delegate).toHaveBeenCalledWith({
            action: 'lua-button',
            characterId: 'group-1',
            chatId: 'chat-1',
            data: 'module-button-payload',
        })
    })

    it('keeps manual trigger controls unavailable in groups', async () => {
        const delegate = vi.fn(async () => ({ commandId: 'unexpected' }))
        const interaction = resolveChatMarkupInteraction('group', control({
            'risu-trigger': 'manual-module-trigger',
            'risu-id': 'button-1',
        }))

        expect(interaction).toBeNull()
        await expect(delegateChatMarkupInteraction(interaction, {
            characterId: 'group-1',
            chatId: 'chat-1',
        }, delegate)).resolves.toBe(false)
        expect(delegate).not.toHaveBeenCalled()
    })

    it('preserves character manual-trigger identity', () => {
        expect(resolveChatMarkupInteraction('character', control({
            'risu-trigger': 'manual-character-trigger',
            'risu-id': 'button-2',
        }))).toEqual({
            action: 'manual-trigger',
            manualName: 'manual-character-trigger',
            triggerId: 'button-2',
        })
    })
})
