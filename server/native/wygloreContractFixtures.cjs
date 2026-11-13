"use strict";

// Synthetic-only executable contract fixture. No user records or live provider
// credentials are read. This is deliberately separate from the production host.
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { instrumentWygloreLifecycle } = require("./wygloreContract.cjs");

function makeWygloreContractFixture(options = {}) {
  const chat = options.chat || {
    id: "synthetic-garden-chat-1",
    name: "Synthetic garden",
    message: [
      {
        role: "char",
        data: "Welcome to the garden.",
        chatId: "synthetic-greeting-1",
      },
      {
        role: "user",
        data: "My favorite flowers are blue.",
        chatId: "synthetic-user-1",
      },
    ],
    localLore: [],
    scriptstate: {},
  };
  if (!options.chat && options.longChat) {
    for (let i = 2; i < 20; i++)
      chat.message.push({
        role: i % 2 ? "user" : "char",
        data:
          i % 2
            ? "I water the blue flowers."
            : "Green waters the blue garden flowers.",
        chatId: `synthetic-message-${i}`,
      });
  }
  const character = {
    chaId: "synthetic-garden-character-1",
    type: "character",
    name: "Synthetic Garden",
    desc: "A gardener named Green welcomes visitors.",
    firstMessage: "Welcome to the garden.",
    chats: [chat],
    chatPage: 0,
    globalLore: [],
    sdData: [],
    bias: [],
    triggers: [],
    customscript: [],
  };
  const database = {
    characters: [character],
    modules: [],
    enabledModules: [],
    moduleIntergration: [],
    globalChatVariables: {},
    personas: [],
    selectedPersona: 0,
    maxContext: 16000,
    maxResponse: 1000,
    mainPrompt: "",
    globalNote: "",
  };
  const settings = {
    coldStartAuto: !!options.longChat,
    speedMode: "fast",
    backgroundFirstEnabled: true,
    canonicalIngestEnabled: true,
    shortTermWindow: 4,
    cbsToggleFloatEnabled: false,
    updateCheckEnabled: false,
    ...options.settings,
  };
  const storage = options.storage || new Map();
  storage.set("wl.globalSettings.v1", JSON.stringify(settings));
  if (options.longChat) {
    storage.set(
      "wl.llm.config",
      JSON.stringify({
        completeProviderId: "custom-openai",
        completeModel: "synthetic-test",
        maxConcurrent: 3,
      }),
    );
    storage.set("wl.provider.custom-openai.apiKey", "synthetic-key");
    storage.set(
      "wl.provider.custom-openai.baseUrl",
      "https://synthetic.invalid/v1",
    );
  }
  const calls = [];
  const registrations = [];
  const hooks = { beforeRequest: [], afterRequest: [] };
  const unload = [];
  const timers = new Set();
  const clone = (value) => structuredClone(value);
  const host = {
    log: (...args) =>
      calls.push({ method: "log", text: args.map(String).join(" ") }),
    pluginStorage: {
      getItem: async (key) => clone(storage.get(key) ?? null),
      setItem: async (key, value) => {
        calls.push({ method: "storage.write", key });
        storage.set(key, clone(value));
      },
      removeItem: async (key) => {
        calls.push({ method: "storage.remove", key });
        storage.delete(key);
      },
      keys: async () => [...storage.keys()],
    },
    registerSetting: async (...args) =>
      registrations.push({ type: "setting", args }),
    registerButton: async (...args) =>
      registrations.push({ type: "button", args }),
    addRisuReplacer: async (type, fn) => hooks[type].push(fn),
    removeRisuReplacer: async (type, fn) => {
      hooks[type] = hooks[type].filter((candidate) => candidate !== fn);
    },
    onUnload: async (fn) => unload.push(fn),
    getCurrentCharacterIndex: async () => 0,
    getCurrentChatIndex: async () => 0,
    getCharacter: async () => clone(character),
    getChatFromIndex: async (ci, pi) => {
      if (ci !== 0 || pi !== 0)
        throw new Error("Synthetic contract: scope denied");
      return clone(chat);
    },
    setChatToIndex: async (ci, pi, next) => {
      if (ci !== 0 || pi !== 0 || next.id !== chat.id)
        throw new Error("Synthetic contract: scope denied");
      calls.push({ method: "chat.write" });
      Object.assign(chat, clone(next));
    },
    getDatabase: async (fields) =>
      fields
        ? Object.fromEntries(fields.map((key) => [key, clone(database[key])]))
        : clone(database),
    getRuntimeInfo: async () => ({
      platform: "server-native",
      saveMethod: "entity",
      apiVersion: "3.0",
    }),
    getArgument: async () => "",
    toast: async (text) => calls.push({ method: "toast", text }),
    nativeFetch: async (url, init) => {
      if (String(url) !== "https://synthetic.invalid/v1/chat/completions") {
        throw new Error("Synthetic contract: outbound network denied");
      }
      calls.push({ method: "provider", url: String(url) });
      if (options.providerBarrier) await options.providerBarrier;
      if (init.signal?.aborted) throw init.signal.reason;
      const body = JSON.parse(init.body);
      const prompt = body.messages.at(-1).content;
      const para = (prompt.match(/<p id="([^"]+)"/) || [])[1] || "m0p0";
      const content = JSON.stringify({
        jumps: [],
        elapsed: "0",
        units: [
          {
            para_id: para,
            name: "Green",
            content: "Green waters the blue garden flowers.",
            keywords: ["Green", "blue", "garden"],
            keyExcerpts: ["Green waters the blue garden flowers."],
            contextNote: "Tending the garden",
            polarity: 1,
            role: "ally",
          },
        ],
        relations: [],
      });
      return new Response(
        body.stream
          ? `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`
          : JSON.stringify({ choices: [{ message: { content } }] }),
        {
          status: 200,
          headers: {
            "content-type": body.stream
              ? "text/event-stream"
              : "application/json",
          },
        },
      );
    },
  };
  const sandbox = {
    risuai: host,
    console: Object.fromEntries(
      ["info", "log", "warn", "error"].map((key) => [key, host.log]),
    ),
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    Response,
    Request,
    Headers,
    Blob,
    ReadableStream,
    WritableStream,
    TransformStream,
    CompressionStream,
    DecompressionStream,
    crypto: webcrypto,
    structuredClone,
    performance,
    btoa,
    atob,
    fetch: host.nativeFetch,
    navigator: { userAgent: "Risu synthetic server contract" },
    setTimeout: (fn, ms, ...args) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn(...args);
      }, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      clearTimeout(timer);
      timers.delete(timer);
    },
    setInterval: (fn, ms, ...args) => {
      const timer = setInterval(fn, ms, ...args);
      timers.add(timer);
      return timer;
    },
    clearInterval: (timer) => {
      clearInterval(timer);
      timers.delete(timer);
    },
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  async function until(predicate, message, deadlineMs = 5000) {
    const end = performance.now() + deadlineMs;
    while (!predicate()) {
      if (performance.now() >= end) throw new Error(message);
      const pending = sandbox.__WL_SERVER_LIFECYCLE.flushPendingPersistence();
      if (pending.promise) await pending.promise;
      await pause();
    }
  }
  return {
    chat,
    character,
    database,
    storage,
    calls,
    hooks,
    registrations,
    host,
    attachDOM(window) {
      window.fetch = host.nativeFetch;
      Object.assign(sandbox, {
        document: window.document,
        window,
        HTMLElement: window.HTMLElement,
        DOMParser: window.DOMParser,
        Node: window.Node,
        Event: window.Event,
        CustomEvent: window.CustomEvent,
        MutationObserver: window.MutationObserver,
        ResizeObserver: window.ResizeObserver,
        getComputedStyle: window.getComputedStyle.bind(window),
        requestAnimationFrame: window.requestAnimationFrame.bind(window),
        cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
        localStorage: window.localStorage,
      });
      host.getRootDocument = async () => window.document;
      host.showContainer = () => calls.push({ method: "container.show" });
      host.hideContainer = () => calls.push({ method: "container.hide" });
    },
    async boot(script) {
      vm.createContext(sandbox);
      vm.runInContext(instrumentWygloreLifecycle(script), sandbox, {
        timeout: 5000,
        filename: "WygLoreLeaf-3.1.6.instrumented.js",
      });
      await until(
        () => sandbox.__WL_SERVER_LIFECYCLE.status().ready,
        "Original WygLore boot did not finish",
      );
      return sandbox.__WL_SERVER_LIFECYCLE;
    },
    lifecycle() {
      return sandbox.__WL_SERVER_LIFECYCLE;
    },
    async settle() {
      await until(() => {
        const state = sandbox.__WL_SERVER_LIFECYCLE.status();
        return (
          !state.coldStart &&
          !state.indexBuild &&
          !state.providerActive &&
          !state.providerQueued &&
          !state.persistPending &&
          !state.persistActive &&
          !state.swapPending
        );
      }, "Original WygLore background tasks did not settle");
      if ((await sandbox.__WL_SERVER_LIFECYCLE.flush()) !== true)
        throw new Error("Original WygLore flush failed");
    },
    async close() {
      try {
        for (const fn of unload) await fn();
      } finally {
        for (const timer of timers) {
          clearTimeout(timer);
          clearInterval(timer);
        }
        timers.clear();
      }
    },
  };
}

module.exports = { makeWygloreContractFixture };
