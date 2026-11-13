"use strict";
const { createHash } = require("node:crypto");

// Audited module-manager v2.2.3 bundle. Its input/display handlers are registered
// only when persona_modules is nonempty. This admits its inert configuration;
// it does not execute JavaScript, change enabled, or provide a general host.
const MODULE_MANAGER_SHA256 =
  "5aab73060f2448bab14a731caf79c8001d5a8acde51bcbfc80b2d7e593533c5b";
function pluginRequiresServerHost(plugin, database, digest = hash) {
  if (!plugin.enabled) return false;
  if (
    plugin.name !== "module-manager" ||
    plugin.version !== "3.0" ||
    typeof plugin.script !== "string" ||
    digest(plugin.script) !== MODULE_MANAGER_SHA256
  )
    return true;
  const args = plugin.realArg;
  if (
    !args ||
    args.global_presets !== "" ||
    args.persona_modules !== "" ||
    Object.keys(args).some(
      (key) => !["debug", "global_presets", "persona_modules"].includes(key),
    )
  )
    return true;
  const injected = database.pluginCustomStorage?.personaInjectedToChar;
  // Refuse stale/nonempty injection bookkeeping too, rather than omitting cleanup.
  return (
    injected != null &&
    (typeof injected !== "object" ||
      Array.isArray(injected) ||
      Object.keys(injected).length > 0)
  );
}
function hash(script) {
  return createHash("sha256").update(script).digest("hex");
}
module.exports = { pluginRequiresServerHost, MODULE_MANAGER_SHA256 };
