"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createServerPluginHost } = require("./serverPluginHost.cjs");
const { createPluginStorageSession } = require("./pluginStorageSession.cjs");
const {
  WYGLORE_RELEASE,
  getWygloreRelease,
  defaultWygloreFixturePath,
} = require("./wygloreContract.cjs");
const { makeWygloreContractFixture } = require("./wygloreContractFixtures.cjs");
const fixturePath =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const actual = {
  skip: fs.existsSync(fixturePath)
    ? false
    : "Fetch the pinned public plugin using wygloreContract.cjs fetch",
};
function setup(settings = {}) {
  const fixture = makeWygloreContractFixture({ settings });
  const namespace = {
    pluginId: "wyglore",
    bundleSha: getWygloreRelease(fs.readFileSync(fixturePath, "utf8")).sha256,
    pluginEpoch: 0,
  };
  const lease = {
    namespace,
    writerId: "worker",
    token: "token",
    fence: 1,
    revision: 0,
  };
  const session = createPluginStorageSession(
    {
      namespace,
      revision: 0,
      items: [...fixture.storage].map(([key, value]) => ({
        key,
        value,
        revision: 1,
      })),
    },
    lease,
  );
  let error;
  const context = {
    getCurrentCharacter: () => fixture.character,
    getCurrentChat: () => fixture.chat,
    setCurrentChat: (next) => Object.assign(fixture.chat, next),
    getDatabase: () => fixture.database,
    readResourceValue: (value) => value,
    ensureHealthy() {
      if (error) throw error;
    },
    fail(message) {
      error ??= new Error(message);
      throw error;
    },
  };
  const plugin = {
    id: "wyglore",
    enabled: true,
    name: WYGLORE_RELEASE.name,
    version: "3.0",
    script: fs.readFileSync(fixturePath, "utf8"),
  };
  return { fixture, context, plugin, session };
}
test(
  "the real pinned server host injects and flushes original memory through a private session",
  actual,
  async () => {
    const f = setup();
    const host = await createServerPluginHost({
      plugin: f.plugin,
      context: f.context,
      storage: f.session,
    });
    try {
      assert.equal(host.status().ready, true);
      let input = [{ role: "user", content: "Green, how is the garden?" }];
      for (const hook of host.hooks.replacerbeforeRequest)
        input = await hook(input, "model");
      assert.match(
        input.map((value) => value.content).join("\n"),
        /canonical layer/,
      );
      assert.equal(host.unitsCount(), 2);
      await host.close({ success: true });
      const checkpoint = f.session.checkpoint("complete");
      assert.ok(checkpoint.writes.some((write) => /units/.test(write.key)));
      assert.ok(
        f.fixture.chat.localLore.some((entry) => entry.key === "__wl_marker__"),
      );
    } finally {
      await host.close();
    }
  },
);
test(
  "server host never silently accepts the original SSR catch-up confirmation",
  actual,
  async () => {
    const f = setup({ coldStartAuto: true });
    const host = await createServerPluginHost({
      plugin: f.plugin,
      context: f.context,
      storage: f.session,
    });
    try {
      const hook = [...host.hooks.replacerbeforeRequest][0];
      await assert.rejects(
        hook([{ role: "user", content: "Continue." }], "model"),
        /interaction DOM bridge/,
      );
      assert.throws(() => host.ensureHealthy(), /interaction DOM bridge/);
    } finally {
      await host.close().catch(() => {});
    }
  },
);
test("server plugin admission is bound to the exact public bundle", async () => {
  await assert.rejects(
    createServerPluginHost({
      plugin: {
        enabled: true,
        name: WYGLORE_RELEASE.name,
        version: "3.0",
        script: "changed",
      },
    }),
    { code: "PLUGIN_UNSUPPORTED" },
  );
});
