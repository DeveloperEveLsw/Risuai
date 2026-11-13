"use strict";
// Standalone measurement against authored terminal jobs; no engine/provider call.
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { mkdtempSync, rmSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir, cpus, platform, release } = require("node:os");
const { EntityStore } = require("../entity/store.cjs");
const { createRuntimeService } = require("./service.cjs");
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
async function main() {
  const dir = mkdtempSync(join(tmpdir(), "risu-history-benchmark-")),
    file = join(dir, "authored.sqlite");
  let runtime;
  try {
    const store = new EntityStore(file),
      count = 10000;
    store.applyCommand("c", {
      type: "create-character",
      characterId: "c",
      definition: { type: "character", name: "Authored benchmark" },
      chat: { chatId: "a" },
    });
    const started = performance.now();
    const update = store.db.prepare(
        "UPDATE jobs SET type=?,state=?,result=? WHERE id=?",
      ),
      result = JSON.stringify({ text: "Authored retained body ".repeat(100) });
    for (let i = 0; i < count; i++) {
      store.enqueueJob("synthetic-history-" + i, {
        type: "send",
        chatId: "a",
        text: "Authored input",
      });
      update.run(
        i % 4 ? "send" : "memory-summary",
        i % 19 ? "completed" : "failed",
        result,
        "synthetic-history-" + i,
      );
    }
    const seedMs = performance.now() - started;
    const positions = {};
    for (const filter of ["all", "memory", "failed"]) {
      const first = store.listJobHistory("a", {
        expectedEpoch: 0,
        filter,
        limit: 20,
      });
      const token = JSON.parse(
        Buffer.from(first.older, "base64url").toString(),
      );
      positions[filter] = [
        undefined,
        ...[5000, 21].map((anchor) =>
          Buffer.from(JSON.stringify([...token.slice(0, 7), anchor])).toString(
            "base64url",
          ),
        ),
      ];
    }
    store.db.exec(
      "DROP INDEX jobs_history;DROP INDEX memory_jobs_history;DROP INDEX failed_jobs_history;",
    );
    store.close();
    const openStart = performance.now();
    runtime = await createRuntimeService({ file });
    const reopenAndIndexMs = performance.now() - openStart;
    const reads = [];
    for (const filter of ["all", "memory", "failed"])
      for (let position = 0; position < 3; position++) {
        const timings = [],
          bytes = [],
          counts = [];
        const suffix = positions[filter][position]
          ? "&after=" + positions[filter][position]
          : "";
        for (let i = 0; i < 43; i++) {
          const begin = performance.now(),
            response = await fetch(
              runtime.url +
                "/api/runtime/chats/a/job-history?expectedEpoch=0&limit=20&filter=" +
                filter +
                suffix,
            );
          assert.equal(response.status, 200);
          const text = await response.text(),
            duration = performance.now() - begin,
            page = JSON.parse(text);
          assert.ok(!text.includes("Authored retained body"));
          assert.ok(page.items.length <= 20);
          assert.ok(Buffer.byteLength(text) < 16384);
          if (i >= 3) {
            timings.push(duration);
            bytes.push(Buffer.byteLength(text));
            counts.push(page.items.length);
          }
        }
        reads.push({
          filter,
          position: ["head", "middle", "tail"][position],
          samples: timings.length,
          p50Ms: percentile(timings, 0.5),
          p95Ms: percentile(timings, 0.95),
          maxMs: Math.max(...timings),
          maxBytes: Math.max(...bytes),
          maxRows: Math.max(...counts),
        });
      }
    console.log(
      JSON.stringify({
        benchmark: "job-history-10000",
        jobs: count,
        databaseBytes: statSync(file).size,
        perJobRetainedBodyBytes: Buffer.byteLength(result),
        metadataPageLimit: 20,
        seedMs,
        reopenAndIndexMs,
        reads,
        environment: {
          node: process.version,
          cpu: cpus()[0].model,
          cpuCount: cpus().length,
          platform: platform(),
          kernel: release(),
        },
        loopbackOnly: true,
        providerCalls: 0,
        wholeApplicationPerformanceResolved: false,
      }),
    );
  } finally {
    await runtime?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
