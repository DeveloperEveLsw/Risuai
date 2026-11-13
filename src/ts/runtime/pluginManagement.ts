import type { RisuPlugin } from "../plugins/plugins.svelte";
import type { FieldTarget } from "./fieldCommands";
import {
  browserRuntime,
  entityRuntimeEnabled,
} from "./browserRuntimeState.svelte";
import { getFieldValue, setFieldValue } from "./fieldControls";

function target(plugin: RisuPlugin, key: string): FieldTarget {
  if (entityRuntimeEnabled && !plugin.id)
    throw new Error("The plugin has not been saved on the server");
  return {
    scope: "resource",
    resourceKind: "plugin",
    entityId: plugin.id ?? "",
    key,
  };
}

export function getPluginEnabled(plugin: RisuPlugin): boolean {
  return getFieldValue(target(plugin, "enabled"), plugin.enabled ?? false);
}

export function setPluginEnabled(plugin: RisuPlugin, value: boolean) {
  if (getPluginEnabled(plugin) === value) return;
  setFieldValue(target(plugin, "enabled"), value, () => {
    plugin.enabled = value;
  });
}

function argumentsValue(plugin: RisuPlugin) {
  return getFieldValue(target(plugin, "realArg"), plugin.realArg ?? {});
}

export function getPluginArgument(plugin: RisuPlugin, key: string) {
  return argumentsValue(plugin)[key];
}

export function setPluginArgument(
  plugin: RisuPlugin,
  key: string,
  value: string | number | undefined,
) {
  if (getPluginArgument(plugin, key) === value) return;
  const args = { ...argumentsValue(plugin) };
  if (value === undefined) delete args[key];
  else
    Object.defineProperty(args, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  setFieldValue(target(plugin, "realArg"), args, () => {
    plugin.realArg = args;
  });
}

/** The confirmation dialog owns this exact resource incarnation and revision. */
export function capturePluginRemoval(plugin: RisuPlugin) {
  const runtime = browserRuntime();
  const id = plugin.id;
  if (!id) throw new Error("The plugin has not been saved on the server");
  const expected = { ...runtime.libraryHeader("plugin", id) };
  return () => runtime.deleteLibraryResource("plugin", id, expected);
}
