<script lang="ts">
  import {
    browserRuntime,
    RuntimeUIState,
    reportRuntimeError,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  let value = $state("");
  let initialized = "";
  let saving = $state("");
  let error = $state("");
  let errorId = $state("");
  let current = $derived(RuntimeUIState.interactions.current);
  let entry = $derived(
    RuntimeUIState.pending.find(
      (item) =>
        ["answer-interaction", "cancel-interaction"].includes(
          item.command.type,
        ) && item.command.interactionId === current?.id,
    ),
  );
  let busy = $derived(!!current && (saving === current.id || !!entry));
  $effect(() => {
    if (current?.descriptor && current.id !== initialized) {
      initialized = current.id;
      value = current.descriptor.defaultValue ?? "";
    }
  });
  async function submit(answer: string | boolean) {
    const captured = current;
    if (!captured?.descriptor || busy) return;
    saving = captured.id;
    error = "";
    errorId = captured.id;
    try {
      await browserRuntime().answerInteraction(
        captured.id,
        captured.revision,
        answer,
      );
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      if (saving === captured.id) saving = "";
    }
  }
  async function cancel() {
    const captured = current;
    if (!captured?.descriptor || busy) return;
    saving = captured.id;
    error = "";
    errorId = captured.id;
    try {
      await browserRuntime().cancelInteraction(captured.id, captured.revision);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      if (saving === captured.id) saving = "";
    }
  }
</script>

{#if current || RuntimeUIState.interactions.error}
  <aside
    class="fixed bottom-16 right-4 z-[130] w-[calc(100%-2rem)] max-w-md rounded-lg border border-borderc bg-darkbg p-4 text-textcolor shadow-lg"
    role="region"
    aria-label="서버 응답 요청"
    data-runtime-interaction={current?.id ?? ""}
  >
    <div class="mb-2 font-bold">
      응답 요청 · 대기 {RuntimeUIState.interactions.count}개
    </div>
    {#if current?.descriptor}
      {@const data = current.descriptor}
      <p
        class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-words"
        data-runtime-interaction-prompt
      >
        {data.prompt}
      </p>
      {#if data.kind === "input"}
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void submit(value);
          }}
        >
          <input
            class="mt-3 w-full rounded bg-darkbutton p-2"
            data-runtime-interaction-input
            aria-label={data.prompt || "입력"}
            bind:value
            disabled={busy}
            list={"runtime-input-" + current.id}
          />
          <datalist id={"runtime-input-" + current.id}
            >{#each data.datalist ?? [] as pair}<option
                value={pair[0]}
                label={pair[1] || pair[0]}
              ></option>{/each}</datalist
          >
          <button
            class="mt-3 rounded bg-darkbutton px-4 py-2"
            disabled={busy}
            data-runtime-interaction-submit
            type="submit">{busy ? "답변 저장 중…" : "확인"}</button
          >
        </form>
      {:else if data.kind === "select"}
        <div class="mt-3 max-h-[35vh] overflow-auto flex flex-wrap gap-2">
          {#each data.options ?? [] as option, index}<button
              class="rounded bg-darkbutton px-4 py-2"
              disabled={busy}
              data-runtime-interaction-option={index}
              onclick={() => submit(String(index))}>{option}</button
            >{/each}
        </div>
      {:else}
        <div class="mt-3 flex gap-2">
          <button
            class="rounded bg-darkbutton px-4 py-2"
            disabled={busy}
            data-runtime-interaction-yes
            onclick={() => submit(true)}>예</button
          ><button
            class="rounded bg-darkbutton px-4 py-2"
            disabled={busy}
            data-runtime-interaction-no
            onclick={() => submit(false)}>아니요</button
          >
        </div>
      {/if}
      <button
        class="mt-3 rounded bg-darkbutton px-3 py-1"
        disabled={busy}
        data-runtime-interaction-cancel
        onclick={cancel}>작업 중지</button
      >
      {#if entry?.state === "blocked"}
        <p class="mt-2 break-words text-draculared">{entry.error?.message}</p>
        <button
          class="mt-2 rounded bg-darkbutton px-3 py-1"
          data-runtime-interaction-discard
          onclick={() =>
            browserRuntime()
              .discardCommand(entry.requestId)
              .catch(reportRuntimeError)}>거절된 답변 취소</button
        >
      {/if}
      {#if errorId === current.id && error}<p
          class="mt-2 break-words text-draculared"
        >
          {error}
        </p>{/if}
    {:else if RuntimeUIState.interactions.loading}<p>
        요청을 불러오는 중…
      </p>{/if}
    {#if RuntimeUIState.interactions.error}<p class="mt-2 text-draculared">
        {RuntimeUIState.interactions.error}
      </p>
      <button
        class="mt-2 rounded bg-darkbutton px-3 py-1"
        onclick={() => browserRuntime().refreshInteractions()}
        >다시 불러오기</button
      >{/if}
  </aside>
{/if}
