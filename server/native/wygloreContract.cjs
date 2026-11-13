"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// This identity is the author's distributed V3 file, not a rebuilt memory engine.
const WYGLORE_RELEASE = Object.freeze({
  name: "◆ WygLore Leaf",
  apiVersion: "3.0",
  version: "3.1.6",
  revision: "f028901324a87053ea72b361073744900aabc763",
  sha256: "5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c",
  bytes: 2034790,
  license: "Apache-2.0",
  url: "https://huggingface.co/m6dd8m/wyglore-leaf/resolve/f028901324a87053ea72b361073744900aabc763/WygLoreLeaf-latest.js",
});

// Keep the legacy export and fixture default stable for existing integrations.
// Admission is by the complete author artifact, never by a reported version.
const SUPPORTED_RELEASES = Object.freeze([
  WYGLORE_RELEASE,
  Object.freeze({
    name: "◆ WygLore Leaf",
    apiVersion: "3.0",
    version: "3.2.0",
    revision: "18ed8012c6e1531fb92e9163d63c62181a3d6c33",
    sha256: "ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9",
    bytes: 2781807,
    license: "Apache-2.0",
    url: "https://huggingface.co/m6dd8m/wyglore-leaf/resolve/18ed8012c6e1531fb92e9163d63c62181a3d6c33/WygLoreLeaf-latest.js",
  }),
]);

function getWygloreRelease(script) {
  if (typeof script !== "string") throw new Error("WygLore script is required");
  const hash = createHash("sha256").update(script).digest("hex");
  const release = SUPPORTED_RELEASES.find((release) => release.sha256 === hash);
  if (!release) {
    throw new Error(
      "Unsupported WygLore Leaf release: distributed bundle hash differs",
    );
  }
  return release;
}

function verifyWygloreScript(script) {
  getWygloreRelease(script);
  return script;
}

function matchesWygloreRelease(plugin) {
  if (
    plugin?.name !== WYGLORE_RELEASE.name ||
    plugin?.version !== WYGLORE_RELEASE.apiVersion ||
    typeof plugin.script !== "string"
  )
    return false;
  try {
    verifyWygloreScript(plugin.script);
    return true;
  } catch {
    return false;
  }
}

// Copied into the execution-only footer. This observes the original asynchronous
// functions; it does not replace their storage/network algorithms or Promises.
function createWygloreBackgroundTracker() {
  const pending = new Map();
  let failure;
  function assertHealthy() {
    if (failure) throw failure;
  }
  function failed(group) {
    if (!failure) {
      failure = new Error(
        group === "persist"
          ? "Original plugin persistence failed"
          : "Original plugin background persistence failed",
      );
      failure.code = "PLUGIN_PERSIST_FAILED";
    }
  }
  function wrap(original, group) {
    return function (...args) {
      assertHealthy();
      let work;
      try {
        work = Reflect.apply(original, this, args);
      } catch (error) {
        failed(group);
        throw error;
      }
      pending.set(work, group);
      // Observe rejection without making a second rejected Promise. An original
      // catch/fallback may consume its rejection, but canonical ACK must fail.
      work.then(
        () => pending.delete(work),
        () => {
          failed(group);
          pending.delete(work);
        },
      );
      return work;
    };
  }
  async function settle(signal) {
    while (true) {
      signal?.throwIfAborted();
      assertHealthy();
      const batch = [...pending.keys()];
      if (!batch.length) return;
      const drained = Promise.allSettled(batch);
      if (signal) {
        await new Promise((resolve, reject) => {
          const aborted = () => {
            signal.removeEventListener("abort", aborted);
            reject(signal.reason);
          };
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) {
            aborted();
            return;
          }
          drained.then(() => {
            signal.removeEventListener("abort", aborted);
            resolve();
          });
        });
      } else await drained;
      // A fulfilled operation can start another one in an original continuation.
      // Repeat until both groups drain; do not run the original work a second time.
    }
  }
  return Object.freeze({
    wrap,
    settle,
    assertHealthy,
    count: (group) =>
      [...pending.values()].filter((value) => value === group).length,
  });
}

// The bundle keeps its identifiers. Exposing the existing lifecycle functions
// inside its outer closure is a compatibility seam, not an algorithm rewrite.
// The stored/imported original is left unchanged. This executable copy therefore
// MUST be described as instrumented, not byte-identical to the author artifact.
const LIFECYCLE_SEAM = `\n;const __wlServerBackground = (${createWygloreBackgroundTracker.toString()})();
_runPendingPersist = __wlServerBackground.wrap(_runPendingPersist, "persist");
_manifestFromCacheOrFetch = __wlServerBackground.wrap(_manifestFromCacheOrFetch, "background");
Object.defineProperty(globalThis, "__WL_SERVER_LIFECYCLE", {
  value: Object.freeze({
    status: () => (__wlServerBackground.assertHealthy(), {
      ready: !!globalThis.__WL_DEBUG,
      coldStart: _coldStartRunning.size,
      indexBuild: !!_indexFallbackInFlight,
      providerActive: getLLMClient()._sem.active,
      providerQueued: getLLMClient()._sem.queue.length,
      persistPending: !!_persistTimer,
      persistActive: _hiddenFlushDepth > 0 || __wlServerBackground.count("persist") > 0,
      backgroundActive: __wlServerBackground.count("background"),
      swapPending: !!_activeSwap
    }),
    flush: flushEngine,
    settlePersistence: (signal) => __wlServerBackground.settle(signal),
    assertPersistenceHealthy: () => __wlServerBackground.assertHealthy(),
    settlePanel: () => _panelSyncTail,
    flushPendingPersistence: flushPendingPersistOnHide,
    parameters: () => structuredClone(getEngine().params),
    unitsCount: () => getEngine().units.size
  }), configurable: false, writable: false
});\n`;

function instrumentWygloreLifecycle(script) {
  verifyWygloreScript(script);
  const end = script.lastIndexOf("})();");
  if (end < 0 || script.slice(end + 5).trim()) {
    throw new Error("WygLore Leaf outer closure changed");
  }
  return script.slice(0, end) + LIFECYCLE_SEAM + script.slice(end);
}

function defaultWygloreFixturePath(version = WYGLORE_RELEASE.version) {
  if (!SUPPORTED_RELEASES.some((release) => release.version === version))
    throw new Error("Unsupported WygLore fixture version");
  return path.resolve(
    __dirname,
    `../../.local-runtime/public-plugins/wyglore-leaf/${version}/WygLoreLeaf-latest.js`,
  );
}

async function readWygloreFixture(file = defaultWygloreFixturePath()) {
  return verifyWygloreScript(await fs.readFile(file, "utf8"));
}

async function fetchWygloreFixture(
  file = defaultWygloreFixturePath(),
  transport = fetch,
) {
  const response = await transport(WYGLORE_RELEASE.url, {
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(`Public WygLore download failed (${response.status})`);
  const script = verifyWygloreScript(await response.text());
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write only after identity validation. An unknown release never replaces cache.
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, script, { mode: 0o600 });
  await fs.rename(temporary, file);
  return {
    path: file,
    sha256: WYGLORE_RELEASE.sha256,
    bytes: WYGLORE_RELEASE.bytes,
  };
}

module.exports = {
  WYGLORE_RELEASE,
  SUPPORTED_RELEASES,
  getWygloreRelease,
  verifyWygloreScript,
  matchesWygloreRelease,
  instrumentWygloreLifecycle,
  defaultWygloreFixturePath,
  readWygloreFixture,
  fetchWygloreFixture,
  LIFECYCLE_SEAM,
};

if (require.main === module) {
  const [action, file] = process.argv.slice(2);
  if (action !== "fetch" && action !== "verify") {
    console.error(
      "Usage: node server/native/wygloreContract.cjs fetch|verify [fixture path]",
    );
    process.exitCode = 1;
  } else {
    (action === "fetch"
      ? fetchWygloreFixture(file)
      : readWygloreFixture(file).then((script) => ({
          path: file || defaultWygloreFixturePath(),
          sha256: getWygloreRelease(script).sha256,
        }))
    )
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
