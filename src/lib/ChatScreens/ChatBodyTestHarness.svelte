<script lang="ts">
    import { onDestroy } from 'svelte'
    import { subscribeTranslationCacheMutations } from '../../ts/translator/translator'
    import ChatBody from './ChatBody.svelte'

    interface Props {
        msgDisplay: string
        translationManualSource?: string
        character?: string | null
        translationCharacter?: string | null
        idx?: number
    }

    let {
        msgDisplay,
        translationManualSource = msgDisplay,
        character = null,
        translationCharacter = null,
        idx = 0,
    }: Props = $props()

    let displayRevision = $state('initial')
    let readOnlyPresentation = $state(false)
    let renderRawStreaming = $state(false)
    let rawStreamingText = $state('')

    export function setPresentation(
        source: string,
        options: { readOnly?: boolean; raw?: boolean; revision?: string } = {},
    ): void {
        msgDisplay = source
        displayRevision = options.revision ?? source
        readOnlyPresentation = options.readOnly ?? false
        renderRawStreaming = options.raw ?? false
        rawStreamingText = source
        translated = false
    }

    let translated = $state(true)
    let translating = $state(false)
    let retranslate = $state(false)

    // Mirror Chat.svelte's parent-first clear listener. This subscription is
    // registered before the child is created below.
    const unsubscribe = subscribeTranslationCacheMutations((mutation) => {
        if (mutation.reason === 'clear') translated = false
    })
    onDestroy(unsubscribe)

    export function forceRetranslate(): void {
        retranslate = true
    }

    export function isRetranslating(): boolean {
        return retranslate
    }

    export function showTranslation(): void {
        translated = true
    }
</script>

<ChatBody
    {msgDisplay}
    {translationManualSource}
    {character}
    {translationCharacter}
    {idx}
    {displayRevision}
    {readOnlyPresentation}
    {renderRawStreaming}
    {rawStreamingText}
    role="char"
    bind:translated
    bind:translating
    bind:retranslate
    modelShortName=""
/>
