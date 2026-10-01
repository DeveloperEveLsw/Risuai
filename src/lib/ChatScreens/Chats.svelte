<script lang="ts">
    import type {
        character,
        groupChat,
        Message,
    } from 'src/ts/storage/database.svelte'
    import { onDestroy } from 'svelte'
    import Chat from './Chat.svelte'
    import { getCharImage } from 'src/ts/characters'
    import { createSimpleCharacter, DBState } from 'src/ts/stores.svelte'
    import { chatFoldedStateMessageIndex } from 'src/ts/globalApi.svelte'
    import type { RuntimeChatPresentationOverlay } from 'src/ts/runtime/chatPresentationOverlay.svelte'
    import type { RuntimeAssistantOutputPresentation } from 'src/ts/runtime/assistantOutputPresentation.svelte'
    import {
        buildRuntimeChatDisplayEntries,
        runtimeChatDisplayKey,
    } from 'src/ts/runtime/chatPresentationEntries'

    let {
        messages,
        currentCharacter,
        onReroll,
        unReroll,
        currentUsername,
        userIcon,
        loadPages,
        userIconPortrait,
        presentationOverlays = [],
        assistantOutputs = [],
        hasNewUnreadMessage = $bindable(false),
    }: {
        messages: Message[]
        currentCharacter: character | groupChat
        onReroll: () => void
        unReroll: () => void
        currentUsername: string
        userIcon: string
        loadPages: number
        userIconPortrait?: boolean
        presentationOverlays?: readonly RuntimeChatPresentationOverlay[]
        assistantOutputs?: readonly RuntimeAssistantOutputPresentation[]
        hasNewUnreadMessage?: boolean
    } = $props()

    let chatBody: HTMLDivElement
    let currentChat = $derived(
        currentCharacter.chats?.[currentCharacter.chatPage],
    )
    let roomKey = $derived(
        JSON.stringify([
            currentCharacter.chaId,
            currentChat?.id ?? currentCharacter.chatPage,
        ]),
    )
    let simpleChar = $derived(createSimpleCharacter(currentCharacter))
    let charImage = $derived(getCharImage(currentCharacter.image, 'css'))
    let userImage = $derived(getCharImage(userIcon, 'css'))
    let configuredPerformanceMode = $derived(
        DBState.db.streamingDisplayOptimizationMode ?? 'off',
    )
    let performanceMode = $derived(
        currentChat?.isStreaming
            ? (currentChat.activeStreamingDisplayOptimizationMode ??
                  configuredPerformanceMode)
            : configuredPerformanceMode,
    )
    let activeStreamingIndex = $derived(
        performanceMode !== 'off' && currentChat?.isStreaming
            ? messages.length - 1
            : -1,
    )
    let displayEntries = $derived(
        buildRuntimeChatDisplayEntries(
            messages,
            presentationOverlays,
            assistantOutputs,
        ),
    )
    let visibleEntries = $derived.by(() => {
        const folded = chatFoldedStateMessageIndex.index
        const end =
            folded === -1
                ? displayEntries.length
                : Math.min(folded + 1, displayEntries.length)
        const start = Math.max(
            0,
            folded === -1 ? end - loadPages : folded - loadPages,
        )
        // Capture keys before child CBS parsing can update the live DB.
        return displayEntries
            .slice(start, end)
            .reverse()
            .map((entry) => ({
                entry,
                key: runtimeChatDisplayKey(roomKey, entry),
            }))
    })

    function checkIfAtBottom() {
        if (!chatBody?.parentElement || !chatBody.firstElementChild) return true
        return (
            chatBody.firstElementChild.getBoundingClientRect().top <=
            chatBody.parentElement.getBoundingClientRect().bottom + 100
        )
    }

    export function scrollToLatestMessage() {
        hasNewUnreadMessage = false
        chatBody?.firstElementChild?.scrollIntoView({
            behavior: 'instant',
            block: 'start',
        })
    }

    let previousLength = 0
    let previousRoomKey: string | null = null
    let scrollTimer: ReturnType<typeof setTimeout> | undefined
    onDestroy(() => clearTimeout(scrollTimer))
    $effect(() => {
        const length = displayEntries.length
        const sameRoom = roomKey === previousRoomKey
        if (
            sameRoom &&
            length > previousLength &&
            displayEntries.at(-1)?.message.role === 'char' &&
            DBState.db.autoScrollToNewMessage
        ) {
            if (checkIfAtBottom() || DBState.db.alwaysScrollToNewMessage) {
                clearTimeout(scrollTimer)
                scrollTimer = setTimeout(scrollToLatestMessage, 700)
            } else {
                hasNewUnreadMessage = true
            }
        }
        previousLength = length
        previousRoomKey = roomKey
    })
</script>

<div class="flex flex-col-reverse" bind:this={chatBody}>
    {#each visibleEntries as { entry, key } (key)}
        {@const message = entry.message}
        {@const readOnlyPresentation =
            entry.overlay !== null || entry.assistantOutput !== null}
        {@const activeStreamingMessage =
            entry.assistantOutput !== null ||
            (entry.canonicalIndex === activeStreamingIndex &&
                message.role === 'char')}
        <div
            class="chat-message-container"
            class:runtime-chat-presentation-overlay={readOnlyPresentation}
            class:opacity-75={entry.overlay !== null}
            class:runtime-assistant-output-presentation={entry.assistantOutput !==
                null}
            data-runtime-request-id={entry.overlay?.requestId}
            data-runtime-command-id={entry.assistantOutput?.commandId}
            data-runtime-output-version={entry.assistantOutput?.version}
            data-message-id={message.chatId}
        >
            <Chat
                message={message.data}
                isLastMemory={false}
                idx={entry.canonicalIndex}
                totalLength={messages.length}
                img={message.role === 'user' ? userImage : charImage}
                {onReroll}
                {unReroll}
                rerollIcon="dynamic"
                character={entry.overlay ? null : simpleChar}
                translationCharacter={currentCharacter.type === 'group'
                    ? currentCharacter.chaId
                    : simpleChar}
                largePortrait={message.role === 'user'
                    ? (userIconPortrait ?? false)
                    : ((currentCharacter as character).largePortrait ?? false)}
                messageGenerationInfo={message.generationInfo}
                role={message.role}
                name={message.role === 'user'
                    ? currentUsername
                    : currentCharacter.name}
                isComment={message.isComment ?? false}
                disabled={message.disabled ?? false}
                isOptimizedStreamingMessage={activeStreamingMessage}
                streamingOptimizationMode={entry.assistantOutput
                    ?.optimizationMode ?? performanceMode}
                rawStreamingText={message.data}
                {readOnlyPresentation}
            />
        </div>
    {/each}
</div>
