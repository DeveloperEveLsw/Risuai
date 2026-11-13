"use strict";
const { validate, MAX_JOB_NOTICE_BYTES } = require("../entity/notices.cjs");
const { RuntimeError } = require("../entity/errors.cjs");

/** Script alerts are synchronous. Persist each call in order and observe failures before final save. */
function createNoticePublisher(store, job, onFailure = () => {}) {
  let position = 0,
    bytes = 0,
    failure,
    stopped = false;
  let tail = Promise.resolve();
  function check() {
    if (failure) throw failure;
  }
  function receive(message) {
    check();
    if (stopped)
      throw new RuntimeError(
        "NOTICE_CLOSED",
        "Notification publisher is closed",
      );
    const size = validate(position + 1, message);
    if (bytes + size > MAX_JOB_NOTICE_BYTES)
      throw new RuntimeError("NOTICE_LIMIT", "Job notifications exceed 1 MiB");
    const current = ++position;
    bytes += size;
    tail = tail
      .then(() => {
        check();
        return store.call(
          "publishJobNotice",
          job.id,
          job.owner,
          job.fence,
          current,
          message,
        );
      })
      .catch((error) => {
        if (!failure) {
          failure = error;
          onFailure(error);
        }
      });
  }
  async function flush() {
    await tail;
    check();
  }
  function receiveError(message) {
    check();
    // Match upstream alertError text handling without logging private script text.
    if (typeof message !== "string") {
      try {
        message =
          message instanceof Error ? message.message : JSON.stringify(message);
      } catch {
        message = String(message);
      }
    }
    const text = String(message).trim();
    if (text !== "{}") receive(text);
  }
  return {
    receive,
    receiveError,
    flush,
    check,
    stop: () => {
      stopped = true;
    },
  };
}
module.exports = { createNoticePublisher };
