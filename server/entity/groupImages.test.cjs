"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EntityStore } = require("./store.cjs");
const target = (id, key) => ({ scope: "character", entityId: id, key });
const code = (n) => (e) => e.code === n;
function fixture(t, count = 150) {
  const store = new EntityStore(":memory:");
  t.after(() => store.close());
  let sequence = 0;
  const create = (id, definition) =>
    store.applyCommand("create-" + ++sequence + "-" + id, {
      type: "create-character",
      characterId: id,
      definition,
    });
  for (let i = 0; i < count; i++)
    create("m" + i, {
      type: "character",
      name: "Synthetic member " + i,
      image: "assets/seed-" + i + ".png",
      desc: "Authored private-shaped definition excluded from image responses",
      unrelated: { retain: true },
    });
  create("g", {
    type: "group",
    name: "Authored image group",
    characters: Array.from({ length: count }, (_, i) => "m" + i),
    image: "assets/before.png",
    ccAssets: [],
    unknown: { retain: true },
  });
  const edit = (id, key, value) => {
    const f = store.readFields([target(id, key)]).fields[0];
    return {
      ...target(id, key),
      expectedRevision: f.revision,
      expectedEpoch: f.entityEpoch,
      value,
    };
  };
  const change = (id, key, value) =>
    store.applyCommand("change-" + ++sequence, {
      type: "change-fields",
      edits: [edit(id, key, value)],
    });
  const command = (guard) => ({
    type: "change-fields",
    edits: [edit("g", "image", "assets/composite.png")],
    groupImageSources: guard,
  });
  return { store, create, edit, change, command };
}
test("150-member source pagination covers every image, keeps order and returns no source bodies", (t) => {
  const f = fixture(t),
    first = f.store.groupImageSources("g"),
    next = f.store.groupImageSources("g", first.nextOffset, first.guard);
  assert.equal(first.sources.length, 128);
  assert.equal(next.sources.length, 22);
  assert.equal(next.nextOffset, null);
  assert.deepEqual(
    [...first.sources, ...next.sources].map((x) => [
      x.memberId,
      x.position,
      x.image,
    ]),
    Array.from({ length: 150 }, (_, i) => [
      "m" + i,
      i,
      "assets/seed-" + i + ".png",
    ]),
  );
  assert.ok(!JSON.stringify(first).includes("private-shaped"));
  assert.equal(first.guard.digest.length, 64);
  assert.equal(f.store.bootstrap().groupImageSourcesVersion, 1);
  assert.equal(f.store.bootstrap().fieldReadChecksVersion, 1);
  assert.throws(
    () => f.store.groupImageSources("g", 128),
    code("INVALID_COMMAND"),
  );
  const command = f.command(first.guard);
  f.change("m149", "nickname", "Unrelated later name");
  const before = f.store.getCharacter("m149");
  const prepare = f.store.db.prepare.bind(f.store.db);
  f.store.db.prepare = (sql) => {
    const s = prepare(sql);
    if (/SELECT definition AS payload/.test(sql))
      return new Proxy(s, {
        get(o, key) {
          if (key === "get")
            return (...a) => {
              assert.equal(
                a[0],
                "g",
                "only the written group body may be loaded",
              );
              return o.get(...a);
            };
          const v = Reflect.get(o, key);
          return typeof v === "function" ? v.bind(o) : v;
        },
      });
    return s;
  };
  const result = f.store.applyCommand("composite", command);
  f.store.db.prepare = prepare;
  assert.deepEqual(
    result.fields.map((x) => [x.entityId, x.key]),
    [["g", "image"]],
  );
  assert.equal(f.store.getCharacter("m149").revision, before.revision);
  assert.deepEqual(f.store.getCharacter("g").definition.ccAssets, []);
  f.change("m149", "image", "assets/after.png");
  const cursor = f.store.cursor();
  assert.deepEqual(f.store.applyCommand("composite", command), result);
  assert.equal(f.store.cursor(), cursor);
});
for (const race of [
  "last-image",
  "image-ABA",
  "membership-ABA",
  "source-incarnation",
  "group-incarnation",
])
  test(`all-member guard rejects ${race} during continuation and final admission atomically`, (t) => {
    const f = fixture(t),
      page = f.store.groupImageSources("g"),
      command = f.command(page.guard);
    if (race === "last-image" || race === "image-ABA") {
      f.change("m149", "image", "assets/changed.png");
      if (race === "image-ABA")
        f.change("m149", "image", "assets/seed-149.png");
    } else if (race === "membership-ABA") {
      const members = f.store.getCharacter("g").definition.characters;
      f.change("g", "characters", ["m0"]);
      f.change("g", "characters", members);
    } else {
      const id = race === "group-incarnation" ? "g" : "m149",
        before = f.store.getCharacter(id);
      f.store.applyCommand("delete-" + id, {
        type: "delete-character",
        characterId: id,
        expectedRevision: before.revision,
        expectedEpoch: before.entityEpoch,
      });
      f.create(id, before.definition);
    }
    assert.throws(
      () => f.store.groupImageSources("g", 128, page.guard),
      code("REVISION_CONFLICT"),
    );
    const cursor = f.store.cursor(),
      count = f.store.db.prepare("SELECT count(*) n FROM commands").get().n;
    assert.throws(
      () => f.store.applyCommand("stale", command),
      code("REVISION_CONFLICT"),
    );
    assert.equal(f.store.cursor(), cursor);
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM commands").get().n,
      count,
    );
    assert.equal(
      f.store.getCharacter("g").definition.image,
      "assets/before.png",
    );
  });
test("duplicate positions, empty groups and invalid source contracts are explicit", (t) => {
  const f = fixture(t, 2);
  f.change("g", "characters", ["m1", "m0", "m1"]);
  const p = f.store.groupImageSources("g");
  assert.deepEqual(
    p.sources.map((x) => x.memberId),
    ["m1", "m0", "m1"],
  );
  for (const guard of [
    null,
    {},
    { ...p.guard, digest: "bad" },
    { ...p.guard, expectedEpoch: -1 },
  ])
    assert.throws(
      () =>
        f.store.applyCommand(
          "invalid-" + JSON.stringify(guard),
          f.command(guard),
        ),
      code("INVALID_COMMAND"),
    );
  assert.throws(() => f.store.groupImageSources("m0"), code("INVALID_COMMAND"));
  assert.throws(
    () => f.store.groupImageSources("g", 4, p.guard),
    code("INVALID_COMMAND"),
  );
  f.change("m0", "image", {});
  assert.throws(() => f.store.groupImageSources("g"), code("INVALID_COMMAND"));
  f.change("g", "characters", []);
  assert.deepEqual(f.store.groupImageSources("g").sources, []);
  f.change("g", "characters", ["missing"]);
  assert.throws(() => f.store.groupImageSources("g"), code("NOT_FOUND"));
  f.change("g", "characters", '["m1"]');
  assert.throws(() => f.store.groupImageSources("g"), code("INVALID_COMMAND"));
  f.change("g", "characters", 42);
  assert.throws(() => f.store.groupImageSources("g"), code("INVALID_COMMAND"));
});
