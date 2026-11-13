import type { Json } from "../runtime/clientProtocol";

export class PresetImportError extends Error {
  constructor(path: string, reason: string) {
    super(`Cannot import preset: ${reason} at ${path}`);
    this.name = "PresetImportError";
  }
}

/** Import optional values with ordinary JSON object/array semantics. */
export function normalizePresetImportJson(
  value: unknown,
): Record<string, Json> {
  const ancestors = new Set<object>();
  function visit(item: unknown, path: string): Json {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return item as Json;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object")
      throw new PresetImportError(path, "expected a JSON value");
    if (ancestors.has(item))
      throw new PresetImportError(path, "cyclic values are not supported");
    if (
      !Array.isArray(item) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      throw new PresetImportError(path, "expected a plain JSON object");
    ancestors.add(item);
    try {
      if (Array.isArray(item))
        return Array.from({ length: item.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, index);
          if (!descriptor) return null;
          if (!("value" in descriptor))
            throw new PresetImportError(
              `${path}[${index}]`,
              "accessors are not JSON values",
            );
          return descriptor.value === undefined
            ? null
            : visit(descriptor.value, `${path}[${index}]`);
        });
      return Object.fromEntries(
        Object.keys(item).flatMap((key) => {
          const childPath = `${path}[${JSON.stringify(key)}]`;
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          if (!("value" in descriptor))
            throw new PresetImportError(
              childPath,
              "accessors are not JSON values",
            );
          return descriptor.value === undefined
            ? []
            : [[key, visit(descriptor.value, childPath)]];
        }),
      );
    } finally {
      ancestors.delete(item);
    }
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new PresetImportError("$", "expected a preset object");
  return visit(value, "$") as Record<string, Json>;
}

export function presetImportNumber(
  value: unknown,
  fallback: number,
  path: string,
  scale?: number,
): number;
export function presetImportNumber(
  value: unknown,
  fallback: number | undefined,
  path: string,
  scale?: number,
): number | undefined;
export function presetImportNumber(
  value: unknown,
  fallback: number | undefined,
  path: string,
  scale = 1,
): number | undefined {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new PresetImportError(path, "expected a finite number");
  const result = value * scale;
  if (!Number.isFinite(result))
    throw new PresetImportError(path, "number is outside the supported range");
  return result;
}
