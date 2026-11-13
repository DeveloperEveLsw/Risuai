"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const code = (expected) => (error) => error.code === expected;
const memoryTarget = { scope: "chat", entityId: "a", key: "hypaV3Data" };
function fixture(t, file = ":memory:") {
  const store = new EntityStore(file);
  t.after(() => {
    try {
      store.close();
    } catch {}
  });
  store.applyCommand("c", {
    type: "create-character",
    characterId: "c",
    definition: {
      type: "character",
      name: "Synthetic",
      firstMessage: "Synthetic greeting",
    },
  });
  for (const chatId of ["a", "b"])
    store.applyCommand(chatId, {
      type: "create-chat",
      chatId,
      characterId: "c",
      metadata: {
        name: chatId,
        hypaV3Data: {
          extra: { kept: true },
          categories: [{ id: "category", name: "Synthetic" }],
          summaries: [
            {
              text: "First",
              chatMemos: [null, "m"],
              isImportant: true,
              categoryId: "category",
              tags: ["tag"],
              extra: { unknown: 1 },
            },
            { text: "Second", chatMemos: ["m", "n"], isImportant: false },
            { text: "Third", chatMemos: [], isImportant: false },
          ],
        },
      },
    });
  store.applyCommand("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 0,
    payload: { synthetic: true },
  });
  let serial = 0;
  const change = (target, value) => {
    const field = store.readFields([target]).fields[0];
    return store.applyCommand("edit" + ++serial, {
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedEpoch: field.entityEpoch,
          expectedRevision: field.revision,
          value,
        },
      ],
    });
  };
  const command = (mode = "single", indices = [0]) => {
    const field = store.readFields([memoryTarget]).fields[0];
    return {
      type: "memory-summary",
      chatId: "a",
      expectedChatEpoch: field.entityEpoch,
      expectedMemoryRevision: field.revision,
      mode,
      indices,
    };
  };
  const claim = (id = "summary", cmd = command()) => {
    store.enqueueJob(id, cmd);
    return store.claimJob("worker");
  };
  const outcome = (run) => ({
    state: "completed",
    writeSet: {
      chatId: "a",
      expectedRevision: run.snapshot.chat.revision,
      expectedContentRevision: run.snapshot.chat.contentRevision,
      characterReads: [],
      resources: [],
      characters: [],
      messages: [],
      deleteMessages: [],
      variables: [],
      deleteVariables: [],
    },
    result: {
      memoryPreview: {
        text: "Synthetic paid summary",
        mode: run.command.mode,
        indices: run.command.indices,
        chatMemos: [
          ...new Set(
            run.command.indices.flatMap(
              (index) =>
                run.snapshot.chat.metadata.hypaV3Data.summaries[index]
                  .chatMemos,
            ),
          ),
        ],
        source: {
          chatEpoch: run.snapshot.chat.entityEpoch,
          memoryRevision: run.command.expectedMemoryRevision,
          contentRevision: run.snapshot.chat.contentRevision,
          characterId: run.snapshot.character.id,
          characterRevision: run.snapshot.character.revision,
          characterEpoch: run.snapshot.character.entityEpoch,
          resources: run.snapshot.resources
            .filter((row) => row.kind !== "global-variable")
            .map((row) => ({
              kind: row.kind,
              id: row.id,
              revision: row.revision,
              epoch: row.entityEpoch,
            })),
        },
      },
    },
  });
  const complete = (run) =>
    store.finishJob(run.job.id, "worker", run.job.fence, outcome(run));
  const act = (
    type = "apply-memory-summary",
    jobId = "summary",
    requestId = "apply",
  ) =>
    store.applyCommand(requestId, {
      type,
      jobId,
      chatId: "a",
      expectedChatEpoch: 0,
    });
  return { store, change, command, claim, outcome, complete, act };
}
test("completed calculation keeps a preview without editing summaries; apply preserves original unknown fields and is idempotent", (t) => {
  const f = fixture(t),
    before = f.store.snapshot("a").chat.metadata.hypaV3Data;
  const run = f.claim();
  f.complete(run);
  assert.deepEqual(f.store.snapshot("a").chat.metadata.hypaV3Data, before);
  assert.equal(f.store.previewMemorySummary("summary").canApply, true);
  assert.equal(f.store.listJobs("a")[0].memoryPreviewAvailable, true);
  assert.equal(
    f.store.getJobStatus("summary").result.memoryPreviewAvailable,
    1,
  );
  f.act();
  const after = f.store.snapshot("a").chat.metadata.hypaV3Data;
  assert.deepEqual(after, {
    ...before,
    summaries: [
      { ...before.summaries[0], text: "Synthetic paid summary" },
      ...before.summaries.slice(1),
    ],
  });
  const cursor = f.store.cursor();
  f.act();
  assert.equal(f.store.cursor(), cursor);
  assert.equal(
    f.act("apply-memory-summary", "summary", "another").alreadyApplied,
    true,
  );
  assert.equal(f.store.listJobs("a")[0].memoryPreviewAvailable, false);
});
test("bulk preview merges only the selected summaries and unique memos while retaining first summary traits", (t) => {
  const f = fixture(t);
  f.complete(f.claim("summary", f.command("bulk", [0, 2])));
  f.act();
  const summaries = f.store.snapshot("a").chat.metadata.hypaV3Data.summaries;
  assert.equal(summaries.length, 2);
  assert.equal(summaries[1].text, "Second");
  assert.deepEqual(summaries[0].chatMemos, [null, "m"]);
  assert.deepEqual(summaries[0].extra, { unknown: 1 });
  assert.equal(summaries[0].isImportant, true);
  assert.equal(summaries[0].categoryId, "category");
});
test("discard is durable and cannot later apply the same paid preview", (t) => {
  const f = fixture(t);
  f.complete(f.claim());
  f.act("dismiss-memory-summary");
  assert.equal(
    f.store.previewMemorySummary("summary").disposition.action,
    "dismiss",
  );
  assert.equal(
    f.act("apply-memory-summary", "summary", "later").alreadyApplied,
    true,
  );
  assert.equal(
    f.store.snapshot("a").chat.metadata.hypaV3Data.summaries[0].text,
    "First",
  );
});
test("stale and malformed selections are rejected before admission with no leaked command", (t) => {
  const f = fixture(t);
  const command = f.command();
  for (const indices of [[], [1, 0], [0, 0], [99], [-1]])
    assert.throws(
      () => f.store.enqueueJob("bad" + indices, { ...command, indices }),
      code("INVALID_COMMAND"),
    );
  f.change(memoryTarget, { summaries: [] });
  assert.throws(
    () => f.store.enqueueJob("stale", command),
    code("REVISION_CONFLICT"),
  );
  assert.equal(f.store.getJob("stale"), null);
  assert.equal(
    f.store.db.prepare("SELECT 1 FROM commands WHERE id='stale'").get(),
    undefined,
  );
});
for (const mutation of ["memory", "content", "character", "configuration"])
  test(`source ${mutation} edits during calculation reject completion and roll back all effects`, (t) => {
    const f = fixture(t),
      run = f.claim();
    if (mutation === "memory") f.change(memoryTarget, { summaries: [] });
    if (mutation === "content") {
      f.store.db
        .prepare(
          "UPDATE chats SET content_revision=content_revision+1 WHERE id='a'",
        )
        .run();
    }
    if (mutation === "character")
      f.change({ scope: "character", entityId: "c", key: "name" }, "Changed");
    if (mutation === "configuration")
      f.change(
        {
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key: "synthetic",
        },
        false,
      );
    assert.throws(() => f.complete(run), code("REVISION_CONFLICT"));
    assert.equal(f.store.getJob("summary").state, "running");
    assert.throws(
      () => f.store.previewMemorySummary("summary"),
      code("RESULT_UNAVAILABLE"),
    );
  });
test("memory ABA prevents apply while keeping the paid result readable", (t) => {
  const f = fixture(t);
  f.complete(f.claim());
  const original = f.store.snapshot("a").chat.metadata.hypaV3Data;
  f.change(memoryTarget, { summaries: [] });
  f.change(memoryTarget, original);
  assert.equal(
    f.store.previewMemorySummary("summary").blocked.code,
    "REVISION_CONFLICT",
  );
  assert.throws(() => f.act(), code("REVISION_CONFLICT"));
  assert.equal(
    f.store.previewMemorySummary("summary").text,
    "Synthetic paid summary",
  );
});
test("application targets only the stored chat; caller supplied output is rejected", (t) => {
  const f = fixture(t);
  f.complete(f.claim());
  assert.throws(
    () =>
      f.store.applyCommand("wrong-owner", {
        type: "apply-memory-summary",
        jobId: "summary",
        chatId: "b",
        expectedChatEpoch: 0,
      }),
    code("IDENTITY_CONFLICT"),
  );
  assert.throws(
    () =>
      f.store.applyCommand("injected", {
        type: "apply-memory-summary",
        jobId: "summary",
        chatId: "a",
        expectedChatEpoch: 0,
        text: "injected",
      }),
    code("INVALID_COMMAND"),
  );
  assert.equal(
    f.store.snapshot("b").chat.metadata.hypaV3Data.summaries[0].text,
    "First",
  );
});
test("reopening the SQLite store retains preview, applied disposition and idempotent receipts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "risu-memory-preview-")),
    file = join(dir, "state.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(t, file);
  f.complete(f.claim());
  f.store.close();
  let store = new EntityStore(file);
  assert.equal(
    store.previewMemorySummary("summary").text,
    "Synthetic paid summary",
  );
  const cmd = {
    type: "apply-memory-summary",
    jobId: "summary",
    chatId: "a",
    expectedChatEpoch: 0,
  };
  store.applyCommand("apply", cmd);
  store.close();
  store = new EntityStore(file);
  t.after(() => store.close());
  assert.equal(
    store.previewMemorySummary("summary").disposition.action,
    "apply",
  );
  assert.equal(store.applyCommand("again", cmd).alreadyApplied, true);
});

for (const mode of ["single", "bulk"])
  test(`${mode} apply accepts user-edited text but preserves the paid output and server-owned selection`, (t) => {
    const f = fixture(t);
    const before = f.store.snapshot("a").chat.metadata.hypaV3Data;
    f.complete(
      f.claim("summary", f.command(mode, mode === "bulk" ? [0, 2] : [0])),
    );
    const command = {
      type: "apply-memory-summary",
      jobId: "summary",
      chatId: "a",
      expectedChatEpoch: 0,
      editedText: "User edited the generated result",
    };
    f.store.applyCommand("edited", command);
    const after = f.store.snapshot("a").chat.metadata.hypaV3Data;
    assert.deepEqual(after.extra, before.extra);
    assert.deepEqual(after.categories, before.categories);
    assert.deepEqual(after.summaries[0], {
      ...before.summaries[0],
      text: command.editedText,
    });
    assert.deepEqual(
      after.summaries.slice(1),
      mode === "bulk" ? [before.summaries[1]] : before.summaries.slice(1),
    );
    const preview = f.store.previewMemorySummary("summary");
    assert.equal(preview.text, "Synthetic paid summary");
    assert.equal(preview.appliedText, command.editedText);
    assert.equal(preview.disposition.edited, true);
    assert.equal(preview.canApply, false);
    const cursor = f.store.cursor();
    f.store.applyCommand("edited", command);
    assert.equal(f.store.cursor(), cursor);
    assert.throws(
      () =>
        f.store.applyCommand("edited", {
          ...command,
          editedText: "Different duplicate",
        }),
      code("IDEMPOTENCY_CONFLICT"),
    );
  });

test("editing a preview never bypasses source ABA, and rejection leaves the edited memory and paid result intact", (t) => {
  const f = fixture(t);
  f.complete(f.claim());
  const original = f.store.snapshot("a").chat.metadata.hypaV3Data;
  f.change(memoryTarget, { summaries: [] });
  f.change(memoryTarget, original);
  const cursor = f.store.cursor();
  assert.throws(
    () =>
      f.store.applyCommand("stale-edit", {
        type: "apply-memory-summary",
        jobId: "summary",
        chatId: "a",
        expectedChatEpoch: 0,
        editedText: "Must not apply",
      }),
    code("REVISION_CONFLICT"),
  );
  assert.equal(f.store.cursor(), cursor);
  assert.deepEqual(f.store.snapshot("a").chat.metadata.hypaV3Data, original);
  assert.equal(
    f.store.previewMemorySummary("summary").text,
    "Synthetic paid summary",
  );
  assert.equal(f.store.previewMemorySummary("summary").disposition, undefined);
  assert.equal(
    f.store.db.prepare("SELECT id FROM commands WHERE id='stale-edit'").get(),
    undefined,
  );
});

test("invalid edited payloads and caller-owned selections leave no receipt or partial disposition", (t) => {
  const f = fixture(t);
  f.complete(f.claim());
  const base = {
    type: "apply-memory-summary",
    jobId: "summary",
    chatId: "a",
    expectedChatEpoch: 0,
  };
  const invalid = [
    { ...base, editedText: "" },
    { ...base, editedText: null },
    { ...base, editedText: 7 },
    { ...base, editedText: "Edited", indices: [1] },
    { ...base, editedText: "Edited", chatMemos: ["injected"] },
    { ...base, type: "dismiss-memory-summary", editedText: "Edited" },
  ];
  const cursor = f.store.cursor();
  invalid.forEach((command, i) => {
    assert.throws(
      () => f.store.applyCommand("invalid-edit-" + i, command),
      code("INVALID_COMMAND"),
    );
    assert.equal(
      f.store.db
        .prepare("SELECT id FROM commands WHERE id=?")
        .get("invalid-edit-" + i),
      undefined,
    );
  });
  assert.equal(f.store.cursor(), cursor);
  assert.equal(f.store.previewMemorySummary("summary").canApply, true);
  assert.equal(
    f.store.snapshot("a").chat.metadata.hypaV3Data.summaries[0].text,
    "First",
  );
});
