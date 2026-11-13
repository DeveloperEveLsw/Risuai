// @vitest-environment node
import { expect, test } from "vitest";
import {
  applyGemini4ArgonRequestPolicy,
  finalizeGemini4ArgonRequest,
  isGemini4ArgonModel,
  resolveGemini4ArgonVertexRegion,
} from "./gemini4ArgonPolicy";

test("Argon policy is exact and keeps earlier Gemini model requests unchanged", () => {
  expect(isGemini4ArgonModel("gemini-4-argon")).toBe(true);
  expect(isGemini4ArgonModel("models/gemini-4-argon")).toBe(true);
  for (const id of [
    "gemini-3.5-flash",
    "gemini-2.5-flash",
    "gemini-4-argon-preview",
    undefined,
  ]) {
    const body = {
      cachedContent: "synthetic-cache",
      generation_config: { temperature: 1, thinkingBudget: 50 },
    };
    expect(applyGemini4ArgonRequestPolicy(id, body, false)).toBe(body);
    expect(resolveGemini4ArgonVertexRegion(id, "us-central1")).toBeUndefined();
  }
});

test("Argon normalizes custom configuration aliases while preserving JSON schema and requested small output caps", () => {
  const body = {
    generation_config: {
      maxOutputTokens: 15,
      thinkingConfig: { thinkingLevel: "high", thinkingBudget: 9999 },
    },
    generationConfig: {
      temperature: 1,
      top_p: 0.5,
      topK: 40,
      presence_penalty: 1,
      frequencyPenalty: 1,
      candidate_count: 2,
      thinking_budget: 400,
      thinking_config: {
        thinking_level: "MINIMAL",
        thinking_budget: 0,
        includeThoughts: true,
      },
      responseSchema: { type: "object" },
    },
    contents: [{ role: "user", parts: [{ text: "Synthetic user input" }] }],
  };
  const before = structuredClone(body);
  const result = applyGemini4ArgonRequestPolicy("gemini-4-argon", body, true);
  expect(result.generation_config).toEqual({
    maxOutputTokens: 15,
    thinkingConfig: { thinkingLevel: "low", includeThoughts: true },
    responseSchema: { type: "object" },
  });
  expect(result.generationConfig).toBeUndefined();
  expect(body).toEqual(before);
});

test("Argon omits missing thinking levels so the provider default remains effective", () => {
  expect(
    applyGemini4ArgonRequestPolicy(
      "gemini-4-argon",
      { generation_config: { maxOutputTokens: 50 } },
      false,
    ).generation_config,
  ).toEqual({ maxOutputTokens: 50 });
  expect(
    applyGemini4ArgonRequestPolicy(
      "gemini-4-argon",
      { generation_config: { thinkingConfig: { thinkingBudget: 512 } } },
      false,
    ).generation_config.thinkingConfig,
  ).toEqual({});
});

test("Argon preserves complete assistant prefill/history and signatures with one idempotent user continuation", () => {
  const assistant = {
    role: "model",
    parts: [
      {
        text: "Synthetic complete history: {",
        thoughtSignature: "synthetic-signature",
      },
    ],
  };
  const body = {
    contents: [
      { role: "user", parts: [{ text: "Synthetic question" }] },
      assistant,
    ],
  };
  const result = applyGemini4ArgonRequestPolicy("gemini-4-argon", body, false);
  expect(result.contents).toHaveLength(3);
  expect(result.contents[1]).toBe(assistant);
  expect(result.contents[2].role).toBe("user");
  expect(body.contents).toHaveLength(2);
  expect(
    applyGemini4ArgonRequestPolicy("gemini-4-argon", result, false),
  ).toEqual(result);
});

test("Argon validates unsupported cached references and malformed explicit controls without disclosing their values", () => {
  expect(() =>
    applyGemini4ArgonRequestPolicy(
      "gemini-4-argon",
      { cachedContent: "synthetic-private-reference" },
      false,
    ),
  ).toThrow("does not support cachedContent");
  for (const config of [
    { thinkingConfig: { thinkingLevel: "unsupported" } },
    { maxOutputTokens: -1 },
    { maxOutputTokens: 2.5 },
    { maxOutputTokens: "large" },
  ])
    expect(() =>
      applyGemini4ArgonRequestPolicy(
        "gemini-4-argon",
        { generation_config: config },
        false,
      ),
    ).toThrow(/Gemini 4 Argon/);
  expect(() =>
    applyGemini4ArgonRequestPolicy(
      "gemini-4-argon",
      { generationConfig: "invalid" },
      false,
    ),
  ).toThrow("must be an object");
});

test("Argon clamps only the REST/stream upper bound and preserves its three supported Vertex locations", () => {
  for (const [streaming, limit] of [
    [false, 32768],
    [true, 65536],
  ] as const)
    for (const requested of [7, limit, 100000])
      expect(
        applyGemini4ArgonRequestPolicy(
          "gemini-4-argon",
          { generation_config: { max_output_tokens: requested } },
          streaming,
        ).generation_config,
      ).toEqual({ maxOutputTokens: Math.min(requested, limit) });
  for (const region of ["global", "us", "eu"])
    expect(resolveGemini4ArgonVertexRegion("gemini-4-argon", region)).toBe(
      region,
    );
  expect(resolveGemini4ArgonVertexRegion("gemini-4-argon", "us-central1")).toBe(
    "global",
  );
});

test("Argon validates the hook's final string body without running non-Argon hooks or accepting malformed JSON", async () => {
  let calls = 0;
  const hooks = [
    {
      callback: async () => {
        calls++;
        return "malformed-json";
      },
    },
  ];
  const body = { generation_config: { maxOutputTokens: 50 } };
  expect(
    await finalizeGemini4ArgonRequest(
      "gemini-3.5-flash",
      body,
      false,
      "gemini_base",
      hooks,
    ),
  ).toBe(body);
  expect(calls).toBe(0);
  await expect(
    finalizeGemini4ArgonRequest(
      "gemini-4-argon",
      body,
      false,
      "gemini_base",
      hooks,
    ),
  ).rejects.toThrow("JSON request object");
  expect(calls).toBe(1);
});
