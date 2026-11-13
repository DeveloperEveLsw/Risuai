"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { launchChromium } = require("./chromium.cjs");

test(
  "client-compiled Svelte display scope shares only frozen bodies and refreshes local/header/module/page/lifetime inputs",
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "risu-display-scope-cache-"),
    );
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
      server: { port: 0, host: "127.0.0.1", hmr: false },
      plugins: [
        {
          name: "scope-fixture-html",
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              if (req.url !== "/scope-fixture") return next();
              res.setHeader("Content-Type", "text/html");
              res.end(
                "<!doctype html><html><body>Synthetic scope fixture</body></html>",
              );
            });
          },
        },
      ],
    });
    await frontend.listen();
    browser = await launchChromium(directory);
    const context = await browser.newContext();
    const page = await browser.page(
      "http://127.0.0.1:" +
        frontend.httpServer.address().port +
        "/scope-fixture",
      context,
    );
    const result = await page.evaluate(
      "(async()=>{const {checkSharedDisplayScope}=await import('/server/browser/displayScopeHarness.svelte.ts');return checkSharedDisplayScope()})()",
    );
    assert.equal(result.clientCompiledSvelte, true);
    for (const key of [
      "aliases",
      "sharedHistory",
      "privateMutable",
      "oldPinned",
      "frozen",
      "unavailable",
      "closed",
      "protoOwn",
      "protoPrototypeUnchanged",
    ])
      assert.equal(result[key], true, key);
    assert.equal(result.changedMessage, "Synthetic later");
    assert.equal(result.moduleValue, "module-later");
    assert.equal(result.presetValue, "preset-later");
    assert.equal(result.protoValue, "after");
    assert.equal(result.addedValue, "new-key");
    assert.equal(result.removedKey, true);
    assert.equal(result.freshEnvironment.old.model.id, "Synthetic model");
    assert.equal(
      result.freshEnvironment.current.model.id,
      "Synthetic next model",
    );
    assert.equal(result.freshEnvironment.old.triggerId, "Synthetic trigger");
    assert.equal(
      result.freshEnvironment.current.triggerId,
      "Synthetic next trigger",
    );
    assert.deepEqual(result.navigation, {
      character: "next-character",
      chat: "next-chat",
      first: "message-49",
    });
    const trace = Object.fromEntries(
      result.trace.map((row) => [row.label, row]),
    );
    assert.equal(
      trace.initial.preparations,
      1,
      "50 rows share one derived body",
    );
    assert.equal(trace["fresh-header-only"].preparations, 1);
    assert.equal(trace["fresh-header-only"].revision, 2);
    assert.equal(trace["nested-message"].preparations, 2);
    assert.equal(trace["nested-variable"].value, "canonical-later");
    assert.deepEqual(trace["disable-module"].modules, []);
    assert.deepEqual(trace["enable-module"].modules, ["m"]);
    assert.equal(trace["partial-history"].partial, true);
    assert.equal(
      trace["plain-projection-notification"].preparations,
      trace["partial-history"].preparations + 1,
    );
    assert.equal(
      trace["fresh-environment"].preparations,
      trace["plain-projection-notification"].preparations,
    );
    assert.equal(trace["unannounced-clock-guard"].clock, 2);
    assert.equal(
      trace["unannounced-clock-guard"].preparations,
      trace["fresh-environment"].preparations + 1,
    );
    assert.equal(trace["unannounced-epoch-guard"].epoch, 2);
    assert.equal(
      trace["unannounced-epoch-guard"].preparations,
      trace["unannounced-clock-guard"].preparations + 1,
    );
    const coalescing = await page.evaluate(
      "(async()=>{const {checkDisplayScopeCoalescing}=await import('/server/browser/displayScopeHarness.svelte.ts');return checkDisplayScopeCoalescing()})()",
    );
    assert.equal(coalescing.realWorker, true);
    assert.equal(coalescing.actualLuaAndCbs, true);
    for (const row of coalescing.observations) {
      const duplicate = row.dependency === "duplicate";
      assert.equal(row.executions, duplicate ? 1 : 2, row.dependency);
      assert.equal(
        row.invocationsWhileBlocked,
        duplicate ? 1 : 2,
        row.dependency,
      );
      assert.deepEqual(row.errors, [], row.dependency);
      assert.deepEqual(row.commands, [], row.dependency);
      assert.equal(row.outputs[0], "0:before:Synthetic:1", row.dependency);
      const value = ["local-value", "private-value"].includes(row.dependency)
        ? "9"
        : "0";
      const trigger =
        row.dependency === "trigger-environment" ? "after" : "before";
      const history =
        row.dependency === "nested-history" ? "Synthetic later" : "Synthetic";
      assert.equal(
        row.outputs[1],
        `${value}:${trigger}:${history}:${duplicate ? 1 : 2}`,
        row.dependency,
      );
      assert.equal(
        row.preparations,
        ["local-value", "nested-history", "nested-module"].includes(
          row.dependency,
        )
          ? 2
          : 1,
        row.dependency,
      );
    }
    result.coalescing = coalescing;
    const transport = await page.evaluate(
      "(async()=>{const {checkWorkerCaptureTransport}=await import('/server/browser/displayScopeHarness.svelte.ts');return checkWorkerCaptureTransport()})()",
    );
    assert.equal(transport.realWorker, true);
    assert.equal(transport.actualLuaAndCbs, true);
    assert.deepEqual(transport.outputs, [
      "0/private-1/First/before/1",
      "0/private-2/First/before/2",
      "9/private-3/Later/after/3",
      "9/private-1/Later/after/1",
    ]);
    assert.equal(transport.canonicalCounter, "9");
    assert.deepEqual(transport.commands, []);
    assert.equal(transport.packets.length, 5);
    assert.ok(transport.packets[0].definitionBytes > 90000);
    assert.equal(transport.packets[1].definitions, 0);
    assert.ok(transport.packets[1].packetBytes < 5000);
    assert.ok(transport.packets[2].definitionBytes > 90000);
    assert.ok(transport.packets[3].definitionBytes > 90000);
    assert.ok(transport.reused.reusedReferences > 0);
    assert.ok(
      transport.refreshed.definitionsSent > transport.reused.definitionsSent,
    );
    assert.equal(transport.closedDictionary.entries, 0);
    assert.equal(transport.closedDictionary.cachedBytes, 0);
    assert.equal(transport.corruption.failed, true);
    assert.equal(transport.corruption.output, "Synthetic corrupted");
    assert.ok(
      transport.corruption.errors.some((error) =>
        error.includes("missing reference"),
      ),
    );
    assert.equal(transport.corruption.terminated, 2);
    assert.equal(transport.corruption.dictionary.entries, 0);
    result.captureTransport = transport;
    const sourceIdentity = await page.evaluate(
      "(async()=>{const {checkWorkerCaptureTransport}=await import('/server/browser/displayScopeHarness.svelte.ts');return checkWorkerCaptureTransport(true)})()",
    );
    assert.deepEqual(sourceIdentity.outputs, transport.outputs);
    assert.equal(sourceIdentity.identityKeys.length, 5);
    assert.ok(
      sourceIdentity.identityKeys.every(
        (key) => key.anchored && key.bytes < 5000,
      ),
    );
    assert.ok(
      sourceIdentity.packets[1].packetBytes > 100000,
      "Local key compaction must not remove actual source from the worker capture",
    );
    assert.equal(sourceIdentity.packets[1].definitions, 0);
    assert.deepEqual(sourceIdentity.commands, []);
    assert.equal(sourceIdentity.canonicalCounter, "9");
    assert.equal(sourceIdentity.corruption.failed, true);
    assert.equal(sourceIdentity.corruption.terminated, 2);
    assert.equal(sourceIdentity.corruption.dictionary.entries, 0);
    result.sourceIdentity = sourceIdentity;
    const sharing = await page.evaluate(
      "(async()=>{const {checkWorkerCaptureTransport}=await import('/server/browser/displayScopeHarness.svelte.ts');return checkWorkerCaptureTransport(false,true)})()",
    );
    assert.deepEqual(sharing.outputs, [
      "0/private-1/First/before/1",
      "0/private-2/First/before/2",
      "9/private-3/First/before/3",
      "9/private-4/Later/after/4",
      "9/private-1/Later/after/1",
    ]);
    assert.equal(sharing.packets.length, 6);
    assert.equal(
      sharing.packets[2].definitions,
      0,
      "Variable/clock changes must refresh Lua while the identical history stays in the dictionary",
    );
    assert.ok(sharing.packets[2].packetBytes < 5000);
    assert.ok(sharing.packets[3].definitionBytes > 90000);
    assert.ok(sharing.packets[4].definitionBytes > 90000);
    assert.deepEqual(sharing.commands, []);
    assert.equal(sharing.canonicalCounter, "9");
    assert.equal(sharing.closedDictionary.entries, 0);
    assert.equal(sharing.corruption.failed, true);
    result.snapshotSharing = sharing;
    if (process.env.RISU_DISPLAY_REUSE_OUTPUT)
      await writeFile(
        process.env.RISU_DISPLAY_REUSE_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
      );
    console.log(JSON.stringify(result));
  },
);
