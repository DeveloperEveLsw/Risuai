<script lang="ts">
  import { onDestroy, untrack, type Snippet } from "svelte";
  import { commandJson } from "src/ts/runtime/clientProtocol";
  import { fieldTarget, type FieldTarget } from "src/ts/runtime/fieldCommands";
  import { getFieldValue } from "src/ts/runtime/fieldControls";
  import {
    browserRuntime,
    reportRuntimeError,
    RuntimeUIState,
  } from "src/ts/runtime/browserRuntimeState.svelte";

  let {
    target,
    value,
    children,
  }: {
    target: FieldTarget;
    value: unknown;
    children: Snippet<
      [
        {
          value: any;
          capture: () => { value: any; commit: (value: unknown) => void };
        },
      ]
    >;
  } = $props();
  // The parent keys this owner by stable entity ID. Legacy editors may mutate
  // every nested level, but must never receive the projection or outbox object.
  const owner = untrack(() => fieldTarget(target));
  let submitted = untrack(() => commandJson(getFieldValue(owner, value) ?? []));
  let header = untrack(() => browserRuntime().fieldHeader(owner));
  let draft = $state({ value: JSON.parse(submitted), capture });

  function publish(desired: string, expected = header) {
    browserRuntime().setField(owner, JSON.parse(desired), expected);
    submitted = desired;
  }
  function flush() {
    const desired = commandJson(draft.value);
    if (desired === submitted) return;
    try {
      publish(desired);
    } catch (error) {
      // A synchronous rejection is visible once, rather than retried on render.
      submitted = desired;
      reportRuntimeError(error);
    }
  }
  function capture() {
    const original = commandJson(draft.value),
      expected = { ...header };
    return {
      value: JSON.parse(original),
      commit(value: unknown) {
        const current = browserRuntime().fieldHeader(owner);
        if (
          commandJson(draft.value) !== original ||
          current.revision !== expected.revision ||
          current.epoch !== expected.epoch
        )
          throw new Error("The script changed while importing; try again");
        const desired = commandJson(value);
        if (desired !== original) {
          publish(desired, expected);
          draft.value = JSON.parse(desired);
        }
      },
    };
  }
  $effect.pre(() => {
    const incoming = commandJson(getFieldValue(owner, value) ?? []);
    const incomingHeader = browserRuntime().fieldHeader(owner);
    untrack(() => {
      // A peer projection arriving in the same flush must not erase a user's
      // already changed draft or replace the revision against which it was read.
      if (commandJson(draft.value) !== submitted) return;
      header = incomingHeader;
      submitted = incoming;
      if (commandJson(draft.value) !== incoming)
        draft.value = JSON.parse(incoming);
    });
  });
  $effect.pre(() => {
    // An equal value may have a newer clock. Compare cheap metadata separately
    // so unrelated journal/job events do not serialize a large script array.
    RuntimeUIState.displayScopeRevision;
    const incomingHeader = browserRuntime().fieldHeader(owner);
    untrack(() => {
      if (
        incomingHeader.revision === header.revision &&
        incomingHeader.epoch === header.epoch
      )
        return;
      if (commandJson(draft.value) === submitted) header = incomingHeader;
    });
  });
  $effect(() => {
    commandJson(draft.value);
    untrack(flush);
  });
  // Navigation in the input event must still enqueue the old owner's last edit.
  onDestroy(flush);
</script>

<div data-runtime-object-field={owner.key}>
  {@render children(draft)}
</div>
