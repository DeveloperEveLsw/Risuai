const modelNames = new Map([
  ["gemini-4-argon", "Gemini 4 Argon"],
  ["gemini-4-carbon", "Gemini 4 Carbon"],
]);
const CONTINUATION_INSTRUCTION =
  "Continue the previous assistant message from where it stopped. Preserve its content as conversation history, follow the existing instructions and output format, and do not repeat the previous text.";

export function isGemini4PolicyModel(modelId: string | undefined): boolean {
  return !!modelName(modelId);
}

function modelName(modelId: string | undefined) {
  return modelNames.get(modelId?.replace(/^models\//, "") ?? "");
}

export function resolveGemini4VertexRegion(
  modelId: string | undefined,
  region: string,
): string | undefined {
  if (!isGemini4PolicyModel(modelId)) return undefined;
  return ["global", "us", "eu"].includes(region) ? region : "global";
}

export function vertexEndpointHost(region: string): string {
  if (region === "global") return "aiplatform.googleapis.com";
  if (region === "us" || region === "eu")
    return `aiplatform.${region}.rep.googleapis.com`;
  return `${region}-aiplatform.googleapis.com`;
}

function configuration(value: unknown, name: string): Record<string, any> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} generation configuration must be an object.`);
  return value as Record<string, any>;
}

/** Apply after user parameters, including on tool follow-up requests. Other
 * models retain their original body. No prompt or setting is persisted here.
 */
export function applyGemini4RequestPolicy(
  modelId: string | undefined,
  body: Record<string, any>,
  streaming: boolean | undefined,
): Record<string, any> {
  const name = modelName(modelId);
  if (!name) return body;

  for (const key of ["cachedContent", "cached_content"])
    if (body[key] !== undefined && body[key] !== null && body[key] !== "")
      throw new Error(
        `${name} does not support cachedContent. Remove the explicit cache reference and supply the complete conversation before sending.`,
      );

  const next = { ...body };
  delete next.cachedContent;
  delete next.cached_content;
  const config = {
    ...configuration(body.generation_config, name),
    ...configuration(body.generationConfig, name),
  };
  for (const key of [
    "temperature",
    "topP",
    "top_p",
    "topK",
    "top_k",
    "presencePenalty",
    "presence_penalty",
    "frequencyPenalty",
    "frequency_penalty",
    "candidateCount",
    "candidate_count",
    "thinkingBudget",
    "thinking_budget",
  ])
    delete config[key];

  if (
    config.thinkingConfig !== undefined ||
    config.thinking_config !== undefined
  ) {
    const thinking = {
      ...configuration(config.thinkingConfig, name),
      ...configuration(config.thinking_config, name),
    };
    delete thinking.thinkingBudget;
    delete thinking.thinking_budget;
    const rawLevel = thinking.thinking_level ?? thinking.thinkingLevel;
    if (rawLevel !== undefined) {
      if (typeof rawLevel !== "string")
        throw new Error(`${name} thinkingLevel must be low, medium or high.`);
      const level = rawLevel.toLowerCase();
      if (!["minimal", "low", "medium", "high"].includes(level))
        throw new Error(`${name} thinkingLevel must be low, medium or high.`);
      thinking.thinkingLevel = level === "minimal" ? "low" : level;
    }
    delete thinking.thinking_level;
    config.thinkingConfig = thinking;
  }
  delete config.thinking_config;

  const requestedTokens = config.max_output_tokens ?? config.maxOutputTokens;
  if (requestedTokens !== undefined) {
    if (!Number.isInteger(requestedTokens) || requestedTokens <= 0)
      throw new Error(`${name} maxOutputTokens must be a positive integer.`);
    config.maxOutputTokens = Math.min(
      requestedTokens,
      streaming ? 65536 : 32768,
    );
  }
  delete config.max_output_tokens;
  next.generation_config = config;
  delete next.generationConfig;

  if (Array.isArray(body.contents) && body.contents.at(-1)?.role === "model")
    next.contents = [
      ...body.contents,
      { role: "user", parts: [{ text: CONTINUATION_INSTRUCTION }] },
    ];
  return next;
}

/** fetchNative normally invokes these string-body hooks inside the transport.
 * Run the same hooks once before validation/authentication for these models, then
 * disable their second transport invocation so none can undo this policy.
 */
export async function finalizeGemini4Request(
  modelId: string | undefined,
  body: Record<string, any>,
  streaming: boolean | undefined,
  hookName: string,
  hooks: readonly { callback: (body: any, type: string) => Promise<any> }[],
): Promise<Record<string, any>> {
  const name = modelName(modelId);
  if (!name) return body;
  let serialized = JSON.stringify(
    applyGemini4RequestPolicy(modelId, body, streaming),
  );
  for (const hook of hooks) {
    try {
      serialized = (await hook.callback(serialized, hookName)) || serialized;
    } catch {
      // Match the transport's existing keep-previous-body fallback.
    }
  }
  let intercepted: Record<string, any>;
  try {
    intercepted = JSON.parse(serialized);
    if (
      !intercepted ||
      typeof intercepted !== "object" ||
      Array.isArray(intercepted)
    )
      throw new Error("Invalid body");
  } catch {
    throw new Error(
      `${name} request interceptors must return a JSON request object.`,
    );
  }
  return applyGemini4RequestPolicy(modelId, intercepted, streaming);
}
