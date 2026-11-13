"use strict";

const { RuntimeError } = require("../entity/errors.cjs");
const { pluginRequiresServerHost } = require("./pluginAdmission.cjs");
const {
  matchesWygloreRelease,
  getWygloreRelease,
} = require("./wygloreContract.cjs");
const {
  createPluginReadDependencies,
} = require("./pluginReadDependencies.cjs");
const {
  matchesHolocallButtonRelease,
} = require("./holocallButtonContract.cjs");

// Future general server admission does not prove that a new author bundle has
// no extension hooks. Each button-inert artifact requires its own review.
const BUTTON_INERT_WYGLORE_BUNDLES = Object.freeze([
  "5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c",
  "ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9",
]);
function isReviewedButtonPlugin(plugin) {
  return (
    matchesWygloreRelease(plugin) &&
    BUTTON_INERT_WYGLORE_BUNDLES.includes(
      getWygloreRelease(plugin.script).sha256,
    )
  );
}

/** Wyg's reviewed request replacers and HoloCall's reviewed browser listeners
 * do not participate in native character-button processing. Execute original
 * Lua/manual triggers without booting either plugin here. Keep Wyg's private
 * cache maintenance in generation/UI and leave HoloCall's browser lifecycle
 * outside this server job. Never use this for generation or unreviewed code.
 */
function reviewButtonPlugins(snapshot) {
  const rows = (snapshot.resources ?? []).filter(
    (row) => row.kind === "plugin",
  );
  const settings = (snapshot.resources ?? []).find(
    (row) => row.kind === "settings" && row.id === "global",
  );
  const database = settings?.payload ?? {};
  const reviewed = new Map();
  const browserOnly = new Map();
  for (const row of rows) {
    const plugin = row.payload;
    if (!plugin?.enabled) continue;
    if (isReviewedButtonPlugin(plugin)) reviewed.set(row.id, plugin.script);
    else if (matchesHolocallButtonRelease(plugin))
      browserOnly.set(row.id, plugin.script);
    else if (pluginRequiresServerHost(plugin, database))
      throw new RuntimeError(
        "PLUGIN_UNSUPPORTED",
        "Character buttons require an exact reviewed server plugin",
      );
  }
  if (reviewed.size > 1)
    throw new RuntimeError(
      "PLUGIN_UNSUPPORTED",
      "Only one WygLore instance can own a native job",
    );
  if (!reviewed.size && !browserOnly.size) return null;

  // Include inactive rows and the collection enumeration: a peer may enable,
  // update, remove or install a plugin while this button is executing. Ordinary
  // incarnation-only resource reads do not guard a same-incarnation update.
  const reads = createPluginReadDependencies(snapshot);
  reads.observeDatabaseFields(["plugins"]);
  reads.observeCharacter();
  reads.observeChat();
  return {
    pluginId: [...reviewed.keys(), ...browserOnly.keys()][0],
    reads: reads.snapshot(),
    pluginRequiresServerHost(plugin, currentDatabase) {
      if (
        plugin.enabled &&
        ((reviewed.get(plugin.id) === plugin.script &&
          isReviewedButtonPlugin(plugin)) ||
          (browserOnly.get(plugin.id) === plugin.script &&
            matchesHolocallButtonRelease(plugin)))
      )
        return false;
      return pluginRequiresServerHost(plugin, currentDatabase);
    },
  };
}

module.exports = { reviewButtonPlugins, BUTTON_INERT_WYGLORE_BUNDLES };
