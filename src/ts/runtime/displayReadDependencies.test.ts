import { expect, test } from "vitest";
import { mergeDisplayReads } from "./displayReadDependencies";

test("joint Lua/outside read revisions must agree and the original proposal stays unchanged", () => {
  const read = { scope: "global" as const, key: "source", expectedRevision: 2 };
  const command = { type: "apply-display-effects", reads: [read], edits: [] };
  expect(() =>
    mergeDisplayReads(command, { reads: [{ ...read, expectedRevision: 1 }] }),
  ).toThrow(/versions differ/);
  expect(command.reads).toEqual([read]);
  const joined = mergeDisplayReads(command, {
    reads: [read, { scope: "global", key: "missing", expectedRevision: 0 }],
  });
  expect(joined.reads).toHaveLength(2);
  expect(command.reads).toHaveLength(1);
});

test("joint read count and UTF8 proposal byte limits retain the existing server budgets", () => {
  const reads = Array.from({ length: 128 }, (_, i) => ({
    scope: "global" as const,
    key: "synthetic_" + i,
    expectedRevision: 0,
  }));
  const command = { type: "apply-display-effects", reads, edits: [] };
  expect(mergeDisplayReads(command, { reads: [reads[0]] }).reads).toHaveLength(
    128,
  );
  expect(() =>
    mergeDisplayReads(command, {
      reads: [{ scope: "global", key: "extra", expectedRevision: 0 }],
    }),
  ).toThrow(/128 variables/);
  expect(() =>
    mergeDisplayReads({
      ...command,
      edits: [
        {
          scope: "chat",
          chatId: "a",
          key: "$large",
          expectedRevision: 0,
          value: "한".repeat(90000),
        },
      ],
    }),
  ).toThrow(/256 KiB/);
});
