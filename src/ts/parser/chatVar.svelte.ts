import { parseKeyValue } from '../util'
import { getRequestRuntimeContext } from '../process/runtimeContext'

function getDatabase(options: Parameters<ReturnType<typeof getRequestRuntimeContext>["getDatabase"]>[0] = {}) {
    return getRequestRuntimeContext().getDatabase(options)
}

function getCurrentCharacter(options: Parameters<ReturnType<typeof getRequestRuntimeContext>["getCurrentCharacter"]>[0] = {}) {
    return getRequestRuntimeContext().getCurrentCharacter(options)
}

function getCurrentChat() {
    return getRequestRuntimeContext().getCurrentChat()
}

function setCurrentChat(chat: Parameters<ReturnType<typeof getRequestRuntimeContext>["setCurrentChat"]>[0]) {
    return getRequestRuntimeContext().setCurrentChat(chat)
}

export function getChatVar(key:string): string {
    const db = getDatabase()
    const char = getCurrentCharacter()
    if(!char){
        return 'null'
    }
    const chat = getCurrentChat()
    if(!chat.scriptstate){
        chat.scriptstate = {}
        setCurrentChat(chat)
    }
    const state = (chat.scriptstate['$' + key])
    if(state === undefined || state === null){
        const defaultVariables = parseKeyValue(char.defaultVariables).concat(parseKeyValue(db.templateDefaultVariables))
        const findResult = defaultVariables.find((f) => {
            return f[0] === key
        })
        if(findResult){
            return findResult[1]
        }
        return 'null'
    }
    return state.toString()
}

export function setChatVar(key:string, value:string): void {
    const chat = getCurrentChat()
    if(!chat.scriptstate){
        chat.scriptstate = {}
    }
    chat.scriptstate['$' + key] = value
    setCurrentChat(chat)
}

export function getGlobalChatVar(key:string): string {
    return getDatabase().globalChatVariables[key] ?? 'null'
}
