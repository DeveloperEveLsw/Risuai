import type { ExecutionSnapshot } from "./executionContext";

export type VariableRead = {
  scope: "chat" | "chat-global" | "global";
  key: string;
  expectedRevision: number;
  expectedExists: boolean;
};

/** Point reads use admission revisions, including absent/deleted keys, never result values. */
export function createVariableReadDependencies(
  source: ExecutionSnapshot,
  fail: (message: string) => never,
) {
  const versions = new Map<string, { revision: number; exists: boolean }>();
  const identity = (scope: VariableRead["scope"], key: string) =>
    JSON.stringify([scope, key]);
  for (const [scope, live, deleted] of [
    ["chat", source.variables, source.deletedVariables ?? []],
    [
      "chat-global",
      source.chatGlobalVariables ?? [],
      source.deletedChatGlobalVariables ?? [],
    ],
    [
      "global",
      (source.resources ?? [])
        .filter((row) => row.kind === "global-variable")
        .map((row) => ({ key: row.id, revision: row.revision })),
      (source.deletedResources ?? [])
        .filter((row) => row.kind === "global-variable")
        .map((row) => ({ key: row.id, revision: row.revision })),
    ],
  ] as const) {
    for (const row of deleted)
      versions.set(identity(scope, row.key), {
        revision: row.revision,
        exists: false,
      });
    for (const row of live)
      versions.set(identity(scope, row.key), {
        revision: row.revision,
        exists: true,
      });
  }
  const reads = new Map<string, VariableRead>();
  return {
    observe(scope: VariableRead["scope"], key: string) {
      if (typeof key !== "string" || !key || key.length > 256)
        fail(
          "Variable read key must be a nonempty string of at most 256 characters",
        );
      const id = identity(scope, key);
      if (reads.has(id)) return;
      if (reads.size >= 4096)
        fail("Variable read dependency limit exceeded (4096 distinct keys)");
      const version = versions.get(id) ?? { revision: 0, exists: false };
      reads.set(id, {
        scope,
        key,
        expectedRevision: version.revision,
        expectedExists: version.exists,
      });
    },
    snapshot: () => [...reads.values()].map((read) => ({ ...read })),
  };
}
