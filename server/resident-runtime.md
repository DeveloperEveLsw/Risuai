# Server-resident RisuAI runtime

## Entry points

This deployment has two views of the same upstream RisuAI build:

- The normal public domain proxies host loopback port 6001. Each desktop or
  mobile browser renders the upstream UI and uses the same-origin database,
  generation, proxy-job, and WebSocket APIs.
- `risuai-runtime` permanently opens
  `http://risuai:6001/?risu-runtime=executor`. It owns the single global
  generation lease and executes prompt assembly, Lua, plugins, provider calls,
  post-processing, and saves after public browsers disconnect.
- The full-runtime compatibility fallback exposes that Chromium desktop on
  host port 6002 (`https://SERVER:6002/`). `/full` is only the mode name; no
  literal `/full` route is installed on the public port. It is an
  administrative/compatibility view, not the normal public UI.

The public reverse proxy must preserve the same origin and WebSocket upgrades
for `/api/sync/database/ws`, `/runtime-generations/*/ws`, and
`/proxy-stream-jobs/*/ws`. Do not publish the Node application's port 6001
directly to the LAN; Compose binds it to host loopback.

## Persistent state

- `risuai-save` contains the canonical opaque RisuSave, assets, database
  revision/conflict metadata, durable generation commands/events, raw proxy
  jobs, the Node password, and trusted device public keys.
- `risuai-runtime-profile` contains Chromium's profile, its Node authentication
  key, resident-only browser/plugin storage, and UI preferences.

Back up both volumes as one stopped-state set. A consistent example from the
Compose directory is:

```bash
backup_dir="$PWD/backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
docker compose stop
trap 'docker compose start' EXIT
docker run --rm -v risuai_risuai-save:/source:ro -v "$backup_dir":/backup alpine \
  sh -c 'cd /source && tar -czf /backup/risuai-save.tgz .'
docker run --rm -v risuai_risuai-runtime-profile:/source:ro -v "$backup_dir":/backup alpine \
  sh -c 'cd /source && tar -czf /backup/risuai-runtime-profile.tgz .'
tar -tzf "$backup_dir/risuai-save.tgz" >/dev/null
tar -tzf "$backup_dir/risuai-runtime-profile.tgz" >/dev/null
docker compose start
trap - EXIT
```

Store a copy of `.env`, the deployed Git commit, and the application/browser
image identifiers with the archives. Protect the archive because it contains
provider credentials, chats, and authentication material.

## Start and access

1. Copy `.env.example` to `.env`. Set a long random
   `RISU_RUNTIME_PASSWORD`. Bind port 6002 only to a trusted LAN/VPN address
   when `/full` access is needed; the default is loopback.
2. Run `docker compose up -d --build`.
3. Open the normal public domain. On a fresh volume the RisuAI Node password is
   initialized, before listen, from `RISU_RUNTIME_PASSWORD`. Existing
   `save/__password` values are never replaced. Each new desktop/mobile device
   enters that Node password once so its public key can be trusted.
4. If compatibility access is needed, open `https://SERVER:6002/` and sign in
   with `RISU_RUNTIME_USER` and `RISU_RUNTIME_PASSWORD`. The fixed resident
   enrolls its device key automatically through an executor-IP-only endpoint;
   it does not receive a hidden first-launch password dialog. A V3 plugin whose
   permission store is absent can still ask during plugin startup before the
   command prompt bridge exists; resolve that startup permission from port
   6002 if health does not become ready.

The application and browser use fixed addresses configured by
`RISU_APP_IPV4` and `RISU_BROWSER_IPV4` inside `RISU_RUNTIME_SUBNET`. The fixed
browser address is also the executor allow-list. Change the subnet and both
addresses together if the default overlaps a Docker, LAN, or VPN route.

`server/runtime/wait-for-risuai.sh` delays Chromium until the app is ready,
including after host reboot. Chromium's debugging endpoint is loopback-only
inside the browser container. The internal HTTP app origin is treated as secure
only in resident Chromium. Container JSON logs rotate at 10 MiB with three
files each.

## Health and recovery

Check both services first:

```sh
docker compose ps
docker compose logs --tail=200 risuai browser-runtime
```

The Chromium container becomes healthy only after its page is the
`?risu-runtime=executor` target **and** that page has made an authenticated
executor claim poll within the last ten seconds. A loaded logo or an open CDP
port alone is not treated as readiness.

After three consecutive readiness failures the health script sends TERM to the
Chromium process. `RESTART_APP=true` asks the image supervisor to start a fresh
Chromium process in the same persistent profile; Docker itself does not restart
a container merely because it is unhealthy. Validate this image-specific
supervisor behavior during every browser-image rollout by terminating Chromium
once and observing a new process, executor claim polling, and healthy status.

Verify the already-running resident page from its network namespace:

```sh
docker run --rm \
  --network container:risuai-runtime \
  --entrypoint node \
  risuai:server-resident \
  /app/server/node/runtimeProbe.cjs verify
```

Closing a public page is safe. Restarting Chromium or expiring its lease marks
the running generation `interrupted`; restarting Node also marks running proxy
jobs interrupted. Neither is automatically reissued. Queued generation
commands remain queued, and committed RisuSave revisions remain authoritative.
After a process restart, inspect the public UI and retry only work explicitly
reported as interrupted.

Retention is bounded in `risuai-save`: terminal proxy jobs default to 7 days
after transport acknowledgement or 14 days without acknowledgement, with a
2,000-job cap; terminal generation commands default to 30 days with a
2,000-command cap. Proxy response spools are additionally limited to 256 MiB
per job and 2 GiB in total. Age, count, and byte overrides are listed in
`.env.example`.

Regular flat NodeStorage files are atomically replaced and subject to an 8 GiB
default accounting cap plus a 1 GiB filesystem free-space reserve. The
accounting includes database/auth files and flat assets, inlays, MCP payloads,
V3 permissions, and backups; durable generation/proxy subdirectories have
their own policies above. A rejected flat write returns HTTP 507 and must be
treated as a storage-capacity failure, not retried indefinitely.

## Updating upstream

1. Stop both services and back up both volumes, `.env`, the current Git commit,
   and current image identifiers.
2. Update the fork's upstream `main`, then rebase the custom runtime branch on
   that reviewed commit. Resolve changes by preserving upstream UI markup and
   keeping runtime integration at storage/generation boundaries.
3. Run the server and browser test suites, Svelte checks, production build, and
   `docker compose config` before deployment.
4. Run `docker compose up -d --build`. The Compose dependency restart reloads
   the resident page at `?risu-runtime=executor` so it cannot keep an older
   cached bundle.
5. Run the health probe and the multi-device acceptance checks in
   `server/multidevice-runtime.md`. Keep the prior Git commit and images until a
   Lua/plugin-heavy real character has passed.
6. For a new Chromium image, terminate its Chromium process once and verify the
   supervisor recreates it and the container returns healthy before accepting
   the rollout.

Update `RISU_CHROMIUM_IMAGE` only after reviewing and testing a new pinned
browser image. Do not use an unattended floating browser tag.
