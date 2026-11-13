<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    browserRuntime,
    RuntimeUIState,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import type { MemorySummaryPreview } from "src/ts/runtime/memorySummaries";
  import { jobFailureMessage } from "src/ts/runtime/jobResults";
  import { translateHTML } from "src/ts/translator/translator";
  let {
    jobId = $bindable(),
    onClose,
  }: { jobId: string; onClose?: () => void } = $props();
  const job = $derived(
    RuntimeUIState.historyResultJob?.id === jobId
      ? RuntimeUIState.historyResultJob
      : RuntimeUIState.jobs.find((value) => value.id === jobId),
  );
  const phase = $derived(job?.state);
  let preview = $state<MemorySummaryPreview | null>(null);
  let text = $state("");
  let error = $state("");
  let loading = $state(false),
    busy = $state(false);
  let translation = $state<string | null>(null),
    translating = $state(false);
  let loaded = "",
    token = 0;
  const failure = (value: unknown) =>
    value instanceof Error ? value.message : String(value);
  async function load() {
    const id = jobId,
      request = ++token;
    loading = true;
    error = "";
    try {
      const next = await browserRuntime().previewMemorySummary(id);
      if (request !== token || id !== jobId) return;
      if (!preview || preview.jobId !== id || text === preview.text)
        text = next.appliedText ?? next.text;
      preview = next;
    } catch (value) {
      if (request === token) error = failure(value);
    } finally {
      if (request === token) loading = false;
    }
  }
  $effect(() => {
    if (phase === "completed" && loaded !== jobId) {
      loaded = jobId;
      void load();
    }
  });
  onDestroy(() => {
    token++;
  });
  async function apply() {
    if (!preview?.canApply || busy || !text) return;
    const value = preview,
      edited = text;
    busy = true;
    error = "";
    try {
      await browserRuntime().applyMemorySummary(
        value,
        false,
        edited === value.text ? undefined : edited,
      );
      await load();
    } catch (value) {
      const message = failure(value);
      await load();
      error = message;
    } finally {
      busy = false;
    }
  }
  async function dismiss() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      if (preview) await browserRuntime().applyMemorySummary(preview, true);
      else await browserRuntime().cancelMemorySummary(jobId);
      if (preview) await load();
    } catch (value) {
      error = failure(value);
    } finally {
      busy = false;
    }
  }
  async function reroll() {
    if (!preview?.canApply || busy) return;
    busy = true;
    error = "";
    try {
      const id = await browserRuntime().summarizeMemory(
        preview.mode,
        preview.indices,
        preview.chatId,
        {
          revision: preview.source.memoryRevision,
          epoch: preview.expectedChatEpoch,
        },
      );
      jobId = id;
      preview = null;
      text = "";
      translation = null;
      loaded = "";
    } catch (value) {
      error = failure(value);
    } finally {
      busy = false;
    }
  }
  async function translate() {
    if (translating || !text) return;
    if (translation) {
      translation = null;
      return;
    }
    translating = true;
    try {
      translation = await translateHTML(text, false, "", -1, false);
    } catch (value) {
      error = failure(value);
    } finally {
      translating = false;
    }
  }
</script>

<section
  data-runtime-memory-summary-result={jobId}
  class="p-3 my-2 border border-borderc rounded-sm bg-darkbg text-textcolor"
>
  <h3>재요약 결과</h3>
  <p class="text-xs break-all">{jobId}</p>
  {#if loading}<p>결과를 불러오는 중…</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if preview}
    <textarea
      data-runtime-memory-summary-text
      class="w-full min-h-32 bg-bgcolor text-textcolor border border-borderc p-2"
      bind:value={text}
      readonly={!!preview.disposition || busy}
    ></textarea>
    {#if preview.blocked}<p role="alert">
        적용할 수 없습니다: {preview.blocked.message}
      </p>{/if}
    {#if preview.disposition}
      <p>
        {preview.disposition.action === "apply"
          ? "적용 완료"
          : "결과 적용 취소됨"}{preview.disposition.edited
          ? " · 편집한 텍스트 적용"
          : ""}
      </p>
    {/if}
    <button
      data-runtime-memory-summary-apply
      disabled={!preview.canApply || busy || !text}
      onclick={apply}>적용</button
    >
    <button
      data-runtime-memory-summary-reroll
      disabled={!preview.canApply || busy}
      onclick={reroll}>다시 요약</button
    >
    <button disabled={translating || busy} onclick={translate}
      >{translating ? "번역 중…" : "번역"}</button
    >
    {#if translation}<textarea
        class="w-full min-h-32 bg-bgcolor text-textcolor"
        readonly
        value={translation}
      ></textarea>{/if}
    <button
      data-runtime-memory-summary-dismiss
      disabled={busy || !!preview.disposition}
      onclick={dismiss}>결과 적용 취소</button
    >
  {:else if phase && ["failed", "cancelled", "interrupted"].includes(phase)}
    <p role="alert">{jobFailureMessage(job)}</p>
  {:else}
    {#if phase}
      <p>재요약 진행 중… 화면을 닫아도 작업은 계속 진행됩니다.</p>
    {:else}<p>요청 접수 대기 중… 연결이 복구되면 접수를 확인합니다.</p>{/if}
    <button
      data-runtime-memory-summary-cancel
      disabled={busy || !phase}
      onclick={dismiss}>작업 취소</button
    >
  {/if}
  <button
    data-runtime-memory-summary-refresh
    disabled={busy || loading || phase !== "completed"}
    onclick={load}>다시 확인</button
  >
  {#if onClose}<button
      data-runtime-memory-summary-close
      disabled={busy}
      onclick={onClose}>닫기</button
    >{/if}
</section>
