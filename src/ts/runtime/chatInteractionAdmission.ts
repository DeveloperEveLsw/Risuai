export interface RuntimeChatInteractionAdmissionState {
    delegated: boolean
    generationActive: boolean
    runtimeGenerationActive: boolean
}

export type RuntimeChatInteractionAdmission<TResult> =
    | { blocked: true }
    | { blocked: false; result: TResult }

/** Keeps upstream/local trigger behavior unchanged while preventing a direct
 * viewer from queueing a second canonical mutation against an active command. */
export function admitRuntimeChatInteraction<TResult>(
    state: RuntimeChatInteractionAdmissionState,
    operation: () => TResult,
): RuntimeChatInteractionAdmission<TResult> {
    if (
        state.delegated
        && (state.generationActive || state.runtimeGenerationActive)
    ) {
        return { blocked: true }
    }
    return { blocked: false, result: operation() }
}
