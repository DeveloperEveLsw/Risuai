"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createPluginUIEffects, MAX_BYTES } = require("./pluginUIEffects.cjs");
const event = () => "plugin-ui:" + randomUUID();
const response = (value, fields) => ({
  effectId: value.id,
  eventId: value.eventId,
  kind: value.kind,
  ...fields,
});
test("download bytes remain private until a completed canonical checkpoint and survive dropped GET responses", async () => {
  const e = createPluginUIEffects(),
    id = event();
  e.beginEvent(id);
  const effectId = e.stageDownload(
    "../test.json",
    "application/json;charset=utf-8",
    new Blob(['{"hello":"world"}']),
  );
  assert.deepEqual(e.snapshot(), []);
  assert.throws(() => e.readArtifact({ effectId, eventId: id }), {
    code: "PLUGIN_UI_EFFECT_CLOSED",
  });
  await e.prepareEvent(id);
  e.commitEvent(id);
  e.endEvent(id);
  const [item] = e.snapshot();
  assert.equal(item.name, ".._test.json");
  assert.equal(item.mime, "application/json");
  const a = e.readArtifact({ effectId, eventId: id }),
    b = e.readArtifact({ effectId, eventId: id });
  assert.equal(a.bytes.toString(), ' {"hello":"world"}'.trim());
  assert.deepEqual(a.bytes, b.bytes);
  a.bytes[0] = 0;
  assert.equal(e.readArtifact({ effectId, eventId: id }).bytes[0], 123);
  assert.throws(() => e.readArtifact({ effectId, eventId: event() }), {
    code: "INVALID_PLUGIN_UI_EFFECT",
  });
  assert.deepEqual(e.resolve(response(item, { received: true })), {
    effectId,
    eventId: id,
    kind: "download",
    resolved: true,
  });
  assert.throws(() => e.readArtifact({ effectId, eventId: id }), {
    code: "PLUGIN_UI_EFFECT_CLOSED",
  });
});
test("failed original events cannot publish their staged export", async () => {
  const e = createPluginUIEffects(),
    id = event();
  e.beginEvent(id);
  const effectId = e.stageDownload(
    "test.json",
    "application/json",
    new Blob(["{}"]),
  );
  await e.prepareEvent(id);
  e.failEvent(id);
  e.commitEvent(id);
  assert.deepEqual(e.snapshot(), []);
  assert.throws(() => e.readArtifact({ effectId, eventId: id }), {
    code: "PLUGIN_UI_EFFECT_CLOSED",
  });
});
test("file responses are one-use and exact event scoped with no server paths", async () => {
  const e = createPluginUIEffects(),
    id = event();
  e.beginEvent(id);
  const pending = e.request("file", { accept: "application/json,.json" }),
    [item] = e.snapshot();
  assert.equal(item.multiple, false);
  assert.throws(
    () => e.resolve(response(item, { eventId: event(), file: null })),
    { code: "INVALID_PLUGIN_UI_EFFECT" },
  );
  assert.throws(
    () =>
      e.resolve(
        response(item, {
          file: { name: "test.json", text: "{}", path: "/private" },
        }),
      ),
    { code: "INVALID_PLUGIN_UI_EFFECT" },
  );
  e.resolve(response(item, { file: { name: "test.json", text: "{}" } }));
  assert.deepEqual(await pending, { name: "test.json", text: "{}" });
  assert.throws(() => e.resolve(response(item, { file: null })), {
    code: "PLUGIN_UI_EFFECT_CLOSED",
  });
  assert.deepEqual(e.snapshot(), []);
});
test("file cancellation and reviewed confirmation rejection wake the original Promise", async () => {
  const e = createPluginUIEffects(),
    id = event();
  e.beginEvent(id);
  const pending = e.request("file", { accept: ".json" }),
    [item] = e.snapshot();
  e.resolve(response(item, { file: null }));
  assert.equal(await pending, null);
  assert.equal(e.cancelledEvent(id), true);
  e.endEvent(id);
  const next = event();
  e.beginEvent(next);
  const confirm = e.request("confirm", {
      text: "Replace these synthetic settings?",
    }),
    [question] = e.snapshot();
  e.resolve(response(question, { accepted: false }));
  assert.equal(await confirm, false);
  assert.equal(e.cancelledEvent(next), true);
});
test("owner drain cancels pending input without waiting for human interaction", async () => {
  const e = createPluginUIEffects(),
    id = event();
  e.beginEvent(id);
  const file = e.request("file", { accept: ".json" }),
    confirm = e.request("confirm", { text: "Synthetic prompt" });
  assert.deepEqual(e.cancelPending(), { cancelled: true });
  assert.equal(await file, null);
  assert.equal(await confirm, false);
  assert.deepEqual(e.snapshot(), []);
});
test("draining before an accepted handler creates its picker also cancels future reviewed interactions", async () => {
  const e = createPluginUIEffects(),
    id = event();
  e.cancelPending();
  e.beginEvent(id);
  assert.equal(await e.request("file", { accept: ".json" }), null);
  assert.equal(
    await e.request("confirm", { text: "Late reviewed import" }),
    false,
  );
  assert.equal(e.cancelledEvent(id), true);
  assert.deepEqual(e.snapshot(), []);
  await assert.rejects(
    e.request("clipboard", { text: "Cannot reach detached browser" }),
    { code: "PLUGIN_UI_EFFECT_FAILED" },
  );
});
test("clipboard text requires positive browser confirmation and a failed response poisons the event", async () => {
  const e = createPluginUIEffects(),
    id = event();
  e.beginEvent(id);
  const p = e.request("clipboard", { text: "synthetic command" }),
    [item] = e.snapshot();
  e.resolve(response(item, { ok: true }));
  await p;
  const failed = e.request("clipboard", { text: "second command" }),
    [second] = e.snapshot();
  e.resolve(response(second, { ok: false, error: "Browser denied write" }));
  await assert.rejects(failed, { code: "PLUGIN_UI_EFFECT_FAILED" });
  assert.throws(() => e.assertHealthy(), { code: "PLUGIN_UI_EFFECT_FAILED" });
});
test("combined transfer bytes and effect count are bounded before data can be committed", async () => {
  const e = createPluginUIEffects(),
    id = event();
  e.beginEvent(id);
  e.stageDownload(
    "full.json",
    "application/json",
    new Blob([Buffer.alloc(MAX_BYTES)]),
  );
  assert.throws(() => e.request("confirm", { text: "one" }), {
    code: "PLUGIN_UI_EFFECT_LIMIT",
  });
  e.close();
  const f = createPluginUIEffects();
  f.beginEvent(event());
  for (let i = 0; i < 4; i++)
    f.stageDownload(`${i}.json`, "application/json", new Blob(["{}"]));
  assert.throws(
    () =>
      f.stageDownload("overflow.json", "application/json", new Blob(["{}"])),
    { code: "PLUGIN_UI_EFFECT_LIMIT" },
  );
});
test("unbound interactions and close never leave a live pending Promise", async () => {
  const e = createPluginUIEffects();
  assert.throws(() => e.request("file", { accept: ".json" }), {
    code: "PLUGIN_UI_CAPABILITY_REQUIRED",
  });
  e.beginEvent(event());
  const p = e.request("file", { accept: ".json" });
  e.close();
  await assert.rejects(p, { code: "PLUGIN_UI_EFFECT_CLOSED" });
});
