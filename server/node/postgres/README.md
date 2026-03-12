# PostgreSQL Storage

This directory contains the compatibility-first PostgreSQL storage layer for the Node server.

## Design rule

RisuAI's runtime object schema remains the source of truth.

- `Database`, `character`, `groupChat`, `botPreset`, `RisuPlugin` shapes must stay compatible with the existing app.
- PostgreSQL is the persistence layer, not a new app-level schema contract.
- Unknown extension fields, plugin storage, imported card metadata, and future ecosystem fields should be preserved losslessly in JSON payloads.

## Current scope

The first migration step keeps the existing `/api/read`, `/api/write`, `/api/list`, and `/api/remove` contract intact.

- `RISU_STORAGE_DRIVER=file`: keeps the legacy filesystem-backed key/value store.
- `RISU_STORAGE_DRIVER=postgres`: stores the same key/value payloads in PostgreSQL.

That means the frontend and import/export paths remain compatible while the backend is prepared for:

- durable chat/job state
- multi-device synchronization
- websocket fan-out
- resumable server-owned generations

## Environment

Set these before starting the Node server:

```bash
export RISU_STORAGE_DRIVER=postgres
export RISU_DATABASE_URL=postgres://user:password@host:5432/risuai
pnpm runserver
```

If `RISU_STORAGE_DRIVER` is unset, the server continues using the filesystem backend.

## Schema

`schema.sql` creates:

- `risu_kv_entries`: compatibility storage for the current binary save blobs
- `risu_documents`: JSONB payload storage for future compatibility-preserving document persistence
- `risu_assets`: metadata for externalized assets
- `risu_chat_sessions`: per-session state for multi-device sync
- `risu_generation_jobs`: durable server-side generation jobs
- `risu_generation_job_events`: ordered generation stream events
