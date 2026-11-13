import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RisuPlugin } from "./plugins.svelte";

const mocks = vi.hoisted(() => ({
  entity: true,
  db: { plugins: [] as RisuPlugin[] },
  records: new Map<string, RisuPlugin>(),
  header: { revision: 7, epoch: 4 },
  hotReloading: [] as string[],
  save: vi.fn(),
  libraryHeader: vi.fn(),
  setDatabase: vi.fn(),
  setDatabaseLite: vi.fn(),
  selectSingleFile: vi.fn(),
  confirm: vi.fn(),
  alertError: vi.fn(),
  reportRuntimeError: vi.fn(),
  loadV3: vi.fn(),
  transpile: vi.fn(),
}));

vi.mock("../../lang", () => ({
  language: {
    duplicatePluginFoundUpdateIt: "Replace existing plugin?",
    errors: { noData: "Plugin import failed" },
  },
}));
vi.mock("../storage/database.svelte", () => ({
  getDatabase: () => mocks.db,
  getCurrentCharacter: vi.fn(),
  setDatabase: mocks.setDatabase,
  setDatabaseLite: mocks.setDatabaseLite,
}));
vi.mock("../alert", () => ({
  alertConfirm: mocks.confirm,
  alertError: mocks.alertError,
  alertPluginConfirm: vi.fn(),
}));
vi.mock("../util", () => ({
  selectSingleFile: mocks.selectSingleFile,
  sleep: vi.fn(),
}));
vi.mock("../globalApi.svelte", () => ({
  fetchNative: vi.fn(),
  globalFetch: vi.fn(),
  readImage: vi.fn(),
  saveAsset: vi.fn(),
  toGetter: vi.fn(),
}));
vi.mock("../stores.svelte", () => ({
  DBState: {
    get db() {
      return mocks.db;
    },
  },
  hotReloading: mocks.hotReloading,
  pluginAlertModalStore: { set: vi.fn() },
  selectedCharID: { subscribe: vi.fn() },
}));
vi.mock("./pluginSafety", () => ({ checkCodeSafety: vi.fn() }));
vi.mock("./pluginSafeClass", () => ({
  SafeDocument: class {},
  SafeIdbFactory: class {},
  SafeLocalStorage: class {},
}));
vi.mock("./apiV3/v3.svelte", () => ({ loadV3Plugins: mocks.loadV3 }));
vi.mock("./apiV3/transpiler", () => ({
  pluginCodeTranspiler: mocks.transpile,
}));
vi.mock("../runtime/browserRuntimeState.svelte", () => ({
  get entityRuntimeEnabled() {
    return mocks.entity;
  },
  browserRuntime: () => ({
    saveLibraryResource: mocks.save,
    libraryHeader: mocks.libraryHeader,
  }),
  reportRuntimeError: mocks.reportRuntimeError,
}));

import { importPlugin, pluginV2 } from "./plugins.svelte";

const script = `//@name Synthetic persistent plugin
//@display-name Synthetic display
//@api 3.0
//@version 1.0.0
//@arg count int
//@arg token string
//@arg added string
//@allowed-ipc read logs
globalThis.__pluginImportExecuted = true;
`;

function projectRemotePlugins() {
  mocks.db.plugins = structuredClone([...mocks.records.values()]);
}

function oldPlugin(): RisuPlugin {
  return {
    id: "9cbd7cda-dc86-49af-ad22-25df99d1a36e",
    name: "Synthetic persistent plugin",
    displayName: "Old display",
    script: "//@name Synthetic persistent plugin\n//@api 3.0\n// previous",
    arguments: { count: "int", token: "string" },
    realArg: { count: 12, token: "saved value", legacyStorage: "retain" },
    version: "3.0",
    versionOfPlugin: "0.9.0",
    customLink: [],
    argMeta: {},
    enabled: false,
    portableMetadata: { retain: ["unrecognized", "portable", "fields"] },
  } as RisuPlugin;
}

function installOldPlugin() {
  const old = oldPlugin();
  mocks.records.set(old.id!, structuredClone(old));
  projectRemotePlugins();
  return old;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entity = true;
  mocks.db = { plugins: [] };
  mocks.records.clear();
  mocks.header = { revision: 7, epoch: 4 };
  mocks.hotReloading.splice(0);
  mocks.confirm.mockResolvedValue(true);
  mocks.loadV3.mockResolvedValue(undefined);
  mocks.libraryHeader.mockImplementation(() => ({ ...mocks.header }));
  mocks.save.mockImplementation(async (kind, payload) => {
    if (kind !== "plugin" || typeof payload.id !== "string")
      throw new Error("Expected a plugin resource with a stable ID");
    mocks.records.set(payload.id, structuredClone(payload));
    projectRemotePlugins();
    return payload.id;
  });
  mocks.transpile.mockImplementation(async (code) => code);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete (globalThis as Record<string, unknown>).__pluginImportExecuted;
});

afterEach(() => {
  pluginV2.loaded = false;
  delete (globalThis as Record<string, unknown>).__pluginApis__;
  delete (globalThis as Record<string, unknown>).__pluginImportExecuted;
  vi.restoreAllMocks();
});

describe("entity plugin import durability", () => {
  test("file import parses UTF-8 metadata and sends an unchanged executable source to the server", async () => {
    mocks.selectSingleFile.mockResolvedValue({
      name: "synthetic.js",
      data: new TextEncoder().encode("\uFEFF" + script),
    });

    await importPlugin();

    expect(mocks.selectSingleFile).toHaveBeenCalledWith(["js", "ts"]);
    expect(mocks.save).toHaveBeenCalledOnce();
    const [kind, payload, expected] = mocks.save.mock.calls[0];
    expect(kind).toBe("plugin");
    expect(expected).toEqual({ revision: 0, epoch: 0 });
    expect(payload).toMatchObject({
      name: "Synthetic persistent plugin",
      displayName: "Synthetic display",
      script,
      version: "3.0",
      versionOfPlugin: "1.0.0",
      realArg: { count: 0, token: "", added: "" },
      arguments: { count: "int", token: "string", added: "string" },
      allowedIPC: ["read", "logs"],
      enabled: true,
    });
    expect(payload.id).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
    );
    expect(mocks.setDatabaseLite).not.toHaveBeenCalled();
    expect(mocks.setDatabase).not.toHaveBeenCalled();
    expect(mocks.db.plugins).toEqual([payload]);
    expect(
      mocks.loadV3.mock.calls.every(([plugins]) => plugins.length === 0),
    ).toBe(true);
    expect(
      (globalThis as Record<string, unknown>).__pluginImportExecuted,
    ).toBeUndefined();

    // A new browser starts from the accepted remote projection rather than its old memory.
    mocks.db = { plugins: [] };
    projectRemotePlugins();
    expect(mocks.db.plugins).toEqual([payload]);
  });

  test("the actual pinned WygLore source is imported without executing or modifying its body", async () => {
    const path =
      process.env.RISU_WYGLORE_PUBLIC_FIXTURE ??
      resolve(
        ".local-runtime/public-plugins/wyglore-leaf/3.1.6/WygLoreLeaf-latest.js",
      );
    const source = readFileSync(path, "utf8");
    const originalHash = createHash("sha256").update(source).digest("hex");
    expect(originalHash).toBe(
      "5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c",
    );

    await importPlugin(source);

    expect(mocks.save).toHaveBeenCalledOnce();
    const [, payload] = mocks.save.mock.calls[0];
    expect(payload).toMatchObject({
      name: "◆ WygLore Leaf",
      displayName: "◆ WygLore Leaf v3.1.6",
      version: "3.0",
      versionOfPlugin: "3.1.6",
      script: source,
      enabled: true,
    });
    expect(createHash("sha256").update(payload.script).digest("hex")).toBe(
      originalHash,
    );
    expect(mocks.loadV3).toHaveBeenCalledWith([]);
    expect(
      mocks.loadV3.mock.calls.every(([plugins]) => plugins.length === 0),
    ).toBe(true);
    expect(mocks.setDatabaseLite).not.toHaveBeenCalled();
    expect(mocks.alertError).not.toHaveBeenCalled();
  });

  test("the importer waits for a durable ACK before showing a new plugin or completing", async () => {
    let acknowledge!: () => void;
    const ack = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    mocks.save.mockImplementation(async (kind, payload) => {
      expect(kind).toBe("plugin");
      await ack;
      mocks.records.set(payload.id, structuredClone(payload));
      projectRemotePlugins();
      return payload.id;
    });
    let finished = false;
    const importing = importPlugin(script).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());

    expect(finished).toBe(false);
    expect(mocks.db.plugins).toEqual([]);
    expect(mocks.setDatabaseLite).not.toHaveBeenCalled();
    expect(mocks.loadV3).not.toHaveBeenCalled();

    acknowledge();
    await importing;
    expect(finished).toBe(true);
    expect(mocks.db.plugins).toHaveLength(1);
    expect(mocks.loadV3).toHaveBeenCalledWith([]);
  });

  test("updating an installed plugin keeps its ID, saved arguments and disabled state with the captured revision and epoch", async () => {
    const old = installOldPlugin();

    await importPlugin(script, {
      isUpdate: true,
      originalPluginName: old.name,
    });

    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledOnce();
    const [kind, payload, expected] = mocks.save.mock.calls[0];
    expect(kind).toBe("plugin");
    expect(payload).toMatchObject({
      id: old.id,
      script,
      realArg: { ...old.realArg, added: "" },
      enabled: false,
      versionOfPlugin: "1.0.0",
      portableMetadata: { retain: ["unrecognized", "portable", "fields"] },
    });
    expect(expected).toEqual({ revision: 7, epoch: 4 });
    expect(mocks.libraryHeader).toHaveBeenCalledWith("plugin", old.id);
    expect(mocks.records).toHaveLength(1);
    expect(mocks.db.plugins).toEqual([payload]);
    expect(old).toEqual(oldPlugin());
  });

  test("duplicate confirmation cannot silently adopt a peer's newer revision", async () => {
    const old = installOldPlugin();
    mocks.confirm.mockImplementation(async () => {
      mocks.header = { revision: 8, epoch: 4 };
      mocks.db.plugins[0].realArg.token = "peer edit during confirmation";
      return true;
    });

    await importPlugin(script);

    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith(
      "plugin",
      expect.objectContaining({
        id: old.id,
        realArg: { ...old.realArg, added: "" },
      }),
      { revision: 7, epoch: 4 },
    );
  });

  test("a rejected durable save leaves no phantom plugin in browser memory", async () => {
    mocks.save.mockRejectedValue(
      new Error("Synthetic resource revision conflict"),
    );

    await importPlugin(script);

    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.db.plugins).toEqual([]);
    expect(mocks.records.size).toBe(0);
    expect(mocks.setDatabaseLite).not.toHaveBeenCalled();
    expect(mocks.loadV3).not.toHaveBeenCalled();
    expect(
      mocks.alertError.mock.calls.length +
        mocks.reportRuntimeError.mock.calls.length,
    ).toBeGreaterThan(0);
  });

  test("a rejected update leaves the existing accepted script and settings unchanged", async () => {
    const old = installOldPlugin();
    mocks.save.mockRejectedValue(new Error("Synthetic incarnation conflict"));

    await importPlugin(script, {
      isUpdate: true,
      originalPluginName: old.name,
    });

    expect(mocks.db.plugins).toEqual([old]);
    expect([...mocks.records.values()]).toEqual([old]);
    expect(mocks.setDatabaseLite).not.toHaveBeenCalled();
    expect(mocks.loadV3).not.toHaveBeenCalled();
  });

  test("canceling duplicate replacement does not mutate, save or launch the installed plugin", async () => {
    const old = installOldPlugin();
    mocks.confirm.mockResolvedValue(false);

    await importPlugin(script);

    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.db.plugins).toEqual([old]);
    expect(mocks.setDatabaseLite).not.toHaveBeenCalled();
    expect(mocks.loadV3).not.toHaveBeenCalled();
  });

  test("a missing update target and an invalid rename do not create new resources", async () => {
    await importPlugin(script, {
      isUpdate: true,
      originalPluginName: "Synthetic persistent plugin",
    });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.db.plugins).toEqual([]);
    installOldPlugin();
    await importPlugin(
      script.replace("//@name Synthetic persistent plugin", "//@name Renamed"),
      {
        isUpdate: true,
        originalPluginName: "Synthetic persistent plugin",
      },
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.db.plugins).toEqual([oldPlugin()]);
  });
});

test("ordinary browser imports retain the legacy local persistence and browser plugin lifecycle", async () => {
  mocks.entity = false;

  await importPlugin(script);
  await vi.waitFor(() => expect(mocks.loadV3).toHaveBeenCalledOnce());

  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.libraryHeader).not.toHaveBeenCalled();
  expect(mocks.setDatabaseLite).toHaveBeenCalledWith(mocks.db);
  expect(mocks.db.plugins).toHaveLength(1);
  expect(mocks.db.plugins[0].script).toBe(script);
  expect(mocks.loadV3).toHaveBeenCalledWith(mocks.db.plugins);
});
