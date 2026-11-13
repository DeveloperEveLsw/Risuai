"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { EntityStore } = require("../entity/store.cjs");
const { createNativePluginCoordinator } = require("./nativePluginRuntime.cjs");
const {
  WYGLORE_RELEASE,
  readWygloreFixture,
} = require("./wygloreContract.cjs");

for (const selection of ["empty", "missing", "listed", "disabled"])
  test(
    `native lease preparation and original plugin open share the ${selection} resource set`,
    { timeout: 15000 },
    async (t) => {
      const source = await readWygloreFixture();
      const native = await import(
        pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
      );
      const store = new EntityStore(":memory:");
      t.after(() => store.close());
      store.initializeState(native.createInitialRuntimeState());
      const row = store.getResource("settings", "global"),
        settings = { ...row.payload };
      if (selection === "missing") delete settings.pluginIds;
      else settings.pluginIds = selection === "listed" ? ["wyglore"] : [];
      store.applyCommand("settings", {
        type: "put-resource",
        kind: "settings",
        resourceId: "global",
        expectedRevision: row.revision,
        payload: settings,
      });
      store.applyCommand("plugin", {
        type: "put-resource",
        kind: "plugin",
        resourceId: "wyglore",
        expectedRevision: 0,
        payload: {
          id: "wyglore",
          name: WYGLORE_RELEASE.name,
          version: "3.0",
          enabled: true,
          script: source,
          realArg: {},
        },
      });
      store.applyCommand("character", {
        type: "create-character",
        characterId: "garden",
        definition: {
          type: "character",
          name: "Green",
          desc: "A synthetic garden.",
        },
        chat: { chatId: "chat", metadata: { localLore: [] } },
      });
      const namespace = {
        pluginId: "wyglore",
        bundleSha: WYGLORE_RELEASE.sha256,
        pluginEpoch: 0,
      };
      const initial = store.claimPluginStorage({
        namespace,
        writerId: "initial",
        authority: { kind: "browser" },
      });
      store.commitPluginStorage({
        lease: initial,
        expectedRevision: 0,
        commitId: "initial",
        writes: [
          {
            key: "wl.globalSettings.v1",
            value: JSON.stringify({
              coldStartAuto: false,
              cbsToggleFloatEnabled: false,
              updateCheckEnabled: false,
            }),
          },
        ],
      });
      store.releasePluginStorage(initial);
      if (selection === "disabled") {
        const plugin = store.getResource("plugin", "wyglore");
        store.applyCommand("disable", {
          type: "put-resource",
          kind: "plugin",
          resourceId: "wyglore",
          expectedRevision: plugin.revision,
          payload: { ...plugin.payload, enabled: false },
        });
      }
      store.enqueueJob("job", {
        type: "send",
        chatId: "chat",
        input: "A synthetic input.",
        messageId: "input",
      });
      const claimed = store.claimJob("synthetic-worker"),
        calls = [];
      const coordinator = createNativePluginCoordinator({
        job: claimed.job,
        snapshot: claimed.snapshot,
        store: {
          call: async (method, ...args) => {
            calls.push(method);
            return store[method](...args);
          },
        },
        fetch: async () => {
          throw Error(
            "No provider call is required to establish the original hook host",
          );
        },
      });
      t.after(() => coordinator.release());
      const prepared = await coordinator.prepareSnapshot(claimed.snapshot),
        context = native.createExecutionContext(prepared, {
          jobId: claimed.job.id,
        });
      const active = context
        .getDatabase()
        .plugins.filter((plugin) => plugin.enabled);
      const runtime = await coordinator.open(context);
      if (selection === "disabled") {
        assert.equal(active.length, 0);
        assert.equal(runtime, undefined);
        assert.equal(calls.includes("claimPluginStorage"), false);
        assert.equal(calls.includes("readPluginJobSnapshot"), false);
      } else {
        assert.equal(active.length, 1);
        assert.ok(runtime);
        assert.equal(
          calls.filter((method) => method === "claimPluginStorage").length,
          1,
        );
        assert.equal(
          calls.filter((method) => method === "readPluginJobSnapshot").length,
          1,
        );
        assert.equal(prepared.pluginCurrentScope.chatId, "chat");
        assert.ok(
          Object.values(runtime.editHooks).some((hooks) => hooks.size > 0),
        );
        await runtime.close();
      }
      await coordinator.release();
      assert.equal(store.readAllPluginStorage(namespace).revision, 1);
      assert.equal(store.snapshot("chat").messages.length, 0);
    },
  );
