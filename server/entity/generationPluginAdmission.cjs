"use strict";

const { RuntimeError } = require("./errors.cjs");
const {
  validatePluginReadDependencies,
} = require("./pluginReadDependencies.cjs");
const {
  HOLOCALL_BUTTON_RELEASE,
} = require("../native/holocallButtonContract.cjs");

/** A browser-only bridge has no server storage checkpoint. Its exact source
 * admission still requires a complete revision/incarnation closure inside both
 * the final chat transaction and explicit result recovery. Keep this separate
 * from the request-only button protocol and from general plugin admission.
 */
function validateGenerationPluginAdmission(store, job, admission) {
  if (
    !["send", "continue", "reroll", "memory-summary"].includes(job.type) ||
    !admission ||
    typeof admission !== "object" ||
    Array.isArray(admission) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(admission)) ||
    !["kind", "pluginId", "bundleSha", "reads"].every((key) =>
      Object.hasOwn(admission, key),
    ) ||
    Reflect.ownKeys(admission).some(
      (key) => !["kind", "pluginId", "bundleSha", "reads"].includes(key),
    ) ||
    admission.kind !== "browser-generation-v1" ||
    admission.bundleSha !== HOLOCALL_BUTTON_RELEASE.sha256 ||
    typeof admission.pluginId !== "string" ||
    !admission.pluginId ||
    admission.pluginId.length > 256 ||
    !Array.isArray(admission.reads?.collectionSets) ||
    !admission.reads.collectionSets.some(
      (collection) => collection?.kind === "plugin",
    )
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Browser-only generation admission requires a complete reviewed source guard",
    );
  return validatePluginReadDependencies(store, admission.reads, {
    chatId: job.chatId,
    pluginId: admission.pluginId,
  });
}

module.exports = { validateGenerationPluginAdmission };
