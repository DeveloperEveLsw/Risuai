import { type character, type groupChat } from 'src/ts/storage/database.svelte'
import { getRequestRuntimeContext } from '../../runtimeContext'

function getDatabase(options: Parameters<ReturnType<typeof getRequestRuntimeContext>["getDatabase"]>[0] = {}) {
  return getRequestRuntimeContext().getDatabase(options)
}

function getCurrentCharacter(options: Parameters<ReturnType<typeof getRequestRuntimeContext>["getCurrentCharacter"]>[0] = {}) {
  return getRequestRuntimeContext().getCurrentCharacter(options)
}

export function getCharacter(id: string): character | groupChat {
  return id ? getDatabase().characters.find((c) => c.chaId === id || c.name === id) : getCurrentCharacter()
}
