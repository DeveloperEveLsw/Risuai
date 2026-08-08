import type { RuntimeExecutorLease } from './generationClient'

export interface ActiveRuntimeExecutionFence extends RuntimeExecutorLease {
    commandId: string
}

let activeFence: ActiveRuntimeExecutionFence | null = null

export function setActiveRuntimeExecutionFence(commandId: string, lease: RuntimeExecutorLease) {
    activeFence = Object.freeze({ commandId, ...lease })
    return activeFence
}

export function getActiveRuntimeExecutionFence(): ActiveRuntimeExecutionFence | null {
    return activeFence ? { ...activeFence } : null
}

export function clearActiveRuntimeExecutionFence(commandId: string, fencingToken: number) {
    if (activeFence?.commandId === commandId && activeFence.fencingToken === fencingToken) {
        activeFence = null
    }
}
