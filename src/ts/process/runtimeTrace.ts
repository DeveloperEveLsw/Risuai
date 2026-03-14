export type RuntimeTraceStatus = 'ok' | 'error' | 'aborted'

export interface RuntimeTraceScope {
    scopeId: string
    rootScopeId: string
    parentScopeId: string | null
    label: string
    depth: number
    startedAtMs: number
    startedAtUnixMs: number
    closed: boolean
}

export interface RuntimeTraceEntry {
    entryId: string
    kind: 'scope_start' | 'scope_end' | 'event'
    label: string
    scopeId: string | null
    rootScopeId: string | null
    parentScopeId: string | null
    depth: number
    status?: RuntimeTraceStatus
    timestampMs: number
    timestampIso: string
    monotonicMs: number
    durationMs?: number
    data?: Record<string, unknown>
}

const MAX_RUNTIME_TRACE_ENTRIES = 2500

let runtimeTraceSequence = 0
let runtimeTraceEntries: RuntimeTraceEntry[] = []
let runtimeTraceStack: RuntimeTraceScope[] = []

function monotonicNow() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now()
    }
    return Date.now()
}

function nextRuntimeTraceId(prefix: string) {
    runtimeTraceSequence += 1
    return `${prefix}_${Date.now().toString(36)}_${runtimeTraceSequence.toString(36)}`
}

function sanitizeTraceValue(value: unknown): unknown {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
        }
    }
    if (typeof value === 'bigint') {
        return value.toString()
    }
    if (Array.isArray(value)) {
        return value.map(sanitizeTraceValue)
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).map(([key, innerValue]) => {
            return [key, sanitizeTraceValue(innerValue)]
        })
        return Object.fromEntries(entries)
    }
    return value
}

function sanitizeTraceData(data?: Record<string, unknown>) {
    if (!data) {
        return undefined
    }
    const entries = Object.entries(data).map(([key, value]) => {
        return [key, sanitizeTraceValue(value)]
    })
    return Object.fromEntries(entries)
}

function getRuntimeTraceDebugEnabled() {
    return Boolean((globalThis as Record<string, unknown>).__RISU_REQUEST_TRACE_DEBUG__)
}

function recordRuntimeTraceEntry(entry: RuntimeTraceEntry) {
    runtimeTraceEntries.push(entry)
    if (runtimeTraceEntries.length > MAX_RUNTIME_TRACE_ENTRIES) {
        runtimeTraceEntries.splice(0, runtimeTraceEntries.length - MAX_RUNTIME_TRACE_ENTRIES)
    }

    if (getRuntimeTraceDebugEnabled()) {
        console.debug('[RisuTrace]', entry.kind, entry.label, entry.data ?? {})
    }
}

function removeRuntimeTraceScope(scope: RuntimeTraceScope) {
    for (let i = runtimeTraceStack.length - 1; i >= 0; i--) {
        if (runtimeTraceStack[i].scopeId === scope.scopeId) {
            runtimeTraceStack.splice(i, 1)
            return
        }
    }
}

function isAbortLikeError(error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
        return true
    }
    if (error instanceof Error && error.name === 'AbortError') {
        return true
    }
    if (typeof error === 'string' && error.toLowerCase().includes('abort')) {
        return true
    }
    return false
}

export function getCurrentRuntimeTraceScope() {
    return runtimeTraceStack.at(-1) ?? null
}

export function startRuntimeTraceScope(
    label: string,
    data?: Record<string, unknown>,
    arg: {
        parentScope?: RuntimeTraceScope | null
        pushToStack?: boolean
    } = {}
) {
    const parentScope = arg.parentScope === undefined ? getCurrentRuntimeTraceScope() : arg.parentScope
    const scopeId = nextRuntimeTraceId('scope')
    const startedAtMs = monotonicNow()
    const startedAtUnixMs = Date.now()
    const scope: RuntimeTraceScope = {
        scopeId,
        rootScopeId: parentScope?.rootScopeId ?? scopeId,
        parentScopeId: parentScope?.scopeId ?? null,
        label,
        depth: (parentScope?.depth ?? -1) + 1,
        startedAtMs,
        startedAtUnixMs,
        closed: false,
    }

    if (arg.pushToStack !== false) {
        runtimeTraceStack.push(scope)
    }

    recordRuntimeTraceEntry({
        entryId: nextRuntimeTraceId('entry'),
        kind: 'scope_start',
        label,
        scopeId: scope.scopeId,
        rootScopeId: scope.rootScopeId,
        parentScopeId: scope.parentScopeId,
        depth: scope.depth,
        timestampMs: startedAtUnixMs,
        timestampIso: new Date(startedAtUnixMs).toISOString(),
        monotonicMs: startedAtMs,
        data: sanitizeTraceData(data),
    })

    return scope
}

export function finishRuntimeTraceScope(
    scope: RuntimeTraceScope | null | undefined,
    status: RuntimeTraceStatus = 'ok',
    data?: Record<string, unknown>
) {
    if (!scope || scope.closed) {
        return
    }

    scope.closed = true
    removeRuntimeTraceScope(scope)

    const finishedAtMs = monotonicNow()
    const finishedAtUnixMs = Date.now()
    recordRuntimeTraceEntry({
        entryId: nextRuntimeTraceId('entry'),
        kind: 'scope_end',
        label: scope.label,
        scopeId: scope.scopeId,
        rootScopeId: scope.rootScopeId,
        parentScopeId: scope.parentScopeId,
        depth: scope.depth,
        status,
        timestampMs: finishedAtUnixMs,
        timestampIso: new Date(finishedAtUnixMs).toISOString(),
        monotonicMs: finishedAtMs,
        durationMs: finishedAtMs - scope.startedAtMs,
        data: sanitizeTraceData(data),
    })
}

export function traceRuntimeEvent(
    label: string,
    data?: Record<string, unknown>,
    scope: RuntimeTraceScope | null = getCurrentRuntimeTraceScope()
) {
    const timestampMs = Date.now()
    recordRuntimeTraceEntry({
        entryId: nextRuntimeTraceId('entry'),
        kind: 'event',
        label,
        scopeId: scope?.scopeId ?? null,
        rootScopeId: scope?.rootScopeId ?? null,
        parentScopeId: scope?.parentScopeId ?? null,
        depth: scope?.depth ?? 0,
        timestampMs,
        timestampIso: new Date(timestampMs).toISOString(),
        monotonicMs: monotonicNow(),
        data: sanitizeTraceData(data),
    })
}

export async function runWithRuntimeTraceScope<T>(
    label: string,
    data: Record<string, unknown> | undefined,
    runner: (scope: RuntimeTraceScope) => Promise<T>,
    arg: {
        parentScope?: RuntimeTraceScope | null
    } = {}
) {
    const scope = startRuntimeTraceScope(label, data, arg)
    try {
        const result = await runner(scope)
        finishRuntimeTraceScope(scope, 'ok')
        return result
    }
    catch (error) {
        finishRuntimeTraceScope(scope, isAbortLikeError(error) ? 'aborted' : 'error', {
            error,
        })
        throw error
    }
}

export function bindAbortTrace(
    abortSignal: AbortSignal | null | undefined,
    label: string,
    data?: Record<string, unknown> | (() => Record<string, unknown>)
) {
    if (!abortSignal) {
        return () => {}
    }

    const getData = () => {
        if (typeof data === 'function') {
            return data()
        }
        return data
    }

    const onAbort = () => {
        traceRuntimeEvent(label, {
            ...getData(),
            reason: abortSignal.reason ? `${abortSignal.reason}` : undefined,
        })
    }

    if (abortSignal.aborted) {
        onAbort()
        return () => {}
    }

    abortSignal.addEventListener('abort', onAbort, { once: true })
    return () => {
        abortSignal.removeEventListener('abort', onAbort)
    }
}

export function getRuntimeTraceEntries() {
    return runtimeTraceEntries.map((entry) => {
        return {
            ...entry,
            data: entry.data ? { ...entry.data } : undefined,
        }
    })
}

export function clearRuntimeTraceEntries() {
    runtimeTraceEntries = []
    runtimeTraceStack = []
}

export function getRuntimeTraceLog() {
    return runtimeTraceEntries.map((entry) => {
        const prefix = `[${entry.timestampIso}] ${entry.kind.toUpperCase()} ${entry.label}`
        const scope = entry.scopeId ? ` scope=${entry.scopeId}` : ''
        const status = entry.status ? ` status=${entry.status}` : ''
        const duration = typeof entry.durationMs === 'number' ? ` durationMs=${entry.durationMs.toFixed(2)}` : ''
        const data = entry.data ? ` data=${JSON.stringify(entry.data)}` : ''
        return `${prefix}${scope}${status}${duration}${data}`
    }).join('\n')
}
