"use strict";
const { createServer } = require("node:http");

// Only the local trial uses this deterministic provider; it never forwards requests.
async function createLocalTrialProvider({ delayMs = 8000 } = {}) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 30000)
    throw Error("INVALID_TRIAL_DELAY");
  const stats = {
    accepted: 0,
    completed: 0,
    aborted: 0,
    active: 0,
    maxActive: 0,
  };
  const waits = new Set();
  const server = createServer(async (req, res) => {
    if (req.headers.host !== "127.0.0.1:" + server.address().port) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ready: true, syntheticOnly: true, ...stats }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!body || Array.isArray(body) || !Array.isArray(body.messages)) {
        res.writeHead(400).end();
        return;
      }
      const n = ++stats.accepted;
      stats.active++;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      let ended = false,
        timer,
        finishWait;
      const finish = (aborted) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        waits.delete(finishWait);
        stats.active--;
        stats[aborted ? "aborted" : "completed"]++;
        finishWait?.();
      };
      res.once("close", () => finish(!res.writableEnded));
      const first = `연습 응답 ${n}: 처리 중입니다.`;
      const last =
        "\n\n완료했습니다. 다른 창에서도 같은 응답과 선택 값을 확인하세요.";
      const delta = (content) =>
        "data: " +
        JSON.stringify({ choices: [{ index: 0, delta: { content } }] }) +
        "\n\n";
      if (body.stream) {
        res.setHeader("content-type", "text/event-stream");
        res.write(delta(first));
      }
      await new Promise((resolve) => {
        finishWait = resolve;
        waits.add(resolve);
        timer = setTimeout(resolve, delayMs);
      });
      waits.delete(finishWait);
      if (res.destroyed || ended) return;
      if (body.stream) res.end(delta(last) + "data: [DONE]\n\n");
      else {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: first + last },
                finish_reason: "stop",
              },
            ],
          }),
        );
      }
      finish(false);
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(400).end();
      else if (!res.destroyed) res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let closing;
  return {
    url: "http://127.0.0.1:" + server.address().port,
    stats,
    close: () =>
      (closing ??= new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
        for (const finish of waits) finish();
      })),
  };
}
module.exports = { createLocalTrialProvider };
if (require.main === module) {
  createLocalTrialProvider({
    delayMs: Number(process.env.RISU_LOCAL_TRIAL_DELAY_MS ?? 8000),
  })
    .then((provider) => {
      process.send?.({ ready: true, url: provider.url });
      const close = () =>
        provider.close().then(() => {
          if (process.connected) process.disconnect();
        });
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      process.once("disconnect", () => void provider.close());
    })
    .catch(() => {
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
}
