<script lang="ts">
    import {
        loadedStore,
        alertStore,
        LoadingStatusState,
    } from './ts/stores.svelte'
    import AlertComp from './lib/Others/AlertComp.svelte'
</script>

<main
    class="min-h-screen bg-bgcolor text-textcolor p-6"
    data-runtime-executor-shell
>
    <p>Risu AI server executor</p>
    <p class="text-textcolor2">
        {$loadedStore ? 'Ready' : LoadingStatusState.text}
    </p>
</main>
{#if $alertStore.type !== 'none'}
    <AlertComp />
{/if}
