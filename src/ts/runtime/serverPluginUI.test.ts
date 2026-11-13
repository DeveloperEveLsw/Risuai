import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServerPluginUIFrameDocument,
  copyServerPluginUIToClipboard,
  mountServerPluginUI,
  openServerPluginUI,
  readServerPluginUIFile,
  saveServerPluginUIArtifact,
  SERVER_PLUGIN_UI_TRANSFER_LIMIT,
  ServerPluginUIError,
  type ServerPluginUIEvent,
  type ServerPluginUISession,
  type ServerPluginUISnapshot,
  type ServerPluginUIEffect,
  validateServerPluginUISnapshot,
} from "./serverPluginUI";
import { createHash } from "node:crypto";

const scope = {
  sessionId: "synthetic-session",
  pluginId: "synthetic-plugin",
  bundleSha: "a".repeat(64),
  pluginEpoch: 0,
  characterId: "synthetic-character",
  chatId: "synthetic-chat",
  chatEpoch: 0,
  writerId: "synthetic-writer",
  writerFence: 1,
};
const view = (revision = 1): ServerPluginUISnapshot => ({
  scope: { ...scope },
  revision,
  html: '<button data-risu-plugin-node="synthetic-node" data-risu-plugin-events="click">Original</button>',
  styles: [],
  controlStates: [],
  visible: true,
  busy: false,
});
const event = (revision = 1): ServerPluginUIEvent => ({
  scope: { ...scope },
  revision,
  eventId: "plugin-ui:11111111-1111-4111-8111-111111111111",
  nodeId: "synthetic-node",
  type: "click",
});
const opened = {
  sessionId: scope.sessionId,
  ownerToken: "synthetic-opaque-owner",
  snapshot: view(),
};
const capability = {
  supported: true,
  enabled: true,
  serverId: "synthetic-server",
};
const sessions: ServerPluginUISession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0))
    await session.close().catch(() => {});
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function transport(
  handler?: (
    path: string,
    init: RequestInit,
  ) => Promise<Response> | Response | undefined,
) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const request = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input);
      calls.push({ path, init });
      const result = handler?.(path, init);
      if (result) return result;
      if (path.endsWith("/capability")) return response(capability);
      if (path === "/api/runtime/plugin-ui") return response(opened);
      if (path.endsWith("/close")) return response({ closed: true });
      return response(view());
    },
  ) as unknown as typeof fetch;
  return { request, calls };
}
async function open(request: typeof fetch, extra = {}) {
  const session = await openServerPluginUI({
    pluginId: scope.pluginId,
    owner: {
      chatId: scope.chatId,
      chatEpoch: 0,
      selection: "not-a-route-selector",
    },
    fetch: request,
    ...extra,
  });
  sessions.push(session);
  return session;
}
describe("server plugin UI owner transport", () => {
  it("opens the stable chat incarnation and keeps the opaque owner only in headers", async () => {
    const h = transport();
    const session = await open(h.request);
    expect(JSON.parse(String(h.calls[1].init.body))).toEqual({
      pluginId: scope.pluginId,
      chatId: scope.chatId,
      expectedChatEpoch: 0,
    });
    expect(new Headers(h.calls[1].init.headers).get("Risu-Runtime-Id")).toBe(
      capability.serverId,
    );
    await session.refresh();
    const read = h.calls.at(-1)!;
    expect(new Headers(read.init.headers).get("Risu-Plugin-Owner")).toBe(
      opened.ownerToken,
    );
    expect(JSON.stringify(session.snapshot)).not.toContain(opened.ownerToken);
    const leaked = session.snapshot;
    leaked.scope.chatId = "other";
    expect(session.snapshot.scope.chatId).toBe(scope.chatId);
    expect(read.init.credentials).toBe("same-origin");
  });
  it("does not open when native capability is disabled", async () => {
    const h = transport((path) =>
      path.endsWith("/capability")
        ? response({ ...capability, enabled: false })
        : undefined,
    );
    await expect(open(h.request)).rejects.toMatchObject({
      code: "PLUGIN_UI_UNAVAILABLE",
    });
    expect(h.calls).toHaveLength(1);
  });
  it("closes an opened owner if its initial snapshot belongs to another chat", async () => {
    const h = transport((path) =>
      path === "/api/runtime/plugin-ui"
        ? response({
            ...opened,
            snapshot: { ...view(), scope: { ...scope, chatId: "other" } },
          })
        : undefined,
    );
    await expect(open(h.request)).rejects.toMatchObject({
      code: "PLUGIN_UI_SCOPE_CHANGED",
    });
    expect(h.calls.at(-1)?.path).toMatch(/\/close$/);
  });
  it("acknowledges the exact event and ignores an older progress response", async () => {
    let requestCount = 0;
    const h = transport((path) =>
      path.endsWith("/event")
        ? response({
            eventId: event().eventId,
            appliedRevision: 2,
            replayed: false,
            snapshot: view(3),
          })
        : path.endsWith(scope.sessionId)
          ? response(view(++requestCount === 1 ? 2 : 1))
          : undefined,
    );
    const session = await open(h.request);
    await session.dispatch(event());
    expect(session.snapshot.revision).toBe(3);
    await session.refresh();
    expect(session.snapshot.revision).toBe(3);
    expect(h.calls.filter((c) => c.path.endsWith("/event"))).toHaveLength(1);
  });
  it("never retries a request with an uncertain event acknowledgement", async () => {
    const h = transport((path) =>
      path.endsWith("/event")
        ? Promise.reject(new TypeError("Synthetic lost ACK"))
        : undefined,
    );
    const session = await open(h.request);
    await expect(session.dispatch(event())).rejects.toThrow(
      "Synthetic lost ACK",
    );
    await expect(session.dispatch(event())).rejects.toThrow(
      "Synthetic lost ACK",
    );
    expect(h.calls.filter((c) => c.path.endsWith("/event"))).toHaveLength(1);
  });
  it("recovers a lost ACK using only the exact completed body-free receipt and a guarded view", async () => {
    const request = event();
    function sorted(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(sorted);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [
              key,
              sorted((value as Record<string, unknown>)[key]),
            ]),
        );
      return value;
    }
    const requestHash = createHash("sha256")
      .update(JSON.stringify(sorted(request)))
      .digest("hex");
    const h = transport((path) => {
      if (path.endsWith("/event"))
        return Promise.reject(new TypeError("Synthetic lost ACK"));
      if (path.includes("/plugin-ui-events/"))
        return response({
          eventId: request.eventId,
          sessionId: scope.sessionId,
          requestHash,
          state: "completed",
          commitId: request.eventId,
          appliedRevision: 2,
        });
      if (path.endsWith(scope.sessionId)) return response(view(3));
    });
    const session = await open(h.request);
    expect(await session.dispatch(request)).toMatchObject({
      eventId: request.eventId,
      appliedRevision: 2,
      replayed: true,
    });
    expect(session.snapshot.revision).toBe(3);
    expect(h.calls.filter((call) => call.path.endsWith("/event"))).toHaveLength(
      1,
    );
    const lookup = h.calls.find((call) =>
      call.path.includes("/plugin-ui-events/"),
    )!;
    expect(lookup.init.body).toBeUndefined();
    expect(new Headers(lookup.init.headers).has("Risu-Plugin-Owner")).toBe(
      false,
    );
  });
  it("never treats an admitted or mismatched receipt as a completed original action", async () => {
    for (const proof of [
      { state: "admitted" },
      { state: "completed", requestHash: "forged" },
    ]) {
      const h = transport((path) =>
        path.endsWith("/event")
          ? Promise.reject(new TypeError("Uncertain"))
          : path.includes("/plugin-ui-events/")
            ? response({
                eventId: event().eventId,
                sessionId: scope.sessionId,
                commitId: event().eventId,
                appliedRevision: 2,
                ...proof,
              })
            : undefined,
      );
      const session = await open(h.request);
      await expect(session.dispatch(event())).rejects.toThrow("Uncertain");
      expect(
        h.calls.filter((call) => call.path.endsWith("/event")),
      ).toHaveLength(1);
    }
  });
  it("reports a confirmed saved event when its original owner has already closed", async () => {
    const request = event();
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [
                  key,
                  canonical((value as Record<string, unknown>)[key]),
                ]),
            )
          : value;
    const requestHash = createHash("sha256")
      .update(JSON.stringify(canonical(request)))
      .digest("hex");
    const h = transport((path) =>
      path.endsWith("/event")
        ? Promise.reject(new TypeError("Lost response"))
        : path.includes("/plugin-ui-events/")
          ? response({
              state: "completed",
              eventId: request.eventId,
              sessionId: scope.sessionId,
              commitId: request.eventId,
              requestHash,
              appliedRevision: 2,
            })
          : path.endsWith(scope.sessionId)
            ? response(
                { error: { code: "FORBIDDEN", message: "Owner is closed" } },
                403,
              )
            : undefined,
    );
    const session = await open(h.request);
    await expect(session.dispatch(request)).rejects.toMatchObject({
      code: "PLUGIN_UI_EVENT_COMPLETED",
    });
    expect(h.calls.filter((call) => call.path.endsWith("/event"))).toHaveLength(
      1,
    );
  });
  it("refreshes a stale unadmitted event and allows only a new explicit action", async () => {
    let rejected = false;
    const h = transport((path) => {
      if (path.endsWith("/event")) {
        if (!rejected) {
          rejected = true;
          return response(
            {
              error: {
                code: "PLUGIN_UI_REVISION_CHANGED",
                message: "Changed original DOM",
              },
            },
            409,
          );
        }
        return response({
          eventId: event().eventId,
          appliedRevision: 4,
          replayed: false,
          snapshot: view(4),
        });
      }
      if (path.endsWith(scope.sessionId)) return response(view(3));
    });
    const session = await open(h.request);
    await expect(session.dispatch(event())).rejects.toMatchObject({
      code: "PLUGIN_UI_REVISION_CHANGED",
    });
    expect(session.snapshot.revision).toBe(3);
    expect(h.calls.filter((c) => c.path.endsWith("/event"))).toHaveLength(1);
    await session.dispatch(event(3));
    expect(session.snapshot.revision).toBe(4);
  });
  it("rejects forged fields and a changed writer before issuing a request", async () => {
    const h = transport();
    const session = await open(h.request);
    await expect(
      session.dispatch({ ...event(), extra: "forged" } as ServerPluginUIEvent),
    ).rejects.toBeInstanceOf(ServerPluginUIError);
    await expect(
      session.dispatch({ ...event(), scope: { ...scope, writerFence: 2 } }),
    ).rejects.toBeInstanceOf(ServerPluginUIError);
    expect(h.calls.filter((c) => c.path.endsWith("/event"))).toHaveLength(0);
  });
  it("polls guarded progress while an event is pending and closes with keepalive", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const h = transport((path) =>
      path.endsWith("/event")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : undefined,
    );
    const session = await open(h.request);
    let completed = false;
    const pending = session.dispatch(event()).then((result) => {
      completed = true;
      return result;
    });
    // WebCrypto admission is real asynchronous work, independent of fake
    // timer advancement and subject to the full suite's worker scheduling.
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"), {
      timeout: 5000,
      interval: 20,
    });
    expect(completed).toBe(false);
    expect(h.calls.filter((call) => call.path.endsWith("/event"))).toHaveLength(
      1,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.calls.some((c) => c.path.endsWith(scope.sessionId))).toBe(true);
    finish(
      response({
        eventId: event().eventId,
        appliedRevision: 2,
        replayed: false,
        snapshot: view(2),
      }),
    );
    await pending;
    await session.close({ keepalive: true });
    expect(h.calls.at(-1)?.init.keepalive).toBe(true);
    const count = h.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.calls).toHaveLength(count);
  });
  it("stops and closes on pagehide without replaying a pending user action", async () => {
    const h = transport();
    const session = await open(h.request);
    window.dispatchEvent(new Event("pagehide"));
    await Promise.resolve();
    expect(h.calls.at(-1)?.path).toMatch(/\/close$/);
    expect(h.calls.at(-1)?.init.keepalive).toBe(true);
    await expect(session.refresh()).rejects.toMatchObject({
      code: "PLUGIN_UI_CLOSED",
    });
  });
});
describe("opaque iframe contract", () => {
  it("contains only the trusted bridge script and source/secret checked channel setup", () => {
    const document = createServerPluginUIFrameDocument(
      "s".repeat(32),
      "n".repeat(32),
    );
    expect(document).toContain("script-src 'nonce-" + "n".repeat(32));
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("event.source !== parentWindow");
    expect(document).toContain("event.data?.secret !== secret");
    expect(document).not.toContain("synthetic-opaque-owner");
    expect(() =>
      createServerPluginUIFrameDocument("</script>", "n".repeat(32)),
    ).toThrow();
  });
  it("rejects missing control semantics and changed chat incarnations", () => {
    expect(() =>
      validateServerPluginUISnapshot({
        ...view(),
        controlStates: [{ nodeId: "x" }],
      }),
    ).toThrow();
    expect(() =>
      validateServerPluginUISnapshot(
        { ...view(), scope: { ...scope, chatEpoch: 1 } },
        scope,
      ),
    ).toThrow();
  });
});

const fileEffect = (): Extract<ServerPluginUIEffect, { kind: "file" }> => ({
  id: "22222222-2222-4222-8222-222222222222",
  eventId: event().eventId,
  kind: "file",
  accept: ".json",
  multiple: false,
});
const downloadEffect = (): Extract<
  ServerPluginUIEffect,
  { kind: "download" }
> => ({
  id: "33333333-3333-4333-8333-333333333333",
  eventId: event().eventId,
  kind: "download",
  name: "original.json",
  mime: "application/json",
  bytes: 2,
});
describe("trusted parent browser effects", () => {
  it("defaults missing effects to an empty list and validates exact schema, IDs and UTF-8 limits", () => {
    expect(validateServerPluginUISnapshot(view()).effects).toEqual([]);
    const file = fileEffect(),
      download = downloadEffect();
    for (const effects of [
      [file, file],
      Array.from({ length: 5 }, () => file),
      [{ ...file, source: "unknown" }],
      [{ ...file, multiple: true }],
      [{ ...file, eventId: "other-event" }],
      [{ ...download, name: "../private.json" }],
      [{ ...download, mime: "text/html" }],
      [{ ...download, bytes: SERVER_PLUGIN_UI_TRANSFER_LIMIT + 1 }],
      [
        {
          ...file,
          kind: "clipboard",
          accept: undefined,
          multiple: undefined,
          text: "copy",
        },
      ],
    ])
      expect(() =>
        validateServerPluginUISnapshot({ ...view(), effects }),
      ).toThrow(ServerPluginUIError);
    expect(
      validateServerPluginUISnapshot({ ...view(), effects: [file, download] })
        .effects,
    ).toEqual([file, download]);
  });
  it("resolves only the exact advertised effect once and uses the opaque owner header", async () => {
    const effect = fileEffect();
    const h = transport((path) =>
      path === "/api/runtime/plugin-ui"
        ? response({ ...opened, snapshot: { ...view(), effects: [effect] } })
        : path.endsWith("/effect")
          ? response({
              effectId: effect.id,
              eventId: effect.eventId,
              kind: effect.kind,
              resolved: true,
            })
          : undefined,
    );
    const session = await open(h.request);
    await expect(
      session.resolveEffect(
        { ...effect, accept: ".txt" },
        { kind: "file", file: null },
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_UI_EFFECT_CHANGED" });
    await expect(
      session.resolveEffect(effect, { kind: "confirm", accepted: true }),
    ).rejects.toMatchObject({ code: "INVALID_PLUGIN_UI_EFFECT" });
    await session.resolveEffect(effect, {
      kind: "file",
      file: { name: "synthetic.json", text: '{"synthetic":true}' },
    });
    await expect(
      session.resolveEffect(effect, { kind: "file", file: null }),
    ).rejects.toMatchObject({ code: "PLUGIN_UI_EFFECT_USED" });
    const calls = h.calls.filter((call) => call.path.endsWith("/effect"));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      effectId: effect.id,
      eventId: effect.eventId,
      kind: "file",
      file: { name: "synthetic.json", text: '{"synthetic":true}' },
    });
    expect(new Headers(calls[0].init.headers).get("Risu-Plugin-Owner")).toBe(
      opened.ownerToken,
    );
    expect(calls[0].path).not.toContain(opened.ownerToken);
  });
  it("rejects oversized UTF-8 file answers before admission and allows a valid explicit answer", async () => {
    const effect = fileEffect();
    const h = transport((path) =>
      path === "/api/runtime/plugin-ui"
        ? response({ ...opened, snapshot: { ...view(), effects: [effect] } })
        : path.endsWith("/effect")
          ? response({
              effectId: effect.id,
              eventId: effect.eventId,
              kind: effect.kind,
              resolved: true,
            })
          : undefined,
    );
    const session = await open(h.request);
    await expect(
      session.resolveEffect(effect, {
        kind: "file",
        file: {
          name: "synthetic.json",
          text: "한".repeat(
            Math.floor(SERVER_PLUGIN_UI_TRANSFER_LIMIT / 3) + 1,
          ),
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_PLUGIN_UI_EFFECT" });
    expect(h.calls.some((call) => call.path.endsWith("/effect"))).toBe(false);
    await session.resolveEffect(effect, { kind: "file", file: null });
  });
  it("never automatically repeats a lost effect acknowledgement", async () => {
    const effect = fileEffect();
    const h = transport((path) =>
      path === "/api/runtime/plugin-ui"
        ? response({ ...opened, snapshot: { ...view(), effects: [effect] } })
        : path.endsWith("/effect")
          ? Promise.reject(new TypeError("Synthetic effect ACK lost"))
          : undefined,
    );
    const session = await open(h.request);
    await expect(
      session.resolveEffect(effect, { kind: "file", file: null }),
    ).rejects.toThrow("Synthetic effect ACK lost");
    await expect(
      session.resolveEffect(effect, { kind: "file", file: null }),
    ).rejects.toThrow("Synthetic effect ACK lost");
    expect(
      h.calls.filter((call) => call.path.endsWith("/effect")),
    ).toHaveLength(1);
  });
  it("handles confirmed cancellation closing the owner without concealing unconfirmed or auth failures", async () => {
    for (const code of ["PLUGIN_UI_CLOSED", "FORBIDDEN"]) {
      const effect = fileEffect(),
        onError = vi.fn();
      const h = transport((path) =>
        path === "/api/runtime/plugin-ui"
          ? response({ ...opened, snapshot: { ...view(), effects: [effect] } })
          : path.endsWith("/effect")
            ? response({
                effectId: effect.id,
                eventId: effect.eventId,
                kind: "file",
                resolved: true,
              })
            : path.endsWith(scope.sessionId)
              ? response(
                  {
                    error: { code, message: "Owner closed after cancellation" },
                  },
                  403,
                )
              : undefined,
      );
      const session = await open(h.request, { onError });
      expect(
        await session.resolveEffect(effect, { kind: "file", file: null }),
      ).toMatchObject({ visible: false, effects: [] });
      expect(session.closed).toBe(true);
      expect(onError).not.toHaveBeenCalled();
    }
  });
  it("accepts changing effect metadata while an original event is busy without a new DOM revision", async () => {
    const file = fileEffect(),
      confirm: ServerPluginUIEffect = {
        id: "44444444-4444-4444-8444-444444444444",
        eventId: file.eventId,
        kind: "confirm",
        text: "Apply the synthetic import?",
      };
    let effects: ServerPluginUIEffect[] = [file];
    let finish!: (value: Response) => void;
    const h = transport((path) => {
      if (path === "/api/runtime/plugin-ui" || path.endsWith(scope.sessionId)) {
        const snapshot = { ...view(), busy: true, effects };
        return response(
          path === "/api/runtime/plugin-ui"
            ? { ...opened, snapshot }
            : snapshot,
        );
      }
      if (path.endsWith("/event"))
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      if (path.endsWith("/effect")) {
        effects = [confirm];
        return response({
          effectId: file.id,
          eventId: file.eventId,
          kind: "file",
          resolved: true,
        });
      }
    });
    const session = await open(h.request),
      snapshots: ServerPluginUISnapshot[] = [];
    session.subscribe((snapshot) => snapshots.push(snapshot));
    const pending = session.dispatch(event());
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await session.resolveEffect(file, {
      kind: "file",
      file: { name: "synthetic.json", text: "{}" },
    });
    expect(session.snapshot.effects).toEqual([confirm]);
    expect(session.snapshot.revision).toBe(1);
    expect(snapshots.at(-1)?.effects).toEqual([confirm]);
    finish(
      response({
        eventId: event().eventId,
        appliedRevision: 2,
        replayed: false,
        snapshot: view(2),
      }),
    );
    await pending;
  });
  it("receives exact bounded artifact bytes over authenticated fetch and acknowledges only after receiving them", async () => {
    const effect = downloadEffect();
    const h = transport((path) =>
      path === "/api/runtime/plugin-ui"
        ? response({ ...opened, snapshot: { ...view(), effects: [effect] } })
        : path.includes("/artifact/")
          ? new Response("{}", {
              headers: {
                "Content-Type": "application/json",
                "Content-Length": "2",
              },
            })
          : path.endsWith("/effect")
            ? response({
                effectId: effect.id,
                eventId: effect.eventId,
                kind: "download",
                resolved: true,
              })
            : undefined,
    );
    const session = await open(h.request);
    await expect(
      session.resolveEffect(effect, { kind: "download", received: true }),
    ).rejects.toMatchObject({ code: "INVALID_PLUGIN_UI_EFFECT" });
    const blob = await session.downloadArtifact(effect);
    expect(await blob.text()).toBe("{}");
    expect(blob.type).toBe("application/json");
    await expect(session.downloadArtifact(effect)).rejects.toMatchObject({
      code: "PLUGIN_UI_EFFECT_USED",
    });
    await session.resolveEffect(effect, { kind: "download", received: true });
    const fetch = h.calls.find((call) => call.path.includes("/artifact/"))!;
    expect(fetch.path).toContain(
      "?eventId=" + encodeURIComponent(effect.eventId),
    );
    expect(new Headers(fetch.init.headers).get("Risu-Plugin-Owner")).toBe(
      opened.ownerToken,
    );
    expect(fetch.path).not.toContain(opened.ownerToken);
  });
  it("rejects wrong MIME, incomplete or oversized artifact bodies without retrying", async () => {
    for (const artifact of [
      new Response("{}", { headers: { "Content-Type": "text/html" } }),
      new Response("{", { headers: { "Content-Type": "application/json" } }),
      new Response("{}x", { headers: { "Content-Type": "application/json" } }),
    ]) {
      const effect = downloadEffect();
      const h = transport((path) =>
        path === "/api/runtime/plugin-ui"
          ? response({ ...opened, snapshot: { ...view(), effects: [effect] } })
          : path.includes("/artifact/")
            ? artifact
            : undefined,
      );
      const session = await open(h.request);
      await expect(session.downloadArtifact(effect)).rejects.toMatchObject({
        code: "INVALID_PLUGIN_UI_ARTIFACT",
      });
      await expect(session.downloadArtifact(effect)).rejects.toMatchObject({
        code: "INVALID_PLUGIN_UI_ARTIFACT",
      });
      expect(
        h.calls.filter((call) => call.path.includes("/artifact/")),
      ).toHaveLength(1);
    }
  });
  it("closing during an artifact fetch prevents a late download or effect acknowledgement", async () => {
    const effect = downloadEffect();
    let finish!: (value: Response) => void;
    const h = transport((path) =>
      path === "/api/runtime/plugin-ui"
        ? response({ ...opened, snapshot: { ...view(), effects: [effect] } })
        : path.includes("/artifact/")
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : undefined,
    );
    const session = await open(h.request);
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click");
    const pending = saveServerPluginUIArtifact(session, effect);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await session.close();
    finish(
      new Response("{}", { headers: { "Content-Type": "application/json" } }),
    );
    await expect(pending).rejects.toMatchObject({ code: "PLUGIN_UI_CLOSED" });
    expect(clicked).not.toHaveBeenCalled();
    clicked.mockRestore();
    expect(h.calls.some((call) => call.path.endsWith("/effect"))).toBe(false);
  });
  it("reads only bounded UTF-8 JSON/plain files and aborts late selection", async () => {
    const good = new File(['{"synthetic":true}'], "synthetic.json", {
      type: "application/json",
    });
    expect(await readServerPluginUIFile(good)).toEqual({
      name: "synthetic.json",
      text: '{"synthetic":true}',
    });
    await expect(
      readServerPluginUIFile(
        new File([new Uint8Array([255, 0])], "bad.json", {
          type: "application/json",
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_PLUGIN_UI_FILE" });
    await expect(
      readServerPluginUIFile(
        new File(["plain"], "wrong.png", { type: "image/png" }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_PLUGIN_UI_FILE" });
    const abort = new AbortController();
    abort.abort();
    await expect(readServerPluginUIFile(good, abort.signal)).rejects.toThrow();
  });
  it("starts native clipboard writing inside the caller's activation and never duplicates a pending copy", async () => {
    const effect: Extract<ServerPluginUIEffect, { kind: "clipboard" }> = {
      id: fileEffect().id,
      eventId: event().eventId,
      kind: "clipboard",
      text: "Synthetic original copy text",
    };
    let finish!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const h = transport((path) =>
      path === "/api/runtime/plugin-ui"
        ? response({ ...opened, snapshot: { ...view(), effects: [effect] } })
        : path.endsWith("/effect")
          ? response({
              effectId: effect.id,
              eventId: effect.eventId,
              kind: "clipboard",
              resolved: true,
            })
          : undefined,
    );
    const session = await open(h.request);
    const pending = copyServerPluginUIToClipboard(session, effect);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(effect.text);
    await expect(
      copyServerPluginUIToClipboard(session, effect),
    ).rejects.toMatchObject({ code: "PLUGIN_UI_EFFECT_USED" });
    expect(h.calls.some((call) => call.path.endsWith("/effect"))).toBe(false);
    finish();
    await pending;
    const answer = h.calls.find((call) => call.path.endsWith("/effect"))!;
    expect(JSON.parse(String(answer.init.body))).toEqual({
      effectId: effect.id,
      eventId: effect.eventId,
      kind: "clipboard",
      ok: true,
    });
    expect(String(answer.init.body)).not.toContain(effect.text);
  });
  it("reports denied clipboard access explicitly without fallback or copy text in the failure", async () => {
    const effect: Extract<ServerPluginUIEffect, { kind: "clipboard" }> = {
      id: fileEffect().id,
      eventId: event().eventId,
      kind: "clipboard",
      text: "Synthetic private copy",
    };
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("Synthetic denial");
        }),
      },
    });
    const h = transport((path) =>
      path === "/api/runtime/plugin-ui"
        ? response({ ...opened, snapshot: { ...view(), effects: [effect] } })
        : path.endsWith("/effect")
          ? response({
              effectId: effect.id,
              eventId: effect.eventId,
              kind: "clipboard",
              resolved: true,
            })
          : undefined,
    );
    const session = await open(h.request);
    await expect(
      copyServerPluginUIToClipboard(session, effect),
    ).rejects.toMatchObject({ code: "PLUGIN_UI_CLIPBOARD_FAILED" });
    const answer = JSON.parse(
      String(h.calls.find((call) => call.path.endsWith("/effect"))!.init.body),
    );
    expect(answer.ok).toBe(false);
    expect(answer.error).not.toContain(effect.text);
  });
  it("keeps filenames and copy/confirm text out of the opaque frame message protocol", async () => {
    const posts: unknown[] = [],
      ports: Array<{
        postMessage: (value: unknown) => void;
        close: () => void;
        start: () => void;
        onmessage?: (message: { data: unknown }) => void;
      }> = [];
    vi.stubGlobal(
      "MessageChannel",
      class {
        port1 = {
          postMessage: (value: unknown) => posts.push(value),
          close() {},
          start() {},
          onmessage: undefined,
        };
        port2 = { close() {} };
        constructor() {
          ports.push(this.port1);
        }
      },
    );
    const effect: ServerPluginUIEffect = {
      id: fileEffect().id,
      eventId: event().eventId,
      kind: "clipboard",
      text: "synthetic-parent-private-copy",
    };
    const h = transport((path) =>
      path === "/api/runtime/plugin-ui"
        ? response({ ...opened, snapshot: { ...view(), effects: [effect] } })
        : undefined,
    );
    const session = await open(h.request),
      container = document.createElement("div");
    document.body.appendChild(container);
    const frame = mountServerPluginUI(container, session);
    ports[0].onmessage?.({ data: { type: "ready" } });
    expect(JSON.stringify(posts)).not.toContain(effect.text);
    expect(JSON.stringify(posts)).not.toContain("effects");
    expect(session.snapshot.effects).toEqual([effect]);
    frame.destroy();
    container.remove();
  });
});
