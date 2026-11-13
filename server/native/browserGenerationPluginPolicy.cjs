"use strict";

const { RuntimeError } = require("../entity/errors.cjs");
const { pluginRequiresServerHost } = require("./pluginAdmission.cjs");
const { matchesWygloreRelease } = require("./wygloreContract.cjs");
const {
  HOLOCALL_BUTTON_RELEASE,
  matchesHolocallButtonRelease,
} = require("./holocallButtonContract.cjs");
const {
  createPluginReadDependencies,
} = require("./pluginReadDependencies.cjs");

const GENERATION_TYPES = Object.freeze([
  "send",
  "continue",
  "reroll",
  "memory-summary",
]);

/** The pinned bridge registers browser DOM/composer listeners, not native
 * request/edit hooks. Ordinary generation must not boot its independent manual
 * HoloCall sender. This exception does not implement that browser sender on the
 * server, admit arbitrary plugins, or skip WygLore's real request hooks.
 */
function reviewBrowserGenerationPlugins(snapshot, type) {
  if (!GENERATION_TYPES.includes(type)) return null;
  const rows = (snapshot.resources ?? []).filter(
    (row) => row.kind === "plugin",
  );
  if (
    !rows.some(
      (row) =>
        row.payload?.enabled &&
        row.payload.name === HOLOCALL_BUTTON_RELEASE.name,
    )
  )
    return null;
  const database =
    (snapshot.resources ?? []).find(
      (row) => row.kind === "settings" && row.id === "global",
    )?.payload ?? {};
  const captured = new Map();
  let wygCount = 0;
  for (const row of rows) {
    const plugin = row.payload;
    if (!plugin?.enabled) continue;
    if (matchesHolocallButtonRelease(plugin))
      captured.set(row.id, plugin.script);
    else if (matchesWygloreRelease(plugin)) wygCount++;
    else if (pluginRequiresServerHost(plugin, database))
      throw new RuntimeError(
        "PLUGIN_UNSUPPORTED",
        "Generation with HoloCall requires exact reviewed plugin sources",
      );
  }
  if (wygCount > 1)
    throw new RuntimeError(
      "PLUGIN_UNSUPPORTED",
      "Only one WygLore instance can own a native job",
    );
  const reads = createPluginReadDependencies(snapshot);
  reads.observeDatabaseFields(["plugins"]);
  reads.observeCharacter();
  reads.observeChat();
  return {
    checkpoint: {
      kind: "browser-generation-v1",
      pluginId: captured.keys().next().value,
      bundleSha: HOLOCALL_BUTTON_RELEASE.sha256,
      reads: reads.snapshot(),
    },
    pluginRequiresServerHost(plugin, currentDatabase) {
      if (
        plugin.enabled &&
        captured.get(plugin.id) === plugin.script &&
        matchesHolocallButtonRelease(plugin)
      )
        return false;
      return pluginRequiresServerHost(plugin, currentDatabase);
    },
  };
}

module.exports = { reviewBrowserGenerationPlugins, GENERATION_TYPES };
