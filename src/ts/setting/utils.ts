import { getFieldValue, setFieldValue } from "../runtime/fieldControls";
import { entityRuntimeEnabled } from "../runtime/browserRuntimeState.svelte";
import { commandJson } from "../runtime/clientProtocol";
import type { Database } from "../storage/database.svelte";
import type { SettingItem, SettingContext } from "./types";
import { DBState } from "../stores.svelte";
import { language } from "src/lang";
import { accessibilitySettingsItems } from "./accessibilitySettingsData";
import { advancedSettingsItems } from "./advancedSettingsData";
import {
  basicParameterItems,
  modelSpecificParameterItems,
  penaltyParameterItems,
  samplingParameterItems,
  seedSetting,
} from "./botSettingsParamsData";
import { chatFormatSettingsItems } from "./chatFormatSettingsData";
import { displaySettingsItems } from "./displaySettingsData.svelte";

/**
 * Sentinel value representing an uninitialized local state in wrapper components.
 * Used instead of `undefined` so that a legitimate `undefined` DB value
 * can still be written back without being silently ignored.
 */
export const UNINITIALIZED = Symbol("uninitialized");

export function getLabel(item: SettingItem): string {
  if (item.labelKey && (language as any)[item.labelKey]) {
    return (language as any)[item.labelKey];
  }
  return item.fallbackLabel ?? "";
}

function settingBinding(item: SettingItem) {
  const parts = (item.runtimeField ?? item.bindPath ?? item.bindKey)?.split(
    ".",
  );
  if (!parts) return;
  return {
    key: parts[0],
    path: parts.slice(1),
    target: {
      scope: "resource" as const,
      resourceKind: "settings" as const,
      entityId: "global",
      key: parts[0],
    },
  };
}

export function getSettingValue(item: SettingItem, ctx: SettingContext): any {
  const binding = entityRuntimeEnabled && settingBinding(item);
  if (binding) {
    let value = getFieldValue(binding.target, (DBState.db as any)[binding.key]);
    if (item.runtimeField && item.getValue)
      return item.getValue({ [binding.key]: value } as Database, ctx);
    for (const part of binding.path) value = value?.[part];
    return value;
  }
  if (item.getValue) {
    return item.getValue(DBState.db, ctx);
  }
  if (item.bindPath) {
    const parts = item.bindPath.split(".");
    let value: any = DBState.db;
    for (const part of parts) {
      value = value?.[part];
    }
    return value;
  }
  if (item.bindKey) {
    return (DBState.db as any)[item.bindKey];
  }
  return undefined;
}

export function setSettingValue(
  item: SettingItem,
  newValue: any,
  ctx: SettingContext,
): void {
  if (entityRuntimeEnabled) {
    const binding = settingBinding(item);
    if (!binding)
      throw new Error(
        "This custom setting needs an explicit server field binding",
      );
    const current = getFieldValue(
      binding.target,
      (DBState.db as any)[binding.key],
    );
    let value: any;
    if (item.runtimeField && item.setValue) {
      const draft = {
        [binding.key]:
          current === undefined ? undefined : JSON.parse(commandJson(current)),
      } as Database;
      item.setValue(draft, newValue, ctx);
      value = draft[binding.key];
    } else if (binding.path.length) {
      value = current == null ? {} : JSON.parse(commandJson(current));
      let target = value;
      for (const part of binding.path.slice(0, -1)) {
        if (["__proto__", "constructor", "prototype"].includes(part))
          throw new Error("Invalid setting path");
        target = target[part] ??= {};
      }
      const key = binding.path.at(-1);
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw new Error("Invalid setting path");
      target[key] = newValue;
    } else value = newValue;
    setFieldValue(binding.target, value, () => {});
    if (!item.reactivePresentation) item.onChange?.(newValue, ctx);
    return;
  }
  if (item.setValue) {
    item.setValue(DBState.db, newValue, ctx);
  } else if (item.bindPath) {
    const parts = item.bindPath.split(".");
    let obj: any = DBState.db;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]] ??= {};
    }
    obj[parts[parts.length - 1]] = newValue;
  } else if (item.bindKey) {
    (DBState.db as any)[item.bindKey] = newValue;
  }

  if (item.onChange) {
    item.onChange(newValue, ctx);
  }
}

/**
 * Check if item should be visible based on condition
 */
export function checkCondition(
  item: SettingItem,
  ctx: SettingContext,
): boolean {
  if (!item.condition) return true;
  return item.condition(ctx);
}

export function getFullSettingsData(searchTerm = "") {
  const full = accessibilitySettingsItems.concat(
    advancedSettingsItems,
    basicParameterItems,
    seedSetting,
    samplingParameterItems,
    penaltyParameterItems,
    modelSpecificParameterItems,
    chatFormatSettingsItems,
    displaySettingsItems,
  );

  if (!searchTerm) return full;

  const lowerSearch = searchTerm.toLowerCase();
  return full.filter((item) => {
    const label = getLabel(item).toLowerCase();
    const keywords = item.keywords?.map((k) => k.toLowerCase()) || [];
    return (
      label.includes(lowerSearch) ||
      keywords.some((k) => k.includes(lowerSearch))
    );
  });
}
