# Server-resident RisuAI runtime

This deployment runs the unmodified RisuAI browser application inside one
persistent Chromium session on the server. Users attach to that session over
the browser desktop at `https://SERVER:6002/` and may disconnect at any time.
The RisuAI tab, its provider request, Lua VM, plugins, triggers, and output
post-processing continue to run in the server container.

## Why the whole browser is resident

Community content can depend on browser APIs, Lua callback ordering, plugin
hooks, IndexedDB, Canvas, alerts, and undocumented combinations of them. A
separate Node implementation of prompt building or output processing would
inevitably drift from upstream. This deployment therefore uses the exact
upstream bundle as its execution engine.

## Persistent state

- `risuai-save` contains the upstream Node server's opaque RisuAI save and
  assets. It remains the canonical application store.
- `risuai-runtime-profile` contains Chromium's profile, the NodeStorage signing
  key, plugin-local browser storage, and UI preferences.
- The viewer browser only stores the remote-desktop site's ordinary cookies and
  cache. It does not hold the RisuAI database.

Back up both Docker volumes together. Do not open the raw app from another
browser and edit it concurrently: RisuAI's browser state is single-writer and a
second page can overwrite newer state.

## Start

1. Copy `.env.example` to `.env`, set a long random
   `RISU_RUNTIME_PASSWORD`, and set `RISU_RUNTIME_BIND` to the server's LAN or
   VPN address when remote access is required.
2. Run `docker compose up -d --build`.
3. Open `https://SERVER:6002/`, accept the locally generated TLS certificate,
   and sign in with `RISU_RUNTIME_USER` and `RISU_RUNTIME_PASSWORD`.
4. On the first RisuAI launch, set its separate Node server password. The
   browser profile and upstream trusted-key file preserve this login across
   normal container recreation.

Port 6001 is bound to host loopback only. The remote browser is the supported
interactive entry point.

The browser container runs `server/runtime/wait-for-risuai.sh` before starting
Chromium. This also covers Docker's host-reboot path, where restart policies do
not guarantee the Compose `depends_on` startup order. If the app is unavailable,
the browser waits instead of permanently opening Chromium's connection-error
page. Readiness checks use a static asset so they do not continuously add root
page access entries to the application log. Docker JSON logs for both services
rotate at 10 MiB with three files retained per container.

The app and browser keep the private addresses configured by `RISU_APP_IPV4`
and `RISU_BROWSER_IPV4` inside `RISU_RUNTIME_SUBNET`. Chromium can cache a Docker
DNS answer beyond a container recreation, so the app's stable address is
required for image updates that replace it while retaining the resident browser
profile. Change the subnet and both addresses together if the default overlaps
an existing Docker, LAN, or VPN route.

Chromium's debugging endpoint listens only on loopback inside its own container.
It is used for health checks and deployment verification and is not published
to the app container, host, or LAN. The internal `http://risuai:6001` origin is
explicitly marked as a secure origin in the resident Chromium only; the raw app
port remains bound to host loopback.

For an administrative readiness check, run the application image as a one-off
probe inside the browser container's network namespace:

```sh
docker run --rm \
  --network container:risuai-runtime \
  --entrypoint node \
  risuai:server-resident \
  /app/server/node/runtimeProbe.cjs verify
```

The probe container exits after the check and cannot make the debugging port
reachable from outside the browser container. Verification performs a
cache-bypassing fetch from inside the already-running RisuAI page, so it also
detects a stale browser-side Docker DNS result after an app replacement.

## Runtime behavior and limits

- Closing the viewer, changing local tabs, or shutting down the viewer device
  does not stop a generation.
- An upstream alert/input/select requested by content remains visible in the
  resident session and waits until the user reconnects. It is not guessed or
  skipped.
- A Chromium crash, host reboot, or deliberate container restart can still
  interrupt an in-flight JavaScript operation. Persisting jobs across process
  crashes is a separate feature from surviving viewer disconnects.
- Local file import/export and clipboard use the remote desktop's transfer
  bridge. Microphone, WebGPU, and hardware-specific plugins remain constrained
  by that bridge.

## Updating upstream

Keep the fork's application code close to upstream `main`. Fast-forward or
rebase this deployment commit onto the reviewed upstream revision, rebuild the
`risuai` image, and then verify at least one Lua/trigger-heavy character before
removing the prior image. Update `RISU_CHROMIUM_IMAGE` explicitly after
reviewing a new browser image. The `depends_on.restart` relation makes an
explicit Compose app update restart the browser service as well, preserving its
profile but forcing the resident tab to load the newly built upstream bundle.
