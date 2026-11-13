"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { setImmediate: nextTurn } = require("node:timers/promises");
const vm = require("node:vm");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { createServerPluginHost } = require("./serverPluginHost.cjs");
const { createPluginStorageSession } = require("./pluginStorageSession.cjs");
const { makeWygloreContractFixture } = require("./wygloreContractFixtures.cjs");
const {
  WYGLORE_RELEASE,
  readWygloreFixture,
} = require("./wygloreContract.cjs");

function originalAbortHelpers(script) {
  const declarations = new Map();
  let timeout;
  walk.simple(acorn.parse(script, { ecmaVersion: "latest" }), {
    FunctionDeclaration(node) {
      if (["_requestAbortError", "_withHostTimeout"].includes(node.id?.name)) {
        assert.equal(declarations.has(node.id.name), false);
        declarations.set(node.id.name, script.slice(node.start, node.end));
      }
    },
    AssignmentExpression(node) {
      if (node.left.name === "HOST_TRANSPORT_TIMEOUT_MS") {
        assert.equal(node.right.type, "Literal");
        timeout = node.right.value;
      }
    },
  });
  assert.equal(declarations.size, 2);
  assert.equal(timeout, 60000);
  // Exact declarations copied from the verified author artifact into the
  // actual host realm. No plugin algorithms, timeout values or product ports
  // are changed to make the failure path reachable.
  return `const HOST_TRANSPORT_TIMEOUT_MS=${timeout};\n${[...declarations.values()].join("\n")}`;
}

async function runAbortFixture(mode) {
  const script = await readWygloreFixture();
  const f = makeWygloreContractFixture();
  const canonicalStorage = [...f.storage];
  const namespace = {
    pluginId: "wyglore",
    bundleSha: WYGLORE_RELEASE.sha256,
    pluginEpoch: 0,
  };
  const session = createPluginStorageSession(
    {
      namespace,
      revision: 0,
      items: canonicalStorage.map(([key, value]) => ({
        key,
        value,
        revision: 1,
      })),
    },
    {
      namespace,
      writerId: "synthetic",
      token: "synthetic",
      fence: 1,
      revision: 0,
    },
  );
  let contextFailure,
    requests = 0,
    realm,
    host;
  const context = {
    getCurrentCharacter: () => f.character,
    getCurrentChat: () => f.chat,
    setCurrentChat: (next) => Object.assign(f.chat, next),
    getDatabase: () => f.database,
    readResourceValue: (value) => value,
    ensureHealthy() {
      if (contextFailure) throw contextFailure;
    },
    fail(message) {
      contextFailure ??= new Error(message);
      throw contextFailure;
    },
  };
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const originalCreateContext = vm.createContext;
  vm.createContext = (sandbox, ...args) => {
    const actual = originalCreateContext(sandbox, ...args);
    if (
      sandbox.risuai &&
      sandbox.navigator?.userAgent === "Risu server native"
    ) {
      assert.equal(realm, undefined);
      realm = actual;
      vm.createContext = originalCreateContext;
    }
    return actual;
  };
  try {
    host = await createServerPluginHost({
      plugin: {
        id: "wyglore",
        enabled: true,
        name: WYGLORE_RELEASE.name,
        version: "3.0",
        script,
      },
      context,
      storage: session,
      fetch: (_url, init) => {
        requests++;
        assert.equal(
          requests,
          1,
          "An uncertain request must never be replayed",
        );
        assert.equal(init.method, "POST");
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
          markStarted();
        });
      },
    });
  } finally {
    vm.createContext = originalCreateContext;
  }
  try {
    assert.ok(realm);
    assert.equal(host.status().ready, true);
    // Capturing createContext above is observation only. These unmodified
    // original helpers use the host's real API, timer wrapper and Node
    // AbortController/EventTarget, including the sandbox's actual globals.
    vm.runInContext(
      `${originalAbortHelpers(script)}
       globalThis.__syntheticAbortController = new AbortController();
       globalThis.__syntheticAbortReason = ${mode === "string" ? '"synthetic-stop"' : mode === "error" ? 'new Error("synthetic-stop")' : "undefined"};
       globalThis.__syntheticAbortResult = _withHostTimeout(
         () => risuai.nativeFetch("https://synthetic.invalid/request", {method:"POST",signal:__syntheticAbortController.signal}),
         HOST_TRANSPORT_TIMEOUT_MS, __syntheticAbortController.signal
       ).then(() => {throw new Error("The synthetic held request must abort");}, error => ({
         name:error.name, code:error.code, sameReason:error===__syntheticAbortReason
       }));`,
      realm,
      { filename: "WygLoreLeaf-3.1.6.abort-contract.js" },
    );
    await started;
    vm.runInContext(
      `setTimeout(() => { try { __syntheticAbortController.abort(${mode === "default" ? "" : "__syntheticAbortReason"}); } catch {} }, 0);`,
      realm,
    );
    const outcome = await realm.__syntheticAbortResult;
    assert.equal(outcome.name, mode === "error" ? "Error" : "AbortError");
    assert.equal(outcome.sameReason, mode === "error");
    if (mode !== "error") assert.equal(outcome.code, 20);
    await nextTurn();
    assert.equal(requests, 1);
    assert.throws(() => host.ensureHealthy(), {
      code: "PLUGIN_PROVIDER_UNCERTAIN",
    });
    await assert.rejects(host.close({ success: true }), {
      code: "PLUGIN_PROVIDER_UNCERTAIN",
    });
    // As in the native coordinator's release/finally path, a failed completion
    // cannot checkpoint the overlay and the owner discards the private session.
    session.discard();
    assert.throws(() => session.checkpoint("must-not-finalize"), {
      code: "PLUGIN_SESSION_CLOSED",
    });
    assert.deepEqual([...f.storage], canonicalStorage);
    assert.equal(script, await readWygloreFixture());
    return {
      mode,
      name: outcome.name,
      sameReason: outcome.sameReason,
      requests,
      uncertainGuard: true,
      overlayDiscarded: true,
      originalBundleUnchanged: true,
    };
  } finally {
    await host.close().catch(() => {});
    session.discard();
  }
}

if (process.argv[2] === "--abort-fixture") {
  runAbortFixture(process.argv[3]).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
} else {
  const { test } = require("node:test");
  for (const mode of ["string", "default", "error"]) {
    test(
      `actual pinned plugin host safely handles a timer abort with ${mode} reason without replay or finalizing its overlay`,
      { timeout: 20000 },
      async () => {
        const child = spawn(
          process.execPath,
          [__filename, "--abort-fixture", mode],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
        const exit = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        }).finally(() => clearTimeout(timer));
        assert.equal(
          exit.code,
          0,
          JSON.stringify({
            mode,
            signal: exit.signal,
            missingDomException: /DOMException is not defined/.test(stderr),
            assertionFailed: /AssertionError/.test(stderr),
          }),
        );
        assert.equal(exit.signal, null);
        const result = JSON.parse(stdout.trim());
        assert.equal(result.name, mode === "error" ? "Error" : "AbortError");
        assert.equal(result.requests, 1);
        assert.equal(result.uncertainGuard, true);
        assert.equal(result.overlayDiscarded, true);
        assert.equal(result.originalBundleUnchanged, true);
      },
    );
  }
}
