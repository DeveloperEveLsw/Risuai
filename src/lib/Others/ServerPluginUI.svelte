<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    browserRuntime,
    RuntimeUIState,
  } from "src/ts/runtime/browserRuntimeState.svelte";
  import {
    openServerPluginUI,
    mountServerPluginUI,
    readServerPluginUIFile,
    saveServerPluginUIArtifact,
    copyServerPluginUIToClipboard,
    type ServerPluginUISession,
    type ServerPluginUIOwner,
    type ServerPluginUIEffect,
    type ServerPluginUIEffectAnswer,
  } from "src/ts/runtime/serverPluginUI";

  let { pluginId, onClose }: { pluginId: string; onClose: () => void } =
    $props();
  let container: HTMLDivElement;
  let loading = $state(true);
  let error = $state("");
  let mounted = $state(false);
  let effects = $state<ServerPluginUIEffect[]>([]);
  let handling = $state<string[]>([]);
  let notice = $state("");
  let owner: ServerPluginUIOwner | null;
  let session: ServerPluginUISession;
  let frame: ReturnType<typeof mountServerPluginUI>;
  let unsubscribe: (() => void) | undefined;
  const opening = new AbortController();
  function dismiss() {
    opening.abort();
    onClose();
  }
  function active() {
    opening.signal.throwIfAborted();
    const current = browserRuntime().jobHistoryOwner();
    if (
      !mounted ||
      !session ||
      session.closed ||
      !current ||
      !owner ||
      current.chatId !== owner.chatId ||
      current.chatEpoch !== owner.chatEpoch ||
      current.selection !== owner.selection
    )
      throw new Error("설정 창 또는 대상 채팅이 변경되었습니다.");
  }
  async function perform(
    effect: ServerPluginUIEffect,
    operation: () => Promise<void>,
    message = "",
  ) {
    if (handling.includes(effect.id)) return;
    try {
      active();
      handling = [...handling, effect.id];
      error = "";
      notice = "";
      // Invoke synchronously inside the user's button/input handler so native
      // clipboard and file-selection activation stays in the trusted parent.
      await operation();
      if (mounted && !opening.signal.aborted) notice = message;
    } catch (cause) {
      if (mounted && !opening.signal.aborted)
        error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (mounted) handling = handling.filter((id) => id !== effect.id);
    }
  }
  function answer(
    effect: ServerPluginUIEffect,
    response: ServerPluginUIEffectAnswer,
  ) {
    return perform(effect, async () => {
      await session.resolveEffect(effect, response);
    });
  }
  function selectFile(effect: ServerPluginUIEffect, event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    void perform(effect, async () => {
      const value = await readServerPluginUIFile(file, opening.signal);
      active();
      await session.resolveEffect(effect, { kind: "file", file: value });
    });
  }
  function copy(effect: Extract<ServerPluginUIEffect, { kind: "clipboard" }>) {
    void perform(
      effect,
      () => copyServerPluginUIToClipboard(session, effect, opening.signal),
      "클립보드에 복사했습니다.",
    );
  }

  onMount(() => {
    mounted = true;
    void (async () => {
      try {
        owner = browserRuntime().jobHistoryOwner();
        if (!owner)
          throw new Error("설정을 적용할 캐릭터의 채팅을 먼저 선택해 주세요.");
        const opened = await openServerPluginUI({
          pluginId,
          owner,
          signal: opening.signal,
          onError: (cause) => {
            if (mounted) error = cause.message;
          },
        });
        if (!mounted) {
          await opened.close({ keepalive: true }).catch(() => {});
          return;
        }
        session = opened;
        frame = mountServerPluginUI(container, session, {
          onError: (cause) => {
            if (mounted) error = cause.message;
          },
        });
        unsubscribe = session.subscribe((view) => {
          if (mounted) {
            effects = view.effects ?? [];
            if (!view.visible && !effects.length) dismiss();
          }
        });
      } catch (cause) {
        if (mounted)
          error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        if (mounted) loading = false;
      }
    })();
  });
  onDestroy(() => {
    mounted = false;
    opening.abort();
    unsubscribe?.();
    frame?.destroy();
    void session?.close({ keepalive: true }).catch(() => {});
  });
  $effect(() => {
    RuntimeUIState.historyViewGeneration;
    RuntimeUIState.displayScopeRevision;
    if (mounted && owner) {
      const current = browserRuntime().jobHistoryOwner();
      if (
        !current ||
        current.chatId !== owner.chatId ||
        current.chatEpoch !== owner.chatEpoch ||
        current.selection !== owner.selection
      )
        dismiss();
    }
  });
</script>

<div
  class="fixed inset-0 z-[1000] flex flex-col bg-darkbg text-textcolor"
  role="dialog"
  aria-modal="true"
  aria-label="WygLore Leaf 설정"
>
  <div
    class="flex items-center justify-between gap-3 border-b border-borderc px-4 py-2"
  >
    <span>WygLore Leaf 설정</span>
    <button class="rounded-sm bg-darkbutton px-3 py-2" onclick={dismiss}
      >닫기</button
    >
  </div>
  {#each effects as effect (effect.id)}
    <section
      class="max-h-[40vh] overflow-auto border-b border-borderc bg-bgcolor px-4 py-3"
      aria-label="플러그인 브라우저 요청"
    >
      {#if effect.kind === "file"}
        <p>원본 플러그인에서 가져올 파일을 선택해 주세요.</p>
        <p class="mb-2 text-sm text-textcolor2">
          JSON 또는 UTF-8 텍스트 파일 하나, 최대 8 MiB
        </p>
        <input
          type="file"
          accept=".json,.txt,application/json,text/plain"
          disabled={handling.includes(effect.id)}
          onchange={(event) => selectFile(effect, event)}
          oncancel={() => answer(effect, { kind: "file", file: null })}
          aria-label="원본 플러그인 가져오기 파일 선택"
        />
        <button
          class="ml-2 rounded-sm bg-darkbutton px-3 py-2"
          disabled={handling.includes(effect.id)}
          onclick={() => answer(effect, { kind: "file", file: null })}
          >취소</button
        >
      {:else if effect.kind === "confirm"}
        <p class="mb-2 whitespace-pre-wrap">{effect.text}</p>
        <button
          class="rounded-sm bg-darkbutton px-3 py-2"
          disabled={handling.includes(effect.id)}
          onclick={() => answer(effect, { kind: "confirm", accepted: true })}
          >확인</button
        >
        <button
          class="ml-2 rounded-sm bg-darkbutton px-3 py-2"
          disabled={handling.includes(effect.id)}
          onclick={() => answer(effect, { kind: "confirm", accepted: false })}
          >취소</button
        >
      {:else if effect.kind === "clipboard"}
        <p>원본 플러그인의 내용을 클립보드로 복사합니다.</p>
        <details class="my-2 text-sm text-textcolor2">
          <summary>복사할 내용 보기 ({effect.text.length}자)</summary>
          <pre
            class="max-h-32 overflow-auto whitespace-pre-wrap">{effect.text.slice(
              0,
              8192,
            )}{effect.text.length > 8192
              ? "\n… (미리보기는 8,192자까지 표시합니다.)"
              : ""}</pre>
        </details>
        <button
          class="rounded-sm bg-darkbutton px-3 py-2"
          disabled={handling.includes(effect.id)}
          onclick={() => copy(effect)}>복사</button
        >
        <button
          class="ml-2 rounded-sm bg-darkbutton px-3 py-2"
          disabled={handling.includes(effect.id)}
          onclick={() =>
            answer(effect, {
              kind: "clipboard",
              ok: false,
              error: "사용자가 복사를 취소했습니다.",
            })}>취소</button
        >
      {:else if effect.kind === "download"}
        <p class="mb-2">
          {effect.name} ({effect.bytes.toLocaleString()}바이트)
        </p>
        <button
          class="rounded-sm bg-darkbutton px-3 py-2"
          disabled={handling.includes(effect.id)}
          onclick={() =>
            perform(
              effect,
              () => saveServerPluginUIArtifact(session, effect, opening.signal),
              "다운로드를 시작했습니다.",
            )}>파일 다운로드</button
        >
        <button
          class="ml-2 rounded-sm bg-darkbutton px-3 py-2"
          disabled={handling.includes(effect.id)}
          onclick={() => answer(effect, { kind: "download", received: false })}
          >취소</button
        >
      {/if}
    </section>
  {/each}
  {#if loading}<p class="p-4" role="status">설정 화면을 여는 중…</p>{/if}
  {#if error}<p class="p-4 text-draculared" role="alert">{error}</p>{/if}
  {#if notice}<p class="px-4 py-2 text-sm text-textcolor2" role="status">
      {notice}
    </p>{/if}
  <div bind:this={container} class="min-h-0 flex-1"></div>
</div>
