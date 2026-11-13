"use strict";

const { RuntimeError } = require("./errors.cjs");
const {
  validatePluginReadDependencies,
} = require("./pluginReadDependencies.cjs");

/** Metadata-only source validation inside the caller's transaction. An inert
 * button never owns a plugin-storage lease or commits a plugin checkpoint, but
 * its reviewed source/configuration must still match at completion/recovery.
 */
function validateButtonPluginAdmission(store, job, admission) {
  if (
    job.type !== "button" ||
    !admission ||
    typeof admission !== "object" ||
    Array.isArray(admission) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(admission)) ||
    !Object.hasOwn(admission, "pluginId") ||
    !Object.hasOwn(admission, "reads") ||
    Reflect.ownKeys(admission).some(
      (key) => !["pluginId", "reads"].includes(key),
    ) ||
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
      "Request-only plugin admission requires a complete button source guard",
    );
  return validatePluginReadDependencies(store, admission.reads, {
    chatId: job.chatId,
    pluginId: admission.pluginId,
  });
}

module.exports = { validateButtonPluginAdmission };
