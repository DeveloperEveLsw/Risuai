"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { openDatabase } = require("./openDatabase.cjs");
const { EntityStoreClient } = require("./client.cjs");

test("simultaneous cold database workers initialize and deduplicate commands", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "risu-cold-workers-"));
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    rmSync(directory, { recursive: true, force: true });
  });
  for (let trial = 0; trial < 8; trial++) {
    const file = join(directory, `cold-${trial}.sqlite`);
    const peers = Array.from({ length: 4 }, () => new EntityStoreClient(file));
    clients.push(...peers);
    const results = await Promise.all(
      peers.map((client) =>
        client.call("applyCommand", "same-character", {
          type: "create-character",
          characterId: "c",
          definition: { name: "Synthetic simultaneous initialization" },
        }),
      ),
    );
    assert.deepEqual(results, Array(4).fill(results[0]));
    const states = await Promise.all(
      peers.map((client) => client.call("bootstrap")),
    );
    assert.ok(states.every((state) => state.characters.length === 1));
    await Promise.all(peers.map((client) => client.close()));
  }
});

test("an unreleased initialization lock fails within its budget without a partial write", () => {
  const directory = mkdtempSync(join(tmpdir(), "risu-init-locked-"));
  const file = join(directory, "locked.sqlite");
  const holder = new DatabaseSync(file);
  try {
    holder.exec("CREATE TABLE fixture(value); BEGIN EXCLUSIVE;");
    const started = performance.now();
    assert.throws(
      () => openDatabase(file, 50),
      (error) => {
        assert.equal(error.code, "ERR_SQLITE_ERROR");
        assert.equal(error.errcode & 255, 5);
        return true;
      },
    );
    assert.ok(performance.now() - started < 2000);
    holder.exec("ROLLBACK;");
    const reopened = openDatabase(file);
    assert.equal(reopened.prepare("SELECT count(*) n FROM fixture").get().n, 0);
    assert.equal(reopened.prepare("PRAGMA busy_timeout").get().timeout, 5000);
    assert.equal(reopened.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(reopened.prepare("PRAGMA synchronous").get().synchronous, 2);
    assert.equal(
      reopened.prepare("PRAGMA journal_mode").get().journal_mode,
      "wal",
    );
    reopened.close();
  } finally {
    holder.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
