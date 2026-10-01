# Risuai Node Server

> Warning: Node server may be deprecated in future versions, replaced with [Hono](https://hono.dev/) based server which could run in multiple environments including nodejs, deno, and serverless platforms such as Cloudflare Workers, Vercel Edge Functions, etc.

This is the Node.js server for Risuai, for self-hosting purposes, who want to run Risuai on their own server remotely, without using official server for privacy or other reasons.

Authenticated reads and writes under `assets/` are exempt from the shared
2,000-requests-per-minute limit so large character imports do not exhaust the
budget needed to save the character database. Device authentication, the 100 MB
request body limit, and disk quotas still apply. Other requests retain their
existing rate limits. If a storage write receives HTTP 429 from an older server
or a proxy, the client shares the `Retry-After` cooldown across pending writes
and retries up to three times; without a valid header it waits 60 seconds.
