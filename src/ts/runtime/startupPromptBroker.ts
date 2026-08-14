import {
    dismissRuntimeAlertPrompt,
    installRuntimeAlertBridge,
    presentRuntimeAlertNotice,
    presentRuntimeAlertPrompt,
    type alertData,
} from '../alert'
import { isNodeServer, isServerResidentExecutor } from '../platform'
import {
    RuntimeStartupClient,
    type RuntimeStartupPhase,
    type RuntimeStartupPublicNotice,
    type RuntimeStartupPublicPrompt,
    type RuntimeStartupSession,
} from './startupPromptClient'

const STARTUP_PRODUCER_SESSION_KEY = 'risu-runtime-startup-producer-id'
const STARTUP_HEARTBEAT_MS = 4_000
const STARTUP_PROMPT_SCOPE = 'runtime-startup'

type ProducerPhase = Exclude<RuntimeStartupPhase,
    'waiting_for_ui' | 'claim_ready' | 'unavailable'>

export interface ResidentRuntimeStartupBrokerHandle {
    readonly session: RuntimeStartupSession
    setPhase(phase: ProducerPhase): Promise<void>
    stop(): void
}

export interface ResidentRuntimeStartupBrokerOptions {
    client?: RuntimeStartupClient
    producerId?: string
    requestId?: string
    heartbeatMs?: number
    onError?: (error: Error) => void
}

export interface RuntimeStartupFollowerOptions {
    client?: RuntimeStartupClient
    clientId?: string
    onError?: (error: Error) => void
}

let activeResidentBroker: ResidentRuntimeStartupBrokerHandle | null = null
let stopActiveFollower: (() => void) | null = null

function reportRuntimeStartupError(
    error: unknown,
    handler?: (error: Error) => void,
) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    handler?.(normalized)
    console.error('[Runtime Startup UI]', normalized)
}

function residentProducerId() {
    const existing = sessionStorage.getItem(STARTUP_PRODUCER_SESSION_KEY)
    if (existing) {
        return existing
    }
    const created = `startup-${crypto.randomUUID()}`
    sessionStorage.setItem(STARTUP_PRODUCER_SESSION_KEY, created)
    return created
}

function isStaleStartupSessionError(error: unknown) {
    if (!error || typeof error !== 'object') {
        return false
    }
    const candidate = error as {
        status?: unknown
        body?: { code?: unknown }
    }
    return candidate.status === 409
        && candidate.body?.code === 'STALE_STARTUP_SESSION'
}

export async function startResidentRuntimeStartupBroker(
    options: ResidentRuntimeStartupBrokerOptions = {},
): Promise<ResidentRuntimeStartupBrokerHandle | null> {
    if (!isServerResidentExecutor) {
        return null
    }
    if (activeResidentBroker) {
        return activeResidentBroker
    }

    const client = options.client ?? new RuntimeStartupClient()
    const producerId = options.producerId ?? residentProducerId()
    // Reuse one create request ID for the lifetime of this browser boot. The
    // server remembers it while the current process is alive, so an obsolete
    // resident cannot reclaim a session that another resident fenced. A Node
    // server restart loses that in-memory tombstone and can safely recreate the
    // same producer session without restarting Chromium.
    const sessionRequestId = options.requestId ?? crypto.randomUUID()
    let currentSession = await client.beginSession(producerId, sessionRequestId)
    const heartbeatMs = options.heartbeatMs ?? STARTUP_HEARTBEAT_MS
    let phase: ProducerPhase = 'loading_data'
    let stopped = false
    let heartbeatRequested = false
    let heartbeatInFlight: Promise<void> | null = null
    let recoveryInFlight: Promise<RuntimeStartupSession> | null = null

    const recoverSession = (staleSession: RuntimeStartupSession) => {
        if (currentSession !== staleSession) {
            return Promise.resolve(currentSession)
        }
        if (recoveryInFlight) {
            return recoveryInFlight
        }
        const recovery = client.beginSession(producerId, sessionRequestId)
            .then((nextSession) => {
                if (currentSession === staleSession) {
                    currentSession = nextSession
                }
                return currentSession
            })
            .finally(() => {
                if (recoveryInFlight === recovery) {
                    recoveryInFlight = null
                }
            })
        recoveryInFlight = recovery
        return recovery
    }

    const withCurrentSession = async <T>(
        operation: (session: RuntimeStartupSession) => Promise<T>,
    ): Promise<T> => {
        while (true) {
            const usedSession = currentSession
            try {
                return await operation(usedSession)
            }
            catch (error) {
                if (!isStaleStartupSessionError(error)) {
                    throw error
                }
                const recoveredSession = await recoverSession(usedSession)
                if (recoveredSession === usedSession) {
                    throw error
                }
            }
        }
    }

    const heartbeat = () => {
        if (stopped) {
            return Promise.resolve()
        }
        heartbeatRequested = true
        if (heartbeatInFlight) {
            return heartbeatInFlight
        }
        const request = (async () => {
            while (!stopped && heartbeatRequested) {
                heartbeatRequested = false
                const sentPhase = phase
                try {
                    await withCurrentSession(async (session) => (
                        await client.heartbeat(session, sentPhase)
                    ))
                }
                catch (error) {
                    reportRuntimeStartupError(error, options.onError)
                }
                if (phase !== sentPhase) {
                    heartbeatRequested = true
                }
            }
        })().finally(() => {
            if (heartbeatInFlight === request) {
                heartbeatInFlight = null
            }
        })
        heartbeatInFlight = request
        return request
    }

    const uninstallAlertBridge = installRuntimeAlertBridge({
        prompt: async (prompt: alertData) => await withCurrentSession(
            async (session) => await client.prompt(
                session,
                prompt,
                { kind: 'runtime_alert' },
            ),
        ),
        notice: async (notice: alertData) => {
            await withCurrentSession(
                async (session) => await client.notice(
                    session,
                    notice,
                    { kind: 'runtime_notice' },
                ),
            )
        },
    })
    const heartbeatTimer = setInterval(() => void heartbeat(), heartbeatMs)
    void heartbeat()

    const handle: ResidentRuntimeStartupBrokerHandle = {
        get session() {
            return currentSession
        },
        async setPhase(nextPhase) {
            phase = nextPhase
            await heartbeat()
        },
        stop() {
            if (stopped) {
                return
            }
            stopped = true
            clearInterval(heartbeatTimer)
            uninstallAlertBridge()
            if (activeResidentBroker === handle) {
                activeResidentBroker = null
            }
        },
    }
    activeResidentBroker = handle
    return handle
}

function presentStartupPrompt(
    client: RuntimeStartupClient,
    publicPrompt: RuntimeStartupPublicPrompt,
    activePromptIds: Set<string>,
    onError?: (error: Error) => void,
) {
    if (activePromptIds.has(publicPrompt.promptId)) {
        return
    }
    activePromptIds.add(publicPrompt.promptId)
    void presentRuntimeAlertPrompt({
        commandId: STARTUP_PROMPT_SCOPE,
        promptId: publicPrompt.promptId,
        prompt: publicPrompt.prompt,
    }).then(async (response) => {
        if (response === null) {
            return
        }
        await client.respond(publicPrompt.promptId, response)
    }).catch((error) => {
        reportRuntimeStartupError(error, onError)
    }).finally(() => {
        // Clear the direct prompt record even when another observer won or the
        // prompt expired while this device was submitting its answer.
        dismissRuntimeAlertPrompt(publicPrompt.promptId)
        activePromptIds.delete(publicPrompt.promptId)
    })
}

function presentStartupNotice(
    notice: RuntimeStartupPublicNotice,
    seenNoticeIds: Set<string>,
) {
    if (seenNoticeIds.has(notice.noticeId)) {
        return
    }
    seenNoticeIds.add(notice.noticeId)
    void presentRuntimeAlertNotice(notice.notice)
}

export function startRuntimeStartupFollower(
    options: RuntimeStartupFollowerOptions = {},
) {
    if (!isNodeServer || isServerResidentExecutor) {
        return null
    }
    if (stopActiveFollower) {
        return stopActiveFollower
    }

    const client = options.client ?? new RuntimeStartupClient()
    const clientId = options.clientId ?? `startup-observer-${crypto.randomUUID()}`
    const activePromptIds = new Set<string>()
    const seenNoticeIds = new Set<string>()
    const reconcileSnapshot = (
        prompts: RuntimeStartupPublicPrompt[],
        notices: RuntimeStartupPublicNotice[],
    ) => {
        const currentIds = new Set(prompts.map((prompt) => prompt.promptId))
        for (const promptId of activePromptIds) {
            if (!currentIds.has(promptId)) {
                dismissRuntimeAlertPrompt(promptId)
            }
        }
        for (const prompt of prompts) {
            presentStartupPrompt(client, prompt, activePromptIds, options.onError)
        }
        for (const notice of notices) {
            presentStartupNotice(notice, seenNoticeIds)
        }
    }

    const stopWatching = client.watch(clientId, {
        onSnapshot: (snapshot) => reconcileSnapshot(snapshot.prompts, snapshot.notices),
        onEvent: (event) => {
            if (event.eventType === 'prompt_created' && event.prompt) {
                presentStartupPrompt(client, event.prompt, activePromptIds, options.onError)
                return
            }
            if (event.eventType === 'prompt_settled' && event.promptId) {
                dismissRuntimeAlertPrompt(event.promptId)
                activePromptIds.delete(event.promptId)
                return
            }
            if (event.eventType === 'notice_created' && event.notice) {
                presentStartupNotice(event.notice, seenNoticeIds)
                return
            }
            if (event.eventType === 'session_expired') {
                for (const promptId of activePromptIds) {
                    dismissRuntimeAlertPrompt(promptId)
                }
                activePromptIds.clear()
            }
        },
        onError: (error) => reportRuntimeStartupError(error, options.onError),
    })

    const stop = () => {
        stopWatching()
        for (const promptId of activePromptIds) {
            dismissRuntimeAlertPrompt(promptId)
        }
        activePromptIds.clear()
        seenNoticeIds.clear()
        if (stopActiveFollower === stop) {
            stopActiveFollower = null
        }
    }
    stopActiveFollower = stop
    return stop
}
