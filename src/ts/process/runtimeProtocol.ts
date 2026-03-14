import type { Chat, Database, MessageGenerationInfo } from "../storage/database.svelte"

export type RequestRuntimeStage = 0 | 1 | 2 | 3 | 4
export type RequestRuntimeStatus = 'queued' | 'running' | 'streaming' | 'completed' | 'failed' | 'aborted'
export type RequestRuntimeCommandType = 'start' | 'abort' | 'subscribe' | 'resume'

export interface RequestRuntimeSelection {
    selectedCharacterIndex: number
    selectedChatIndex: number
    chatProcessIndex: number
    characterId?: string
    chatId?: string
}

export interface RequestRuntimeStartArgs {
    chatAdditonalTokens?: number
    continue?: boolean
    preview?: boolean
    previewPrompt?: boolean
}

export interface RequestRuntimeSnapshot {
    database: Database
    selection: RequestRuntimeSelection
    requestedAt: number
}

export interface RequestRuntimeStartCommand {
    type: 'start'
    requestId: string
    args: RequestRuntimeStartArgs
    snapshot: RequestRuntimeSnapshot
}

export interface RequestRuntimeAbortCommand {
    type: 'abort'
    requestId: string
}

export interface RequestRuntimeSubscribeCommand {
    type: 'subscribe'
    requestId: string
    replayBufferedEvents?: boolean
}

export interface RequestRuntimeResumeCommand {
    type: 'resume'
    requestId: string
    snapshot: RequestRuntimeSnapshot
}

export type RequestRuntimeCommand =
    | RequestRuntimeStartCommand
    | RequestRuntimeAbortCommand
    | RequestRuntimeSubscribeCommand
    | RequestRuntimeResumeCommand

export interface RequestRuntimeMultimodal {
    type: 'image' | 'video' | 'audio' | 'signature'
    base64: string
    height?: number
    width?: number
}

export interface RequestRuntimePromptMessage {
    role: 'system' | 'user' | 'assistant' | 'function'
    content: string
    memo?: string
    name?: string
    removable?: boolean
    attr?: string[]
    thoughts?: string[]
    cachePoint?: boolean
    multimodals?: RequestRuntimeMultimodal[]
}

export interface RequestRuntimeStateSnapshot {
    requestId: string
    status: RequestRuntimeStatus
    stage: RequestRuntimeStage
    selection: RequestRuntimeSelection
    generationId?: string
    streamChunkCount: number
    previewBody?: string
    error?: string
}

export interface RequestRuntimeStageEvent {
    type: 'stage'
    requestId: string
    stage: RequestRuntimeStage
    label: string
    at: number
}

export interface RequestRuntimePromptReadyEvent {
    type: 'prompt_ready'
    requestId: string
    generationId: string
    prompt: RequestRuntimePromptMessage[]
    generationInfo: MessageGenerationInfo
    at: number
}

export interface RequestRuntimePreviewBodyEvent {
    type: 'preview_body'
    requestId: string
    generationId: string
    previewBody: string
    at: number
}

export interface RequestRuntimeStreamEvent {
    type: 'stream'
    requestId: string
    generationId: string
    chunkIndex: number
    messageIndex: number
    text: string
    at: number
}

export interface RequestRuntimeChatEvent {
    type: 'chat_update'
    requestId: string
    chat: Chat
    at: number
}

export interface RequestRuntimeCompleteEvent {
    type: 'complete'
    requestId: string
    generationId?: string
    chat: Chat
    generationInfo?: MessageGenerationInfo
    at: number
}

export interface RequestRuntimeFailEvent {
    type: 'fail'
    requestId: string
    error: string
    at: number
}

export interface RequestRuntimeAbortedEvent {
    type: 'aborted'
    requestId: string
    at: number
}

export type RequestRuntimeEvent =
    | RequestRuntimeStageEvent
    | RequestRuntimePromptReadyEvent
    | RequestRuntimePreviewBodyEvent
    | RequestRuntimeStreamEvent
    | RequestRuntimeChatEvent
    | RequestRuntimeCompleteEvent
    | RequestRuntimeFailEvent
    | RequestRuntimeAbortedEvent
