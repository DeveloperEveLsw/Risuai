import {
    getCharacterByIndex as getCharacterByIndexFromDatabase,
    getCurrentCharacter as getCurrentCharacterFromDatabase,
    getCurrentCharacterIndex as getCurrentCharacterIndexFromDatabase,
    getCurrentChat as getCurrentChatFromDatabase,
    getDatabase as getDatabaseFromStorage,
    setCharacterByIndex as setCharacterByIndexFromDatabase,
    setCurrentCharacter as setCurrentCharacterFromDatabase,
    setCurrentChat as setCurrentChatFromDatabase,
    setDatabase as setDatabaseFromStorage,
    type Chat,
    type Database,
    type character,
    type groupChat,
} from "../storage/database.svelte"

export interface RequestRuntimeDatabaseOptions {
    snapshot?: boolean
}

export interface RequestRuntimeContext {
    getDatabase(options?: RequestRuntimeDatabaseOptions): Database
    setDatabase(data: Database): void
    getSelectedCharacterIndex(): number
    getCharacterByIndex(index: number, options?: RequestRuntimeDatabaseOptions): character | groupChat
    setCharacterByIndex(index: number, char: character | groupChat): void
    getCurrentCharacter(options?: RequestRuntimeDatabaseOptions): character | groupChat
    setCurrentCharacter(char: character | groupChat): void
    getCurrentChat(): Chat
    setCurrentChat(chat: Chat): void
}

function createDefaultRequestRuntimeContext(): RequestRuntimeContext {
    return {
        getDatabase(options = {}) {
            return getDatabaseFromStorage(options)
        },
        setDatabase(data) {
            setDatabaseFromStorage(data)
        },
        getSelectedCharacterIndex() {
            return getCurrentCharacterIndexFromDatabase()
        },
        getCharacterByIndex(index, options = {}) {
            return getCharacterByIndexFromDatabase(index, options)
        },
        setCharacterByIndex(index, char) {
            setCharacterByIndexFromDatabase(index, char)
        },
        getCurrentCharacter(options = {}) {
            return getCurrentCharacterFromDatabase(options)
        },
        setCurrentCharacter(char) {
            setCurrentCharacterFromDatabase(char)
        },
        getCurrentChat() {
            return getCurrentChatFromDatabase()
        },
        setCurrentChat(chat) {
            setCurrentChatFromDatabase(chat)
        },
    }
}

const defaultRequestRuntimeContext = createDefaultRequestRuntimeContext()
let activeRequestRuntimeContext = defaultRequestRuntimeContext

export function getRequestRuntimeContext() {
    return activeRequestRuntimeContext
}

export function setRequestRuntimeContext(context: RequestRuntimeContext) {
    activeRequestRuntimeContext = context
}

export function resetRequestRuntimeContext() {
    activeRequestRuntimeContext = defaultRequestRuntimeContext
}

export async function runWithRequestRuntimeContext<T>(context: RequestRuntimeContext, runner: () => Promise<T>) {
    const previousContext = activeRequestRuntimeContext
    activeRequestRuntimeContext = context
    try {
        return await runner()
    }
    finally {
        activeRequestRuntimeContext = previousContext
    }
}
