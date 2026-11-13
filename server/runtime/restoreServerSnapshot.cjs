"use strict";
const fs = require("node:fs/promises");
const { join, dirname, resolve } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { EntityStore } = require("../entity/store.cjs");
const interactions = require("../entity/interactions.cjs");
const {
  snapshotMagic,
  snapshotEnd,
  snapshotLimits,
  validateSnapshotManifest,
} = require("../../src/ts/runtime/serverSnapshotProtocol.mjs");
function fail(code) {
  throw Object.assign(new Error(code), { code });
}
const quoted = (name) => '"' + name.replaceAll('"', '""') + '"';
async function absent(path) {
  try {
    await fs.lstat(path);
    fail("DESTINATION_EXISTS");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
async function syncFile(path) {
  const handle = await fs.open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
const PLUGIN_TABLES = [
  "plugin_storage_namespaces",
  "plugin_storage_items",
  "plugin_storage_commits",
];
function fingerprints(
  db,
  liveIds,
  pendingIds,
  cursor,
  { pluginLeaseIds = new Set(), excludeTables = new Set() } = {},
) {
  const result = { tables: Object.create(null) };
  const tables = db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all()
    .filter((table) => !excludeTables.has(table.name));
  result.schema = createHash("sha256")
    .update(
      JSON.stringify(
        db
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
          )
          .all()
          .filter((entry) => !excludeTables.has(entry.tbl_name)),
      ),
    )
    .digest("hex");
  for (const table of tables) {
    const keys = db
      .prepare("PRAGMA table_info(" + quoted(table.name) + ")")
      .all()
      .filter((c) => c.pk)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => quoted(c.name));
    const order = keys.length ? keys.join(",") : "rowid";
    const hash = createHash("sha256");
    const rows = db.prepare(
      "SELECT * FROM " + quoted(table.name) + " ORDER BY " + order,
    );
    rows.setReadBigInts(true);
    for (const raw of rows.iterate()) {
      const row = { ...raw };
      if (table.name === "changes" && row.sequence > cursor) continue;
      if (table.name === "runtime_identity") delete row.id;
      if (table.name === "sqlite_sequence" && row.name === "changes")
        delete row.seq;
      if (table.name === "jobs" && liveIds.has(row.id))
        for (const key of [
          "state",
          "owner",
          "lease_until",
          "fence",
          "result",
          "updated_at",
        ])
          delete row[key];
      if (table.name === "job_interactions" && pendingIds.has(row.id))
        for (const key of ["state", "revision", "closed_reason", "resolved_at"])
          delete row[key];
      if (
        table.name === "plugin_storage_namespaces" &&
        pluginLeaseIds.has(row.id)
      )
        for (const key of [
          "writer_id",
          "lease_token",
          "lease_until",
          "authority",
          "fence",
        ])
          delete row[key];
      hash.update(
        JSON.stringify(row, (_key, value) =>
          typeof value === "bigint"
            ? { sqliteInteger: value.toString() }
            : value,
        ),
      );
      hash.update("\n");
    }
    result.tables[table.name] = hash.digest("hex");
  }
  return result;
}
async function restoreServerSnapshot({ backup, file, expectedSha256 }) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) fail("INVALID_CHECKSUM");
  file = resolve(file);
  for (const path of [file, file + ".assets", file + ".restore-report.json"])
    await absent(path);
  await fs.mkdir(dirname(file), { recursive: true });
  const directory = await fs.mkdtemp(
    join(dirname(file), ".risu-snapshot-restore-"),
  );
  const whole = createHash("sha256");
  let offset = 0,
    source,
    store,
    createdAssets,
    publishedAuthority,
    published = false;
  try {
    source = await fs.open(backup, "r");
    const before = await source.stat();
    if (
      before.size >
      snapshotLimits.totalBytes + snapshotLimits.manifestBytes + 20
    )
      fail("SNAPSHOT_TOO_LARGE");
    async function read(size) {
      if (offset + size > before.size) fail("TRUNCATED_SNAPSHOT");
      const bytes = Buffer.alloc(size);
      let got = 0;
      while (got < size) {
        const r = await source.read(bytes, got, size - got, offset + got);
        if (!r.bytesRead) fail("TRUNCATED_SNAPSHOT");
        got += r.bytesRead;
      }
      offset += size;
      whole.update(bytes);
      return bytes;
    }
    if (!(await read(snapshotMagic.length)).equals(Buffer.from(snapshotMagic)))
      fail("INVALID_SNAPSHOT_MAGIC");
    const length = (await read(4)).readUInt32LE(0);
    if (!length || length > snapshotLimits.manifestBytes)
      fail("INVALID_SNAPSHOT_MANIFEST");
    const manifest = validateSnapshotManifest(
      JSON.parse((await read(length)).toString("utf8")),
    );
    const blobDir = join(directory, "blobs");
    await fs.mkdir(blobDir, { mode: 0o700 });
    const stagedDb = join(directory, "snapshot.sqlite");
    for (const entry of manifest.files) {
      const path =
        entry.name === "snapshot.sqlite"
          ? stagedDb
          : join(blobDir, entry.sha256 + ".blob");
      const output = await fs.open(path, "wx", 0o600),
        hash = createHash("sha256");
      try {
        for (let remaining = entry.bytes; remaining;) {
          const bytes = await read(Math.min(65536, remaining));
          hash.update(bytes);
          await output.writeFile(bytes);
          remaining -= bytes.length;
        }
        if (hash.digest("hex") !== entry.sha256)
          fail("SNAPSHOT_ENTRY_CHECKSUM_MISMATCH");
        await output.sync();
      } finally {
        await output.close();
      }
    }
    if (
      !(await read(snapshotEnd.length)).equals(Buffer.from(snapshotEnd)) ||
      offset !== before.size
    )
      fail("INCOMPLETE_SNAPSHOT");
    const after = await source.stat(),
      actualSha = whole.digest("hex");
    if (
      actualSha !== expectedSha256 ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      fail("SNAPSHOT_CHECKSUM_MISMATCH");
    const check = new DatabaseSync(stagedDb, { readOnly: true });
    let expected, liveIds, pendingIds, pluginLeaseIds, addedPluginTables;
    try {
      if (
        check.prepare("PRAGMA integrity_check").get().integrity_check !==
          "ok" ||
        check.prepare("PRAGMA foreign_key_check").all().length
      )
        fail("DATABASE_INTEGRITY_FAILURE");
      if (
        check.prepare("PRAGMA user_version").get().user_version !==
          manifest.schema ||
        check.prepare("SELECT id FROM runtime_identity WHERE singleton=1").get()
          ?.id !== manifest.serverId ||
        (check
          .prepare("SELECT seq FROM sqlite_sequence WHERE name='changes'")
          .get()?.seq ?? 0) !== manifest.cursor
      )
        fail("SNAPSHOT_METADATA_MISMATCH");
      const blobs = check
        .prepare(
          "SELECT digest, MIN(byte_length) AS bytes, MAX(byte_length) AS maxBytes FROM assets GROUP BY digest ORDER BY digest",
        )
        .all();
      if (
        blobs.length !== manifest.files.length - 1 ||
        blobs.some(
          (b, i) =>
            b.bytes !== b.maxBytes ||
            b.bytes !== manifest.files[i + 1].bytes ||
            b.digest !== manifest.files[i + 1].sha256,
        )
      )
        fail("SNAPSHOT_ASSET_INVENTORY_MISMATCH");
      liveIds = new Set(
        check
          .prepare("SELECT id FROM jobs WHERE state IN ('queued','running')")
          .all()
          .map((r) => r.id),
      );
      pendingIds = new Set(
        check
          .prepare(
            "SELECT id,job_id FROM job_interactions WHERE state='pending'",
          )
          .all()
          .filter((r) => liveIds.has(r.job_id))
          .map((r) => r.id),
      );
      const tableNames = new Set(
        check
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => row.name),
      );
      // Schema21 ->22 only adds empty plugin relations. Every preexisting
      // table/schema object still participates in the fidelity comparison.
      addedPluginTables = new Set(
        manifest.schema === 21
          ? PLUGIN_TABLES.filter((name) => !tableNames.has(name))
          : [],
      );
      pluginLeaseIds = new Set(
        tableNames.has("plugin_storage_namespaces")
          ? check
              .prepare(
                "SELECT id FROM plugin_storage_namespaces WHERE lease_token IS NOT NULL",
              )
              .all()
              .map((row) => row.id)
          : [],
      );
      expected = fingerprints(check, liveIds, pendingIds, manifest.cursor, {
        pluginLeaseIds,
      });
    } finally {
      check.close();
    }
    store = new EntityStore(stagedDb);
    const serverId = randomUUID();
    store.transaction(() => {
      store.db
        .prepare("UPDATE runtime_identity SET id=? WHERE singleton=1")
        .run(serverId);
      for (const jobId of liveIds) {
        const job = store.getJob(jobId);
        store.db
          .prepare(
            "UPDATE jobs SET state=?, owner=NULL, lease_until=NULL, fence=fence+1, result=?, updated_at=? WHERE id=?",
          )
          .run(
            job.cancelRequested ? "cancelled" : "interrupted",
            JSON.stringify({
              code: "BACKUP_RESTORED",
              message: "Restored unfinished job; automatic replay is disabled",
              mayHaveExternalEffects: true,
            }),
            store.now(),
            jobId,
          );
        interactions.closeJob(store, jobId, "backup-restored");
        store.jobEvent(store.getJob(jobId));
      }
      // Restored browser/native writer tokens cannot continue under a new
      // server authority. Keep graph data, revisions and commit proofs intact.
      for (const namespaceId of pluginLeaseIds)
        store.db
          .prepare(
            "UPDATE plugin_storage_namespaces SET writer_id=NULL,lease_token=NULL,lease_until=NULL,authority=NULL,fence=fence+1 WHERE id=?",
          )
          .run(namespaceId);
    });
    for (const name of addedPluginTables)
      if (
        store.db.prepare("SELECT COUNT(*) AS count FROM " + quoted(name)).get()
          .count !== 0
      )
        fail("SNAPSHOT_RESTORE_FIDELITY_FAILURE");
    const actual = fingerprints(
      store.db,
      liveIds,
      pendingIds,
      manifest.cursor,
      { pluginLeaseIds, excludeTables: addedPluginTables },
    );
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      fail("SNAPSHOT_RESTORE_FIDELITY_FAILURE");
    if (
      store.db.prepare("PRAGMA integrity_check").get().integrity_check !==
        "ok" ||
      store.db.prepare("PRAGMA foreign_key_check").all().length
    )
      fail("DATABASE_INTEGRITY_FAILURE");
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const restoredSchema = store.schemaVersion();
    store.close();
    store = null;
    await syncFile(stagedDb);
    await fs.mkdir(file + ".assets", { mode: 0o700 });
    createdAssets = await fs.lstat(file + ".assets");
    await fs.rename(blobDir, join(file + ".assets", serverId));
    publishedAuthority = serverId;
    await syncFile(file + ".assets");
    await syncFile(join(file + ".assets", serverId));
    // Atomic no-clobber publication; another process's destination is never replaced.
    await fs.link(stagedDb, file);
    published = true;
    await syncFile(dirname(file));
    const report = {
      restored: true,
      schema: restoredSchema,
      sourceSchema: manifest.schema,
      schemaMigrated: restoredSchema !== manifest.schema,
      serverId,
      sourceServerId: manifest.serverId,
      sourceCursor: manifest.cursor,
      backupSha256: actualSha,
      unfinishedJobsInterrupted: liveIds.size,
      pendingInteractionsClosed: pendingIds.size,
      pluginWriterLeasesReleased: pluginLeaseIds.size,
      assetBlobs: manifest.files.length - 1,
      comparedTables: Object.keys(actual.tables).length,
      untouchedDataIdentical: true,
      automaticExternalReplay: false,
    };
    await fs.writeFile(
      file + ".restore-report.json",
      JSON.stringify(report, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await syncFile(file + ".restore-report.json");
    await syncFile(dirname(file));
    return report;
  } finally {
    store?.close();
    await source?.close();
    if (createdAssets && !published) {
      const current = await fs.lstat(file + ".assets").catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      // Remove only our authority from our directory; preserve any peer's additions.
      if (
        current?.dev === createdAssets.dev &&
        current?.ino === createdAssets.ino
      ) {
        if (publishedAuthority)
          await fs.rm(join(file + ".assets", publishedAuthority), {
            recursive: true,
            force: true,
          });
        await fs.rmdir(file + ".assets").catch((e) => {
          if (e.code !== "ENOTEMPTY" && e.code !== "ENOENT") throw e;
        });
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
module.exports = { restoreServerSnapshot, fingerprints };
if (require.main === module) {
  const [backup, file, expectedSha256] = process.argv.slice(2);
  restoreServerSnapshot({ backup, file, expectedSha256 })
    .then((report) => console.log(JSON.stringify(report)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          restored: false,
          code: error.code ?? "RESTORE_FAILED",
        }),
      );
      process.exitCode = 1;
    });
}
