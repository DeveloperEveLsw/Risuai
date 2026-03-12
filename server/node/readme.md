# Risuai Node Server

> Warning: Node server may be deprecated in future versions, replaced with [Hono](https://hono.dev/) based server which could run in multiple environments including nodejs, deno, and serverless platforms such as Cloudflare Workers, Vercel Edge Functions, etc.

This is the Node.js server for Risuai, for self-hosting purposes, who want to run Risuai on their own server remotely, without using official server for privacy or other reasons.

## Storage backends

The Node server now supports two persistence backends without changing the frontend storage API:

- `file` (default): legacy filesystem-backed key/value storage under `save/`
- `postgres`: PostgreSQL-backed key/value storage for long-term migration

### PostgreSQL mode

```bash
export RISU_STORAGE_DRIVER=postgres
export RISU_DATABASE_URL=postgres://user:password@host:5432/risuai
pnpm runserver
```

This mode keeps the current `/api/read`, `/api/write`, `/api/list`, and `/api/remove` behavior intact, so the app's runtime `Database` schema and ecosystem imports remain compatible while persistence moves into PostgreSQL.

See `server/node/postgres/README.md` for the compatibility strategy and schema overview.
