import { createDisplayScopeCache } from "../../src/ts/runtime/displayScopeCache.svelte";
import type { DisplayCapture } from "../../src/ts/runtime/displayEffects";
import { BrowserDisplayLua } from "../../src/ts/runtime/browserDisplayLua";
import { DisplayWorkerExecutor } from "../../src/ts/runtime/displayWorkerExecutor";
import { displayScopeJson } from "../../src/ts/runtime/displayScopeIdentity";
import { DisplayWireBudget } from "../../src/ts/runtime/displayWireBudget";

/** Neutral authored fixture; executes the actual client-compiled Svelte runes. */
export function checkSharedDisplayScope() {
  let projection = $state(0);
  let partial = $state(false);
  let ready = $state(true);
  let clock = 1,
    epoch = 1,
    version = 1,
    model = "Synthetic model",
    triggerId = "Synthetic trigger";
  const database = $state<Record<string, any>>({
    characters: [
      {
        type: "character",
        chaId: "c",
        modules: ["m"],
        triggerscript: [],
        chats: [
          {
            id: "a",
            message: Array.from({ length: 50 }, (_, i) => ({
              chatId: "message-" + i,
              role: "char",
              data: "Synthetic " + i,
            })),
            scriptstate: { $counter: "0" },
            GLGlobalVariables: { choice: "before" },
          },
        ],
      },
    ],
    globalChatVariables: { choice: "global-before" },
    modules: [{ id: "m", nested: { value: "module-before" } }],
    presets: [{ id: "p", nested: { value: "preset-before" } }],
    personas: [{ id: "persona", desc: "Synthetic persona" }],
    syntheticJson: JSON.parse('{"__proto__":{"value":"before"}}'),
  });
  const environment = () =>
    ({
      model: { id: model },
      triggerId,
      isTauri: false,
      isNodeServer: false,
      isMobile: false,
      appVer: "Synthetic",
    }) as unknown as DisplayCapture["cbsEnvironment"];
  const fresh = (index = 0): DisplayCapture => {
    const character = database.characters[0],
      chat = character.chats[0];
    return {
      serverId: "synthetic",
      projectedCursor: 1,
      state: {
        cursor: 1,
        characterId: character.chaId,
        chatId: chat.id,
        chatEpoch: epoch,
        characterEpoch: epoch,
        inputClock: clock,
        applied: [],
        next: null,
      },
      database: database as DisplayCapture["database"],
      character,
      chat,
      triggers: character.triggerscript,
      versions: {
        chat: new Map([["$counter", version]]),
        localGlobal: new Map([["choice", version]]),
        global: new Map([["choice", version]]),
      },
      cbsModules: database.modules.filter((m) =>
        character.modules.includes(m.id),
      ),
      cbsEnvironment: environment(),
      sourceContent: chat.message[index]?.data,
      message: chat.message[index] && {
        id: chat.message[index].chatId,
        revision: version,
      },
      hasEarlier: partial,
      persistent: index >= 0,
    };
  };
  const cache = createDisplayScopeCache(
    () => (ready ? fresh() : undefined),
    () => {
      projection;
      partial;
      ready;
    },
  );
  const take = (index = 0) =>
    ready ? cache.capture(fresh(index), environment()) : undefined;
  const trace = [];
  const record = (label: string, capture = take()) => {
    trace.push({
      label,
      ...cache.diagnostics(),
      value: capture?.chat.scriptstate.$counter,
      source: capture?.sourceContent,
      revision: capture?.versions.chat.get("$counter"),
      clock: capture?.state.inputClock,
      epoch: capture?.state.chatEpoch,
      partial: capture?.hasEarlier,
      modules: capture?.cbsModules.map((m) => m.id),
    });
    return capture;
  };
  const scopes = Array.from({ length: 50 }, (_, i) => take(i));
  const initial = scopes[0];
  record("initial", initial);
  const sharedHistory = scopes.every(
    (c) => c.chat.message === initial.chat.message,
  );
  const aliases = scopes.every(
    (c) =>
      c.chat === c.character.chats[0] &&
      c.character === c.database.characters[0],
  );
  initial.chat.scriptstate.$counter = "pending-only";
  initial.chat.GLGlobalVariables.choice = "pending-local-global";
  initial.database.globalChatVariables.choice = "pending-global";
  initial.versions.chat.set("$counter", 99);
  const privateMutable =
    scopes[1].chat.scriptstate.$counter === "0" &&
    scopes[1].chat.GLGlobalVariables.choice === "before" &&
    scopes[1].database.globalChatVariables.choice === "global-before" &&
    scopes[1].versions.chat.get("$counter") === 1 &&
    database.characters[0].chats[0].scriptstate.$counter === "0";
  version++;
  record("fresh-header-only");
  database.characters[0].chats[0].message[0].data = "Synthetic later";
  const changed = record("nested-message");
  const oldPinned = initial.chat.message[0].data === "Synthetic 0";
  database.characters[0].chats[0].scriptstate.$counter = "canonical-later";
  record("nested-variable");
  database.modules[0].nested.value = "module-later";
  const module = record("nested-module");
  database.presets[0].nested.value = "preset-later";
  const preset = record("nested-preset");
  database.characters[0].modules = [];
  record("disable-module");
  database.characters[0].modules = ["m"];
  record("enable-module");
  partial = true;
  record("partial-history");
  projection++;
  record("plain-projection-notification");
  const oldEnvironment = take().cbsEnvironment;
  model = "Synthetic next model";
  triggerId = "Synthetic next trigger";
  const newEnvironment = record("fresh-environment").cbsEnvironment;
  clock++;
  record("unannounced-clock-guard");
  epoch++;
  record("unannounced-epoch-guard");
  database.syntheticJson.__proto__.value = "after";
  const proto = record("own-proto");
  database.characters[0].chats[0].scriptstate.$added = "new-key";
  const added = record("local-key-added");
  delete database.characters[0].chats[0].scriptstate.$added;
  const removed = record("local-key-removed");
  ready = false;
  const unavailable = take() === undefined;
  ready = true;
  database.characters[0].chaId = "next-character";
  database.characters[0].chats[0].id = "next-chat";
  database.characters[0].chats[0].message.reverse();
  const navigation = record("navigation-and-reorder");
  const frozen =
    Object.isFrozen(initial.chat.message) &&
    Object.isFrozen(initial.database.personas) &&
    Object.isFrozen(initial.cbsModules[0]);
  cache.close();
  const closed = take() === undefined && !cache.diagnostics().active;
  return {
    clientCompiledSvelte: true,
    trace,
    aliases,
    sharedHistory,
    privateMutable,
    oldPinned,
    frozen,
    unavailable,
    closed,
    changedMessage: changed.chat.message[0].data,
    moduleValue: (module.cbsModules[0] as any).nested.value,
    presetValue: (preset.database.presets[0] as any).nested.value,
    freshEnvironment: {
      old: oldEnvironment,
      current: newEnvironment,
    },
    protoOwn: Object.hasOwn((proto.database as any).syntheticJson, "__proto__"),
    protoPrototypeUnchanged:
      Object.getPrototypeOf((proto.database as any).syntheticJson) ===
      Object.prototype,
    protoValue: (proto.database as any).syntheticJson.__proto__.value,
    addedValue: added.chat.scriptstate.$added,
    removedKey: !Object.hasOwn(removed.chat.scriptstate, "$added"),
    navigation: {
      character: navigation.state.characterId,
      chat: navigation.state.chatId,
      first: navigation.chat.message[0].chatId,
    },
  };
}

/** Actual worker Lua/CBS behind a controlled first invocation, with real runes. */
export async function checkDisplayScopeCoalescing() {
  const observations = [];
  const code =
    "local calls=0; listenEdit('editDisplay', function(id,data) calls=calls+1; return getChatVar(id,'counter') .. ':' .. cbs('{{trigger_id}}') .. ':' .. getChat(id,0).data .. ':' .. calls end)";
  for (const dependency of [
    "duplicate",
    "local-value",
    "trigger-environment",
    "revision-map",
    "private-value",
    "nested-history",
    "nested-module",
  ]) {
    let revision = 1,
      triggerId = "before",
      privateValue: string;
    const database = $state<any>({
      characters: [
        {
          type: "character",
          chaId: "c",
          name: "Synthetic",
          chatPage: 0,
          defaultVariables: "",
          triggerscript: [
            {
              type: "manual",
              conditions: [],
              effect: [{ type: "triggerlua", code }],
            },
          ],
          chats: [
            {
              message: [{ chatId: "m", role: "char", data: "Synthetic" }],
              scriptstate: { $counter: "0" },
              GLGlobalVariables: {},
              localLore: [],
            },
          ],
        },
      ],
      templateDefaultVariables: "",
      globalChatVariables: {},
      personas: [],
      modules: [{ id: "m", nested: { value: "before" } }],
    });
    const environment = () =>
      ({
        model: { id: "synthetic" },
        triggerId,
        isTauri: false,
        isNodeServer: false,
        isMobile: false,
        appVer: "Synthetic",
      }) as DisplayCapture["cbsEnvironment"];
    const fresh = (): DisplayCapture => {
      const character = database.characters[0],
        chat = character.chats[0];
      return {
        serverId: "synthetic",
        projectedCursor: 1,
        state: {
          cursor: 1,
          inputClock: 1,
          chatId: "a",
          characterId: "c",
          chatEpoch: 1,
          characterEpoch: 1,
          applied: [],
          next: null,
        },
        database,
        character,
        chat,
        triggers: character.triggerscript,
        versions: {
          chat: new Map([["$counter", revision]]),
          localGlobal: new Map(),
          global: new Map(),
        },
        cbsEnvironment: environment(),
        cbsModules: database.modules,
        sourceContent: "Synthetic",
        message: { id: "m", revision: 1 },
        persistent: false,
        hasEarlier: false,
      };
    };
    const cache = createDisplayScopeCache(fresh, () => {});
    let begin: () => void, release: () => void;
    const started = new Promise<void>((resolve) => (begin = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let executions = 0;
    const errors: string[] = [],
      commands = [];
    const runtime = new BrowserDisplayLua(
      () => ({}) as never,
      {
        capture: () => {
          const capture = cache.capture(fresh(), environment());
          if (privateValue !== undefined)
            capture.chat.scriptstate.$counter = privateValue;
          return capture;
        },
        seen: () => false,
        pending: () => undefined,
        submit: async (command) => {
          commands.push(command);
        },
        error: (error) => errors.push(String(error)),
        parser: () => {
          throw new Error("Worker must execute CBS");
        },
      },
      8,
      (base) => {
        const worker = new DisplayWorkerExecutor(base);
        return {
          async execute(input) {
            if (++executions === 1) {
              begin();
              await blocked;
            }
            return worker.execute(input);
          },
          close: () => worker.close(),
        };
      },
    );
    let first: Promise<string>, second: Promise<string>;
    try {
      first = runtime.run("Synthetic", 0);
      await started;
      if (dependency === "local-value")
        database.characters[0].chats[0].scriptstate.$counter = "9";
      if (dependency === "trigger-environment") triggerId = "after";
      if (dependency === "revision-map") revision++;
      if (dependency === "private-value") privateValue = "9";
      if (dependency === "nested-history")
        database.characters[0].chats[0].message[0].data = "Synthetic later";
      if (dependency === "nested-module")
        database.modules[0].nested.value = "after";
      second = runtime.run("Synthetic", 0);
      const expected = dependency === "duplicate" ? 1 : 2;
      const end = performance.now() + 1000;
      while (
        runtime.diagnostics().invocations < expected &&
        performance.now() < end
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      // Let duplicate hashing finish too; the first executor remains blocked.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const invocationsWhileBlocked = runtime.diagnostics().invocations;
      release();
      const outputs = await Promise.all([first, second]);
      observations.push({
        dependency,
        outputs,
        executions,
        invocationsWhileBlocked,
        preparations: cache.diagnostics().preparations,
        errors,
        commands,
      });
    } finally {
      release();
      runtime.close();
      cache.close();
      await Promise.allSettled([first, second]);
    }
  }
  return {
    clientCompiledSvelte: true,
    realWorker: true,
    actualLuaAndCbs: true,
    controlledFirstInvocation: true,
    syntheticOnly: true,
    observations,
  };
}

/** Real worker transfer reuse, fresh Lua variables/history and fatal corruption. */
export async function checkWorkerCaptureTransport(
  useCanonicalSource = false,
  variableOnlyRefresh = false,
) {
  const code = `local calls=0
listenEdit('editDisplay', function(id,data)
  calls=calls+1
  local before=getChatVar(id,'counter')
  setChatVar(id,'counter','private-' .. calls)
  return before .. '/' .. getChatVar(id,'counter') .. '/' .. string.sub(getChat(id,0).data,1,5) .. '/' .. cbs('{{trigger_id}}') .. '/' .. calls
end)`;
  const database = $state<any>({
    characters: [
      {
        type: "character",
        chaId: "c",
        name: "Synthetic",
        chatPage: 0,
        defaultVariables: "",
        triggerscript: [
          {
            type: "manual",
            conditions: [],
            effect: [{ type: "triggerlua", code }],
          },
        ],
        chats: [
          {
            message: [
              {
                chatId: "m",
                role: "char",
                data: "First" + " Synthetic".repeat(10000),
              },
            ],
            scriptstate: { $counter: "0" },
            GLGlobalVariables: {},
            localLore: [],
          },
        ],
      },
    ],
    templateDefaultVariables: "",
    globalChatVariables: {},
    personas: [],
    modules: [],
  });
  let triggerId = "before",
    revision = 1,
    content = "Synthetic A",
    corrupt = false,
    terminations = 0;
  const packets: {
    definitions: number;
    definitionBytes: number;
    packetBytes: number;
  }[] = [];
  const workers: DisplayWorkerExecutor[] = [];
  const commands = [],
    errors: string[] = [];
  const identityKeys: { anchored: boolean; bytes: number }[] = [];
  const environment = () =>
    ({
      model: { id: "synthetic" },
      triggerId,
      isTauri: false,
      isNodeServer: false,
      isMobile: false,
      appVer: "Synthetic",
    }) as DisplayCapture["cbsEnvironment"];
  const fresh = (): DisplayCapture => {
    const character = database.characters[0],
      chat = character.chats[0];
    return {
      serverId: "synthetic",
      projectedCursor: 1,
      state: {
        cursor: 1,
        inputClock: variableOnlyRefresh ? revision : 1,
        chatId: "a",
        characterId: "c",
        chatEpoch: 1,
        characterEpoch: 1,
        applied: [],
        next: null,
      },
      database,
      character,
      chat,
      triggers: character.triggerscript,
      versions: {
        chat: new Map([["$counter", revision]]),
        localGlobal: new Map(),
        global: new Map(),
      },
      cbsEnvironment: environment(),
      cbsModules: database.modules,
      sourceContent: useCanonicalSource ? chat.message[0].data : content,
      message: { id: "m", revision: 1 },
      persistent: false,
      hasEarlier: false,
    };
  };
  const cache = createDisplayScopeCache(fresh, () => {});
  const makeRuntime = () =>
    new BrowserDisplayLua(
      () => ({}) as never,
      {
        capture: () => {
          const capture = cache.capture(fresh(), environment());
          if (useCanonicalSource) {
            const key = displayScopeJson(
              capture,
              new DisplayWireBudget(undefined, 0, 0),
            );
            identityKeys.push({
              anchored: JSON.parse(key)[0] === "source-field",
              bytes: new TextEncoder().encode(key).length,
            });
          }
          return capture;
        },
        seen: () => false,
        pending: () => undefined,
        submit: async (command) => {
          commands.push(command);
        },
        error: (error) => errors.push(String(error)),
        parser: () => {
          throw new Error("Actual worker must execute CBS");
        },
      },
      8,
      (base) => {
        const worker = new Worker(
          new URL("../../src/ts/runtime/display.worker.ts", import.meta.url),
          { type: "module" },
        );
        const post = worker.postMessage.bind(worker),
          terminate = worker.terminate.bind(worker);
        worker.postMessage = ((message, options) => {
          if (message.type === "execute") {
            packets.push({
              definitions: message.captureWire.definitions.length,
              definitionBytes: message.captureWire.definitions.reduce(
                (sum, row) => sum + row[1],
                0,
              ),
              packetBytes: new TextEncoder().encode(
                JSON.stringify(message.captureWire),
              ).length,
            });
            if (corrupt)
              message.captureWire.value = ["r", Number.MAX_SAFE_INTEGER];
          }
          post(message, options);
        }) as typeof worker.postMessage;
        worker.terminate = () => {
          terminations++;
          terminate();
        };
        const executor = new DisplayWorkerExecutor(base, 2000, worker);
        workers.push(executor);
        return executor;
      },
    );
  let runtime = makeRuntime();
  const outputs: string[] = [];
  let reused, refreshed;
  try {
    outputs.push(await runtime.run(content, 0));
    content = "Synthetic B";
    outputs.push(await runtime.run(content, 0));
    reused = workers[0].transportDiagnostics();
    database.characters[0].chats[0].scriptstate.$counter = "9";
    if (variableOnlyRefresh) {
      revision++;
      content = "Synthetic variable-only refresh";
      outputs.push(await runtime.run(content, 0));
    }
    database.characters[0].chats[0].message[0].data =
      "Later" + " Synthetic".repeat(10000);
    triggerId = "after";
    revision++;
    content = "Synthetic C";
    outputs.push(await runtime.run(content, 0));
    refreshed = workers[0].transportDiagnostics();
    runtime.close();
    runtime = makeRuntime();
    content = "Synthetic D";
    outputs.push(await runtime.run(content, 0));
    corrupt = true;
    content = "Synthetic corrupted";
    const draft = await runtime.defer(content, 0);
    await draft.commit();
    return {
      realWorker: true,
      actualLuaAndCbs: true,
      syntheticOnly: true,
      outputs,
      identityKeys,
      packets,
      reused,
      refreshed,
      corruption: {
        failed: draft.failed,
        output: draft.output,
        errors: [...errors],
        terminated: terminations,
        dictionary: workers[1].transportDiagnostics(),
      },
      commands,
      canonicalCounter: database.characters[0].chats[0].scriptstate.$counter,
      closedDictionary: workers[0].transportDiagnostics(),
    };
  } finally {
    runtime.close();
    cache.close();
  }
}
