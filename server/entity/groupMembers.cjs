"use strict";
const { RuntimeError } = require("./errors.cjs");
const keys = ["characters", "characterTalks", "characterActive"];

// Portable arrays retain their exact shape. This relation supplies stable
// member revisions, including removals; duplicate legacy occurrences stay visible.
function members(definition) {
  const result = new Map();
  if (definition.type !== "group" || !Array.isArray(definition.characters))
    return result;
  definition.characters.forEach((memberId, position) => {
    if (typeof memberId !== "string" || !memberId) return;
    const slots = result.get(memberId) ?? [];
    slots.push({
      position,
      ...(Array.isArray(definition.characterTalks) &&
      position < definition.characterTalks.length
        ? { talkness: definition.characterTalks[position] }
        : {}),
      ...(Array.isArray(definition.characterActive) &&
      position < definition.characterActive.length
        ? { active: definition.characterActive[position] }
        : {}),
    });
    result.set(memberId, slots);
  });
  return result;
}
function record(store, groupId, before, after, json) {
  if (
    keys.every((key) => before[key] === after[key]) &&
    before.type === after.type
  )
    return [];
  const old = members(before),
    next = members(after),
    changed = [];
  for (const memberId of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(memberId) ?? [],
      b = next.get(memberId) ?? [];
    if (json(a) === json(b)) continue;
    const content = (slots) =>
      slots.map(({ position: _position, ...settings }) => settings);
    const increment = Number(json(content(a)) !== json(content(b)));
    store.db
      .prepare(
        `INSERT INTO group_members(group_id,member_id,revision,occurrences,sort_position,slots_json)
      VALUES (?,?,1,?,?,?) ON CONFLICT(group_id,member_id) DO UPDATE SET
      revision=revision+?,occurrences=excluded.occurrences,sort_position=excluded.sort_position,slots_json=excluded.slots_json`,
      )
      .run(
        groupId,
        memberId,
        b.length,
        b[0]?.position ?? -1,
        json(b),
        increment,
      );
    changed.push(header(store, groupId, memberId));
  }
  return changed;
}
function migrate(store, json) {
  for (const row of store.db
    .prepare("SELECT id,definition FROM characters WHERE kind='group'")
    .all())
    record(store, row.id, {}, JSON.parse(row.definition), json);
}
function header(store, groupId, memberId) {
  const row = store.db
    .prepare("SELECT * FROM group_members WHERE group_id=? AND member_id=?")
    .get(groupId, memberId);
  return {
    memberId,
    revision: row?.revision ?? 0,
    slots: row ? JSON.parse(row.slots_json) : [],
  };
}
function headers(store, groupId) {
  return store.db
    .prepare(
      "SELECT member_id FROM group_members WHERE group_id=? AND occurrences>0 ORDER BY sort_position,member_id",
    )
    .all(groupId)
    .map((row) => header(store, groupId, row.member_id));
}
function orderRevision(store, groupId) {
  return (
    store.fieldRevisions({ scope: "character", entityId: groupId })
      .characters ?? 0
  );
}
function definitionHeader(store, characterId) {
  const row = store.db
    .prepare("SELECT definition FROM characters WHERE id=?")
    .get(characterId);
  return (
    row && {
      definition: JSON.parse(row.definition),
      entityEpoch: store.fieldEpoch({
        scope: "character",
        entityId: characterId,
      }),
      fieldRevisions: store.fieldRevisions({
        scope: "character",
        entityId: characterId,
      }),
    }
  );
}
function read(store, groupId, memberId) {
  const group = definitionHeader(store, groupId);
  if (!group || group.definition.type !== "group")
    throw new RuntimeError("NOT_FOUND", "Group does not exist");
  return {
    groupId,
    cursor: store.cursor(),
    entityEpoch: group.entityEpoch,
    orderRevision: orderRevision(store, groupId),
    member: header(store, groupId, memberId),
  };
}
function apply(store, command, validation) {
  const { id, integer, object, json } = validation;
  const groupId = id(command.groupId, "group ID"),
    memberId = id(command.memberId, "member ID");
  const group = definitionHeader(store, groupId);
  if (!group || group.definition.type !== "group")
    throw new RuntimeError("NOT_FOUND", "Group does not exist");
  store.expectRevision(
    integer(command.expectedEpoch, "group epoch"),
    group.entityEpoch,
  );
  store.expectRevision(
    integer(command.expectedOrderRevision, "group order revision"),
    orderRevision(store, groupId),
  );
  const member = header(store, groupId, memberId);
  store.expectRevision(
    integer(command.expectedMemberRevision, "group member revision"),
    member.revision,
  );
  const value = group.definition;
  if (
    !keys.every((key) => Array.isArray(value[key])) ||
    value.characterTalks.length !== value.characters.length ||
    value.characterActive.length !== value.characters.length
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Group arrays have an inconsistent shape; editing requires explicit repair",
    );
  const next = Object.fromEntries(keys.map((key) => [key, [...value[key]]]));
  const action = command.action;
  if (!["add", "remove", "set-active", "set-talkness"].includes(action))
    throw new RuntimeError("INVALID_COMMAND", "Unknown group member action");
  let greeting;
  if (action === "add") {
    if (member.slots.length)
      throw new RuntimeError(
        "IDENTITY_CONFLICT",
        "Character is already in the group",
      );
    const source = definitionHeader(store, memberId);
    if (!source || source.definition.type !== "character")
      throw new RuntimeError(
        "NOT_FOUND",
        "A live character is required for a group member",
      );
    if (command.greeting !== undefined) {
      const g = object(command.greeting, "group greeting");
      const chat = store.requireChat(id(g.chatId, "greeting chat ID"));
      if (chat.character_id !== groupId)
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Greeting chat belongs to another group",
        );
      store.expectRevision(
        integer(g.expectedChatEpoch, "chat epoch"),
        store.fieldEpoch({ scope: "chat", entityId: chat.id }),
      );
      store.expectRevision(
        integer(g.expectedChatRevision, "chat revision"),
        chat.revision,
      );
      store.expectRevision(
        integer(g.expectedMemberEpoch, "member epoch"),
        source.entityEpoch,
      );
      store.expectRevision(
        integer(g.expectedGreetingRevision, "greeting revision"),
        source.fieldRevisions.firstMessage ?? 0,
      );
      store.requireUnlocked(chat.id);
      if (typeof source.definition.firstMessage !== "string")
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Character greeting must be a string",
        );
      greeting = {
        chatId: chat.id,
        messageId: id(g.messageId, "greeting message ID"),
        message: {
          role: "char",
          data: source.definition.firstMessage,
          saying: memberId,
        },
      };
    }
    next.characters.push(memberId);
    next.characterTalks.push((1 / 6) * 4);
    next.characterActive.push(true);
  } else {
    const position = integer(command.position, "group member position");
    if (
      next.characters[position] !== memberId ||
      !member.slots.some((slot) => slot.position === position)
    )
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Group member position changed",
      );
    if (action === "remove")
      for (const key of keys) next[key].splice(position, 1);
    else if (action === "set-active") {
      if (typeof command.value !== "boolean")
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Member activity must be boolean",
        );
      next.characterActive[position] = command.value;
    } else {
      if (
        typeof command.value !== "number" ||
        !Number.isFinite(command.value) ||
        command.value < 0 ||
        command.value > 1
      )
        throw new RuntimeError(
          "INVALID_COMMAND",
          "Member talkness must be between zero and one",
        );
      next.characterTalks[position] = command.value;
    }
  }
  if (action !== "add" && command.greeting !== undefined)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Only adding a member can include a greeting",
    );
  const edits = keys
    .filter((key) => json(next[key]) !== json(value[key]))
    .map((key) => ({
      scope: "character",
      entityId: groupId,
      key,
      expectedRevision: group.fieldRevisions[key] ?? 0,
      expectedEpoch: group.entityEpoch,
      value: next[key],
    }));
  if (edits.length) store.applyFields(edits);
  if (greeting) store.mutate({ type: "append-message", ...greeting });
  return {
    groupId,
    member: header(store, groupId, memberId),
    orderRevision: orderRevision(store, groupId),
  };
}
module.exports = {
  record,
  migrate,
  header,
  headers,
  read,
  apply,
  orderRevision,
};
