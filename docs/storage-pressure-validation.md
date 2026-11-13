# SQLite capacity pressure validation

Release preparation encountered actual `ENOSPC`. After preserving service/data and recovering duplicate public-release space, a new synthetic regression exercises real `SQLITE_FULL` rather than mocking a database exception. `PRAGMA max_page_count` fixes each private fixture at its existing page count; a larger authored value then requires more pages and fails with SQLite primary error 13.

| Boundary        | Failure and recovery oracle                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message command | No canonical message, chat revision or change cursor is partially committed. After raising the page limit, the same request commits once and replay returns the same receipt. Integrity and foreign keys remain valid.                  |
| Job admission   | Failed admission leaves no accepted job or change cursor. The same request can be admitted after capacity returns and replay creates no extra job.                                                                                      |
| Final result    | Failure leaves the job running and commits neither the final message, variable nor change cursor. A still-valid worker/fence can save the already-captured result after capacity returns. No provider request is repeated by this test. |

All three cases pass locally on Node 22 and in an isolated Node 24 container against the deployed `0913c0d` store code. Tests access only newly authored temporary databases. The production volume is never filled or given a page limit; no actual model request is sent.

This validates the entity transaction boundary. It does not establish automatic recovery of the complete scheduler/provider flow after a disk failure, available physical storage reservation, quota handling for assets/WAL/outbox/snapshots, or recovery after a worker lease expires. A captured final result in the test can be retried within its lease; a lost provider outcome must not be generated again automatically. Those storage-budget and lifecycle policies remain active work.

These are additional tests/documentation, not another runtime deployment. Original runtime code and all 15 acceptance conditions remain unchanged by this follow-up. The deployed revision stays `0913c0d`; the following source commit adds this regression and its report.
