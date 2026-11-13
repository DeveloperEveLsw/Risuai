# Historical server jobs

The original runtime status panel now offers **작업 기록 전체**. It reads one page of 20 job headers for the selected chat. **전체**, **재요약**, and **실패·취소·중단** filters support both directions and a refresh from the newest admitted job. An older summary can open the existing durable result editor; an older failed generation can open the retained-result review. This removes the recent-50 discoverability limit without downloading all results or keeping an ever-growing browser list.

The HTTP endpoint is `GET /api/runtime/chats/:id/job-history?expectedEpoch=…&filter=all|memory|failed&limit=20&after=…`. The API permits limits 1–100; the original UI fixes 20. It selects identifiers, type, state, timestamps, ownership/progress revisions and a result-present flag. It does not select/decode result, progress or command bodies. Individual result bodies are requested only after opening a result.

Three additive SQLite indexes cover chat incarnation, admission position and sparse memory/failed filters. They are installed after legacy job-table migration. Portable tables and schema version 21 remain unchanged. Page cursors bind database identity, chat ID/incarnation, filter, admission high-water mark, direction and anchor. New admissions appear on refresh rather than shifting previously issued page boundaries. Current job states are read at each request; this is not an immutable snapshot of states or failure-filter membership.

The dialog captures the selected chat/incarnation and the navigation generation. Closing aborts the request and clears the page; a delayed response is also ignored after closing, filter replacement, navigation away and back, or chat recreation. A failed read hides the old actionable rows and offers refresh. Opening one old job loads its status before opening the existing result component. Result application continues to use the existing server source/ownership guards and does not execute the provider again.

Local trial:

1. Run `pnpm trial:local` using the existing isolated-trial instructions in `docs/server-runtime-plan.md` and the local trial documentation. Use authored synthetic cards and a loopback provider for automated verification.
2. Select a conversation, open **작업 기록 전체**, choose a filter and navigate **이전 기록** / **더 최근 기록**. The original list can remain limited to the latest 50 jobs.
3. Open an older re-summary, review/edit/apply it, reload or use a second device, then reopen it. An already applied result must remain applied. Failed generation review must retain its explicit recovery/retry limits.
4. During a history read, close the dialog or switch conversations. A late response must not reopen a dialog or attach its rows to another conversation.

Verification commands:

```sh
pnpm check
pnpm exec vitest run src/ts/runtime/jobHistory.test.ts
node --test server/entity/jobHistory.test.cjs server/runtime/jobHistory.test.cjs server/entity/lifecycle.test.cjs
pnpm build:native
node --test server/browser/jobHistoryUi.test.cjs
node server/runtime/jobHistoryBenchmark.cjs
```

The browser fixture uses 137 authored jobs, two independent Chromium contexts and mobile emulation, one real native summary through an authored loopback HTTP provider, result application/reopen/reload and late-response checks. It does not use production data or a real model. The benchmark uses 10,000 authored jobs and retained synthetic bodies, measures head/middle/tail metadata pages, and reports its environment. Neither proves physical-mobile acceptance or completion of whole-application performance and compatibility. TTS additional development remains excluded; all original 15 requirements remain active.
