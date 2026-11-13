"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { EntityStore } = require("./store.cjs");
const storage = require("./pluginStorage.cjs");
const { SUPPORTED_RELEASES } = require("../native/wygloreContract.cjs");

// Only the author's immutable public artifacts are read. Tests never download
// code, run the plugin, or inspect production storage/provider credentials.
const releases = ["3.1.6", "3.2.0"].map((version) => {
  const release = SUPPORTED_RELEASES.find((entry) => entry.version === version);
  const file = join(
    __dirname,
    "../../.local-runtime/public-plugins/wyglore-leaf",
    version,
    "WygLoreLeaf-latest.js",
  );
  return { ...release, file };
});
const available = releases.every((release) => existsSync(release.file));
const actual = {
  skip: available ? false : "Fetch both pinned public WygLore fixtures first",
};
const scripts = available
  ? releases.map((release) => {
      const source = readFileSync(release.file, "utf8");
      assert.equal(
        createHash("sha256").update(source).digest("hex"),
        release.sha256,
      );
      return source;
    })
  : [];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "risu-plugin-upgrade-"));
  let now = 1000;
  const store = new EntityStore(join(directory, "state.sqlite"), {
    now: () => now,
  });
  store.initializeState({ settings: {}, resources: [] });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const pluginId = "synthetic-wyglore-upgrade";
  const namespaces = releases.map((release) => ({
    pluginId,
    bundleSha: release.sha256,
    pluginEpoch: 0,
  }));
  const install = (index, expectedRevision = index) =>
    store.applyCommand(`install-${index}-${expectedRevision}`, {
      type: "put-resource",
      kind: "plugin",
      resourceId: pluginId,
      expectedRevision,
      payload: {
        name: releases[index].name,
        script: scripts[index],
        version: "3.0",
        enabled: true,
      },
    });
  install(0);
  const claim = (
    index = 1,
    writerId = "new-browser",
    namespace = namespaces[index],
  ) =>
    store.claimPluginStorage({
      namespace,
      writerId,
      authority: { kind: "browser" },
    });
  const row = (index = 1) =>
    store.db
      .prepare(
        "SELECT * FROM plugin_storage_namespaces WHERE plugin_id=? AND bundle_sha=? AND plugin_epoch=0",
      )
      .get(pluginId, releases[index].sha256);
  const items = (index = 1) => {
    const namespace = row(index);
    return namespace
      ? store.db
          .prepare(
            "SELECT key,value,value_bytes,revision FROM plugin_storage_items WHERE namespace_id=? ORDER BY key",
          )
          .all(namespace.id)
          .map((item) => ({ ...item }))
      : [];
  };
  const commits = (index = 1) => {
    const namespace = row(index);
    return namespace
      ? store.db
          .prepare(
            "SELECT * FROM plugin_storage_commits WHERE namespace_id=? ORDER BY commit_id",
          )
          .all(namespace.id)
      : [];
  };
  function seed({ active = false } = {}) {
    const lease = claim(0, "old-browser");
    store.commitPluginStorage({
      lease,
      expectedRevision: 0,
      commitId: "old-checkpoint",
      writes: [
        {
          key: "wl.llm.config",
          value: {
            apiKey: "synthetic-credential",
            endpoint: "https://invalid.example",
          },
        },
        { key: "wl.settings.v1", value: { language: "ja", threshold: 0.7 } },
        {
          key: "wl.web.v1.synthetic",
          value: {
            version: 3,
            units: [{ id: "synthetic-unit", text: "Synthetic graph" }],
            commitLog: [],
          },
        },
        { key: "deleted-key", value: "synthetic-deleted" },
      ],
    });
    store.commitPluginStorage({
      lease,
      expectedRevision: 1,
      commitId: "old-deletion",
      writes: [{ key: "deleted-key", deleted: true }],
    });
    // Noncanonical but valid stored JSON proves the upgrade never reserializes.
    const opaque = '{ "apiKey": "synthetic-credential", "spacing": [1,  2] }';
    store.db
      .prepare(
        "UPDATE plugin_storage_items SET value=?,value_bytes=? WHERE namespace_id=? AND key='wl.llm.config'",
      )
      .run(opaque, Buffer.byteLength(opaque), row(0).id);
    if (!active) store.releasePluginStorage(lease);
    return lease;
  }
  return {
    store,
    namespaces,
    install,
    claim,
    row,
    items,
    commits,
    seed,
    time: (value) => {
      now = value;
    },
  };
}

test(
  "reviewed upgrade copies settings, opaque credentials, graph and tombstones without changing original bytes or receipts",
  actual,
  (t) => {
    const f = fixture(t);
    f.seed();
    const before = {
      namespace: f.row(0),
      items: f.items(0),
      commits: f.commits(0),
    };
    f.install(1);
    const lease = f.claim();
    assert.equal(lease.revision, 1);
    assert.equal(lease.fence, 1);
    assert.notEqual(lease.token, before.namespace.lease_token);
    assert.deepEqual(
      f.items(),
      before.items.map((item) => ({ ...item, revision: 1 })),
    );
    assert.equal(
      f.items().every((item) => item.revision === lease.revision),
      true,
    );
    assert.deepEqual(f.commits(), []);
    assert.deepEqual(
      { namespace: f.row(0), items: f.items(0), commits: f.commits(0) },
      before,
    );
    assert.equal(
      f.store.readPluginStorage(f.namespaces[1], "wl.settings.v1").value
        .language,
      "ja",
    );
    assert.throws(() => f.store.readAllPluginStorage(f.namespaces[0]), {
      code: "PLUGIN_NAMESPACE_CHANGED",
    });
  },
);

test(
  "upgrade is copy-once across repeated claims and does not restore later-deleted keys",
  actual,
  (t) => {
    const f = fixture(t);
    f.seed();
    f.install(1);
    const lease = f.claim();
    const repeated = f.claim();
    assert.deepEqual(repeated, lease);
    f.store.commitPluginStorage({
      lease,
      expectedRevision: 1,
      commitId: "new-deletion",
      writes: [{ key: "wl.llm.config", deleted: true }],
    });
    f.store.releasePluginStorage(lease);
    assert.equal(f.claim(1, "next-browser").revision, 2);
    assert.equal(
      f.store.readPluginStorage(f.namespaces[1], "wl.llm.config").found,
      false,
    );
  },
);

test(
  "any target revision, item, tombstone or commit prevents merging or overwriting",
  actual,
  async (t) => {
    for (const kind of ["revision", "item", "tombstone", "commit"]) {
      await t.test(kind, (t) => {
        const f = fixture(t);
        f.seed();
        f.install(1);
        const newId = createHash("sha256")
          .update(
            JSON.stringify({
              bundleSha: f.namespaces[1].bundleSha,
              pluginEpoch: 0,
              pluginId: f.namespaces[1].pluginId,
            }),
          )
          .digest("hex");
        f.store.db
          .prepare(
            "INSERT INTO plugin_storage_namespaces(id,plugin_id,bundle_sha,plugin_epoch,revision) VALUES (?,?,?,?,?)",
          )
          .run(
            newId,
            f.namespaces[1].pluginId,
            f.namespaces[1].bundleSha,
            0,
            Number(kind === "revision"),
          );
        if (kind === "item" || kind === "tombstone") {
          const value = kind === "item" ? '"synthetic-new"' : null;
          f.store.db
            .prepare(
              "INSERT INTO plugin_storage_items(namespace_id,key,value,value_bytes,revision) VALUES (?,?,?,?,1)",
            )
            .run(
              newId,
              "existing",
              value,
              value ? Buffer.byteLength(value) : 0,
            );
        }
        if (kind === "commit")
          f.store.db
            .prepare(
              "INSERT INTO plugin_storage_commits(namespace_id,commit_id,request_hash,result,created_at) VALUES (?,?,?,?,?)",
            )
            .run(newId, "existing", "synthetic-hash", "{}", 1000);
        const before = {
          items: f.items(),
          commits: f.commits(),
          revision: f.row().revision,
        };
        f.claim();
        assert.deepEqual(
          {
            items: f.items(),
            commits: f.commits(),
            revision: f.row().revision,
          },
          before,
        );
      });
    }
  },
);

test(
  "different plugin incarnation does not inherit an older namespace",
  actual,
  (t) => {
    const f = fixture(t);
    f.seed();
    f.store.db
      .prepare("DELETE FROM resources WHERE kind='plugin' AND id=?")
      .run(f.namespaces[0].pluginId);
    f.store.db
      .prepare(
        "INSERT INTO entity_tombstones(kind,scope,id,revision) VALUES ('resource','plugin',?,2)",
      )
      .run(f.namespaces[0].pluginId);
    f.install(1, 2);
    const namespace = { ...f.namespaces[1], pluginEpoch: 2 };
    const lease = f.claim(1, "new-incarnation", namespace);
    assert.equal(lease.revision, 0);
    assert.deepEqual(f.store.readAllPluginStorage(namespace).items, []);
    assert.equal(f.items(0).length, 4);
  },
);

test(
  "new claimed hash must match the actually installed source before any copy",
  actual,
  (t) => {
    const f = fixture(t);
    f.seed();
    assert.throws(() => f.claim(), { code: "PLUGIN_NAMESPACE_CHANGED" });
    assert.equal(f.row(), undefined);
    f.install(1);
    assert.throws(
      () =>
        f.claim(1, "forged", { ...f.namespaces[1], bundleSha: "f".repeat(64) }),
      { code: "PLUGIN_NAMESPACE_CHANGED" },
    );
    assert.equal(f.row(), undefined);
  },
);

test(
  "active old writer blocks upgrade until expiry and its old lease is never copied",
  actual,
  (t) => {
    const f = fixture(t);
    const oldLease = f.seed({ active: true });
    const before = f.row(0);
    f.install(1);
    assert.throws(() => f.claim(), { code: "PLUGIN_STORAGE_BUSY" });
    assert.equal(f.row(), undefined);
    assert.deepEqual(f.row(0), before);
    f.time(oldLease.expiresAt + 1);
    const newLease = f.claim();
    assert.equal(newLease.revision, 1);
    assert.notEqual(newLease.token, oldLease.token);
    assert.deepEqual(f.row(0), before);
  },
);

test(
  "source storage byte accounting is checked before creating a target",
  actual,
  (t) => {
    const f = fixture(t);
    f.seed();
    f.store.db
      .prepare(
        "UPDATE plugin_storage_items SET value_bytes=value_bytes+1 WHERE namespace_id=? AND value IS NOT NULL",
      )
      .run(f.row(0).id);
    f.install(1);
    assert.throws(() => f.claim(), { code: "PLUGIN_STORAGE_LIMIT" });
    assert.equal(f.row(), undefined);
  },
);

test(
  "an empty active target keeps its revision-zero snapshot until its writer releases",
  actual,
  (t) => {
    const f = fixture(t);
    f.install(1);
    const emptyLease = f.claim();
    assert.equal(emptyLease.revision, 0);
    f.install(0, 2);
    f.seed();
    f.install(1, 3);
    const before = f.row();
    assert.throws(() => f.claim(), { code: "PLUGIN_STORAGE_BUSY" });
    assert.deepEqual(f.row(), before);
    assert.deepEqual(f.items(), []);
    f.store.releasePluginStorage(emptyLease);
    assert.equal(f.claim().revision, 1);
    assert.equal(f.items().length, 4);
  },
);

test(
  "claim failure rolls back copied rows, new namespace and invalidations together",
  actual,
  (t) => {
    const f = fixture(t);
    f.seed();
    f.install(1);
    const cursor = f.store.cursor();
    const source = {
      namespace: f.row(0),
      items: f.items(0),
      commits: f.commits(0),
    };
    f.store.db.exec(
      `CREATE TRIGGER reject_upgrade_claim BEFORE UPDATE OF writer_id ON plugin_storage_namespaces WHEN NEW.bundle_sha='${releases[1].sha256}' BEGIN SELECT RAISE(ABORT,'synthetic claim failure'); END`,
    );
    assert.throws(() => f.claim(), /synthetic claim failure/);
    assert.equal(f.row(), undefined);
    assert.equal(f.store.cursor(), cursor);
    assert.deepEqual(
      { namespace: f.row(0), items: f.items(0), commits: f.commits(0) },
      source,
    );
    f.store.db.exec("DROP TRIGGER reject_upgrade_claim");
    assert.equal(f.claim().revision, 1);
  },
);
