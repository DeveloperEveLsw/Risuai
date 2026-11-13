import { IndexedDbOutbox } from "../../src/ts/runtime/browserOutbox";
import { RuntimeSyncClient } from "../../src/ts/runtime/runtimeSyncClient";

// Protocol acceptance harness, not a substitute for the Risu UI acceptance gate.
const h: any = {
  offline: false,
  loseAck: false,
  failKey: "",
  posts: [],
  postPaths: [],
  errors: [],
  attempts: [],
  applied: [],
  pending: [],
  variables: {},
  messages: {},
  jobs: {},
  status: "new",
};
const originalFetch = fetch.bind(globalThis);
h.open = async (serverUrl: string, expectedServerId?: string, start = true) => {
  const baseUrl = serverUrl + "/api/runtime";
  const bootstrap = await (await originalFetch(baseUrl + "/bootstrap")).json();
  h.outbox = new IndexedDbOutbox(expectedServerId ?? bootstrap.serverId);
  const load = async () => {
    for (const chatId of ["a", "b"]) {
      const snapshot: any = await h.client.read("/chats/" + chatId);
      h.variables[chatId] = Object.fromEntries(
        snapshot.variables.map((v) => [v.key, v.value]),
      );
      h.messages[chatId] = snapshot.messages.map((m) => m.message);
    }
  };
  h.client = new RuntimeSyncClient({
    baseUrl,
    serverId: expectedServerId ?? bootstrap.serverId,
    outbox: h.outbox,
    retryMs: 50,
    fetch: async (input, init) => {
      if (h.offline) throw new TypeError("Synthetic disconnected device");
      if (init?.method === "POST") {
        h.posts.push(JSON.parse(String(init.body)).requestId);
        h.postPaths.push(String(input));
        if (
          h.noGuardedFields &&
          String(input).endsWith("/commands/guarded-fields")
        )
          return new Response(
            JSON.stringify({
              error: { code: "NOT_FOUND", message: "Authored old server" },
            }),
            {
              status: 404,
              headers: {
                "Content-Type": "application/json",
                "Risu-Runtime-Id": bootstrap.serverId,
              },
            },
          );
      }
      const response = await originalFetch(input, init);
      if (h.loseAck && init?.method === "POST") {
        h.loseAck = false;
        await response.text();
        throw new TypeError("Synthetic discarded acknowledgement");
      }
      return response;
    },
    onBootstrap: async () => {
      await load();
      if (h.pauseBootstrap) {
        h.bootstrapPaused = true;
        await new Promise<void>((resolve) => {
          h.resumeBootstrap = resolve;
        });
        h.pauseBootstrap = false;
        h.bootstrapPaused = false;
      }
    },
    onChange: async (change) => {
      h.attempts.push(change.sequence);
      if (change.type === "variable" && change.payload.key === h.failKey) {
        h.failKey = "";
        throw new Error("Synthetic projection failure");
      }
      if (change.type === "variable")
        h.variables[change.chatId][String(change.payload.key)] =
          change.payload.value;
      if (change.type === "job") {
        h.jobs[change.id] = change.payload;
        if (!["queued", "running"].includes(String(change.payload.state)))
          await load();
      }
      h.applied.push(change.sequence);
    },
    onAccepted: async (entry) => {
      if (entry.kind === "job") {
        const job: any = await h.client.read("/jobs/" + entry.requestId);
        h.jobs[job.id] = job;
        if (!["queued", "running"].includes(job.state)) {
          await load();
          await h.client.acknowledgeJob(job.id);
        }
      }
    },
    onPending: (entries) => {
      h.pending = entries;
    },
    onStatus: (status) => {
      h.status = status;
    },
    onError: (error) => {
      h.errors.push(String((error as any)?.code ?? error));
    },
  });
  if (start) await h.client.start();
  return bootstrap.serverId;
};
h.close = async () => {
  await h.client.close();
  await h.outbox.close();
};
(window as any).harness = h;
