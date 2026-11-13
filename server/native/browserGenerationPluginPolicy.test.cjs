"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const {
  reviewBrowserGenerationPlugins,
} = require("./browserGenerationPluginPolicy.cjs");
const { pluginRequiresServerHost } = require("./pluginAdmission.cjs");
const { HOLOCALL_BUTTON_RELEASE } = require("./holocallButtonContract.cjs");

const holoPath = join(
  __dirname,
  "../../.local-runtime/public-plugins/creditail-holocall-bridge/1.3.0/creditail_holocall_bridge.js",
);
const actual = {
  skip: fs.existsSync(holoPath)
    ? false
    : "Preserve the reviewed original HoloCall fixture",
};
const holocall = () => ({
  id: "holo",
  name: "creditail_holocall_bridge",
  version: "3.0",
  enabled: true,
  script: fs.readFileSync(holoPath, "utf8"),
  realArg: { synthetic: "unchanged" },
});
function snapshot(plugins) {
  return {
    character: { id: "c", revision: 2, entityEpoch: 1 },
    chat: { id: "a", revision: 3, entityEpoch: 4 },
    resources: [
      {
        kind: "settings",
        id: "global",
        revision: 4,
        entityEpoch: 0,
        payload: {},
      },
      ...plugins.map((payload, i) => ({
        kind: "plugin",
        id: payload.id,
        revision: i + 5,
        entityEpoch: i + 1,
        payload,
      })),
    ],
  };
}

test("ordinary generations without an active HoloCall keep existing admission semantics", () => {
  for (const type of ["send", "continue", "reroll", "memory-summary"])
    assert.equal(
      reviewBrowserGenerationPlugins(
        snapshot([{ id: "unknown", enabled: true }]),
        type,
      ),
      null,
    );
});

test(
  "reviewed HoloCall omission is scoped to generation types and never changes global admission",
  actual,
  () => {
    const plugin = holocall();
    const captured = snapshot([plugin]);
    const before = structuredClone(captured);
    for (const type of ["send", "continue", "reroll", "memory-summary"]) {
      const admission = reviewBrowserGenerationPlugins(captured, type);
      assert.equal(admission.pluginRequiresServerHost(plugin, {}), false);
      assert.equal(admission.checkpoint.kind, "browser-generation-v1");
      assert.equal(
        admission.checkpoint.bundleSha,
        HOLOCALL_BUTTON_RELEASE.sha256,
      );
      assert.equal(admission.checkpoint.pluginId, plugin.id);
    }
    for (const type of ["button", "unknown", undefined])
      assert.equal(reviewBrowserGenerationPlugins(captured, type), null);
    assert.equal(pluginRequiresServerHost(plugin, {}), true);
    assert.deepEqual(captured, before);
  },
);

test(
  "generation admission pins captured identity and source, not just reported plugin name",
  actual,
  () => {
    const plugin = holocall();
    const admission = reviewBrowserGenerationPlugins(
      snapshot([plugin]),
      "send",
    );
    for (const changed of [
      { ...plugin, id: "new" },
      { ...plugin, script: plugin.script + "\n" },
      { ...plugin, name: "renamed" },
      { ...plugin, version: "3.1" },
    ])
      assert.equal(admission.pluginRequiresServerHost(changed, {}), true);
  },
);

test(
  "generation review rejects altered HoloCall and unrelated active plugins before execution",
  actual,
  () => {
    const plugin = holocall();
    for (const plugins of [
      [{ ...plugin, script: plugin.script + "\n" }],
      [{ ...plugin, version: "3.1" }],
      [
        plugin,
        { id: "unknown", enabled: true, name: "unknown", script: "unknown" },
      ],
    ])
      assert.throws(
        () => reviewBrowserGenerationPlugins(snapshot(plugins), "send"),
        { code: "PLUGIN_UNSUPPORTED" },
      );
  },
);

test(
  "HoloCall generation review guards all inactive and active plugins plus collection and scope",
  actual,
  () => {
    const plugin = holocall();
    const admission = reviewBrowserGenerationPlugins(
      snapshot([plugin, { id: "inactive", enabled: false }]),
      "send",
    );
    assert.deepEqual(admission.checkpoint.reads, {
      version: 1,
      characters: [{ id: "c", revision: 2, epoch: 1 }],
      chats: [{ id: "a", revision: 3, epoch: 4 }],
      resources: [
        { kind: "settings", id: "global", revision: 4, epoch: 0 },
        { kind: "plugin", id: "holo", revision: 5, epoch: 1 },
        { kind: "plugin", id: "inactive", revision: 6, epoch: 2 },
      ],
      collectionSets: [{ kind: "plugin", ids: ["holo", "inactive"] }],
    });
  },
);

for (const version of ["3.1.6", "3.2.0"]) {
  const path = join(
    __dirname,
    `../../.local-runtime/public-plugins/wyglore-leaf/${version}/WygLoreLeaf-latest.js`,
  );
  test(
    `generation policy leaves WygLore ${version} request hooks to its real server host`,
    {
      skip:
        actual.skip ||
        (fs.existsSync(path) ? false : "Preserve the original WygLore fixture"),
    },
    () => {
      const holo = holocall();
      const wyg = {
        id: "wyg",
        name: "◆ WygLore Leaf",
        version: "3.0",
        enabled: true,
        script: fs.readFileSync(path, "utf8"),
      };
      const admission = reviewBrowserGenerationPlugins(
        snapshot([holo, wyg]),
        "send",
      );
      assert.equal(admission.pluginRequiresServerHost(holo, {}), false);
      assert.equal(admission.pluginRequiresServerHost(wyg, {}), true);
      assert.throws(
        () =>
          reviewBrowserGenerationPlugins(
            snapshot([holo, wyg, { ...wyg, id: "second" }]),
            "send",
          ),
        { code: "PLUGIN_UNSUPPORTED" },
      );
    },
  );
}
