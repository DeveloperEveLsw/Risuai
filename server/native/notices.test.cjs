"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createNoticePublisher } = require("./notices.cjs");
const job = { id: "job", owner: "owner", fence: 3 };
test("script error alerts retain normalized text in the same durable order as normal alerts", async () => {
  const calls = [];
  const publisher = createNoticePublisher(
    { call: async (...args) => calls.push(args) },
    job,
  );
  publisher.receive("first");
  publisher.receiveError("  아직 안 고른 것: 부서  ");
  publisher.receiveError(new Error("  synthetic validation  "));
  publisher.receiveError({});
  publisher.receiveError(" {} ");
  publisher.receive("last");
  await publisher.flush();
  assert.deepEqual(
    calls.map((args) => args.slice(4)),
    [
      [1, "first"],
      [2, "아직 안 고른 것: 부서"],
      [3, "synthetic validation"],
      [4, "last"],
    ],
  );
});
test("synchronous native alerts persist individually in order and flush waits for the last receipt", async () => {
  const calls = [];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const publisher = createNoticePublisher(
    {
      call: async (...args) => {
        calls.push(args);
        if (calls.length === 1) await held;
      },
    },
    job,
  );
  assert.equal(publisher.receive("first"), undefined);
  publisher.receive("second");
  let flushed = false;
  const flushing = publisher.flush().then(() => {
    flushed = true;
  });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(flushed, false);
  release();
  await flushing;
  assert.deepEqual(
    calls.map((args) => args.slice(4)),
    [
      [1, "first"],
      [2, "second"],
    ],
  );
  publisher.stop();
  assert.throws(() => publisher.receive("after-close"), {
    code: "NOTICE_CLOSED",
  });
});
test("asynchronous database failure is retained, aborts once and suppresses queued subsequent notifications", async () => {
  const failure = new Error("synthetic database failure");
  let calls = 0,
    failures = 0;
  const publisher = createNoticePublisher(
    {
      call: async () => {
        calls++;
        throw failure;
      },
    },
    job,
    () => {
      failures++;
    },
  );
  publisher.receive("first");
  publisher.receive("second");
  await assert.rejects(publisher.flush(), failure);
  assert.equal(calls, 1);
  assert.equal(failures, 1);
  assert.throws(() => publisher.receive("third"), failure);
});
test("bounded queue rejects notification floods synchronously without enqueueing excess text", async () => {
  let calls = 0;
  const publisher = createNoticePublisher(
    {
      call: async () => {
        calls++;
      },
    },
    job,
  );
  for (let i = 0; i < 128; i++) publisher.receive("");
  assert.throws(() => publisher.receive("excess"), { code: "NOTICE_LIMIT" });
  await publisher.flush();
  assert.equal(calls, 128);
});
