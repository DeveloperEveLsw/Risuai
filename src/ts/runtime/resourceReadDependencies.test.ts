// @vitest-environment node
import { expect, test } from "vitest";
import { createExecutionContext } from "./executionContext";
import { createModuleRuntime } from "../process/moduleRuntime";
import { fixture, claim } from "./testFixtures";

test("selected modules and bound persona record identities without unrelated serialization reads", () => {
  const store = fixture();
  try {
    const { job, snapshot } = claim(store),
      context = createExecutionContext(snapshot, { jobId: job.id });
    expect(context.writeSet().resourceReads).toEqual([
      { kind: "settings", id: "global", expectedEpoch: 0 },
    ]);
    const modules = createModuleRuntime({ ...context, ...context.util });
    const selected = modules.getModules();
    expect(selected[0]).toBe(context.getDatabase().modules[0]);
    expect(context.util.getPersonaPrompt()).toBe("synthetic persona");
    expect(modules.getModuleById("module")).toBe(selected[0]);
    const reads = context.writeSet().resourceReads!;
    expect(reads).toHaveLength(3);
    expect(reads).toContainEqual({
      kind: "module",
      id: "module",
      expectedEpoch: 0,
    });
    expect(reads).toContainEqual({
      kind: "persona",
      id: "persona",
      expectedEpoch: 0,
    });
    const clone = structuredClone(selected);
    expect(context.readResourceValue(clone)).toBe(clone);
    expect(context.writeSet().resourceReads).toEqual(reads);
    expect(context.writeSet().resources).toEqual([]);
  } finally {
    store.close();
  }
});

test("display resource selection keeps original object identity and cannot persist", () => {
  const store = fixture();
  try {
    const context = createExecutionContext(claim(store).snapshot, {
      jobId: "display",
      mode: "display",
    });
    const modules = createModuleRuntime({ ...context, ...context.util });
    expect(modules.getModules()[0]).toBe(context.getDatabase().modules[0]);
    expect(context.util.getUserName()).toBe("Bound");
    context.ensureHealthy();
    expect(() => context.writeSet()).toThrow("Display contexts cannot commit");
    expect(store.snapshot("a").messages.at(-1).message.data).toBe("before");
  } finally {
    store.close();
  }
});

for (const copy of [
  "record",
  "array",
  "database-snapshot",
  "repeated-copy",
] as const)
  test(`an explicitly selected ${copy} retains its resource lifetime after copying`, () => {
    const store = fixture({ settings: { enabledModules: [] } });
    try {
      const { job, snapshot } = claim(store);
      // Whole database serialization is allowed only inside this one-character
      // admission; other characters keep their cross-chat history barrier.
      snapshot.characterIndex = snapshot.characterIndex.filter(
        (row: any) => row.id === "c",
      );
      const context = createExecutionContext(snapshot, { jobId: job.id });
      const clone = context.cloneResourceValue;
      const original = context.getDatabase().modules[0];
      const copied =
        copy === "record"
          ? clone(original)
          : copy === "array"
            ? clone(context.getDatabase().modules)[0]
            : copy === "database-snapshot"
              ? context.getDatabase({ snapshot: true }).modules[0]
              : clone(clone(context.getDatabase({ snapshot: true })))
                  .modules[0];
      expect(copied).not.toBe(original);
      expect(copied).toEqual(original);
      expect(context.writeSet().resourceReads).not.toContainEqual({
        kind: "module",
        id: "module",
        expectedEpoch: 0,
      });
      expect(context.readResourceValue(copied)).toBe(copied);
      expect(context.writeSet().resourceReads).toContainEqual({
        kind: "module",
        id: "module",
        expectedEpoch: 0,
      });
      context.variables.setChatVar("derived", copied.description);
      const previous = store.getResource("module", "module");
      store.applyCommand("peer-delete", {
        type: "delete-library-resource",
        kind: "module",
        resourceId: "module",
        expectedRevision: previous.revision,
        expectedEpoch: previous.entityEpoch,
      });
      const before = store.snapshot("a"),
        cursor = store.cursor();
      expect(() =>
        store.finishJob(job.id, "worker", job.fence, {
          state: "completed",
          writeSet: context.writeSet(),
        }),
      ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
      expect(store.snapshot("a")).toEqual(before);
      expect(store.cursor()).toBe(cursor);
    } finally {
      store.close();
    }
  });

test("copying and selecting one resource does not consume other copied rows or forged identities", () => {
  const store = fixture({ settings: { enabledModules: [] } });
  try {
    store.applyCommand("unused", {
      type: "put-resource",
      kind: "module",
      resourceId: "unused",
      expectedRevision: 0,
      payload: { id: "unused", name: "Unused" },
    });
    const { job, snapshot } = claim(store),
      context = createExecutionContext(snapshot, { jobId: job.id });
    const copied = context.cloneResourceValue(context.getDatabase().modules);
    context.readResourceValue({ id: "module", name: "Forged" });
    expect(context.writeSet().resourceReads).toHaveLength(1);
    const selected = copied.find((row) => row.id === "module")!;
    context.readResourceValue(selected);
    selected.id = "unused"; // Provenance belongs to the copied row, not a caller-supplied ID.
    context.readResourceValue(selected);
    expect(context.writeSet().resourceReads).toEqual([
      { kind: "settings", id: "global", expectedEpoch: 0 },
      { kind: "module", id: "module", expectedEpoch: 0 },
    ]);
    store.applyCommand("delete-unused", {
      type: "delete-library-resource",
      kind: "module",
      resourceId: "unused",
      expectedRevision: 1,
      expectedEpoch: 0,
    });
    context.variables.setChatVar("derived", "captured");
    store.finishJob(job.id, "worker", job.fence, {
      state: "completed",
      writeSet: context.writeSet(),
    });
    expect(
      store.snapshot("a").variables.find((row: any) => row.key === "$derived")
        .value,
    ).toBe("captured");
  } finally {
    store.close();
  }
});

test("resource copy metadata does not invoke accessors twice or recurse through arbitrary payloads", () => {
  const store = fixture();
  try {
    const context = createExecutionContext(claim(store).snapshot, {
      jobId: "copy",
    });
    let accesses = 0;
    const array = context.getDatabase().modules;
    const original = array[0];
    Object.defineProperty(array, "0", {
      enumerable: true,
      configurable: true,
      get() {
        accesses++;
        return original;
      },
    });
    const copy = context.cloneResourceValue(array);
    expect(accesses).toBe(1);
    expect(copy[0]).toEqual(original);
    const nested = { row: original };
    const nestedCopy = context.cloneResourceValue(nested);
    expect(nestedCopy).toEqual(nested);
    context.readResourceValue(nestedCopy.row);
    expect(context.writeSet().resourceReads).toHaveLength(1);
    // Arbitrary graphs and accessor-returned rows still require a selector before copying.
    expect(() =>
      context.cloneResourceValue({ invalid: () => undefined }),
    ).toThrow();
  } finally {
    store.close();
  }
});

for (const recreate of [false, true])
  test(`a selected copied resource ${recreate ? "rejects recreation" : "merges same-incarnation payload edits"}`, () => {
    const store = fixture({ settings: { enabledModules: [] } });
    try {
      const { job, snapshot } = claim(store),
        context = createExecutionContext(snapshot, { jobId: job.id });
      const copied = context.cloneResourceValue(
        context.getDatabase().modules[0],
      );
      context.readResourceValue(copied);
      context.variables.setChatVar("derived", copied.description);
      const previous = store.getResource("module", "module");
      if (recreate)
        store.applyCommand("delete", {
          type: "delete-library-resource",
          kind: "module",
          resourceId: "module",
          expectedRevision: previous.revision,
          expectedEpoch: previous.entityEpoch,
        });
      store.applyCommand("peer", {
        type: "put-resource",
        kind: "module",
        resourceId: "module",
        expectedRevision: previous.revision + (recreate ? 1 : 0),
        payload: { ...previous.payload, description: "peer" },
      });
      const before = store.snapshot("a");
      const finish = () =>
        store.finishJob(job.id, "worker", job.fence, {
          state: "completed",
          writeSet: context.writeSet(),
        });
      if (recreate) {
        expect(finish).toThrowError(
          expect.objectContaining({ code: "REVISION_CONFLICT" }),
        );
        expect(store.snapshot("a")).toEqual(before);
      } else {
        finish();
        expect(
          store
            .snapshot("a")
            .variables.find((row: any) => row.key === "$derived").value,
        ).toBe("synthetic");
      }
      expect(store.getResource("module", "module").payload.description).toBe(
        "peer",
      );
    } finally {
      store.close();
    }
  });
