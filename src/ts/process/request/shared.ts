let browserRuntime: ReturnType<typeof createParameterRuntime>;
import { getDatabase } from "src/ts/storage/database.svelte";

import { parseAdditionalParamJsonValue } from "./additionalParams";

export type LLMParameter =
  | "temperature"
  | "top_k"
  | "repetition_penalty"
  | "min_p"
  | "top_a"
  | "top_p"
  | "frequency_penalty"
  | "presence_penalty"
  | "reasoning_effort"
  | "reasoning_effort_min_medium"
  | "reasoning_effort_none"
  | "reasoning_effort_xhigh"
  | "thinking_tokens"
  | "verbosity";

export type ModelModeExtended =
  | "model"
  | "submodel"
  | "memory"
  | "emotion"
  | "otherAx"
  | "translate";

export function isReasoningCapabilityParameter(
  parameter: LLMParameter,
): boolean {
  return getBrowserRuntime().isReasoningCapabilityParameter(parameter);
}

export function setObjectValue<T>(obj: T, key: string, value: any): T {
  return getBrowserRuntime().setObjectValue(obj, key, value);
}

export function getAdditionalParameters(aiModel?: string): [string, string][] {
  return getBrowserRuntime().getAdditionalParameters(aiModel);
}

export function applyAdditionalParameters<T extends Record<string, any>>(
  body: T,
  headers: Record<string, string>,
  additionalParams: [string, string][],
): T {
  return getBrowserRuntime().applyAdditionalParameters(
    body,
    headers,
    additionalParams,
  );
}

export function applyParameters(
  data: Record<string, any>,
  parameters: LLMParameter[],
  rename: Partial<Record<LLMParameter, string>>,
  modelMode: ModelModeExtended,
  arg: {
    ignoreTopKIfZero?: boolean;
    modelId: string;
  },
): Record<string, any> {
  return getBrowserRuntime().applyParameters(
    data,
    parameters,
    rename,
    modelMode,
    arg,
  );
}
import { createParameterRuntime } from "./parameterRuntime";

function getBrowserRuntime() {
  return (browserRuntime ??= createParameterRuntime({
    get getDatabase() {
      return getDatabase;
    },
    get parseAdditionalParamJsonValue() {
      return parseAdditionalParamJsonValue;
    },
  }));
}
