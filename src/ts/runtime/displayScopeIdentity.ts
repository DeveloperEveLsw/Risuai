import type { DisplayCapture } from "./displayEffects";
import type { DisplayWireBudget } from "./displayWireBudget";

// Weak keys retain neither a body nor its owner after the invocation closes.
// These identities belong only to local presentation coalescing, never receipts.
const immutable = new WeakMap<object, { id: number; keys: string[] }>();
const shells = new WeakMap<object, object>();
let sequence = 0;

/** Only the private recursively frozen JSON registered below is trusted.
 * Object.isFrozen alone cannot prove nested values or accessor results immutable.
 */
export function isImmutableDisplayJson(value: object) {
  return immutable.has(value);
}

/** Register only recursively frozen private JSON, never shallow-frozen Maps. */
export function freezeDisplayJson(value: unknown, seen = new Set<object>()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  if (immutable.has(value)) return;
  seen.add(value);
  const children = Object.keys(value).map((key) => value[key]);
  for (const child of children) freezeDisplayJson(child, seen);
  Object.freeze(value);
  const plain =
    Array.isArray(value) ||
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
  if (
    plain &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => !descriptor.get && !descriptor.set,
    ) &&
    children.every(
      (child) =>
        child == null ||
        ["string", "number", "boolean", "undefined"].includes(typeof child) ||
        (typeof child === "object" && immutable.has(child)),
    )
  ) {
    if (!Number.isSafeInteger(sequence + 1))
      throw new Error("Display immutable scope identity limit reached");
    immutable.set(value, { id: ++sequence, keys: Object.keys(value).sort() });
  }
}

/** Known plain private forks can compare unchanged fields with their deeply
 * frozen base, without re-encoding large immutable scalar settings per row.
 * Changed/replaced/deleted fields are still read on every invocation.
 */
export function bindDisplayShell(shell: object, base: object) {
  if (immutable.has(base)) shells.set(shell, base);
}

/** A large source already owned by a registered immutable history/greeting
 * field needs no second string encoding in a local work key. The original
 * source remains in the capture, wire-size check and durable source digest.
 */
function immutableSourceField(capture: DisplayCapture) {
  const source = capture.sourceContent;
  if (typeof source !== "string" || source.length < 4096) return;
  const field = (owner: object, key: string) => {
    const token = immutable.get(owner);
    if (
      token &&
      Object.hasOwn(owner, key) &&
      Reflect.get(owner, key) === source
    )
      return [token.id, key];
  };
  if (capture.message) {
    const history = capture.chat.message;
    if (!Array.isArray(history) || !immutable.has(history)) return;
    const message = history.find(
      (value) => value && value.chatId === capture.message.id,
    );
    if (message) return field(message, "data");
    return;
  }
  return field(
    shells.get(capture.character) ?? capture.character,
    "firstMessage",
  );
}

/** Synchronous snapshot before hashing awaits. Tagged containers cannot collide
 * with user JSON resembling an immutable token. Unregistered captures use their
 * complete values; cached UI bodies require only their small mutable shell.
 */
export function displayScopeJson(
  capture: DisplayCapture,
  budget: DisplayWireBudget,
) {
  const ancestors = new Set<object>();
  let nodes = 0;
  function encode(value: unknown, depth = 0): unknown {
    if (++nodes > 200000 || depth > 128)
      throw new Error("Display presentation exceeds its structural budget");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (value === undefined) return null; // Original JSON array semantics.
    if (typeof value !== "object")
      throw new Error("Display presentation requires JSON values");
    const token = immutable.get(value);
    if (token !== undefined) return ["frozen", token.id];
    if (ancestors.has(value))
      throw new Error("Display presentation cannot contain circular values");
    ancestors.add(value);
    let encoded: unknown;
    const base = shells.get(value);
    if (base) {
      const frozen = immutable.get(base);
      const removed = frozen.keys.filter(
        (key) => !Object.hasOwn(value, key) || value[key] === undefined,
      );
      const changed = Object.keys(value)
        .filter(
          (key) =>
            value[key] !== undefined &&
            (!Object.hasOwn(base, key) || !Object.is(value[key], base[key])),
        )
        .sort()
        .map((key) => [key, encode(value[key], depth + 1)]);
      encoded = ["shell", frozen.id, removed, changed];
    } else if (Array.isArray(value))
      encoded = [
        "array",
        Array.from(value, (child) => encode(child, depth + 1)),
      ];
    else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new Error("Display presentation requires JSON containers");
      encoded = [
        "object",
        Object.keys(value)
          .sort()
          .filter((key) => value[key] !== undefined)
          .map((key) => [key, encode(value[key], depth + 1)]),
      ];
    }
    ancestors.delete(value);
    return encoded;
  }
  const sourceField = immutableSourceField(capture);
  const scope = encode({
    ...capture,
    sourceContent: sourceField ? undefined : capture.sourceContent,
    // Outer CBS uses optimistic overlays, but Lua reads only the pinned
    // canonical maps. Its expanded input is already a separate work key;
    // provisional admission and outside reads remain caller-specific.
    presentationVariables: undefined,
    // Preserve independent aliases for adapters that do not normalize them.
    character:
      capture.character === capture.database.characters[0]
        ? undefined
        : capture.character,
    chat:
      capture.chat === capture.database.characters[0]?.chats[0]
        ? undefined
        : capture.chat,
    versions: {
      chat: [...capture.versions.chat].sort(([a], [b]) => a.localeCompare(b)),
      localGlobal: [...capture.versions.localGlobal].sort(([a], [b]) =>
        a.localeCompare(b),
      ),
      global: [...capture.versions.global].sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    },
  });
  // This wrapper is outside the encoded user tree, so user JSON resembling
  // a field token cannot collide. Every other fresh input stays in the scope.
  const value = sourceField ? ["source-field", scope, sourceField] : scope;
  const json = JSON.stringify(value);
  budget.measureSerializedJson(json);
  return json;
}
