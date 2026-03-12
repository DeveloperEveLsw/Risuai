import type { Chat, Message, character, customscript } from "../storage/database.svelte";

export type ServerProviderType = 'openai-compatible' | 'anthropic' | 'google';

export type PreparedServerProviderRequest = {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: Record<string, any>
    stream?: boolean
}

export type ResolvedServerProvider = {
    type: ServerProviderType
    request: {
        url: string
        method: string
        headers: Record<string, string>
        body: Record<string, any>
        stream: boolean
    }
    streamOptions?: {
        streamGeminiThoughts?: boolean
    }
}

type PolicyState = {
    currentChar: Pick<character, 'customscript' | 'triggerscript'>
    presetRegex?: Array<customscript | { type?: string | null } | null>
    pluginState: {
        hasProviderPlugin: boolean
        hasEditOutputPlugin: boolean
        hasAfterRequestPlugin: boolean
    }
    preparedRequest?: PreparedServerProviderRequest | null
}

export type ServerGenerationCompatibilityReport = {
    executionOwner: 'builtin-http' | 'plugin-executor' | 'unknown'
    hasRequestMutators: boolean
    hasDisplayMutators: boolean
    hasResponseMutators: boolean
    blockers: string[]
}

export type ServerSafePresetEditOutputRegex = Pick<customscript, 'comment' | 'in' | 'out' | 'flag' | 'ableFlag'> & {
    type: 'editoutput'
}

function cloneValue<T>(value: T): T {
    if (value == null) {
        return value
    }
    if (typeof structuredClone === 'function') {
        return structuredClone(value)
    }
    return JSON.parse(JSON.stringify(value))
}

function normalizeHeaders(headers: Record<string, string> = {}) {
    const normalized: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
        normalized[key.toLowerCase()] = value
    }
    return normalized
}

export function inferPreparedRequestStream(request: PreparedServerProviderRequest | null | undefined) {
    if (!request) {
        return false
    }

    if (request.stream === true) {
        return true
    }

    const url = request.url?.toLowerCase() ?? ''
    if (url.includes('alt=sse') || url.includes(':streamgeneratecontent')) {
        return true
    }

    if (request.body?.stream === true) {
        return true
    }

    return false
}

function normalizeRequest(request: PreparedServerProviderRequest): ResolvedServerProvider['request'] {
    return {
        url: request.url,
        method: request.method ?? 'POST',
        headers: cloneValue(request.headers ?? {}),
        body: cloneValue(request.body ?? {}),
        stream: inferPreparedRequestStream(request),
    }
}

function valuesEqual(left: unknown, right: unknown) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function pickMergedValue<T>(serverValue: T, localValue: T, baseValue?: T) {
    if (baseValue === undefined) {
        return cloneValue(localValue ?? serverValue)
    }

    const serverChanged = !valuesEqual(serverValue, baseValue)
    const localChanged = !valuesEqual(localValue, baseValue)

    if (!serverChanged) {
        return cloneValue(localValue)
    }

    if (!localChanged) {
        return cloneValue(serverValue)
    }

    return cloneValue(localValue)
}

function mergeUniqueArray<T>(serverValue: T[] = [], localValue: T[] = [], baseValue?: T[]) {
    if (baseValue === undefined) {
        return cloneValue(localValue.length > 0 ? localValue : serverValue)
    }

    const serverChanged = !valuesEqual(serverValue, baseValue)
    const localChanged = !valuesEqual(localValue, baseValue)

    if (!serverChanged) {
        return cloneValue(localValue)
    }

    if (!localChanged) {
        return cloneValue(serverValue)
    }

    const merged: T[] = []
    const seen = new Set<string>()
    for (const value of [...serverValue, ...localValue]) {
        const key = JSON.stringify(value ?? null)
        if (seen.has(key)) {
            continue
        }
        seen.add(key)
        merged.push(cloneValue(value))
    }
    return merged
}

function mergeNamedMap(
    serverValue: Record<string, string> = {},
    localValue: Record<string, string> = {},
    baseValue?: Record<string, string>
) {
    if (baseValue === undefined) {
        return {
            ...cloneValue(serverValue),
            ...cloneValue(localValue),
        }
    }

    const next: Record<string, string> = {}
    const keys = new Set([
        ...Object.keys(serverValue ?? {}),
        ...Object.keys(localValue ?? {}),
        ...Object.keys(baseValue ?? {}),
    ])

    for (const key of keys) {
        const mergedValue = pickMergedValue(serverValue?.[key], localValue?.[key], baseValue?.[key])
        if (mergedValue != null) {
            next[key] = mergedValue
        }
    }

    return next
}

function messageIdentity(message: Message, index: number) {
    if (message?.chatId) {
        return `chat:${message.chatId}`
    }
    return `fallback:${message?.role ?? 'unknown'}:${message?.time ?? 'none'}:${message?.saying ?? 'none'}:${message?.data ?? ''}:${index}`
}

function chooseMessageData(existing: Message, incoming: Message) {
    const existingData = existing?.data ?? ''
    const incomingData = incoming?.data ?? ''
    if (incomingData === '' && existingData !== '') {
        return existingData
    }
    return incomingData || existingData || ''
}

function mergeMessage(existing: Message, incoming: Message) {
    const merged = {
        ...cloneValue((existing ?? {}) as Message),
        ...cloneValue((incoming ?? {}) as Message),
    } as Message

    merged.data = chooseMessageData(existing, incoming)

    if (existing?.generationInfo || incoming?.generationInfo) {
        merged.generationInfo = {
            ...(existing?.generationInfo ?? {}),
            ...(incoming?.generationInfo ?? {}),
        }
    }

    if (existing?.promptInfo || incoming?.promptInfo) {
        merged.promptInfo = {
            ...(existing?.promptInfo ?? {}),
            ...(incoming?.promptInfo ?? {}),
        }
    }

    return merged
}

function mergeMessageArrays(baseMessages: Message[] = [], incomingMessages: Message[] = []) {
    const merged = cloneValue(baseMessages)
    const keyToIndex = new Map<string, number>()

    for (let index = 0; index < merged.length; index++) {
        keyToIndex.set(messageIdentity(merged[index], index), index)
    }

    for (let index = 0; index < incomingMessages.length; index++) {
        const incoming = cloneValue(incomingMessages[index])
        const key = messageIdentity(incoming, index)
        const existingIndex = keyToIndex.get(key)
        if (existingIndex == null) {
            keyToIndex.set(key, merged.length)
            merged.push(incoming)
            continue
        }

        merged[existingIndex] = mergeMessage(merged[existingIndex], incoming)
    }

    return merged
}

function emptyChat(): Chat {
    return {
        message: [],
        note: '',
        name: '',
        localLore: [],
    }
}

export function mergeChatsForLivePatch(serverChat: Chat | null | undefined, localChat: Chat, baseChat?: Chat | null) {
    const currentServerChat = cloneValue(serverChat ?? emptyChat())
    const nextChat = {
        ...currentServerChat,
        ...cloneValue(localChat),
    } as Chat
    const originalBaseChat = cloneValue(baseChat ?? emptyChat())

    nextChat.message = mergeMessageArrays(currentServerChat.message, localChat.message ?? [])
    nextChat.note = pickMergedValue(currentServerChat.note ?? '', localChat.note ?? '', originalBaseChat.note ?? '')
    nextChat.name = pickMergedValue(currentServerChat.name ?? '', localChat.name ?? '', originalBaseChat.name ?? '')
    nextChat.localLore = mergeUniqueArray(currentServerChat.localLore ?? [], localChat.localLore ?? [], originalBaseChat.localLore ?? [])
    nextChat.bookmarks = mergeUniqueArray(currentServerChat.bookmarks ?? [], localChat.bookmarks ?? [], originalBaseChat.bookmarks ?? [])
    nextChat.bookmarkNames = mergeNamedMap(
        currentServerChat.bookmarkNames ?? {},
        localChat.bookmarkNames ?? {},
        originalBaseChat.bookmarkNames ?? {}
    )

    if ((currentServerChat.isStreaming || localChat.isStreaming) && nextChat.isStreaming !== false) {
        nextChat.isStreaming = true
    }

    return nextChat
}

export function buildGenerationSubmitChat(serverChat: Chat | null | undefined, localChat: Chat, userMessage: Message | null, assistantMessage: Message) {
    const mergedChat = mergeChatsForLivePatch(serverChat, localChat)

    if (userMessage) {
        mergedChat.message = mergeMessageArrays(mergedChat.message, [userMessage])
    }

    mergedChat.message = mergeMessageArrays(mergedChat.message, [assistantMessage])
    mergedChat.isStreaming = true

    return mergedChat
}

export function inferServerGenerationProvider(request: PreparedServerProviderRequest | null | undefined): ResolvedServerProvider | null {
    if (!request?.url) {
        return null
    }

    const normalizedHeaders = normalizeHeaders(request.headers ?? {})
    const normalizedRequest = normalizeRequest(request)
    const url = normalizedRequest.url.toLowerCase()
    const body = normalizedRequest.body ?? {}

    if (normalizedHeaders['anthropic-version'] || body.anthropic_version) {
        return {
            type: 'anthropic',
            request: normalizedRequest,
        }
    }

    if (
        url.includes('generativelanguage.googleapis.com') ||
        url.includes('aiplatform.googleapis.com') ||
        Array.isArray(body.contents)
    ) {
        return {
            type: 'google',
            request: normalizedRequest,
        }
    }

    if (
        url.includes('/chat/completions') ||
        url.includes('/responses') ||
        url.endsWith('/completions') ||
        Array.isArray(body.messages) ||
        Array.isArray(body.input)
    ) {
        return {
            type: 'openai-compatible',
            request: normalizedRequest,
        }
    }

    return null
}

function hasPreparedToolUse(preparedRequest?: PreparedServerProviderRequest | null) {
    const body = preparedRequest?.body ?? {}
    if (Array.isArray(body.tools) && body.tools.length > 0) {
        return true
    }
    if (Array.isArray(body.messages) && body.messages.some((message) => message?.role === 'tool' || Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)) {
        return true
    }
    if (Array.isArray(body.input) && body.input.some((item) => item?.type === 'function_call_output')) {
        return true
    }
    if (Array.isArray(body.contents) && body.contents.some((item) => Array.isArray(item?.parts) && item.parts.some((part: any) => part?.functionCall || part?.functionResponse))) {
        return true
    }
    if (Array.isArray(body.tools?.functionDeclarations) && body.tools.functionDeclarations.length > 0) {
        return true
    }
    return false
}

function hasScriptType(scripts: Array<{ type?: string | null } | null | undefined>, type: string) {
    return scripts.some((script) => script?.type === type)
}

function hasFlagActions(script: Pick<customscript, 'flag' | 'ableFlag'>) {
    return !!(script.ableFlag && script.flag?.includes('<'))
}

function usesParserInterpolation(script: Pick<customscript, 'in' | 'out'>) {
    return script.in.includes('{{') || script.out.includes('{{')
}

export function isServerSafePresetEditOutputRegex(
    script: Pick<customscript, 'comment' | 'in' | 'out' | 'type' | 'flag' | 'ableFlag'> | null | undefined
): script is ServerSafePresetEditOutputRegex {
    if (!script || script.type !== 'editoutput') {
        return false
    }

    if (typeof script.in !== 'string' || typeof script.out !== 'string') {
        return false
    }

    if (hasFlagActions(script)) {
        return false
    }

    if (script.out.startsWith('@@')) {
        return false
    }

    if (usesParserInterpolation(script)) {
        return false
    }

    return true
}

export function extractServerSafePresetEditOutputRegex(
    scripts: Array<customscript | { type?: string | null } | null | undefined> = []
): ServerSafePresetEditOutputRegex[] {
    return scripts.filter((script): script is customscript => {
        return !!script && typeof script === 'object' && 'in' in script && 'out' in script
    }).filter(isServerSafePresetEditOutputRegex)
}

export function getServerGenerationCompatibilityReport(state: PolicyState): ServerGenerationCompatibilityReport {
    const executionOwner = state.pluginState.hasProviderPlugin
        ? 'plugin-executor'
        : inferServerGenerationProvider(state.preparedRequest ?? null)
            ? 'builtin-http'
            : 'unknown'

    const hasPresetEditProcess = hasScriptType(state.presetRegex ?? [], 'editprocess')
    const hasPresetEditDisplay = hasScriptType(state.presetRegex ?? [], 'editdisplay')
    const hasPresetEditOutput = hasScriptType(state.presetRegex ?? [], 'editoutput')
    const safePresetEditOutput = extractServerSafePresetEditOutputRegex((state.presetRegex ?? []) as customscript[])
    const hasUnsupportedPresetEditOutput = hasPresetEditOutput && safePresetEditOutput.length !== (state.presetRegex ?? []).filter((script) => script?.type === 'editoutput').length
    const hasCharacterEditOutput = hasScriptType(state.currentChar.customscript ?? [], 'editoutput')
    const hasOutputTriggers = hasScriptType(state.currentChar.triggerscript ?? [], 'output')
    const hasResponseMutators = (
        state.pluginState.hasEditOutputPlugin ||
        state.pluginState.hasAfterRequestPlugin ||
        hasCharacterEditOutput ||
        hasOutputTriggers ||
        hasUnsupportedPresetEditOutput
    )

    const blockers: string[] = []

    if (executionOwner === 'plugin-executor') {
        blockers.push('Server-owned generation does not support plugin providers yet.')
    }

    if (state.pluginState.hasEditOutputPlugin) {
        blockers.push('Server-owned generation is not compatible with output-editing plugins.')
    }

    if (state.pluginState.hasAfterRequestPlugin) {
        blockers.push('Server-owned generation is not compatible with response-rewriting plugins.')
    }

    if (hasCharacterEditOutput) {
        blockers.push('Server-owned generation is not compatible with editoutput scripts.')
    }

    if (hasOutputTriggers) {
        blockers.push('Server-owned generation is not compatible with output triggers.')
    }

    if (hasUnsupportedPresetEditOutput) {
        blockers.push('Server-owned generation is not compatible with preset editoutput regex.')
    }

    if (hasPreparedToolUse(state.preparedRequest)) {
        blockers.push('Server-owned generation does not support tool-calling requests yet.')
    }

    if (executionOwner === 'unknown') {
        blockers.push('Current provider path is not yet supported for server-owned generation.')
    }

    return {
        executionOwner,
        hasRequestMutators: hasPresetEditProcess,
        hasDisplayMutators: hasPresetEditDisplay,
        hasResponseMutators,
        blockers,
    }
}

export function getServerGenerationPolicyError(state: PolicyState) {
    return getServerGenerationCompatibilityReport(state).blockers[0] ?? null
}
