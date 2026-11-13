<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    browserRuntime,
    RuntimeUIState,
    type RuntimeJob,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import {
    JobHistory,
    type JobHistoryItem,
    type JobHistoryFilter,
    type JobHistoryState,
  } from "src/ts/runtime/jobHistory";
  let {
    onClose,
    onSelect,
  }: {
    onClose: () => void;
    onSelect: (item: JobHistoryItem, job: RuntimeJob) => void;
  } = $props();
  let view = $state<JobHistoryState>({
    page: null,
    loading: false,
    error: "",
    filter: "all",
  });
  let opening = $state(false),
    openingError = $state("");
  const history = new JobHistory({
    owner: () => browserRuntime().jobHistoryOwner(),
    read: (owner, filter, after, signal) =>
      browserRuntime().readJobHistory(owner, filter, after, signal),
    publish: (value) => {
      view = value;
    },
  });
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
    void history.open();
  });
  onDestroy(() => {
    mounted = false;
    history.close();
  });
  $effect(() => {
    RuntimeUIState.historyViewGeneration;
    RuntimeUIState.displayScopeRevision;
    if (mounted && !history.current()) onClose();
  });
  async function open(item: JobHistoryItem) {
    if (opening || !history.current()) return;
    opening = true;
    openingError = "";
    try {
      const job = await browserRuntime().observeJob(item.id);
      if (mounted && history.current()) onSelect(item, job);
    } catch (error) {
      if (mounted && history.current())
        openingError = error instanceof Error ? error.message : String(error);
    } finally {
      if (mounted) opening = false;
    }
  }
  const labels: Record<string, string> = {
    queued: "접수됨",
    running: "실행 중",
    completed: "완료",
    failed: "실패",
    cancelled: "취소됨",
    interrupted: "중단됨",
  };
</script>

<section
  data-runtime-job-history
  class="flex flex-col max-h-[85dvh] p-4 max-w-2xl bg-darkbg text-textcolor border border-borderc rounded-sm"
>
  <h3>작업 기록</h3>
  <label
    >종류
    <select
      data-runtime-history-filter
      class="bg-bgcolor text-textcolor"
      value={view.filter}
      disabled={opening}
      onchange={(event) => {
        void history.refresh(event.currentTarget.value as JobHistoryFilter);
      }}
    >
      <option value="all">전체</option><option value="memory">재요약</option
      ><option value="failed">실패·취소·중단</option>
    </select>
  </label>
  <button
    data-runtime-history-refresh
    disabled={opening}
    onclick={() => {
      void history.refresh();
    }}>최근 기록부터</button
  >
  {#if view.loading}<p role="status">기록을 불러오는 중…</p>{/if}
  {#if view.error}<p role="alert">{view.error}</p>{/if}
  {#if openingError}<p role="alert">{openingError}</p>{/if}
  {#if view.page}
    {#if !view.page.items.length}<p>작업 기록이 없습니다.</p>{/if}
    <ul class="overflow-y-auto min-h-0">
      {#each view.page.items as job (job.id)}
        <li
          data-runtime-history-job={job.id}
          class="p-2 border-b border-borderc"
        >
          <span
            >{new Date(job.createdAt).toLocaleString()} · {job.type ===
            "memory-summary"
              ? "재요약"
              : job.type === "button"
                ? "캐릭터 버튼"
                : "응답 생성"} · {labels[job.state] ?? job.state}</span
          >
          {#if job.type === "memory-summary" || ["failed", "cancelled", "interrupted"].includes(job.state)}
            <button
              data-runtime-history-open={job.id}
              disabled={opening}
              onclick={() => {
                void open(job);
              }}
              >{job.type === "memory-summary"
                ? "재요약 확인"
                : "보존된 결과 확인"}</button
            >
          {/if}
        </li>
      {/each}
    </ul>
    <button
      data-runtime-history-newer
      disabled={!view.page.newer || view.loading || opening}
      onclick={() => {
        void history.newer();
      }}>더 최근 기록</button
    >
    <button
      data-runtime-history-older
      disabled={!view.page.older || view.loading || opening}
      onclick={() => {
        void history.older();
      }}>이전 기록</button
    >
  {/if}
  <button data-runtime-history-close onclick={onClose}>닫기</button>
</section>
