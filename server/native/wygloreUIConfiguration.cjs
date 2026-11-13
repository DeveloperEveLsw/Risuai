"use strict";
const acorn = require("acorn");
const walk = require("acorn-walk");
const { verifyWygloreScript } = require("./wygloreContract.cjs");

const PORT = "__WL_SERVER_UI_CONFIGURATION";
const PROFILE = Object.freeze({
  saveNow:
    'saveNow=async()=>{let patch={};patch[providerKey2]=providerSel.value||"",patch[modelKey]=(modelInput.value||"").trim();try{await client.setConfig(patch)}catch{}}',
  scheduleSave:
    "scheduleSave=()=>{saveTimer&&clearTimeout(saveTimer),saveTimer=setTimeout(async()=>{saveTimer=null,await saveNow()},250)}",
  flushSave:
    "flushSave=async()=>{saveTimer&&(clearTimeout(saveTimer),saveTimer=null),await saveNow()}",
});
const DELAYED_INPUT_PROFILE = Object.freeze({
  excludedModules: Object.freeze({
    owner: "renderCbsTogglesTab",
    timer: "_excludeDebounce",
    operation: "__risuExcludedModuleApply",
    flush: "__risuExcludedModuleFlush",
    target: "excludeInput",
    declaration: "_excludeDebounce=null",
    callback:
      "()=>{getEngine().setParams({moduleLoreIngestExclude:excludeInput.value}),persistEngine().catch(()=>{}),_excludeDebounce=null}",
    registration:
      'excludeInput.addEventListener("input",()=>{_excludeDebounce&&clearTimeout(_excludeDebounce),_excludeDebounce=setTimeout(()=>{getEngine().setParams({moduleLoreIngestExclude:excludeInput.value}),persistEngine().catch(()=>{}),_excludeDebounce=null},400)})',
  }),
  toggleText: Object.freeze({
    owner: "_buildRow",
    timer: "_deb",
    operation: "__risuToggleTextApply",
    flush: "__risuToggleTextFlush",
    target: "inp",
    declaration: "_deb=null",
    callback:
      'async()=>{let ctx=await _resolveCurrentContext(),delta=updateActiveToggle(getEngine().params,ctx.charId,ctx.chatKey,t.varName,inp.value===""?null:inp.value);getEngine().setParams(delta),persistEngine().catch(()=>{})}',
    registration:
      'inp.addEventListener("input",()=>{_deb&&clearTimeout(_deb),_deb=setTimeout(async()=>{let ctx=await _resolveCurrentContext(),delta=updateActiveToggle(getEngine().params,ctx.charId,ctx.chatKey,t.varName,inp.value===""?null:inp.value);getEngine().setParams(delta),persistEngine().catch(()=>{})},400)})',
  }),
});
function validateWygloreUIConfiguration(source) {
  if (typeof source !== "string")
    throw Error("WygLore executable source is required");
  const found = new Map();
  const delayed = Object.values(DELAYED_INPUT_PROFILE);
  const delayedFound = new Set();
  function owner(ancestors) {
    return ancestors.findLast((parent) => parent.type === "FunctionDeclaration")
      ?.id?.name;
  }
  function requireInput(key, node, expected) {
    if (
      delayedFound.has(key) ||
      source.slice(node.start, node.end) !== expected
    )
      throw Error(
        "Reviewed WygLore UI configuration source profile differs: " + key,
      );
    delayedFound.add(key);
  }
  walk.ancestor(acorn.parse(source, { ecmaVersion: "latest" }), {
    VariableDeclarator(node, ancestors) {
      for (const input of delayed) {
        if (node.id.name === input.operation || node.id.name === input.flush)
          throw Error("Reviewed WygLore UI configuration identifier collision");
        if (node.id.name === input.timer) {
          if (owner(ancestors) !== input.owner)
            throw Error(
              "Reviewed WygLore UI configuration timer scope differs",
            );
          requireInput(input.timer, node, input.declaration);
        }
      }
      if (!Object.hasOwn(PROFILE, node.id.name)) return;
      const name = node.id.name;
      if (
        found.has(name) ||
        source.slice(node.start, node.end) !== PROFILE[name] ||
        !ancestors.some(
          (parent) =>
            parent.type === "FunctionDeclaration" &&
            parent.id?.name === "renderActiveSlotEditor" &&
            parent.async,
        )
      )
        throw Error(
          "Reviewed WygLore UI configuration source profile differs: " + name,
        );
      found.set(name, node);
    },
    CallExpression(node, ancestors) {
      if (
        node.callee.type !== "MemberExpression" ||
        node.callee.property.name !== "addEventListener" ||
        node.arguments[0]?.value !== "input"
      )
        return;
      for (const input of delayed) {
        if (
          owner(ancestors) === input.owner &&
          node.callee.object.name === input.target
        )
          requireInput(input.timer + ".input", node, input.registration);
      }
    },
  });
  if (found.size !== 3 || delayedFound.size !== delayed.length * 2)
    throw Error("Reviewed WygLore UI configuration declarations are missing");
  return true;
}

/** Pending callbacks preserve the original model/input operations. Their local
 * timers and their original save algorithms stay in the author closure. The
 * port observes scheduled/running work without collecting field names or values.
 * This factory is self-contained because its source is also used in the realm.
 */
function createWygloreUIConfiguration(options = {}) {
  const pending = new Set(),
    active = new Map();
  const maxPending = options.maxPending ?? 64,
    maxRounds = options.maxRounds ?? 64;
  let closed = false,
    failure,
    flushing;
  function error(code, message) {
    return Object.assign(new Error(message), { code });
  }
  function healthy() {
    if (failure) throw failure;
    if (closed)
      throw error(
        "PLUGIN_UI_CONFIGURATION_CLOSED",
        "Original UI configuration owner is closed",
      );
    options.check?.();
    options.signal?.throwIfAborted();
  }
  function callback(value) {
    if (typeof value !== "function")
      throw error(
        "PLUGIN_UI_CONFIGURATION_INVALID",
        "Original configuration callback is required",
      );
  }
  function fail(cause) {
    failure ??= cause;
    throw failure;
  }
  function schedule(flush) {
    healthy();
    callback(flush);
    if (!pending.has(flush) && pending.size + active.size >= maxPending)
      return fail(
        error(
          "PLUGIN_UI_CONFIGURATION_LIMIT",
          "Pending original configuration callback budget exceeded",
        ),
      );
    pending.add(flush);
  }
  function run(key, operation) {
    healthy();
    callback(key);
    callback(operation);
    // A timer that already started is awaited, never invoked a second time.
    if (active.has(key)) return active.get(key);
    pending.delete(key);
    const task = Promise.resolve()
      .then(() => {
        healthy();
        return operation();
      })
      .then(() => healthy())
      .catch(fail)
      .finally(() => active.delete(key));
    active.set(key, task);
    task.catch(() => {});
    return task;
  }
  function flush() {
    healthy();
    if (flushing) return flushing;
    const task = (async () => {
      for (let round = 0; round < maxRounds; round++) {
        healthy();
        // Each flush cancels its own reviewed timer before the original save.
        const selected = [...pending];
        await Promise.all(
          selected.map((flush) =>
            Promise.resolve().then(() => {
              healthy();
              return flush();
            }),
          ),
        );
        await Promise.all([...active.values()]);
        // The original provider queue cancels its own 400ms timers and reports
        // any failed key operation. No general browser timer is awaited.
        await options.flushFields?.();
        healthy();
        if (!pending.size && !active.size) return;
      }
      throw error(
        "PLUGIN_UI_CONFIGURATION_LIMIT",
        "Original configuration settlement budget exceeded",
      );
    })()
      .catch(fail)
      .finally(() => {
        flushing = undefined;
      });
    flushing = task;
    task.catch(() => {});
    return task;
  }
  return Object.freeze({
    schedule,
    run,
    flush,
    pending: () => pending.size + active.size,
    assertHealthy: healthy,
    close() {
      closed = true;
      pending.clear();
      active.clear();
    },
  });
}

/** Confirmation/lifecycle transforms run first. Independently verify the raw
 * pinned author file, then match only this untouched reviewed configuration
 * profile in the executable copy. The stored plugin is never replaced.
 */
function instrumentWygloreUIConfiguration(
  originalSource,
  executionCopy = originalSource,
) {
  verifyWygloreScript(originalSource);
  validateWygloreUIConfiguration(originalSource);
  validateWygloreUIConfiguration(executionCopy);
  if (executionCopy.includes('"' + PORT + '"'))
    throw Error("WygLore UI configuration port was already installed");
  const observedRun = `await globalThis.${PORT}.run(flushSave,saveNow)`;
  let result = executionCopy.replace(
    PROFILE.scheduleSave,
    PROFILE.scheduleSave
      .replace("await saveNow()", observedRun)
      .replace("},250)}", `},250),globalThis.${PORT}.schedule(flushSave)}`),
  );
  result = result.replace(
    PROFILE.flushSave,
    PROFILE.flushSave.replace("await saveNow()", observedRun),
  );
  for (const input of Object.values(DELAYED_INPUT_PROFILE)) {
    const run = `globalThis.${PORT}.run(${input.flush},${input.operation})`;
    const declaration =
      `${input.declaration},${input.operation}=${input.callback},` +
      `${input.flush}=()=>{${input.timer}&&(clearTimeout(${input.timer}),${input.timer}=null);return ${run}}`;
    // Move the untouched author callback into the same lexical closure. Both
    // its timer and a checkpoint flush invoke it through the same dedup key.
    const registration = input.registration
      .replace(input.callback, `()=>${run}`)
      .replace(
        ",400)})",
        `,400),globalThis.${PORT}.schedule(${input.flush})})`,
      );
    result = result
      .replace(input.declaration, declaration)
      .replace(input.registration, registration);
  }
  const end = result.lastIndexOf("})();");
  if (end < 0 || result.slice(end + 5).trim())
    throw Error(
      "WygLore outer closure changed before configuration instrumentation",
    );
  const footer = `\n;Object.defineProperty(globalThis,"${PORT}",{value:(${createWygloreUIConfiguration.toString()})({flushFields:()=>providerFieldSaves?.flush()}),configurable:false,writable:false});\n`;
  return result.slice(0, end) + footer + result.slice(end);
}
module.exports = {
  PORT,
  PROFILE,
  DELAYED_INPUT_PROFILE,
  createWygloreUIConfiguration,
  validateWygloreUIConfiguration,
  instrumentWygloreUIConfiguration,
};
