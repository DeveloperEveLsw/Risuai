<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { commandJson } from "src/ts/runtime/clientProtocol";

  let {
    value,
    onchange,
    children,
  }: {
    value: unknown;
    onchange: (value: any) => void;
    children: Snippet<[{ value: any }]>;
  } = $props();
  // Legacy collection editors mutate nested bindings. Give them one isolated field,
  // rather than a reference into the confirmed server projection or pending intent.
  let draft = $state({ value: untrack(() => JSON.parse(commandJson(value))) });
  let projected = $state(untrack(() => commandJson(value)));
  $effect(() => {
    const incoming = commandJson(value);
    if (incoming !== projected) {
      projected = incoming;
      untrack(() => {
        if (commandJson(draft.value) !== incoming)
          draft.value = JSON.parse(incoming);
      });
    }
  });
  $effect(() => {
    const desired = commandJson(draft.value);
    if (desired !== projected) untrack(() => onchange(JSON.parse(desired)));
  });
</script>

{@render children(draft)}
