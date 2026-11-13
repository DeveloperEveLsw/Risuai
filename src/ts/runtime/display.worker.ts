import { LuaFactory } from "wasmoon";
import luaWasmUrl from "wasmoon/dist/glue.wasm?url";
import { DisplayLuaContext, type DisplayExecution } from "./displayLuaContext";
import type { ScriptingRuntimeHost } from "../process/scriptingRuntime";
import { createCbsRuntime } from "../parser/cbsRuntime";
import { createExpressionEvaluator } from "../process/expressionRuntime";
import { pickHashRand } from "../utilText";
import { DisplayCaptureDecoder } from "./displayCaptureTransport";

const preparedFactory = new LuaFactory(luaWasmUrl);
// Upstream constructs its injected factory once. Reuse this worker-local factory
// so resource download/compilation happens within the separate initialization budget.
const WorkerLuaFactory = function () {
  return preparedFactory;
} as unknown as typeof LuaFactory;
let jsonLua = "";
class WorkerImage {
  src = "";
}
let active: DisplayExecution;
let invocation = 0;
let portSequence = 0;
let logCount = 0;
let portFailure: Error;
const captureDecoder = new DisplayCaptureDecoder();
const urls = new Set<string>();
const ports = new Map<
  number,
  { resolve: (result: unknown) => void; reject: (error: Error) => void }
>();
const send = (data: unknown) => globalThis.postMessage(data);
console.log = (...args) => {
  // Relay bounded original Lua log() diagnostics; never relay the source dump.
  if (active && args[0] !== "Running Lua code:" && logCount++ < 16) {
    try {
      const json = JSON.stringify(args);
      if (json.length <= 16384)
        send({ type: "log", id: invocation, args: JSON.parse(json) });
    } catch {}
  }
};
function port(name: string, args: unknown[]) {
  const portId = ++portSequence;
  return new Promise((resolve, reject) => {
    ports.set(portId, { resolve, reject });
    send({ type: "port", id: invocation, portId, port: name, args });
  });
}
const runtime = new DisplayLuaContext(
  () => {
    const unsupported = () => {
      throw new Error("Unavailable display worker capability");
    };
    return new Proxy(
      {
        LuaFactory: WorkerLuaFactory,
        v4: () => crypto.randomUUID(),
        getModuleLorebooks: () => active.capture.cbsLorebooks ?? [],
        fetch: (path: string) => {
          if (path !== "/lua/json.lua")
            return Promise.reject(new Error("Unavailable worker resource"));
          return Promise.resolve(new Response(jsonLua));
        },
        readImage: (path: string) => port("readImage", [path]),
        Image: WorkerImage,
        asBuffer: (bytes: Uint8Array) => bytes,
        writeInlayImage: async (image: WorkerImage, options: unknown) => {
          urls.add(image.src);
          return port("writeInlayImage", [image.src, options]);
        },
        hasher: async (bytes: Uint8Array) =>
          [
            ...new Uint8Array(
              await crypto.subtle.digest("SHA-256", bytes as BufferSource),
            ),
          ]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(""),
      },
      {
        get: (target, key) =>
          key in target ? Reflect.get(target, key) : unsupported,
      },
    ) as unknown as ScriptingRuntimeHost;
  },
  (scope) => {
    const environment = scope.capture.cbsEnvironment;
    if (!environment)
      return scope.proposal.fail("Display CBS environment was not captured");
    return createCbsRuntime({
      ...scope.variables,
      ...scope.util,
      ...environment,
      calcString: createExpressionEvaluator(scope.variables),
      getDatabase: () => scope.capture.database,
      getSelectedCharID: () => 0,
      getModules: () => scope.capture.cbsModules ?? [],
      getModuleLorebooks: () => scope.capture.cbsLorebooks ?? [],
      getCurrentTriggerId: () => environment.triggerId,
      getModelInfo: (model) =>
        model === scope.capture.database.aiModel
          ? environment.model
          : scope.proposal.fail("Uncaptured display model metadata"),
      safeStructuredClone: structuredClone,
      pickHashRand,
      callInternalFunction: () => "",
      findCharacterbyId: (id) => {
        if (
          id !== scope.capture.character.chaId ||
          scope.capture.character.type === "group"
        )
          return scope.proposal.fail(
            "Display character lookup outside its pinned scope is unavailable",
          );
        return scope.capture.character;
      },
    }).parse;
  },
);
globalThis.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  if (message.type === "port-result") {
    if (message.id !== invocation) return;
    const pending = ports.get(message.portId);
    ports.delete(message.portId);
    if (message.error) {
      portFailure = new Error(message.error);
      pending?.reject(portFailure);
    } else pending?.resolve(message.result);
    return;
  }
  if (message.type !== "execute" || active) return;
  invocation = message.id;
  logCount = 0;
  portFailure = undefined;
  try {
    // Normalize the small outer input and independently parse every immutable
    // capture reference. No decoded Lua-mutable object is shared or retained.
    try {
      active = JSON.parse(JSON.stringify(message.input));
      active.capture = captureDecoder.decode(
        message.captureWire,
      ) as DisplayExecution["capture"];
    } catch (error) {
      captureDecoder.close();
      runtime.close();
      send({
        type: "error",
        id: invocation,
        fatal: true,
        error: String(error),
      });
      return;
    }
    const { capture } = active;
    capture.character = capture.database.characters[0];
    capture.chat = capture.character.chats[0];
    for (const key of ["chat", "localGlobal", "global"] as const)
      capture.versions[key] = new Map(
        capture.versions[key] as unknown as [string, number][],
      );
    const result = await runtime.execute(active);
    if (portFailure) throw portFailure;
    if (typeof result.output !== "string")
      throw new Error("Display Lua output must be text");
    if (new TextEncoder().encode(result.output).length > 4 * 1024 * 1024)
      throw new Error("Display Lua output exceeds 4 MiB");
    send({ type: "result", id: invocation, result });
  } catch (error) {
    send({
      type: "error",
      id: invocation,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    active = undefined;
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    ports.clear();
  }
};
void (async () => {
  try {
    const response = await fetch(
      new URL("/lua/json.lua", globalThis.location.origin),
    );
    if (!response.ok)
      throw new Error("Display Lua JSON resource could not be loaded");
    jsonLua = await response.text();
    await preparedFactory.mountFile("json.lua", jsonLua);
    send({ type: "ready" });
  } catch (error) {
    send({
      type: "boot-error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
})();
