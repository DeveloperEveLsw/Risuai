# Compound group interruption and queued recovery

The group engine can make several provider calls inside one job. A first member may finish and change private variables while the next member is still streaming. The existing supervisor/fencing contract must therefore protect the entire group batch, rather than treating the first completed response as saved conversation state.

This follow-up adds actual process/database/browser acceptance for that boundary. It does not change production execution code. The checks confirm the existing atomic transaction and interrupted-job behavior after the original group generation/reroll fixes.

## Verified boundaries

A real scheduler stops during a two-member send. Its first response has passed original output processing and its second response is partial. The durable checkpoint retains the user input and both assistant messages, with their stable IDs and provider-call count. Canonical messages and variables remain unchanged. A queued same-chat command remains queued.

The database client is closed and reopened through a new DB worker. The interrupted job and checkpoint survive exactly. Resubmitting either immutable request ID recovers its existing state. Attempts using the old worker's owner/fence cannot write another progress record or final transaction. A new scheduler executes the queued command once, making two new synthetic calls. Only that queued turn becomes three canonical messages; its member variables are each one, proving that provisional effects from the interrupted turn did not leak. Synthetic individual member archives remain intact.

The built original UI check separately kills the actual native process during a compound reroll. Both browsers already display a complete confirmed batch plus two provisional replacement replies. The first new member has finished; the second is streaming. After the crash, the original confirmed batch and variables remain on disk, each original DOM row stays connected and unchanged in both browsers, provisional rows disappear, and the runtime status visibly reports `Job interrupted`. All tabs and the local service then close. Reopening the service and two authenticated contexts restores the same confirmed IDs and interrupted checkpoint, with no repeated request and no browser runtime exception. This browser sequence makes six synthetic calls total, including its earlier send and successful reroll.

The backend suite passes 237 tests, including 12 native group cases. Type checking reports zero errors/warnings, and the extended built browser case passes. The only initial fixture failure assumed progress held only assistant replies; a new send also includes its newly admitted user row. The corrected test distinguishes roles while retaining the complete checkpoint. The failed attempt remains evidence, not a passing regression.

The application source, native host and web source are unchanged from 467723a. Their prior 431 passing application tests/three existing skips, native/entity/ordinary builds and 168-declaration audit remain the verified source baseline. This follow-up reuses those exact build artifacts rather than claiming fresh application/build/audit runs. Artifact/source/log hashes and check accounting are in [group-recovery-validation.json](group-recovery-validation.json) and root `evidence/local-group-recovery-20261004.json` / `evidence/local-group-recovery-logs/`.

## Recovery limits

Subsequent [incarnation guards](incarnation-guards-runtime.md) validate loaded character lifetime and bookkeeping target lifetime before final writes. Same-incarnation read revision policy and explicit retained-output recovery remain separate requirements. The remaining-boundary paragraph below records this earlier recovery-test milestone.

Queued commands can execute after restart because their provider call has not begun. Interrupted calls remain terminal and are never automatically replayed: a remote provider may have received or completed them even when the local process died. Retained checkpoints are diagnostic/recovery source data; they are not a resumed provider stream or an automatic partial conversation commit. An explicit user-facing choose/copy/retry flow for retained group replies remains unfinished.

These checks cover scheduler shutdown, native process `SIGKILL`, DB-worker reopen and orderly local service restart. They do not test a machine power failure, abrupt supervisor death with an orphaned connection, prolonged disk failure or a physical mobile device. Original previous/next variants, automode, empty/inactive/orphan groups, member definition read dependencies, arbitrary history-rewriting extensions and representative latency/long tasks remain required.

Use a disposable synthetic DB for a local trial. Hold the second reply of a two-member group, restart the local service and check the interrupted status and retained old batch on two profiles. A queued turn should execute once after restart. Inspect retained progress separately; do not treat it as confirmed chat history. All 15 completion requirements and the active goal remain unchanged. No production access, private-content read, deployment, remote push or real provider call occurred.
