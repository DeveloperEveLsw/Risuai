// @vitest-environment node
import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { DBState } from "../storage/databaseState.svelte";
import type { Database } from "../storage/database.svelte";
import { createCharacterFactory } from "../characterFactory";
import { RisuReadModel, reconcileValue } from "./risuReadModel";
import { RuntimeClientError } from "./clientProtocol";
import type { VariableTarget } from "./variableCommands";
import { createHypaPresetRuntime } from "../process/memory/hypaPresetRuntime";
const { EntityStore } = createRequire(import.meta.url)(
  "../../../server/entity/store.cjs",
);

test("settings projection keeps portable memory members while applying original defaults and rejecting older field bodies", async () => {
  const f = fixture();
  try {
    const normalize = f.host.normalizeSettings;
    const { createHypaV3Preset } = createHypaPresetRuntime({});
    f.host.normalizeSettings = (db) => {
      const normalized = normalize(db);
      db.hypaV3Presets = (db.hypaV3Presets ?? []).map((p) =>
        createHypaV3Preset(p.name, p.settings),
      );
      db.hypaCustomSettings = {
        url: db.hypaCustomSettings?.url ?? "",
        key: db.hypaCustomSettings?.key ?? "",
        model: db.hypaCustomSettings?.model ?? "",
      };
      return normalized;
    };
    const old = f.store.getResource("settings", "global");
    const presets = [
      {
        name: "Authored portable preset",
        unknown: { keep: true },
        settings: {
          memoryTokensRatio: "invalid-original-type",
          unknown: { keep: true },
        },
      },
    ];
    f.command({
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: old.revision,
      payload: {
        ...old.payload,
        hypaV3Presets: presets,
        hypaCustomSettings: {
          url: "http://synthetic.invalid",
          unknown: { keep: true },
        },
      },
    });
    await f.model.bootstrap(f.store.bootstrap());
    expect((f.model.database.hypaV3Presets[0] as any).unknown).toEqual({
      keep: true,
    });
    expect((f.model.database.hypaV3Presets[0].settings as any).unknown).toEqual(
      { keep: true },
    );
    expect(f.model.database.hypaV3Presets[0].settings.memoryTokensRatio).toBe(
      0.2,
    );
    expect((f.model.database.hypaCustomSettings as any).unknown).toEqual({
      keep: true,
    });
    expect(f.model.database.hypaCustomSettings.model).toBe("");
    expect(
      f.store.getResource("settings", "global").payload.hypaV3Presets,
    ).toEqual(presets);
    const stale = f.store.getResourceSnapshot("settings", "global"),
      cursor = f.store.cursor();
    const target = {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "hypaV3Presets",
    };
    const field = f.store.readFields([target]).fields[0];
    const updated = [{ ...presets[0], name: "Peer portable update" }];
    f.command({
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          value: updated,
        },
      ],
    });
    await f.replay(cursor);
    const read = f.host.read;
    f.host.read = (async (path: string, options?: RequestInit) =>
      path === "/resources/settings/global"
        ? stale
        : read(path, options)) as typeof read;
    await f.model.ensureResource("settings", "global", true);
    expect(f.model.database.hypaV3Presets[0].name).toBe("Peer portable update");
    expect((f.model.database.hypaV3Presets[0].settings as any).unknown).toEqual(
      { keep: true },
    );
  } finally {
    f.store.close();
  }
});

test("an unloaded field confirmation admits its equally current complete character body", async () => {
  const f = fixture();
  try {
    f.command({
      type: "create-character",
      characterId: "late-lore",
      definition: {
        name: "Authored late body",
        type: "character",
        globalLore: [],
      },
    });
    await f.model.bootstrap(f.store.bootstrap());
    const target = {
      scope: "character",
      entityId: "late-lore",
      key: "globalLore",
    } as const;
    const header = f.store.readFields([target]).fields[0];
    const value = [
      {
        id: "portable-lore",
        comment: "Authored offline lore",
        key: "neutral",
        content: "Synthetic data",
        unknown: { retained: true },
      },
    ];
    f.command({
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedRevision: header.revision,
          expectedEpoch: header.entityEpoch,
          value,
        },
      ],
    });
    const current = f.store.readFields([target]);
    await f.model.applyFieldRead(current);
    expect(f.model.characterLoaded("late-lore")).toBe(false);
    expect(f.model.fieldVersion(target).revision).toBe(
      current.fields[0].revision,
    );
    const loaded = await f.model.ensureCharacter("late-lore");
    expect(loaded.globalLore).toEqual(value);
    expect(f.model.characterLoaded("late-lore")).toBe(true);
    const stale = f.store.getCharacter("late-lore");
    f.command({
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedRevision: current.fields[0].revision,
          expectedEpoch: current.fields[0].entityEpoch,
          value: [{ ...value[0], content: "Newer peer data" }],
        },
      ],
    });
    await f.model.applyFieldRead(f.store.readFields([target]));
    const read = f.host.read;
    f.host.read = async (path) =>
      path === "/characters/late-lore" ? stale : read(path);
    await f.model.ensureCharacter("late-lore", true);
    expect(loaded.globalLore[0].content).toBe("Newer peer data");
  } finally {
    f.store.close();
  }
});

test("catalog pages leave inactive bodies unloaded, preserve lazy edit fidelity and reject delayed deleted bodies", async () => {
  const f = fixture();
  try {
    for (const id of ["inactive-a", "inactive-b"])
      f.command({
        type: "save-library-resource",
        kind: "module",
        resourceId: id,
        expectedRevision: 0,
        expectedEpoch: 0,
        payload: {
          id,
          name: id,
          unknown: { retained: true },
          regex: [{ in: "x", out: "x".repeat(256 * 1024) }],
        },
      });
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.loadLibrary("module");
    expect(
      f.paths.filter((path) => path.startsWith("/resources/module/")),
    ).toEqual([]);
    expect(f.model.database.modules).toEqual([]);
    expect(f.catalogs.get("module").items.map((value) => value.id)).toEqual([
      "inactive-a",
      "inactive-b",
    ]);
    const opened = await f.model.getLibraryResource("module", "inactive-a");
    expect(opened.payload.unknown).toEqual({ retained: true });
    expect(opened.header).toEqual({ revision: 1, epoch: 0 });
    expect(f.model.database.modules.map((value) => value.id)).toEqual([
      "inactive-a",
    ]);
    opened.payload.name = "Synthetic unsaved draft";
    expect(f.model.database.modules[0].name).toBe("inactive-a");
    f.model.closeLibrary("module");
    expect(f.model.database.modules).toEqual([]);
    await f.model.loadLibrary("module");
    f.command({
      type: "save-library-resource",
      kind: "module",
      resourceId: "inactive-new",
      expectedRevision: 0,
      expectedEpoch: 0,
      payload: { id: "inactive-new", name: "Synthetic offline creation" },
    });
    await f.model.bootstrap(f.store.bootstrap());
    expect(
      f.catalogs
        .get("module")
        .items.map((value) => value.id)
        .sort(),
    ).toEqual(["inactive-a", "inactive-b", "inactive-new"]);
    const body = f.store.getResourceSnapshot("module", "inactive-a"),
      original = f.host.read;
    let release: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.host.read = async <T>(
      path: string,
      options?: RequestInit,
    ): Promise<T> => {
      if (path === "/resources/module/inactive-a") {
        await gate;
        return body as T;
      }
      return original(path, options);
    };
    const pending = f.model.getLibraryResource("module", "inactive-a"),
      before = f.store.cursor();
    f.command({
      type: "delete-library-resource",
      kind: "module",
      resourceId: "inactive-a",
      expectedRevision: body.revision,
      expectedEpoch: 0,
    });
    await f.replay(before);
    release();
    await expect(pending).rejects.toMatchObject({ code: "RESOURCE_CHANGED" });
    expect(f.model.database.modules).toEqual([]);
    expect(
      f.catalogs
        .get("module")
        .items.map((value) => value.id)
        .sort(),
    ).toEqual(["inactive-b", "inactive-new"]);
    expect(f.model.libraryHeader("module", "inactive-a").epoch).toBe(
      body.revision + 1,
    );
  } finally {
    f.store.close();
  }
});

test("search/page generations ignore responses after a new query or closed view", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 63; i++)
      f.command({
        type: "save-library-resource",
        kind: "module",
        resourceId: "catalog-" + i,
        expectedRevision: 0,
        expectedEpoch: 0,
        payload: {
          id: "catalog-" + i,
          name: "Synthetic " + String(i).padStart(2, "0"),
        },
      });
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.loadLibrary("module");
    expect(f.catalogs.get("module").items).toHaveLength(50);
    expect(f.catalogs.get("module").next).toBeTruthy();
    await f.model.loadLibraryMore("module");
    expect(f.catalogs.get("module").items).toHaveLength(63);
    expect(f.catalogs.get("module").next).toBeNull();
    const original = f.host.read;
    let release: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.host.read = async <T>(
      path: string,
      options?: RequestInit,
    ): Promise<T> => {
      const result = await original<T>(path, options);
      if (path.includes("search=Synthetic%2001")) await gate;
      return result;
    };
    const pending = f.model.loadLibrary("module", "Synthetic 01");
    await f.model.loadLibrary("module", "Synthetic 02");
    release();
    await pending;
    expect(f.catalogs.get("module").items.map((value) => value.id)).toEqual([
      "catalog-2",
    ]);
    const late = f.model.loadLibrary("module", "Synthetic 03");
    f.model.closeLibrary("module");
    await late;
    expect(f.catalogs.get("module").items).toEqual([]);
    expect(
      f.paths.filter((path) => path.startsWith("/resources/module/")),
    ).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("exact module namespaces load every matching active definition and release inactive bodies", async () => {
  const f = fixture();
  try {
    for (const id of ["namespace-a", "namespace-b", "unrelated"])
      f.command({
        type: "save-library-resource",
        kind: "module",
        resourceId: id,
        expectedRevision: 0,
        expectedEpoch: 0,
        payload: {
          id,
          name: id,
          namespace: id === "unrelated" ? "Other" : "Synthetic",
        },
      });
    const target = {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "moduleIntergration",
    };
    const set = (value: string) => {
      const field = f.store.readFields([target]).fields[0];
      f.command({
        type: "change-fields",
        edits: [
          {
            ...target,
            expectedRevision: field.revision,
            expectedEpoch: field.entityEpoch,
            value,
          },
        ],
      });
    };
    set("Synthetic");
    await f.model.bootstrap(f.store.bootstrap());
    expect(f.model.database.modules.map((value) => value.id)).toEqual([
      "namespace-a",
      "namespace-b",
    ]);
    expect(
      f.paths.filter((path) => path.startsWith("/resources/module/")),
    ).toEqual([
      "/resources/module/namespace-a",
      "/resources/module/namespace-b",
    ]);
    const before = f.store.cursor();
    set("");
    await f.replay(before);
    expect(f.model.database.modules).toEqual([]);
    f.paths.length = 0;
    f.command({
      type: "save-library-resource",
      kind: "module",
      resourceId: "namespace-a",
      expectedRevision: 1,
      expectedEpoch: 0,
      payload: {
        id: "namespace-a",
        name: "Edited inactive",
        namespace: "Synthetic",
      },
    });
    await f.model.bootstrap(f.store.bootstrap());
    expect(
      f.paths.filter((path) => path.startsWith("/resources/module/")),
    ).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("late edit bodies are released after their library view closes", async () => {
  const f = fixture();
  try {
    f.command({
      type: "save-library-resource",
      kind: "module",
      resourceId: "late-edit",
      expectedRevision: 0,
      expectedEpoch: 0,
      payload: { id: "late-edit", name: "Synthetic" },
    });
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.loadLibrary("module");
    const original = f.host.read;
    let release: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.host.read = async <T>(
      path: string,
      options?: RequestInit,
    ): Promise<T> => {
      const result = await original<T>(path, options);
      if (path === "/resources/module/late-edit") await gate;
      return result;
    };
    const pending = f.model.getLibraryResource("module", "late-edit");
    f.model.closeLibrary("module");
    release();
    await expect(pending).rejects.toMatchObject({ code: "RESOURCE_CHANGED" });
    expect(f.model.database.modules).toEqual([]);
    expect(f.catalogs.get("module").items).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("a delayed namespace resolution cannot replace a newer active module set", async () => {
  const f = fixture();
  try {
    for (const id of ["namespace-a", "namespace-b"])
      f.command({
        type: "save-library-resource",
        kind: "module",
        resourceId: id,
        expectedRevision: 0,
        expectedEpoch: 0,
        payload: {
          id,
          name: id,
          namespace: id === "namespace-a" ? "Synthetic" : "Other",
        },
      });
    const set = (target: any, value: string) => {
      const field = f.store.readFields([target]).fields[0];
      f.command({
        type: "change-fields",
        edits: [
          {
            ...target,
            expectedRevision: field.revision,
            expectedEpoch: field.entityEpoch,
            value,
          },
        ],
      });
    };
    set(
      {
        scope: "resource",
        resourceKind: "settings",
        entityId: "global",
        key: "moduleIntergration",
      },
      "Synthetic",
    );
    await f.model.bootstrap(f.store.bootstrap());
    const original = f.host.read;
    let release: () => void,
      entered: () => void,
      once = true;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      started = new Promise<void>((resolve) => (entered = resolve));
    f.host.read = async <T>(
      path: string,
      options?: RequestInit,
    ): Promise<T> => {
      const result = await original<T>(path, options);
      if (path === "/libraries/module/resolve" && once) {
        once = false;
        entered();
        await gate;
      }
      return result;
    };
    const pending = f.model.bootstrap(f.store.bootstrap());
    await started;
    const before = f.store.cursor();
    set(
      {
        scope: "resource",
        resourceKind: "module",
        entityId: "namespace-a",
        key: "namespace",
      },
      "Other",
    );
    set(
      {
        scope: "resource",
        resourceKind: "module",
        entityId: "namespace-b",
        key: "namespace",
      },
      "Synthetic",
    );
    await f.replay(before);
    release();
    await pending;
    expect(f.model.database.modules.map((value) => value.id)).toEqual([
      "namespace-b",
    ]);
  } finally {
    f.store.close();
  }
});

test("live preset/persona membership and reordering keep canonical stable selection and body identity", async () => {
  const f = fixture();
  try {
    for (const kind of ["preset", "persona"])
      for (const id of ["first", "second"])
        f.command({
          type: "save-library-resource",
          kind,
          resourceId: kind + "-" + id,
          expectedRevision: 0,
          expectedEpoch: 0,
          payload: {
            id: kind + "-" + id,
            name: id,
            icon: "",
            personaPrompt: "Synthetic",
          },
        });
    await f.model.bootstrap(f.store.bootstrap());
    for (const [kind, key, collection] of [
      ["preset", "botPresetsId", "botPresets"],
      ["persona", "selectedPersona", "personas"],
    ]) {
      let cursor = f.store.cursor();
      const target = {
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key,
        },
        header = f.store.readFields([target]).fields[0];
      f.command({
        type: "change-fields",
        edits: [
          {
            ...target,
            expectedRevision: header.revision,
            expectedEpoch: header.entityEpoch,
            value: 1,
          },
        ],
      });
      await f.replay(cursor);
      const values = f.model.database[collection],
        selected = values[1];
      cursor = f.store.cursor();
      const orderHeader = f.store.readFields([{ ...target, key: kind + "Ids" }])
        .fields[0];
      f.command({
        type: "reorder-library",
        kind,
        order: [kind + "-second", kind + "-first"],
        expectedRevision: orderHeader.revision,
        expectedEpoch: orderHeader.entityEpoch,
      });
      await f.replay(cursor);
      expect(f.model.database[collection]).toBe(values);
      expect(values[0]).toBe(selected);
      expect(f.model.database[key]).toBe(0);
      cursor = f.store.cursor();
      f.command({
        type: "save-library-resource",
        kind,
        resourceId: kind + "-new",
        expectedRevision: 0,
        expectedEpoch: 0,
        payload: {
          id: kind + "-new",
          name: "New",
          icon: "",
          personaPrompt: "Synthetic",
        },
      });
      await f.replay(cursor);
      expect(values.map((value) => value.id)).toEqual([
        kind + "-second",
        kind + "-first",
        kind + "-new",
      ]);
    }
  } finally {
    f.store.close();
  }
});

test("opened library replay advances past obsolete creation whose body was already deleted", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.loadLibrary("module");
    const original = f.host.read;
    f.host.read = async <T>(path: string): Promise<T> => {
      if (path === "/resources/module/transient")
        throw new RuntimeClientError(
          "NOT_FOUND",
          "Synthetic deleted resource",
          404,
        );
      return original(path);
    };
    const before = f.store.cursor();
    f.command({
      type: "save-library-resource",
      kind: "module",
      resourceId: "transient",
      expectedRevision: 0,
      expectedEpoch: 0,
      payload: { id: "transient", name: "Synthetic" },
    });
    f.command({
      type: "delete-library-resource",
      kind: "module",
      resourceId: "transient",
      expectedRevision: 1,
      expectedEpoch: 0,
    });
    await f.replay(before);
    expect(f.model.database.modules).toEqual([]);
    expect(f.model.libraryHeader("module", "transient")).toEqual({
      revision: 2,
      epoch: 2,
    });
  } finally {
    f.store.close();
  }
});

test("lifecycle projection removes selected chats and rejects stale snapshots/events after deletion and recreation", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const stale = f.store.snapshot("a"),
      before = f.store.cursor();
    const oldCreate = f.store
      .changes(0, 1000)
      .changes.find((c: any) => c.type === "chat" && c.id === "a");
    f.command({
      type: "delete-chat",
      chatId: "a",
      expectedRevision: stale.chat.revision,
      expectedEpoch: 0,
    });
    await f.replay(before);
    expect(f.model.activeChatId).toBeNull();
    expect(f.model.database.characters[0].chats.map((c) => c.id)).toEqual([
      "b",
    ]);
    f.model.applySnapshot(stale);
    await f.model.change(oldCreate);
    expect(f.model.database.characters[0].chats.map((c) => c.id)).toEqual([
      "b",
    ]);
    const cursor = f.store.cursor();
    f.command({
      type: "create-chat",
      characterId: "c",
      chatId: "a",
      metadata: { name: "Synthetic new incarnation" },
      prepend: true,
    });
    await f.replay(cursor);
    await f.model.selectCharacter("c", "a");
    const current = f.model.activeChat;
    f.model.applySnapshot(stale);
    await f.model.change(oldCreate);
    expect(f.model.activeChat).toBe(current);
    expect(current.name).toBe("Synthetic new incarnation");
    expect(current.message).toEqual([]);
    expect(f.model.database.characters[0].chats.map((c) => c.id)).toEqual([
      "a",
      "b",
    ]);
  } finally {
    f.store.close();
  }
});

test("delayed character reads cannot resurrect a deleted definition and bootstrap trash summaries need no full bodies", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const stale = f.store.getCharacter("c"),
      before = f.store.cursor();
    const oldRead = f.host.read;
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.host.read = async <T>(path: string) => {
      if (path === "/characters/c") {
        await gate;
        return stale as T;
      }
      return oldRead<T>(path);
    };
    const delayed = f.model.ensureCharacter("c", true);
    const rejected = expect(delayed).rejects.toThrow("removed");
    f.command({
      type: "delete-character",
      characterId: "c",
      expectedRevision: stale.revision,
      expectedEpoch: stale.entityEpoch,
    });
    await f.replay(before);
    release();
    await rejected;
    expect(f.model.characterIndex("c")).toBe(-1);
    expect(f.model.activeChatId).toBeNull();
    f.host.read = oldRead;
    const field = f.store.readFields([
      { scope: "character", entityId: "d", key: "trashTime" },
    ]).fields[0];
    f.command({
      type: "change-fields",
      edits: [
        {
          scope: "character",
          entityId: "d",
          key: "trashTime",
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          value: 1234,
        },
      ],
    });
    f.paths.length = 0;
    await f.model.bootstrap(f.store.bootstrap());
    expect(f.model.database.characters[0].trashTime).toBe(1234);
    expect(f.paths.some((p) => p.startsWith("/characters/"))).toBe(false);
  } finally {
    f.store.close();
  }
});

test("field events patch loaded entities without reads, preserve counters and windows, and load only newly referenced resources", async () => {
  const f = fixture();
  const edit = (target: any, value: any) => {
    const current = f.store.readFields([target]).fields[0];
    return {
      ...target,
      expectedRevision: current.revision,
      expectedEpoch: current.entityEpoch,
      value,
    };
  };
  const settings = (key: string) => ({
    scope: "resource",
    resourceKind: "settings",
    entityId: "global",
    key,
  });
  try {
    for (const [kind, id] of [
      ["module", "m"],
      ["persona", "p"],
    ])
      f.command({
        type: "put-resource",
        kind,
        resourceId: id,
        expectedRevision: 0,
        payload: { name: "Synthetic " + kind, unknown: { retained: true } },
      });
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const before = f.store.cursor();
    const messages = f.model.activeChat.message;
    const character = f.model.database.characters[0];
    const unknown = (character as any).unknown;
    f.paths.length = 0;
    f.command({
      type: "change-fields",
      edits: [
        edit({ scope: "character", entityId: "c", key: "supaMemory" }, true),
        edit(
          { scope: "character", entityId: "d", key: "name" },
          "Synthetic renamed summary",
        ),
        edit(
          { scope: "chat", entityId: "a", key: "note" },
          "Synthetic delta note",
        ),
        edit(settings("username"), "Synthetic delta user"),
        edit(settings("statics"), { syntheticExtra: "retained" }),
        edit(settings("characterOrder"), ["d", "c"]),
        edit(
          {
            scope: "resource",
            resourceKind: "module",
            entityId: "m",
            key: "name",
          },
          "Synthetic renamed module",
        ),
      ],
    });
    await f.replay(before);
    expect(f.paths).toEqual([]);
    expect((character as any).supaMemory).toBe(true);
    expect((character as any).unknown).toBe(unknown);
    expect(f.model.database.characters[1].name).toBe(
      "Synthetic renamed summary",
    );
    expect(f.model.activeChat.note).toBe("Synthetic delta note");
    expect(f.model.activeChat.message).toBe(messages);
    expect(f.model.database.username).toBe("Synthetic delta user");
    expect(f.model.database.statics).toEqual({
      messages: 7,
      imports: 2,
      syntheticExtra: "retained",
    });
    expect(f.model.database.characterOrder).toEqual(["d", "c"]);
    expect(f.model.database.modules).toEqual([]);
    expect(f.model.resourceRevision("settings", "global")).toBe(
      f.store.getResource("settings", "global").revision,
    );
    const references = f.store.cursor();
    f.command({
      type: "change-fields",
      edits: [
        edit({ scope: "character", entityId: "c", key: "modules" }, ["m"]),
        edit({ scope: "chat", entityId: "a", key: "bindedPersona" }, "p"),
      ],
    });
    await f.replay(references);
    expect(f.paths).toEqual([
      "/libraries/module/resolve",
      "/resources/module/m",
      "/resources/persona/p",
    ]);
    expect(f.model.database.modules[0].name).toBe("Synthetic renamed module");
    expect(f.model.activeChat.message).toBe(messages);
    const deletion = f.store.cursor();
    f.command({
      type: "change-fields",
      edits: [
        { ...edit(settings("statics"), null), value: undefined, remove: true },
        {
          ...edit({ scope: "chat", entityId: "a", key: "note" }, null),
          value: undefined,
          remove: true,
        },
      ].map(({ value, ...rest }) => rest),
    });
    await f.replay(deletion);
    expect(f.model.database.statics).toEqual({ messages: 7, imports: 2 });
    expect(f.model.activeChat.note).toBe("");
    expect(f.model.activeChat.message).toBe(messages);
  } finally {
    f.store.close();
  }
});

test("a scoped field read across resource recreation refreshes its new body once and fences earlier incarnation events", async () => {
  const f = fixture();
  try {
    f.command({
      type: "put-resource",
      kind: "module",
      resourceId: "m",
      expectedRevision: 0,
      payload: { name: "Synthetic old module", oldOnly: true },
    });
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    await f.model.ensureResource("module", "m");
    const before = f.store.cursor();
    f.store.enqueueJob("synthetic-delete", { type: "button", chatId: "a" });
    const claim = f.store.claimJob("synthetic-owner");
    f.store.finishJob("synthetic-delete", "synthetic-owner", claim.job.fence, {
      state: "completed",
      writeSet: {
        chatId: "a",
        expectedRevision: claim.snapshot.chat.revision,
        deleteResources: [{ kind: "module", id: "m", expectedRevision: 1 }],
      },
    });
    f.command({
      type: "put-resource",
      kind: "module",
      resourceId: "m",
      expectedRevision: 2,
      payload: { name: "Synthetic new module", newOnly: true },
    });
    const target = {
      scope: "resource",
      resourceKind: "module",
      entityId: "m",
      key: "name",
    } as const;
    const current = f.store.readFields([target]).fields[0];
    f.command({
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedRevision: current.revision,
          expectedEpoch: current.entityEpoch,
          value: "Synthetic new field",
        },
      ],
    });
    f.paths.length = 0;
    await f.model.applyFieldRead(f.store.readFields([target]));
    expect(f.paths).toEqual(["/resources/module/m"]);
    expect(f.model.database.modules[0]).toEqual({
      id: "m",
      name: "Synthetic new field",
      newOnly: true,
    });
    await f.replay(before);
    expect(f.paths).toEqual(["/resources/module/m"]);
    expect(f.model.database.modules[0]).toEqual({
      id: "m",
      name: "Synthetic new field",
      newOnly: true,
    });
    expect(f.model.fieldVersion(target).entityEpoch).toBe(2);
  } finally {
    f.store.close();
  }
});

test("field reads and late full projections preserve current own versions without replacing messages", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const stale = f.store.snapshot("a", { limit: 2 });
    const staleSettings = f.store.getResource("settings", "global");
    const messages = f.model.activeChat.message;
    const targets = [
      {
        scope: "resource",
        resourceKind: "settings",
        entityId: "global",
        key: "username",
      },
      { scope: "character", entityId: "c", key: "name" },
      { scope: "chat", entityId: "a", key: "note" },
    ] as const;
    const before = f.store.readFields(targets);
    f.command({
      type: "change-fields",
      edits: before.fields.map((value: any, i: number) => ({
        ...targets[i],
        expectedRevision: value.revision,
        expectedEpoch: value.entityEpoch,
        value: "Synthetic changed " + i,
      })),
    });
    const latest = f.store.readFields(targets);
    await f.model.applyFieldRead(latest);
    await f.model.applyFieldRead(before);
    f.model.applySnapshot(stale);
    const read = f.host.read;
    f.host.read = async (path) =>
      path === "/resources/settings/global" ? staleSettings : read(path);
    await f.model.ensureResource("settings", "global", true);
    expect(f.model.database.username).toBe("Synthetic changed 0");
    expect(f.model.database.characters[0].name).toBe("Synthetic changed 1");
    expect(f.model.activeChat.note).toBe("Synthetic changed 2");
    expect(f.model.activeChat.message).toBe(messages);
    for (const target of targets)
      expect(f.model.fieldVersion(target)).toEqual({
        revision: 2,
        entityEpoch: 0,
      });
    await f.replay(before.cursor);
    expect(f.model.activeChat.note).toBe("Synthetic changed 2");
    expect(f.model.fieldVersion(targets[2]).revision).toBe(2);
  } finally {
    f.store.close();
  }
});

test("local-global key events and tombstones survive old snapshots and metadata updates without replacing the message window", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const stale = f.store.snapshot("a", { limit: 2 });
    const messages = f.model.activeChat.message;
    const target = {
      scope: "chat-global",
      chatId: "a",
      key: "toggle_test",
    } as const;
    f.command({
      type: "change-variables",
      edits: [{ ...target, expectedRevision: 0, value: "local" }],
    });
    await f.replay(stale.cursor);
    f.model.applySnapshot(stale);
    expect(f.model.activeChat.GLGlobalVariables.toggle_test).toBe("local");
    expect(f.model.scopedVariableRevision(target)).toBe(1);
    expect(f.model.activeChat.message).toBe(messages);
    const beforeDelete = f.store.snapshot("a", { limit: 2 });
    f.command({
      type: "change-variables",
      edits: [{ ...target, expectedRevision: 1, remove: true }],
    });
    await f.replay(beforeDelete.cursor);
    f.model.applySnapshot(beforeDelete);
    expect(f.model.activeChat.GLGlobalVariables.toggle_test).toBeUndefined();
    expect(f.model.scopedVariableRevision(target)).toBe(2);
    expect((f.model.activeChat as any).unknown).toEqual({ retained: true });
  } finally {
    f.store.close();
  }
});

test("narrow variable refresh respects revisions and prototype-named keys without reading chat history", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const targets: VariableTarget[] = [
      { scope: "global", key: "__proto__" },
      { scope: "chat-global", chatId: "a", key: "constructor" },
    ];
    f.command({
      type: "change-variables",
      edits: targets.map((target) => ({
        ...target,
        value: "own",
        expectedRevision: 0,
      })),
    });
    const old = f.store.readVariables(targets);
    f.model.applyVariableRead(old);
    expect(
      Object.hasOwn(f.model.database.globalChatVariables, "__proto__"),
    ).toBe(true);
    expect(f.model.database.globalChatVariables["__proto__"]).toBe("own");
    expect(f.model.activeChat.GLGlobalVariables.constructor).toBe("own");
    f.command({
      type: "change-variables",
      edits: targets.map((target) => ({
        ...target,
        remove: true,
        expectedRevision: 1,
      })),
    });
    f.model.applyVariableRead(f.store.readVariables(targets));
    f.model.applyVariableRead(old);
    expect(
      Object.hasOwn(f.model.database.globalChatVariables, "__proto__"),
    ).toBe(false);
    expect(
      Object.hasOwn(f.model.activeChat.GLGlobalVariables, "constructor"),
    ).toBe(false);
    expect(f.model.scopedVariableRevision(targets[1])).toBe(2);
  } finally {
    f.store.close();
  }
});

test("character navigation preserves canonical invisible fields while projecting peer move, trash and restore without inactive body reads", async () => {
  const f = fixture();
  try {
    const folder = {
      id: "synthetic-folder",
      name: "Synthetic folder",
      color: "",
      imgFile: "synthetic-image",
      data: ["c", "missing"],
      unknown: { retained: true },
    };
    const field = f.store.readFields([
      {
        scope: "resource",
        resourceKind: "settings",
        entityId: "global",
        key: "characterOrder",
      },
    ]).fields[0];
    f.command({
      type: "change-fields",
      edits: [
        {
          ...field,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          value: [folder, "unmapped", null, "d"],
        },
      ],
    });
    await f.model.bootstrap(f.store.bootstrap());
    const canonical = f.model.characterOrderSource();
    expect(canonical).toEqual([folder, "unmapped", null, "d"]);
    expect(f.model.database.characterOrder).toEqual([
      { ...folder, data: ["c"] },
      "d",
    ]);
    expect(f.model.database.characters.map((value) => value.chats)).toEqual([
      [],
      [],
    ]);
    const before = f.store.cursor();
    f.command({
      type: "change-character-navigation",
      ...f.model.characterNavigationTarget(),
      action: {
        type: "move",
        source: { kind: "character", id: "c" },
        destination: { folderId: null, before: { kind: "character", id: "d" } },
      },
    });
    await f.replay(before);
    expect(f.model.database.characterOrder).toEqual(["c", "d"]);
    expect(f.model.characterOrderSource()).toEqual([
      { ...folder, data: ["missing"] },
      "unmapped",
      null,
      "c",
      "d",
    ]);
    for (const hidden of [true, false]) {
      const target = f.store.readFields([
          { scope: "character", entityId: "c", key: "trashTime" },
        ]).fields[0],
        cursor = f.store.cursor();
      const { value: oldValue, ...identity } = target;
      f.command({
        type: "change-fields",
        edits: [
          {
            ...identity,
            expectedRevision: target.revision,
            expectedEpoch: target.entityEpoch,
            ...(hidden ? { value: 123 } : { remove: true }),
          },
        ],
      });
      await f.replay(cursor);
      expect(f.model.database.characterOrder).toEqual(
        hidden ? ["d"] : ["c", "d"],
      );
      expect(
        f.model.characterNavigationTarget().expectedNavigationRevision,
      ).toBe(f.store.bootstrap().characterNavigation.revision);
    }
    expect(
      f.paths.filter(
        (path) => path.startsWith("/characters/") || path.startsWith("/chats/"),
      ),
    ).toEqual([]);
    expect(canonical).toEqual([folder, "unmapped", null, "d"]);
  } finally {
    f.store.close();
  }
});

test("held settings/creation summaries and resync cannot restore old character order or visibility after peer edits and lifecycle changes", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    const oldSettings = f.store.getResourceSnapshot("settings", "global"),
      oldBootstrap = f.store.bootstrap(),
      cursor = f.store.cursor();
    const captured = f.model.characterNavigationTarget();
    f.command({
      type: "change-character-navigation",
      ...captured,
      action: {
        type: "group",
        sourceId: "d",
        target: { kind: "character", id: "c" },
        folder: { id: "peer-folder", name: "Synthetic", color: "green" },
      },
    });
    f.command({
      type: "create-character",
      characterId: "peer-new",
      definition: { name: "Synthetic peer new" },
    });
    const field = f.store.readFields([
      { scope: "character", entityId: "c", key: "trashTime" },
    ]).fields[0];
    f.command({
      type: "change-fields",
      edits: [
        {
          ...field,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          value: 123,
        },
      ],
    });
    await f.replay(cursor);
    const expected = [
        { id: "peer-folder", name: "Synthetic", color: "green", data: ["d"] },
        "peer-new",
      ],
      raw = f.model.characterOrderSource();
    expect(f.model.database.characterOrder).toEqual(expected);
    const oldCreation = f.store
      .changes(0)
      .changes.find(
        (change) => change.type === "character" && change.id === "c",
      );
    await f.model.change(oldCreation);
    expect(f.model.database.characterOrder).toEqual(expected);
    const original = f.host.read;
    f.host.read = async <T>(path: string, options?: RequestInit): Promise<T> =>
      path === "/resources/settings/global"
        ? (oldSettings as T)
        : original(path, options);
    await f.model.ensureResource("settings", "global", true);
    expect(f.model.characterOrderSource()).toEqual(raw);
    await f.model.bootstrap(oldBootstrap);
    expect(f.model.database.characterOrder).toEqual(expected);
    expect(f.model.characterOrderSource()).toEqual(raw);
    expect(
      f.model.database.characters.find((value) => value.chaId === "c")
        .trashTime,
    ).toBe(123);
    expect(f.model.characterNavigationTarget().expectedNavigationRevision).toBe(
      f.store.bootstrap().characterNavigation.revision,
    );
    expect(() =>
      f.command({
        type: "change-character-navigation",
        ...captured,
        action: {
          type: "edit-folder",
          folderId: "peer-folder",
          updates: { name: "Old dialog" },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "REVISION_CONFLICT" }));
  } finally {
    f.store.close();
  }
});

test("known deleted order members disappear on both projection and canonical source; recreation cannot inherit an old folder", async () => {
  const f = fixture();
  try {
    const folder = {
      id: "synthetic-folder",
      name: "Synthetic",
      color: "",
      data: ["c", "d", "unmapped"],
      imgFile: "synthetic-image",
      unknown: true,
    };
    const field = f.store.readFields([
      {
        scope: "resource",
        resourceKind: "settings",
        entityId: "global",
        key: "characterOrder",
      },
    ]).fields[0];
    f.command({
      type: "change-fields",
      edits: [
        {
          ...field,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          value: [folder, "c", null, "unmapped-top"],
        },
      ],
    });
    await f.model.bootstrap(f.store.bootstrap());
    const before = f.store.cursor(),
      row = f.store.getCharacter("c");
    f.command({
      type: "delete-character",
      characterId: "c",
      expectedRevision: row.revision,
      expectedEpoch: row.entityEpoch,
    });
    await f.replay(before);
    expect(f.model.characterOrderSource()).toEqual([
      { ...folder, data: ["d", "unmapped"] },
      null,
      "unmapped-top",
    ]);
    expect(f.model.database.characterOrder).toEqual([
      { ...folder, data: ["d"] },
    ]);
    const cursor = f.store.cursor();
    f.command({
      type: "create-character",
      characterId: "c",
      definition: { name: "Synthetic recreated" },
    });
    await f.replay(cursor);
    expect(f.model.database.characterOrder).toEqual([
      { ...folder, data: ["d"] },
      "c",
    ]);
    expect(
      f.paths.filter(
        (path) => path.startsWith("/characters/") || path.startsWith("/chats/"),
      ),
    ).toEqual([]);
  } finally {
    f.store.close();
  }
});

function fixture() {
  const store = new EntityStore(":memory:");
  let next = 0;
  const command = (c: any) => store.applyCommand("command-" + ++next, c);
  for (const characterId of ["c", "d"])
    command({
      type: "create-character",
      characterId,
      definition: {
        type: "character",
        name: characterId,
        firstMessage: "Synthetic greeting",
        unknown: { retained: true },
      },
    });
  for (const [chatId, characterId] of [
    ["a", "c"],
    ["b", "c"],
    ["other", "d"],
  ])
    command({
      type: "create-chat",
      characterId,
      chatId,
      metadata: {
        name: chatId,
        note: "synthetic note",
        localLore: [],
        unknown: { retained: true },
      },
    });
  command({
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: 0,
    payload: {
      username: "Synthetic user",
      statics: { messages: 7, imports: 2 },
      unknown: { retained: true },
    },
  });
  for (let i = 0; i < 5; i++)
    command({
      type: "append-message",
      chatId: "a",
      messageId: "m" + i,
      message: {
        role: "char",
        data: "synthetic-" + i,
        extension: { retained: true },
      },
    });
  command({
    type: "append-message",
    chatId: "other",
    messageId: "private-fixture",
    message: { role: "char", data: "synthetic-unrelated-archive" },
  });
  const paths: string[] = [];
  const catalogs = new Map<
    string,
    {
      items: import("./clientProtocol").RuntimeLibraryItem[];
      next: string | null;
    }
  >();
  const read = async <T>(path: string, options?: RequestInit): Promise<T> => {
    paths.push(path);
    const url = new URL(path, "http://synthetic.invalid");
    const parts = url.pathname.split("/");
    if (parts[1] === "characters")
      return (
        parts[3] === "chats"
          ? store.listChats(parts[2])
          : store.getCharacter(parts[2])
      ) as T;
    if (parts[1] === "resources")
      return store.getResourceSnapshot(parts[2], parts[3]);
    if (parts[1] === "libraries")
      return (
        parts[3] === "resolve"
          ? store.resolveModuleCatalog(
              JSON.parse(options?.body as string).tokens,
            )
          : store.listLibrary(parts[2], {
              limit: Number(url.searchParams.get("limit") ?? 50),
              search: url.searchParams.get("search") ?? "",
              after: url.searchParams.get("after") ?? undefined,
            })
      ) as T;
    if (parts[1] === "chats")
      return store.snapshot(parts[2], {
        limit: Number(url.searchParams.get("limit") ?? 100),
        ...(url.searchParams.has("before")
          ? { before: Number(url.searchParams.get("before")) }
          : {}),
        ...(url.searchParams.has("after")
          ? { after: Number(url.searchParams.get("after")) }
          : {}),
        ...(url.searchParams.has("around")
          ? { around: url.searchParams.get("around") }
          : {}),
      });
    throw new Error("Unexpected synthetic read " + path);
  };
  DBState.db = {} as Database;
  const host = {
    DBState,
    read,
    onCatalog: (
      kind: string,
      items: import("./clientProtocol").RuntimeLibraryItem[],
      next: string | null,
    ) => catalogs.set(kind, { items, next }),
    characterDefaults: createCharacterFactory({
      uuidv4: (() => "stub") as any,
      defaultSdDataFunc: () => [],
    }).createBlankChar,
    normalizeSettings: (db: Database) =>
      Object.assign(db, {
        modules: [],
        botPresets: [],
        personas: [],
        plugins: [],
        globalChatVariables: {},
        statics: db.statics ?? { messages: 0, imports: 0 },
      }),
  };
  const model = new RisuReadModel(host, 2);
  const replay = async (after: number) => {
    for (const event of store.changes(after, 1000).changes)
      await model.change(event);
  };
  return { store, model, command, read, host, paths, replay, catalogs };
}

function installSyntheticPlugin(
  f: ReturnType<typeof fixture>,
  id: string,
  enabled = true,
  script = "// Synthetic original plugin source",
) {
  f.command({
    type: "save-library-resource",
    kind: "plugin",
    resourceId: id,
    expectedRevision: 0,
    expectedEpoch: 0,
    payload: {
      id,
      name: id,
      version: "3.0",
      enabled,
      script,
      realArg: { example: "preserved" },
      arguments: { example: "string" },
      customLink: [],
      argMeta: {},
      unknown: { retained: true },
    },
  });
}

for (const index of ["missing", "empty", "partial", "ordered"])
  test(`plugin bootstrap hydrates live installed headers with a ${index} ordering index, including disabled plugins and excluding tombstones`, async () => {
    const f = fixture();
    try {
      installSyntheticPlugin(f, "plugin-a");
      installSyntheticPlugin(f, "plugin-b", false);
      installSyntheticPlugin(f, "plugin-deleted");
      f.command({
        type: "delete-library-resource",
        kind: "plugin",
        resourceId: "plugin-deleted",
        expectedRevision: 1,
        expectedEpoch: 0,
      });
      const settings = f.store.getResource("settings", "global"),
        payload = { ...settings.payload };
      if (index === "missing") delete payload.pluginIds;
      else
        payload.pluginIds =
          index === "empty"
            ? []
            : index === "partial"
              ? ["plugin-b", "uninstalled"]
              : ["plugin-b", "plugin-a"];
      f.command({
        type: "put-resource",
        kind: "settings",
        resourceId: "global",
        expectedRevision: settings.revision,
        payload,
      });
      f.paths.length = 0;
      await f.model.bootstrap(f.store.bootstrap());
      expect(f.model.database.plugins.map((plugin) => plugin.id)).toEqual(
        index === "partial" || index === "ordered"
          ? ["plugin-b", "plugin-a"]
          : ["plugin-a", "plugin-b"],
      );
      expect(
        f.model.database.plugins.find((plugin) => plugin.id === "plugin-b")
          .enabled,
      ).toBe(false);
      expect((f.model.database.plugins[0] as any).unknown).toEqual({
        retained: true,
      });
      expect(
        f.paths.filter((path) => path.startsWith("/resources/plugin/")),
      ).toEqual(["/resources/plugin/plugin-a", "/resources/plugin/plugin-b"]);
      expect(f.paths.some((path) => path.includes("uninstalled"))).toBe(false);
      expect(f.paths.some((path) => path.includes("plugin-deleted"))).toBe(
        false,
      );
      expect(f.paths.some((path) => path.startsWith("/characters/"))).toBe(
        false,
      );
    } finally {
      f.store.close();
    }
  });

test("plugin reconnect reuses original scripts while peer field changes, imports, deletions and offline replacements update the confirmed installed list", async () => {
  const f = fixture();
  try {
    const original = "// Synthetic original\n" + "x".repeat(2 * 1024 * 1024);
    installSyntheticPlugin(f, "plugin-a", true, original);
    await f.model.bootstrap(f.store.bootstrap());
    const plugin = f.model.database.plugins[0];
    f.paths.length = 0;
    await f.model.bootstrap(f.store.bootstrap());
    expect(f.model.database.plugins[0]).toBe(plugin);
    expect(f.model.database.plugins[0].script).toBe(original);
    expect(
      f.paths.filter((path) => path.startsWith("/resources/plugin/")),
    ).toEqual([]);
    let cursor = f.store.cursor();
    const target = {
      scope: "resource",
      resourceKind: "plugin",
      entityId: "plugin-a",
      key: "enabled",
    } as const;
    const field = f.store.readFields([target]).fields[0];
    f.command({
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          value: false,
        },
      ],
    });
    await f.replay(cursor);
    expect(f.model.database.plugins[0].enabled).toBe(false);
    expect(f.model.database.plugins[0].script).toBe(original);
    expect(
      f.paths.filter((path) => path.startsWith("/resources/plugin/")),
    ).toEqual([]);
    cursor = f.store.cursor();
    installSyntheticPlugin(f, "plugin-b");
    await f.replay(cursor);
    expect(f.model.database.plugins.map((value) => value.id)).toEqual([
      "plugin-a",
      "plugin-b",
    ]);
    expect(
      f.paths.filter((path) => path.startsWith("/resources/plugin/")),
    ).toEqual(["/resources/plugin/plugin-b"]);
    cursor = f.store.cursor();
    f.command({
      type: "delete-library-resource",
      kind: "plugin",
      resourceId: "plugin-a",
      expectedRevision: f.store.getResource("plugin", "plugin-a").revision,
      expectedEpoch: 0,
    });
    await f.replay(cursor);
    expect(f.model.database.plugins.map((value) => value.id)).toEqual([
      "plugin-b",
    ]);
    f.command({
      type: "delete-library-resource",
      kind: "plugin",
      resourceId: "plugin-b",
      expectedRevision: 1,
      expectedEpoch: 0,
    });
    installSyntheticPlugin(f, "plugin-c");
    f.paths.length = 0;
    await f.model.bootstrap(f.store.bootstrap());
    expect(f.model.database.plugins.map((value) => value.id)).toEqual([
      "plugin-c",
    ]);
    expect(
      f.paths.filter((path) => path.startsWith("/resources/plugin/")),
    ).toEqual(["/resources/plugin/plugin-c"]);
  } finally {
    f.store.close();
  }
});

test("a plugin body held during bootstrap cannot resurrect a peer deletion", async () => {
  const f = fixture();
  try {
    installSyntheticPlugin(f, "plugin-held");
    const body = f.store.getResourceSnapshot("plugin", "plugin-held"),
      read = f.host.read;
    let release: () => void, started: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve) => (started = resolve));
    f.host.read = async <T>(
      path: string,
      options?: RequestInit,
    ): Promise<T> => {
      if (path === "/resources/plugin/plugin-held") {
        started();
        await gate;
        return body as T;
      }
      return read(path, options);
    };
    const bootstrap = f.model.bootstrap(f.store.bootstrap());
    await ready;
    const cursor = f.store.cursor();
    f.command({
      type: "delete-library-resource",
      kind: "plugin",
      resourceId: "plugin-held",
      expectedRevision: 1,
      expectedEpoch: 0,
    });
    await f.replay(cursor);
    release();
    await bootstrap;
    expect(f.model.database.plugins).toEqual([]);
    expect(f.model.libraryHeader("plugin", "plugin-held").epoch).toBe(2);
  } finally {
    f.store.close();
  }
});

test("group member headers follow confirmed fields and ignore a held older definition without loading member histories", async () => {
  const f = fixture();
  try {
    f.command({
      type: "create-character",
      characterId: "g",
      definition: {
        type: "group",
        name: "Synthetic group",
        characters: ["c", "d"],
        characterTalks: [1, 1],
        characterActive: [true, true],
      },
      chat: { chatId: "g-chat", metadata: { name: "Synthetic group" } },
    });
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("g", "g-chat");
    expect(f.model.groupMemberHeader("g", "c").revision).toBe(1);
    const old = f.store.getCharacter("g"),
      cursor = f.store.cursor();
    let release: () => void, held: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      ready = new Promise<void>((resolve) => (held = resolve));
    f.host.read = async <T>(path: string) => {
      if (path === "/characters/g") {
        held();
        await gate;
        return old as T;
      }
      return f.read<T>(path);
    };
    const delayed = f.model.ensureCharacter("g", true);
    await ready;
    const header = f.store.readGroupMember("g", "c");
    f.command({
      type: "change-group-member",
      groupId: "g",
      memberId: "c",
      action: "set-active",
      position: 0,
      value: false,
      expectedEpoch: header.entityEpoch,
      expectedOrderRevision: header.orderRevision,
      expectedMemberRevision: header.member.revision,
    });
    await f.replay(cursor);
    release();
    await delayed;
    expect(f.model.groupMemberHeader("g", "c")).toEqual(
      f.store.readGroupMember("g", "c").member,
    );
    expect(f.model.groupMemberHeader("g", "d").revision).toBe(1);
    expect(
      (f.model.database.characters[f.model.characterIndex("g")] as any)
        .characterActive,
    ).toEqual([false, true]);
    expect(f.paths.some((path) => /^\/chats\/(a|b|other)/.test(path))).toBe(
      false,
    );
  } finally {
    f.store.close();
  }
});

test("group removal headers retain tombstones, shifted members and reset on stable group ID reuse", async () => {
  const f = fixture();
  try {
    f.command({
      type: "create-character",
      characterId: "g",
      definition: {
        type: "group",
        name: "Synthetic group",
        characters: ["c", "d"],
        characterTalks: [1, 1],
        characterActive: [true, true],
      },
      chat: { chatId: "g-chat", metadata: { name: "Synthetic" } },
    });
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("g", "g-chat");
    let cursor = f.store.cursor();
    const header = f.store.readGroupMember("g", "c");
    f.command({
      type: "change-group-member",
      groupId: "g",
      memberId: "c",
      action: "remove",
      position: 0,
      expectedEpoch: header.entityEpoch,
      expectedOrderRevision: header.orderRevision,
      expectedMemberRevision: header.member.revision,
    });
    await f.replay(cursor);
    expect(f.model.groupMemberHeader("g", "c")).toEqual({
      memberId: "c",
      revision: 2,
      slots: [],
    });
    expect(f.model.groupMemberHeader("g", "d")).toEqual({
      memberId: "d",
      revision: 1,
      slots: [{ position: 0, talkness: 1, active: true }],
    });
    cursor = f.store.cursor();
    const group = f.store.getCharacter("g");
    f.command({
      type: "delete-character",
      characterId: "g",
      expectedRevision: group.revision,
      expectedEpoch: group.entityEpoch,
    });
    await f.replay(cursor);
    cursor = f.store.cursor();
    f.command({
      type: "create-character",
      characterId: "g",
      definition: group.definition,
      chat: { chatId: "g-chat", metadata: { name: "Synthetic replacement" } },
    });
    await f.replay(cursor);
    await f.model.selectCharacter("g", "g-chat");
    expect(f.model.groupMemberHeader("g", "d").revision).toBe(1);
    expect(f.model.groupMemberHeader("g", "c").revision).toBe(0);
  } finally {
    f.store.close();
  }
});

test("bootstrap hydrates only settings and summaries; selecting a character reads only that definition/chat page", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    expect(f.paths).toEqual(["/resources/settings/global"]);
    expect(f.model.database.characters.map((c) => c.chats)).toEqual([[], []]);
    expect(JSON.stringify(f.model.database)).not.toContain(
      "synthetic-unrelated-archive",
    );
    await f.model.selectCharacter("c", "a");
    expect(f.model.activeChat.message.map((m) => m.data)).toEqual([
      "synthetic-3",
      "synthetic-4",
    ]);
    expect(f.model.hasEarlier).toBe(true);
    expect(f.model.database.characters[0].chats[1].message).toEqual([]);
    expect(f.paths.some((path) => path.includes("other"))).toBe(false);
    expect((f.model.database.characters[0] as any).unknown).toEqual({
      retained: true,
    });
  } finally {
    f.store.close();
  }
});

test("unopened character thumbnails load at bootstrap and follow peer changes across resync", async () => {
  const f = fixture();
  const initialImage = `assets/${"a".repeat(64)}.png`;
  const updatedImage = `assets/runtime/${"b".repeat(64)}.webp`;
  const target = { scope: "character", entityId: "d", key: "image" } as const;
  const thumbnail = (id: string) =>
    f.model.database.characters.find((character) => character.chaId === id)
      ?.image;
  const editImage = (image?: string) => {
    const field = f.store.readFields([target]).fields[0];
    f.command({
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          ...(image === undefined ? { remove: true } : { value: image }),
        },
      ],
    });
  };
  try {
    editImage(initialImage);
    const initial = f.store.bootstrap();
    await f.model.bootstrap(initial);
    expect(thumbnail("d")).toBe(initialImage);
    expect(f.model.characterLoaded("d")).toBe(false);
    expect(f.paths).toEqual(["/resources/settings/global"]);

    editImage(updatedImage);
    await f.replay(initial.cursor);
    expect(thumbnail("d")).toBe(updatedImage);
    await f.model.bootstrap(initial);
    expect(thumbnail("d")).toBe(updatedImage);

    const beforeRemoval = f.store.bootstrap();
    editImage();
    f.command({
      type: "create-character",
      characterId: "peer-group",
      definition: {
        type: "group",
        name: "Synthetic group",
        image: initialImage,
      },
    });
    await f.replay(beforeRemoval.cursor);
    expect(thumbnail("d")).toBeFalsy();
    expect(thumbnail("peer-group")).toBe(initialImage);
    expect(f.model.characterLoaded("peer-group")).toBe(false);
    await f.model.bootstrap(beforeRemoval);
    expect(thumbnail("d")).toBeFalsy();
    expect(f.model.characterLoaded("d")).toBe(false);
    expect(f.paths.every((path) => path === "/resources/settings/global")).toBe(
      true,
    );
  } finally {
    f.store.close();
  }
});

test("source origin headers survive journal and stale page projection but are cleared by an external message edit", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const old = f.store.snapshot("a", { limit: 2 });
    const state = f.store.displayState("a");
    const result = f.command({
      type: "apply-display-effects",
      chatId: "a",
      expectedChatEpoch: state.chatEpoch,
      expectedCharacterEpoch: state.characterEpoch,
      inputClock: state.inputClock,
      codeHash: "b".repeat(64),
      source: {
        kind: "message",
        messageId: "m4",
        expectedRevision: 1,
        contentHash: "c".repeat(64),
      },
      reads: [],
      edits: [],
      messageEdits: [
        { messageId: "m4", expectedRevision: 1, text: "Synthetic processed" },
      ],
    });
    await f.replay(old.cursor);
    const origin = f.model.messageDisplayOrigin("m4");
    expect(origin.displayKey).toBe(result.displayKey);
    f.model.applySnapshot(old);
    expect(f.model.messageDisplayOrigin("m4")).toEqual(origin);
    const fresh = f.store.snapshot("a", { limit: 2 });
    expect(fresh.messages[1].displayOrigin).toEqual(origin);
    await f.model.refreshActive();
    expect(f.model.messageDisplayOrigin("m4")).toEqual(origin);
    origin.messageRevision = 999;
    expect(f.model.messageDisplayOrigin("m4").messageRevision).toBe(2);
    f.command({
      type: "edit-message",
      chatId: "a",
      messageId: "m4",
      expectedRevision: 2,
      text: "Synthetic outside",
    });
    await f.replay(fresh.cursor);
    expect(f.model.messageDisplayOrigin("m4")).toBeUndefined();
    expect(f.store.snapshot("a").messages[4].displayOrigin).toBeUndefined();
  } finally {
    f.store.close();
  }
});

test("an early browser getter creating characters does not bypass settings initialization", async () => {
  const f = fixture();
  try {
    DBState.db = { characters: [] } as Database;
    await f.model.bootstrap(f.store.bootstrap());
    expect(f.model.database.personas).toEqual([]);
    expect(f.model.database.globalChatVariables).toEqual({});
    expect(f.model.database.characterOrder).toEqual(["c", "d"]);
    await f.model.selectCharacter("c", "a");
    expect(f.model.activeChat.id).toBe("a");
    expect(f.model.activeChat.fmIndex).toBe(-1);
    await f.model.change({
      sequence: f.store.cursor() + 1,
      type: "chat",
      id: "a",
      chatId: "a",
      revision: 20,
      payload: {
        characterId: "c",
        metadata: { name: "renamed", note: "changed metadata" },
      },
    });
    expect(f.model.activeChat.id).toBe("a");
    expect(f.model.activeChat.fmIndex).toBe(-1);
    expect(f.model.activeChat.message.length).toBe(2);
  } finally {
    f.store.close();
  }
});

test("unknown JSON fields named like prototype properties stay own data and do not alter other objects", () => {
  const target: any = {};
  const source = JSON.parse(
    '{"__proto__":{"risuPolluted":true},"constructor":{"prototype":{"risuPolluted":true}},"nested":{"toString":{"value":"retained"}}}',
  );
  reconcileValue(target, source);
  expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
  expect(({} as any).risuPolluted).toBeUndefined();
  expect(Object.hasOwn(target, "__proto__")).toBe(true);
  expect(target.constructor.prototype.risuPolluted).toBe(true);
  const nested = target.nested;
  reconcileValue(target, { nested: { toString: { value: "updated" } } });
  expect(Object.hasOwn(target, "__proto__")).toBe(false);
  expect(Object.hasOwn(target, "constructor")).toBe(false);
  expect(target.nested).toBe(nested);
  expect(nested.toString.value).toBe("updated");
});

function deleteSyntheticMessages(f: ReturnType<typeof fixture>, ids: string[]) {
  f.store.enqueueJob("delete-" + f.store.cursor(), {
    type: "button",
    chatId: "a",
  });
  const { job, snapshot } = f.store.claimJob("synthetic-owner");
  f.store.finishJob(job.id, "synthetic-owner", job.fence, {
    state: "completed",
    writeSet: {
      chatId: "a",
      expectedRevision: snapshot.chat.revision,
      deleteMessages: ids.map((id) => ({
        id,
        expectedRevision: snapshot.messages.find((row) => row.id === id)
          .revision,
      })),
    },
  });
}

test("deleting the entire loaded suffix still allows bounded older-history recovery", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const before = f.store.cursor();
    deleteSyntheticMessages(f, ["m3", "m4"]);
    await f.replay(before);
    expect(f.model.activeChat.message).toEqual([]);
    expect(f.model.hasEarlier).toBe(true);
    expect(f.model.displayHistory(-1)).toMatchObject({ count: 3 });
    await f.model.loadEarlier();
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual([
      "m1",
      "m2",
    ]);
    await f.model.loadEarlier();
    expect(f.model.hasEarlier).toBe(false);
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual([
      "m0",
      "m1",
      "m2",
    ]);
    expect(
      f.model.activeChat.message.map(
        (_, i) => f.model.displayHistory(i).ordinal,
      ),
    ).toEqual([0, 1, 2]);
    expect(f.paths.some((path) => path.includes("Infinity"))).toBe(false);
  } finally {
    f.store.close();
  }
});

test("partial display ranks follow deletion gaps, append and replay without fetching unloaded edited bodies", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const messages = f.model.activeChat.message,
      last = messages.at(-1),
      reads = f.paths.length;
    expect(f.model.displayHistory(0)).toMatchObject({ count: 5, ordinal: 3 });
    let before = f.store.cursor();
    f.command({
      type: "edit-message",
      messageId: "m1",
      text: "Synthetic unloaded edit",
      expectedRevision: 1,
    });
    await f.replay(before);
    expect(messages.map((m) => m.chatId)).toEqual(["m3", "m4"]);
    before = f.store.cursor();
    deleteSyntheticMessages(f, ["m0"]);
    await f.replay(before);
    expect(f.model.displayHistory(0)).toMatchObject({ count: 4, ordinal: 2 });
    before = f.store.cursor();
    f.command({
      type: "append-message",
      chatId: "a",
      messageId: "m5",
      message: { role: "char", data: "Synthetic appended" },
    });
    await f.replay(before);
    await f.replay(0);
    expect(f.model.activeChat.message).toBe(messages);
    expect(messages[1]).toBe(last);
    expect(messages.map((m) => m.chatId)).toEqual(["m3", "m4", "m5"]);
    expect(messages.map((_, i) => f.model.displayHistory(i).ordinal)).toEqual([
      2, 3, 4,
    ]);
    expect(f.model.displayHistory(-1)).toMatchObject({ count: 5 });
    expect(f.paths.length).toBe(reads);
  } finally {
    f.store.close();
  }
});

test("a delayed older page is re-read after deletion instead of installing stale ranks", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const last = f.model.activeChat.message.at(-1),
      original = f.host.read;
    let release: () => void,
      started: () => void,
      armed = true;
    const gate = new Promise<void>((resolve) => (release = resolve)),
      entered = new Promise<void>((resolve) => (started = resolve));
    f.host.read = async <T>(
      path: string,
      options?: RequestInit,
    ): Promise<T> => {
      const value = await original<T>(path, options);
      if (armed && path.includes("&before=")) {
        armed = false;
        started();
        await gate;
      }
      return value;
    };
    const pending = f.model.loadEarlier();
    await entered;
    const before = f.store.cursor();
    deleteSyntheticMessages(f, ["m0"]);
    await f.replay(before);
    release();
    await pending;
    expect(f.model.hasEarlier).toBe(false);
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(f.model.activeChat.message.at(-1)).toBe(last);
    expect(
      f.model.activeChat.message.map(
        (_, i) => f.model.displayHistory(i).ordinal,
      ),
    ).toEqual([0, 1, 2, 3]);
    expect(f.model.displayHistory(-1)).toMatchObject({ count: 4 });
    expect(f.paths.filter((path) => path.includes("&before=3"))).toHaveLength(
      2,
    );
  } finally {
    f.store.close();
  }
});

test("an older page with a future cursor cannot swallow an unseen append in the latest window", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const before = f.store.cursor();
    f.command({
      type: "append-message",
      chatId: "a",
      messageId: "m5",
      message: { role: "char", data: "Synthetic append before replay" },
    });
    f.model.applySnapshot(f.store.snapshot("a", { limit: 2, before: 3 }));
    await f.replay(before);
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
    ]);
    expect(
      f.model.activeChat.message.map(
        (_, i) => f.model.displayHistory(i).ordinal,
      ),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(f.model.displayHistory(-1)).toMatchObject({ count: 6 });
  } finally {
    f.store.close();
  }
});

test("reorder refresh keeps the bounded latest window and surviving object identities with canonical ranks", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const messages = f.model.activeChat.message,
      last = messages.at(-1),
      before = f.store.cursor();
    f.store.enqueueJob("reorder", { type: "button", chatId: "a" });
    const { job, snapshot } = f.store.claimJob("synthetic-owner");
    f.store.finishJob(job.id, "synthetic-owner", job.fence, {
      state: "completed",
      writeSet: {
        chatId: "a",
        expectedRevision: snapshot.chat.revision,
        messageOrder: ["m3", "m0", "m1", "m2", "m4"],
      },
    });
    await f.replay(before);
    expect(f.model.activeChat.message).toBe(messages);
    expect(messages.at(-1)).toBe(last);
    expect(messages.map((m) => m.chatId)).toEqual(["m2", "m4"]);
    expect(messages.map((_, i) => f.model.displayHistory(i).ordinal)).toEqual([
      3, 4,
    ]);
    expect(f.model.displayHistory(-1)).toMatchObject({ count: 5 });
  } finally {
    f.store.close();
  }
});

test("pagination and message edits preserve Svelte object/array identity; changing chats evicts the old message bodies", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const chat = f.model.activeChat,
      messages = chat.message,
      last = messages.at(-1),
      extension = (last as any).extension;
    await f.model.loadEarlier();
    expect(messages.map((m) => m.chatId)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(messages.at(-1)).toBe(last);
    const before = f.store.cursor();
    f.command({
      type: "edit-message",
      messageId: "m4",
      text: "updated",
      expectedRevision: 1,
    });
    await f.replay(before);
    expect(f.model.activeChat).toBe(chat);
    expect(chat.message).toBe(messages);
    expect(messages.at(-1)).toBe(last);
    expect(last.data).toBe("updated");
    expect((last as any).extension).toBe(extension);
    await f.model.selectCharacter("c", "b");
    expect(chat.message).toEqual([]);
    await f.model.selectCharacter("c", "a");
    expect(f.model.activeChat.message.length).toBe(2);
  } finally {
    f.store.close();
  }
});

test("a delayed older snapshot cannot erase a newly received variable or revert an edited message", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const old = f.store.snapshot("a", { limit: 2 }),
      before = f.store.cursor();
    f.command({
      type: "set-chat-variable",
      chatId: "a",
      key: "$new",
      value: "confirmed",
      expectedRevision: 0,
    });
    f.command({
      type: "edit-message",
      messageId: "m4",
      text: "confirmed",
      expectedRevision: 1,
    });
    await f.replay(before);
    f.model.applySnapshot(old);
    expect(f.model.activeChat.scriptstate.$new).toBe("confirmed");
    expect(f.model.activeChat.message.at(-1).data).toBe("confirmed");
    expect(f.model.variableRevision("$new")).toBe(1);
    expect(f.model.messageRevision("m4")).toBe(2);
  } finally {
    f.store.close();
  }
});

test("a resnapshot refreshes the loaded older window and ignores old journal events without losing stable references", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    await f.model.loadEarlier();
    const existing = f.model.activeChat.message[0];
    f.command({
      type: "edit-message",
      messageId: "m1",
      text: "new older text",
      expectedRevision: 1,
    });
    await f.model.bootstrap(f.store.bootstrap());
    expect(f.model.activeChat.message[0]).toBe(existing);
    expect(existing.data).toBe("new older text");
    await f.replay(0);
    expect(existing.data).toBe("new older text");
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
  } finally {
    f.store.close();
  }
});

test("snapshot tombstones prevent old message/variable events from resurrecting deleted entities", async () => {
  const f = fixture();
  try {
    f.command({
      type: "set-chat-variable",
      chatId: "a",
      key: "$choice",
      value: "old",
      expectedRevision: 0,
    });
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    f.store.enqueueJob("button", {
      type: "button",
      chatId: "a",
      data: "synthetic",
    });
    const claimed = f.store.claimJob("worker");
    f.store.finishJob("button", "worker", claimed.job.fence, {
      state: "completed",
      writeSet: {
        chatId: "a",
        expectedRevision: claimed.snapshot.chat.revision,
        deleteMessages: [{ id: "m4", expectedRevision: 1 }],
        deleteVariables: [{ key: "$choice", expectedRevision: 1 }],
      },
    });
    await f.model.bootstrap(f.store.bootstrap());
    await f.replay(0);
    expect(f.model.activeChat.message.some((m) => m.chatId === "m4")).toBe(
      false,
    );
    expect(f.model.activeChat.scriptstate.$choice).toBeUndefined();
    expect(f.model.variableRevision("$choice")).toBe(2);
    expect(f.model.messageRevision("m4")).toBe(2);
  } finally {
    f.store.close();
  }
});

test("background chat changes do not load its archive or alter the device's active chat", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const before = f.store.cursor(),
      reads = f.paths.length;
    f.command({
      type: "append-message",
      chatId: "other",
      messageId: "background",
      message: { role: "char", data: "synthetic-background" },
    });
    await f.replay(before);
    expect(f.paths.length).toBe(reads);
    expect(f.model.activeChatId).toBe("a");
    expect(JSON.stringify(f.model.database)).not.toContain(
      "synthetic-background",
    );
  } finally {
    f.store.close();
  }
});

test("a newer selection wins while an earlier character hydration is still in flight", async () => {
  const f = fixture();
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.host.read = async <T>(path: string) => {
      if (path === "/characters/c") await gate;
      return f.read<T>(path);
    };
    await f.model.bootstrap(f.store.bootstrap());
    const first = f.model.selectCharacter("c", "a");
    expect(await f.model.selectCharacter("d", "other")).toBe(true);
    release();
    expect(await first).toBe(false);
    expect(f.model.activeChatId).toBe("other");
    expect(f.model.activeChat.message[0].data).toBe(
      "synthetic-unrelated-archive",
    );
  } finally {
    release();
    f.store.close();
  }
});

test("an empty local-global map removal survives older snapshots without recreating an absent map", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const target = { scope: "chat-global", chatId: "a", key: "toggle_test" };
    const cursor = f.store.cursor();
    f.command({
      type: "change-variables",
      edits: [{ ...target, expectedRevision: 0, value: "1" }],
    });
    f.command({
      type: "change-variables",
      edits: [{ ...target, expectedRevision: 1, remove: true }],
    });
    await f.replay(cursor);
    const stale = f.store.snapshot("a", { limit: 2 });
    f.store.enqueueJob("shape-job", { type: "send", chatId: "a" });
    const claimed = f.store.claimJob("worker");
    f.store.finishJob(claimed.job.id, "worker", claimed.job.fence, {
      state: "completed",
      writeSet: {
        chatId: "a",
        expectedRevision: claimed.snapshot.chat.revision,
        expectedContentRevision: claimed.snapshot.chat.contentRevision,
        chatGlobalShape: {
          type: "absent",
          expectedRevision: claimed.snapshot.chat.chatGlobalRevision,
        },
      },
    });
    await f.replay(stale.cursor);
    expect(f.model.activeChat.GLGlobalVariables).toBeUndefined();
    f.model.applySnapshot(stale);
    expect(f.model.activeChat.GLGlobalVariables).toBeUndefined();
    expect(
      f.model.scopedVariableRevision({
        scope: "chat-global",
        chatId: "a",
        key: "toggle_test",
      }),
    ).toBe(2);
  } finally {
    f.store.close();
  }
});

test("compact disabled delta preserves body/identity/count/ordinal and rejects stale pages and body events", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const stale = f.store.snapshot("a", { limit: 2 }),
      cursor = f.store.cursor(),
      saved = f.model.activeChat.message[0],
      neighbor = f.model.activeChat.message[1];
    f.command({
      type: "set-message-disabled",
      chatId: "a",
      messageId: "m3",
      expectedRevision: 1,
      expectedChatEpoch: 0,
      disabled: true,
    });
    f.paths.length = 0;
    await f.replay(cursor);
    expect(f.paths).toEqual([]);
    expect(f.model.activeChat.message[0]).toBe(saved);
    expect(f.model.activeChat.message[1]).toBe(neighbor);
    expect(saved.disabled).toBe(true);
    expect(saved.data).toBe(stale.messages[0].message.data);
    expect(f.model.displayHistory(0)).toMatchObject({ count: 5, ordinal: 3 });
    expect(f.model.applySnapshot(stale)).toBe(false);
    expect(f.model.applySnapshot({ ...stale, history: undefined })).toBe(false);
    await f.model.change({
      sequence: cursor,
      type: "message",
      id: "m3",
      chatId: "a",
      revision: 1,
      payload: { message: stale.messages[0].message, position: 3 },
    });
    expect(saved.disabled).toBe(true);
    expect(f.model.messageRevision("m3")).toBe(2);
  } finally {
    f.store.close();
  }
});
test("flags outside the loaded page fence an old page without loading bodies; a fresh earlier page returns the flag", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const stale = f.store.snapshot("a", { limit: 2, before: 3 }),
      cursor = f.store.cursor(),
      messages = f.model.activeChat.message;
    f.command({
      type: "set-message-disabled",
      chatId: "a",
      messageId: "m1",
      expectedRevision: 1,
      expectedChatEpoch: 0,
      disabled: "allBefore",
    });
    f.paths.length = 0;
    await f.replay(cursor);
    expect(f.paths).toEqual([]);
    expect(f.model.activeChat.message).toBe(messages);
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual([
      "m3",
      "m4",
    ]);
    expect(f.model.applySnapshot(stale)).toBe(false);
    await f.model.loadEarlier();
    expect(f.paths).toEqual(["/chats/a?limit=2&before=3"]);
    expect(
      f.model.activeChat.message.find((m) => m.chatId === "m1").disabled,
    ).toBe("allBefore");
    expect(f.model.displayHistory(0)).toMatchObject({ count: 5, ordinal: 1 });
  } finally {
    f.store.close();
  }
});
test("an older flag delta cannot undo a newer snapshot/body or cross a chat incarnation", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const cursor = f.store.cursor();
    f.command({
      type: "set-message-disabled",
      chatId: "a",
      messageId: "m3",
      expectedRevision: 1,
      expectedChatEpoch: 0,
      disabled: true,
    });
    const old = f.store.changes(cursor, 100).changes[0];
    f.command({
      type: "edit-message",
      messageId: "m3",
      expectedRevision: 2,
      text: "Synthetic later flag body",
    });
    f.command({
      type: "set-message-disabled",
      chatId: "a",
      messageId: "m3",
      expectedRevision: 3,
      expectedChatEpoch: 0,
      disabled: false,
    });
    expect(f.model.applySnapshot(f.store.snapshot("a", { limit: 2 }))).toBe(
      true,
    );
    const saved = f.model.activeChat.message[0];
    await f.model.change(old);
    expect(saved.disabled).toBe(false);
    expect(saved.data).toBe("Synthetic later flag body");
    expect(f.model.messageRevision("m3")).toBe(4);
    await f.model.change({
      ...old,
      sequence: f.store.cursor() + 1,
      revision: 5,
      payload: { ...old.payload, entityEpoch: 1 },
    });
    expect(saved.disabled).toBe(false);
    expect(f.model.messageRevision("m3")).toBe(4);
  } finally {
    f.store.close();
  }
});

test("compact single removal preserves surviving identity and canonical ordinal; stale pages cannot resurrect deletion", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const stale = f.store.snapshot("a", { limit: 2 }),
      survivor = f.model.activeChat.message[1],
      cursor = f.store.cursor();
    const header = f.model.entityHeader("chat", "a");
    f.command({
      type: "remove-message",
      chatId: "a",
      messageId: "m3",
      mode: "one",
      expectedRevision: f.model.messageRevision("m3"),
      expectedChatRevision: header.revision,
      expectedChatEpoch: header.epoch,
    });
    f.paths.length = 0;
    await f.replay(cursor);
    expect(f.paths).toEqual([]);
    expect(f.model.activeChat.message).toEqual([survivor]);
    expect(f.model.activeChat.message[0]).toBe(survivor);
    expect(f.model.displayHistory(0).ordinal).toBe(3);
    expect(f.model.displayHistory(0).count).toBe(4);
    expect(f.model.applySnapshot(stale)).toBe(false);
    expect(f.model.applySnapshot({ ...stale, history: undefined })).toBe(false);
    expect(f.model.activeChat.message[0]).toBe(survivor);
    expect(f.model.activeChat).toMatchObject({ unknown: { retained: true } });
  } finally {
    f.store.close();
  }
});

test("range removal past the loaded window atomically tops up the surviving canonical tail once", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const header = f.model.entityHeader("chat", "a"),
      cursor = f.store.cursor();
    f.command({
      type: "remove-message",
      chatId: "a",
      messageId: "m3",
      mode: "from",
      expectedRevision: 1,
      expectedChatRevision: header.revision,
      expectedChatEpoch: header.epoch,
    });
    f.paths.length = 0;
    await f.replay(cursor);
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual([
      "m1",
      "m2",
    ]);
    expect(f.model.displayHistory(0).count).toBe(3);
    expect(f.model.displayHistory(0).ordinal).toBe(1);
    expect(f.model.hasEarlier).toBe(true);
    expect(f.paths).toEqual(["/chats/a?limit=2"]);
    const single = f.model.entityHeader("chat", "a"),
      next = f.store.cursor();
    f.command({
      type: "remove-message",
      chatId: "a",
      messageId: "m1",
      mode: "from",
      expectedRevision: 1,
      expectedChatRevision: single.revision,
      expectedChatEpoch: single.epoch,
    });
    await f.replay(next);
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual(["m0"]);
    const last = f.model.entityHeader("chat", "a"),
      beforeLast = f.store.cursor();
    f.command({
      type: "remove-message",
      chatId: "a",
      messageId: "m0",
      mode: "one",
      expectedRevision: 1,
      expectedChatRevision: last.revision,
      expectedChatEpoch: last.epoch,
    });
    await f.replay(beforeLast);
    expect(f.model.activeChat.message).toEqual([]);
    expect(f.model.displayHistory(-1).count).toBe(0);
    expect(f.model.hasEarlier).toBe(false);
  } finally {
    f.store.close();
  }
});

test("late removal event cannot erase a newer snapshot, reused position or recreated message", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const header = f.model.entityHeader("chat", "a"),
      cursor = f.store.cursor();
    f.command({
      type: "remove-message",
      chatId: "a",
      messageId: "m4",
      mode: "one",
      expectedRevision: 1,
      expectedChatRevision: header.revision,
      expectedChatEpoch: header.epoch,
    });
    const removal = f.store.changes(cursor, 100).changes[0];
    f.store.transaction(() =>
      f.store.appendMessage(
        "a",
        "m4",
        { role: "char", data: "Synthetic recreated" },
        2,
      ),
    );
    f.model.applySnapshot(f.store.snapshot("a", { limit: 2 }));
    const current = f.model.activeChat.message.at(-1);
    await f.model.change(removal);
    expect(f.model.activeChat.message.at(-1)).toBe(current);
    expect(current.data).toBe("Synthetic recreated");
    expect(f.model.displayHistory(1).count).toBe(5);
  } finally {
    f.store.close();
  }
});

test("compact bookmark deltas preserve loaded messages/ordinals and cannot be undone by old snapshots or replay", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const page = f.store.snapshot("a", { limit: 2 }),
      rows = [...f.model.activeChat.message],
      cursor = f.store.cursor();
    const set = (action: string, name?: string) => {
      const h = f.store.readBookmark("a", "m4");
      return f.command({
        type: "set-bookmark",
        chatId: "a",
        messageId: "m4",
        expectedRevision: h.revision,
        expectedMessageRevision: h.messageRevision,
        expectedChatEpoch: h.entityEpoch,
        action,
        ...(name ? { name } : {}),
      });
    };
    set("add", "Synthetic bookmark");
    const old = f.store.changes(cursor).changes[0];
    f.paths.length = 0;
    await f.replay(cursor);
    expect(f.model.activeChat.bookmarks).toEqual(["m4"]);
    expect(f.model.activeChat.bookmarkNames).toEqual({
      m4: "Synthetic bookmark",
    });
    expect(f.model.activeChat.message[0]).toBe(rows[0]);
    expect(f.model.activeChat.message[1]).toBe(rows[1]);
    expect(f.model.displayHistory(1)).toMatchObject({ ordinal: 4, count: 5 });
    expect(f.paths).toEqual([]);
    f.model.applySnapshot(page);
    expect(f.model.activeChat.bookmarks).toEqual(["m4"]);
    const next = f.store.cursor();
    set("rename", "Synthetic renamed");
    await f.replay(next);
    await f.model.change(old);
    expect(f.model.activeChat.bookmarkNames.m4).toBe("Synthetic renamed");
    const header = f.model.entityHeader("chat", "a");
    await f.model.change({
      ...old,
      sequence: f.store.cursor() + 20,
      payload: { ...old.payload, entityEpoch: 999 },
    });
    expect(f.model.entityHeader("chat", "a")).toEqual(header);
    expect(f.model.activeChat.bookmarkNames.m4).toBe("Synthetic renamed");
  } finally {
    f.store.close();
  }
});

test("an unloaded bookmark member projects metadata without loading its body", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const rows = [...f.model.activeChat.message],
      h = f.store.readBookmark("a", "m0"),
      cursor = f.store.cursor();
    f.command({
      type: "set-bookmark",
      chatId: "a",
      messageId: "m0",
      expectedRevision: h.revision,
      expectedMessageRevision: h.messageRevision,
      expectedChatEpoch: h.entityEpoch,
      action: "add",
      name: "Synthetic earlier",
    });
    f.paths.length = 0;
    await f.replay(cursor);
    expect(f.model.activeChat.bookmarks).toEqual(["m0"]);
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual([
      "m3",
      "m4",
    ]);
    expect(f.model.activeChat.message[0]).toBe(rows[0]);
    expect(f.model.activeChat.message[1]).toBe(rows[1]);
    expect(f.paths).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("bookmark projection retains nonadjacent duplicates and synchronizes portable collection field removal", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const field = (key: string, value?: unknown) => {
      const h = f.store.readFields([{ scope: "chat", entityId: "a", key }])
        .fields[0];
      return {
        scope: "chat",
        entityId: "a",
        key,
        expectedRevision: h.revision,
        expectedEpoch: h.entityEpoch,
        ...(value === undefined ? { remove: true } : { value }),
      };
    };
    let cursor = f.store.cursor();
    f.command({
      type: "change-fields",
      edits: [
        field("bookmarks", ["m4", "m3", "m4", "m0", "m4"]),
        field("bookmarkNames", {
          m4: "Synthetic duplicates",
          orphan: { retained: true },
        }),
      ],
    });
    await f.replay(cursor);
    cursor = f.store.cursor();
    const h = f.store.readBookmark("a", "m4");
    f.command({
      type: "set-bookmark",
      chatId: "a",
      messageId: "m4",
      expectedRevision: h.revision,
      expectedMessageRevision: h.messageRevision,
      expectedChatEpoch: h.entityEpoch,
      action: "remove",
    });
    await f.replay(cursor);
    expect(f.model.activeChat.bookmarks).toEqual(["m3", "m4", "m0", "m4"]);
    expect(f.model.activeChat.bookmarkNames).toEqual({
      orphan: { retained: true },
    });
    cursor = f.store.cursor();
    f.command({
      type: "change-fields",
      edits: [field("bookmarks"), field("bookmarkNames")],
    });
    await f.replay(cursor);
    expect(Object.hasOwn(f.model.activeChat, "bookmarks")).toBe(false);
    expect(Object.hasOwn(f.model.activeChat, "bookmarkNames")).toBe(false);
  } finally {
    f.store.close();
  }
});

function historyFixture() {
  const f = fixture();
  for (let i = 5; i < 220; i++)
    f.command({
      type: "append-message",
      chatId: "a",
      messageId: "m" + i,
      message: {
        role: "char",
        data: "Synthetic history " + i,
        unknown: { retained: true },
      },
    });
  f.model.pageSize = 20;
  return f;
}
function syntheticReplyBatch(
  f: ReturnType<typeof fixture>,
  oldIds: string[],
  count = 3,
) {
  const snapshot = f.store.snapshot("a");
  const tail = snapshot.messages.at(-1);
  f.store.enqueueJob("synthetic-batch", {
    type: "reroll",
    chatId: "a",
    messageId: tail.id,
    expectedRevision: tail.revision,
    expectedChatEpoch: 0,
  });
  const job = f.store.claimJob("worker").job;
  f.store.finishJob(job.id, "worker", job.fence, {
    state: "completed",
    writeSet: {
      chatId: "a",
      expectedRevision: job.startedRevision,
      expectedContentRevision: job.startedContentRevision,
      deleteMessages: oldIds.map((id) => ({
        id,
        expectedRevision: snapshot.messages.find((row) => row.id === id)
          .revision,
      })),
      messages: Array.from({ length: count }, (_, i) => ({
        id: "batch-" + i,
        expectedRevision: 0,
        message: {
          role: "char",
          data: "Synthetic batch " + i,
          extension: { retain: true },
        },
      })),
    },
  });
  const move = (direction: string) => {
    const row = f.store.snapshot("a").messages.at(-1);
    const head = f.store.readReplyChoices("a", row.id, row.revision, 0);
    return f.command({ type: "move-reply-choice", ...head.target, direction });
  };
  return { move };
}
test("reply batch projection publishes one full replacement, retains prefix objects and ranks, and rejects held snapshots/replay", async () => {
  const f = fixture();
  try {
    f.model.pageSize = 10;
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const prefix = f.model.activeChat.message.slice(0, 3),
      array = f.model.activeChat.message;
    const cursor = f.store.cursor(),
      batch = syntheticReplyBatch(f, ["m3", "m4"]);
    await f.replay(cursor);
    const held = f.store.snapshot("a");
    const after = f.store.cursor();
    batch.move("previous");
    const original = (f.model as any).render.bind(f.model),
      published: string[][] = [];
    (f.model as any).render = (view: any) => {
      original(view);
      published.push(view.value.message.map((m: any) => m.chatId));
    };
    await f.replay(after);
    expect(published).toEqual([["m0", "m1", "m2", "m3", "m4"]]);
    expect(f.model.activeChat.message).toBe(array);
    for (let i = 0; i < 3; i++)
      expect(f.model.activeChat.message[i]).toBe(prefix[i]);
    expect(f.model.displayWindow()).toEqual([
      ["m0", 0],
      ["m1", 1],
      ["m2", 2],
      ["m3", 3],
      ["m4", 4],
    ]);
    expect(f.model.displayHistory(4)).toMatchObject({ ordinal: 4, count: 5 });
    expect(f.model.applySnapshot(held)).toBe(false);
    const paths = f.paths.length;
    await f.replay(after);
    expect(published).toHaveLength(1);
    expect(f.paths).toHaveLength(paths);
    expect((f.model as any).chats.get("a").messages.size).toBe(5);
    const next = f.store.cursor();
    batch.move("next");
    await f.replay(next);
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual([
      "m0",
      "m1",
      "m2",
      "batch-0",
      "batch-1",
      "batch-2",
    ]);
    expect(f.model.displayHistory(5)).toMatchObject({ ordinal: 5, count: 6 });
    expect(f.paths).toHaveLength(paths);
  } finally {
    f.store.close();
  }
});
test("reply batches bound a latest window and recover a fully removed historical window with one small page", async () => {
  for (const complete of [false, true]) {
    const f = fixture();
    try {
      await f.model.bootstrap(f.store.bootstrap());
      await f.model.selectCharacter("c", "a");
      const batch = syntheticReplyBatch(
        f,
        complete ? ["m0", "m1", "m2", "m3", "m4"] : ["m3", "m4"],
      );
      await f.model.jumpToMessage(complete ? "batch-0" : "batch-2");
      const reads = f.paths.length,
        cursor = f.store.cursor();
      batch.move("previous");
      await f.replay(cursor);
      expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual([
        "m3",
        "m4",
      ]);
      expect(f.model.displayHistory(1)).toMatchObject({ count: 5, ordinal: 4 });
      expect(f.model.hasLater).toBe(false);
      expect(f.model.isWindowed).toBe(!complete);
      expect(f.paths.length - reads).toBe(complete ? 1 : 0);
      expect(f.model.activeChat.message.length).toBe(2);
      if (!complete) {
        const after = f.store.cursor();
        batch.move("next");
        await f.replay(after);
        expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual([
          "batch-1",
          "batch-2",
        ]);
        expect(f.model.displayHistory(1)).toMatchObject({
          count: 6,
          ordinal: 5,
        });
        expect(f.paths).toHaveLength(reads);
      }
    } finally {
      f.store.close();
    }
  }
});
test("an unloaded reply batch updates a historical window's count without jumping to the tail or hydrating its bodies", async () => {
  const f = historyFixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const batch = syntheticReplyBatch(f, ["m218", "m219"]);
    await f.model.jumpToMessage("m60");
    const old = [...f.model.activeChat.message],
      held = f.store.snapshot("a", { around: "m60", limit: 20 }),
      paths = f.paths.length,
      cursor = f.store.cursor();
    batch.move("previous");
    await f.replay(cursor);
    expect(f.model.activeChat.message).toEqual(old);
    for (let i = 0; i < old.length; i++)
      expect(f.model.activeChat.message[i]).toBe(old[i]);
    expect(f.model.isWindowed).toBe(true);
    expect(f.model.hasLater).toBe(true);
    expect(f.model.displayHistory(10)).toMatchObject({
      ordinal: 60,
      count: 220,
    });
    expect(f.paths).toHaveLength(paths);
    expect(f.model.applySnapshot(held)).toBe(false);
    const next = f.store.cursor();
    batch.move("next");
    await f.replay(next);
    expect(f.model.displayHistory(10)).toMatchObject({
      ordinal: 60,
      count: 221,
    });
    expect(f.paths).toHaveLength(paths);
    expect(f.model.activeChat.message).toEqual(old);
  } finally {
    f.store.close();
  }
});
test("stable-ID history windows preserve dense ordinals through gaps, bounded two-way paging and latest return", async () => {
  const f = historyFixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    for (const id of ["m3", "m5"]) {
      const row = f.store.snapshot("a", { around: id, limit: 1 }).messages[0];
      const cursor = f.store.cursor();
      f.command({
        type: "remove-message",
        chatId: "a",
        messageId: id,
        expectedRevision: row.revision,
        expectedChatRevision: f.store.snapshot("a").chat.revision,
        expectedChatEpoch: 0,
        mode: "one",
      });
      await f.replay(cursor);
    }
    const index = await f.model.jumpToMessage("m60");
    expect(index).toBe(10);
    expect(f.model.isWindowed).toBe(true);
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual(
      Array.from({ length: 20 }, (_, i) => "m" + (50 + i)),
    );
    expect(f.model.displayHistory(index)).toMatchObject({
      ordinal: 58,
      count: 218,
    });
    expect(f.model.hasEarlier).toBe(true);
    expect(f.model.hasLater).toBe(true);
    const target = f.model.activeChat.message[index];
    await f.model.jumpToMessage("m60");
    expect(f.model.activeChat.message[index]).toBe(target);
    await f.model.loadEarlier();
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual(
      Array.from({ length: 20 }, (_, i) => "m" + (30 + i)),
    );
    await f.model.loadLater();
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual(
      Array.from({ length: 20 }, (_, i) => "m" + (50 + i)),
    );
    await f.model.loadLatest();
    expect(f.model.isWindowed).toBe(false);
    expect(f.model.hasLater).toBe(false);
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual(
      Array.from({ length: 20 }, (_, i) => "m" + (200 + i)),
    );
    expect(
      f.paths
        .filter((p) => p.includes("/chats/a?"))
        .every(
          (p) =>
            new URL(p, "http://synthetic.invalid").searchParams.get("limit") ===
            "20",
        ),
    ).toBe(true);
  } finally {
    f.store.close();
  }
});
test("historical windows retain their bodies across unloaded remote edits/appends and resync, with fresh count and ranks", async () => {
  const f = historyFixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    await f.model.jumpToMessage("m60");
    const ids = f.model.activeChat.message.map((m) => m.chatId),
      row = f.model.activeChat.message[10];
    const cursor = f.store.cursor();
    f.command({
      type: "append-message",
      chatId: "a",
      messageId: "m220",
      message: { role: "char", data: "Synthetic remote new response" },
    });
    f.command({
      type: "edit-message",
      chatId: "a",
      messageId: "m219",
      expectedRevision: 1,
      text: "Synthetic unloaded edit",
    });
    await f.replay(cursor);
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual(ids);
    expect(f.model.activeChat.message[10]).toBe(row);
    expect(f.model.newerMessageCount).toBe(151);
    expect(f.model.displayHistory(10)).toMatchObject({
      count: 221,
      ordinal: 60,
    });
    await f.model.bootstrap(f.store.bootstrap());
    expect(f.model.isWindowed).toBe(true);
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual(ids);
    expect(f.model.activeChat.message[10]).toBe(row);
  } finally {
    f.store.close();
  }
});
test("a held history window cannot override a newer navigation or a different selected conversation", async () => {
  const f = historyFixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    let release: () => void;
    let held: () => void;
    const ready = new Promise<void>((r) => (held = r));
    f.host.read = async <T>(path: string): Promise<T> => {
      const snapshot = await f.read<T>(path);
      if (path.includes("around=m60")) {
        held();
        await new Promise<void>((r) => (release = r));
      }
      return snapshot;
    };
    const delayed = f.model.jumpToMessage("m60");
    await ready;
    await f.model.loadLatest();
    release();
    expect(await delayed).toBe(-1);
    expect(f.model.isWindowed).toBe(false);
    expect(f.model.activeChat.message[0].chatId).toBe("m200");
    let releaseAgain: () => void;
    let heldAgain: () => void;
    const readyAgain = new Promise<void>((r) => (heldAgain = r));
    f.host.read = async <T>(path: string): Promise<T> => {
      const snapshot = await f.read<T>(path);
      if (path.includes("around=m60")) {
        heldAgain();
        await new Promise<void>((r) => (releaseAgain = r));
      }
      return snapshot;
    };
    const old = f.model.jumpToMessage("m60");
    await readyAgain;
    await f.model.selectCharacter("c", "b");
    releaseAgain();
    expect(await old).toBe(-1);
    expect(f.model.activeChatId).toBe("b");
    expect(f.model.activeChat.message).toEqual([]);
  } finally {
    f.store.close();
  }
});
test("automatic reorder refresh cannot cancel a held user history navigation", async () => {
  const f = historyFixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    await f.model.jumpToMessage("m60");
    let release: () => void;
    let held: () => void;
    const ready = new Promise<void>((r) => (held = r));
    let hold = true;
    f.host.read = async <T>(path: string): Promise<T> => {
      const snapshot = await f.read<T>(path);
      if (hold && path.includes("around=m120")) {
        hold = false;
        held();
        await new Promise<void>((r) => (release = r));
      }
      return snapshot;
    };
    const pending = f.model.jumpToMessage("m120");
    await ready;
    const before = f.store.cursor();
    f.store.enqueueJob("synthetic-history-reorder", {
      type: "button",
      chatId: "a",
    });
    const { job, snapshot } = f.store.claimJob("synthetic-owner");
    f.store.finishJob(job.id, "synthetic-owner", job.fence, {
      state: "completed",
      writeSet: {
        chatId: "a",
        expectedRevision: snapshot.chat.revision,
        messageOrder: snapshot.messages.map((m) => m.id).reverse(),
      },
    });
    await f.replay(before);
    release();
    expect(await pending).toBe(10);
    expect(f.model.activeChat.message[10].chatId).toBe("m120");
    expect(f.model.displayHistory(10)).toMatchObject({
      ordinal: 99,
      count: 220,
    });
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual(
      Array.from({ length: 20 }, (_, i) => "m" + (130 - i)),
    );
    expect(f.paths.filter((p) => p.includes("around=m120"))).toHaveLength(2);
  } finally {
    f.store.close();
  }
});

test("a failed held navigation recovers the old window after a deferred reorder", async () => {
  const f = historyFixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    await f.model.jumpToMessage("m60");
    let release: () => void, held: () => void;
    const ready = new Promise<void>((r) => (held = r));
    let hold = true;
    f.host.read = async <T>(path: string): Promise<T> => {
      const snapshot = await f.read<T>(path);
      if (hold && path.includes("around=m120")) {
        hold = false;
        held();
        await new Promise<void>((r) => (release = r));
      }
      return snapshot;
    };
    const pending = f.model.jumpToMessage("m120");
    await ready;
    const before = f.store.cursor();
    f.store.enqueueJob("synthetic-history-failed-reorder", {
      type: "button",
      chatId: "a",
    });
    const { job, snapshot } = f.store.claimJob("synthetic-owner");
    f.store.finishJob(job.id, "synthetic-owner", job.fence, {
      state: "completed",
      writeSet: {
        chatId: "a",
        expectedRevision: snapshot.chat.revision,
        messageOrder: snapshot.messages.map((m) => m.id).reverse(),
      },
    });
    f.command({
      type: "remove-message",
      chatId: "a",
      messageId: "m120",
      mode: "one",
      expectedRevision: 1,
      expectedChatRevision: f.store.snapshot("a").chat.revision,
      expectedChatEpoch: 0,
    });
    await f.replay(before);
    release();
    await expect(pending).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    expect(f.model.activeChat.message).toHaveLength(20);
    expect(f.model.activeChat.message[10].chatId).toBe("m60");
    expect(f.model.displayHistory(10)).toMatchObject({
      ordinal: 158,
      count: 219,
    });
    expect(f.model.activeChat.message.map((m) => m.chatId)).toEqual(
      Array.from({ length: 20 }, (_, i) => "m" + (70 - i)),
    );
  } finally {
    f.store.close();
  }
});

test("delayed pre-deletion windows reject resurrection of their deleted navigation anchor", async () => {
  const f = historyFixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    let release: () => void;
    let held: () => void;
    const ready = new Promise<void>((r) => (held = r));
    f.host.read = async <T>(path: string): Promise<T> => {
      const snapshot = await f.read<T>(path);
      if (path.includes("around=m60")) {
        held();
        await new Promise<void>((r) => (release = r));
      }
      return snapshot;
    };
    const pending = f.model.jumpToMessage("m60");
    await ready;
    f.host.read = f.read;
    const cursor = f.store.cursor();
    f.command({
      type: "remove-message",
      chatId: "a",
      messageId: "m60",
      expectedRevision: 1,
      expectedChatRevision: f.store.snapshot("a").chat.revision,
      expectedChatEpoch: 0,
      mode: "one",
    });
    await f.replay(cursor);
    release();
    await expect(pending).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    expect(f.model.activeChat.message.some((m) => m.chatId === "m60")).toBe(
      false,
    );
    expect(f.model.isWindowed).toBe(false);
  } finally {
    f.store.close();
  }
});

function setSummaryFolder(
  f: ReturnType<typeof fixture>,
  id: string,
  value?: import("./clientProtocol").Json,
) {
  const target = { scope: "chat", entityId: id, key: "folderId" };
  f.command({
    type: "change-fields",
    edits: [
      {
        ...target,
        expectedRevision: f.store.fieldRevisions(target).folderId ?? 0,
        expectedEpoch: f.store.fieldEpoch(target),
        ...(value === undefined ? { remove: true } : { value }),
      },
    ],
  });
}
function seedSummaryFolders(f: ReturnType<typeof fixture>) {
  const target = { scope: "character", entityId: "c", key: "chatFolders" };
  f.command({
    type: "change-fields",
    edits: [
      {
        ...target,
        expectedRevision: f.store.fieldRevisions(target).chatFolders ?? 0,
        expectedEpoch: f.store.fieldEpoch(target),
        value: [
          { id: "f1", name: "Synthetic one", folded: false },
          { id: "f2", name: "Synthetic two", folded: false },
        ],
      },
    ],
  });
  setSummaryFolder(f, "a", "f1");
  setSummaryFolder(f, "b", "f2");
}

test("chat summary navigation restores unopened folder membership without marking its full metadata loaded", async () => {
  const f = fixture();
  try {
    seedSummaryFolders(f);
    f.command({
      type: "create-chat",
      characterId: "c",
      chatId: "orphan",
      metadata: {
        name: "Synthetic orphan",
        folderId: "synthetic-missing-folder",
      },
    });
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const char = f.model.database.characters.find((c) => c.chaId === "c"),
      b = char.chats.find((c) => c.id === "b");
    expect(char.chats.find((c) => c.id === "a").folderId).toBe("f1");
    expect(b.folderId).toBe("f2");
    expect(char.chats.find((c) => c.id === "orphan").folderId).toBe(
      "synthetic-missing-folder",
    );
    expect(b.message).toEqual([]);
    expect(f.model.chatMetadataCursor("b")).toBe(-1);
    expect(
      f.model.fieldVersion({ scope: "chat", entityId: "b", key: "folderId" })
        .revision,
    ).toBe(1);
    expect(f.paths.some((p) => p.startsWith("/chats/b"))).toBe(false);
    expect(f.paths.some((p) => p.startsWith("/chats/orphan"))).toBe(false);
    await f.model.selectCharacter("c", "b");
    expect(b.note).toBe("synthetic note");
    expect((b as any).unknown).toEqual({ retained: true });
    expect(f.model.chatMetadataCursor("b")).toBeGreaterThanOrEqual(0);
    expect(f.paths.filter((p) => p.startsWith("/chats/b"))).toHaveLength(1);
    setSummaryFolder(f, "b");
    await f.model.ensureCharacter("c", true);
    expect(Object.hasOwn(b, "folderId")).toBe(false);
    setSummaryFolder(f, "b", null);
    await f.model.ensureCharacter("c", true);
    expect(Object.hasOwn(b, "folderId")).toBe(true);
    expect(b.folderId).toBeNull();
  } finally {
    f.store.close();
  }
});

test("delayed old chat folder summaries cannot replace a newer peer field projection or load unopened bodies", async () => {
  const f = fixture();
  let release: () => void;
  try {
    seedSummaryFolders(f);
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const stale = f.store.getCharacter("c"),
      original = f.host.read;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.host.read = async <T>(
      path: string,
      options?: RequestInit,
    ): Promise<T> => {
      if (path === "/characters/c") {
        await gate;
        return stale as T;
      }
      return original(path, options);
    };
    const refresh = f.model.ensureCharacter("c", true),
      cursor = f.store.cursor();
    setSummaryFolder(f, "b", "f1");
    await f.replay(cursor);
    const b = f.model.database.characters
      .find((c) => c.chaId === "c")
      .chats.find((c) => c.id === "b");
    expect(b.folderId).toBe("f1");
    release();
    await refresh;
    expect(b.folderId).toBe("f1");
    expect(
      f.model.fieldVersion({ scope: "chat", entityId: "b", key: "folderId" })
        .revision,
    ).toBe(2);
    expect(f.model.chatMetadataCursor("b")).toBe(-1);
    expect(f.paths.some((p) => p.startsWith("/chats/b"))).toBe(false);
  } finally {
    release?.();
    f.store.close();
  }
});

test("delayed chat folder summaries cannot resurrect a deleted incarnation after stable ID reuse", async () => {
  const f = fixture();
  let release: () => void;
  try {
    seedSummaryFolders(f);
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const stale = f.store.getCharacter("c"),
      original = f.host.read;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.host.read = async <T>(
      path: string,
      options?: RequestInit,
    ): Promise<T> => {
      if (path === "/characters/c") {
        await gate;
        return stale as T;
      }
      return original(path, options);
    };
    const refresh = f.model.ensureCharacter("c", true),
      cursor = f.store.cursor();
    f.command({
      type: "delete-chat",
      chatId: "b",
      expectedRevision: f.store.requireChat("b").revision,
      expectedEpoch: 0,
    });
    f.command({
      type: "create-chat",
      characterId: "c",
      chatId: "b",
      metadata: { name: "Synthetic new incarnation", folderId: "f1" },
    });
    await f.replay(cursor);
    release();
    await refresh;
    const chats = f.model.database.characters.find(
      (c) => c.chaId === "c",
    ).chats;
    expect(chats.filter((c) => c.id === "b")).toHaveLength(1);
    const b = chats.find((c) => c.id === "b");
    expect(b.name).toBe("Synthetic new incarnation");
    expect(b.folderId).toBe("f1");
    expect(
      f.model.fieldVersion({ scope: "chat", entityId: "b", key: "folderId" })
        .entityEpoch,
    ).toBeGreaterThan(0);
    expect(f.model.activeChatId).toBe("a");
    expect(f.paths.some((p) => p.startsWith("/chats/b"))).toBe(false);
  } finally {
    release?.();
    f.store.close();
  }
});

function navigationIntent(f: ReturnType<typeof fixture>, chatIds: string[]) {
  const owner = f.store.getCharacter("c");
  return {
    type: "reorder-chat-navigation",
    characterId: "c",
    expectedCharacterEpoch: owner.entityEpoch,
    expectedFolderRevision: owner.fieldRevisions.chatFolders ?? 0,
    expectedNavigationRevision: owner.navigationRevision,
    folderIds: [],
    chatIds,
    memberships: [],
  };
}

test("compact order events preserve selected identity, unopened metadata and newer order across a held older character response", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const active = f.model.activeChat,
      rows = [...active.message],
      old = f.store.getCharacter("c");
    let release: () => void, held: () => void;
    const ready = new Promise<void>((resolve) => (held = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    f.host.read = async <T>(path: string) => {
      if (path === "/characters/c") {
        held();
        await gate;
        return old as T;
      }
      return f.read<T>(path);
    };
    const delayed = f.model.ensureCharacter("c", true),
      cursor = f.store.cursor();
    await ready;
    f.paths.length = 0;
    f.command(navigationIntent(f, ["b", "a"]));
    await f.replay(cursor);
    expect(f.model.database.characters[0].chats.map((chat) => chat.id)).toEqual(
      ["b", "a"],
    );
    expect(f.model.database.characters[0].chatPage).toBe(1);
    expect(f.model.activeChat).toBe(active);
    expect(active.message).toEqual(rows);
    expect(f.model.database.characters[0].chats[0].message).toEqual([]);
    expect(f.model.chatMetadataCursor("b")).toBe(-1);
    release();
    await delayed;
    expect(f.model.database.characters[0].chats.map((chat) => chat.id)).toEqual(
      ["b", "a"],
    );
    expect(f.model.chatNavigationHeader("c").revision).toBe(
      f.store.getCharacter("c").navigationRevision,
    );
    expect(f.paths).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("prepend creation advances independent navigation state and a delayed old list cannot remove or reposition it", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const old = f.store.getCharacter("c"),
      cursor = f.store.cursor();
    let release: () => void, held: () => void;
    const ready = new Promise<void>((resolve) => (held = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve));
    f.host.read = async <T>(path: string) => {
      if (path === "/characters/c") {
        held();
        await gate;
        return old as T;
      }
      return f.read<T>(path);
    };
    const delayed = f.model.ensureCharacter("c", true);
    await ready;
    f.command({
      type: "create-chat",
      characterId: "c",
      chatId: "new",
      metadata: { name: "Synthetic prepend" },
      prepend: true,
    });
    await f.replay(cursor);
    release();
    await delayed;
    expect(f.model.database.characters[0].chats.map((chat) => chat.id)).toEqual(
      ["new", "a", "b"],
    );
    expect(f.model.activeChatId).toBe("a");
    expect(f.model.database.characters[0].chatPage).toBe(1);
    expect(f.model.chatNavigationHeader("c").revision).toBe(
      f.store.getCharacter("c").navigationRevision,
    );
  } finally {
    f.store.close();
  }
});

test("a previous character incarnation's compact order cannot retarget a recreated character or its active chat", async () => {
  const f = fixture();
  try {
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    let cursor = f.store.cursor();
    f.command(navigationIntent(f, ["b", "a"]));
    const oldOrder = f.store
      .changes(cursor)
      .changes.find((change: any) => change.type === "chat-order");
    await f.replay(cursor);
    const owner = f.store.getCharacter("c");
    cursor = f.store.cursor();
    f.command({
      type: "delete-character",
      characterId: "c",
      expectedRevision: owner.revision,
      expectedEpoch: owner.entityEpoch,
    });
    await f.replay(cursor);
    cursor = f.store.cursor();
    f.command({
      type: "create-character",
      characterId: "c",
      definition: {
        type: "character",
        name: "Synthetic recreated",
        firstMessage: "Synthetic greeting",
      },
      chat: { chatId: "a", metadata: { name: "Synthetic recreated chat" } },
    });
    await f.replay(cursor);
    await f.model.selectCharacter("c", "a");
    const header = f.model.chatNavigationHeader("c"),
      active = f.model.activeChat;
    await f.model.change(oldOrder);
    expect(f.model.chatNavigationHeader("c")).toEqual(header);
    expect(f.model.activeChat).toBe(active);
    expect(
      f.model.database.characters[f.model.characterIndex("c")].chats.map(
        (chat) => chat.id,
      ),
    ).toEqual(["a"]);
  } finally {
    f.store.close();
  }
});

test("a held older chat creation cannot move a loaded chat after a newer navigation order", async () => {
  const f = fixture();
  try {
    const cursor = f.store.cursor();
    f.command({
      type: "create-chat",
      characterId: "c",
      chatId: "new",
      metadata: { name: "Synthetic third" },
    });
    const oldCreation = f.store
      .changes(cursor)
      .changes.find((change: any) => change.type === "chat");
    await f.model.bootstrap(f.store.bootstrap());
    await f.model.selectCharacter("c", "a");
    const active = f.model.activeChat,
      before = f.store.cursor();
    f.command(navigationIntent(f, ["new", "a", "b"]));
    await f.replay(before);
    const header = f.model.chatNavigationHeader("c");
    f.paths.length = 0;
    await f.model.change(oldCreation);
    expect(f.model.database.characters[0].chats.map((chat) => chat.id)).toEqual(
      ["new", "a", "b"],
    );
    expect(f.model.chatNavigationHeader("c")).toEqual(header);
    expect(f.model.activeChat).toBe(active);
    expect(f.model.database.characters[0].chatPage).toBe(1);
    expect(f.paths).toEqual([]);
  } finally {
    f.store.close();
  }
});
