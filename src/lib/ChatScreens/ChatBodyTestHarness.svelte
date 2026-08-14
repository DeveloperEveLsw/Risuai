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
    role="char"
    bind:translated
    bind:translating
    bind:retranslate
    modelShortName=""
/>
