"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile, readFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { launchChromium } = require("./chromium.cjs");

test(
  "compiled display headers avoid projected-body enumeration and lazy cache refresh rejects stale/missing bodies",
  { timeout: 45000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-display-header-"));
    let frontend, browser;
    t.after(async () => {
      if (browser) await browser.close();
      if (frontend) await frontend.close();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const { createServer } = await import("vite");
    frontend = await createServer({
      configFile: resolve("vite.config.ts"),
      logLevel: "error",
      server: { port: 0, strictPort: false, host: "127.0.0.1", hmr: false },
      plugins: [
        {
          name: "synthetic-header-fixture",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (req.url !== "/header-fixture") return next();
              res.setHeader("Content-Type", "text/html");
              res.end("<!doctype html><body>Synthetic header fixture</body>");
            });
          },
        },
      ],
    });
    await frontend.listen();
    browser = await launchChromium(directory);
    const page = await browser.page(
      "http://127.0.0.1:" +
        frontend.httpServer.address().port +
        "/header-fixture",
      await browser.newContext(),
      { blockHttps: true },
    );
    const result = await page.evaluate(
      "(async()=>{const h=await import('/server/browser/displayHeaderHarness.svelte.ts');return {controller:h.checkControllerDisplayHeaders(),cache:h.checkLazyDisplayHeaders(),provisional:h.checkProvisionalHeaders()}})()",
    );
    for (const [group, keys] of [
      [
        "controller",
        [
          "actualControllerMethods",
          "syntheticProjectionOnly",
          "mainNoEnumeration",
          "bookmarkNoEnumeration",
          "independentVersions",
          "aliases",
          "previewAliases",
          "cursorFence",
          "clockFence",
          "historyFence",
          "bookmarkPageFence",
          "retiredPreview",
          "missingTargets",
          "unavailableHistory",
          "notReady",
        ],
      ],
      [
        "cache",
        [
          "clientCompiledSvelte",
          "sharedFrozen",
          "independentMutable",
          "rebuiltClock",
          "headerOnlyFresh",
          "rebuiltEpoch",
          "mismatchedBodyRejected",
          "missingBodyRejected",
          "legacyFullApi",
          "closedNoReads",
        ],
      ],
    ])
      for (const key of keys)
        assert.equal(result[group][key], true, group + ":" + key);
    for (const [key, value] of Object.entries(result.provisional))
      assert.equal(value, true, "provisional:" + key);
    assert.deepEqual(result.controller.mainFields, {
      id: "m1",
      revision: 2,
      ordinal: 21,
      count: 220,
      model: "Synthetic model",
      source: "Synthetic one",
      epochs: [4, 5],
    });
    assert.deepEqual(result.controller.outsideFields, {
      id: "outside",
      ordinal: 8,
      count: 220,
      source: "Synthetic outside",
      origin: "synthetic-key",
      partial: true,
    });
    assert.deepEqual(result.controller.fullEnumerations, {
      database: 1,
      character: 1,
      chat: 1,
    });
    assert.deepEqual(result.controller.bookmarkFullEnumerations, {
      database: 1,
      character: 1,
      chat: 1,
    });
    assert.equal(result.cache.initialReads, 1);
    assert.equal(result.cache.changedReads, 2);
    assert.equal(result.cache.epochReads, 3);
    result.sourceHashes = {};
    for (const path of [
      "src/ts/runtime/displayEffects.ts",
      "src/ts/runtime/browserRuntimeController.svelte.ts",
      "src/ts/runtime/browserRuntimeState.svelte.ts",
      "src/ts/runtime/displayScopeCache.svelte.ts",
      "src/ts/process/scriptings.ts",
      "server/browser/displayHeaderHarness.svelte.ts",
      "server/browser/displayHeaderUi.test.cjs",
    ])
      result.sourceHashes[path] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    if (process.env.RISU_DISPLAY_HEADER_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_HEADER_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    console.log(JSON.stringify(result));
  },
);
