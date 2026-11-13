# Bounded database initialization under concurrent first open

The pre-deployment Node24 run of frontend4d passed376/failed1. The existing real database-worker test failed in the EntityStore constructor with ERR_SQLITE_ERROR/SQLITE_BUSY5 at the initial PRAGMA configuration. The unchanged test also failed in a separate filtered process. The failed logs and candidate remain preserved;4d was never deployed.

EntityStore now opens/configures its connection through openDatabase. On primary SQLITE_BUSY only, it closes the failed connection, waits at most25ms per retry and tries again within a5second monotonic budget. The current SQLite busy timeout uses the remaining initialization budget; successful initialization restores the ordinary5000ms transaction wait. Other errors propagate immediately after cleanup. No schema, command, job, model request or user transaction is replayed.

The existing foreign_keys ON, journal_mode WAL and synchronous FULL remain. Schema21, DDL, command bodies, serialization and the native engine are unchanged. SQLite documents that WAL operations can still return SQLITE_BUSY; the limited setup retry addresses the observed constructor race, not every possible database error. See [SQLite WAL documentation](https://www.sqlite.org/wal.html).

New regressions start4 real workers on each of8 new databases and require one canonical result for the same durable command. A real held exclusive lock must exhaust a50ms test budget without partial writes, then recover with WAL/FULL/foreign keys and the normal wait policy. The original failing two-worker test remains unchanged. Final focused28, fresh Node22 backend379, application508+3existing skips and actual compiled production/group/variable UI3 pass. Target Node24 acceptance is recorded separately in the rollout receipt.

The frontend source, helper and native/entity/ordinary artifact hashes match the validated4d build, so its192 warm observations,19 UI checks, types0/0 and169-declaration audit are explicitly reused. No new frontend speed result is claimed after the initialization fix. See display-wire-sizing.md and database-initialization-validation.json.

Current and prior8d keep schema21 and the same command/data format. The authorized rollout proves both versions can open the copied production snapshot and preserves the live database on rollback. The user’s earlier first-visit DB errors and private Nexus gsub cause remain unconfirmed. No actual content/auth/model access or remote push is used. All15 original completion requirements remain active.

An intermediate Node22 run passed378/failed1 because a cached setup helper constructor bypassed the existing SQLite subclass fault injection in the real disk-full migration test. Store now passes its original captured DatabaseSync constructor explicitly; the fault injection and assertion remain unchanged. The failing log and final28-case focused recheck are retained. This was corrected before deployment.
