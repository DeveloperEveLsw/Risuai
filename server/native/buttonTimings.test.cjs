"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buttonTiming, PHASES } = require("./buttonTimings.cjs");
const { createProgressCheckpoint } = require("./progress.cjs");

test("button timing retains only reviewed phases and finite bounded durations", () => {
  for (const phase of PHASES)
    assert.deepEqual(
      buttonTiming({ phase, durationMs: 12.345, buttonData: "private" }),
      { phase, durationMs: 12.3 },
    );
  assert.deepEqual(buttonTiming({ phase: "lua", durationMs: 9e15 }), {
    phase: "lua",
    durationMs: 3600000,
  });
  for (const value of [NaN, Infinity, -1, "12", {}, null])
    assert.equal(buttonTiming({ phase: "lua", durationMs: value }), null);
  assert.equal(
    buttonTiming({ phase: "private button body", durationMs: 1 }),
    null,
  );
});

test("button phase metadata coalesces with the existing fenced progress checkpoint", async () => {
  const writes = [];
  const progress = createProgressCheckpoint(
    { call: async (...args) => writes.push(args) },
    { id: "button", owner: "owner", fence: 3, type: "button" },
    { intervalMs: 60000 },
  );
  try {
    progress.receive({
      type: "button-timing",
      phase: "context",
      durationMs: 1.1,
    });
    progress.receive({
      type: "button-timing",
      phase: "lua",
      durationMs: 42.4,
      data: "private",
    });
    progress.receive({
      type: "button-timing",
      phase: "private payload",
      durationMs: 1,
    });
    progress.receive({ type: "state-updated" });
    await progress.flush();
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].slice(0, 4), [
      "writeJobProgress",
      "button",
      "owner",
      3,
    ]);
    assert.deepEqual(writes[0][4], {
      buttonTimings: { context: 1.1, lua: 42.4 },
      engineStateChanged: true,
    });
  } finally {
    progress.stop();
  }
});

test("generation jobs cannot acquire button performance metadata", async () => {
  let calls = 0;
  const progress = createProgressCheckpoint(
    { call: async () => calls++ },
    { id: "generation", owner: "owner", fence: 1, type: "send" },
  );
  try {
    progress.receive({ type: "button-timing", phase: "lua", durationMs: 2 });
    await progress.flush();
    assert.equal(calls, 0);
  } finally {
    progress.stop();
  }
});
