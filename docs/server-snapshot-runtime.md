# Server data snapshots and offline restoration

The original Settings → Account & Files page has a **Back up all server data** action in entity mode. Its `.risusnapshot` preserves the complete schema21 SQLite database and every registered immutable asset blob, including server jobs, retained provider outputs, response alternatives, command receipts, clocks and additional settings. It complements the original-compatible `.bin` backup. This is a local milestone; online restoration, whole-host backup, physical-device acceptance and all15 completion requirements remain active.

## Capture and transfer

A dedicated read-only worker begins a transaction and reads the authority to pin the source WAL state. Node's online backup copies that transaction to an owned temporary SQLite file. Asset inventory, schema and change cursor come from this same copied database. The source connection closes before network draining; subsequent peer writes are excluded. Asset blobs are immutable and conservatively retained, so aliases share one digest entry.

The binary format has an eight-byte `RISURT01` magic, a little-endian uint32 JSON manifest length, UTF-8 manifest, SQLite bytes followed by digest-named blob bytes, then an eight-byte `RTDONE01` completion marker and exact EOF. Version1 accepts schema21 only. Each entry includes its byte length and SHA-256. Restoration also requires the caller's whole-file SHA-256. A partial HTTP200 response is insufficient: browser validation checks entry hashes and the required end marker before closing the writer or showing success. The format is plain data and includes any credentials stored in the database; separate host authentication files are outside its scope.

| Boundary           | Contract                                                                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal application | No complete snapshot is installed in DBState; ordinary pagination and command protocols remain unchanged. Pending local outbox/field/variable/group edits reject capture. This checks the requesting device, not unsubmitted drafts on every other device.                      |
| Isolation          | One snapshot per service, separate from the original archive worker and command worker. Worker old-generation heap limit512MiB. Chunks up to64KiB are acknowledged only after the response write callback; browser writes are awaited too.                                      |
| Limits             | Raw DB8GiB, total entry data32GiB, manifest64MiB, up to200,000 distinct asset blobs, each≤64MiB. These are operation limits, not a global storage quota or space reservation. Browser request deadline1hour.                                                                    |
| Failure            | Wrong authority, size/inventory limits, missing/changed blob, disconnect and shutdown fail. Normal completion/error/disconnect/shutdown removes owned capture directories. Source data is unchanged.                                                                            |
| Browser memory     | Header plus incremental SHA state; file bodies are processed in chunks. The fallback LocalWriter backend can have its own buffering. Header parsing and hashing still run on the main thread; physical-mobile responsiveness and maximum-size transfers have not been measured. |

The implementation needs Node's `sqlite.backup`, introduced in22.16. It was exercised here with Node22.21.0; this milestone has no fresh Node24 run. See [Node's API documentation](https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options) and [SQLite's backup documentation](https://www.sqlite.org/backup.html). The pinned-WAL behavior was verified with an actual peer commit after capture starts, rather than assumed from the general backup API.

## Local trial

Use an isolated local database and authored neutral fixtures:

```bash
pnpm build:native
RISU_RUNTIME_DATABASE=/tmp/risu-server-snapshot-trial.sqlite node server/runtime/develop.cjs
```

Open `http://127.0.0.1:5174`, then Settings → Account & Files → Back up all server data. Finish pending changes first. Original settings navigation unmounts the chat screen; the separate mounted-chat export check confirms that the export operation itself retains both input nodes and unsent text. The peer's existing partial projection remains intact while the real Settings button downloads.

Compute a SHA-256 for the completed file, choose a **new** destination, and run:

```bash
sha256sum /path/to/risu-server-backup.risusnapshot
node server/runtime/restoreServerSnapshot.cjs /path/to/risu-server-backup.risusnapshot /path/to/new-restored.sqlite BACKUP_SHA256
```

The CLI stages files beside the destination, checks framing/hashes, SQLite integrity/foreign keys, database authority/schema/cursor and complete asset inventory. It refuses an existing database, `.assets` directory or `.restore-report.json`. Staged files use0600 permissions and directories0700. Database publication uses a no-clobber hard link on the same filesystem; the original running database is never a restore target. Run the isolated development server against the new file to inspect it.

## Restoration policy

The copied database keeps entity IDs, revisions, epochs, receipts, reply choices/batches, retained terminal results, unknown JSON and SQL tables. Before publishing, restoration assigns a **new server authority** so existing device outboxes cannot silently replay into a historical database. Queued/running jobs become `interrupted` or `cancelled` if cancellation was already recorded; ownership and lease clear, fence advances, and their pending interactions close. Progress and captured provider output remain available. No unfinished model or script invocation is automatically retried.

All table/schema fingerprints are compared before and after, excluding only the explicit authority/live-job/interaction policy changes and new change events. The synthetic fixture includes unknown tables with BLOBs, a64-bit integer, and reserved-looking names. This is table/schema preservation evidence, not a promise that arbitrary future schemas or SQL extensions are supported. A previously complete guarded failed write set can still be reviewed and recovered; incomplete results remain incomplete. Restoration cannot turn the earlier `RESULT_NOT_RECOVERABLE` job into a complete transaction.

The report records source/new identities, source cursor, file SHA, asset/table counts, interrupted jobs, closed interactions and fidelity verification. A failure after publishing the database but before report completion can leave a valid destination without a report; retry refuses that destination. Check it before choosing another path. Process crashes can leave owned staging directories or an unpublished asset directory; automatic crash-orphan reclamation and filesystem fault injection remain unfinished.

## Evidence and remaining work

See [the validation receipt](server-snapshot-validation.json), `server/runtime/serverSnapshot*.test.cjs` and `server/browser/serverSnapshotUi.test.cjs`. The real Settings writer → CLI → fresh database roundtrip preserves additional settings, retained failed output and reply alternatives. The restored original UI opens the saved result for review. Synthetic live/queued/cancelled jobs retain partial output and never execute after restoring and starting the scheduler. Missing/corrupt blobs cannot produce a completion marker; a same-length corrupt PNG aborts the actual browser writer. Backpressure, busy/identity/budgets, source peer writes, authentication, pending edits, cancellation and staging cleanup are checked.

Separate host password/session configuration, runtime code/configuration and browser/device outboxes are excluded. Registered assets are included; unregistered orphan files are not inventoried. This is offline restoration into a new database, not in-place online replacement or a complete host recovery procedure. Schema migration across snapshot versions, global disk/WAL/asset budgets and reservation, reference/GC policy, crash recovery, portable file pickers, unknown extension fidelity, representative latency/long tasks, real mobile and the configured whole trial remain active. No production access, deployment, private-content read, remote push or actual provider request occurred in this continuation.
