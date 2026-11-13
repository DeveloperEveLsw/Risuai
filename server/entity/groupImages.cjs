"use strict";
const { createHash } = require("node:crypto");
const { RuntimeError } = require("./errors.cjs");
const fields = require("./fields.cjs");

// Only membership and source clocks enter the digest; no source definition,
// prompt, chat body or asset bytes are sent as part of a dependency check.
function capture(store, groupId) {
  if (typeof groupId !== "string" || !groupId || groupId.length > 256)
    throw new RuntimeError("INVALID_COMMAND", "Invalid image group ID");
  const group = store.db
    .prepare(
      "SELECT json_extract(definition,'$.type') type, json_extract(definition,'$.characters') members, json_type(definition,'$.characters') membersType FROM characters WHERE id=?",
    )
    .get(groupId);
  if (!group) throw new RuntimeError("NOT_FOUND", "Image group does not exist");
  if (group.type !== "group")
    throw new RuntimeError("INVALID_COMMAND", "Image sources require a group");
  if (
    group.membersType !== null &&
    group.membersType !== undefined &&
    group.membersType !== "array"
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Group membership must be an array",
    );
  let members;
  try {
    members = JSON.parse(group.members ?? "[]");
  } catch {
    throw new RuntimeError("INVALID_COMMAND", "Invalid group image membership");
  }
  if (
    !Array.isArray(members) ||
    members.some((id) => typeof id !== "string" || !id || id.length > 256)
  )
    throw new RuntimeError("INVALID_COMMAND", "Invalid group image membership");
  const membership = {
    scope: "character",
    entityId: groupId,
    key: "characters",
  };
  const revision =
    store.db
      .prepare(
        "SELECT revision FROM entity_field_revisions WHERE scope='character' AND kind='' AND entity_id=? AND key='characters'",
      )
      .get(groupId)?.revision ?? 0;
  const expectedEpoch = fields.epoch(store, membership);
  const hash = createHash("sha256").update(
    JSON.stringify([groupId, expectedEpoch, revision, members.length]),
  );
  const clocks = store.db.prepare(
    "SELECT c.id,COALESCE(f.revision,0) revision,COALESCE(t.revision,0) epoch FROM characters c LEFT JOIN entity_field_revisions f ON f.scope='character' AND f.kind='' AND f.entity_id=c.id AND f.key='image' LEFT JOIN entity_tombstones t ON t.kind='character' AND t.scope='' AND t.id=c.id WHERE c.id=?",
  );
  const seen = new Map();
  for (const id of members) {
    if (!seen.has(id)) {
      const clock = clocks.get(id);
      if (!clock)
        throw new RuntimeError(
          "NOT_FOUND",
          "Group image member no longer exists",
        );
      seen.set(id, clock);
    }
    const clock = seen.get(id);
    hash.update(JSON.stringify([id, clock.epoch, clock.revision]));
  }
  return {
    members,
    guard: {
      groupId,
      expectedEpoch,
      expectedMembershipRevision: revision,
      digest: hash.digest("hex"),
    },
  };
}
function validate(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.groupId !== "string" ||
    !input.groupId ||
    input.groupId.length > 256 ||
    !Number.isSafeInteger(input.expectedEpoch) ||
    input.expectedEpoch < 0 ||
    !Number.isSafeInteger(input.expectedMembershipRevision) ||
    input.expectedMembershipRevision < 0 ||
    typeof input.digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.digest)
  )
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Invalid group image source guard",
    );
}
function check(store, input) {
  if (input === undefined) return;
  validate(input);
  const current = capture(store, input.groupId).guard;
  if (
    current.expectedEpoch !== input.expectedEpoch ||
    current.expectedMembershipRevision !== input.expectedMembershipRevision ||
    current.digest !== input.digest
  )
    throw new RuntimeError(
      "REVISION_CONFLICT",
      "Group image sources changed; create the image again",
    );
}
function page(store, groupId, offset = 0, expected) {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Invalid group image source offset",
    );
  if (offset && expected === undefined)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Continuation requires captured image sources",
    );
  const { members, guard } = capture(store, groupId);
  if (expected !== undefined) {
    validate(expected);
    if (
      expected.groupId !== groupId ||
      expected.expectedEpoch !== guard.expectedEpoch ||
      expected.expectedMembershipRevision !==
        guard.expectedMembershipRevision ||
      expected.digest !== guard.digest
    )
      throw new RuntimeError(
        "REVISION_CONFLICT",
        "Group image source page changed; try again",
      );
  }
  if (offset > members.length)
    throw new RuntimeError(
      "INVALID_COMMAND",
      "Image source offset is outside the group",
    );
  const read = store.db.prepare(
    "SELECT json_extract(definition,'$.image') image, json_type(definition,'$.image') imageType FROM characters WHERE id=?",
  );
  const sources = members.slice(offset, offset + 128).map((id, index) => {
    const record = read.get(id);
    const image = record?.image;
    if (![null, undefined, "null", "text"].includes(record?.imageType))
      throw new RuntimeError(
        "INVALID_COMMAND",
        "Group member image reference is invalid",
      );
    return { memberId: id, position: offset + index, image: image ?? null };
  });
  return {
    guard,
    sources,
    count: members.length,
    nextOffset:
      offset + sources.length < members.length ? offset + sources.length : null,
  };
}
module.exports = { check, page };
