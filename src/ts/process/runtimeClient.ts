import { get } from "svelte/store"
import { v4 } from "uuid"
import { chatProcessStage, sendChat } from "./index.svelte"
import { getRequestRuntimeContext } from "./runtimeContext"
import { traceRuntimeEvent } from "./runtimeTrace"
import type {
    RequestRuntimeAbortedEvent,
    RequestRuntimeCommand,
    RequestRuntimeCompleteEvent,
    RequestRuntimeEvent,
    RequestRuntimeFailEvent,
    RequestRuntimeSelection,
    RequestRuntimeStage,
    RequestRuntimeStageEvent,
    RequestRuntimeStartArgs,
    RequestRuntimeStartCommand,
    RequestRuntimeStateSnapshot,
} from "./runtimeProtocol"

type RuntimeRequestListener = (event: RequestRuntimeEvent, state: RequestRuntimeStateSnapshot) => void

export interface ActiveRuntimeRequest {
    requestId: string
    signal: AbortSignal
    promise: Promise<RequestRuntimeStateSnapshot>
}

const requestStates = new Map<string, RequestRuntimeStateSnapshot>()
const requestAbortControllers = new Map<string, AbortController>()
const requestListeners = new Map<string, Set<RuntimeRequestListener>>()

function getSelection(chatProcessIndex: number): RequestRuntimeSelection {
    const runtimeContext = getRequestRuntimeContext()
    const selectedCharacterIndex = runtimeContext.getSelectedCharacterIndex()
    const currentCharacter = runtimeContext.getCharacterByIndex(selectedCharacterIndex)
    const selectedChatIndex = currentCharacter.chatPage
    const currentChat = currentCharacter.chats[selectedChatIndex]

    return {
        selectedCharacterIndex,
        selectedChatIndex,
        chatProcessIndex,
        characterId: currentCharacter.chaId,
        chatId: currentChat?.id,
    }
}

function getStageLabel(stage: RequestRuntimeStage) {
    switch (stage) {
        case 0:
            return "init"
        case 1:
            return "prompt_assembly"
        case 2:
            return "memory"
        case 3:
            return "request"
        case 4:
            return "postprocess"
    }
}

function getRequestChat(selection: RequestRuntimeSelection) {
    const db = getRequestRuntimeContext().getDatabase()
    return db.characters?.[selection.selectedCharacterIndex]?.chats?.[selection.selectedChatIndex]
}

function emitRuntimeEvent(event: RequestRuntimeEvent) {
    const state = requestStates.get(event.requestId)
    if (!state) {
        return
    }

    for (const listener of requestListeners.get(event.requestId) ?? []) {
        listener(event, state)
    }
}

function setRuntimeState(requestId: string, state: RequestRuntimeStateSnapshot) {
    requestStates.set(requestId, state)
}

function updateRuntimeState(requestId: string, patch: Partial<RequestRuntimeStateSnapshot>) {
    const previous = requestStates.get(requestId)
    if (!previous) {
        return
    }
    requestStates.set(requestId, {
        ...previous,
        ...patch,
    })
}

function finalizeRuntimeRequest(requestId: string) {
    requestAbortControllers.delete(requestId)
}

export function createRuntimeStartCommand(args: RequestRuntimeStartArgs, chatProcessIndex = -1): RequestRuntimeStartCommand {
    return {
        type: "start",
        requestId: v4(),
        args,
        snapshot: {
            database: getRequestRuntimeContext().getDatabase({ snapshot: true }),
            selection: getSelection(chatProcessIndex),
            requestedAt: Date.now(),
        },
    }
}

export function startRuntimeRequest(command: RequestRuntimeStartCommand): ActiveRuntimeRequest {
    const abortController = new AbortController()
    requestAbortControllers.set(command.requestId, abortController)

    const initialState: RequestRuntimeStateSnapshot = {
        requestId: command.requestId,
        status: "queued",
        stage: 0,
        selection: command.snapshot.selection,
        streamChunkCount: 0,
    }
    setRuntimeState(command.requestId, initialState)
    traceRuntimeEvent('runtimeClient.start', {
        requestId: command.requestId,
        selection: command.snapshot.selection,
        args: command.args,
    })

    const promise = (async () => {
        let lastStage = get(chatProcessStage) as RequestRuntimeStage
        const unsubscribeStage = chatProcessStage.subscribe((stage) => {
            const nextStage = stage as RequestRuntimeStage
            if (nextStage === lastStage && requestStates.get(command.requestId)?.status !== "queued") {
                return
            }
            lastStage = nextStage
            updateRuntimeState(command.requestId, {
                status: nextStage >= 3 ? "streaming" : "running",
                stage: nextStage,
            })
            const event: RequestRuntimeStageEvent = {
                type: "stage",
                requestId: command.requestId,
                stage: nextStage,
                label: getStageLabel(nextStage),
                at: Date.now(),
            }
            emitRuntimeEvent(event)
            traceRuntimeEvent('runtimeClient.stage', {
                requestId: command.requestId,
                stage: nextStage,
                label: event.label,
            })
        })

        try {
            updateRuntimeState(command.requestId, {
                status: "running",
                stage: lastStage,
            })
            const ok = await sendChat(command.snapshot.selection.chatProcessIndex, {
                ...command.args,
                signal: abortController.signal,
            })

            if (abortController.signal.aborted) {
                updateRuntimeState(command.requestId, {
                    status: "aborted",
                })
                const event: RequestRuntimeAbortedEvent = {
                    type: "aborted",
                    requestId: command.requestId,
                    at: Date.now(),
                }
                emitRuntimeEvent(event)
                traceRuntimeEvent('runtimeClient.aborted', {
                    requestId: command.requestId,
                })
                return requestStates.get(command.requestId)!
            }

            if (!ok) {
                updateRuntimeState(command.requestId, {
                    status: "failed",
                    error: "sendChat returned false",
                })
                const event: RequestRuntimeFailEvent = {
                    type: "fail",
                    requestId: command.requestId,
                    error: "sendChat returned false",
                    at: Date.now(),
                }
                emitRuntimeEvent(event)
                traceRuntimeEvent('runtimeClient.fail', {
                    requestId: command.requestId,
                    error: event.error,
                })
                return requestStates.get(command.requestId)!
            }

            const chat = getRequestChat(command.snapshot.selection)
            const generationInfo = chat?.message?.at(-1)?.generationInfo
            updateRuntimeState(command.requestId, {
                status: "completed",
                generationId: generationInfo?.generationId,
            })
            if (chat) {
                const event: RequestRuntimeCompleteEvent = {
                    type: "complete",
                    requestId: command.requestId,
                    generationId: generationInfo?.generationId,
                    chat,
                    generationInfo,
                    at: Date.now(),
                }
                emitRuntimeEvent(event)
                traceRuntimeEvent('runtimeClient.complete', {
                    requestId: command.requestId,
                    generationId: generationInfo?.generationId ?? null,
                })
            }
            return requestStates.get(command.requestId)!
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (abortController.signal.aborted) {
                updateRuntimeState(command.requestId, {
                    status: "aborted",
                })
                const event: RequestRuntimeAbortedEvent = {
                    type: "aborted",
                    requestId: command.requestId,
                    at: Date.now(),
                }
                emitRuntimeEvent(event)
                traceRuntimeEvent('runtimeClient.aborted', {
                    requestId: command.requestId,
                })
                return requestStates.get(command.requestId)!
            }

            updateRuntimeState(command.requestId, {
                status: "failed",
                error: message,
            })
            const event: RequestRuntimeFailEvent = {
                type: "fail",
                requestId: command.requestId,
                error: message,
                at: Date.now(),
            }
            emitRuntimeEvent(event)
            traceRuntimeEvent('runtimeClient.fail', {
                requestId: command.requestId,
                error: message,
            })
            return requestStates.get(command.requestId)!
        }
        finally {
            unsubscribeStage()
            finalizeRuntimeRequest(command.requestId)
        }
    })()

    return {
        requestId: command.requestId,
        signal: abortController.signal,
        promise,
    }
}

export function abortRuntimeRequest(requestId: string) {
    traceRuntimeEvent('runtimeClient.abort_requested', {
        requestId,
        hasController: requestAbortControllers.has(requestId),
    })
    requestAbortControllers.get(requestId)?.abort()
}

export function subscribeRuntimeRequest(command: Extract<RequestRuntimeCommand, { type: "subscribe" }>, listener: RuntimeRequestListener) {
    const listeners = requestListeners.get(command.requestId) ?? new Set<RuntimeRequestListener>()
    listeners.add(listener)
    requestListeners.set(command.requestId, listeners)

    if (command.replayBufferedEvents) {
        const state = requestStates.get(command.requestId)
        if (state) {
            listener({
                type: "stage",
                requestId: command.requestId,
                stage: state.stage,
                label: getStageLabel(state.stage),
                at: Date.now(),
            }, state)
        }
    }

    return () => {
        const current = requestListeners.get(command.requestId)
        if (!current) {
            return
        }
        current.delete(listener)
        if (current.size === 0) {
            requestListeners.delete(command.requestId)
        }
    }
}

export function getRuntimeRequestState(requestId: string) {
    return requestStates.get(requestId) ?? null
}
