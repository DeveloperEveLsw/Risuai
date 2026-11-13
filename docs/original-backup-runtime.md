# Coherent original data backup from server storage

Later local follow-up: [server data snapshots](server-snapshot-runtime.md) adds a separate `.risusnapshot` for full schema21 runtime tables and registered assets. It preserves the operational state omitted by the original-compatible format below, with fresh authority and no automatic unfinished-job replay. Offline restore and host/device exclusions are explicit; all15 conditions remain active.

The original dataset and local-backup entry points now read a detached complete server archive in entity mode. They include unopened characters and earlier messages without loading them into browser DBState. This is a local milestone; all 15 completion requirements remain active.

## Reproduced problem

The actual original UI fixture contains two characters, three chats and 213 messages, with server-only PNG and WAV assets. Initially the browser loads 100 messages for one character and only the other character's summary. The unchanged original dataset exports one record with 100 messages; the original backup also contains 100 messages and no assets. The baseline assertion fails on these omissions.

With this change, the same original entry points export three records with 210/1/2 messages and write all 213 messages plus both assets. The second character remains unopened in that browser; both device contexts keep their existing partial state, textarea node and unsent input. Stable IDs and unknown fields survive a complete original-writer → inventory CLI → restore CLI → fresh SQLite reconstruction comparison.

## Contract

| Boundary         | Behavior                                                                                                                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture          | Dedicated read-only worker pins one SQLite WAL snapshot, reads all original data and immutable asset metadata, and closes its database before network draining. Peer commits cannot mix old and new records in this capture.                                                                        |
| Reconstruction   | Includes definitions/groups/trash, ordered modules/presets/personas/plugins, root/chat globals, script variables, chat metadata/bookmarks, complete message history, statistics/activity and unknown JSON fields. Original cold-storage placeholders are not emitted.                               |
| Normal UI        | Never installs this full value in DBState or the confirmed browser projection. Ordinary bootstrap/pagination/commands keep their existing partial protocols.                                                                                                                                        |
| Pending edits    | Local unresolved outbox entries and field/variable/group drafts reject export; optimistic values cannot silently masquerade as committed backup data.                                                                                                                                               |
| Full backup      | Original compression and LocalWriter framing; original account exclusion retained. Includes every registered immutable asset, conservatively including unused blobs. Missing referenced assets or changed downloaded bytes fail. Database entry is written only after all selected assets validate. |
| Partial backup   | Existing two confirmations; all original data but only main character/user/persona/preset/folder images. Extra audio/images remain intentionally excluded and their references remain in the data, as in the original partial format.                                                               |
| Limits           | One concurrent archive capture, 128 MiB JSON limit, 512 MiB worker old-generation heap, 32K UTF-16 response chunks with backpressure; asset/database backup entries ≤64 MiB. These are explicit operation limits, not a global storage budget or constant-memory reconstruction.                    |
| Failure/lifetime | Wrong authority, unavailable data, additional settings without an original-format slot, oversize, disconnect and shutdown fail explicitly; the export slot is released. File-picker cancellation clears the loading alert.                                                                          |
| Restore          | Offline into a new destination. Immutable `SHA.extension` files retain media MIME; aliases sharing a digest reuse one blob. Missing non-PNG references also reject restoration.                                                                                                                     |

Byte digests are checked after downloading each asset. A same-length corrupted stored PNG aborts the actual writer, raises an error and produces no database entry. Missing inline WAV metadata rejects before opening the writer. A partially written download may still exist after an error; it must not be treated as a complete backup.

## Local trial and restoration

From this checkout, start an isolated local database with Node 22.12+ and installed project dependencies:

```bash
pnpm build:native
RISU_RUNTIME_DATABASE=/tmp/risu-original-backup-trial.sqlite node server/runtime/develop.cjs
```

Open `http://127.0.0.1:5174`, use neutral trial data and the original full-backup or dataset actions. This change has not been deployed to the hosted service. Export captures committed data at one cursor; later server changes require another backup.

Inspect an exported full `.bin` without decoding its contents:

```bash
node server/runtime/inventoryBackup.cjs /path/to/full-backup.bin /path/to/new-inventory.json
```

The command reports `backupSha256` and `inventorySha256`. Pass those exact values to the restore CLI and choose a new destination:

```bash
node server/runtime/restoreBackup.cjs /path/to/full-backup.bin /path/to/new-inventory.json /path/to/new-restored.sqlite BACKUP_SHA256 INVENTORY_SHA256
```

Both commands refuse existing destinations. The inventory uses bounded byte reads, a 100,000-entry limit and framing/hash checks. It does not inspect prompts, scripts or messages. The restore report compares normalized data and checks SQLite integrity. A partial backup with omitted referenced assets cannot satisfy the full-restore contract; keep a full backup for restoration.

## Evidence and remaining scope

See [the validation receipt](original-backup-validation.json) and `server/browser/fullBackupUi.test.cjs`. New backend tests cover pinned-WAL peer commits, resource/variable/bookmark/group/unknown preservation, identity/size failures, backpressure, busy/disconnect/shutdown cleanup, Unicode and HTTP identity. Existing original archive/library/lifecycle regressions also run.

This original-compatible format does not contain server job/command receipts, retained failed results, inactive reply-choice/reply-batch history, revision/tombstone/change-log state or the database authority. It is not a complete server operational snapshot. Additional settings records explicitly reject rather than disappear. Versioned operational-state import/export, online restore, reference lifetime/GC, opaque asset aliases, arbitrary extension fidelity, total storage budgets, file-picker/device acceptance and the full configured trial remain necessary. Snapshot reconstruction, browser JSON parsing and original backup compression still allocate and can take time during explicit export. No representative export latency or physical-mobile measurement is claimed; existing ordinary UI stutter remains a separate active task.

Only public code and authored neutral fixtures were used in this continuation. No production connection/read, deployment, restart, remote push or actual model request occurred.
