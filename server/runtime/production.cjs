"use strict";
const express = require("express");
const { createServer, request } = require("node:http");
const { createHash, createHmac, timingSafeEqual } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const { createRuntimeService } = require("./service.cjs");
const { traceRequest, recordRequestFailure } = require("./diagnostics.cjs");

const COOKIE = "risu-entity-session";
const LOGIN = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Risu AI 로그인</title><style>body{font:16px system-ui;background:#171820;color:#eee;display:grid;place-items:center;min-height:90vh}form{width:min(80vw,320px)}input,button{box-sizing:border-box;width:100%;padding:14px;margin-top:12px;border-radius:8px;border:1px solid #555;font:inherit}button{cursor:pointer}</style><form method="post" action="/login"><h1>Risu AI</h1><label for="password">기존 서비스 비밀번호</label><input id="password" name="password" type="password" autocomplete="current-password" required><button>접속</button><p role="alert">__ERROR__</p></form></html>`;
function equal(a, b) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function createProductionService(options) {
  const secret = (await readFile(options.passwordFile, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("INVALID_PASSWORD_FILE");
  const origin = new URL(options.origin);
  if (!options.insecureLocalTest && origin.protocol !== "https:")
    throw new Error("HTTPS_ORIGIN_REQUIRED");
  const runtime = await createRuntimeService({
    ...options.runtime,
    initialize: false,
    file: options.file,
    origins: [origin.origin],
  });
  try {
    if (!(await runtime.store.call("getResource", "settings", "global")))
      throw new Error("RESTORED_DATABASE_REQUIRED");
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const app = express(),
    attempts = new Map();
  app.disable("x-powered-by");
  const cookie = (value, age) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${options.insecureLocalTest ? "" : "; Secure"}`;
  const sign = (value) =>
    createHmac("sha256", secret)
      .update("risu-entity:" + value)
      .digest("base64url");
  function authenticated(req) {
    const raw = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(COOKIE + "="))
      ?.slice(COOKIE.length + 1);
    const [expires, signature, extra] = (raw ?? "").split(".");
    const now = Math.floor(Date.now() / 1000);
    return (
      !extra &&
      /^\d{10}$/.test(expires ?? "") &&
      Number(expires) > now &&
      Number(expires) <= now + 7 * 86400 &&
      typeof signature === "string" &&
      equal(signature, sign(expires))
    );
  }
  let server;
  const failure = (req, res, status, code) => {
    recordRequestFailure(runtime.diagnostics, req, code, status, "front-error");
    return res
      .status(status)
      .json({ error: { code, requestId: req.runtimeRequestId } });
  };
  app.use((req, res, next) => {
    traceRequest(req, res);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const local = "http://127.0.0.1:" + server?.address()?.port;
    const hosts = new Set([
      origin.host,
      "127.0.0.1:" + server?.address()?.port,
      ...(options.localHosts ?? []),
    ]);
    if (
      !hosts.has(req.headers.host) ||
      (req.headers.origin &&
        req.headers.origin !== origin.origin &&
        !(options.insecureLocalTest && req.headers.origin === local)) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return failure(req, res, 403, "FORBIDDEN");
    next();
  });
  app.get("/_health", async (req, res) => {
    const metadata = {
      engine: "native-entity",
      version: options.version ?? "development",
      diagnostics: {
        dropped: runtime.diagnostics.dropped,
        writeFailures: runtime.diagnostics.writeFailures,
      },
    };
    try {
      const schema = await runtime.store.call("schemaVersion");
      res.json({ ready: true, schema, ...metadata });
    } catch {
      recordRequestFailure(
        runtime.diagnostics,
        req,
        "STORE_UNAVAILABLE",
        503,
        "front-error",
      );
      res.status(503).json({
        ready: false,
        ...metadata,
        error: { code: "STORE_UNAVAILABLE", requestId: req.runtimeRequestId },
      });
    }
  });
  app.get("/login", (req, res) =>
    authenticated(req)
      ? res.redirect(303, "/")
      : res.type("html").send(LOGIN.replace("__ERROR__", "")),
  );
  app.post(
    "/login",
    express.urlencoded({ extended: false, limit: "4kb" }),
    (req, res) => {
      const key = req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress;
      const now = Date.now();
      for (const [id, entry] of attempts)
        if (entry.until < now) attempts.delete(id);
      let entry = attempts.get(key);
      if (!entry) {
        if (attempts.size >= 10000)
          return failure(req, res, 429, "AUTH_REQUIRED");
        attempts.set(key, (entry = { count: 0, until: now + 15 * 60 * 1000 }));
      }
      if (++entry.count > 20) {
        recordRequestFailure(
          runtime.diagnostics,
          req,
          "AUTH_REQUIRED",
          429,
          "front-error",
        );
        return res
          .status(429)
          .type("html")
          .send(LOGIN.replace("__ERROR__", "잠시 후 다시 시도해주세요."));
      }
      const password = req.body?.password;
      if (
        typeof password !== "string" ||
        !equal(createHash("sha256").update(password).digest("hex"), secret)
      ) {
        recordRequestFailure(
          runtime.diagnostics,
          req,
          "AUTH_REQUIRED",
          401,
          "front-error",
        );
        return res
          .status(401)
          .type("html")
          .send(LOGIN.replace("__ERROR__", "비밀번호가 일치하지 않습니다."));
      }
      attempts.delete(key);
      const expires = String(Math.floor(Date.now() / 1000) + 7 * 86400);
      res.setHeader(
        "Set-Cookie",
        cookie(expires + "." + sign(expires), 7 * 86400),
      );
      res.redirect(303, "/");
    },
  );
  app.use((req, res, next) => {
    if (authenticated(req)) return next();
    if (req.path.startsWith("/api/"))
      return failure(req, res, 401, "AUTH_REQUIRED");
    return res.redirect(303, "/login");
  });
  app.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", cookie("", 0));
    res.redirect(303, "/login");
  });
  app.use("/api/runtime", (req, res) => {
    const target = new URL(runtime.url);
    const headers = {
      ...req.headers,
      host: target.host,
      "risu-request-id": req.runtimeRequestId,
    };
    // Only the front door owns sessions; the internal API is loopback-only.
    delete headers.cookie;
    if (
      options.insecureLocalTest &&
      headers.origin === "http://127.0.0.1:" + server.address().port
    )
      headers.origin = origin.origin;
    const upstream = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: req.originalUrl,
        method: req.method,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (req.aborted || res.destroyed) return;
      if (!res.headersSent) failure(req, res, 502, "RUNTIME_UNAVAILABLE");
      else {
        recordRequestFailure(
          runtime.diagnostics,
          req,
          "RUNTIME_UNAVAILABLE",
          502,
          "front-error",
        );
        res.destroy();
      }
    });
    req.once("aborted", () => upstream.destroy());
    res.once("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream);
  });
  app.use(
    express.static(resolve(options.staticDirectory), {
      index: "index.html",
      dotfiles: "deny",
      setHeaders: (res, path) => {
        if (path.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
        else res.setHeader("Cache-Control", "private, max-age=3600");
      },
    }),
  );
  app.use((req, res) => failure(req, res, 404, "NOT_FOUND"));
  app.use((_error, req, res, _next) => {
    if (!res.headersSent) failure(req, res, 400, "INVALID_REQUEST");
    else res.end();
  });
  server = createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 6001, options.host ?? "0.0.0.0", resolve);
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }
  let closing;
  const close = () =>
    (closing ??= (async () => {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      await runtime.close();
    })());
  return {
    url: "http://127.0.0.1:" + server.address().port,
    runtime,
    server,
    close,
  };
}
module.exports = { createProductionService };
if (require.main === module) {
  createProductionService({
    origin: process.env.RISU_PUBLIC_ORIGIN,
    file: process.env.RISU_RUNTIME_DATABASE,
    passwordFile: process.env.RISU_PASSWORD_FILE,
    staticDirectory: process.env.RISU_STATIC_DIRECTORY,
    version: process.env.RISU_RELEASE_VERSION,
    localHosts: (process.env.RISU_LOCAL_HOSTS ?? "").split(",").filter(Boolean),
    port: Number(process.env.RISU_HTTP_PORT ?? 6001),
    runtime: {
      port: Number(process.env.RISU_RUNTIME_PORT ?? 6174),
      scheduler: {
        reviewedPlugins: process.env.RISU_REVIEWED_SERVER_PLUGINS === "TRUE",
        concurrency: 2,
        onError: (error) =>
          console.error(
            JSON.stringify({ schedulerError: error.code ?? error.name }),
          ),
      },
    },
  })
    .then((service) => {
      console.log(JSON.stringify({ ready: true, engine: "native-entity" }));
      const close = () =>
        service.close().catch(() => {
          process.exitCode = 1;
        });
      process.once("SIGTERM", close);
      process.once("SIGINT", close);
    })
    .catch(() => {
      console.error("Production runtime could not start");
      process.exitCode = 1;
    });
}
