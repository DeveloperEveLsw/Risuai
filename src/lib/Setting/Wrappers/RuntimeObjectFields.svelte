<script lang="ts">
  import { onDestroy, untrack, type Snippet } from "svelte";
  import { commandJson, type Json } from "src/ts/runtime/clientProtocol";
  import {
    fieldTarget,
    type FieldTarget,
    type DerivedFieldOptions,
  } from "src/ts/runtime/fieldCommands";
  import { getFieldValue } from "src/ts/runtime/fieldControls";
  import {
    browserRuntime,
    reportRuntimeError,
    RuntimeUIState,
  } from "src/ts/runtime/browserRuntimeState.svelte";

  let {
    targets,
    values,
    children,
    dependencyGroups = [],
  }: {
    targets: Record<string, FieldTarget>;
    values: Record<string, unknown>;
    dependencyGroups?: string[][];
    children: Snippet<
      [
        {
          values: any;
          capture: (names: string[]) => {
            values: any;
            headers: Record<string, { revision: number; epoch: number }>;
            commit: (
              values: Record<string, unknown>,
              guardAll?: boolean,
              dependencies?: DerivedFieldOptions,
            ) => void;
          };
        },
      ]
    >;
  } = $props();
  // The parent keys all owners by stable IDs. Optional fields retain absence,
  // while nested legacy editors receive only independent mutable copies.
  const owners = untrack(() =>
    Object.fromEntries(
      Object.entries(targets).map(([key, target]) => [
        key,
        fieldTarget(target),
      ]),
    ),
  );
  const names = Object.keys(owners);
  const groups = untrack(() => dependencyGroups.map((group) => [...group]));
  for (const group of groups)
    if (
      group.length < 2 ||
      new Set(group).size !== group.length ||
      group.some((key) => !owners[key])
    )
      throw new Error("Invalid field dependency group");
  function expandDependencies(selected: string[]) {
    const result = new Set(selected);
    let changed = true;
    while (changed) {
      changed = false;
      for (const group of groups)
        if (group.some((key) => result.has(key)))
          for (const key of group)
            if (!result.has(key)) {
              result.add(key);
              changed = true;
            }
    }
    return [...result];
  }
  const encode = (value: unknown) =>
    value === undefined ? "absent" : commandJson(value);
  const decode = (value: string): Json | undefined =>
    value === "absent" ? undefined : JSON.parse(value);
  let submitted = untrack(() =>
    Object.fromEntries(
      names.map((key) => [
        key,
        encode(getFieldValue(owners[key], values[key])),
      ]),
    ),
  );
  let headers = untrack(() =>
    Object.fromEntries(
      names.map((key) => [key, browserRuntime().fieldHeader(owners[key])]),
    ),
  );
  let draft = $state({
    values: Object.fromEntries(
      names.map((key) => [key, decode(submitted[key])]),
    ) as any,
    capture,
  });
  // Keep one reactive encoder per field. The outer values record may be rebuilt
  // after any projection, so separate its cheap value read from serialization.
  // Nested proxy reads still invalidate the encoder for the edited object/array.
  const serializers = Object.fromEntries(
    names.map((key) => {
      // Read-model reconciliation can preserve an object's identity. A confirmed
      // field clock must invalidate its current encoding even when the incoming
      // object reference is stable. Equal clocks keep unrelated progress cheap.
      const version = $derived.by(() => {
        RuntimeUIState.displayScopeRevision;
        const clock = browserRuntime().fieldHeader(owners[key]);
        return `${clock.revision}:${clock.epoch}`;
      });
      const source = $derived.by(() => {
        version;
        return getFieldValue(owners[key], values[key]);
      });
      const incoming = $derived.by(() => {
        version;
        return encode(source);
      });
      const desired = $derived.by(() => encode(draft.values[key]));
      return [key, { incoming: () => incoming, draft: () => desired }];
    }),
  );
  function publish(
    changed: string[],
    desired: Record<string, string>,
    expected = headers,
    dependencies?: DerivedFieldOptions,
  ) {
    changed =
      dependencies?.checks?.length || dependencies?.groupImageSources
        ? changed
        : expandDependencies(changed);
    browserRuntime().setFields(
      changed.map((key) => ({
        target: owners[key],
        value: decode(desired[key] ?? serializers[key].draft()),
      })),
      changed.map((key) => expected[key]),
      dependencies,
    );
    for (const key of changed)
      submitted[key] = desired[key] ?? serializers[key].draft();
  }
  function flush() {
    const desired = Object.fromEntries(
      names.map((key) => [key, serializers[key].draft()]),
    );
    const changed = names.filter((key) => desired[key] !== submitted[key]);
    if (!changed.length) return;
    try {
      publish(changed, desired);
    } catch (error) {
      for (const key of changed) submitted[key] = desired[key];
      reportRuntimeError(error);
    }
  }
  function capture(selected: string[]) {
    if (
      !selected.length ||
      new Set(selected).size !== selected.length ||
      selected.some((key) => !owners[key])
    )
      throw new Error("Invalid captured fields");
    selected = expandDependencies(selected);
    const original = Object.fromEntries(
      selected.map((key) => [key, serializers[key].draft()]),
    );
    const expected = Object.fromEntries(
      selected.map((key) => [key, { ...headers[key] }]),
    );
    return {
      values: Object.fromEntries(
        selected.map((key) => [key, decode(original[key])]),
      ),
      headers: Object.fromEntries(
        selected.map((key) => [key, { ...expected[key] }]),
      ),
      commit(
        next: Record<string, unknown>,
        guardAll = false,
        dependencies?: DerivedFieldOptions,
      ) {
        for (const key of selected) {
          const current = browserRuntime().fieldHeader(owners[key]);
          if (
            serializers[key].draft() !== original[key] ||
            current.revision !== expected[key].revision ||
            current.epoch !== expected[key].epoch
          )
            throw new Error(
              "The edited fields changed while waiting; try again",
            );
        }
        const desired = Object.fromEntries(
          selected.map((key) => [key, encode(next[key])]),
        );
        const changed = selected.filter(
          (key) => desired[key] !== original[key],
        );
        if (!changed.length) return;
        // Unchanged read dependencies participate in the same server CAS.
        publish(guardAll ? selected : changed, desired, expected, dependencies);
        for (const key of changed) draft.values[key] = decode(desired[key]);
      },
    };
  }
  $effect.pre(() => {
    // Observe values separately from cheap clocks. Unrelated journal progress
    // must not cause serialization of every open lore collection.
    const incoming = Object.fromEntries(
      names.map((key) => [key, serializers[key].incoming()]),
    );
    const clocks = Object.fromEntries(
      names.map((key) => [key, browserRuntime().fieldHeader(owners[key])]),
    );
    untrack(() => {
      for (const key of names) {
        if (serializers[key].draft() !== submitted[key]) continue;
        headers[key] = clocks[key];
        submitted[key] = incoming[key];
        if (serializers[key].draft() !== incoming[key])
          draft.values[key] = decode(incoming[key]);
      }
    });
  });
  $effect.pre(() => {
    RuntimeUIState.displayScopeRevision;
    const clocks = Object.fromEntries(
      names.map((key) => [key, browserRuntime().fieldHeader(owners[key])]),
    );
    untrack(() => {
      for (const key of names) {
        if (
          clocks[key].revision === headers[key].revision &&
          clocks[key].epoch === headers[key].epoch
        )
          continue;
        if (serializers[key].draft() === submitted[key])
          headers[key] = clocks[key];
      }
    });
  });
  $effect(() => {
    for (const key of names) serializers[key].draft();
    untrack(flush);
  });
  onDestroy(flush);
</script>

{@render children(draft)}
