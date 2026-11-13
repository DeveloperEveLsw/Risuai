<script lang="ts">
  import {
    browserRuntime,
    RuntimeUIState,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  let saving = $state("");
  let error = $state("");
  async function acknowledge() {
    const notice = RuntimeUIState.notices.current;
    if (!notice || notice.message === undefined || saving) return;
    saving = notice.id;
    error = "";
    try {
      await browserRuntime().acknowledgeNotice(notice.id, notice.revision);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      saving = "";
    }
  }
</script>

{#if RuntimeUIState.notices.current || RuntimeUIState.notices.error}
  <aside
    class="fixed right-4 top-16 z-[120] w-[calc(100%-2rem)] max-w-md rounded-lg border border-borderc bg-darkbg p-4 text-textcolor shadow-lg"
    role="alert"
    aria-label="서버 알림"
    data-runtime-notice={RuntimeUIState.notices.current?.id ?? ""}
  >
    <div class="mb-2 font-bold">
      서버 알림 · 미확인 {RuntimeUIState.notices.count}개
    </div>
    {#if RuntimeUIState.notices.current?.message !== undefined}
      <p
        class="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words"
        data-runtime-notice-message
      >
        {RuntimeUIState.notices.current.message}
      </p>
      <button
        class="mt-3 rounded bg-darkbutton px-4 py-2"
        data-runtime-notice-ack
        disabled={!!saving}
        onclick={acknowledge}>{saving ? "확인 저장 중…" : "확인"}</button
      >
    {:else if RuntimeUIState.notices.loading}
      <p>알림을 불러오는 중…</p>
    {/if}
    {#if error || RuntimeUIState.notices.error}
      <p class="mt-2 break-words text-draculared">
        {error || RuntimeUIState.notices.error}
      </p>
      <button
        class="mt-2 rounded bg-darkbutton px-3 py-1"
        onclick={() => {
          error = "";
          browserRuntime().refreshNotices();
        }}>다시 불러오기</button
      >
    {/if}
  </aside>
{/if}
