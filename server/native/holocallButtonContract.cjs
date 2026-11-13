"use strict";

const { createHash } = require("node:crypto");

// This original bridge installs browser DOM/composer listeners, not native
// edit/request hooks. Its own send actions can write chats and call models;
// ordinary server character-button and generation jobs may omit that browser
// lifecycle under their separate captured-source guards. This is not a general
// plugin host or a promise of server-side manual HoloCall sends.
const HOLOCALL_BUTTON_RELEASE = Object.freeze({
  name: "creditail_holocall_bridge",
  apiVersion: "3.0",
  version: "1.3.0",
  sha256: "d7ce51b5edbf46940b2c3526bba0ed933ca8f548733c3035a12466c0f474bcf3",
  bytes: 137666,
});

function matchesHolocallButtonRelease(plugin) {
  return (
    plugin?.name === HOLOCALL_BUTTON_RELEASE.name &&
    plugin?.version === HOLOCALL_BUTTON_RELEASE.apiVersion &&
    typeof plugin.script === "string" &&
    createHash("sha256").update(plugin.script).digest("hex") ===
      HOLOCALL_BUTTON_RELEASE.sha256
  );
}

module.exports = { HOLOCALL_BUTTON_RELEASE, matchesHolocallButtonRelease };
