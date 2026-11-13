"use strict";
const { createHash } = require("node:crypto");
const { RuntimeError } = require("../entity/errors.cjs");

const MARKER_KEY = "__wl_marker__";
const EMBED_FIELD = "associationTree";
const READ_HISTORY_LIMIT = 64;

// Match the pinned author's predicate, including legacy marker migration.
function isMarker(value) {
  return !!(
    value &&
    (value.key === MARKER_KEY ||
      (typeof value.comment === "string" &&
        /^wl\.marker\.v\d+$/i.test(value.comment)))
  );
}

function clone(value) {
  const json = JSON.stringify(value, (_key, item) => {
    if (
      ["function", "symbol", "bigint"].includes(typeof item) ||
      (typeof item === "number" && !Number.isFinite(item))
    )
      throw new RuntimeError(
        "PLUGIN_JOB_CONTEXT_INVALID_WRITE",
        "Plugin chat data must contain JSON values",
      );
    return item;
  });
  return json === undefined ? undefined : JSON.parse(json);
}

function canonical(value) {
  const sort = (item) =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sort(item[key])]),
          )
        : item;
  return JSON.stringify(sort(clone(value)));
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function lore(chat) {
  if (chat.localLore == null) return [];
  if (!Array.isArray(chat.localLore))
    throw new RuntimeError(
      "PLUGIN_JOB_CONTEXT_INVALID_WRITE",
      "Plugin chat lore must be an array",
    );
  return chat.localLore;
}

function markers(chat) {
  return lore(chat).filter(isMarker);
}

function embed(chat) {
  const exists =
    Object.hasOwn(chat, EMBED_FIELD) && chat[EMBED_FIELD] !== undefined;
  return { exists, ...(exists ? { value: chat[EMBED_FIELD] } : {}) };
}

function ownedSignatures(chat) {
  return {
    markers: digest(markers(chat)),
    embed: digest(embed(chat)),
  };
}

function signatures(chat) {
  const other = { ...chat };
  delete other.localLore;
  delete other[EMBED_FIELD];
  return {
    other: digest({
      other,
      nonMarkerLore: lore(chat).filter((row) => !isMarker(row)),
    }),
    ...ownedSignatures(chat),
  };
}

function replaceMarkers(chat, rows) {
  const current = lore(chat);
  const first = current.findIndex(isMarker);
  const insertion =
    first < 0
      ? current.length
      : current.slice(0, first).filter((row) => !isMarker(row)).length;
  const ordinary = current.filter((row) => !isMarker(row));
  chat.localLore = [
    ...ordinary.slice(0, insertion),
    ...clone(rows),
    ...ordinary.slice(insertion),
  ];
}

/**
 * One generation's private WygLore view. Reads follow current engine state;
 * only marker/embedded-memory writes are staged. No network/lifecycle policy is
 * implemented here, and main execution failures are never cleared or hidden.
 */
function createWygloreJobContext(mainContext) {
  mainContext.ensureHealthy();
  const targetId = mainContext.getCurrentChat().id;
  let failure;
  let closed = false;
  let pending = {};
  const issued = new WeakMap();
  const history = [];

  function ensureHealthy() {
    mainContext.ensureHealthy();
    if (failure) throw failure;
    if (closed)
      throw new RuntimeError(
        "PLUGIN_JOB_CONTEXT_CLOSED",
        "Plugin job context is closed",
      );
  }

  function fail(reason) {
    failure ??=
      reason instanceof Error
        ? reason
        : new RuntimeError("PLUGIN_JOB_CONTEXT_FAILED", String(reason));
    throw failure;
  }

  function reject(code, message) {
    return fail(new RuntimeError(code, message));
  }

  function guarded(action) {
    ensureHealthy();
    try {
      return action();
    } catch (error) {
      failure ??= error;
      throw failure;
    }
  }

  function current() {
    const chat = mainContext.getCurrentChat();
    if (!chat || chat.id !== targetId)
      reject("PLUGIN_JOB_CONTEXT_CONFLICT", "The main chat identity changed");
    return chat;
  }

  function view(raw) {
    const chat = clone(raw);
    if (pending.markers) replaceMarkers(chat, pending.markers.value);
    if (pending.embed) {
      if (pending.embed.value.exists)
        chat[EMBED_FIELD] = clone(pending.embed.value.value);
      else delete chat[EMBED_FIELD];
    }
    return chat;
  }

  function issue(raw) {
    const chat = view(raw);
    const base = signatures(raw);
    const record = {
      view: {
        ...base,
        markers: pending.markers?.signature ?? base.markers,
        embed: pending.embed?.signature ?? base.embed,
      },
      main: base,
    };
    issued.set(chat, record);
    // Retain only hashes, never old message bodies or entire embedded graphs.
    const key = canonical(record);
    if (!history.some((entry) => entry.key === key)) {
      history.push({ key, record });
      if (history.length > READ_HISTORY_LIMIT) history.shift();
    }
    return chat;
  }

  function clonePluginChat() {
    return guarded(() => issue(current()));
  }

  function trackPluginCharacter(character) {
    return guarded(() => {
      if (
        !character ||
        typeof character !== "object" ||
        Array.isArray(character)
      )
        reject(
          "PLUGIN_JOB_CONTEXT_INVALID_WRITE",
          "Plugin character view is invalid",
        );
      const raw = current();
      if (Array.isArray(character.chats)) {
        character.chats = character.chats.map((chat) =>
          chat?.id === targetId ? issue(raw) : chat,
        );
      }
      return character;
    });
  }

  function getCurrentCharacter(...args) {
    return guarded(() =>
      trackPluginCharacter(clone(mainContext.getCurrentCharacter(...args))),
    );
  }

  function plan(record, candidate, candidateSignatures, raw, rawSignatures) {
    if (record.view.other !== candidateSignatures.other)
      throw new RuntimeError(
        "PLUGIN_JOB_CONTEXT_INVALID_WRITE",
        "Plugin chat write changed fields outside WygLore memory",
      );
    const existingView = {
      markers: pending.markers?.signature ?? rawSignatures.markers,
      embed: pending.embed?.signature ?? rawSignatures.embed,
    };
    const next = { ...pending };
    for (const field of ["markers", "embed"]) {
      if (candidateSignatures[field] === record.view[field]) continue;
      const expected = pending[field]?.expected ?? record.main[field];
      if (rawSignatures[field] !== expected)
        throw new RuntimeError(
          "PLUGIN_JOB_CONTEXT_CONFLICT",
          "Main execution changed a WygLore memory field",
        );
      if (
        existingView[field] !== record.view[field] &&
        existingView[field] !== candidateSignatures[field]
      )
        throw new RuntimeError(
          "PLUGIN_JOB_CONTEXT_CONFLICT",
          "Plugin chat write is based on a stale memory view",
        );
      if (candidateSignatures[field] === rawSignatures[field]) {
        delete next[field];
      } else {
        next[field] = {
          expected,
          signature: candidateSignatures[field],
          value: clone(
            field === "markers" ? markers(candidate) : embed(candidate),
          ),
        };
      }
    }
    return next;
  }

  function stagePluginChat(chat) {
    return guarded(() => {
      if (
        !chat ||
        typeof chat !== "object" ||
        Array.isArray(chat) ||
        chat.id !== targetId
      )
        reject(
          "PLUGIN_JOB_CONTEXT_INVALID_WRITE",
          "Plugin chat write has another identity",
        );
      const record = issued.get(chat);
      const candidate = clone(chat);
      const candidateSignatures = signatures(candidate);
      const raw = current();
      const rawSignatures = ownedSignatures(raw);
      if (record) {
        pending = plan(
          record,
          candidate,
          candidateSignatures,
          raw,
          rawSignatures,
        );
        return;
      }
      // A host clone may lose object identity. Accept its fingerprint only if
      // every matching issued read yields the same unambiguous patch.
      const records = history
        .map((entry) => entry.record)
        .filter((entry) => entry.view.other === candidateSignatures.other);
      if (!records.length)
        reject(
          "PLUGIN_JOB_CONTEXT_INVALID_WRITE",
          "Plugin chat write has no issued read",
        );
      const plans = records.map((entry) =>
        plan(entry, candidate, candidateSignatures, raw, rawSignatures),
      );
      const first = canonical(plans[0]);
      if (plans.some((entry) => canonical(entry) !== first))
        reject(
          "PLUGIN_JOB_CONTEXT_CONFLICT",
          "Plugin chat write has ambiguous read provenance",
        );
      pending = plans[0];
    });
  }

  function commit() {
    return guarded(() => {
      const raw = current();
      const before = ownedSignatures(raw);
      for (const field of ["markers", "embed"]) {
        if (pending[field] && pending[field].expected !== before[field])
          reject(
            "PLUGIN_JOB_CONTEXT_CONFLICT",
            "Main execution changed a staged WygLore memory field",
          );
      }
      const fields = Object.keys(pending);
      const merged = fields.length ? view(raw) : undefined;
      // Validate and construct everything before the single main mutation.
      if (merged) mainContext.setCurrentChat(merged);
      closed = true;
      pending = {};
      history.length = 0;
      return { committed: true, fields };
    });
  }

  function discard() {
    closed = true;
    pending = {};
    history.length = 0;
  }

  const context = Object.assign(Object.create(mainContext), {
    ensureHealthy,
    fail,
    getDatabase: (...args) => guarded(() => mainContext.getDatabase(...args)),
    ...(typeof mainContext.readResourceValue === "function"
      ? {
          readResourceValue: (...args) =>
            guarded(() => mainContext.readResourceValue(...args)),
        }
      : {}),
    getCurrentChat: clonePluginChat,
    clonePluginChat,
    getCurrentCharacter,
    trackPluginCharacter,
    setCurrentChat: stagePluginChat,
    stagePluginChat,
  });
  return { context, commit, discard };
}

module.exports = { createWygloreJobContext };
