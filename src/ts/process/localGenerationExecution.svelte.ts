import { writable } from 'svelte/store'

const localExecutionState = writable(false)
let localExecutionDepth = 0

/** True only while this browser is executing the upstream prompt/provider
 * pipeline itself. Delegated server commands never acquire this lock. */
export const localGenerationExecutionActive = {
    subscribe: localExecutionState.subscribe,
}

export async function runWithLocalGenerationExecution<TResult>(
    operation: () => Promise<TResult>,
): Promise<TResult> {
    localExecutionDepth += 1
    if (localExecutionDepth === 1) {
        localExecutionState.set(true)
    }
    try {
        return await operation()
    }
    finally {
        localExecutionDepth -= 1
        if (localExecutionDepth === 0) {
            localExecutionState.set(false)
        }
    }
}

/** Runs the delegate first and acquires the local execution lock only when the
 * delegate explicitly returns null to request the upstream browser fallback. */
export async function runDelegatedOrLocalGeneration<TResult>(
    delegate: (() => Promise<TResult | null>) | null,
    localOperation: () => Promise<TResult>,
): Promise<TResult> {
    if (delegate) {
        const delegated = await delegate()
        if (delegated !== null) {
            return delegated
        }
    }
    return await runWithLocalGenerationExecution(localOperation)
}
