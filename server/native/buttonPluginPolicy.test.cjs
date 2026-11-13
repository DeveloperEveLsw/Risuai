"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { EntityStore } = require("../entity/store.cjs");
const {
  reviewButtonPlugins,
  BUTTON_INERT_WYGLORE_BUNDLES,
} = require("./buttonPluginPolicy.cjs");
const { createServerPluginHost } = require("./serverPluginHost.cjs");
const { createPluginStorageSession } = require("./pluginStorageSession.cjs");
const { createPluginDom } = require("./pluginDom.cjs");
const { makeWygloreContractFixture } = require("./wygloreContractFixtures.cjs");
const { getWygloreRelease } = require("./wygloreContract.cjs");

function snapshot(plugins = []) {
  return {
    character: { id: "garden", revision: 4, entityEpoch: 1 },
    chat: { id: "chat", revision: 5, entityEpoch: 2 },
    resources: [
      {
        kind: "settings",
        id: "global",
        revision: 2,
        entityEpoch: 0,
        payload: {},
      },
      ...plugins.map((payload, index) => ({
        kind: "plugin",
        id: payload.id,
        revision: index + 3,
        entityEpoch: index + 1,
        payload,
      })),
    ],
  };
}

test("button-inert admission remains separately pinned when general plugin support grows", () => {
  assert.ok(Object.isFrozen(BUTTON_INERT_WYGLORE_BUNDLES));
  assert.deepEqual(BUTTON_INERT_WYGLORE_BUNDLES, [
    "5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c",
    "ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9",
  ]);
});

test("unknown active plugins are rejected before any character button can execute", () => {
  for (const plugin of [
    { id: "unknown", name: "unknown", enabled: true, script: "unknown" },
    {
      id: "wyglore",
      name: "◆ WygLore Leaf",
      version: "3.0",
      enabled: true,
      script: "changed",
    },
  ])
    assert.throws(() => reviewButtonPlugins(snapshot([plugin])), {
      code: "PLUGIN_UNSUPPORTED",
    });
});

test("without an active reviewed WygLore, existing strict plugin admission remains in charge", () => {
  assert.equal(reviewButtonPlugins(snapshot()), null);
  assert.equal(
    reviewButtonPlugins(
      snapshot([{ id: "inactive", enabled: false, script: "unknown" }]),
    ),
    null,
  );
});

for (const version of ["3.1.6", "3.2.0"]) {
  const fixturePath = join(
    __dirname,
    "../../.local-runtime/public-plugins/wyglore-leaf",
    version,
    "WygLoreLeaf-latest.js",
  );
  const actual = {
    skip: fs.existsSync(fixturePath)
      ? false
      : `Fetch the pinned public WygLore ${version} fixture`,
  };
  test(
    `only captured exact ${version} WygLore is inert for the button policy`,
    actual,
    () => {
      const plugin = {
        id: "wyglore",
        name: "◆ WygLore Leaf",
        version: "3.0",
        enabled: true,
        script: fs.readFileSync(fixturePath, "utf8"),
      };
      const admission = reviewButtonPlugins(snapshot([plugin]));
      assert.equal(admission.pluginId, "wyglore");
      assert.equal(admission.pluginRequiresServerHost(plugin, {}), false);
      for (const changed of [
        { ...plugin, script: plugin.script + "\n" },
        { ...plugin, id: "new-plugin" },
        { ...plugin, name: "unknown" },
      ])
        assert.equal(admission.pluginRequiresServerHost(changed, {}), true);
      assert.throws(
        () =>
          reviewButtonPlugins(snapshot([plugin, { ...plugin, id: "second" }])),
        { code: "PLUGIN_UNSUPPORTED" },
      );
      const inactive = { id: "inactive", enabled: false, script: "unknown" };
      const withInactive = reviewButtonPlugins(snapshot([plugin, inactive]));
      assert.deepEqual(withInactive.reads.resources, [
        { kind: "settings", id: "global", revision: 2, epoch: 0 },
        { kind: "plugin", id: "wyglore", revision: 3, epoch: 1 },
        { kind: "plugin", id: "inactive", revision: 4, epoch: 2 },
      ]);
      assert.deepEqual(withInactive.reads.characters, [
        { id: "garden", revision: 4, epoch: 1 },
      ]);
      assert.deepEqual(withInactive.reads.chats, [
        { id: "chat", revision: 5, epoch: 2 },
      ]);
      assert.deepEqual(withInactive.reads.collectionSets, [
        { kind: "plugin", ids: ["inactive", "wyglore"] },
      ]);
      assert.equal(withInactive.pluginRequiresServerHost(inactive, {}), false);
      assert.equal(
        withInactive.pluginRequiresServerHost(
          { ...inactive, enabled: true },
          {},
        ),
        true,
      );
    },
  );

  test(
    `original Lua button writes and notices are identical with full ${version} boot or deferred plugin boot`,
    actual,
    async (t) => {
      const native = await import(
        pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
      );
      const store = new EntityStore(":memory:");
      t.after(() => store.close());
      store.initializeState(native.createInitialRuntimeState());
      const plugin = {
        id: "wyglore",
        name: "◆ WygLore Leaf",
        version: "3.0",
        enabled: true,
        script: fs.readFileSync(fixturePath, "utf8"),
      };
      store.applyCommand("synthetic-plugin", {
        type: "put-resource",
        kind: "plugin",
        resourceId: plugin.id,
        expectedRevision: 0,
        payload: plugin,
      });
      store.applyCommand("synthetic-character", {
        type: "create-character",
        characterId: "garden",
        definition: {
          type: "character",
          name: "Green",
          desc: "A synthetic gardener.",
          firstMessage: "Welcome to the garden.",
          globalLore: [],
          triggerscript: [
            {
              effect: [
                {
                  type: "triggerlua",
                  code: `
function onButtonClick(id, data)
  setChatVar(id, "selected", data)
  setChatVar(id, "count", tostring(tonumber(getChatVar(id, "count")) + 1))
  alertNormal(id, "Saved the selection")
  return data
end`,
                },
              ],
            },
          ],
          defaultVariables: "count=0",
        },
        chat: {
          chatId: "chat",
          metadata: { name: "Synthetic garden", localLore: [] },
        },
      });
      store.enqueueJob("synthetic-button", {
        type: "button",
        chatId: "chat",
        data: "blue",
      });
      const claimed = store.claimJob("synthetic-worker");
      const admission = reviewButtonPlugins(claimed.snapshot);
      const effects = { full: [], deferred: [] };
      async function execute(full) {
        return native.executeExtensionJob(structuredClone(claimed), {
          appVer: "2026.8.250",
          pluginRequiresServerHost: admission.pluginRequiresServerHost,
          alertNormal: (value) =>
            effects[full ? "full" : "deferred"].push(value),
          fetch: async (path) =>
            new Response(
              fs.readFileSync(join(__dirname, "../../public", path.slice(1))),
            ),
          ...(full
            ? {
                openPluginRuntime: async (context) => {
                  const fixture = makeWygloreContractFixture();
                  const namespace = {
                    pluginId: plugin.id,
                    bundleSha: getWygloreRelease(plugin.script).sha256,
                    pluginEpoch: 0,
                  };
                  const storage = createPluginStorageSession(
                    {
                      namespace,
                      revision: 0,
                      items: [...fixture.storage].map(([key, value]) => ({
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
                  const dom = createPluginDom();
                  const host = await createServerPluginHost({
                    plugin,
                    context,
                    storage,
                    dom,
                    fetch: fixture.host.nativeFetch,
                  });
                  return {
                    editHooks: host.hooks,
                    requestHooks: host.hooks,
                    pluginRequiresServerHost:
                      admission.pluginRequiresServerHost,
                    complete: async () => {
                      await host.close({ success: true });
                    },
                    close: async () => {
                      await host.close();
                      dom.stop();
                      storage.discard();
                    },
                  };
                },
              }
            : {}),
        });
      }
      const full = await execute(true);
      const deferred = await execute(false);
      const { resourceReads: fullReads, ...fullWrites } = full.writeSet;
      const { resourceReads: deferredReads, ...deferredWrites } =
        deferred.writeSet;
      assert.deepEqual(deferredWrites, fullWrites);
      for (const read of deferredReads)
        assert.ok(
          fullReads.some((row) => JSON.stringify(row) === JSON.stringify(read)),
        );
      // The old plugin boot also read the selected persona for its own cache;
      // the deferred path never evaluates that unrelated resource.
      assert.ok(
        fullReads
          .filter(
            (row) =>
              !deferredReads.some(
                (read) => JSON.stringify(row) === JSON.stringify(read),
              ),
          )
          .every((row) => row.kind === "persona"),
      );
      assert.deepEqual(deferred.result, full.result);
      assert.deepEqual(effects.deferred, effects.full);
      assert.deepEqual(effects.deferred, ["Saved the selection"]);
      assert.equal(deferred.result.value, "blue");
      assert.ok(
        deferred.writeSet.variables.some(
          (variable) =>
            variable.key === "$selected" && variable.value === "blue",
        ),
      );
      assert.ok(
        deferred.writeSet.variables.some(
          (variable) => variable.key === "$count" && variable.value === "1",
        ),
      );
    },
  );

  for (const longChat of [false, true])
    test(
      `real ${version} boot/flush has request-only hooks and no character state changes (${longChat ? "long" : "short"} chat)`,
      actual,
      async () => {
        const fixture = makeWygloreContractFixture({ longChat });
        const plugin = {
          id: "wyglore",
          name: "◆ WygLore Leaf",
          version: "3.0",
          enabled: true,
          script: fs.readFileSync(fixturePath, "utf8"),
        };
        const namespace = {
          pluginId: plugin.id,
          bundleSha: getWygloreRelease(plugin.script).sha256,
          pluginEpoch: 0,
        };
        const storage = createPluginStorageSession(
          {
            namespace,
            revision: 0,
            items: [...fixture.storage].map(([key, value]) => ({
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
        let failure;
        let chatWrites = 0;
        const context = {
          getCurrentCharacter: () => fixture.character,
          getCurrentChat: () => fixture.chat,
          setCurrentChat(next) {
            chatWrites++;
            Object.assign(fixture.chat, next);
          },
          getDatabase: () => fixture.database,
          readResourceValue: (value) => value,
          ensureHealthy() {
            if (failure) throw failure;
          },
          fail(message) {
            failure ??= new Error(message);
            throw failure;
          },
        };
        const dom = createPluginDom({
          alertSelect: async () => {
            throw new Error("Unexpected synthetic interaction");
          },
        });
        const originalChat = structuredClone(fixture.chat);
        const originalDatabase = structuredClone(fixture.database);
        let host;
        try {
          host = await createServerPluginHost({
            plugin,
            context,
            storage,
            dom,
            fetch: fixture.host.nativeFetch,
          });
          assert.deepEqual(
            Object.fromEntries(
              Object.entries(host.hooks).map(([name, handlers]) => [
                name,
                handlers.size,
              ]),
            ),
            {
              editinput: 0,
              editoutput: 0,
              editdisplay: 0,
              editprocess: 0,
              replacerbeforeRequest: 1,
              replacerafterRequest: 1,
            },
          );
          await host.close({ success: true });
          assert.equal(chatWrites, 0);
          assert.deepEqual(fixture.chat, originalChat);
          assert.deepEqual(fixture.database, originalDatabase);
          assert.equal(
            fixture.calls.filter((call) => call.method === "provider").length,
            0,
          );
          // Boot and finalization do write the private plugin cache/diagnostics.
          // Deferring these until generation/UI is the explicit policy change;
          // do not incorrectly claim that initializing WygLore is side-effect free.
          const checkpoint = storage.checkpoint("synthetic");
          assert.ok(
            checkpoint.writes.some((write) => write.key === "wl.diag.boot.v1"),
          );
          assert.ok(
            checkpoint.writes.some(
              (write) => write.key === "wl.canon-cache.v1",
            ),
          );
        } finally {
          await host?.close().catch(() => {});
          dom.stop();
          storage.discard();
        }
      },
    );
}
