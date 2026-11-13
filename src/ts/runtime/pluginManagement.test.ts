import { beforeEach, expect, test, vi } from "vitest";
import type { RisuPlugin } from "../plugins/plugins.svelte";
import { fieldIdentity, type FieldTarget } from "./fieldCommands";

const mocks = vi.hoisted(() => ({
  entity: true,
  overlays: new Map<
    string,
    { exists: boolean; value?: unknown; entityEpoch: number }
  >(),
  header: { revision: 11, epoch: 3 },
  setField: vi.fn(),
  libraryHeader: vi.fn(),
  deleteLibraryResource: vi.fn(),
}));
vi.mock("./browserRuntimeState.svelte", () => ({
  get entityRuntimeEnabled() {
    return mocks.entity;
  },
  FieldOverlays: mocks.overlays,
  browserRuntime: () => ({
    setField: mocks.setField,
    libraryHeader: mocks.libraryHeader,
    deleteLibraryResource: mocks.deleteLibraryResource,
  }),
}));
import {
  capturePluginRemoval,
  getPluginArgument,
  getPluginEnabled,
  setPluginArgument,
  setPluginEnabled,
} from "./pluginManagement";

function fixture(): RisuPlugin {
  return {
    id: "a12b7d90-5ae9-4b48-8b83-9024a54ba01f",
    name: "Synthetic plugin",
    script: "// parse only",
    arguments: { first: "int", second: "string" },
    realArg: { first: 1, second: "confirmed" },
    version: "3.0",
    enabled: true,
    customLink: [],
    argMeta: {},
  };
}
function target(plugin: RisuPlugin, key: string): FieldTarget {
  return {
    scope: "resource",
    resourceKind: "plugin",
    entityId: plugin.id!,
    key,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.entity = true;
  mocks.overlays.clear();
  mocks.header = { revision: 11, epoch: 3 };
  mocks.libraryHeader.mockImplementation(() => mocks.header);
  mocks.setField.mockImplementation((field, value) => {
    mocks.overlays.set(fieldIdentity(field), {
      exists: value !== undefined,
      value: structuredClone(value),
      entityEpoch: 3,
    });
  });
  mocks.deleteLibraryResource.mockResolvedValue(undefined);
});

test("plugin enable toggles use a durable field intent and read its pending overlay without mutating confirmed memory", () => {
  const plugin = fixture();
  setPluginEnabled(plugin, false);
  expect(mocks.setField).toHaveBeenCalledWith(target(plugin, "enabled"), false);
  expect(plugin.enabled).toBe(true);
  expect(getPluginEnabled(plugin)).toBe(false);
  setPluginEnabled(plugin, false);
  expect(mocks.setField).toHaveBeenCalledOnce();
  setPluginEnabled(plugin, true);
  expect(mocks.setField).toHaveBeenLastCalledWith(
    target(plugin, "enabled"),
    true,
  );
  expect(getPluginEnabled(plugin)).toBe(true);
});

test("successive argument changes include pending siblings, keeping confirmed values untouched", () => {
  const plugin = fixture();
  setPluginArgument(plugin, "first", 2);
  expect(plugin.realArg).toEqual({ first: 1, second: "confirmed" });
  expect(getPluginArgument(plugin, "first")).toBe(2);
  setPluginArgument(plugin, "second", "pending");
  expect(mocks.setField).toHaveBeenLastCalledWith(target(plugin, "realArg"), {
    first: 2,
    second: "pending",
  });
  expect(plugin.realArg).toEqual({ first: 1, second: "confirmed" });
  expect(getPluginArgument(plugin, "second")).toBe("pending");
  setPluginArgument(plugin, "second", "pending");
  expect(mocks.setField).toHaveBeenCalledTimes(2);
});

test("clearing an argument removes just that entry from the pending merged resource", () => {
  const plugin = fixture();
  setPluginArgument(plugin, "first", 2);
  setPluginArgument(plugin, "second", undefined);
  expect(mocks.setField).toHaveBeenLastCalledWith(target(plugin, "realArg"), {
    first: 2,
  });
  expect(getPluginArgument(plugin, "second")).toBeUndefined();
  expect(plugin.realArg.second).toBe("confirmed");
});

test("argument names such as __proto__ stay own data properties without changing the container prototype", () => {
  const plugin = fixture();
  setPluginArgument(plugin, "__proto__", "own portable value");
  const [, args] = mocks.setField.mock.calls[0];
  expect(Object.hasOwn(args, "__proto__")).toBe(true);
  expect(args.__proto__).toBe("own portable value");
  expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
  expect(getPluginArgument(plugin, "__proto__")).toBe("own portable value");
});

test("removal captures the exact ID, revision and incarnation before confirmation and awaits the deletion ACK", async () => {
  const plugin = fixture();
  const remove = capturePluginRemoval(plugin);
  mocks.header.revision = 12;
  mocks.header.epoch = 4;
  plugin.id = "peer-replacement";
  expect(mocks.deleteLibraryResource).not.toHaveBeenCalled();
  let acknowledge!: () => void;
  const ack = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  mocks.deleteLibraryResource.mockReturnValue(ack);
  let finished = false;
  const deleting = remove().then(() => {
    finished = true;
  });
  expect(mocks.deleteLibraryResource).toHaveBeenCalledWith(
    "plugin",
    "a12b7d90-5ae9-4b48-8b83-9024a54ba01f",
    { revision: 11, epoch: 3 },
  );
  await Promise.resolve();
  expect(finished).toBe(false);
  acknowledge();
  await deleting;
  expect(finished).toBe(true);
});

test("a rejected deletion propagates the conflict and leaves the plugin unchanged", async () => {
  const plugin = fixture();
  const original = structuredClone(plugin);
  mocks.deleteLibraryResource.mockRejectedValue(
    new Error("Synthetic incarnation conflict"),
  );
  await expect(capturePluginRemoval(plugin)()).rejects.toThrow(
    "incarnation conflict",
  );
  expect(plugin).toEqual(original);
});

test("server commands reject plugin entries without a persisted resource ID", () => {
  const plugin = fixture();
  delete plugin.id;
  expect(() => setPluginEnabled(plugin, false)).toThrow("not been saved");
  expect(() => setPluginArgument(plugin, "first", 2)).toThrow("not been saved");
  expect(() => capturePluginRemoval(plugin)).toThrow("not been saved");
  expect(mocks.setField).not.toHaveBeenCalled();
  expect(mocks.deleteLibraryResource).not.toHaveBeenCalled();
});

test("ordinary browser toggles and argument edits use the original local state without server commands", () => {
  mocks.entity = false;
  const plugin = fixture();
  delete plugin.id;
  setPluginEnabled(plugin, false);
  setPluginArgument(plugin, "first", 2);
  setPluginArgument(plugin, "second", undefined);
  expect(plugin.enabled).toBe(false);
  expect(plugin.realArg).toEqual({ first: 2 });
  expect(getPluginEnabled(plugin)).toBe(false);
  expect(getPluginArgument(plugin, "first")).toBe(2);
  expect(mocks.setField).not.toHaveBeenCalled();
});
