"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { EntityStore } = require("../entity/store.cjs");

for (const experimental of [false, true])
  for (const model of ["custom", "openai3small", "voyageContext3"])
    test(
      `composed native ${experimental ? "experimental" : "default"} V3 ${model} embeds/ranks/persists using an injected synthetic provider transport`,
      { timeout: 15000 },
      async (t) => {
        const { createInitialRuntimeState, executeExtensionJob } = await import(
          pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
        );
        const store = new EntityStore(":memory:");
        t.after(() => store.close());
        store.initializeState(createInitialRuntimeState());
        const settings = store.getResource("settings", "global");
        store.applyCommand("settings", {
          type: "put-resource",
          kind: "settings",
          resourceId: "global",
          expectedRevision: settings.revision,
          payload: {
            ...settings.payload,
            aiModel: "reverse_proxy",
            customProxyRequestModel: "synthetic",
            customTokenizer: "tik",
            forceReplaceUrl: "http://synthetic.invalid/v1/chat/completions",
            maxContext: 1500,
            maxResponse: 100,
            useStreaming: false,
            hypav2: false,
            hanuraiEnable: false,
            hypaV3: true,
            hypaModel: model,
            supaMemoryKey: "synthetic-embedding-key",
            voyageApiKey: "synthetic-voyage-key",
            hypaCustomSettings: {
              url: "http://custom.invalid",
              key: "synthetic-custom-key",
              model: "synthetic-custom-model",
            },
            hypaV3PresetId: 0,
            hypaV3Presets: [
              {
                name: "Synthetic",
                settings: {
                  ...settings.payload.hypaV3Presets[0].settings,
                  useExperimentalImpl: experimental,
                  recentMemoryRatio: 0,
                  similarMemoryRatio: 1,
                  queryChatCount: 3,
                },
              },
            ],
          },
        });
        const memory = {
          summaries: [
            {
              text: "hay first\n\nhay second",
              chatMemos: ["m0"],
              isImportant: false,
            },
            {
              text: "needle first\n\nneedle second",
              chatMemos: ["m1"],
              isImportant: false,
            },
          ],
        };
        store.applyCommand("c", {
          type: "create-character",
          characterId: "c",
          definition: {
            type: "character",
            name: "Synthetic",
            supaMemory: true,
            firstMessage: "Synthetic greeting",
          },
          chat: {
            chatId: "a",
            metadata: { name: "Synthetic", hypaV3Data: memory },
          },
        });
        for (let i = 0; i < 6; i++)
          store.applyCommand("m" + i, {
            type: "append-message",
            chatId: "a",
            messageId: "m" + i,
            message: {
              role: i % 2 ? "char" : "user",
              data: i > 3 ? "needle query" : "hay history",
            },
          });
        store.enqueueJob("job", {
          type: "send",
          chatId: "a",
          input: "needle input",
          messageId: "input",
        });
        const claimed = store.claimJob("engine"),
          calls = [];
        const execution = await executeExtensionJob(claimed, {
          appVer: "2026.8.250",
          fetch: async (path) =>
            new Response(
              await readFile(join(__dirname, "../../public", path.slice(1))),
            ),
          providerFetch: async (url, init) => {
            const target = new URL(url),
              body = JSON.parse(init.body),
              authorization = new Headers(init.headers).get("authorization");
            calls.push({ hostname: target.hostname, body });
            const embedding = (text) =>
              String(text).includes("needle") ? [1, 0] : [0, 1];
            if (target.hostname === "api.voyageai.com") {
              assert.equal(authorization, "Bearer synthetic-voyage-key");
              assert.equal(body.model, "voyage-context-3");
              return Response.json({
                data: body.inputs.map((group) => ({
                  data: group.map((text) => ({ embedding: embedding(text) })),
                })),
              });
            }
            if (
              target.hostname === "api.openai.com" ||
              target.hostname === "custom.invalid"
            ) {
              assert.equal(
                authorization,
                target.hostname === "api.openai.com"
                  ? "Bearer synthetic-embedding-key"
                  : "Bearer synthetic-custom-key",
              );
              assert.equal(
                body.model,
                target.hostname === "api.openai.com"
                  ? "text-embedding-3-small"
                  : "synthetic-custom-model",
              );
              const input = Array.isArray(body.input)
                ? body.input
                : [body.input];
              return Response.json({
                data: input.map((text) => ({ embedding: embedding(text) })),
              });
            }
            assert.equal(target.hostname, "synthetic.invalid");
            assert.ok(
              body.messages.some((x) =>
                String(x.content).includes("needle first"),
              ),
            );
            return Response.json({
              choices: [{ message: { content: "Synthetic complete reply" } }],
            });
          },
        });
        assert.equal(execution.result.providerCalls, calls.length);
        assert.equal(
          calls.filter((x) => x.hostname === "synthetic.invalid").length,
          1,
        );
        assert.ok(calls.length > 1);
        if (model === "voyageContext3") {
          assert.deepEqual(
            calls.find((x) => x.body.input_type === "document").body.inputs,
            [
              ["hay first", "hay second"],
              ["needle first", "needle second"],
            ],
          );
          assert.ok(calls.some((x) => x.body.input_type === "query"));
        }
        store.finishJob(claimed.job.id, claimed.job.owner, claimed.job.fence, {
          state: "completed",
          ...execution,
        });
        const saved = store.snapshot("a");
        assert.equal(
          saved.chat.metadata.hypaV3Data.metrics.lastSimilarSummaries[0],
          1,
        );
        assert.deepEqual(
          saved.chat.metadata.hypaV3Data.summaries,
          memory.summaries,
        );
        assert.equal(
          saved.messages.at(-1).message.data,
          "Synthetic complete reply",
        );
      },
    );
