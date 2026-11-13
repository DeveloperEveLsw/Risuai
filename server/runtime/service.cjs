"use strict";
const express = require("express");
const { createServer } = require("node:http");
const { resolve, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { EntityStoreClient } = require("../entity/client.cjs");
const { NativeScheduler } = require("../native/scheduler.cjs");
const { PluginUIOwners } = require("./pluginUI.cjs");
const { RuntimeError } = require("../entity/errors.cjs");
const { AssetStorage } = require("./assets.cjs");
const { MAX_ASSET_BYTES } = require("../entity/assets.cjs");
const { ArchiveExports } = require("./archive.cjs");
const { ServerSnapshotExports } = require("./serverSnapshotExports.cjs");
const {
  RuntimeDiagnostics,
  traceRequest,
  recordRequestFailure,
} = require("./diagnostics.cjs");

function number(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      name + " must be a nonnegative integer",
    );
  return Number(value);
}
const route = (handler) => (req, res, next) =>
  Promise.resolve()
    .then(() => handler(req, res))
    .catch(next);

// Original progress remains available; private model output is fetched only
// through the explicit terminal-result preview, never receipt/poll/cancel DTOs.
function publicJob(job) {
  if (job?.type === "memory-summary" && job.result) {
    const { code, message, reason } = job.result;
    job = {
      ...job,
      result: {
        code,
        message,
        reason,
        memoryPreviewAvailable:
          job.state === "completed" &&
          !!job.result.memoryPreview &&
          !job.result.memoryPreview.disposition,
      },
    };
  }
  if (!job?.progress?.providerOutputs) return job;
  const { providerOutputs: _outputs, ...progress } = job.progress;
  return { ...job, progress };
}

/** Loopback API. The production entrypoint owns external authentication/hosting. */
async function createRuntimeService(options = {}) {
  const file = resolve(options.file ?? ".local-runtime/entity.sqlite");
  const store = new EntityStoreClient(file);
  await store.ready;
  try {
    if (
      options.initialize &&
      !(await store.call("getResource", "settings", "global"))
    ) {
      const { createInitialRuntimeState } = await import(
        pathToFileURL(join(__dirname, "../native/dist/extensionJob.mjs")).href
      );
      await store.call("initializeState", createInitialRuntimeState());
    }
  } catch (error) {
    await store.close();
    throw error;
  }
  const serverId = (await store.call("bootstrap")).serverId;
  const pluginOwners = new PluginUIOwners({
    file,
    store,
    serverId,
    enabled: options.scheduler?.reviewedPlugins === true,
  });
  const assets = new AssetStorage(file, store, serverId);
  const archives = new ArchiveExports(file, serverId, options.archive);
  const snapshots = new ServerSnapshotExports(file, serverId, options.snapshot);
  const diagnostics = new RuntimeDiagnostics(
    file + ".diagnostics.jsonl",
    options.diagnostics,
  );
  const app = express(),
    feeds = new Set();
  app.disable("x-powered-by");
  let scheduler, address;
  app.use((req, res, next) => {
    traceRequest(req, res, true);
    const allowedHosts = new Set([address?.host, "127.0.0.1", "localhost"]);
    if (!allowedHosts.has(req.headers.host?.replace(/:\d+$/, "")))
      return next(new RuntimeError("FORBIDDEN", "Unknown development host"));
    const origins = new Set([
      address?.url,
      ...(options.origins ?? [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:5174",
        "http://localhost:5174",
      ]),
    ]);
    if (req.headers.origin && !origins.has(req.headers.origin))
      return next(new RuntimeError("FORBIDDEN", "Unknown development origin"));
    if (req.headers.origin) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Last-Event-ID, Risu-Runtime-Id, Risu-Plugin-Owner",
      );
      res.setHeader("Access-Control-Expose-Headers", "Risu-Request-Id");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    if (
      req.headers["risu-runtime-id"] &&
      req.headers["risu-runtime-id"] !== serverId
    )
      return next(
        new RuntimeError(
          "SERVER_CHANGED",
          "Runtime database identity does not match this client's pending commands",
        ),
      );
    next();
  });
  const prefix = "/api/runtime";
  app.get(
    prefix + "/server-snapshot",
    route(async (req, res) => {
      if (req.headers["risu-runtime-id"] !== serverId)
        throw new RuntimeError(
          "SERVER_CHANGED",
          "Snapshot requires the current database identity",
        );
      await snapshots.stream(res);
    }),
  );
  app.get(
    prefix + "/archive",
    route(async (req, res) => {
      if (req.headers["risu-runtime-id"] !== serverId)
        throw new RuntimeError(
          "SERVER_CHANGED",
          "Archive export requires the current database identity",
        );
      await archives.stream(res);
    }),
  );
  app.post(
    prefix + "/assets",
    route(async (req, res) => {
      if (req.headers["risu-runtime-id"] !== serverId)
        throw new RuntimeError(
          "SERVER_CHANGED",
          "Asset upload requires the current database identity",
        );
      if (
        req.headers["content-type"]?.split(";")[0] !==
        "application/octet-stream"
      )
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Asset upload requires application/octet-stream",
        );
      if (Number(req.headers["content-length"]) > MAX_ASSET_BYTES)
        throw new RuntimeError(
          "ASSET_TOO_LARGE",
          "Asset exceeds the 64 MiB upload limit",
        );
      res.json(await assets.upload(req, req.query.extension ?? "png"));
    }),
  );
  app.get(
    prefix + "/assets/:id",
    route(async (req, res) => {
      if (req.query.authority !== serverId)
        throw new RuntimeError(
          "SERVER_CHANGED",
          "Asset URL requires the current database identity",
        );
      const { file, value } = await assets.file(req.params.id);
      res.set({
        "Content-Type": value.mime,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        ETag: '"' + value.id + '"',
        "Content-Disposition":
          (value.mime === "application/octet-stream"
            ? "attachment"
            : "inline") +
          '; filename="' +
          value.id +
          '"',
      });
      const matches = (req.headers["if-none-match"] ?? "")
        .split(",")
        .map((value) => value.trim().replace(/^W\//, ""));
      if (matches.includes('"' + value.id + '"') || matches.includes("*")) {
        res.status(304).end();
        return;
      }
      await new Promise((resolve, reject) =>
        res.sendFile(file, { lastModified: false }, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    }),
  );
  // A UTF-8 file of at most 8 MiB can expand sixfold as JSON string escapes.
  // Grant that wire budget only to the current private UI owner; all ordinary
  // commands keep their existing budget. The broker checks the decoded bytes.
  app.use(
    prefix + "/plugin-ui/:id/effect",
    (req, _res, next) => {
      try {
        pluginOwners.owner(req.params.id, pluginIdentity(req));
        next();
      } catch (error) {
        next(error);
      }
    },
    express.json({ limit: "49mb" }),
  );
  app.use(express.json({ limit: "16mb" }));
  app.get(
    prefix + "/plugins/:id/capability",
    route(async (req, res) =>
      res.json(await pluginOwners.capability(req.params.id)),
    ),
  );
  function pluginIdentity(req) {
    if (req.headers["risu-runtime-id"] !== serverId)
      throw new RuntimeError(
        "SERVER_CHANGED",
        "Plugin UI requires the current database identity",
      );
    return req.headers["risu-plugin-owner"];
  }
  app.post(
    prefix + "/plugin-ui",
    route(async (req, res) => {
      pluginIdentity(req);
      const body = req.body;
      if (
        !body ||
        typeof body !== "object" ||
        Object.keys(body).some(
          (key) => !["pluginId", "chatId", "expectedChatEpoch"].includes(key),
        ) ||
        typeof body.pluginId !== "string" ||
        typeof body.chatId !== "string" ||
        body.pluginId.length > 256 ||
        body.chatId.length > 256
      )
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Plugin UI opening requires an installed plugin and captured chat",
        );
      res.json(await pluginOwners.open(body));
    }),
  );
  app.get(
    prefix + "/plugin-ui/:id",
    route(async (req, res) =>
      res.json(
        await pluginOwners.call(req.params.id, pluginIdentity(req), "snapshot"),
      ),
    ),
  );
  app.post(
    prefix + "/plugin-ui/:id/event",
    route(async (req, res) =>
      res.json(
        await pluginOwners.call(
          req.params.id,
          pluginIdentity(req),
          "dispatch",
          req.body,
        ),
      ),
    ),
  );
  app.post(
    prefix + "/plugin-ui/:id/effect",
    route(async (req, res) =>
      res.json(
        await pluginOwners.call(
          req.params.id,
          pluginIdentity(req),
          "resolveEffect",
          req.body,
        ),
      ),
    ),
  );
  app.get(
    prefix + "/plugin-ui/:id/artifact/:effectId",
    route(async (req, res) => {
      const artifact = await pluginOwners.call(
        req.params.id,
        pluginIdentity(req),
        "readArtifact",
        { effectId: req.params.effectId, eventId: req.query.eventId },
      );
      const bytes = Buffer.from(artifact?.bytes ?? []);
      if (
        bytes.length > 8 * 1024 * 1024 ||
        typeof artifact?.name !== "string" ||
        artifact.name.length > 256 ||
        /[\x00-\x1f\x7f/\\]/.test(artifact.name) ||
        !["application/json", "text/plain"].includes(artifact?.mime)
      )
        throw new RuntimeError(
          "INVALID_PLUGIN_UI_EFFECT",
          "Plugin artifact does not match its bounded transfer contract",
        );
      const asciiName = artifact.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      res.set({
        "Content-Type": artifact.mime + "; charset=utf-8",
        "Content-Length": String(bytes.length),
        "Content-Disposition":
          'attachment; filename="' +
          (asciiName || "wyglore.json") +
          "\"; filename*=UTF-8''" +
          encodeURIComponent(artifact.name),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(bytes);
    }),
  );
  app.post(
    prefix + "/plugin-ui/:id/close",
    route(async (req, res) =>
      res.json(
        await pluginOwners.closeOwner(req.params.id, pluginIdentity(req)),
      ),
    ),
  );
  app.get(
    prefix + "/plugin-ui-events/:id",
    route(async (req, res) => {
      pluginIdentity(req);
      const receipt = await store.call("readPluginUIEvent", {
        eventId: req.params.id,
        sessionId: req.query.sessionId,
      });
      if (!receipt)
        throw new RuntimeError(
          "NOT_FOUND",
          "Plugin UI event has no saved receipt",
        );
      res.json(receipt);
    }),
  );
  app.get(
    prefix + "/health",
    route(async (_req, res) =>
      res.json({
        ready: true,
        mode: "local-development",
        schema: await store.call("schemaVersion"),
        diagnostics: {
          dropped: diagnostics.dropped,
          writeFailures: diagnostics.writeFailures,
        },
      }),
    ),
  );
  app.get(
    prefix + "/bootstrap",
    route(async (_req, res) => res.json(await store.call("bootstrap"))),
  );
  app.get(
    prefix + "/interactions",
    route(async (req, res) =>
      res.json(
        await store.call("listInteractions", {
          limit: number(req.query.limit, "limit", 20),
          after: number(req.query.after, "after", 0),
        }),
      ),
    ),
  );
  app.get(
    prefix + "/interactions/:id",
    route(async (req, res) =>
      res.json(await store.call("readInteraction", req.params.id)),
    ),
  );
  app.get(
    prefix + "/notices",
    route(async (req, res) =>
      res.json(
        await store.call("listNotices", {
          limit: number(req.query.limit, "limit", 20),
          after: number(req.query.after, "after", 0),
        }),
      ),
    ),
  );
  app.get(
    prefix + "/notices/:id",
    route(async (req, res) =>
      res.json(await store.call("readNotice", req.params.id)),
    ),
  );
  app.get(
    prefix + "/characters/:id/chats",
    route(async (req, res) =>
      res.json(await store.call("listChats", req.params.id)),
    ),
  );
  app.get(
    prefix + "/characters/:id",
    route(async (req, res) => {
      const character = await store.call("getCharacter", req.params.id);
      if (!character)
        throw new RuntimeError("NOT_FOUND", "Character does not exist");
      res.json(character);
    }),
  );
  app.get(
    prefix + "/groups/:id/members/:memberId",
    route(async (req, res) =>
      res.json(
        await store.call("readGroupMember", req.params.id, req.params.memberId),
      ),
    ),
  );
  app.get(
    prefix + "/chats/:id",
    route(async (req, res) =>
      res.json(
        await store.call("snapshot", req.params.id, {
          limit: number(req.query.limit, "limit", 100),
          ...(req.query.before === undefined
            ? {}
            : { before: number(req.query.before, "before") }),
          ...(req.query.after === undefined
            ? {}
            : { after: number(req.query.after, "after") }),
          ...(req.query.around === undefined
            ? {}
            : { around: req.query.around }),
        }),
      ),
    ),
  );
  app.post(
    prefix + "/chats/:id/memory-source",
    route(async (req, res) =>
      res.json(await store.call("readMemorySource", req.params.id, req.body)),
    ),
  );
  app.get(
    prefix + "/chats/:id/bookmarks",
    route(async (req, res) =>
      res.json(
        await store.call("listBookmarks", req.params.id, {
          limit: number(req.query.limit, "limit", 50),
          ...(req.query.after === undefined ? {} : { after: req.query.after }),
        }),
      ),
    ),
  );
  app.get(
    prefix + "/chats/:id/bookmarks/:messageId",
    route(async (req, res) =>
      res.json(
        await store.call("readBookmark", req.params.id, req.params.messageId, {
          ...(req.query.observedCursor === undefined
            ? {}
            : {
                observedCursor: number(
                  req.query.observedCursor,
                  "observedCursor",
                ),
              }),
        }),
      ),
    ),
  );
  app.get(
    prefix + "/chats/:id/job-history",
    route(async (req, res) =>
      res.json(
        await store.call("listJobHistory", req.params.id, {
          expectedEpoch: number(req.query.expectedEpoch, "expectedEpoch"),
          limit: number(req.query.limit, "limit", 20),
          ...(req.query.filter === undefined
            ? {}
            : { filter: req.query.filter }),
          ...(req.query.after === undefined ? {} : { after: req.query.after }),
        }),
      ),
    ),
  );
  app.get(
    prefix + "/chats/:id/jobs",
    route(async (req, res) =>
      res.json(
        await store.call(
          "listJobs",
          req.params.id,
          number(req.query.limit, "limit", 50),
        ),
      ),
    ),
  );
  app.get(
    prefix + "/chats/:id/choices",
    route(async (req, res) =>
      res.json(
        await store.call(
          "readReplyChoices",
          req.params.id,
          req.query.messageId,
          number(req.query.revision, "revision"),
          number(req.query.epoch, "epoch"),
        ),
      ),
    ),
  );
  app.get(
    prefix + "/chats/:id/display",
    route(async (req, res) =>
      res.json(
        await store.call("displayState", req.params.id, {
          limit: number(req.query.limit, "limit", 100),
          ...(req.query.after === undefined ? {} : { after: req.query.after }),
        }),
      ),
    ),
  );
  app.get(
    prefix + "/resources/:kind/:id",
    route(async (req, res) => {
      const resource = await store.call(
        "getResourceSnapshot",
        req.params.kind,
        req.params.id,
      );
      if (!resource)
        throw new RuntimeError("NOT_FOUND", "Resource does not exist");
      res.json(resource);
    }),
  );
  app.post(
    prefix + "/variables/read",
    route(async (req, res) =>
      res.json(await store.call("readVariables", req.body?.targets)),
    ),
  );
  app.get(
    prefix + "/libraries/:kind",
    route(async (req, res) =>
      res.json(
        await store.call("listLibrary", req.params.kind, {
          limit: number(req.query.limit, "limit", 50),
          search: req.query.search ?? "",
          after: req.query.after,
        }),
      ),
    ),
  );
  app.post(
    prefix + "/libraries/module/resolve",
    route(async (req, res) =>
      res.json(await store.call("resolveModuleCatalog", req.body?.tokens)),
    ),
  );
  app.post(
    prefix + "/fields/read",
    route(async (req, res) =>
      res.json(await store.call("readFields", req.body?.targets)),
    ),
  );
  app.post(
    prefix + "/groups/:id/image-sources",
    route(async (req, res) => {
      res.json(
        await store.call(
          "groupImageSources",
          req.params.id,
          req.body?.offset ?? 0,
          req.body?.expected,
        ),
      );
    }),
  );
  app.post(
    [prefix + "/commands", prefix + "/commands/guarded-fields"],
    route(async (req, res) => {
      if (
        req.path.endsWith("/guarded-fields") &&
        (req.body?.command?.type !== "change-fields" ||
          (!req.body.command.groupImageSources &&
            !req.body.command.checks?.length))
      )
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Guarded admission requires field read dependencies",
        );
      const apply = () =>
        store.call("applyCommand", req.body?.requestId, req.body?.command);
      const result = ["retry-job-result", "move-reply-choice"].includes(
        req.body?.command?.type,
      )
        ? await pluginOwners.yieldToGeneration(apply)
        : await apply();
      if (
        (result.disposition?.action === "retry" && !result.alreadyApplied) ||
        (result.kind === "generation" && typeof result.jobId === "string")
      )
        scheduler.kick();
      res.json(result);
    }),
  );
  app.post(
    prefix + "/jobs",
    route(async (req, res) => {
      const admit = () =>
        store.call("enqueueJob", req.body?.requestId, req.body?.command);
      // Character buttons use only reviewed request-inert plugin admission.
      // They never claim the memory namespace, so an open settings realm does
      // not need to flush and shut down before accepting each interaction.
      const job =
        req.body?.command?.type === "button"
          ? await admit()
          : await pluginOwners.yieldToGeneration(admit);
      scheduler.kick();
      res.status(202).json({ accepted: true, job: publicJob(job) });
    }),
  );
  app.get(
    prefix + "/jobs/:id",
    route(async (req, res) => {
      const job = await store.call("getJob", req.params.id);
      if (!job) throw new RuntimeError("NOT_FOUND", "Job does not exist");
      res.json(publicJob(job));
    }),
  );
  app.post(
    prefix + "/jobs/:id/cancel",
    route(async (req, res) => {
      const job = await store.call("requestCancel", req.params.id);
      if (job.state === "running") scheduler.cancel(job.id);
      res.json(publicJob(job));
    }),
  );
  app.get(
    prefix + "/jobs/:id/status",
    route(async (req, res) => {
      const job = await store.call("getJobStatus", req.params.id);
      if (!job) throw new RuntimeError("NOT_FOUND", "Job does not exist");
      res.json(job);
    }),
  );
  app.get(
    prefix + "/jobs/:id/result",
    route(async (req, res) => {
      res.json(await store.call("previewJobResult", req.params.id));
    }),
  );
  app.get(
    prefix + "/jobs/:id/memory-summary",
    route(async (req, res) => {
      res.json(await store.call("previewMemorySummary", req.params.id));
    }),
  );
  app.get(
    prefix + "/jobs/:id/command",
    route(async (req, res) => {
      const command = await store.call("getJobCommand", req.params.id);
      if (!command)
        throw new RuntimeError("NOT_FOUND", "Job command does not exist");
      res.json(command);
    }),
  );
  app.get(
    prefix + "/changes",
    route(async (req, res) =>
      res.json(
        await store.call(
          "changes",
          number(req.query.after, "after", 0),
          number(req.query.limit, "limit", 100),
        ),
      ),
    ),
  );
  app.get(
    prefix + "/events",
    route(async (req, res) => {
      let cursor = number(
          req.headers["last-event-id"] ?? req.query.after,
          "after",
        ),
        closed = false,
        busy = false;
      let page = await store.call("changes", cursor, 100);
      if (req.aborted || res.destroyed) return;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      res.write(": connected\n\n");
      const stop = () => {
        closed = true;
        clearInterval(timer);
        feeds.delete(stop);
        if (!res.destroyed) res.end();
      };
      const drain = async () => {
        if (closed || busy) return;
        busy = true;
        try {
          while (!closed) {
            page ??= await store.call("changes", cursor, 100);
            for (const change of page.changes) {
              if (closed) break;
              const accepted = res.write(
                "id: " +
                  change.sequence +
                  "\nevent: change\ndata: " +
                  JSON.stringify(change) +
                  "\n\n",
              );
              cursor = change.sequence;
              // Bound slow-client buffers; reconnection replays from the browser's last event ID.
              if (!accepted) {
                stop();
                break;
              }
            }
            const caughtUp = cursor >= page.head;
            page = null;
            if (caughtUp) break;
          }
        } catch (error) {
          if (!closed)
            recordRequestFailure(
              diagnostics,
              req,
              error.code ?? "STREAM_ERROR",
              500,
              "stream-reset",
            );
          if (!closed)
            res.write(
              "event: reset\ndata: " +
                JSON.stringify({
                  code: error.code ?? "STREAM_ERROR",
                  details: error.details ?? {},
                  requestId: req.runtimeRequestId,
                }) +
                "\n\n",
            );
          stop();
        } finally {
          busy = false;
        }
      };
      const timer = setInterval(drain, options.eventsPollMs ?? 200);
      feeds.add(stop);
      res.once("close", stop);
      await drain();
    }),
  );
  app.use((_req, _res, next) =>
    next(new RuntimeError("NOT_FOUND", "Unknown runtime endpoint")),
  );
  app.use((error, req, res, _next) => {
    const status =
      error.status ??
      {
        INVALID_COMMAND: 400,
        INVALID_INTERACTION: 400,
        INVALID_INTERACTION_ANSWER: 400,
        INTERACTION_LIMIT: 413,
        INTERACTION_ALREADY_ANSWERED: 409,
        INTERACTION_CLOSED: 409,
        INTERACTION_PENDING: 409,
        INTERACTION_BUSY: 409,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        REVISION_CONFLICT: 409,
        DISPLAY_INPUT_CHANGED: 409,
        IDEMPOTENCY_CONFLICT: 409,
        CHAT_BUSY: 409,
        LAST_CHAT: 409,
        LAST_RESOURCE: 409,
        IDENTITY_CONFLICT: 409,
        DEPENDENCY_PENDING: 409,
        RESYNC_REQUIRED: 409,
        SERVER_CHANGED: 409,
        PLUGIN_STORAGE_BUSY: 409,
        STALE_PLUGIN_WORKER: 409,
        PLUGIN_UI_EVENT_UNCERTAIN: 409,
        PLUGIN_UI_STALE: 409,
        PLUGIN_UI_REVISION_CHANGED: 409,
        PLUGIN_UI_NODE_CHANGED: 409,
        PLUGIN_UI_DISABLED: 409,
        PLUGIN_UI_SCOPE_CHANGED: 409,
        PLUGIN_UI_CLOSED: 409,
        PLUGIN_UI_BUSY: 409,
        PLUGIN_UI_CANCEL_UNSAFE: 409,
        INVALID_PLUGIN_UI: 400,
        INVALID_PLUGIN_UI_EVENT: 400,
        INVALID_PLUGIN_UI_SCOPE: 400,
        INVALID_PLUGIN_UI_VALUE: 400,
        INVALID_PLUGIN_UI_TARGET: 400,
        INVALID_PLUGIN_UI_EFFECT: 400,
        PLUGIN_UI_EFFECT_CLOSED: 409,
        PLUGIN_UI_EFFECT_LIMIT: 413,
        PLUGIN_UI_EFFECT_FAILED: 422,
        PLUGIN_UNSUPPORTED: 422,
        PLUGIN_CAPABILITY_REQUIRED: 422,
        PLUGIN_UI_CAPABILITY_REQUIRED: 422,
        INVALID_PLUGIN_UI_CSS: 400,
        PLUGIN_UI_LIMIT: 413,
        PLUGIN_CATALOG_UNSUPPORTED: 422,
        PLUGIN_CATALOG_LIMIT: 413,
        SELECTION_CONFLICT: 409,
        ASSET_TOO_LARGE: 413,
        ARCHIVE_TOO_LARGE: 413,
        ARCHIVE_BUSY: 409,
        ARCHIVE_UNSUPPORTED_RESOURCE: 409,
        ARCHIVE_MISSING_RESOURCE: 409,
      }[error.code] ??
      500;
    recordRequestFailure(
      diagnostics,
      req,
      error.code ?? "RUNTIME_ERROR",
      status,
    );
    if (res.headersSent) return res.end();
    res.status(status).json({
      error: {
        code: error.code ?? "RUNTIME_ERROR",
        message: error.message,
        details: error.details ?? {},
        requestId: req.runtimeRequestId,
      },
    });
  });
  const server = createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", resolve);
    });
    address = {
      host: "127.0.0.1",
      url: "http://127.0.0.1:" + server.address().port,
    };
    scheduler = new NativeScheduler({ ...options.scheduler, file, store });
  } catch (error) {
    server.close();
    await assets.close();
    await pluginOwners.close();
    await store.close();
    await diagnostics.close();
    throw error;
  }
  let closing;
  const close = () =>
    (closing ??= (async () => {
      for (const stop of [...feeds]) stop();
      await archives.close();
      await snapshots.close();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      await scheduler.close();
      await pluginOwners.close();
      await assets.close();
      await store.close();
      await diagnostics.close();
    })());
  return {
    url: address.url,
    file,
    store,
    scheduler,
    pluginOwners,
    assets,
    diagnostics,
    server,
    close,
  };
}
module.exports = { createRuntimeService };
