export type ChatMarkupInteraction =
    | {
        action: 'manual-trigger'
        manualName: string
        triggerId?: string
    }
    | {
        action: 'lua-button'
        data: string
    }

export type ChatMarkupInteractionTarget = {
    characterId: string
    chatId: string
}

export type ChatMarkupDelegationRequest = ChatMarkupInteractionTarget & ChatMarkupInteraction

type AttributeReader = {
    getAttribute(name: string): string | null
}

/** Resolve one actionable control from rendered community HTML.
 *
 * Group chats do not have a character trigger list, so a `risu-trigger`
 * control must remain unavailable there. Enabled module Lua scripts do expose
 * `onButtonClick` for groups, however, and their `risu-btn` payload is safe to
 * route through the same canonical resident command used by characters.
 */
export function resolveChatMarkupInteraction(
    characterType: 'character' | 'group',
    origin: AttributeReader,
): ChatMarkupInteraction | null {
    const manualName = origin.getAttribute('risu-trigger')
    const triggerId = origin.getAttribute('risu-id')
    const buttonData = origin.getAttribute('risu-btn')

    if (manualName) {
        if (characterType === 'group') {
            return null
        }
        return {
            action: 'manual-trigger',
            manualName,
            triggerId: triggerId || undefined,
        }
    }
    if (buttonData) {
        return {
            action: 'lua-button',
            data: buttonData,
        }
    }
    return null
}

export async function delegateChatMarkupInteraction(
    interaction: ChatMarkupInteraction | null,
    target: ChatMarkupInteractionTarget,
    delegate: (request: ChatMarkupDelegationRequest) => Promise<unknown | null>,
) {
    if (!interaction) {
        return false
    }
    return await delegate({
        ...target,
        ...interaction,
    }) !== null
}
