"use strict";

const acorn = require("acorn");
const walk = require("acorn-walk");
const { createHash } = require("node:crypto");
const { getWygloreRelease } = require("./wygloreContract.cjs");

// Admission remains the complete original artifact. Each execution-only seam
// below is separately pinned; future admitted releases do not inherit it.
const PROFILES = Object.freeze({
  "5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c":
    Object.freeze({
      _hostSafeInit:
        "85fe5230118290f49cde9f8da0d522c33aaa13617b79f6e20e052ba372d43ff5",
      fetchWithFallback:
        "4ee3c3d6c3549342670f9f0f5585a7624eab3426e4c5cca5b87aa2b871d59410",
      testSlotConnection:
        "cca8bda6b96e67737ba15dc1d29267a8b4b930da38f4d4d44f087da143b3c2ae",
    }),
  ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9:
    Object.freeze({
      _hostSafeInit:
        "85fe5230118290f49cde9f8da0d522c33aaa13617b79f6e20e052ba372d43ff5",
      fetchWithFallback:
        "3a952134b68b47b919e7f513404e7872e327324f994b513c2ae6176fdeb46e7a",
      testSlotConnection:
        "c60a81c20533cde85653ca237b3d656f9a15714801638aace747a974849ac0cd",
    }),
});
const FUNCTION_SIGNATURES = Object.freeze({
  _hostSafeInit: "function _hostSafeInit(init)",
  fetchWithFallback: "async function fetchWithFallback(url,init)",
  testSlotConnection:
    "async function testSlotConnection(slotName,providerId,modelId,opts={})",
});
const FUNCTION_LENGTHS = Object.freeze({
  "5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c":
    Object.freeze({
      _hostSafeInit: 242,
      fetchWithFallback: 7156,
      testSlotConnection: 4098,
    }),
  ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9:
    Object.freeze({
      _hostSafeInit: 242,
      fetchWithFallback: 7334,
      testSlotConnection: 4104,
    }),
});

/** A server-native host has no iframe structured-clone boundary. Retain the
 * caller's signal and give each original host attempt its own abortable
 * deadline. A rejected original race cannot leave its physical request alive.
 * Successful headers keep the caller signal connected for streaming the body.
 * This factory is self-contained because its source also runs in the realm.
 */
function withWygloreTransportDeadline(
  start,
  timeoutMs,
  inputSignal,
  bindSignal,
  originalTimeout,
  combineSignals,
) {
  const controller = new AbortController();
  const signal = combineSignals([inputSignal, controller.signal]);
  bindSignal(signal);
  const abort = (error) => {
    if (!controller.signal.aborted) controller.abort(error);
    throw error;
  };
  let pending;
  try {
    pending = originalTimeout(start, timeoutMs, signal);
  } catch (error) {
    return abort(error);
  }
  return Promise.resolve(pending).catch(abort);
}

function collect(source, profile, lengths) {
  if (
    source.includes("__wlServerTransportDeadline") ||
    source.includes("__wlServerSlotAbort")
  )
    throw Error("WygLore transport adapter identifier collision");
  const found = new Map();
  // The full distributed artifact was already verified by SHA. Parse only its
  // three separately hashed functions; repeatedly parsing a multi-megabyte
  // author/UI executable adds avoidable startup allocation and GC pressure.
  for (const [name, expected] of Object.entries(profile)) {
    const signature = FUNCTION_SIGNATURES[name],
      start = source.indexOf(signature);
    if (start < 0 || source.indexOf(signature, start + signature.length) >= 0)
      throw Error("Reviewed WygLore transport function count differs: " + name);
    const text = source.slice(start, start + lengths[name]);
    if (createHash("sha256").update(text).digest("hex") !== expected)
      throw Error("Reviewed WygLore transport function differs: " + name);
    const parsed = acorn.parse(text, { ecmaVersion: "latest" });
    const node = parsed.body[0];
    if (
      parsed.body.length !== 1 ||
      node.type !== "FunctionDeclaration" ||
      node.id?.name !== name ||
      node.end !== text.length
    )
      throw Error(
        "Reviewed WygLore transport function boundary differs: " + name,
      );
    walk.full(node, (child) => {
      child.start += start;
      child.end += start;
    });
    found.set(name, node);
  }
  if (found.size !== 3)
    throw Error("Reviewed WygLore transport functions are missing");
  return found;
}

/** Adapt only the executable copy after validating its unchanged author seams.
 * No persisted plugin source, setting, model or credential is changed. Only the
 * measured Vertex model's default slot-test budget is raised to the existing
 * transport budget. Original POST uncertainty/replay guards choose all retries.
 */
function instrumentWygloreTransportCancellation(
  original,
  executable = original,
) {
  const release = getWygloreRelease(original);
  const profile = PROFILES[release.sha256];
  if (!profile)
    throw Error("WygLore transport cancellation release is not reviewed");
  const lengths = FUNCTION_LENGTHS[release.sha256];
  collect(original, profile, lengths);
  const functions = collect(executable, profile, lengths);
  const edits = [];
  const hostInit = functions.get("_hostSafeInit");
  const returned = hostInit.body.body.at(-1);
  if (returned.type !== "ReturnStatement" || returned.argument?.name !== "out")
    throw Error("Reviewed WygLore host initialization return differs");
  edits.push({
    start: returned.start,
    end: returned.start,
    value: "if(init.signal)out.signal=init.signal;",
  });

  let hostDeadline = 0;
  walk.simple(functions.get("fetchWithFallback"), {
    VariableDeclarator(node) {
      if (node.id?.name !== "_ht") return;
      if (
        executable.slice(node.init.start, node.init.end) !==
        "start=>_withHostTimeout(start,hostTimeoutMs,signal)"
      )
        throw Error("Reviewed WygLore host deadline differs");
      hostDeadline++;
      edits.push({
        start: node.init.start,
        end: node.init.end,
        value:
          "start=>__wlServerTransportDeadline(start,hostTimeoutMs,signal,__wlServerSignal=>{hostInit={...hostInit,signal:__wlServerSignal}})",
      });
    },
  });

  const slot = functions.get("testSlotConnection");
  edits.push({
    start: slot.body.start + 1,
    end: slot.body.start + 1,
    value: "const __wlServerSlotAbort=new AbortController;",
  });
  let timer = 0,
    complete = 0,
    embed = 0,
    budget = 0;
  walk.simple(slot, {
    VariableDeclarator(node) {
      if (node.id?.name !== "timeoutMs") return;
      if (
        executable.slice(node.init.start, node.init.end) !==
        "opts.timeoutMs||DEFAULT_TIMEOUT_MS"
      )
        throw Error("Reviewed WygLore slot budget differs");
      budget++;
      // The measured Vertex model can validly need 14–17 seconds even for
      // ping. Match the existing 60-second server transport budget only for
      // this exact model; retain explicit overrides and every other default.
      edits.push({
        start: node.init.start,
        end: node.init.end,
        value:
          'opts.timeoutMs||(providerId==="vertex"&&String(modelId||"").trim()==="gemini-3.8-flash"?6e4:DEFAULT_TIMEOUT_MS)',
      });
    },
    SequenceExpression(node) {
      const first = node.expressions[0];
      if (
        first?.type !== "AssignmentExpression" ||
        first.left?.name !== "timedOut"
      )
        return;
      if (
        executable.slice(node.start, node.end) !==
        "timedOut=!0,reject(new Error(`timeout ${timeoutMs}ms`))"
      )
        throw Error("Reviewed WygLore slot deadline differs");
      timer++;
      edits.push({
        start: first.end,
        end: first.end,
        value:
          ',__wlServerSlotAbort.abort(new DOMException("WygLore slot test deadline","TimeoutError"))',
      });
    },
    CallExpression(node) {
      if (
        node.callee?.type !== "MemberExpression" ||
        node.callee.object?.name !== "client"
      )
        return;
      const method = node.callee.property?.name;
      if (!["complete", "embed"].includes(method)) return;
      const options = node.arguments[1];
      if (
        options?.type !== "ObjectExpression" ||
        options.properties.some((p) => p.key?.name === "signal")
      )
        throw Error("Reviewed WygLore slot call options differ");
      if (method === "complete") complete++;
      else embed++;
      edits.push({
        start: options.end - 1,
        end: options.end - 1,
        value: ",signal:__wlServerSlotAbort.signal",
      });
    },
  });
  if (
    hostDeadline !== 1 ||
    timer !== 1 ||
    complete !== 1 ||
    embed !== 1 ||
    budget !== 1
  )
    throw Error("Reviewed WygLore transport cancellation seams are incomplete");
  const end = executable.lastIndexOf("})();");
  if (end < 0 || executable.slice(end + 5).trim())
    throw Error("WygLore transport outer closure differs");
  edits.push({
    start: end,
    end,
    value:
      "\nfunction __wlServerTransportDeadline(start,ms,signal,bind){return (" +
      withWygloreTransportDeadline.toString() +
      ")(start,ms,signal,bind,_withHostTimeout,combineSignals)}\n",
  });
  let result = executable;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}

module.exports = {
  instrumentWygloreTransportCancellation,
  withWygloreTransportDeadline,
  PROFILES,
};
