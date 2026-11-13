// @vitest-environment node
import { expect, test } from "vitest";
import type { Database } from "../storage/database.svelte";
import { LLMFlags } from "../model/types";
import { settingValues } from "./settingIntents";
import { botSettingValues } from "./botSettingIntents";

test("nested setting edits copy only touched fields, preserve siblings and capture caller values", () => {
  const settings = {
    google: {
      projectId: "old",
      accessToken: "synthetic-token",
      extension: { keep: true },
    },
    bias: [
      ["first", 1],
      ["second", 2],
    ],
    get unrelatedArchive(): never {
      throw new Error("Unrelated field was read");
    },
  };
  const source = { synthetic: [1] };
  const values = settingValues(settings, [
    { path: ["google", "projectId"], value: "new" },
    { path: ["google", "extension", "added"], value: source },
    { path: ["bias", 1, 1], value: 9 },
  ]);
  source.synthetic.push(2);
  expect([...values.keys()]).toEqual(["google", "bias"]);
  expect(values.get("google")).toEqual({
    projectId: "new",
    accessToken: "synthetic-token",
    extension: { keep: true, added: { synthetic: [1] } },
  });
  expect(values.get("bias")).toEqual([
    ["first", 1],
    ["second", 9],
  ]);
  expect(settings.google.projectId).toBe("old");
  expect(settings.bias[1][1]).toBe(2);
});

test("invalid paths and separately stored collections cannot mutate canonical settings", () => {
  const settings = { custom: { keep: true } };
  for (const path of [
    ["custom", "__proto__", "x"],
    ["custom", -1],
    ["characters", 0],
    ["botPresets", 0],
  ])
    expect(() => settingValues(settings, [{ path, value: 1 }])).toThrow();
  expect(settings.custom).toEqual({ keep: true });
  expect(
    settingValues(settings, [
      { path: ["custom", "keep"], value: undefined },
    ]).get("custom"),
  ).toEqual({});
});

test("NanoGPT key/subscription transitions reset related configuration in one intent without observer writes", () => {
  const db = {
    nanogptKey: "synthetic-key",
    nanogptUseSubscriptionEndpoint: true,
    nanogptSubscriptionState: "active",
    nanogptRequestModel: "old",
    nanogptRequestModelName: "Old",
    nanogptProvider: "old-provider",
  } as unknown as Database;
  const flags = () => [];
  expect(botSettingValues(db, [], flags).size).toBe(0);
  expect(
    Object.fromEntries(
      botSettingValues(db, [{ path: ["nanogptKey"], value: "" }], flags),
    ),
  ).toEqual({
    nanogptKey: "",
    nanogptUseSubscriptionEndpoint: false,
    nanogptSubscriptionState: "",
    nanogptRequestModel: "",
    nanogptRequestModelName: "",
    nanogptProvider: "",
  });
  expect(db.nanogptRequestModel).toBe("old");
  const selection = botSettingValues(
    db,
    [
      { path: ["nanogptRequestModel"], value: "new" },
      { path: ["nanogptRequestModelName"], value: "New" },
    ],
    flags,
  );
  expect(Object.fromEntries(selection)).toEqual({
    nanogptRequestModel: "new",
    nanogptRequestModelName: "New",
    nanogptProvider: "",
  });
});

test("provider credentials, streaming and model-dependent thinking changes include their dependent fields", () => {
  const db = {
    google: { accessToken: "synthetic", projectId: "old", extension: 7 },
    vertexAccessToken: "synthetic-cached",
    vertexAccessTokenExpires: 9,
    aiModel: "old",
    subModel: "old",
    thinkingType: "budget",
    textgenWebUIStreamURL: "wss://synthetic.invalid",
    useStreaming: false,
  } as unknown as Database;
  expect(
    Object.fromEntries(
      botSettingValues(
        db,
        [{ path: ["google", "projectId"], value: "new" }],
        () => [],
      ),
    ),
  ).toEqual({
    google: { accessToken: "synthetic", projectId: "new", extension: 7 },
    vertexAccessToken: "",
    vertexAccessTokenExpires: 0,
  });
  expect(
    Object.fromEntries(
      botSettingValues(
        db,
        [{ path: ["aiModel"], value: "textgen_webui" }],
        () => [LLMFlags.claudeAdaptiveThinking],
      ),
    ),
  ).toEqual({
    aiModel: "textgen_webui",
    useStreaming: true,
    thinkingType: "adaptive",
  });
});
