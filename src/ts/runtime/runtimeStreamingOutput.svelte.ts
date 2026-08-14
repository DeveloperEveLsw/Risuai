import type {
    MessageGenerationInfo,
    StreamingDisplayOptimizationMode,
} from '../storage/database.svelte'

/**
 * A processed, cumulative view of the assistant message currently being
 * generated. The process pipeline deliberately emits this only after its
 * edit-output hooks have updated the canonical message.
 */
export interface RuntimeStreamingOutputSnapshot {
    messageId: string
    messageIndex: number
    data: string
    createdAt: number
    generationInfo?: MessageGenerationInfo
    optimizationMode: StreamingDisplayOptimizationMode
}

export type RuntimeStreamingOutputPublisher = (
    snapshot: RuntimeStreamingOutputSnapshot,
) => void

interface RuntimeStreamingOutputPublisherScope {
    publisher: RuntimeStreamingOutputPublisher
    previous: RuntimeStreamingOutputPublisherScope | null
    restored: boolean
}

let activePublisherScope: RuntimeStreamingOutputPublisherScope | null = null

function copyGenerationInfo(generationInfo: MessageGenerationInfo | undefined) {
    if (!generationInfo) {
        return undefined
    }
    return {
        ...generationInfo,
        stageTiming: generationInfo.stageTiming
            ? { ...generationInfo.stageTiming }
            : undefined,
    }
}

/**
 * Installs a publisher for the duration of one resident command. Restoring a
 * nested publisher reveals the previous scope, while a stale restore cannot
 * clobber a newer command scope.
 */
export function installRuntimeStreamingOutputPublisher(
    publisher: RuntimeStreamingOutputPublisher,
) {
    const scope: RuntimeStreamingOutputPublisherScope = {
        publisher,
        previous: activePublisherScope,
        restored: false,
    }
    activePublisherScope = scope
    return () => {
        if (scope.restored) {
            return
        }
        scope.restored = true
        if (activePublisherScope !== scope) {
            return
        }
        let previous = scope.previous
        while (previous?.restored) {
            previous = previous.previous
        }
        activePublisherScope = previous
    }
}

/**
 * Non-blocking boundary used by the original process pipeline. In ordinary
 * local/direct mode no publisher is installed, so this is intentionally a
 * no-op. The resident publisher owns transport errors and exposes them from
 * its terminal flush rather than throwing into edit-output processing here.
 */
export function emitRuntimeStreamingOutput(
    snapshot: RuntimeStreamingOutputSnapshot,
) {
    const publisher = activePublisherScope?.publisher
    if (!publisher) {
        return
    }
    publisher({
        ...snapshot,
        generationInfo: copyGenerationInfo(snapshot.generationInfo),
    })
}
