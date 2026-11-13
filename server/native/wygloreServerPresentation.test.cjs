"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { createPluginDom } = require("./pluginDom.cjs");
const { createServerPluginHost } = require("./serverPluginHost.cjs");
const { createPluginStorageSession } = require("./pluginStorageSession.cjs");
const { makeWygloreContractFixture } = require("./wygloreContractFixtures.cjs");
const {
  WYGLORE_RELEASE,
  readWygloreFixture,
} = require("./wygloreContract.cjs");
const {
  FLOAT_DISABLE_KEY,
  createWyglorePresentationStorage,
} = require("./wygloreServerPresentation.cjs");

test("floating shortcut emergency flag is a realm-only read facade and delegates every unrelated storage operation", () => {
  const values = new Map([
    ["unrelated", "original"],
    [FLOAT_DISABLE_KEY, "0"],
  ]);
  const storage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
    clear: () => values.clear(),
  };
  let failure;
  const facade = createWyglorePresentationStorage(storage, (message, code) => {
    failure ??= Object.assign(new Error(message), { code });
    throw failure;
  });
  assert.equal(facade.getItem(FLOAT_DISABLE_KEY), "1");
  facade.setItem(FLOAT_DISABLE_KEY, "1");
  assert.throws(() => facade.setItem(FLOAT_DISABLE_KEY, "0"), {
    code: "PLUGIN_UI_CAPABILITY_REQUIRED",
  });
  assert.throws(
    () => facade.removeItem(FLOAT_DISABLE_KEY),
    (error) => error === failure,
  );
  assert.equal(values.get(FLOAT_DISABLE_KEY), "0");
  assert.equal(facade.length, 2);
  assert.equal(facade.key(0), "unrelated");
  assert.equal(facade.getItem("unrelated"), "original");
  facade.setItem("other", "changed");
  assert.equal(values.get("other"), "changed");
  facade.removeItem("other");
  assert.equal(values.has("other"), false);
  facade.clear();
  assert.equal(values.size, 0);
  assert.equal(facade.getItem(FLOAT_DISABLE_KEY), "1");
});

test("actual default-true floating shortcut cannot poison native memory hooks after its original three-second defer", async (t) => {
  const f = makeWygloreContractFixture({
    settings: { cbsToggleFloatEnabled: undefined },
  });
  assert.equal(
    JSON.parse(f.storage.get("wl.globalSettings.v1")).cbsToggleFloatEnabled,
    undefined,
  );
  const namespace = {
    pluginId: "wyglore",
    bundleSha: WYGLORE_RELEASE.sha256,
    pluginEpoch: 0,
  };
  const storage = createPluginStorageSession(
    {
      namespace,
      revision: 0,
      items: [...f.storage].map(([key, value]) => ({
        key,
        value,
        revision: 1,
      })),
    },
    {
      namespace,
      writerId: "synthetic",
      token: "synthetic",
      fence: 1,
      revision: 0,
    },
  );
  let error,
    requests = 0;
  const context = {
    getCurrentCharacter: () => f.character,
    getCurrentChat: () => f.chat,
    setCurrentChat: (next) => Object.assign(f.chat, next),
    getDatabase: () => f.database,
    readResourceValue: (value) => value,
    ensureHealthy() {
      if (error) throw error;
    },
    fail(message) {
      error ??= new Error(message);
      throw error;
    },
  };
  const dom = createPluginDom();
  const script = await readWygloreFixture();
  const host = await createServerPluginHost({
    plugin: {
      id: "wyglore",
      enabled: true,
      name: WYGLORE_RELEASE.name,
      version: "3.0",
      script,
    },
    context,
    storage,
    dom,
    fetch: async () => {
      requests++;
      throw Error("The synthetic memory hooks need no network");
    },
  });
  t.after(async () => {
    await host.close().catch(() => {});
    dom.stop();
  });
  assert.equal(host.parameters().cbsToggleFloatEnabled, true);
  await delay(3300);
  host.ensureHealthy();
  const before = [...host.hooks.replacerbeforeRequest][0];
  const after = [...host.hooks.replacerafterRequest][0];
  const injected = await before(
    [{ role: "user", content: "How is the garden?" }],
    "model",
  );
  assert.match(
    injected.map((message) => message.content).join("\n"),
    /canonical layer/,
  );
  const rendered = await after(
    'Blue flowers. <at-elapsed duration="1d"/>',
    "model",
  );
  assert.doesNotMatch(rendered, /at-elapsed/);
  await host.settle();
  host.ensureHealthy();
  assert.equal(host.parameters().cbsToggleFloatEnabled, true);
  assert.equal(requests, 0);
  assert.ok(host.unitsCount() >= 2);
  await host.close({ success: true });
  const checkpoint = storage.checkpoint("complete");
  assert.ok(checkpoint.writes.some((write) => /units/.test(write.key)));
  assert.equal(
    checkpoint.writes.some((write) => write.key === FLOAT_DISABLE_KEY),
    false,
  );
  assert.equal(script, await readWygloreFixture());
});
