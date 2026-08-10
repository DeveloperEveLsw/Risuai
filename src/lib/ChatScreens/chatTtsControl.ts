export interface ChatTtsCharacter {
    type?: string
    ttsMode?: string
}

export function shouldShowChatTtsControl(character: ChatTtsCharacter | null | undefined): boolean {
    return Boolean(
        character
        && character.type !== 'group'
        && character.ttsMode
        && character.ttsMode !== 'none'
    )
}
