import type { Message } from '../storage/database.svelte'
import type { RuntimeAssistantOutputPresentation } from './assistantOutputPresentation.svelte'
import type { RuntimeChatPresentationOverlay } from './chatPresentationOverlay.svelte'

export interface RuntimeChatDisplayEntry {
    message: Message
    canonicalIndex: number
    overlay: RuntimeChatPresentationOverlay | null
    assistantOutput: RuntimeAssistantOutputPresentation | null
}

/** Builds a read-only projection without ever inserting pending runtime data
 * into the canonical message array. A matching assistant snapshot replaces
 * the visible canonical slot (important for continue generation); otherwise
 * it occupies the index the resident has assigned to the future message. */
export function buildRuntimeChatDisplayEntries(
    messages: readonly Message[],
    presentationOverlays: readonly RuntimeChatPresentationOverlay[],
    assistantOutputs: readonly RuntimeAssistantOutputPresentation[],
): RuntimeChatDisplayEntry[] {
    const canonicalUserIds = new Set(messages
        .filter(message => message.role === 'user' && message.chatId)
        .map(message => message.chatId))
    const entries: RuntimeChatDisplayEntry[] = [
        ...messages.map((message, canonicalIndex) => ({
            message,
            canonicalIndex,
            overlay: null,
            assistantOutput: null,
        })),
        ...[...presentationOverlays]
            // The canonical input and its pending overlay can coexist for one
            // reactive turn while a revision is adopted. Present it once.
            .filter(overlay => !canonicalUserIds.has(overlay.canonicalMessageId ?? overlay.requestId))
            .sort((left, right) => (
                left.createdAt - right.createdAt
                || left.requestId.localeCompare(right.requestId)
            ))
            .map((overlay) => ({
                message: {
                    role: 'user' as const,
                    data: overlay.displayText,
                    time: overlay.createdAt,
                },
                canonicalIndex: -1,
                overlay,
                assistantOutput: null,
            })),
    ]

    for (const output of [...assistantOutputs].sort((left, right) => (
        left.messageIndex - right.messageIndex
        || left.timestamp - right.timestamp
        || left.createdAt - right.createdAt
        || left.commandId.localeCompare(right.commandId)
    ))) {
        const canonicalEntryIndex = entries.findIndex((entry) => (
            entry.overlay === null
            && entry.message.chatId === output.messageId
        ))
        const canonicalMessage = canonicalEntryIndex >= 0
            ? entries[canonicalEntryIndex].message
            : null
        const entry: RuntimeChatDisplayEntry = {
            message: {
                ...(canonicalMessage ?? {}),
                role: 'char',
                data: output.data,
                chatId: output.messageId,
                time: output.createdAt,
                generationInfo: output.generationInfo ?? canonicalMessage?.generationInfo,
            },
            // The resident-assigned index is used only for ordering. Until the
            // terminal revision is adopted, this browser must not run CBS or
            // Lua/plugin/trigger/regex editdisplay against a DB slot that may
            // not exist (or mutate an older continue message).
            canonicalIndex: -1,
            overlay: null,
            assistantOutput: output,
        }
        if (canonicalEntryIndex >= 0) {
            entries[canonicalEntryIndex] = entry
        }
        else {
            entries.splice(
                Math.min(output.messageIndex, entries.length),
                0,
                entry,
            )
        }
    }
    return entries
}

/** A message owns its DOM across edits and the runtime-to-canonical handoff.
 * Room scope prevents reused/imported IDs from carrying state across chats.
 */
export function runtimeChatDisplayKey(roomKey: string, entry: RuntimeChatDisplayEntry): string {
    const id = entry.message.chatId ?? entry.overlay?.canonicalMessageId ?? entry.overlay?.requestId;
    return id
        ? JSON.stringify([roomKey, 'message', id])
        : JSON.stringify([roomKey, 'index', entry.canonicalIndex]);
}
