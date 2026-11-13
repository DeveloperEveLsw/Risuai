"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const acorn = require("acorn");
const { createHash, generateKeyPairSync } = require("node:crypto");
const {
  instrumentWygloreVertexEndpoint,
  RELEASES,
} = require("./wygloreVertexEndpoint.cjs");
const {
  instrumentWygloreTransportCancellation,
} = require("./wygloreTransportCancellation.cjs");
const {
  defaultWygloreFixturePath,
  getWygloreRelease,
  instrumentWygloreLifecycle,
} = require("./wygloreContract.cjs");
const { createServerPluginHost } = require("./serverPluginHost.cjs");
const { createPluginStorageSession } = require("./pluginStorageSession.cjs");
const { makeWygloreContractFixture } = require("./wygloreContractFixtures.cjs");

const digest = (value) => createHash("sha256").update(value).digest("hex");
function endpoint(source) {
  const start = source.indexOf("function endpointBase(region,projectId)");
  assert.ok(start >= 0);
  const node = acorn.parseExpressionAt(source, start, {
    ecmaVersion: "latest",
  });
  assert.equal(node.type, "FunctionExpression");
  assert.equal(node.id.name, "endpointBase");
  return vm.runInNewContext("(" + source.slice(start, node.end) + ")");
}
function checkRoutes(resolve) {
  const project = "synthetic-public";
  for (const region of ["us", "eu"])
    assert.equal(
      resolve(region, project),
      `https://aiplatform.${region}.rep.googleapis.com/v1/projects/${project}/locations/${region}`,
    );
  assert.equal(
    resolve("global", project),
    `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global`,
  );
  for (const region of ["us-central1", "europe-west4", "asia-northeast3"])
    assert.equal(
      resolve(region, project),
      `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}`,
    );
  // Only the exact author setting values gain new routing semantics.
  for (const region of ["US", "eu ", "global "])
    assert.equal(
      resolve(region, project),
      `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}`,
    );
}

test("Vertex multi-region adapter is separately pinned to two complete author artifacts", () => {
  assert.ok(Object.isFrozen(RELEASES));
  assert.deepEqual([...RELEASES].sort(), [
    "5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c",
    "ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9",
  ]);
});

for (const [version, region] of [
  ["3.1.6", "us"],
  ["3.2.0", "eu"],
]) {
  const path = defaultWygloreFixturePath(version);
  const actual = {
    skip: fs.existsSync(path)
      ? false
      : "Preserve the pinned original WygLore fixture",
    timeout: 15000,
  };

  test(
    `${version} original endpoint function supports explicit multi-regions while preserving global and regional routes`,
    actual,
    () => {
      const source = fs.readFileSync(path, "utf8"),
        before = digest(source);
      const originalEndpoint = endpoint(source);
      assert.equal(
        originalEndpoint("eu", "synthetic-public"),
        "https://eu-aiplatform.googleapis.com/v1/projects/synthetic-public/locations/eu",
      );
      checkRoutes(endpoint(instrumentWygloreVertexEndpoint(source)));
      assert.equal(digest(source), before);
      assert.equal(digest(fs.readFileSync(path, "utf8")), before);
    },
  );

  test(
    `${version} changed, missing, duplicate and already adapted endpoint seams are rejected`,
    actual,
    () => {
      const source = fs.readFileSync(path, "utf8");
      assert.throws(() => instrumentWygloreVertexEndpoint(source + "\n"));
      assert.throws(() => instrumentWygloreVertexEndpoint(source, null));
      assert.throws(() =>
        instrumentWygloreVertexEndpoint(
          source,
          source.replace(
            "function endpointBase(region,projectId){",
            "function endpointBase(region,projectId){void 0;",
          ),
        ),
      );
      assert.throws(() =>
        instrumentWygloreVertexEndpoint(
          source,
          source.replace(
            "function endpointBase(region,projectId)",
            "function changedEndpoint(region,projectId)",
          ),
        ),
      );
      assert.throws(() =>
        instrumentWygloreVertexEndpoint(
          source,
          source + "\nfunction endpointBase(region,projectId){}",
        ),
      );
      assert.throws(() =>
        instrumentWygloreVertexEndpoint(
          source,
          instrumentWygloreVertexEndpoint(source),
        ),
      );
    },
  );

  test(
    `${version} endpoint adaptation composes after lifecycle and cancellation without changing the original model or timeout defaults`,
    actual,
    () => {
      const source = fs.readFileSync(path, "utf8");
      const cancellation = instrumentWygloreTransportCancellation(
        source,
        instrumentWygloreLifecycle(source),
      );
      const combined = instrumentWygloreVertexEndpoint(source, cancellation);
      checkRoutes(endpoint(combined));
      assert.ok(combined.includes("__wlServerSlotAbort.signal"));
      assert.ok(
        combined.includes(
          "__wlServerTransportDeadline(start,hostTimeoutMs,signal",
        ),
      );
      assert.ok(combined.includes("DEFAULT_TIMEOUT_MS=8e3"));
      assert.ok(combined.includes("HOST_TRANSPORT_TIMEOUT_MS=6e4"));
      assert.equal(
        combined.replace(
          endpoint(combined).toString(),
          endpoint(cancellation).toString(),
        ),
        cancellation,
        "The endpoint function is the only further executable change",
      );
      assert.equal(
        digest(fs.readFileSync(path, "utf8")),
        getWygloreRelease(source).sha256,
      );
    },
  );

  test(
    `${version} full original server host sends one synthetic slot call to configured ${region} with cancellable transport and unchanged stored settings`,
    actual,
    async (t) => {
      const source = fs.readFileSync(path, "utf8");
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });
      const settings = new Map([
        [
          "wl.llm.config",
          JSON.stringify({
            completeProviderId: "vertex",
            completeModel: "gemini-3.8-flash",
            maxConcurrent: 1,
          }),
        ],
        ["wl.provider.vertex.region", region],
        [
          "wl.provider.vertex.serviceAccountJson",
          JSON.stringify({
            type: "service_account",
            client_email: "public@synthetic-public.iam.gserviceaccount.com",
            private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
            project_id: "synthetic-public",
          }),
        ],
      ]);
      const fixture = makeWygloreContractFixture({ storage: settings });
      const namespace = {
        pluginId: "synthetic-vertex",
        bundleSha: getWygloreRelease(source).sha256,
        pluginEpoch: 0,
      };
      const storage = createPluginStorageSession(
        {
          namespace,
          revision: 0,
          items: [...settings].map(([key, value]) => ({
            key,
            value,
            revision: 0,
          })),
        },
        {
          namespace,
          writerId: "synthetic-worker",
          token: "synthetic-token",
          fence: 1,
          revision: 0,
        },
      );
      let failure, sandbox;
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
              "\nglobalThis.__SYNTHETIC_VERTEX={slot:testSlotConnection,client:getLLMClient};\n" +
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
      let host;
      const calls = [];
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
          fetch: async (address, init) => {
            const url = new URL(address);
            assert.equal(init.method, "POST");
            assert.ok(init.signal instanceof AbortSignal);
            assert.equal(init.signal.aborted, false);
            calls.push(url.hostname);
            if (url.hostname === "oauth2.googleapis.com") {
              assert.equal(url.pathname, "/token");
              return Response.json({
                access_token: "synthetic-token",
                expires_in: 3600,
              });
            }
            assert.equal(
              url.hostname,
              `aiplatform.${region}.rep.googleapis.com`,
            );
            assert.equal(
              url.pathname,
              `/v1/projects/synthetic-public/locations/${region}/publishers/google/models/gemini-3.8-flash:streamGenerateContent`,
            );
            assert.equal(url.search, "?alt=sse");
            const body = JSON.parse(init.body);
            assert.deepEqual(body.contents, [
              { role: "user", parts: [{ text: "ping" }] },
            ]);
            assert.equal(body.generationConfig.maxOutputTokens, 256);
            return new Response(
              'data: {"candidates":[{"content":{"parts":[{"text":"pong"}]},"finishReason":"STOP"}]}\n\n',
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        });
      } finally {
        vm.Script = originalScript;
        vm.createContext = originalCreate;
      }
      t.after(() => host?.close());
      const result = await sandbox.__SYNTHETIC_VERTEX.slot(
        "complete",
        "vertex",
        "gemini-3.8-flash",
      );
      assert.equal(result.ok, true);
      assert.equal(String(result.response).trim(), "pong");
      assert.deepEqual(calls, [
        "oauth2.googleapis.com",
        `aiplatform.${region}.rep.googleapis.com`,
      ]);
      assert.equal(settings.get("wl.provider.vertex.region"), region);
      assert.equal(
        await storage.pluginStorage.getItem("wl.provider.vertex.region"),
        region,
      );
      assert.equal(
        storage
          .checkpoint("complete")
          .writes.some(
            (write) =>
              write.key === "wl.provider.vertex.region" ||
              write.key === "wl.provider.vertex.serviceAccountJson" ||
              write.key === "wl.llm.config",
          ),
        false,
      );
      assert.equal(digest(fs.readFileSync(path, "utf8")), namespace.bundleSha);
      host.ensureHealthy();
    },
  );
}
