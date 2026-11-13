"use strict";

const { RuntimeError } = require("../entity/errors.cjs");
const pluginCatalog = require("../entity/pluginCatalog.cjs");

const COLLECTION_FIELDS = Object.freeze({
  modules: "module",
  personas: "persona",
  plugins: "plugin",
  botPresets: "preset",
});

/** Additional guards for a plugin's durable derived memory.
 * Ordinary native generation intentionally retains snapshot semantics across
 * same-incarnation configuration edits. A plugin checkpoint is different: its
 * durable graph must not become canonical after one of its source rows changed.
 * Keep these metadata-only guards separate from existing execution read policy.
 */
function createPluginReadDependencies(snapshot, options = {}) {
  const settingsId = options.settingsId || "global";
  const resources = new Map(
    (snapshot.resources || []).map((row) => [
      JSON.stringify([row.kind, row.id]),
      row,
    ]),
  );
  const characters = new Map();
  const chats = new Map();
  const observedResources = new Map();
  const collectionSets = new Map();
  let globalVariables;
  let gardenCatalog;
  let currentScope;
  function invalid(message) {
    throw new RuntimeError("PLUGIN_READ_DEPENDENCY_INVALID", message);
  }
  function identity(id) {
    if (typeof id !== "string" || !id || id.length > 256)
      invalid("Plugin read identity is invalid");
    return id;
  }
  function revision(value) {
    if (!Number.isSafeInteger(value) || value < 0)
      invalid("Plugin read revision is invalid");
    return value;
  }
  function metadata(row) {
    if (!row) invalid("Plugin read has no captured source row");
    return {
      id: identity(row.id),
      revision: revision(row.revision),
      epoch: revision(row.entityEpoch ?? 0),
    };
  }
  function limit() {
    if (
      characters.size +
        chats.size +
        observedResources.size +
        (globalVariables?.rows.length || 0) +
        (gardenCatalog
          ? gardenCatalog.characters.length + gardenCatalog.chats.length
          : 0) +
        (currentScope ? currentScope.chats.length + 1 : 0) >
      4096
    )
      invalid("Plugin read dependency limit exceeded (4096 rows)");
  }
  function observeResource(kind, id) {
    const key = JSON.stringify([kind, id]);
    if (observedResources.has(key)) return;
    const row = resources.get(key);
    observedResources.set(key, { kind, ...metadata(row) });
    limit();
  }
  function observeSettings() {
    observeResource("settings", settingsId);
  }
  function observeGlobalVariables() {
    if (globalVariables) return;
    const rows = (snapshot.resources || [])
      .filter((row) => row.kind === "global-variable")
      .map((row) => {
        const value = metadata(row);
        return { key: value.id, revision: value.revision, epoch: value.epoch };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
    // The original API returns a broad object clone, so property reads cannot be
    // observed afterwards. Guard enumeration as well as existing point values:
    // otherwise an absent toggle created by another device would go unnoticed.
    globalVariables = { ids: rows.map((row) => row.key), rows };
    limit();
  }
  return {
    observeCurrentScope() {
      const captured = snapshot.pluginCurrentScope;
      if (
        captured?.projection !== pluginCatalog.CURRENT_SCOPE_PROJECTION ||
        !Array.isArray(captured.chats)
      )
        invalid(
          "Current-garden index reads require an explicit snapshot capability",
        );
      currentScope ??= pluginCatalog.checkedScopeGuard(captured.guard);
      limit();
    },
    observeCharacter() {
      const row = metadata(snapshot.character);
      characters.set(row.id, row);
      limit();
    },
    observeChat() {
      const row = metadata(snapshot.chat);
      chats.set(row.id, row);
      limit();
    },
    observePlugin(id) {
      observeResource("plugin", identity(id));
    },
    observeDatabaseFields(fields) {
      if (
        !Array.isArray(fields) ||
        fields.some((field) => typeof field !== "string" || !field)
      )
        invalid("Plugin database reads must identify fields");
      for (const field of fields) {
        if (field === "characters") {
          // Other histories are outside an admitted job. A caller must supply an
          // explicit broader snapshot capability before enabling this API field.
          const captured = snapshot.pluginCatalog;
          if (
            captured?.projection !== pluginCatalog.PROJECTION ||
            !Array.isArray(captured.characters)
          )
            invalid(
              "Cross-character plugin reads require an explicit snapshot capability",
            );
          gardenCatalog ??= pluginCatalog.checkedGuard(captured.guard);
          limit();
        }
        observeSettings();
        const kind = COLLECTION_FIELDS[field];
        if (kind) {
          const ids = [];
          for (const row of snapshot.resources || []) {
            if (row.kind === kind) {
              observeResource(kind, row.id);
              ids.push(identity(row.id));
            }
          }
          collectionSets.set(kind, { kind, ids: [...new Set(ids)].sort() });
        }
        if (field === "globalChatVariables") observeGlobalVariables();
      }
    },
    snapshot() {
      return {
        version: 1,
        characters: [...characters.values()].map((row) => ({ ...row })),
        chats: [...chats.values()].map((row) => ({ ...row })),
        resources: [...observedResources.values()].map((row) => ({ ...row })),
        ...(gardenCatalog
          ? { gardenCatalog: structuredClone(gardenCatalog) }
          : {}),
        ...(currentScope
          ? { currentScope: structuredClone(currentScope) }
          : {}),
        ...(collectionSets.size
          ? {
              collectionSets: [...collectionSets.values()].map((row) => ({
                kind: row.kind,
                ids: [...row.ids],
              })),
            }
          : {}),
        ...(globalVariables
          ? {
              globalVariables: {
                ids: [...globalVariables.ids],
                rows: globalVariables.rows.map((row) => ({ ...row })),
              },
            }
          : {}),
      };
    },
  };
}

module.exports = { createPluginReadDependencies };
