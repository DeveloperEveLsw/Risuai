# Server-Owned Generation And Live State Plan

## Goal

Satisfy these requirements together:

1. AI request lifecycle is owned by the server, not by the browser UI.
2. Multiple devices for the same account see the same generation state nearly in real time.
3. Concurrent reads, writes, partial outputs, and reconnects do not corrupt chat state.
4. Existing RisuAI data shapes, plugins, modules, and import/export flows remain as compatible as practical.

This plan is implementation-oriented. It is not a vague direction document.

## Implementation Checklist

### Planning and boundaries

- [x] define that `database.bin` is no longer the live authoritative source in server mode
- [x] define server-owned jobs, live chat documents, and chat revision control
- [x] define first transport direction as REST + SSE
- [x] define first compatibility mode as client-prepared and server-executed

### Server persistence foundation

- [x] extend PostgreSQL schema for live generation metadata
- [x] add live document repository for JSON document reads/writes
- [x] add generation job repository for jobs and ordered events
- [x] add in-process live event hub for SSE fan-out
- [x] add generation runner foundation for server-owned execution

### Server APIs

- [x] add `POST /api/generation-jobs`
- [x] add `GET /api/generation-jobs`
- [x] add `GET /api/generation-jobs/:jobId`
- [x] add `GET /api/generation-jobs/:jobId/events`
- [x] add `POST /api/generation-jobs/:jobId/cancel`
- [x] add `GET /api/live/events`
- [x] add `GET /api/live/chats/:chatKey`
- [x] add `GET /api/live/chats`
- [x] add `PATCH /api/live/chats/:chatKey`
- [x] add `GET /api/live/root`
- [x] add `GET /api/live/characters/:characterKey`

### Frontend plumbing

- [x] add authenticated Node-server client helpers for live APIs
- [x] add client-side live SSE subscription parsing
- [x] add startup overlay of live chat documents onto `DBState`
- [x] add startup load of active server generation jobs
- [x] route stop/cancel from the chat UI to server jobs when present
- [x] add first `sendChat()` submit path for server-owned jobs using prepared provider request payload

### Still required for full requirement completion

- [x] replace the most user-visible `doingChat` assumptions with per-chat streaming state in the main chat UI
- [x] surface running/completed/cancelled status in the chat list and current chat area
- [x] support reconnect/resume UX for active jobs and live chat overlays on app load
- [x] add live subscription auto-reconnect for long-lived sessions
- [x] harden optimistic concurrency conflict handling for generation submit paths beyond first retry
- [x] harden optimistic concurrency conflict handling for normal chat edits outside generation
- [x] project live chat state back into compatibility snapshots before `database.bin` save
- [x] add server-mode policy for unsupported providers and unsupported plugin-trigger combinations
- [x] add broader provider support beyond the first OpenAI-compatible path
- [x] add verification coverage for refresh, cancel, duplicate submit, and multi-device synchronization

## Product Requirements To Preserve

### 1. Server-owned request lifecycle

- sending a request must create durable server state
- generation must continue if the browser tab reloads, closes, or navigates elsewhere
- the user must be able to return later and see whether the request is:
  - queued
  - running
  - completed
  - failed
  - cancelled
- stop/cancel must work against the server-owned job, not against a component-local abort controller

### 2. Multi-device shared state

- if mobile starts a generation, PC must observe the same running state
- partial output and final output must propagate to all active devices on the same account
- request state cannot be device-local; it must be account-scoped or server-session-scoped

### 3. Stability under concurrency

- no blank overwrite of chat state
- no lost user message or lost assistant message
- no duplicate final assistant message after reconnect or retry
- partial output, cancellation, reconnect, and concurrent viewing must not corrupt data

### 4. Compatibility

- keep current `Database`, `character`, `Chat`, and `Message` shapes as long as possible
- preserve existing import/export around `database.bin`
- avoid breaking plugins/modules unless there is no safe alternative
- do not require a full rewrite of the application

## Current Architecture Reality

Today:

- browser UI starts generation
- `sendChat()` orchestrates request preparation, request dispatch, stream consumption, and `DBState` mutation
- cancellation is tied to a local `AbortController`
- `saveDb()` writes `database.bin` as a whole-file snapshot
- load path reconstructs state by reading `database.bin`
- Node server is currently a storage/proxy server, not the authoritative generation owner

Important consequence:

- a browser-owned stream and a whole-file `database.bin` write model cannot satisfy the multi-device stability requirement at the same time

## Main Design Decision

Do not make `database.bin` the live authoritative state for server mode.

Instead:

- keep `database.bin` for compatibility, backup, import/export, and migration
- move live authoritative state for server mode into server-side documents and job tables
- treat browser `DBState` as a cache/render model, not as the source of truth for active server-owned chats

This is the only realistic way to satisfy:

- persistent server-owned generation
- multi-device live visibility
- concurrency safety

without repeatedly overwriting the entire save blob from multiple clients.

## What `database.bin` Becomes

In server mode, `database.bin` should become:

- compatibility snapshot
- backup artifact
- import/export payload
- legacy restore source

It should not remain the primary write target for:

- generation progress
- partial outputs
- active chat concurrency
- cross-device authoritative chat state

## Target Architecture

### Authoritative state split

Server becomes authoritative for:

- generation jobs
- generation events
- live chat documents
- chat revision numbers
- account/device subscriptions

Browser remains authoritative for:

- ephemeral UI-only state
- viewport state
- input box contents
- local rendering preferences

### Live state storage model

Use PostgreSQL as the authoritative backend for server mode.

Keep:

- `risu_generation_jobs`
- `risu_generation_job_events`
- `risu_documents`
- `risu_chat_sessions`

Use them as follows:

- `risu_generation_jobs`: one row per generation request
- `risu_generation_job_events`: ordered durable event stream for a job
- `risu_documents`: compatibility-preserving JSON documents for live server-owned state
- `risu_chat_sessions`: optional session/account metadata for subscription and active state indexing

## Required Data Ownership Change

### New server-owned live documents

Do not normalize the entire application into dozens of tables immediately.

Instead, keep compatibility-first JSON documents in `risu_documents`, for example:

- `document_type = 'db_root'`
- `document_type = 'character'`
- `document_type = 'chat'`

This preserves existing shapes while avoiding whole-file overwrites.

Recommended document boundaries:

- one root document for account-wide settings that are not chat-hot
- one document per character/group
- one document per chat

The chat document is the critical boundary for concurrency control.

### Revision control

Every live document write must use optimistic concurrency.

Meaning:

- every chat document has a `revision`
- client/server writes must compare expected revision
- conflict must produce retry or merge behavior, never silent overwrite

## Generation Data Model

### `risu_generation_jobs`

Extend current job usage so each job records:

- `job_id`
- `account_id` or server namespace key
- `session_key`
- `character_id`
- `chat_document_key`
- `assistant_message_chat_id`
- `client_request_id`
- `status`
- `request_payload_version`
- `request_payload`
- `result_payload`
- `error_text`
- `cancel_requested_at`
- `created_at`
- `started_at`
- `finished_at`

### `risu_generation_job_events`

Use ordered durable events.

Initial event types:

- `job_created`
- `generation_started`
- `text_snapshot`
- `generation_completed`
- `generation_failed`
- `generation_cancelled`

Important note:

- prefer `text_snapshot` over ultra-granular token deltas for the first pass
- snapshots simplify resume, replay, and multi-device rendering
- the current client already works well with cumulative text

## API Direction

### Job API

Required endpoints:

- `POST /api/generation-jobs`
- `GET /api/generation-jobs/:jobId`
- `GET /api/generation-jobs/:jobId/events?after=<sequence>`
- `POST /api/generation-jobs/:jobId/cancel`
- `GET /api/generation-jobs?status=running`

### Live chat API

Required endpoints:

- `GET /api/live/chats/:chatKey`
- `PATCH /api/live/chats/:chatKey`
- `GET /api/live/characters/:characterKey`
- `GET /api/live/root`

### Subscription API

Required near-real-time transport:

- SSE first

Recommended endpoint:

- `GET /api/live/events`

SSE is sufficient for:

- job started
- job progress
- job completed
- job cancelled
- chat revision advanced

Use REST for submission and cancel.

## First Implementation Mode

### Compatibility mode: client-prepared, server-executed

Do not begin with full server-side prompt reconstruction.

First vertical slice should be:

- browser prepares the request payload using existing logic
- browser submits a durable generation job to the server
- server executes provider calls and owns the stream
- server updates live chat documents and job events
- all devices observe the same server-owned status and output

Reason:

- current prompt assembly, request triggers, and plugin hooks are deeply browser-coupled
- moving execution first gives the largest product win with the smallest architectural break

### What stays client-side in phase one

- prompt assembly
- request-time plugin transformations
- browser-only trigger types
- display/UI-only plugin logic

### What moves server-side in phase one

- job lifecycle
- provider execution for first supported provider path
- streaming ownership
- durable partial output
- final assistant message write into live chat document
- cancel semantics
- reconnect recovery

## Required Change To Submit Flow

The server submission path must be transactional.

On submit:

1. validate account/session identity
2. load target chat document with revision
3. append the user message if it is not already present
4. create or reserve the assistant placeholder message using deterministic `assistant_message_chat_id`
5. create the generation job row
6. commit
7. start the runner

This prevents:

- lost user message
- duplicate assistant placeholders
- ambiguous retry behavior

## Required Change To Finalization Flow

The server, not the browser, must finalize the assistant message in the live chat document.

That means:

- partial output should be visible from server state
- completion should advance chat revision
- all devices should see the same final assistant message

Browser can still cache or export later, but it must not be the only finalizer.

## Concurrency Rules

### Chat writes

Never blindly overwrite a full chat from a client snapshot in server mode.

Allowed write forms:

- append user message
- update assistant placeholder content
- finalize assistant message
- cancel running generation
- patch metadata with revision checks

### Idempotency

Every generation submit must include a stable client request identifier.

Recommended reuse:

- current generation UUID / message chatId semantics

Submit retry with the same idempotency key must not create a second assistant message.

### Active generation policy

First server-owned version should enforce:

- at most one active generation per chat

This is simpler and safer.

Later:

- allow multiple concurrent jobs across different chats if needed

## Multi-Device Synchronization Model

### Source of synchronization truth

Do not build this on top of the current PeerJS multiuser feature.

That feature is:

- room-scoped
- ephemeral
- browser-host-dependent
- not account-authoritative

Instead:

- use server-owned events per account or per authenticated namespace
- each device subscribes on app load
- devices update local render state from server events

### Required observed states

Every device must be able to observe:

- chat has active job
- job status changed
- new partial assistant content available
- job cancelled
- final assistant message committed

## Stability Guarantees Required Before Shipping

The implementation is not done unless these are true:

- closing the browser does not cancel a running generation
- opening another chat does not cancel or hide the running server job
- returning later shows the correct running/completed/cancelled state
- PC and mobile converge to the same assistant output
- no blank chat overwrite occurs under concurrent access
- reconnect does not duplicate the assistant message
- cancel is durable and remains visible after reload

## Compatibility Strategy

### Preserve existing JSON shapes

Preserve existing object shapes for:

- `Database`
- `character`
- `groupChat`
- `Chat`
- `Message`

This reduces migration cost for:

- plugins
- modules
- import/export
- existing rendering code

### Preserve existing import/export

Keep `database.bin` import/export support intact.

Migration path:

- import `database.bin`
- project it into live documents
- continue operating from live server documents
- export back to `database.bin` when needed

### Plugin and trigger compatibility

Do not attempt full plugin runtime migration in the first pass.

Instead classify behavior:

- safe to keep client-side:
  - display hooks
  - DOM plugins
  - browser-only module logic
- safe to support in compatibility mode:
  - prompt preparation hooks that execute before submit
- defer:
  - provider plugins that require browser-specific runtime
  - arbitrary server-side execution of unsafe plugin code

## Provider Strategy

Do not migrate all providers at once.

First supported server-owned provider path should be:

- one OpenAI-compatible path

Why:

- it covers the largest practical subset
- it is the easiest to implement safely on the server
- it minimizes scope while validating the architecture

Later:

- add more provider adapters incrementally

## Migration Phases

### Phase 0: Planning and boundaries

Done when:

- authoritative state ownership is explicitly defined
- `database.bin` is demoted to compatibility snapshot in server mode
- required tables and APIs are named

### Phase 1: Server-owned execution vertical slice

Goal:

- one provider path works end-to-end with durable jobs and live sync

Deliver:

- job submit API
- job status API
- job event API
- job cancel API
- SSE feed
- live chat document write path
- browser submit-and-observe flow

Keep:

- client-prepared request payload

### Phase 2: Resume and multi-device polish

Goal:

- server-owned jobs feel reliable across devices and reconnects

Deliver:

- active job discovery on app load
- chat list indicators for running jobs
- reconnect to active SSE
- durable cancelled/failed/completed state restoration

### Phase 3: Broader compatibility

Goal:

- minimize behavioral regressions for existing extensions

Deliver:

- documented compatibility matrix
- server-mode feature gating for unsafe plugins/providers
- incremental support for more providers

### Phase 4: Server-side preparation, later

Goal:

- remove the remaining browser dependency from prompt preparation

Deliver:

- extracted serializable preparation context
- server-safe prompt builder
- reduced client-prepared payload

This phase is explicitly later.

## Files Likely To Change

### Frontend

- `src/lib/ChatScreens/DefaultChatScreen.svelte`
- `src/ts/process/index.svelte.ts`
- `src/ts/process/request/request.ts`
- `src/ts/globalApi.svelte.ts`
- `src/ts/bootstrap.ts`
- new client modules for:
  - generation job submission
  - SSE subscription
  - live document sync
  - active job store

### Server

- `server/node/server.cjs`
- `server/node/postgres/schema.sql`
- `server/node/storage/postgresStorage.cjs`
- new modules for:
  - generation job repository
  - live document repository
  - generation runner
  - provider adapters
  - SSE/event hub
  - concurrency helpers

## Explicit Non-Goals For First Ship

- full server execution of all plugin logic
- full migration of every provider
- distributed workers
- perfect backward compatibility for browser-only provider plugins in server mode
- turning `database.bin` into the live concurrent state source

## Open Questions

- what is the first required provider path?
- do we need one active generation per chat only, or more?
- should account identity map to current account sync identity, node server identity, or both?
- when exporting, how much of live document state must round-trip into `database.bin` immediately?

## Recommended Answers

- first provider path: one OpenAI-compatible adapter
- active generation limit: one per chat for v1
- transport: SSE first
- identity: use account-scoped namespace where available; otherwise server-authenticated namespace
- export behavior: keep `database.bin` export/import, but do not block live mode on whole-file sync

## Final Working Principle

The implementation should follow one strict rule:

- make the server the owner of generation and live chat writes first

Do not spend the first implementation pass on:

- every provider
- every plugin edge case
- full server-side prompt reconstruction
- full import/export redesign

The first complete success condition is:

1. user submits a request
2. server creates a durable job
3. server owns the stream
4. server writes partial and final output into live chat state
5. other devices observe the same state
6. browser reload/close/reconnect does not break the lifecycle
