export interface CharacterOrderIdentity {
    chaId: string
    trashTime?: number
}

export interface CharacterOrderFolder {
    data: string[]
}

type CharacterOrderEntry = string | CharacterOrderFolder | null | undefined

/**
 * Reconciles the persisted character order without changing the existing
 * in-place mutation contract used by Svelte's database proxy.
 */
export function reconcileCharacterOrderInPlace(
    characters: readonly CharacterOrderIdentity[],
    characterOrder: CharacterOrderEntry[],
) {
    const ordered = new Set<string>()
    for (const entry of characterOrder) {
        if (typeof entry === 'string') {
            ordered.add(entry)
        }
        else if (entry) {
            for (const characterId of entry.data) {
                ordered.add(characterId)
            }
        }
    }

    const activeCharacterIds = new Set<string>()
    for (const character of characters) {
        const characterId = character.chaId
        if (!character.trashTime) {
            activeCharacterIds.add(characterId)
        }
        if (
            !ordered.has(characterId)
            && characterId !== '§temp'
            && characterId !== '§playground'
            && !character.trashTime
        ) {
            characterOrder.push(characterId)
            ordered.add(characterId)
        }
    }

    for (let index = 0; index < characterOrder.length; index += 1) {
        const entry = characterOrder[index]
        if (typeof entry !== 'string') {
            if (!entry || entry.data.length === 0) {
                characterOrder.splice(index, 1)
                index -= 1
                continue
            }
            for (let childIndex = 0; childIndex < entry.data.length; childIndex += 1) {
                if (!activeCharacterIds.has(entry.data[childIndex])) {
                    entry.data.splice(childIndex, 1)
                    childIndex -= 1
                }
            }
            characterOrder[index] = entry
        }
        else if (!activeCharacterIds.has(entry)) {
            characterOrder.splice(index, 1)
            index -= 1
        }
    }
}
