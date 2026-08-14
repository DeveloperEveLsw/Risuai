type SelectedCharacterChangeListener = () => void

const selectedCharacterChangeListeners = new Set<SelectedCharacterChangeListener>()

export function onSelectedCharacterChanged(listener: SelectedCharacterChangeListener): () => void {
    selectedCharacterChangeListeners.add(listener)
    return () => selectedCharacterChangeListeners.delete(listener)
}

export function notifySelectedCharacterChanged(): void {
    for (const listener of selectedCharacterChangeListeners) {
        listener()
    }
}
