"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createWygloreJobContext } = require("./wygloreJobContext.cjs");

const marker = (content) => ({ key: "__wl_marker__", content, enabled: false });

function fixture() {
  let chat = {
    id: "chat",
    name: "Synthetic chat",
    message: [
      { chatId: "input", role: "user", data: "Public synthetic input" },
    ],
    scriptstate: { $main: "original" },
    localLore: [
      { key: "ordinary", content: "Synthetic lore" },
      { key: "legacy", comment: "wl.marker.v1", content: "old" },
    ],
    associationTree: { version: 1, units: ["original"] },
  };
  let writes = 0;
  let mainFailure;
  const database = { aiModel: "synthetic" };
  const main = {
    ensureHealthy() {
      if (mainFailure) throw mainFailure;
    },
    fail(message) {
      mainFailure ??= new Error(message);
      throw mainFailure;
    },
    getCurrentChat: () => chat,
    getCurrentCharacter: () => ({
      chaId: "character",
      chatPage: 0,
      chats: [chat],
    }),
    getDatabase: () => database,
    readResourceValue: (value) => value,
    cloneResourceValue: (value) => structuredClone(value),
    setCurrentChat(next) {
      writes++;
      chat = next;
    },
  };
  return {
    main,
    adapter: createWygloreJobContext(main),
    current: () => chat,
    writes: () => writes,
    database,
  };
}

test("legacy marker changes stay private and merge beside current main messages and Lua state", () => {
  const f = fixture();
  const { context, commit } = f.adapter;
  const read = context.clonePluginChat();
  read.localLore[1] = marker("new");
  context.stagePluginChat(read);
  assert.equal(f.current().localLore[1].content, "old");
  assert.equal(context.getCurrentChat().localLore[1].content, "new");
  assert.equal(f.writes(), 0);

  f.current().message.push({
    chatId: "answer",
    role: "char",
    data: "Completed answer",
  });
  f.current().scriptstate.$main = "Lua completed";
  f.current().localLore.unshift({ key: "lua", content: "Lua added this" });
  const result = commit();
  assert.deepEqual(result.fields, ["markers"]);
  assert.equal(f.writes(), 1);
  assert.equal(f.current().message.at(-1).data, "Completed answer");
  assert.equal(f.current().scriptstate.$main, "Lua completed");
  assert.equal(f.current().localLore[0].key, "lua");
  assert.equal(
    f.current().localLore.find((row) => row.key === "__wl_marker__").content,
    "new",
  );
});

test("a stale marker-only write does not restore an older staged embedded snapshot", () => {
  const f = fixture();
  const oldRead = f.adapter.context.clonePluginChat();
  const embedRead = f.adapter.context.clonePluginChat();
  embedRead.associationTree = { version: 1, units: ["updated"] };
  f.adapter.context.stagePluginChat(embedRead);
  oldRead.localLore[1] = marker("new marker");
  f.adapter.context.stagePluginChat(oldRead);
  assert.deepEqual(f.adapter.context.getCurrentChat().associationTree.units, [
    "updated",
  ]);
  assert.deepEqual(f.current().associationTree.units, ["original"]);
  f.adapter.commit();
  assert.deepEqual(f.current().associationTree.units, ["updated"]);
  assert.equal(f.current().localLore[1].content, "new marker");
  assert.equal(f.writes(), 1);
});

test("a marker-only commit preserves an independently changed main embedded snapshot", () => {
  const f = fixture();
  const read = f.adapter.context.clonePluginChat();
  read.localLore[1] = marker("new");
  f.adapter.context.stagePluginChat(read);
  f.current().associationTree = { units: ["main Lua changed this"] };
  f.adapter.commit();
  assert.deepEqual(f.current().associationTree.units, [
    "main Lua changed this",
  ]);
});

test("embedded snapshots can be added or removed without replacing the main chat", () => {
  const f = fixture();
  const read = f.adapter.context.clonePluginChat();
  delete read.associationTree;
  f.adapter.context.stagePluginChat(read);
  assert.equal(
    Object.hasOwn(f.adapter.context.getCurrentChat(), "associationTree"),
    false,
  );
  assert.equal(Object.hasOwn(f.current(), "associationTree"), true);
  f.adapter.commit();
  assert.equal(Object.hasOwn(f.current(), "associationTree"), false);
  assert.equal(f.current().message.length, 1);
});

test("marker removal preserves ordinary lore rows", () => {
  const f = fixture();
  const read = f.adapter.context.clonePluginChat();
  read.localLore = read.localLore.filter((row) => row.key === "ordinary");
  f.adapter.context.stagePluginChat(read);
  f.adapter.commit();
  assert.deepEqual(f.current().localLore, [
    { key: "ordinary", content: "Synthetic lore" },
  ]);
});

for (const [name, change] of [
  [
    "messages",
    (chat) => {
      chat.message[0].data = "Forbidden replacement";
    },
  ],
  [
    "script variables",
    (chat) => {
      chat.scriptstate.$main = "Forbidden replacement";
    },
  ],
  [
    "chat metadata",
    (chat) => {
      chat.name = "Forbidden replacement";
    },
  ],
  [
    "ordinary lore",
    (chat) => {
      chat.localLore[0].content = "Forbidden replacement";
    },
  ],
]) {
  test(`plugin writes cannot alter ${name}`, () => {
    const f = fixture();
    const original = structuredClone(f.current());
    const read = f.adapter.context.clonePluginChat();
    read.localLore[1] = marker("must not commit");
    change(read);
    assert.throws(() => f.adapter.context.stagePluginChat(read), {
      code: "PLUGIN_JOB_CONTEXT_INVALID_WRITE",
    });
    assert.throws(() => f.adapter.commit());
    assert.deepEqual(f.current(), original);
    assert.equal(f.writes(), 0);
  });
}

test("discard drops both overlays and never fails or changes the main context", () => {
  const f = fixture();
  const original = structuredClone(f.current());
  const read = f.adapter.context.clonePluginChat();
  read.localLore[1] = marker("pending");
  read.associationTree = { units: ["pending"] };
  f.adapter.context.stagePluginChat(read);
  f.adapter.discard();
  f.adapter.discard();
  assert.throws(() => f.adapter.commit(), {
    code: "PLUGIN_JOB_CONTEXT_CLOSED",
  });
  assert.doesNotThrow(() => f.main.ensureHealthy());
  assert.deepEqual(f.current(), original);
  assert.equal(f.writes(), 0);
});

for (const field of ["markers", "associationTree"]) {
  test(`commit rejects a main ${field} collision before applying any overlay`, () => {
    const f = fixture();
    const read = f.adapter.context.clonePluginChat();
    read.localLore[1] = marker("plugin");
    read.associationTree = { units: ["plugin"] };
    f.adapter.context.stagePluginChat(read);
    if (field === "markers") f.current().localLore[1] = marker("main Lua");
    else f.current().associationTree = { units: ["main Lua"] };
    const original = structuredClone(f.current());
    assert.throws(() => f.adapter.commit(), {
      code: "PLUGIN_JOB_CONTEXT_CONFLICT",
    });
    assert.deepEqual(f.current(), original);
    assert.equal(f.writes(), 0);
  });
}

test("a returned character's nested current chat retains write provenance", () => {
  const f = fixture();
  // Match getCharacter's extra host clone and explicit tracking hook.
  const character = f.adapter.context.trackPluginCharacter(
    structuredClone(f.adapter.context.getCurrentCharacter()),
  );
  character.chats[0].localLore[1] = marker("nested");
  f.adapter.context.stagePluginChat(character.chats[0]);
  f.adapter.commit();
  assert.equal(f.current().localLore[1].content, "nested");
});

test("a known host clone can use unambiguous issued fingerprints", () => {
  const f = fixture();
  const read = structuredClone(f.adapter.context.clonePluginChat());
  read.localLore[1] = marker("cloned");
  f.adapter.context.stagePluginChat(read);
  f.adapter.commit();
  assert.equal(f.current().localLore[1].content, "cloned");
});

test("an ambiguous cloned old read cannot reverse a more recent plugin overlay", () => {
  const f = fixture();
  const old = structuredClone(f.adapter.context.clonePluginChat());
  const next = f.adapter.context.clonePluginChat();
  next.associationTree = { units: ["newer"] };
  f.adapter.context.stagePluginChat(next);
  f.adapter.context.clonePluginChat();
  old.localLore[1] = marker("cloned old marker");
  assert.throws(() => f.adapter.context.stagePluginChat(old), {
    code: "PLUGIN_JOB_CONTEXT_CONFLICT",
  });
  assert.equal(f.writes(), 0);
});

test("plugin failures are sticky and local while main failures remain strict", () => {
  const f = fixture();
  let first;
  try {
    f.adapter.context.fail("Synthetic plugin failure");
  } catch (error) {
    first = error;
  }
  assert.ok(first);
  assert.throws(
    () => f.adapter.context.ensureHealthy(),
    (error) => error === first,
  );
  assert.doesNotThrow(() => f.main.ensureHealthy());
  let main;
  try {
    f.main.fail("Synthetic main failure");
  } catch (error) {
    main = error;
  }
  assert.throws(
    () => f.adapter.context.ensureHealthy(),
    (error) => error === main,
  );
  assert.equal(f.writes(), 0);
});

test("read helpers preserve main resource identity and no-op completion performs no write", () => {
  const f = fixture();
  assert.equal(f.adapter.context.getDatabase(), f.database);
  assert.equal(f.adapter.context.readResourceValue(f.database), f.database);
  assert.deepEqual(f.adapter.context.cloneResourceValue({ value: 1 }), {
    value: 1,
  });
  assert.deepEqual(f.adapter.commit().fields, []);
  assert.equal(f.writes(), 0);
});
