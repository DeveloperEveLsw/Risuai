<script lang="ts">
  import RuntimeNotices from "./RuntimeNotices.svelte";
  import RuntimeInteractions from "./RuntimeInteractions.svelte";
  import RuntimeMemorySummaryResult from "./RuntimeMemorySummaryResult.svelte";
  import RuntimeJobHistory from "./RuntimeJobHistory.svelte";
  import { onMount } from "svelte";
  import {
    buttonActivities,
    pendingButtonSummary,
  } from "src/ts/runtime/buttonActivity";
  let statusNow = $state(Date.now());
  onMount(() => {
    const timer = setInterval(() => {
      if (
        RuntimeUIState.pending.some((entry) => entry.command.type === "button")
      )
        statusNow = Date.now();
    }, 250);
    return () => clearInterval(timer);
  });
  $effect(() => {
    buttonActivities.reconcile(RuntimeUIState.pending, RuntimeUIState.jobs);
  });
  let pendingSummary = $derived(
    pendingButtonSummary(RuntimeUIState.pending, statusNow),
  );
  let historyOpen = $state(false);
  let memoryReviewJob = $state("");
  const memoryJobs = $derived(
    RuntimeUIState.jobs.filter((job) => job.type === "memory-summary"),
  );
  import {
    entityRuntimeEnabled,
    RuntimeUIState,
    browserRuntime,
    reportRuntimeError,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import { variableEdits } from "src/ts/runtime/variableCommands";
  import { fieldEdits } from "src/ts/runtime/fieldCommands";
  import {
    jobFailureMessage,
    type JobResultPreview,
  } from "src/ts/runtime/jobResults";
  let review = $state<JobResultPreview | null>(null);
  let reviewJob = $state("");
  let reviewError = $state("");
  let reviewing = $state(false);
  let saving = $state(false);
  let reviewToken = 0;
  function closeReview() {
    RuntimeUIState.historyResultJob = null;
    reviewToken++;
    reviewJob = "";
    review = null;
  }
  function mountReview(dialog: HTMLDialogElement) {
    dialog.showModal();
    return { destroy: () => dialog.close() };
  }
  let failedJobs = $derived(
    RuntimeUIState.jobs.filter((job) =>
      ["failed", "cancelled", "interrupted"].includes(job.state),
    ),
  );
  async function openResult(id: string) {
    const token = ++reviewToken;
    reviewJob = id;
    review = null;
    reviewError = "";
    reviewing = true;
    try {
      const value = await browserRuntime().previewJobResult(id);
      if (token === reviewToken) review = value;
    } catch (error) {
      if (token === reviewToken)
        reviewError = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === reviewToken) reviewing = false;
    }
  }
  async function recoverResult() {
    if (!review?.canRecover || saving) return;
    const target = { ...review.target };
    saving = true;
    reviewError = "";
    try {
      await browserRuntime().recoverJobResult(target);
      await openResult(target.jobId);
    } catch (error) {
      reviewError = error instanceof Error ? error.message : String(error);
      if (review) review.canRecover = false;
    } finally {
      saving = false;
    }
  }
  let resolving = $state("");
  async function retryResult() {
    if (!review?.canRetry || saving) return;
    const target = { ...review.target };
    saving = true;
    reviewError = "";
    try {
      await browserRuntime().retryJobResult(target);
      await openResult(target.jobId);
    } catch (error) {
      reviewError = error instanceof Error ? error.message : String(error);
      if (review) review.canRetry = false;
    } finally {
      saving = false;
    }
  }
  async function resolve(id: string, keep: boolean) {
    resolving = id;
    try {
      const entry = RuntimeUIState.pending.find(
        (entry) => entry.requestId === id,
      );
      if (entry && fieldEdits(entry.command).length)
        await browserRuntime().resolveFieldConflict(id, keep);
      else await browserRuntime().resolveVariableConflict(id, keep);
    } catch (error) {
      reportRuntimeError(error);
    } finally {
      resolving = "";
    }
  }
  let blocked = $derived(
    RuntimeUIState.pending.filter((entry) => entry.state === "blocked"),
  );
</script>

{#if entityRuntimeEnabled}<RuntimeNotices /><RuntimeInteractions />{/if}

{#if entityRuntimeEnabled}
  <div
    class="fixed bottom-0 right-0 z-50 max-w-lg bg-darkbutton text-textcolor text-xs p-2"
    role="status"
    data-runtime-ready={RuntimeUIState.ready}
    data-runtime-pending-count={RuntimeUIState.pending.length}
  >
    {#if RuntimeUIState.error}
      <p data-runtime-status-message>{RuntimeUIState.error}</p>
      <button
        onclick={() => {
          RuntimeUIState.error = "";
        }}>확인</button
      >
    {:else if RuntimeUIState.connection !== "connected"}
      <p data-runtime-status-message>서버 연결: {RuntimeUIState.connection}</p>
    {:else if pendingSummary.ordinary}
      <p data-runtime-status-message>
        처리 대기 {pendingSummary.ordinary}개
      </p>
    {/if}
    {#if pendingSummary.buttons}
      <p data-runtime-status-message data-runtime-button-pending-summary>
        버튼 동작 {pendingSummary.buttons}개 처리 중…
        {#if pendingSummary.local}<span>
            · 서버 전송 대기 {pendingSummary.local}개</span
          >{/if}
        {#if pendingSummary.accepted}<span>
            · 서버 접수 {pendingSummary.accepted}개</span
          >{/if}
      </p>
    {/if}
    {#if RuntimeUIState.ready && !RuntimeUIState.scopeReady && RuntimeUIState.messages.length}
      <p data-runtime-status-message>대화를 불러오는 중…</p>
    {/if}
    {#each blocked as entry (entry.requestId)}
      <p data-runtime-status-message>
        변경을 반영하지 못했습니다: {entry.error?.message}
      </p>
      {@const derived =
        !!entry.command.groupImageSources ||
        (Array.isArray(entry.command.checks) &&
          entry.command.checks.length > 0)}
      {#if variableEdits(entry.command).length || fieldEdits(entry.command).length}
        <button
          disabled={!!resolving}
          onclick={() => resolve(entry.requestId, false)}>서버 값 사용</button
        >
        {#if derived}<p>
            서버 값을 사용한 다음 이미지를 다시 만들어 주세요.
          </p>{:else}<button
            disabled={!!resolving}
            onclick={() => resolve(entry.requestId, true)}>내 변경 적용</button
          >{/if}
      {/if}
      {#if entry.kind === "command" && !variableEdits(entry.command).length && !fieldEdits(entry.command).length}
        <button
          onclick={async () => {
            try {
              await browserRuntime().discardCommand(entry.requestId);
            } catch (error) {
              reportRuntimeError(error);
            }
          }}>요청 취소</button
        >
      {/if}
    {/each}
    <button
      data-runtime-history-show
      disabled={!RuntimeUIState.scopeReady ||
        !browserRuntime().jobHistoryOwner()}
      onclick={() => {
        historyOpen = true;
      }}>작업 기록 전체</button
    >
    {#if memoryJobs.length}
      <details data-runtime-memory-jobs>
        <summary>재요약 작업 {memoryJobs.length}개</summary>
        {#each memoryJobs as job (job.id)}
          <p>{job.state}</p>
          <button
            data-runtime-memory-result={job.id}
            onclick={() => {
              memoryReviewJob = job.id;
            }}>재요약 결과 보기</button
          >
        {/each}
      </details>
    {/if}
    {#if failedJobs.length}
      <details data-runtime-failed-jobs>
        <summary>작업 기록 {failedJobs.length}개</summary>
        {#each failedJobs as job (job.id)}
          <p>{jobFailureMessage(job)}</p>
          {#if job.disposition}<p>
              {job.disposition.action === "retry"
                ? "재요청 접수됨"
                : "복구 완료"}
            </p>{/if}
          <button
            data-runtime-result={job.id}
            onclick={() => openResult(job.id)}>보존된 응답 확인</button
          >
        {/each}
      </details>
    {/if}
  </div>
  {#if historyOpen}
    <dialog
      use:mountReview
      aria-label="전체 작업 기록"
      oncancel={() => {
        historyOpen = false;
      }}
    >
      <RuntimeJobHistory
        onClose={() => {
          historyOpen = false;
        }}
        onSelect={(item, job) => {
          RuntimeUIState.historyResultJob = job;
          historyOpen = false;
          if (item.type === "memory-summary") memoryReviewJob = item.id;
          else void openResult(item.id);
        }}
      />
    </dialog>
  {/if}
  {#if memoryReviewJob}
    <dialog
      use:mountReview
      aria-label="재요약 작업 결과"
      data-runtime-memory-result-review
      oncancel={() => {
        memoryReviewJob = "";
      }}
    >
      <RuntimeMemorySummaryResult
        bind:jobId={memoryReviewJob}
        onClose={() => {
          RuntimeUIState.historyResultJob = null;
          memoryReviewJob = "";
        }}
      />
    </dialog>
  {/if}
  {#if reviewJob}
    <dialog
      use:mountReview
      aria-label="보존된 작업 결과"
      data-runtime-result-review
      oncancel={(event) => {
        event.preventDefault();
        if (!saving) closeReview();
      }}
      class="backdrop:bg-darkbg/90 bg-bgcolor text-textcolor border border-borderc p-4 w-full max-w-3xl max-h-[90vh] overflow-auto"
    >
      <h2>보존된 작업 결과</h2>
      <p class="text-xs break-all">{reviewJob}</p>
      {#if reviewing}<p>불러오는 중…</p>{/if}
      {#if reviewError}<p role="alert">{reviewError}</p>{/if}
      {#if review}
        {#if review.failure}
          <section data-runtime-result-failure class="mt-2">
            <h3>작업 실패·중단 원인</h3>
            <p class="whitespace-pre-wrap break-all">
              {jobFailureMessage({
                state: review.state,
                result: review.failure,
              })}
            </p>
          </section>
        {/if}
        {#if review.disposition}<p data-runtime-result-saved>
            {review.disposition.action === "retry"
              ? "새 요청을 접수했습니다."
              : "이미 복구한 결과입니다."}
          </p>
          {#if review.disposition.resultJobId}<p class="text-xs break-all">
              새 작업: {review.disposition.resultJobId}
            </p>{/if}
        {:else if review.canRecover}
          <p>
            응답과 변수·설정 변경을 함께 저장합니다. 추가 생성 요청은 보내지
            않습니다. 저장 시 상태가 바뀌었다면 복구를 거부합니다.
          </p>
        {:else}
          <section data-runtime-result-recovery-blocked class="mt-2">
            <h3>결과 복구 제한</h3>
            <p>이 작업의 결과를 대화에 바로 저장할 수 없습니다.</p>
            {#if review.blocked}<p>
                {review.blocked.code}: {review.blocked.message}
              </p>{/if}
          </section>
        {/if}
        {#if !review.complete}<p>
            {review.messages.some((message) => message.data.length > 0)
              ? "실패·중단 시 보존된 메시지입니다. 전체 스크립트 처리 결과가 포함되어 있지 않습니다."
              : "저장 가능한 전체 스크립트 처리 결과가 남아 있지 않습니다."}
          </p>{/if}
        {#each review.messages as message, index}
          <label class="block mt-2" for={"runtime-result-" + index}
            >{message.role}{message.saying ? " · " + message.saying : ""}</label
          >
          <textarea
            id={"runtime-result-" + index}
            readonly
            value={message.data}
            rows="5"
            class="w-full bg-darkbg text-textcolor border border-borderc p-2"
          ></textarea>
        {/each}
        {#if !review.messages.length}<p>보존된 메시지가 없습니다.</p>{/if}
        {#if review.providerOutputs?.length}
          <h3 class="mt-4">모델이 보낸 응답 (추가 처리 전)</h3>
          <p>
            아래 원문을 확인하거나 복사할 수 있습니다. 실패한 처리를 마친 대화
            메시지는 아닙니다.
          </p>
          {#each review.providerOutputs as output (output.request)}
            <p>
              생성 {output.request}{output.mode === "model"
                ? ""
                : " · 보조 생성"} · {output.complete
                ? "수신 완료"
                : "스트리밍 미완료"}
            </p>
            {#each output.candidates as candidate, index}
              <label
                class="block mt-2"
                for={"runtime-provider-" + output.request + "-" + index}
                >응답 {index + 1}</label
              >
              <textarea
                id={"runtime-provider-" + output.request + "-" + index}
                data-runtime-provider-output
                readonly
                value={candidate.data}
                rows="5"
                class="w-full bg-darkbg text-textcolor border border-borderc p-2"
              ></textarea>
            {/each}
          {/each}
        {/if}
        {#if review.canRecover}
          <button data-runtime-recover disabled={saving} onclick={recoverResult}
            >{saving ? "저장 확인 중…" : "전체 결과 복구"}</button
          >
        {/if}
        {#if review.canRetry && review.retryIntent}
          <p class="mt-4">
            원래 {review.retryIntent.type === "send"
              ? "입력문을 새 메시지로 추가하고"
              : review.retryIntent.type === "button"
                ? "버튼 호출을 다시 실행하고"
                : review.retryIntent.type === "memory-summary"
                  ? "선택한 메모리 요약을 다시 계산하고"
                  : "현재 마지막 응답을 대상으로"} 실행 시점의 설정·대화로 새 요청을
            보냅니다.
          </p>
          <p>
            추가 API 비용이 발생할 수 있고, 스크립트의 외부 동작이 반복될 수
            있습니다.
          </p>
          {#if review.retryIntent.type === "send"}
            <label for="runtime-retry-input">다시 보낼 입력문</label>
            <textarea
              id="runtime-retry-input"
              readonly
              value={review.retryIntent.input ?? ""}
              rows="3"
              class="w-full bg-darkbg text-textcolor border border-borderc p-2"
            ></textarea>
          {:else if review.retryIntent.type === "button"}
            <p class="whitespace-pre-wrap break-all">
              {review.retryIntent.manualName ?? review.retryIntent.data ?? ""}
            </p>
          {:else if review.retryTarget}
            <label for="runtime-retry-tail">현재 대상 응답</label>
            <textarea
              id="runtime-retry-tail"
              readonly
              value={review.retryTarget.data}
              rows="3"
              class="w-full bg-darkbg text-textcolor border border-borderc p-2"
            ></textarea>
          {/if}
          <button data-runtime-retry disabled={saving} onclick={retryResult}
            >{saving ? "접수 확인 중…" : "새 요청 보내기"}</button
          >
        {:else if !review.disposition && review.retryBlocked}
          <p>재요청 불가: {review.retryBlocked.message}</p>
        {/if}
      {/if}
      <button
        disabled={saving || reviewing}
        onclick={() => openResult(reviewJob)}>다시 확인</button
      >
      <button disabled={saving} onclick={closeReview}>닫기</button>
    </dialog>
  {/if}
{/if}
