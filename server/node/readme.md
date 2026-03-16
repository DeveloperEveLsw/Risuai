# Risuai Node Server

> Warning: Node server may be deprecated in future versions, replaced with [Hono](https://hono.dev/) based server which could run in multiple environments including nodejs, deno, and serverless platforms such as Cloudflare Workers, Vercel Edge Functions, etc.

This is the Node.js server for Risuai, for self-hosting purposes, who want to run Risuai on their own server remotely, without using official server for privacy or other reasons.

## Storage

The node server now supports two persistence drivers:

- `postgres`: recommended default for self-hosting
- `fs`: legacy `/save` file storage

### Environment Variables

- `RISU_STORAGE_DRIVER=postgres|fs`
- `DATABASE_URL=postgresql://user:password@host:5432/dbname`
- `RISU_STORAGE_IMPORT_FROM_SAVE=true|false`

When `postgres` is enabled, the server will create its storage tables automatically and can import the legacy `/save` directory once on first boot.

## Relational State

With `postgres`, the node server now persists application state in normalized tables instead of treating `database.bin` as the primary source of truth.

Current relational tables include:

- `risu_app_settings`
- `risu_personas`
- `risu_bot_presets`
- `risu_modules`
- `risu_characters`
- `risu_character_chat_folders`
- `risu_character_chats`
- `risu_chat_messages`
- `risu_lorebooks`
- `risu_character_assets`

Compatibility snapshots are still written for backup and recovery, but the node server can now read and write the relational model directly through:

- `GET /api/db/export`
- `POST /api/db/import`
