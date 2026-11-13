"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const vm = require("node:vm");
const {
  WYGLORE_RELEASE,
  LIFECYCLE_SEAM,
  defaultWygloreFixturePath,
  verifyWygloreScript,
  matchesWygloreRelease,
  instrumentWygloreLifecycle,
} = require("./wygloreContract.cjs");
const { makeWygloreContractFixture } = require("./wygloreContractFixtures.cjs");

// The fetch CLI populates this ignored cache using the author's pinned artifact.
// Test execution never downloads anything and never contacts a model provider.
const fixturePath =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const fixtureAvailable = fs.existsSync(fixturePath);
const actual = {
  skip: fixtureAvailable
    ? false
    : "Fetch public fixture with: node server/native/wygloreContract.cjs fetch",
};
const source = fixtureAvailable ? fs.readFileSync(fixturePath, "utf8") : null;

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function persistenceLifecycle(run, background = async () => null) {
  const sandbox = {
    __WL_DEBUG: true,
    _coldStartRunning: new Set(),
    _indexFallbackInFlight: false,
    getLLMClient: () => ({ _sem: { active: 0, queue: [] } }),
    _persistTimer: null,
    _hiddenFlushDepth: 0,
    _activeSwap: null,
    flushEngine: async () => true,
    _panelSyncTail: Promise.resolve(),
    flushPendingPersistOnHide: () => {},
    getEngine: () => ({ params: {}, units: new Set() }),
    structuredClone,
    _runPendingPersist: run,
    _manifestFromCacheOrFetch: background,
  };
  vm.runInNewContext(LIFECYCLE_SEAM, sandbox);
  return { sandbox, lifecycle: sandbox.__WL_SERVER_LIFECYCLE };
}

test("background manifest reads and subsequent cache writes stay active until the full original task ends", async () => {
  const fetchFinished = deferred(),
    cacheFinished = deferred();
  let writes = 0;
  const { sandbox, lifecycle } = persistenceLifecycle(
    async () => true,
    async () => {
      await fetchFinished.promise;
      writes++;
      await cacheFinished.promise;
      return { version: "Synthetic public manifest" };
    },
  );
  const returned = sandbox._manifestFromCacheOrFetch({});
  assert.equal(lifecycle.status().backgroundActive, 1);
  let settled = false;
  const drain = lifecycle.settlePersistence().then(() => {
    settled = true;
  });
  fetchFinished.resolve();
  await fetchFinished.promise;
  assert.equal(writes, 1);
  assert.equal(lifecycle.status().backgroundActive, 1);
  assert.equal(settled, false);
  cacheFinished.resolve();
  assert.equal((await returned).version, "Synthetic public manifest");
  await drain;
  assert.equal(lifecycle.status().backgroundActive, 0);
});

test("background offline-null fallback and original Promise identity retain their semantics", async () => {
  const work = deferred();
  const { sandbox, lifecycle } = persistenceLifecycle(
    async () => true,
    () => work.promise,
  );
  const returned = sandbox._manifestFromCacheOrFetch({ force: true });
  assert.equal(returned, work.promise);
  const drain = lifecycle.settlePersistence();
  work.resolve(null);
  assert.equal(await returned, null);
  await drain;
  lifecycle.assertPersistenceHealthy();
  assert.equal(lifecycle.status().backgroundActive, 0);
});

test("one shared drain waits nested background work and the original persistence tail", async () => {
  const cacheFinished = deferred(),
    persistFinished = deferred();
  let calls = 0;
  let f;
  f = persistenceLifecycle(
    async () => {
      calls++;
      await f.sandbox._manifestFromCacheOrFetch({});
      await persistFinished.promise;
      return true;
    },
    () => cacheFinished.promise,
  );
  f.sandbox._runPendingPersist();
  assert.equal(f.lifecycle.status().backgroundActive, 1);
  assert.equal(f.lifecycle.status().persistActive, true);
  let settled = false;
  const drain = f.lifecycle.settlePersistence().then(() => {
    settled = true;
  });
  cacheFinished.resolve(null);
  await cacheFinished.promise;
  await Promise.resolve();
  assert.equal(f.lifecycle.status().backgroundActive, 0);
  assert.equal(f.lifecycle.status().persistActive, true);
  assert.equal(settled, false);
  persistFinished.resolve(true);
  await drain;
  assert.equal(calls, 1);
  assert.equal(f.lifecycle.status().persistActive, false);
});

test("hidden-page persistence retains its existing busy guard after regular work ends", async () => {
  const work = deferred();
  const { sandbox, lifecycle } = persistenceLifecycle(() => work.promise);
  sandbox._hiddenFlushDepth = 1;
  sandbox._runPendingPersist();
  work.resolve(true);
  await lifecycle.settlePersistence();
  assert.equal(lifecycle.status().persistActive, true);
  sandbox._hiddenFlushDepth = 0;
  assert.equal(lifecycle.status().persistActive, false);
});

test("regular timer persistence stays active through its unchanged original Promise", async () => {
  const work = deferred();
  const { sandbox, lifecycle } = persistenceLifecycle(() => work.promise);
  assert.equal(lifecycle.status().persistActive, false);
  const returned = sandbox._runPendingPersist();
  assert.equal(returned, work.promise);
  // The original timer clears _persistTimer before calling the asynchronous
  // runner. Hidden-page depth is also zero for an ordinary timer callback.
  assert.equal(lifecycle.status().persistPending, false);
  assert.equal(lifecycle.status().persistActive, true);
  let settled = false;
  const drain = lifecycle.settlePersistence().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  work.resolve(true);
  assert.equal(await returned, true);
  await drain;
  assert.equal(lifecycle.status().persistActive, false);
});

test("persistence drain waits concurrent and newly started work without repeating either original operation", async () => {
  const first = deferred(),
    second = deferred(),
    third = deferred();
  const works = [first, second, third];
  let calls = 0;
  const { sandbox, lifecycle } = persistenceLifecycle(
    () => works[calls++].promise,
  );
  sandbox._runPendingPersist();
  sandbox._runPendingPersist();
  first.promise.then(() => sandbox._runPendingPersist());
  let settled = false;
  const drain = lifecycle.settlePersistence().then(() => {
    settled = true;
  });
  first.resolve(true);
  second.resolve(true);
  await first.promise;
  await second.promise;
  await Promise.resolve();
  assert.equal(calls, 3);
  assert.equal(settled, false);
  assert.equal(lifecycle.status().persistActive, true);
  third.resolve(true);
  await drain;
  assert.equal(calls, 3);
  assert.equal(lifecycle.status().persistActive, false);
});

test("an original swap-blocked false persistence result keeps its original meaning", async () => {
  const work = deferred();
  const { sandbox, lifecycle } = persistenceLifecycle(() => work.promise);
  const returned = sandbox._runPendingPersist();
  const drain = lifecycle.settlePersistence();
  work.resolve(false);
  assert.equal(await returned, false);
  await drain;
  assert.equal(lifecycle.status().persistActive, false);
  lifecycle.assertPersistenceHealthy();
});

test("a caught original persistence rejection remains a body-free sticky failure", async () => {
  const work = deferred();
  let calls = 0;
  const { sandbox, lifecycle } = persistenceLifecycle(() => {
    calls++;
    return work.promise;
  });
  const original = sandbox._runPendingPersist();
  const originalCaught = original.catch((error) => error.message);
  const draining = lifecycle.settlePersistence();
  const rejection = assert.rejects(
    draining,
    (error) =>
      error.code === "PLUGIN_PERSIST_FAILED" &&
      error.message === "Original plugin persistence failed",
  );
  work.reject(
    new Error(
      "Synthetic original private details must not escape the lifecycle",
    ),
  );
  assert.match(await originalCaught, /Synthetic original private details/);
  await rejection;
  assert.throws(() => lifecycle.assertPersistenceHealthy(), {
    code: "PLUGIN_PERSIST_FAILED",
  });
  assert.throws(() => lifecycle.status(), { code: "PLUGIN_PERSIST_FAILED" });
  assert.throws(() => sandbox._runPendingPersist(), {
    code: "PLUGIN_PERSIST_FAILED",
  });
  assert.equal(calls, 1);
});

test("persistence drain cancellation exits without changing accepted original work or poisoning it", async () => {
  const work = deferred();
  const { sandbox, lifecycle } = persistenceLifecycle(() => work.promise);
  const original = sandbox._runPendingPersist();
  const controller = new AbortController();
  const draining = lifecycle.settlePersistence(controller.signal);
  const cancellation = assert.rejects(draining, /Synthetic drain cancellation/);
  controller.abort(new Error("Synthetic drain cancellation"));
  await cancellation;
  assert.equal(lifecycle.status().persistActive, true);
  work.resolve(true);
  assert.equal(await original, true);
  await lifecycle.settlePersistence();
  lifecycle.assertPersistenceHealthy();
});

test("WygLore identity rejects missing, modified, and unknown scripts", () => {
  assert.throws(() => verifyWygloreScript(undefined), /script is required/);
  assert.throws(() => verifyWygloreScript("unreviewed code"), /hash differs/);
  assert.equal(
    matchesWygloreRelease({
      name: WYGLORE_RELEASE.name,
      version: "3.0",
      script: "unreviewed code",
    }),
    false,
  );
});

test(
  "verified lifecycle adapter preserves every byte of the author body",
  actual,
  () => {
    assert.equal(
      Buffer.byteLength(verifyWygloreScript(source)),
      WYGLORE_RELEASE.bytes,
    );
    assert.equal(
      matchesWygloreRelease({
        name: WYGLORE_RELEASE.name,
        version: "3.0",
        script: source,
      }),
      true,
    );
    assert.equal(
      matchesWygloreRelease({
        name: WYGLORE_RELEASE.name,
        version: "2.0",
        script: source,
      }),
      false,
    );
    const adapted = instrumentWygloreLifecycle(source);
    assert.equal(adapted.split(LIFECYCLE_SEAM).length, 2);
    assert.equal(adapted.replace(LIFECYCLE_SEAM, ""), source);
    assert.notEqual(
      createHash("sha256").update(adapted).digest("hex"),
      WYGLORE_RELEASE.sha256,
    );
    assert.throws(
      () => instrumentWygloreLifecycle(source + "\n"),
      /hash differs/,
    );
  },
);

test(
  "author bundle boots, injects canonical memory, filters request mode, and strips elapsed output",
  actual,
  async () => {
    const fixture = makeWygloreContractFixture();
    try {
      const lifecycle = await fixture.boot(source);
      assert.equal(lifecycle.status().ready, true);
      assert.equal(fixture.hooks.beforeRequest.length, 1);
      assert.equal(fixture.hooks.afterRequest.length, 1);
      assert.equal(fixture.registrations.length, 2);
      const translate = [{ role: "user", content: "Translate this." }];
      const unchanged = await fixture.hooks.beforeRequest[0](
        translate,
        "translate",
      );
      assert.equal(unchanged, translate);
      const messages = await fixture.hooks.beforeRequest[0](
        [
          { role: "system", content: "You are a helpful gardener." },
          { role: "user", content: "Tell me about the garden." },
        ],
        "model",
      );
      assert.match(
        messages.map((message) => message.content).join("\n"),
        /WygLore Leaf — canonical layer/,
      );
      assert.match(
        messages.map((message) => message.content).join("\n"),
        /A gardener named Green/,
      );
      assert.equal(lifecycle.unitsCount(), 2);
      const output = await fixture.hooks.afterRequest[0](
        'A sunny garden. <at-elapsed duration="1d"/>',
        "model",
      );
      assert.doesNotMatch(output, /at-elapsed/);
      await fixture.settle();
      assert.equal(
        fixture.calls.some((call) => call.method === "provider"),
        false,
      );
      assert.ok(
        fixture.chat.localLore.some(
          (entry) => entry.key === "__wl_marker__" && entry.enabled === false,
        ),
      );
    } finally {
      await fixture.close();
    }
  },
);

test(
  "author background SSE extraction survives checkpoint, restart, and memory reinjection",
  actual,
  async () => {
    let releaseProvider;
    const providerBarrier = new Promise((resolve) => {
      releaseProvider = resolve;
    });
    const fixture = makeWygloreContractFixture({
      longChat: true,
      providerBarrier,
    });
    let restart;
    try {
      const lifecycle = await fixture.boot(source);
      const messages = await fixture.hooks.beforeRequest[0](
        [
          { role: "system", content: "You are a helpful gardener." },
          { role: "user", content: "Green, how are the blue flowers?" },
        ],
        "model",
      );
      assert.match(
        messages.map((message) => message.content).join("\n"),
        /canonical layer/,
      );
      // Main request has returned while the author memory pipeline is still live.
      assert.ok(lifecycle.status().coldStart > 0);
      assert.equal(lifecycle.unitsCount(), 2);
      releaseProvider();
      await fixture.settle();
      assert.equal(lifecycle.unitsCount(), 3);
      assert.ok(fixture.calls.some((call) => call.method === "provider"));
      const cursorKey = [...fixture.storage.keys()].find((key) =>
        key.startsWith("at.coldstart.wl.web.v1."),
      );
      assert.ok(
        cursorKey,
        "current author bundle still uses at.coldstart legacy prefix",
      );
      const snapshot = JSON.stringify(Object.fromEntries(fixture.storage));
      assert.match(snapshot, /Green waters the blue garden flowers/);
      const marker = fixture.chat.localLore.find(
        (entry) => entry.key === "__wl_marker__",
      );
      assert.equal(JSON.parse(marker.content).unitCount, 3);
      await fixture.close();
      restart = makeWygloreContractFixture({
        storage: fixture.storage,
        chat: structuredClone(fixture.chat),
        settings: { coldStartAuto: false },
      });
      const restored = await restart.boot(source);
      assert.equal(restored.unitsCount(), 3);
      const restoredMessages = await restart.hooks.beforeRequest[0](
        [
          { role: "system", content: "You are a helpful gardener." },
          { role: "user", content: "Remember Green and the blue garden." },
        ],
        "model",
      );
      assert.match(
        restoredMessages.map((message) => message.content).join("\n"),
        /Green waters the blue garden flowers/,
      );
      await restart.settle();
    } finally {
      releaseProvider();
      if (restart) await restart.close();
      else await fixture.close();
    }
  },
);
