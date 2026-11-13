"use strict";
const { fork, spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdir, mkdtemp, writeFile, access } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { EntityStore } = require("../entity/store.cjs");
const { createProductionService } = require("./production.cjs");
const { createNativeProcessWorker } = require("../native/processWorker.cjs");
const root = resolve(__dirname, "../..");
const TRIAL_PASSWORD = "local-trial";

async function createTrialDirectory(
  parent = join(root, ".local-runtime/trials"),
) {
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(resolve(parent), "trial-"));
}
async function startTrialProvider(delayMs) {
  const child = fork(join(__dirname, "localTrialProvider.cjs"), [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, RISU_LOCAL_TRIAL_DELAY_MS: String(delayMs) },
  });
  let readyTimer;
  try {
    const ready = await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(Error("TRIAL_PROVIDER_START_FAILED")));
      readyTimer = setTimeout(
        () => reject(Error("TRIAL_PROVIDER_START_TIMEOUT")),
        10000,
      );
    });
    const url = new URL(ready.url);
    if (
      !ready.ready ||
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port
    )
      throw Error("INVALID_TRIAL_PROVIDER");
    let closing;
    return {
      child,
      url: url.origin,
      close: () =>
        (closing ??= (async () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const exited = once(child, "exit");
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
          try {
            await exited;
          } finally {
            clearTimeout(timer);
          }
        })()),
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit").catch(() => {});
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    throw error;
  } finally {
    clearTimeout(readyTimer);
  }
}
async function createLocalTrial(options = {}) {
  const port = options.port ?? 5176,
    delayMs = options.delayMs ?? 8000;
  if (
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !Number.isSafeInteger(delayMs) ||
    delayMs < 0 ||
    delayMs > 30000
  )
    throw Error("INVALID_TRIAL_OPTIONS");
  const staticDirectory = resolve(
    options.staticDirectory ?? join(root, ".local-runtime/trial-ui"),
  );
  await access(join(staticDirectory, "index.html"));
  const bundlePath = resolve(
    options.bundlePath ?? join(__dirname, "../native/dist/extensionJob.mjs"),
  );
  await access(bundlePath);
  options.signal?.throwIfAborted();
  const directory = await createTrialDirectory(options.parent);
  const file = join(directory, "entity.sqlite"),
    passwordFile = join(directory, "password.sha256");
  let provider, service;
  try {
    provider = await startTrialProvider(delayMs);
    options.signal?.throwIfAborted();
    const { createInitialRuntimeState } = await import(
      pathToFileURL(bundlePath).href
    );
    const state = createInitialRuntimeState();
    Object.assign(state.settings, {
      didFirstSetup: true,
      language: "ko",
      autoTranslate: false,
      sendWithEnter: true,
      aiModel: "reverse_proxy",
      customProxyRequestModel: "risu-local-trial",
      customTokenizer: "tik",
      forceReplaceUrl: provider.url + "/v1/chat/completions",
      proxyKey: "",
      useStreaming: true,
      streamingDisplayOptimizationMode: "strong",
      maxContext: 8000,
      maxResponse: 200,
      mainPrompt:
        "You are a neutral assistant in an authored local structural test.",
      jailbreakToggle: false,
      presetChain: "",
      // Keep the small trial's prefix inside the original bounded history window.
      chatLoadInitialPages: 30,
      localActivationInGlobalLorebook: true,
      bulkEnabling: true,
    });
    const store = new EntityStore(file);
    try {
      store.initializeState(state);
      store.applyCommand("trial-character", {
        type: "create-character",
        characterId: "local-trial-character",
        definition: {
          type: "character",
          creatorNotes: "합성 제작자 메모",
          alternateGreetings: ["합성 대체 인사 1", "합성 대체 인사 2"],
          name: "로컬 구조 시험",
          desc: "비용 없는 합성 응답으로 동기화와 서버 처리를 시험합니다.",
          supaMemory: false,
          defaultVariables: "counter=0\nlast_reply=대기",
          globalLore: [
            {
              id: "local-trial-lore",
              key: "로컬시험",
              comment: "합성 로어 편집 시험",
              content:
                "공개 개발 코드와 합성 데이터로 저장·동기화를 시험합니다.",
              mode: "normal",
              insertorder: 100,
              alwaysActive: false,
              secondkey: "",
              selective: false,
            },
          ],
          customModuleToggle: "trial=동기화 시험 토글",
          firstMessage: `<p>비용 없는 테스트 응답입니다. 응답 완료까지 약 ${delayMs / 1000}초 걸립니다.</p><button risu-btn="trial-counter">카운터 +1</button><p>카운터: {{getvar::counter}} / 마지막 응답: {{getvar::last_reply}}</p>`,
          triggerscript: [
            {
              comment: "Local trial controls",
              type: "manual",
              conditions: [],
              effect: [
                {
                  type: "triggerlua",
                  code: `function onButtonClick(id,data)
  if data=='trial-counter' then
    local n=tonumber(getChatVar(id,'counter')) or 0
    setChatVar(id,'counter',tostring(n+1))
  end
end
listenEdit('editOutput',function(id,data)
  setChatVar(id,'last_reply','완료')
  return data
end)`,
                },
              ],
            },
          ],
        },
        chat: {
          chatId: "local-trial-a",
          metadata: { name: "기본 채팅", localLore: [] },
        },
      });
      store.applyCommand("trial-chat-b", {
        type: "create-chat",
        characterId: "local-trial-character",
        chatId: "local-trial-b",
        metadata: { name: "독립 채팅", localLore: [] },
      });
      store.applyCommand("trial-prefix", {
        type: "append-message",
        chatId: "local-trial-a",
        messageId: "local-trial-prefix",
        message: {
          role: "char",
          data: '이 메시지는 응답 중에도 유지됩니다. <img alt="로컬 시험 이미지" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg2JLyHwAD6AIYhAHF9gAAAABJRU5ErkJggg==">',
        },
      });
    } finally {
      store.close();
    }
    await writeFile(
      passwordFile,
      createHash("sha256").update(TRIAL_PASSWORD).digest("hex"),
      { flag: "wx", mode: 0o600 },
    );
    service = await createProductionService({
      file,
      passwordFile,
      staticDirectory,
      host: "127.0.0.1",
      port,
      origin: "http://127.0.0.1:" + port,
      insecureLocalTest: true,
      version: "local-trial",
      runtime: {
        port: 0,
        eventsPollMs: 20,
        scheduler: {
          concurrency: 2,
          pollMs: 20,
          progressIntervalMs: 25,
          workerFactory: (claimed) =>
            createNativeProcessWorker({
              file,
              claimed,
              progressIntervalMs: 25,
              bundlePath,
            }),
        },
      },
    });
    options.signal?.throwIfAborted();
    let closing;
    const close = () =>
      (closing ??= (async () => {
        await service.close();
        await provider.close();
      })());
    if (provider.child.exitCode !== null || provider.child.signalCode !== null)
      throw Error("TRIAL_PROVIDER_STOPPED");
    provider.child.once("exit", () => {
      if (!closing) {
        options.onProviderExit?.();
        void close();
      }
    });
    await writeFile(
      join(directory, "trial.json"),
      JSON.stringify(
        {
          version: 1,
          syntheticOnly: true,
          url: service.url,
          providerUrl: provider.url,
          delayMs,
          schema: 21,
          staticDirectory,
          bundlePath,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    return {
      ...service,
      directory,
      file,
      providerUrl: provider.url,
      providerPid: provider.child.pid,
      delayMs,
      close,
    };
  } catch (error) {
    await service?.close();
    await provider?.close();
    throw error;
  }
}
async function buildTrialUi(signal) {
  const directory = await createTrialDirectory(
    process.env.RISU_LOCAL_TRIAL_PARENT,
  );
  const build = (args, env = process.env) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: root,
        env,
        stdio: "inherit",
        signal,
        killSignal: "SIGTERM",
      });
      let startError;
      child.once("error", (error) => {
        startError = error;
      });
      child.once("close", (code) =>
        startError
          ? reject(startError)
          : code === 0
            ? resolve()
            : reject(Error("TRIAL_BUILD_FAILED")),
      );
      process.send?.({ building: true, pid: child.pid, directory });
    });
  const native = join(directory, "native");
  await build([
    "node_modules/vite/bin/vite.js",
    "build",
    "--config",
    "vite.native.config.ts",
    "--outDir",
    native,
  ]);
  const ui = join(directory, "ui");
  await build(["node_modules/vite/bin/vite.js", "build", "--outDir", ui], {
    ...process.env,
    VITE_RISU_ENTITY_RUNTIME: "TRUE",
    VITE_RISU_LEGAL_CONFIGURED: "TRUE",
  });
  return { staticDirectory: ui, bundlePath: join(native, "extensionJob.mjs") };
}
module.exports = { createLocalTrial, createTrialDirectory, TRIAL_PASSWORD };
if (require.main === module) {
  const abort = new AbortController();
  let trial;
  const close = () => {
    abort.abort(Error("TRIAL_STOPPED"));
    void trial?.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  (async () => {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === "--built-ui"))
      throw Error(
        "Usage: node server/runtime/localTrial.cjs [--built-ui PATH]",
      );
    const artifacts = args.length
      ? { staticDirectory: resolve(args[1]) }
      : await buildTrialUi(abort.signal);
    abort.signal.throwIfAborted();
    trial = await createLocalTrial({
      ...artifacts,
      signal: abort.signal,
      parent: process.env.RISU_LOCAL_TRIAL_PARENT,
      port: Number(process.env.RISU_LOCAL_TRIAL_PORT ?? 5176),
      delayMs: Number(process.env.RISU_LOCAL_TRIAL_DELAY_MS ?? 8000),
      onProviderExit: () => {
        console.error("TRIAL_PROVIDER_STOPPED");
        process.exitCode = 1;
      },
    });
    console.log("로컬 Risu 시험:", trial.url);
    console.log("새 시험용 비밀번호:", TRIAL_PASSWORD);
    console.log("시험 데이터:", trial.directory);
    console.log(
      "두 브라우저 창에서 ‘로컬 구조 시험’을 선택하세요. Ctrl+C로 종료하며 시험 데이터는 남습니다.",
    );
    process.send?.({
      ready: true,
      url: trial.url,
      providerUrl: trial.providerUrl,
      providerPid: trial.providerPid,
      directory: trial.directory,
    });
  })().catch((error) => {
    if (abort.signal.aborted) return;
    console.error(error.code ?? error.message);
    process.exitCode = 1;
  });
}
