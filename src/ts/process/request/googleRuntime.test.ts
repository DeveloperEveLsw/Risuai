// @vitest-environment node
import { generateKeyPairSync, verify, webcrypto } from "node:crypto";
import { expect, test } from "vitest";
import { createGoogleRuntime } from "./googleRuntime";
import { createUtilBinaryRuntime } from "../../utilBinaryRuntime";
import { createNativeTransport } from "../../runtime/nativeTransport";
import { LLMFlags, LLMFormat } from "../../model/types";
import { LLMModels } from "../../model/modelCatalog";
import { createParameterRuntime } from "./parameterRuntime";
import { parseAdditionalParamJsonValue } from "./additionalParams";

function fixture(
  providerFetch: typeof fetch,
  extra: Record<string, unknown> = {},
  signal?: AbortSignal,
  capabilities: Record<string, unknown> = {},
) {
  const database: any = {
    google: { projectId: "synthetic-project", accessToken: "synthetic-key" },
    vertexRegion: "us-central1",
    vertexAccessToken: "synthetic-cached-token",
    vertexAccessTokenExpires: Date.now() + 60000,
    antiServerOverloads: true,
    streamGeminiThoughts: false,
    ...extra,
  };
  const progress: any[] = [],
    writes: any[] = [];
  const context: any = {
    ensureHealthy() {},
    fail(message: string): never {
      throw new Error(message);
    },
  };
  const transport = createNativeTransport(context, {
    providerFetch,
    signal,
    onProgress: (e) => progress.push(e),
  });
  const host: any = new Proxy(
    {
      ...transport,
      ...createUtilBinaryRuntime(),
      LLMFlags,
      LLMFormat,
      window: { crypto: webcrypto },
      crypto: webcrypto,
      getDatabase: () => database,
      setDatabase: (db: unknown) => writes.push(structuredClone(db)),
      ...createParameterRuntime({
        getDatabase: () => database,
        parseAdditionalParamJsonValue,
      }),
      bodyIntercepterStore: [],
      alertError: context.fail,
      ...capabilities,
    },
    {
      get(target: any, key) {
        return key in target
          ? target[key]
          : function () {
              return context.fail(
                "Missing synthetic capability: " + String(key),
              );
            };
      },
    },
  );
  const arg: any = {
    formated: [
      { role: "system", content: "Synthetic system" },
      { role: "user", content: "Synthetic input" },
    ],
    modelInfo: {
      id: "synthetic-vertex",
      internalID: "gemini-3-pro-preview",
      format: LLMFormat.VertexAIGemini,
      flags: [],
      parameters: [],
    },
    aiModel: "synthetic-vertex",
    maxTokens: 50,
    mode: "model",
    useStreaming: false,
    tools: [],
  };
  return {
    runtime: createGoogleRuntime(host),
    database,
    writes,
    transport,
    progress,
    arg,
  };
}
const textResponse = () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Synthetic answer" }] } }],
    }),
    { headers: { "content-type": "application/json" } },
  );

function argonFixture(
  providerFetch: typeof fetch,
  extra: Record<string, unknown> = {},
  signal?: AbortSignal,
  capabilities: Record<string, unknown> = {},
) {
  const f = fixture(providerFetch, extra, signal, capabilities);
  const model = LLMModels.find((m) => m.id === "gemini-4-argon-vertex");
  if (!model)
    throw new Error("Argon must be registered in the real model catalog");
  return {
    ...f,
    arg: {
      ...f.arg,
      aiModel: model.id,
      modelInfo: structuredClone(model),
    },
  };
}

for (const [effort, level] of [
  [-1, "low"],
  [0, "low"],
  [1, "medium"],
  [2, "high"],
] as const)
  test(`Argon real parameter runtime sends ${level} for effort ${effort} without unsupported configuration`, async () => {
    let sent: any;
    const f = argonFixture(
      async (url, init) => {
        expect(String(url)).toContain("/locations/global/");
        expect(String(url)).toContain("/models/gemini-4-argon:generateContent");
        sent = JSON.parse(String(init?.body));
        return textResponse();
      },
      {
        reasoningEffort: effort,
        temperature: 170,
        top_p: 0.7,
        top_k: 40,
        frequencyPenalty: 120,
        PresensePenalty: 130,
        thinkingTokens: 10000,
        applyAdditionalParamsToAll: true,
        additionalParams: [
          ["generation_config.temperature", "1.5"],
          ["generation_config.topP", "0.9"],
          ["generation_config.top_k", "50"],
          ["generation_config.presencePenalty", "1"],
          ["generation_config.frequency_penalty", "1"],
          ["generation_config.candidateCount", "2"],
          ["generation_config.thinkingConfig.thinkingBudget", "2048"],
          ["generation_config.response_mime_type", '"application/json"'],
        ],
      },
    );
    expect(await f.runtime.requestGoogleCloudVertex(f.arg)).toMatchObject({
      type: "success",
    });
    expect(sent.generation_config).toEqual({
      maxOutputTokens: 50,
      thinkingConfig: { thinkingLevel: level, includeThoughts: true },
      response_mime_type: "application/json",
    });
    expect(f.transport.calls()).toBe(1);
  });

for (const region of ["global", "us", "eu", "us-central1"])
  test(`Argon Vertex region ${region} selects its supported route`, async () => {
    const expected = region === "us-central1" ? "global" : region;
    const f = argonFixture(
      async (url) => {
        const target = new URL(String(url));
        expect(target.hostname).toBe(
          expected === "global"
            ? "aiplatform.googleapis.com"
            : `${expected}-aiplatform.googleapis.com`,
        );
        expect(target.pathname).toContain(
          `/v1/projects/synthetic-project/locations/${expected}/`,
        );
        return textResponse();
      },
      { vertexRegion: region, reasoningEffort: 1 },
    );
    expect(await f.runtime.requestGoogleCloudVertex(f.arg)).toMatchObject({
      type: "success",
    });
  });

for (const tokens of [17, 32768, 65000])
  test(`Argon REST preserves requested cap ${tokens} below its 32768 upper bound`, async () => {
    const f = argonFixture(async (_url, init) => {
      const config = JSON.parse(String(init?.body)).generation_config;
      expect(config.maxOutputTokens).toBe(Math.min(tokens, 32768));
      return textResponse();
    });
    expect(
      await f.runtime.requestGoogleCloudVertex({ ...f.arg, maxTokens: tokens }),
    ).toMatchObject({ type: "success" });
  });

test("Argon Google API streams byte-fragmented thoughts and text with its 65536 cap and preserves assistant-ended history", async () => {
  const prefix = "Synthetic complete assistant history and requested prefix: {";
  const events = [
    { text: "Synthetic thought", thought: true },
    { text: "안녕 🙂" },
    { text: " 계속합니다." },
  ];
  const f = argonFixture(
    async (url, init) => {
      const target = new URL(String(url));
      expect(target.pathname).toBe(
        "/v1beta/models/gemini-4-argon:streamGenerateContent",
      );
      expect(target.searchParams.get("alt")).toBe("sse");
      const body = JSON.parse(String(init?.body));
      expect(body.generation_config.maxOutputTokens).toBe(65536);
      expect(body.generation_config.thinkingConfig.thinkingLevel).toBe(
        "medium",
      );
      expect(body.contents.at(-2)).toEqual({
        role: "model",
        parts: [{ text: prefix }],
      });
      expect(body.contents.at(-1).role).toBe("user");
      expect(body.contents.at(-1).parts[0].text).toContain("Continue");
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const part of events) {
              const packet = new TextEncoder().encode(
                "data: " +
                  JSON.stringify({
                    candidates: [{ content: { parts: [part] } }],
                  }) +
                  "\r\n\r\n",
              );
              for (const byte of packet)
                controller.enqueue(Uint8Array.of(byte));
            }
            controller.close();
          },
        }),
      );
    },
    { reasoningEffort: 1 },
  );
  const result = await f.runtime.requestGoogleCloudVertex({
    ...f.arg,
    modelInfo: { ...f.arg.modelInfo, format: LLMFormat.GoogleCloud },
    maxTokens: 100000,
    useStreaming: true,
    continue: true,
    formated: [...f.arg.formated, { role: "assistant", content: prefix }],
  });
  if (result.type !== "streaming") throw new Error("Expected Argon streaming");
  const reader = result.result.getReader(),
    chunks: string[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value["0"]);
  }
  expect(chunks.at(-1)).toBe(
    "<Thoughts>\n\nSynthetic thought\n\n</Thoughts>\n\n안녕 🙂 계속합니다.",
  );
  expect(f.transport.calls()).toBe(1);
});

for (const cacheKey of ["cachedContent", "cached_content"])
  test(`Argon rejects ${cacheKey} before OAuth or generation instead of sending a truncated conversation`, async () => {
    const f = argonFixture(
      async () => {
        throw new Error("Unexpected provider request");
      },
      {
        vertexAccessTokenExpires: 0,
        vertexClientEmail: "synthetic@test.gserviceaccount.com",
        vertexPrivateKey: "Synthetic unused private key",
        applyAdditionalParamsToAll: true,
        additionalParams: [[cacheKey, '"synthetic-cache-reference"']],
      },
    );
    expect(await f.runtime.requestGoogleCloudVertex(f.arg)).toMatchObject({
      type: "fail",
      result: expect.stringContaining("complete conversation"),
    });
    expect(f.transport.calls()).toBe(0);
    expect(f.writes).toHaveLength(0);
  });

test("Argon invalid explicit thinking level fails without provider admission", async () => {
  const f = argonFixture(
    async () => {
      throw new Error("Unexpected provider request");
    },
    {
      applyAdditionalParamsToAll: true,
      additionalParams: [
        ["generation_config.thinkingConfig.thinkingLevel", '"extreme"'],
      ],
    },
  );
  expect(await f.runtime.requestGoogleCloudVertex(f.arg)).toMatchObject({
    type: "fail",
    result: expect.stringContaining("low, medium or high"),
  });
  expect(f.transport.calls()).toBe(0);
});

test("Argon quota failure never recursively repeats the Google API request", async () => {
  const f = argonFixture(
    async () => new Response("RESOURCE_EXHAUSTED synthetic", { status: 429 }),
  );
  const result = await f.runtime.requestGoogleCloudVertex({
    ...f.arg,
    modelInfo: { ...f.arg.modelInfo, format: LLMFormat.GoogleCloud },
  });
  expect(result).toMatchObject({ type: "fail", failByServerError: true });
  expect(f.transport.calls()).toBe(1);
});

test("Argon runs string-body interceptors once before its final policy and keeps explicit header overrides", async () => {
  let hooks = 0;
  const f = argonFixture(
    async (_url, init) => {
      expect(hooks).toBe(1);
      expect((init as any).interceptor).toBeUndefined();
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer synthetic-override",
      );
      expect(JSON.parse(String(init?.body)).generation_config).toEqual({
        maxOutputTokens: 50,
        thinkingConfig: { thinkingLevel: "low", includeThoughts: true },
      });
      return textResponse();
    },
    {
      reasoningEffort: 0,
      applyAdditionalParamsToAll: true,
      additionalParams: [
        ["header::Authorization", "Bearer synthetic-override"],
      ],
    },
    undefined,
    {
      bodyIntercepterStore: [
        {
          callback: async (serialized: string, name: string) => {
            expect(name).toBe("gemini_base");
            hooks++;
            const body = JSON.parse(serialized);
            Object.assign(body.generation_config, {
              temperature: 1,
              topP: 0.9,
              topK: 99,
              candidateCount: 3,
            });
            body.generation_config.thinkingConfig.thinkingBudget = 512;
            return JSON.stringify(body);
          },
        },
      ],
    },
  );
  expect(await f.runtime.requestGoogleCloudVertex(f.arg)).toMatchObject({
    type: "success",
  });
  expect(hooks).toBe(1);
  expect(f.transport.calls()).toBe(1);
});

test("an Argon interceptor cannot reinsert an explicit cache reference before OAuth", async () => {
  let hooks = 0;
  const f = argonFixture(
    async () => {
      throw new Error("Unexpected provider request");
    },
    {
      vertexAccessTokenExpires: 0,
      vertexClientEmail: "synthetic@test.gserviceaccount.com",
      vertexPrivateKey: "Synthetic unused private key",
    },
    undefined,
    {
      bodyIntercepterStore: [
        {
          callback: async (serialized: string) => {
            hooks++;
            return JSON.stringify({
              ...JSON.parse(serialized),
              cachedContent: "synthetic-cache-reference",
            });
          },
        },
      ],
    },
  );
  expect(await f.runtime.requestGoogleCloudVertex(f.arg)).toMatchObject({
    type: "fail",
    result: expect.stringContaining("cachedContent"),
  });
  expect(hooks).toBe(1);
  expect(f.transport.calls()).toBe(0);
  expect(f.writes).toHaveLength(0);
});

for (const id of ["gemini-3.5-flash-vertex", "gemini-2.5-flash-vertex"])
  test(`the real ${id} request retains its existing sampling and thinking policy`, async () => {
    const model = LLMModels.find((m) => m.id === id);
    if (!model) throw new Error("Existing Gemini model missing");
    const f = fixture(
      async (_url, init) => {
        const config = JSON.parse(String(init?.body)).generation_config;
        expect(config.maxOutputTokens).toBe(50);
        expect(config.temperature).toBe(1.7);
        expect(config.topP).toBe(0.7);
        expect(config.topK).toBe(40);
        expect(config.thinkingConfig).toEqual(
          id.includes("3.5")
            ? { thinkingLevel: "medium", includeThoughts: true }
            : { thinkingBudget: 512, includeThoughts: true },
        );
        return textResponse();
      },
      {
        temperature: 170,
        top_p: 0.7,
        top_k: 40,
        reasoningEffort: 1,
        thinkingTokens: 512,
        frequencyPenalty: 0,
        PresensePenalty: 0,
      },
    );
    expect(
      await f.runtime.requestGoogleCloudVertex({
        ...f.arg,
        aiModel: id,
        modelInfo: structuredClone(model),
      }),
    ).toMatchObject({ type: "success" });
  });

test("Vertex OAuth signs a real RSA JWT, persists refreshed credentials through context and uses the upstream global route", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const calls: URL[] = [];
  const f = fixture(
    async (url, init) => {
      const target = new URL(String(url));
      calls.push(target);
      if (target.hostname === "oauth2.googleapis.com") {
        const fields = new URLSearchParams(String(init?.body));
        const jwt = fields.get("assertion")!.split(".");
        expect(JSON.parse(Buffer.from(jwt[0], "base64url").toString())).toEqual(
          { alg: "RS256", typ: "JWT" },
        );
        const claim = JSON.parse(Buffer.from(jwt[1], "base64url").toString());
        expect(claim.iss).toBe("synthetic@test.gserviceaccount.com");
        expect(claim.aud).toBe("https://oauth2.googleapis.com/token");
        expect(claim.exp - claim.iat).toBe(3600);
        expect(
          verify(
            "RSA-SHA256",
            Buffer.from(jwt[0] + "." + jwt[1]),
            publicKey,
            Buffer.from(jwt[2], "base64url"),
          ),
        ).toBe(true);
        return Response.json({ access_token: "synthetic-new-token" });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer synthetic-new-token",
      );
      const body = JSON.parse(String(init?.body));
      expect(body.systemInstruction.parts[0].text).toBe("Synthetic system");
      expect(body.contents[0].parts[0].text).toBe("Synthetic input");
      expect(body.tools).toBeUndefined();
      return textResponse();
    },
    {
      vertexClientEmail: "synthetic@test.gserviceaccount.com",
      vertexPrivateKey: key,
      vertexAccessTokenExpires: 0,
    },
  );
  expect(await f.runtime.requestGoogleCloudVertex(f.arg)).toEqual({
    type: "success",
    result: "Synthetic answer",
  });
  expect(calls.map((u) => u.hostname)).toEqual([
    "oauth2.googleapis.com",
    "aiplatform.googleapis.com",
  ]);
  expect(calls[1].pathname).toContain("/locations/global/");
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0].vertexAccessToken).toBe("synthetic-new-token");
  expect(f.writes[0].vertexAccessTokenExpires).toBeGreaterThan(Date.now());
  expect(f.transport.calls()).toBe(2);
  expect(JSON.stringify(f.progress)).not.toMatch(
    /synthetic-(new-token|input|key|answer)/,
  );
});

test("cached Vertex auth streams original thought/text chunks with a stable accumulated final response", async () => {
  const encoder = new TextEncoder();
  const events = [
    {
      candidates: [
        { content: { parts: [{ text: "Synthetic thought", thought: true }] } },
      ],
    },
    { candidates: [{ content: { parts: [{ text: "어서 오세요. " }] } }] },
    {
      candidates: [{ content: { parts: [{ text: "안내입니다." }] } }],
      usageMetadata: { totalTokenCount: 10 },
    },
  ];
  const f = fixture(async (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer synthetic-cached-token",
    );
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const event of events)
            controller.enqueue(
              encoder.encode("data: " + JSON.stringify(event) + "\n\n"),
            );
          controller.close();
        },
      }),
    );
  });
  const result = await f.runtime.requestGoogleCloudVertex({
    ...f.arg,
    useStreaming: true,
  });
  expect(result.type).toBe("streaming");
  if (result.type !== "streaming") throw new Error("Expected streaming result");
  const reader = result.result.getReader(),
    chunks: any[] = [];
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    chunks.push(item.value);
  }
  expect(chunks.at(-1)["0"]).toBe(
    "<Thoughts>\n\nSynthetic thought\n\n</Thoughts>\n\n어서 오세요. 안내입니다.",
  );
  expect(f.writes).toHaveLength(0);
  expect(f.transport.calls()).toBe(1);
  expect(typeof window).toBe("undefined");
});

test("Vertex emits intact Korean and emoji from byte-fragmented SSE before the provider finishes", async () => {
  const encoder = new TextEncoder();
  let provider!: ReadableStreamDefaultController<Uint8Array>;
  const packet = (text: string) =>
    encoder.encode(
      "data: " +
        JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) +
        "\r\n\r\n",
    );
  const f = fixture(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            provider = controller;
            for (const byte of packet("안녕하세요 🙂"))
              controller.enqueue(Uint8Array.of(byte));
          },
        }),
      ),
  );
  const result = await f.runtime.requestGoogleCloudVertex({
    ...f.arg,
    useStreaming: true,
  });
  if (result.type !== "streaming") throw Error("Expected Vertex streaming");
  const reader = result.result.getReader();
  let finished = false;
  try {
    let prefix: string | undefined;
    while (!prefix) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      prefix = next.value?.["0"];
    }
    expect(prefix).toBe("안녕하세요 🙂");
    provider.enqueue(packet(" 계속합니다."));
    provider.close();
    finished = true;
    let final = prefix;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      final = next.value["0"];
    }
    expect(final).toBe("안녕하세요 🙂 계속합니다.");
    expect(f.transport.calls()).toBe(1);
  } finally {
    if (!finished) provider.close();
  }
});

test("later Vertex deltas never replay a signed part or replace its signature marker", async () => {
  const signatures: unknown[] = [];
  let ids = 0;
  const f = fixture(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const part of [
              { text: "Signed", thoughtSignature: "synthetic-signature" },
              { text: " next" },
              { text: " final" },
            ])
              controller.enqueue(
                new TextEncoder().encode(
                  "data: " +
                    JSON.stringify({
                      candidates: [{ content: { parts: [part] } }],
                    }) +
                    "\n\n",
                ),
              );
            controller.close();
          },
        }),
      ),
    {},
    undefined,
    {
      v4: () => "signature-" + ++ids,
      saveInlayedSignature: (id: string, value: unknown) =>
        signatures.push({ id, value }),
    },
  );
  const result = await f.runtime.requestGoogleCloudVertex({
    ...f.arg,
    useStreaming: true,
    saveSignatures: true,
  });
  if (result.type !== "streaming") throw Error("Expected streaming");
  const reader = result.result.getReader();
  const chunks: string[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value["0"]);
  }
  expect(signatures).toHaveLength(1);
  expect(ids).toBe(1);
  expect(chunks.at(-1)).toBe("Signed{{inlayeddata::signature-1}} next final");
  expect(
    chunks.every((text) => text.includes("{{inlayeddata::signature-1}}")),
  ).toBe(true);
});

test("malformed Vertex SSE reaches the caller as an error without provider replay", async () => {
  const f = fixture(async () => new Response('data: {"broken":}\n\n'));
  const result = await f.runtime.requestGoogleCloudVertex({
    ...f.arg,
    useStreaming: true,
  });
  if (result.type !== "streaming") throw Error("Expected streaming");
  await expect(result.result.getReader().read()).rejects.toThrow(
    "Malformed JSON in provider event stream",
  );
  expect(f.transport.calls()).toBe(1);
});

test("Vertex error events reject an already started response instead of returning its partial text", async () => {
  const f = fixture(
    async () =>
      new Response(
        'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n' +
          'data: {"error":{"message":"Synthetic provider failure"}}\n\n',
      ),
  );
  const result = await f.runtime.requestGoogleCloudVertex({
    ...f.arg,
    useStreaming: true,
  });
  if (result.type !== "streaming") throw Error("Expected streaming");
  await expect(result.result.getReader().read()).rejects.toThrow(
    "Google stream failed: Synthetic provider failure",
  );
  expect(f.transport.calls()).toBe(1);
});

test("Vertex quota errors return the original failure without recursive provider replay", async () => {
  const f = fixture(
    async () => new Response("RESOURCE_EXHAUSTED synthetic", { status: 429 }),
  );
  const result = await f.runtime.requestGoogleCloudVertex({
    ...f.arg,
    useStreaming: true,
  });
  expect(result).toMatchObject({ type: "fail", failByServerError: true });
  expect(f.transport.calls()).toBe(1);
});

test("the server job signal aborts OAuth and no generation request is admitted afterward", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const abort = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = fixture(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(init!.signal!.reason),
          { once: true },
        );
        started();
      }),
    {
      vertexClientEmail: "synthetic@test.gserviceaccount.com",
      vertexPrivateKey: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      vertexAccessTokenExpires: 0,
    },
    abort.signal,
  );
  const pending = f.runtime.requestGoogleCloudVertex(f.arg);
  const rejected = expect(pending).rejects.toThrow(
    "Provider outcome is uncertain",
  );
  await ready;
  abort.abort(new Error("Synthetic cancellation"));
  await rejected;
  expect(f.transport.calls()).toBe(1);
  expect(f.writes).toHaveLength(0);
});

test("unsupported image persistence fails explicitly instead of reporting an asset was saved", async () => {
  const f = fixture(async () =>
    Response.json({
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: "image/png", data: "synthetic" } },
            ],
          },
        },
      ],
    }),
  );
  await expect(f.runtime.requestGoogleCloudVertex(f.arg)).rejects.toThrow(
    "Missing synthetic capability: Image",
  );
  expect(f.transport.calls()).toBe(1);
});
