// Shared by canonical server writes and the browser's private pending view.
export class CharacterNavigationError extends Error {}
const fail = (message) => {
  throw new CharacterNavigationError(message);
};
const folder = (value) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  typeof value.id === "string" &&
  Array.isArray(value.data);
const id = (value) => {
  if (typeof value !== "string" || !value || value.length > 256)
    fail("Invalid navigation ID");
  return value;
};
const same = (a, b) => a?.kind === b?.kind && a?.id === b?.id;

export function projectCharacterOrder(raw, visibleIds) {
  const remaining = new Set(visibleIds),
    result = [],
    seenFolders = new Set();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry === "string") {
      if (remaining.delete(entry)) result.push(entry);
    } else if (folder(entry)) {
      if (seenFolders.has(entry.id)) continue;
      seenFolders.add(entry.id);
      const data = entry.data.filter((value) => remaining.delete(value));
      if (data.length) result.push({ ...structuredClone(entry), data });
    }
  }
  return [...result, ...remaining];
}

export function applyCharacterNavigation(raw, action, visibleIds) {
  if (!Array.isArray(raw)) fail("Character order must be an array");
  if (!action || typeof action !== "object") fail("Invalid navigation action");
  const order = structuredClone(raw),
    visible = new Set(visibleIds),
    folders = new Map();
  for (const entry of order) {
    if (!folder(entry)) continue;
    if (folders.has(entry.id)) fail("Ambiguous folder ID");
    folders.set(entry.id, entry);
  }
  const getFolder = (folderId) => {
    const value = folders.get(id(folderId));
    if (!value) fail("Folder does not exist");
    if (value.data.some((value) => typeof value !== "string"))
      fail("Invalid folder membership");
    return value;
  };
  const locate = (source) => {
    id(source?.id);
    if (source.kind === "folder") {
      const value = getFolder(source.id);
      return { list: order, index: order.indexOf(value), owner: null, value };
    }
    if (source.kind !== "character" || !visible.has(source.id))
      fail("Character is no longer visible");
    const found = [];
    for (let i = 0; i < order.length; i++) {
      if (order[i] === source.id)
        found.push({ list: order, index: i, owner: null, value: source.id });
      else if (folder(order[i]))
        for (let j = 0; j < order[i].data.length; j++)
          if (order[i].data[j] === source.id)
            found.push({
              list: order[i].data,
              index: j,
              owner: order[i],
              value: source.id,
            });
    }
    if (found.length > 1) fail("Ambiguous character membership");
    if (found.length) return found[0];
    // Materialize only the visible member used by this intent. Never write the
    // whole projected list, which excludes hidden and unknown imported members.
    order.push(source.id);
    return {
      list: order,
      index: order.length - 1,
      owner: null,
      value: source.id,
    };
  };
  const prune = (owner) => {
    if (owner && !owner.data.length) {
      const index = order.indexOf(owner);
      if (index >= 0) order.splice(index, 1);
    }
  };
  if (action.type === "edit-folder") {
    const value = getFolder(action.folderId),
      updates = action.updates;
    if (
      !updates ||
      typeof updates !== "object" ||
      Array.isArray(updates) ||
      !Object.keys(updates).length
    )
      fail("Invalid folder edits");
    for (const [key, change] of Object.entries(updates)) {
      if (
        !["name", "color", "img", "imgFile"].includes(key) ||
        (typeof change !== "string" && !(key === "imgFile" && change === null))
      )
        fail("Invalid folder field");
      value[key] = change;
    }
    return order;
  }
  if (action.type === "move") {
    const source = locate(action.source),
      destination = action.destination;
    if (
      !destination ||
      !Object.hasOwn(destination, "folderId") ||
      !Object.hasOwn(destination, "before")
    )
      fail("Invalid move destination");
    if (same(action.source, destination.before)) return order;
    if (action.source.kind === "folder" && destination.folderId !== null)
      fail("Folders cannot be nested");
    const target =
      destination.folderId === null
        ? order
        : getFolder(destination.folderId).data;
    const anchor =
      destination.before === null ? null : locate(destination.before);
    if (anchor && anchor.list !== target)
      fail("Anchor is outside the destination");
    source.list.splice(source.index, 1);
    const position = anchor ? target.indexOf(anchor.value) : target.length;
    if (position < 0) fail("Move anchor disappeared");
    target.splice(position, 0, source.value);
    prune(source.owner);
    return order;
  }
  if (action.type === "group") {
    const source = locate({ kind: "character", id: action.sourceId }),
      target = locate(action.target);
    if (same({ kind: "character", id: action.sourceId }, action.target))
      return order;
    if (target.list !== order) fail("Group target must be at the top level");
    let created;
    if (action.target.kind === "character") {
      const input = action.folder;
      id(input?.id);
      if (
        folders.has(input.id) ||
        typeof input.name !== "string" ||
        typeof input.color !== "string"
      )
        fail("Invalid new folder");
      created = {
        id: input.id,
        name: input.name,
        color: input.color,
        data: [action.sourceId, action.target.id],
      };
    }
    source.list.splice(source.index, 1);
    if (created) order.splice(order.indexOf(target.value), 1, created);
    else getFolder(action.target.id).data.push(action.sourceId);
    prune(source.owner);
    return order;
  }
  fail("Unknown character navigation action");
}

// Permanent deletion removes known relationships, rather than leaving an old
// incarnation's position ready for accidental ID reuse. Unknown entries stay.
export function removeCharacterOrderReferences(raw, characterId) {
  if (!Array.isArray(raw)) return raw;
  const result = [];
  for (const entry of raw) {
    if (entry === characterId) continue;
    if (folder(entry) && entry.data.includes(characterId)) {
      const data = entry.data.filter((value) => value !== characterId);
      if (data.length) result.push({ ...entry, data });
    } else result.push(entry);
  }
  return result;
}
