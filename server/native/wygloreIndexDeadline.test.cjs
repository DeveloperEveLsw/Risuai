"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createHash, generateKeyPairSync } = require("node:crypto");
const { createServer } = require("node:http");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createServerPluginHost } = require("./serverPluginHost.cjs");
const { createPluginStorageSession } = require("./pluginStorageSession.cjs");
const { makeWygloreContractFixture } = require("./wygloreContractFixtures.cjs");
const {
  defaultWygloreFixturePath,
  getWygloreRelease,
  instrumentWygloreLifecycle,
} = require("./wygloreContract.cjs");
const {
  instrumentWygloreTransportCancellation,
} = require("./wygloreTransportCancellation.cjs");
const {
  instrumentWygloreVertexEndpoint,
} = require("./wygloreVertexEndpoint.cjs");
const {
  PORT,
  PROFILES,
  instrumentWygloreIndexDeadline,
  createWygloreIndexDeadlineRegistry,
} = require("./wygloreIndexDeadline.cjs");

const digest = (value) => createHash("sha256").update(value).digest("hex");
const target = new URL(
  "https://aiplatform.eu.rep.googleapis.com/v1/projects/synthetic-public/locations/eu/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
);

function proofFixture(options = {}) {
  const host = new AbortController(),
    caller = new AbortController(),
    pipeline = new AbortController(),
    timer = new AbortController();
  const request = AbortSignal.any([
    caller.signal,
    pipeline.signal,
    timer.signal,
  ]);
  const registry = createWygloreIndexDeadlineRegistry({
    enabled: options.enabled !== false,
    signal: host.signal,
  });
  const port = registry.executionPort;
  const registered = port.register(
    options.badToken ? {} : port.token,
    request,
    timer.signal,
    caller.signal,
    pipeline.signal,
    150,
    options.provider || "vertex",
    options.model || "gemini-3.8-flash",
  );
  const child = AbortSignal.any([request, new AbortController().signal]);
  port.inherit(request, child);
  return {
    registry,
    host,
    caller,
    pipeline,
    timer,
    request,
    child,
    registered,
    expire: () => timer.abort("llm-timeout-150ms"),
  };
}

test(
  "a proven deadline never bypasses context health, plugin source or plugin-storage writer guards",
  {
    timeout: 15000,
    skip: fs.existsSync(defaultWygloreFixturePath("3.2.0"))
      ? false
      : "Preserve the pinned original plugin fixture",
  },
  async (t) => {
    for (const stale of ["context", "source", "lease"])
      await t.test(stale, async (t) => {
        const f = await realHost(t, "3.2.0"),
          { engine } = prepareIndex(f);
        await f.realm.risuai.pluginStorage.setItem("synthetic-valid-memory", {
          retained: true,
        });
        f.onAbort(() => {
          if (stale === "context") f.invalidateContext();
          else if (stale === "lease") {
            f.store.releasePluginStorage(f.lease);
            f.store.claimPluginStorage({
              namespace: f.namespace,
              writerId: "replacement",
              authority: { kind: "browser" },
            });
          } else {
            const plugin = f.store.getResource("plugin", f.namespace.pluginId);
            f.store.applyCommand("changed-source", {
              type: "put-resource",
              kind: "plugin",
              resourceId: plugin.id,
              expectedRevision: plugin.revision,
              payload: {
                ...plugin.payload,
                script: plugin.payload.script + "\n",
              },
            });
          }
        });
        await f.api.build(engine, f.api.client()).catch(() => {});
        await until(() => f.counts.closed === 1);
        assert.equal(f.counts.model, 1);
        if (stale === "context") assert.throws(() => f.host.ensureHealthy());
        else {
          f.host.ensureHealthy();
          await f.host.close({ success: true });
          assert.throws(
            () =>
              f.store.commitPluginStorage(
                f.storage.checkpoint("stale-at-deadline"),
              ),
            (error) => /SOURCE|STALE|LEASE|CHANGED/.test(error.code),
          );
        }
      });
  },
);

test("an actual registered index own timer and inherited signal allow only a known Vertex Gemini operation", () => {
  const f = proofFixture();
  assert.equal(f.registered, true);
  assert.equal(
    f.registry.failure(new Error("not aborted"), f.child, target),
    null,
  );
  f.expire();
  const allowed = f.registry.failure(f.child.reason, f.child, target);
  assert.ok(allowed instanceof Error);
  assert.equal(f.registry.isHandled(allowed), true);
  assert.equal(
    f.registry.isHandled(
      Object.assign(new Error(allowed.message), { code: allowed.code }),
    ),
    false,
  );
  assert.ok(
    f.registry.beforeRequest(f.child, target),
    "No physical replay is allowed after this operation expires",
  );
  assert.equal(
    f.registry.failure(
      Object.assign(new TypeError("unrelated connection loss"), {
        code: "ECONNRESET",
      }),
      f.child,
      target,
    ),
    null,
    "A coincident ordinary failure is never accepted by deadline text",
  );
});

test("forged messages, unregistered signals, disabled UI registry and other providers cannot bypass uncertainty", () => {
  for (const options of [
    { badToken: true },
    { enabled: false },
    { provider: "custom-google" },
    { model: "claude-synthetic" },
  ]) {
    const f = proofFixture(options);
    f.expire();
    assert.equal(f.registered, false);
    assert.equal(f.registry.failure(f.child.reason, f.child, target), null);
  }
  const f = proofFixture();
  f.expire();
  const unregistered = AbortSignal.abort("llm-timeout-150ms");
  assert.equal(
    f.registry.failure(unregistered.reason, unregistered, target),
    null,
  );
  assert.equal(
    f.registry.failure(
      "llm-timeout-150ms",
      AbortSignal.abort("llm-slow-abort-150ms"),
      target,
    ),
    null,
  );
});

test("caller, pipeline, host cancellation and registry closure remain authoritative", () => {
  for (const kind of ["caller", "pipeline", "host"]) {
    const f = proofFixture();
    f[kind].abort("external cancellation");
    f.expire();
    assert.equal(f.registry.failure(f.child.reason, f.child, target), null);
  }
  const f = proofFixture();
  f.expire();
  f.registry.close();
  assert.equal(f.registry.failure(f.child.reason, f.child, target), null);
});

test("auth, embedding, custom proxies, model mismatch and malformed generation URLs never receive the exception", () => {
  const f = proofFixture();
  f.expire();
  for (const address of [
    "https://oauth2.googleapis.com/token",
    "https://api.voyageai.com/v1/embeddings",
    String(target).replace("aiplatform.eu.rep.googleapis.com", "proxy.invalid"),
    String(target).replace("gemini-3.8-flash", "gemini-2.5-flash"),
    String(target).replace(":streamGenerateContent?alt=sse", ":predict"),
    String(target).replace("https:", "http:"),
    String(target) + "&unexpected=1",
    String(target).replace("/locations/eu/", "/locations/global/"),
  ])
    assert.equal(
      f.registry.failure(f.child.reason, f.child, new URL(address)),
      null,
    );
});

async function until(read) {
  const end = Date.now() + 3000;
  while (!read()) {
    if (Date.now() >= end) throw Error("Synthetic HTTP did not settle");
    await delay(5);
  }
}

async function realHost(t, version, mode = "headers", isolation = true) {
  const path = defaultWygloreFixturePath(version),
    source = fs.readFileSync(path, "utf8");
  const counts = { oauth: 0, model: 0, closed: 0, aborted: 0 };
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
    } // Synthetic public test body only.
    counts.model++;
    response.once("close", () => counts.closed++);
    if (mode === "body" || mode === "cancel-error") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("\n");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${server.address().port}/model`;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const fixture = makeWygloreContractFixture({
    settings: { stagedSearchEnabled: false },
  });
  fixture.storage.set(
    "wl.llm.config",
    JSON.stringify({
      completeProviderId: "vertex",
      completeModel: "gemini-3.8-flash",
      maxConcurrent: 2,
    }),
  );
  fixture.storage.set("wl.provider.vertex.region", "eu");
  fixture.storage.set(
    "wl.provider.vertex.serviceAccountJson",
    JSON.stringify({
      type: "service_account",
      client_email: "public@synthetic-public.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      project_id: "synthetic-public",
    }),
  );
  const preservedCache = {
    existing: { symbols: [{ token: "blue", kind: "appearance", weight: 1 }] },
  };
  fixture.storage.set("wl.canon-cache.v2", JSON.stringify(preservedCache));
  const store = new EntityStore(":memory:");
  store.initializeState({ settings: {}, resources: [] });
  store.applyCommand("plugin", {
    type: "put-resource",
    kind: "plugin",
    resourceId: "synthetic-index",
    expectedRevision: 0,
    payload: {
      id: "synthetic-index",
      name: "◆ WygLore Leaf",
      version: "3.0",
      enabled: true,
      script: source,
    },
  });
  const namespace = {
    pluginId: "synthetic-index",
    bundleSha: getWygloreRelease(source).sha256,
    pluginEpoch: 0,
  };
  let lease = store.claimPluginStorage({
    namespace,
    writerId: "synthetic-settings",
    authority: { kind: "browser" },
  });
  store.commitPluginStorage({
    lease,
    expectedRevision: 0,
    commitId: "settings",
    writes: [...fixture.storage].map(([key, value]) => ({ key, value })),
  });
  store.releasePluginStorage(lease);
  lease = store.claimPluginStorage({
    namespace,
    writerId: "synthetic-generation",
    authority: { kind: "browser" },
  });
  const storage = createPluginStorageSession(
    store.readAllPluginStorage(namespace),
    lease,
  );
  const lifetime = new AbortController();
  let failure, sandbox, host, onModelAbort;
  const context = {
    getCurrentCharacter: () => fixture.character,
    getCurrentChat: () => fixture.chat,
    setCurrentChat: (next) => Object.assign(fixture.chat, next),
    getDatabase: () => fixture.database,
    readResourceValue: (value) => value,
    ensureHealthy() {
      if (failure) throw failure;
    },
    fail(message) {
      failure ??= new Error(message);
      throw failure;
    },
  };
  const originalScript = vm.Script,
    originalCreate = vm.createContext;
  vm.Script = class extends originalScript {
    constructor(executable, options) {
      if (options?.filename?.startsWith("WygLoreLeaf-")) {
        const end = executable.lastIndexOf("})();");
        executable =
          executable.slice(0, end) +
          '\nglobalThis.__SYNTHETIC_INDEX_UNIT=MemoryUnit;globalThis.__SYNTHETIC_INDEX={build:(...a)=>(typeof buildCanonSymbolIndex2==="function"?buildCanonSymbolIndex2:buildCanonSymbolIndex)(...a),engine:getEngine,client:getLLMClient,flush:flushEngine};\n' +
          executable.slice(end);
      }
      super(executable, options);
    }
  };
  vm.createContext = (value, ...args) => {
    if (value.risuai && value.navigator?.userAgent === "Risu server native")
      sandbox = value;
    return originalCreate(value, ...args);
  };
  try {
    host = await createServerPluginHost({
      plugin: {
        id: namespace.pluginId,
        enabled: true,
        name: "◆ WygLore Leaf",
        version: "3.0",
        script: source,
      },
      context,
      storage,
      signal: lifetime.signal,
      isolateProviderFailure: isolation,
      fetch: async (url, init) => {
        assert.equal(init.method, "POST");
        if (new URL(url).hostname === "oauth2.googleapis.com") {
          counts.oauth++;
          return Response.json({
            access_token: "synthetic-token",
            expires_in: 3600,
          });
        }
        assert.equal(String(url), String(target));
        assert.ok(init.signal instanceof AbortSignal);
        init.signal.addEventListener(
          "abort",
          () => {
            counts.aborted++;
            onModelAbort?.();
          },
          {
            once: true,
          },
        );
        try {
          const response = await fetch(address, init);
          if (mode === "cancel-error") {
            const getReader = response.body.getReader.bind(response.body);
            response.body.getReader = (...args) => {
              const reader = getReader(...args),
                cancel = reader.cancel.bind(reader);
              reader.cancel = async (reason) => {
                await cancel(reason);
                throw Object.assign(
                  new TypeError("Synthetic cancel transport failure"),
                  { code: "ECONNRESET" },
                );
              };
              return reader;
            };
          }
          return response;
        } catch (error) {
          if (mode === "coincident-error")
            throw Object.assign(
              new TypeError("Synthetic unrelated connection failure"),
              { code: "ECONNRESET" },
            );
          throw error;
        }
      },
    });
  } finally {
    vm.Script = originalScript;
    vm.createContext = originalCreate;
  }
  t.after(async () => {
    await host?.close().catch(() => {});
    store.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  return {
    host,
    api: sandbox.__SYNTHETIC_INDEX,
    realm: sandbox,
    counts,
    lifetime,
    storage,
    store,
    namespace,
    lease,
    path,
    source,
    preservedCache,
    onAbort(callback) {
      onModelAbort = callback;
    },
    invalidateContext() {
      failure = new Error("Synthetic revision guard changed");
    },
  };
}

function prepareIndex(f) {
  const engine = f.api.engine();
  engine.units.clear();
  for (const id of ["indexed", "fresh-a", "fresh-b", "fresh-c"])
    engine.units.set(
      id,
      new f.realm.__SYNTHETIC_INDEX_UNIT({
        id,
        name: id,
        content: `${id} is a friendly gardener who grows blue flowers and carries a silver notebook every morning.`,
        keywords: [id, "gardener"],
        flags: {
          canonical: true,
          canonicalSource: {
            kind: "lorebook",
            rawHash: id,
            hash: id,
            label: id,
          },
        },
      }),
    );
  const existing = {
    bySymbol: {
      blue: [{ unitId: "indexed", weight: 1, source: "appearance" }],
    },
    sourceUnitIds: ["indexed"],
    emptyAttempts: { kept: 2 },
    version: 1,
  };
  engine.setParams({
    stagedSearchEnabled: true,
    speedMode: "balanced",
    stagedBatchSize: 2,
    interactiveSlowAbortMs: 500,
    canonSymbolIndex: existing,
  });
  return { engine, existing };
}

for (const version of ["3.1.6", "3.2.0"]) {
  const path = defaultWygloreFixturePath(version),
    actual = {
      skip: fs.existsSync(path)
        ? false
        : "Preserve the pinned original plugin fixture",
      timeout: 15000,
    };
  test(
    `${version} deadline adapter rejects changed, duplicated and already transformed source seams`,
    actual,
    () => {
      const source = fs.readFileSync(path, "utf8"),
        before = digest(source);
      const executable = instrumentWygloreVertexEndpoint(
        source,
        instrumentWygloreTransportCancellation(
          source,
          instrumentWygloreLifecycle(source),
        ),
      );
      const adapted = instrumentWygloreIndexDeadline(source, executable);
      assert.ok(adapted.includes("delete globalThis." + PORT));
      assert.equal(Object.keys(PROFILES).length, 2);
      assert.throws(() =>
        instrumentWygloreIndexDeadline(source + "\n", executable),
      );
      assert.throws(() => instrumentWygloreIndexDeadline(source, adapted));
      for (const seam of Object.values(
        PROFILES[getWygloreRelease(source).sha256],
      )) {
        assert.throws(() =>
          instrumentWygloreIndexDeadline(
            source,
            executable.replace(seam.signature, seam.signature + "void 0;"),
          ),
        );
        assert.throws(() =>
          instrumentWygloreIndexDeadline(
            source,
            executable + "\n" + seam.signature + "{}",
          ),
        );
      }
      assert.throws(() =>
        instrumentWygloreIndexDeadline(
          source,
          executable + "__wlServerIndexToken",
        ),
      );
      assert.equal(digest(fs.readFileSync(path, "utf8")), before);
    },
  );

  for (const mode of ["headers", "body"])
    test(
      `${version} real original Canon batch ${mode} deadline preserves existing index, avoids empty cache and commits other memory without HTTP replay`,
      actual,
      async (t) => {
        const f = await realHost(t, version, mode),
          { engine, existing } = prepareIndex(f);
        await f.realm.risuai.pluginStorage.setItem("synthetic-valid-memory", {
          retained: true,
        });
        const result = await f.api.build(engine, f.api.client());
        await until(() => f.counts.closed === 1);
        await delay(25);
        assert.equal(f.counts.model, 1);
        assert.equal(f.counts.oauth, 1);
        assert.equal(f.counts.aborted, 1);
        assert.equal(result.batchCalls, 1);
        assert.equal(result.providerErrors, 1);
        assert.equal(result.singletonFallbacks, 0);
        assert.ok(result.saturatedSkips >= 1);
        assert.deepEqual(
          structuredClone(engine.params.canonSymbolIndex.bySymbol),
          existing.bySymbol,
        );
        assert.deepEqual(
          structuredClone(engine.params.canonSymbolIndex.sourceUnitIds),
          existing.sourceUnitIds,
        );
        assert.deepEqual(
          structuredClone(engine.params.canonSymbolIndex.emptyAttempts),
          existing.emptyAttempts,
        );
        assert.deepEqual(
          JSON.parse(
            await f.storage.pluginStorage.getItem("wl.canon-cache.v2"),
          ),
          f.preservedCache,
        );
        assert.equal(
          f.storage
            .checkpoint()
            .writes.some((write) => write.key === "wl.canon-cache.v2"),
          false,
        );
        f.host.ensureHealthy();
        await f.host.close({ success: true });
        const checkpoint = f.storage.checkpoint("retained-memory");
        assert.ok(
          checkpoint.writes.some(
            (write) => write.key === "synthetic-valid-memory",
          ),
        );
        assert.ok(
          checkpoint.writes.some(
            (write) =>
              write.key !== "synthetic-valid-memory" &&
              (JSON.stringify(write.value) || "").includes("fresh-a"),
          ),
          "The original engine flush also staged its synthetic graph",
        );
        const committed = f.store.commitPluginStorage(checkpoint);
        f.storage.acknowledge(committed, checkpoint);
        assert.deepEqual(
          f.store
            .readAllPluginStorage(f.namespace)
            .items.find((item) => item.key === "synthetic-valid-memory").value,
          { retained: true },
        );
        assert.equal(
          digest(fs.readFileSync(f.path, "utf8")),
          f.namespace.bundleSha,
        );
      },
    );

  test(
    `${version} ordinary complete and foreground slow abort remain isolated despite matching deadline text`,
    actual,
    async (t) => {
      for (const opts of [{ timeoutMs: 500 }, { slowAbortMs: 500 }]) {
        await t.test(Object.keys(opts)[0], async (t) => {
          const f = await realHost(t, version);
          await assert.rejects(
            f.api.client().complete("Synthetic public question", {
              ...opts,
              useCache: false,
            }),
          );
          await until(() => f.counts.closed === 1);
          assert.throws(() => f.host.ensureHealthy(), {
            code: "PLUGIN_PROVIDER_UNCERTAIN",
          });
          assert.equal(f.counts.model, 1);
        });
      }
    },
  );

  test(
    `${version} external host cancellation and disabled registry cannot be softened by Canon index proof`,
    actual,
    async (t) => {
      for (const cancel of [true, false, "coincident-error", "cancel-error"])
        await t.test(
          cancel === true
            ? "external cancellation"
            : cancel === false
              ? "registry disabled"
              : cancel === "coincident-error"
                ? "ordinary TypeError at the deadline"
                : "genuine reader cancellation failure",
          async (t) => {
            const f = await realHost(
                t,
                version,
                typeof cancel === "string" ? cancel : "headers",
                cancel !== false,
              ),
              { engine } = prepareIndex(f);
            if (cancel === true) {
              engine.setParams({ interactiveSlowAbortMs: 1000 });
              setTimeout(
                () => f.lifetime.abort(new Error("Synthetic job cancellation")),
                100,
              );
            }
            await f.api.build(engine, f.api.client()).catch(() => {});
            await until(() => f.counts.closed === 1);
            assert.throws(() => f.host.ensureHealthy());
            assert.equal(f.counts.model, 1);
          },
        );
    },
  );
}
