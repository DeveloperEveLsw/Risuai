import { commandJson, type Json } from "./clientProtocol";

export type SettingPath = readonly (string | number)[];
export type SettingChange = { path: SettingPath; value: unknown };
const reserved = new Set(["__proto__", "constructor", "prototype"]);
const collections = new Set([
  "characters",
  "modules",
  "botPresets",
  "personas",
  "plugins",
  "globalChatVariables",
]);

/** Copy only touched top-level fields, keeping siblings and earlier changes in the same intent. */
export function settingValues(
  database: object,
  changes: readonly SettingChange[],
): Map<string, Json | undefined> {
  const values = new Map<string, Json | undefined>();
  for (const { path, value } of changes) {
    if (!path.length || typeof path[0] !== "string" || collections.has(path[0]))
      throw new Error("This value requires an entity or collection command");
    for (const part of path)
      if (
        (typeof part === "string" && (!part || reserved.has(part))) ||
        (typeof part === "number" && (!Number.isSafeInteger(part) || part < 0))
      )
        throw new Error("Invalid setting path");
    const key = path[0];
    const copy =
      value === undefined ? undefined : JSON.parse(commandJson(value));
    if (path.length === 1) {
      values.set(key, copy);
      continue;
    }
    if (!values.has(key)) {
      const current = (database as Record<string, unknown>)[key];
      values.set(
        key,
        current == null
          ? typeof path[1] === "number"
            ? []
            : {}
          : JSON.parse(commandJson(current)),
      );
    }
    let target: any = values.get(key);
    if (!target || typeof target !== "object")
      throw new Error("Invalid setting container");
    for (let i = 1; i < path.length - 1; i++) {
      const part = path[i];
      if (!Object.hasOwn(target, part) || target[part] == null)
        target[part] = typeof path[i + 1] === "number" ? [] : {};
      target = target[part];
      if (!target || typeof target !== "object")
        throw new Error("Invalid setting container");
    }
    const leaf = path.at(-1)!;
    if (copy === undefined) delete target[leaf];
    else target[leaf] = copy;
  }
  return values;
}
