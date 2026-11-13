import type { Json } from "./clientProtocol";
import { commandJson } from "./clientProtocol";
import { fieldIdentity, type FieldTarget } from "./fieldCommands";
import {
  browserRuntime,
  entityRuntimeEnabled,
  FieldOverlays,
} from "./browserRuntimeState.svelte";
import { settingValues, type SettingChange } from "./settingIntents";

export function setSettingChanges<T extends object>(
  database: T,
  changes: readonly SettingChange[],
) {
  setSettingValues(
    database,
    settingValues(getSettingDatabase(database), changes),
  );
}

/** Apply already prepared fields without copying a large edited field a second time. */
export function setSettingValues<T extends object>(
  database: T,
  values: ReadonlyMap<string, Json | undefined>,
) {
  const view = getSettingDatabase(database);
  // Component binding initialization and confirmed projection must not originate
  // writes. Keep the complete dependency group when any requested value differs.
  if (
    !values.size ||
    [...values].every(([key, value]) => {
      const current = (view as Record<string, unknown>)[key];
      return (
        current === value ||
        (current !== undefined &&
          value !== undefined &&
          commandJson(current) === commandJson(value))
      );
    })
  )
    return;
  if (entityRuntimeEnabled) {
    browserRuntime().setFields(
      [...values].map(([key, value]) => ({
        target: {
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key,
        },
        value,
      })),
    );
  } else {
    for (const [key, value] of values)
      if (value === undefined) delete (database as any)[key];
      else (database as any)[key] = value;
  }
}

export function getFieldValue<T>(target: FieldTarget, confirmed: T): T {
  if (!entityRuntimeEnabled) return confirmed;
  const overlay = FieldOverlays.get(fieldIdentity(target));
  return overlay
    ? ((overlay.exists ? overlay.value : undefined) as T)
    : confirmed;
}
export function setFieldValue(
  target: FieldTarget,
  value: Json | undefined,
  local: () => void,
) {
  if (entityRuntimeEnabled) browserRuntime().setField(target, value);
  else local();
}

const settingsViews = new WeakMap<object, object>();
/** Conditions read pending values too, so dependent inputs appear before acknowledgement. */
export function getSettingDatabase<T extends object>(database: T): T {
  if (!entityRuntimeEnabled) return database;
  let view = settingsViews.get(database);
  if (!view) {
    view = new Proxy(database, {
      get(target, key) {
        const confirmed = Reflect.get(target, key);
        return typeof key === "string"
          ? getFieldValue(
              {
                scope: "resource",
                resourceKind: "settings",
                entityId: "global",
                key,
              },
              confirmed,
            )
          : confirmed;
      },
      set() {
        throw new Error("Settings must be changed through commands");
      },
    });
    settingsViews.set(database, view);
  }
  return view as T;
}
