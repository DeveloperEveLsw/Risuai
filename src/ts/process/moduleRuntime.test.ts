// @vitest-environment node
import { expect, test } from "vitest";
import { createModuleRuntime, type ModuleRuntimeHost } from "./moduleRuntime";
import type { RisuModule } from "./modules";

function context(name: string, modules: RisuModule[]) {
  const db = { modules, enabledModules: [name], moduleIntergration: "" };
  const chat = { modules: [] as string[] };
  const character = { modules: [] as string[] };
  const runtime = createModuleRuntime({
    readResourceValue: (value) => value,
    getDatabase: () => db,
    getCurrentChat: () => chat,
    getCurrentCharacter: () => character,
    checkPersonaBinded: () => null,
  } as unknown as ModuleRuntimeHost);
  return { db, chat, character, runtime };
}

test("module definitions and cached selection stay within each execution context", () => {
  expect(typeof document).toBe("undefined");
  const a = context("same", [
    { id: "same", name: "Alpha", description: "synthetic" },
  ]);
  const b = context("same", [
    { id: "same", name: "Beta", description: "synthetic" },
  ]);
  expect(a.runtime.getModules().map((m) => m.name)).toEqual(["Alpha"]);
  expect(b.runtime.getModules().map((m) => m.name)).toEqual(["Beta"]);
  a.db.modules = [
    { id: "same", name: "Alpha revised", description: "synthetic" },
  ];
  a.runtime.refreshModules();
  expect(a.runtime.getModules().map((m) => m.name)).toEqual(["Alpha revised"]);
  expect(b.runtime.getModules().map((m) => m.name)).toEqual(["Beta"]);
});

test("upstream global, character, chat and namespace activation preserves order and deduplicates IDs", () => {
  const a = context("global", [
    {
      id: "chat",
      namespace: "tools",
      name: "Chat",
      description: "",
      customModuleToggle: "tool=Tool",
    },
    {
      id: "global",
      name: "Global",
      description: "",
      assets: [["image", "asset/image", "png"]],
    },
    {
      id: "character",
      name: "Character",
      description: "",
      regex: [
        { comment: "synthetic", in: "one", out: "two", type: "editoutput" },
      ],
    },
  ]);
  a.chat.modules = ["tools"];
  a.character.modules = ["character", "global"];
  expect(a.runtime.getModules().map((m) => m.id)).toEqual([
    "chat",
    "global",
    "character",
  ]);
  expect(a.runtime.getModuleAssets()).toEqual([
    ["image", "asset/image", "png"],
  ]);
  expect(a.runtime.getModuleRegexScripts()[0].out).toBe("two");
  expect(a.runtime.getModuleToggles()).toContain("tool=Tool");
});
