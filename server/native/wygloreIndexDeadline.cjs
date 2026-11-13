"use strict";

const { createHash } = require("node:crypto");
const { getWygloreRelease } = require("./wygloreContract.cjs");

const PORT = "__RISU_WYGLORE_INDEX_DEADLINE";
const PROFILES = Object.freeze({
  "5829457ed4a8b63a5c61b0048aa2b5cb53837b4652c6907077d97cc54cfb2d9c":
    Object.freeze({
      single: Object.freeze({
        signature:
          "async function extractCanonMetaFor(unitContent,client,language,signal,timeoutMs)",
        length: 2183,
        sha256:
          "e0061735819667a26ea50b66a25bc6a9cd6de8111b3870a68e69dfcb70e72741",
      }),
      batch: Object.freeze({
        signature:
          "async function extractCanonMetaForBatch(targets,client,language,signal,timeoutMs)",
        length: 2216,
        sha256:
          "671b0d5895829aa26a431383816657f84fc24452c0f2492dd3c3e5766567df2b",
      }),
      complete: Object.freeze({
        signature: "async complete(userPrompt,opts)",
        length: 6853,
        sha256:
          "8b08fa1188bc3ea4be793a1027924b11bc28dbb26d92513e22b19598ae1d6a62",
        signal: "sig",
      }),
    }),
  ed11f68de317efd6654a0c9ea4b70021a62138fc26ef8e2521445a8f4973ffd9:
    Object.freeze({
      single: Object.freeze({
        signature:
          "async function extractCanonMetaFor(unitContent,client,language,signal,timeoutMs)",
        length: 2188,
        sha256:
          "a48145d2291c5e5a5e5a236deb91230c1dda98581d094e6ffc8d0165d6353523",
      }),
      batch: Object.freeze({
        signature:
          "async function extractCanonMetaForBatch(targets,client,language,signal,timeoutMs)",
        length: 2217,
        sha256:
          "31fbaa0f261686c7b2191b92ade3dd47452c17642d140bcea433e70616131321",
      }),
      complete: Object.freeze({
        signature:
          "async#complete(userPrompt,opts,assertCurrent,retainCleanup)",
        length: 6955,
        sha256:
          "cc115aa7d938bf8285a1978bace1b26f39a516d0b94328e8de18b7d9304f6763",
        signal: "sig2",
      }),
    }),
});
const CHILD_SEAM =
  "__wlServerSignal=>{hostInit={...hostInit,signal:__wlServerSignal}}";

function replaceOnce(text, from, to) {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + from.length) >= 0)
    throw Error("Reviewed WygLore index deadline seam differs");
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** Mark only the author's two Canon-index extraction calls. Their own complete
 * timer, not an untrusted abort message, proves an optional index deadline.
 * This executes after the reviewed lifecycle/cancellation/endpoint adapters.
 */
function instrumentWygloreIndexDeadline(original, executable = original) {
  const release = getWygloreRelease(original),
    profile = PROFILES[release.sha256];
  if (!profile) throw Error("WygLore index deadline release is not reviewed");
  if (
    typeof executable !== "string" ||
    executable.includes("__wlServerIndex") ||
    executable.includes(PORT)
  )
    throw Error("WygLore index deadline adapter identifier collision");
  const edits = [];
  for (const [kind, seam] of Object.entries(profile)) {
    const start = executable.indexOf(seam.signature);
    if (
      start < 0 ||
      executable.indexOf(seam.signature, start + seam.signature.length) >= 0
    )
      throw Error("Reviewed WygLore index deadline function count differs");
    const text = executable.slice(start, start + seam.length);
    if (createHash("sha256").update(text).digest("hex") !== seam.sha256)
      throw Error("Reviewed WygLore index deadline function differs");
    const value =
      kind === "complete"
        ? replaceOnce(
            text,
            "_foreground=!(opts&&opts.background===!0);",
            '_foreground=!(opts&&opts.background===!0);if(opts?.__wlServerIndexDeadline===__wlServerIndexToken&&opts.background===!0&&slot==="staged"&&_slowAbortMs===0&&opts.timeoutMs===_effTimeoutMs)__wlServerIndexPort.register(__wlServerIndexToken,' +
              seam.signal +
              ",_toCtl.signal,opts?.signal,getPipelineSignal(),_effTimeoutMs,provider.id,model);",
          )
        : replaceOnce(
            text,
            "background:!0,timeoutMs:",
            "background:!0,__wlServerIndexDeadline:__wlServerIndexToken,timeoutMs:",
          );
    edits.push({ start, end: start + seam.length, value });
  }
  const child = executable.indexOf(CHILD_SEAM);
  if (
    child < 0 ||
    executable.indexOf(CHILD_SEAM, child + CHILD_SEAM.length) >= 0
  )
    throw Error("Reviewed WygLore index transport inheritance seam differs");
  edits.push({
    start: child,
    end: child + CHILD_SEAM.length,
    value:
      "__wlServerSignal=>{hostInit={...hostInit,signal:__wlServerSignal};__wlServerIndexPort.inherit(signal,__wlServerSignal)}",
  });
  const opening = original.indexOf("(()=>{");
  if (
    opening < 0 ||
    executable.slice(0, opening + 6) !== original.slice(0, opening + 6)
  )
    throw Error("Reviewed WygLore index deadline outer closure differs");
  edits.push({
    start: opening + 6,
    end: opening + 6,
    value:
      "const __wlServerIndexPort=globalThis." +
      PORT +
      ";delete globalThis." +
      PORT +
      ';if(!__wlServerIndexPort||typeof __wlServerIndexPort.register!=="function")throw Error("WygLore index deadline host is required");const __wlServerIndexToken=__wlServerIndexPort.token;',
  });
  let result = executable;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  return result;
}

function isSignal(value) {
  return value instanceof AbortSignal;
}

// Model generation is a known read-only calculation. Auth, predictions,
// arbitrary proxies/providers and custom model operations never enter here.
function isVertexGeminiGeneration(target, model) {
  if (
    !(target instanceof URL) ||
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.port ||
    target.hash ||
    !/^gemini-[a-z0-9][a-z0-9._-]{0,120}$/.test(model)
  )
    return false;
  const match =
    /^\/v1\/projects\/[^/]+\/locations\/([a-z0-9-]+)\/publishers\/google\/models\/([^/:]+):(streamGenerateContent|generateContent)$/.exec(
      target.pathname,
    );
  if (!match || match[2] !== model) return false;
  const region = match[1];
  const expectedHost =
    region === "global"
      ? "aiplatform.googleapis.com"
      : region === "us" || region === "eu"
        ? `aiplatform.${region}.rep.googleapis.com`
        : `${region}-aiplatform.googleapis.com`;
  if (target.hostname !== expectedHost) return false;
  return match[3] === "streamGenerateContent"
    ? target.searchParams.get("alt") === "sse" &&
        [...target.searchParams.keys()].every((key) => key === "alt")
    : !target.search;
}

/** The port is consumed into an execution-only lexical binding before author
 * initialization. Signal identities and an actual own-controller abort are
 * required; matching text, error codes or caller supplied fields cannot grant
 * the exception. Handled errors are also tracked by object identity so generic
 * promise observers cannot accidentally poison the original local fallback.
 */
function createWygloreIndexDeadlineRegistry({ enabled = false, signal } = {}) {
  const token = Object.freeze({});
  let active = true,
    proofs = new WeakMap();
  const handled = new WeakSet();
  const executionPort = Object.freeze({
    token,
    register(
      capability,
      request,
      timer,
      caller,
      pipeline,
      timeoutMs,
      provider,
      model,
    ) {
      if (
        !active ||
        !enabled ||
        capability !== token ||
        ![request, timer, pipeline].every(isSignal) ||
        (caller != null && !isSignal(caller)) ||
        [request, caller, pipeline].includes(timer) ||
        [request, timer, caller, pipeline].some((item) => item?.aborted) ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 120000 ||
        provider !== "vertex" ||
        typeof model !== "string" ||
        !/^gemini-[a-z0-9][a-z0-9._-]{0,120}$/.test(model)
      )
        return false;
      const proof = {
        timer,
        caller,
        pipeline,
        model,
        timeoutMs,
        expired: false,
      };
      timer.addEventListener(
        "abort",
        () => {
          proof.expired = timer.reason === `llm-timeout-${timeoutMs}ms`;
        },
        { once: true },
      );
      proofs.set(request, proof);
      return true;
    },
    inherit(parent, child) {
      if (!active || !enabled || !isSignal(parent) || !isSignal(child)) return;
      const proof = proofs.get(parent);
      if (proof) proofs.set(child, proof);
    },
  });
  function expected(request, target) {
    if (
      !active ||
      !enabled ||
      signal?.aborted ||
      !isSignal(request) ||
      !request.aborted
    )
      return false;
    const proof = proofs.get(request);
    return !!(
      proof?.expired &&
      proof.timer.aborted &&
      !proof.caller?.aborted &&
      !proof.pipeline.aborted &&
      request.reason === proof.timer.reason &&
      isVertexGeminiGeneration(target, proof.model)
    );
  }
  function deadlineError() {
    const error = new Error(
      "Original Canon index calculation reached its own deadline",
    );
    handled.add(error);
    return error;
  }
  return {
    executionPort,
    isExpected(request, target) {
      return expected(request, target);
    },
    // A repeated author fallback with the same expired operation cannot send
    // another physical HTTP request. Normal original flow also checks abort.
    beforeRequest(request, target) {
      return expected(request, target) ? deadlineError() : null;
    },
    failure(error, request, target) {
      if (
        !expected(request, target) ||
        !(error === request.reason || error?.name === "AbortError")
      )
        return null;
      return deadlineError();
    },
    isHandled(error) {
      return !!error && typeof error === "object" && handled.has(error);
    },
    close() {
      active = false;
      proofs = new WeakMap();
    },
  };
}

module.exports = {
  PORT,
  PROFILES,
  instrumentWygloreIndexDeadline,
  createWygloreIndexDeadlineRegistry,
};
