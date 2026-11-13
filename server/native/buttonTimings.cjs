"use strict";

// Only fixed phase names and bounded durations enter durable job metadata.
// Script bodies, button data, URLs, variables and provider details are excluded.
const PHASES = Object.freeze([
  "queue",
  "startup",
  "store-ready",
  "engine-load",
  "snapshot",
  "plugin-prepare",
  "context",
  "extension",
  "plugin-open",
  "lua",
  "plugin-complete",
  "write-set",
  "engine-close",
  "precommit",
]);
function buttonTiming(event) {
  if (
    !PHASES.includes(event?.phase) ||
    typeof event.durationMs !== "number" ||
    !Number.isFinite(event.durationMs) ||
    event.durationMs < 0
  )
    return null;
  return {
    phase: event.phase,
    durationMs: Math.min(3600000, Math.round(event.durationMs * 10) / 10),
  };
}
module.exports = { PHASES, buttonTiming };
