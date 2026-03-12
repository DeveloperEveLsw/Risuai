import { get, writable } from "svelte/store";
import { DBState } from "../stores.svelte";
import { isNodeServer } from "../platform";
import { NodeStorage } from "../storage/nodeStorage";
import type { Chat, Database, Message } from "../storage/database.svelte";
import {
    buildGenerationSubmitChat,
    mergeChatsForLivePatch,
    type ServerProviderType,
    type ServerSafePresetEditOutputRegex,
} from "./serverGenerationShared";

export type ServerGenerationJob = {
    job_id: string
    session_key: string
    character_id?: string
    chat_document_key?: string
    assistant_message_chat_id?: string
    client_request_id?: string
    status: string
    request_payload?: any
    result_payload?: any
    error_text?: string | null
    cancel_requested_at?: string | null
    created_at?: string
    updated_at?: string
    started_at?: string | null
    finished_at?: string | null
}

type LiveEvent =
    | {
        type: 'ready' | 'heartbeat'
        [key: string]: any
    }
    | {
        type: 'chat_updated'
        chatKey: string
        revision: number
        payload: Chat
        metadata?: Record<string, any>
    }
    | {
        type: 'job_updated'
        sessionKey: string
        jobId: string
        status: string
        text?: string
        error?: string | null
        chatKey?: string
        sequenceNo?: number
        cancelRequested?: boolean
        model?: string | null
    }

const nodeStorage = new NodeStorage();
let subscriptionController: AbortController | null = null;
let subscriptionPromise: Promise<void> | null = null;
let cachedSupported: boolean | null = null;
let liveMirrorInterval: ReturnType<typeof setInterval> | null = null;
let liveMirrorInFlight = false;
let liveReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let liveSubscriptionStopped = false;
let lastMirroredRootPayload: Database | null = null;
const lastMirroredCharacterPayloads = new Map<string, any>();
const lastMirroredChatPayloads = new Map<string, Chat>();
const pendingChatDocuments = new Map<string, {
    payload: Chat
    revision?: number
    metadata?: Record<string, any>
}>();
const lastJobSequences = new Map<string, number>();

export const serverGenerationAvailable = writable(false);
export const activeServerJobs = writable<Record<string, ServerGenerationJob>>({});
export const liveRootRevision = writable<number | null>(null);
export const liveCharacterRevisions = writable<Record<string, number>>({});
export const liveChatRevisions = writable<Record<string, number>>({});
export const liveChatMetadata = writable<Record<string, Record<string, any>>>({});

function defaultSessionKey() {
    return 'database/database.bin';
}

function cloneValue<T>(value: T): T {
    if (value == null) {
        return value;
    }

    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}

function valuesEqual(left: unknown, right: unknown) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function hashPayload(value: unknown) {
    return JSON.stringify(value ?? {});
}

function toCharacterDocumentKey(characterId: string) {
    return `character:${characterId}`;
}

function getCharacterIdFromDocumentKey(documentKey: string) {
    if (!documentKey.startsWith('character:')) {
        return null;
    }
    return documentKey.slice('character:'.length);
}

function buildRootDocumentPayload(database: Database) {
    const payload = cloneValue(database);
    payload.characters = (database.characters ?? []).map((entry: any) => {
        if (!entry) {
            return entry;
        }

        const stripped = cloneValue(entry);
        stripped.chats = [];
        return stripped;
    });
    return payload;
}

function buildCharacterDocumentPayload(character: any) {
    const payload = cloneValue(character);
    payload.chats = [];
    return payload;
}

function resolveFieldValue<T>(serverValue: T, localValue: T, baseValue?: T) {
    if (baseValue === undefined) {
        return cloneValue(localValue ?? serverValue);
    }

    const serverChanged = !valuesEqual(serverValue, baseValue);
    const localChanged = !valuesEqual(localValue, baseValue);

    if (!serverChanged) {
        return cloneValue(localValue);
    }

    if (!localChanged) {
        return cloneValue(serverValue);
    }

    return cloneValue(localValue);
}

function mergePlainObjectWithBase(serverValue: Record<string, any>, localValue: Record<string, any>, baseValue?: Record<string, any> | null) {
    const keys = new Set([
        ...Object.keys(serverValue ?? {}),
        ...Object.keys(localValue ?? {}),
        ...Object.keys(baseValue ?? {}),
    ]);
    const merged: Record<string, any> = {};

    for (const key of keys) {
        merged[key] = resolveFieldValue(serverValue?.[key], localValue?.[key], baseValue?.[key]);
    }

    return merged;
}

async function getNodeAuthHeaders(extra: Record<string, string> = {}) {
    if (!isNodeServer) {
        return extra;
    }

    const auth = await nodeStorage.getAuthHeader();
    return {
        ...extra,
        'risu-auth': auth,
    };
}

async function fetchNodeJson(url: string, init: RequestInit = {}) {
    const headers = await getNodeAuthHeaders({
        ...(init.headers as Record<string, string> ?? {}),
    });

    const response = await fetch(url, {
        ...init,
        headers,
    });

    const text = await response.text();
    let data: any = null;
    try {
        data = text ? JSON.parse(text) : null;
    }
    catch (_error) {
        data = text;
    }

    return {
        ok: response.ok,
        status: response.status,
        data,
    };
}

function updateJobStore(job: ServerGenerationJob) {
    activeServerJobs.update((current) => {
        const next = { ...current };
        if (['completed', 'failed', 'cancelled'].includes(job.status)) {
            delete next[job.job_id];
            return next;
        }

        next[job.job_id] = job;
        return next;
    });

    if (job.chat_document_key) {
        const located = findChatIndicesByKey(job.chat_document_key);
        if (located) {
            DBState.db.characters[located.characterIndex].chats[located.chatIndex].isStreaming = ['queued', 'running'].includes(job.status);
        }
        liveChatMetadata.update((current) => {
            const previous = current[job.chat_document_key] ?? {};
            return {
                ...current,
                [job.chat_document_key]: {
                    ...previous,
                    activeJobId: ['queued', 'running'].includes(job.status) ? job.job_id : null,
                    lastJobId: job.job_id,
                    lastJobStatus: job.status,
                    lastJobError: job.error_text ?? null,
                },
            };
        });
    }
}

function removeCompletedJobs() {
    activeServerJobs.update((current) => {
        const next = { ...current };
        for (const [jobId, job] of Object.entries(next)) {
            if (['completed', 'failed', 'cancelled'].includes(job.status)) {
                delete next[jobId];
            }
        }
        return next;
    });
}

function findChatIndicesByKey(chatKey: string) {
    const parts = chatKey.split(':');
    if (parts.length !== 3 || parts[0] !== 'chat') {
        return null;
    }

    const characterId = parts[1];
    const chatId = parts[2];
    const characterIndex = DBState.db.characters?.findIndex((character) => character?.chaId === characterId) ?? -1;
    if (characterIndex === -1) {
        return null;
    }

    const chatIndex = DBState.db.characters[characterIndex]?.chats?.findIndex((chat) => chat?.id === chatId) ?? -1;
    if (chatIndex === -1) {
        return null;
    }

    return {
        characterIndex,
        chatIndex,
    };
}

function applyLiveRootDocument(payload: Database, revision?: number) {
    const currentCharacters = new Map(
        (DBState.db.characters ?? [])
            .filter((entry: any) => entry?.chaId)
            .map((entry: any) => [entry.chaId, entry])
    );
    const nextCharacters = (payload.characters ?? []).map((incoming: any) => {
        if (!incoming?.chaId) {
            return incoming;
        }

        const existing = currentCharacters.get(incoming.chaId);
        currentCharacters.delete(incoming.chaId);
        return {
            ...(existing ?? {}),
            ...cloneValue(incoming),
            chats: cloneValue(existing?.chats ?? []),
        };
    });

    for (const leftover of currentCharacters.values()) {
        nextCharacters.push(leftover);
    }

    Object.assign(DBState.db, cloneValue(payload));
    DBState.db.characters = nextCharacters as any;
    lastMirroredRootPayload = buildRootDocumentPayload(DBState.db);

    if (revision != null) {
        liveRootRevision.set(revision);
    }
}

function applyLiveCharacterDocument(characterKey: string, payload: any, revision?: number) {
    const characterId = getCharacterIdFromDocumentKey(characterKey);
    if (!characterId) {
        return;
    }

    const nextPayload = cloneValue(payload);
    const characterIndex = DBState.db.characters?.findIndex((entry: any) => entry?.chaId === characterId) ?? -1;
    if (characterIndex === -1) {
        DBState.db.characters.push({
            ...nextPayload,
            chaId: nextPayload.chaId ?? characterId,
            chats: [],
        });
    }
    else {
        const existing = DBState.db.characters[characterIndex];
        DBState.db.characters[characterIndex] = {
            ...existing,
            ...nextPayload,
            chats: cloneValue(existing?.chats ?? []),
        };
        DBState.db.characters[characterIndex].reloadKeys ??= 0;
        DBState.db.characters[characterIndex].reloadKeys += 1;
    }

    if (revision != null) {
        liveCharacterRevisions.update((current) => ({
            ...current,
            [characterKey]: revision,
        }));
    }
    const character = DBState.db.characters.find((entry: any) => entry?.chaId === characterId);
    if (character) {
        lastMirroredCharacterPayloads.set(characterKey, buildCharacterDocumentPayload(character));
    }
    flushPendingChatDocumentsForCharacter(characterId);
}

function applyLiveChatDocument(chatKey: string, payload: Chat, revision?: number, metadata?: Record<string, any>) {
    const parts = chatKey.split(':');
    if (parts.length !== 3 || parts[0] !== 'chat') {
        return;
    }

    const characterId = parts[1];
    const chatId = parts[2];
    const characterIndex = DBState.db.characters?.findIndex((character: any) => character?.chaId === characterId) ?? -1;
    if (characterIndex === -1) {
        pendingChatDocuments.set(chatKey, {
            payload: cloneValue(payload),
            revision,
            metadata,
        });
        if (revision != null) {
            liveChatRevisions.update((current) => ({ ...current, [chatKey]: revision }));
        }
        if (metadata) {
            liveChatMetadata.update((current) => ({ ...current, [chatKey]: metadata }));
        }
        return;
    }

    const character = DBState.db.characters[characterIndex];
    character.chats ??= [];
    const chatIndex = character.chats.findIndex((chat: Chat) => chat?.id === chatId);
    const nextChatPayload = {
        ...cloneValue(payload),
        id: payload?.id ?? chatId,
    } as Chat;

    if (chatIndex === -1) {
        character.chats.push(nextChatPayload);
    }
    else {
        character.chats[chatIndex] = nextChatPayload;
    }

    character.reloadKeys ??= 0;
    character.reloadKeys += 1;
    if (revision != null) {
        liveChatRevisions.update((current) => ({ ...current, [chatKey]: revision }));
    }
    if (metadata) {
        liveChatMetadata.update((current) => ({ ...current, [chatKey]: metadata }));
    }
    lastMirroredChatPayloads.set(chatKey, cloneValue(nextChatPayload));
    pendingChatDocuments.delete(chatKey);
}

function flushPendingChatDocumentsForCharacter(characterId: string) {
    for (const [chatKey, document] of pendingChatDocuments.entries()) {
        if (!chatKey.startsWith(`chat:${characterId}:`)) {
            continue;
        }

        pendingChatDocuments.delete(chatKey);
        applyLiveChatDocument(chatKey, document.payload, document.revision, document.metadata);
    }
}

function applyJobEvent(event: Extract<LiveEvent, { type: 'job_updated' }>) {
    if (event.sequenceNo != null) {
        lastJobSequences.set(event.jobId, event.sequenceNo);
    }

    if (event.chatKey) {
        const located = findChatIndicesByKey(event.chatKey);
        if (located) {
            DBState.db.characters[located.characterIndex].chats[located.chatIndex].isStreaming = ['queued', 'running'].includes(event.status);
        }
        liveChatMetadata.update((current) => {
            const previous = current[event.chatKey] ?? {};
            return {
                ...current,
                [event.chatKey]: {
                    ...previous,
                    activeJobId: ['queued', 'running'].includes(event.status) ? event.jobId : null,
                    lastJobId: event.jobId,
                    lastJobStatus: event.status,
                    lastJobError: event.error ?? null,
                },
            };
        });
    }

    activeServerJobs.update((current) => {
        const previous = current[event.jobId];
        const next = {
            ...current,
            [event.jobId]: {
                ...(previous ?? {}),
                job_id: event.jobId,
                session_key: event.sessionKey,
                status: event.status,
                error_text: event.error ?? previous?.error_text ?? null,
                result_payload: event.text ? { text: event.text, model: event.model ?? null } : previous?.result_payload,
                chat_document_key: event.chatKey ?? previous?.chat_document_key,
            },
        };
        return next;
    });

    if (['completed', 'failed', 'cancelled'].includes(event.status)) {
        removeCompletedJobs();
    }
}

function applyLiveEvent(event: LiveEvent) {
    switch (event.type) {
        case 'chat_updated':
            applyLiveChatDocument(event.chatKey, event.payload, event.revision, event.metadata);
            break;
        case 'job_updated':
            applyJobEvent(event);
            break;
        default:
            break;
    }
}

async function parseSseStream(response: Response, onEvent: (event: LiveEvent) => void, signal: AbortSignal) {
    if (!response.body) {
        return;
    }

    const reader = response.body.getReader();
    let buffer = '';
    let currentEvent = 'message';
    const decoder = new TextDecoder();

    while (true) {
        if (signal.aborted) {
            return;
        }

        const { value, done } = await reader.read();
        if (done) {
            return;
        }

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';

        for (const chunk of chunks) {
            const lines = chunk.split('\n');
            let dataLines: string[] = [];
            currentEvent = 'message';

            for (const line of lines) {
                if (line.startsWith('event:')) {
                    currentEvent = line.slice(6).trim();
                }
                else if (line.startsWith('data:')) {
                    dataLines.push(line.slice(5).trim());
                }
            }

            if (dataLines.length === 0) {
                continue;
            }

            try {
                const payload = JSON.parse(dataLines.join('\n'));
                onEvent({
                    type: (payload.type ?? currentEvent) as LiveEvent['type'],
                    ...payload,
                });
            }
            catch (error) {
                console.error('Failed to parse live SSE payload', error);
            }
        }
    }
}

export async function isServerGenerationSupported() {
    if (!isNodeServer) {
        cachedSupported = false;
        serverGenerationAvailable.set(false);
        return false;
    }

    if (cachedSupported != null) {
        return cachedSupported;
    }

    const headers = await getNodeAuthHeaders();
    const response = await fetch('/healthz', {
        headers,
    });
    const payload = await response.json();
    cachedSupported = response.ok && payload?.storage === 'postgres';
    serverGenerationAvailable.set(cachedSupported);
    return cachedSupported;
}

export async function loadActiveServerGenerationJobs(sessionKey = defaultSessionKey()) {
    if (!(await isServerGenerationSupported())) {
        return [];
    }

    const response = await fetchNodeJson(`/api/generation-jobs?status=queued,running&session_key=${encodeURIComponent(sessionKey)}`);
    if (!response.ok) {
        return [];
    }

    const jobs = (response.data?.jobs ?? []) as ServerGenerationJob[];
    activeServerJobs.set({});
    for (const job of jobs) {
        updateJobStore(job);
    }
    return jobs;
}

async function fetchLiveRootDocument(sessionKey = defaultSessionKey()) {
    return await fetchNodeJson(`/api/live/root?session_key=${encodeURIComponent(sessionKey)}`);
}

async function fetchLiveCharacterDocument(characterKey: string, sessionKey = defaultSessionKey()) {
    return await fetchNodeJson(`/api/live/characters/${encodeURIComponent(characterKey)}?session_key=${encodeURIComponent(sessionKey)}`);
}

export async function syncLiveChatDocumentsFromServer(sessionKey = defaultSessionKey()) {
    if (!(await isServerGenerationSupported())) {
        return [];
    }

    const rootResponse = await fetchLiveRootDocument(sessionKey);
    if (rootResponse.ok && rootResponse.data?.document?.payload) {
        applyLiveRootDocument(rootResponse.data.document.payload, rootResponse.data.document.revision);
    }

    const characterKeys = new Set<string>();
    for (const character of DBState.db.characters ?? []) {
        if (character?.chaId) {
            characterKeys.add(toCharacterDocumentKey(character.chaId));
        }
    }

    const characterResponses = await Promise.all(
        Array.from(characterKeys).map(async (characterKey) => ({
            characterKey,
            response: await fetchLiveCharacterDocument(characterKey, sessionKey),
        }))
    );
    for (const item of characterResponses) {
        if (item.response.ok && item.response.data?.document?.payload) {
            applyLiveCharacterDocument(item.characterKey, item.response.data.document.payload, item.response.data.document.revision);
        }
    }

    const response = await fetchNodeJson(`/api/live/chats?session_key=${encodeURIComponent(sessionKey)}`);
    if (!response.ok) {
        return [];
    }

    const documents = response.data?.documents ?? [];
    for (const document of documents) {
        if (document?.document_key && document?.payload) {
            applyLiveChatDocument(document.document_key, document.payload, document.revision, document.metadata);
        }
    }

    return documents;
}

function applyReplayedJobEvent(job: ServerGenerationJob, eventRow: any) {
    const payload = eventRow?.payload ?? {};
    const previousSequence = lastJobSequences.get(job.job_id) ?? 0;
    lastJobSequences.set(job.job_id, Math.max(previousSequence, eventRow.sequence_no ?? previousSequence));

    switch (eventRow?.event_type) {
        case 'generation_started':
            applyJobEvent({
                type: 'job_updated',
                sessionKey: job.session_key,
                jobId: job.job_id,
                chatKey: job.chat_document_key,
                status: 'running',
                sequenceNo: eventRow.sequence_no,
            });
            break;
        case 'text_snapshot':
            applyJobEvent({
                type: 'job_updated',
                sessionKey: job.session_key,
                jobId: job.job_id,
                chatKey: job.chat_document_key,
                status: 'running',
                text: payload.text ?? '',
                sequenceNo: eventRow.sequence_no,
                model: payload.model ?? null,
            });
            break;
        case 'generation_completed':
            applyJobEvent({
                type: 'job_updated',
                sessionKey: job.session_key,
                jobId: job.job_id,
                chatKey: job.chat_document_key,
                status: 'completed',
                text: payload.text ?? '',
                sequenceNo: eventRow.sequence_no,
                model: payload.model ?? null,
            });
            break;
        case 'generation_failed':
            applyJobEvent({
                type: 'job_updated',
                sessionKey: job.session_key,
                jobId: job.job_id,
                chatKey: job.chat_document_key,
                status: 'failed',
                error: payload.error ?? job.error_text ?? null,
                sequenceNo: eventRow.sequence_no,
            });
            break;
        case 'generation_cancelled':
            applyJobEvent({
                type: 'job_updated',
                sessionKey: job.session_key,
                jobId: job.job_id,
                chatKey: job.chat_document_key,
                status: 'cancelled',
                sequenceNo: eventRow.sequence_no,
            });
            break;
        default:
            break;
    }
}

async function replayMissedJobEvents(sessionKey = defaultSessionKey()) {
    const trackedJobs = Object.values(get(activeServerJobs));
    await Promise.all(trackedJobs.map(async (job) => {
        const afterSequence = lastJobSequences.get(job.job_id) ?? 0;
        const response = await fetchNodeJson(`/api/generation-jobs/${job.job_id}/events?after=${afterSequence}&session_key=${encodeURIComponent(sessionKey)}`);
        if (!response.ok) {
            return;
        }

        for (const eventRow of response.data?.events ?? []) {
            applyReplayedJobEvent(job, eventRow);
        }
    }));
}

export async function recoverLiveServerState(sessionKey = defaultSessionKey()) {
    if (!(await isServerGenerationSupported())) {
        return;
    }

    await syncLiveChatDocumentsFromServer(sessionKey);
    await replayMissedJobEvents(sessionKey);
    await loadActiveServerGenerationJobs(sessionKey);
    await syncLiveChatDocumentsFromServer(sessionKey);
}

export async function ensureLiveServerSubscription(sessionKey = defaultSessionKey()) {
    if (!(await isServerGenerationSupported())) {
        return;
    }

    if (subscriptionPromise) {
        return subscriptionPromise;
    }

    liveSubscriptionStopped = false;
    subscriptionController = new AbortController();
    subscriptionPromise = (async () => {
        const response = await fetch('/api/live/events?session_key=' + encodeURIComponent(sessionKey), {
            headers: await getNodeAuthHeaders(),
            signal: subscriptionController?.signal,
        });

        if (!response.ok) {
            throw new Error('Failed to connect live event stream');
        }

        await parseSseStream(response, applyLiveEvent, subscriptionController.signal);
    })().catch((error) => {
        console.error('Live subscription closed', error);
    }).finally(() => {
        subscriptionPromise = null;
        subscriptionController = null;
        if (!liveSubscriptionStopped) {
            if (liveReconnectTimer) {
                clearTimeout(liveReconnectTimer);
            }
            liveReconnectTimer = setTimeout(() => {
                void (async () => {
                    await recoverLiveServerState(sessionKey);
                    await ensureLiveServerSubscription(sessionKey);
                })();
            }, 1500);
        }
    });

    return subscriptionPromise;
}

async function patchLiveDocument(url: string, payload: unknown, expectedRevision: number | undefined, metadata: Record<string, any>, sessionKey = defaultSessionKey()) {
    return await fetchNodeJson(url, {
        method: 'PATCH',
        headers: {
            'content-type': 'application/json',
            'x-risu-session-key': sessionKey,
        },
        body: JSON.stringify({
            expectedRevision,
            payload,
            metadata,
        }),
    });
}

export async function patchLiveChatDocument(chatKey: string, payload: Chat, expectedRevision?: number, metadata: Record<string, any> = {}, sessionKey = defaultSessionKey()) {
    const response = await patchLiveDocument(`/api/live/chats/${encodeURIComponent(chatKey)}`, payload, expectedRevision, metadata, sessionKey);

    if (response.data?.document?.document_key && response.data?.document?.payload) {
        applyLiveChatDocument(
            response.data.document.document_key,
            response.data.document.payload,
            response.data.document.revision,
            response.data.document.metadata
        );
    }

    return response;
}

async function patchLiveRootDocument(payload: Database, expectedRevision?: number, metadata: Record<string, any> = {}, sessionKey = defaultSessionKey()) {
    const response = await patchLiveDocument('/api/live/root', payload, expectedRevision, metadata, sessionKey);

    if (response.data?.document?.payload) {
        applyLiveRootDocument(response.data.document.payload, response.data.document.revision);
    }

    return response;
}

async function patchLiveCharacterDocument(characterKey: string, payload: any, expectedRevision?: number, metadata: Record<string, any> = {}, sessionKey = defaultSessionKey()) {
    const response = await patchLiveDocument(`/api/live/characters/${encodeURIComponent(characterKey)}`, payload, expectedRevision, metadata, sessionKey);

    if (response.data?.document?.payload) {
        applyLiveCharacterDocument(characterKey, response.data.document.payload, response.data.document.revision);
    }

    return response;
}

async function patchLiveRootDocumentWithRetry(payload: Database, metadata: Record<string, any> = {}, sessionKey = defaultSessionKey()) {
    let expectedRevision = get(liveRootRevision) ?? undefined;
    let nextPayload = payload;
    let response = await patchLiveRootDocument(nextPayload, expectedRevision, metadata, sessionKey);

    for (let attempt = 0; attempt < 4 && response.status === 409 && response.data?.current?.payload && response.data?.current?.revision != null; attempt++) {
        nextPayload = mergePlainObjectWithBase(
            response.data.current.payload as Database,
            payload,
            lastMirroredRootPayload
        ) as Database;
        expectedRevision = response.data.current.revision;
        response = await patchLiveRootDocument(nextPayload, expectedRevision, metadata, sessionKey);
    }

    return response;
}

async function patchLiveCharacterDocumentWithRetry(characterKey: string, payload: any, metadata: Record<string, any> = {}, sessionKey = defaultSessionKey()) {
    let expectedRevision = get(liveCharacterRevisions)[characterKey] ?? undefined;
    let nextPayload = payload;
    let response = await patchLiveCharacterDocument(characterKey, nextPayload, expectedRevision, metadata, sessionKey);

    for (let attempt = 0; attempt < 4 && response.status === 409 && response.data?.current?.payload && response.data?.current?.revision != null; attempt++) {
        nextPayload = mergePlainObjectWithBase(
            response.data.current.payload ?? {},
            payload ?? {},
            lastMirroredCharacterPayloads.get(characterKey) ?? null
        );
        expectedRevision = response.data.current.revision;
        response = await patchLiveCharacterDocument(characterKey, nextPayload, expectedRevision, metadata, sessionKey);
    }

    return response;
}

async function patchLiveChatDocumentWithRetry(chatKey: string, payload: Chat, metadata: Record<string, any> = {}, sessionKey = defaultSessionKey()) {
    let expectedRevision = getLiveChatRevision(chatKey) ?? undefined;
    let nextPayload = payload;
    let response = await patchLiveChatDocument(chatKey, nextPayload, expectedRevision, metadata, sessionKey);

    for (let attempt = 0; attempt < 4 && response.status === 409 && response.data?.current?.payload && response.data?.current?.revision != null; attempt++) {
        const currentServerChat = response.data.current.payload as Chat;
        nextPayload = mergeChatsForLivePatch(
            currentServerChat,
            payload,
            lastMirroredChatPayloads.get(chatKey) ?? undefined
        );
        expectedRevision = response.data.current.revision;
        response = await patchLiveChatDocument(chatKey, nextPayload, expectedRevision, metadata, sessionKey);
    }

    return response;
}

export async function submitServerGenerationJob(payload: {
    sessionKey?: string
    characterId: string
    chatId: string
    expectedRevision?: number
    chatSnapshot: Chat
    userMessage: Message | null
    assistantMessage: Message
    clientRequestId: string
    provider: {
        type: ServerProviderType
        request: {
            url: string
            method?: string
            headers: Record<string, string>
            body: Record<string, any>
            stream: boolean
        }
        streamOptions?: {
            streamGeminiThoughts?: boolean
        }
    }
    outputMutators?: {
        presetEditOutputRegex?: ServerSafePresetEditOutputRegex[]
    }
}) {
    async function submitOnce(submitPayload: typeof payload) {
        return await fetchNodeJson('/api/generation-jobs', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-risu-session-key': sessionKey,
            },
            body: JSON.stringify(submitPayload),
        });
    }

    const sessionKey = payload.sessionKey ?? defaultSessionKey();
    let submitPayload = { ...payload };
    let response = await submitOnce(submitPayload);

    for (let attempt = 0; attempt < 4 && response.status === 409 && response.data?.current?.payload && response.data?.current?.revision != null; attempt++) {
        submitPayload = {
            ...submitPayload,
            chatSnapshot: buildGenerationSubmitChat(
                response.data.current.payload,
                payload.chatSnapshot,
                payload.userMessage,
                payload.assistantMessage
            ),
            expectedRevision: response.data.current.revision,
        };
        response = await submitOnce(submitPayload);
    }

    if (!response.ok) {
        throw new Error(response.data?.error ?? 'Failed to submit server generation job');
    }

    if (response.data?.job) {
        updateJobStore(response.data.job);
    }

    if (response.data?.chat?.document_key && response.data?.chat?.payload) {
        applyLiveChatDocument(
            response.data.chat.document_key,
            response.data.chat.payload,
            response.data.chat.revision,
            response.data.chat.metadata
        );
    }

    return response.data;
}

export async function cancelServerGenerationJob(jobId: string, sessionKey = defaultSessionKey()) {
    const response = await fetchNodeJson(`/api/generation-jobs/${jobId}/cancel`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-risu-session-key': sessionKey,
        },
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        throw new Error(response.data?.error ?? 'Failed to cancel server generation job');
    }

    if (response.data?.job) {
        updateJobStore(response.data.job);
    }

    return response.data?.job as ServerGenerationJob;
}

export function stopLiveServerSubscription() {
    liveSubscriptionStopped = true;
    if (liveReconnectTimer) {
        clearTimeout(liveReconnectTimer);
        liveReconnectTimer = null;
    }
    subscriptionController?.abort();
}

export function getActiveServerJobForChat(characterId: string, chatId: string) {
    const chatKey = `chat:${characterId}:${chatId}`;
    return Object.values(get(activeServerJobs)).find((job) => {
        return job.chat_document_key === chatKey && ['queued', 'running'].includes(job.status);
    }) ?? null;
}

export function getLiveChatRevision(chatKey: string) {
    return get(liveChatRevisions)[chatKey] ?? null;
}

export function getLiveChatMetadata(chatKey: string) {
    return get(liveChatMetadata)[chatKey] ?? null;
}

export async function syncDirtyLiveChats(sessionKey = defaultSessionKey()) {
    if (!(await isServerGenerationSupported())) {
        return;
    }
    if (liveMirrorInFlight) {
        return;
    }

    liveMirrorInFlight = true;
    try {
        const rootPayload = buildRootDocumentPayload(DBState.db);
        if (!valuesEqual(rootPayload, lastMirroredRootPayload)) {
            await patchLiveRootDocumentWithRetry(rootPayload, {}, sessionKey);
        }

        for (const character of DBState.db.characters ?? []) {
            if (!character?.chaId) {
                continue;
            }

            const characterKey = toCharacterDocumentKey(character.chaId);
            const characterPayload = buildCharacterDocumentPayload(character);
            if (!valuesEqual(characterPayload, lastMirroredCharacterPayloads.get(characterKey) ?? null)) {
                await patchLiveCharacterDocumentWithRetry(
                    characterKey,
                    characterPayload,
                    {
                        characterId: character.chaId,
                    },
                    sessionKey
                );
            }

            if (!Array.isArray(character.chats)) {
                continue;
            }

            for (const chat of character.chats) {
                if (!chat?.id) {
                    continue;
                }

                const chatKey = `chat:${character.chaId}:${chat.id}`;
                if (getActiveServerJobForChat(character.chaId, chat.id)) {
                    continue;
                }

                if (valuesEqual(chat, lastMirroredChatPayloads.get(chatKey) ?? null)) {
                    continue;
                }

                const response = await patchLiveChatDocumentWithRetry(
                    chatKey,
                    chat,
                    {
                        characterId: character.chaId,
                        chatId: chat.id,
                    },
                    sessionKey
                );

                if (response.ok) {
                    continue;
                }

                if (response.status === 409 && response.data?.current?.document_key && response.data?.current?.payload) {
                    applyLiveChatDocument(
                        response.data.current.document_key,
                        response.data.current.payload,
                        response.data.current.revision,
                        response.data.current.metadata
                    );
                }
            }
        }
    }
    finally {
        liveMirrorInFlight = false;
    }
}

export async function startLiveChatMirror(sessionKey = defaultSessionKey()) {
    if (!(await isServerGenerationSupported())) {
        return;
    }

    if (liveMirrorInterval) {
        return;
    }

    liveMirrorInterval = setInterval(() => {
        void syncDirtyLiveChats(sessionKey);
    }, 1500);
}

export function stopLiveChatMirror() {
    if (liveMirrorInterval) {
        clearInterval(liveMirrorInterval);
        liveMirrorInterval = null;
    }
}

export async function flushLiveStateToServer(sessionKey = defaultSessionKey()) {
    await syncDirtyLiveChats(sessionKey);
}
