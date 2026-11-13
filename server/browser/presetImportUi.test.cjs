"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createCipheriv, createHash } = require("node:crypto");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { encode } = require("msgpackr");
const { compressSync } = require("fflate");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");

async function until(read, predicate = Boolean, label = "preset file flow") {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(50);
  } while (Date.now() < end);
  throw Error("Synthetic " + label + " timeout: " + JSON.stringify(value));
}
const openPresetList = `(async()=>{const s=await import('/src/ts/stores.svelte.ts');s.settingsOpen.set(false);s.openPresetList.set(true);})()`;
const runtimeValue = (expression) =>
  `(async()=>{const {browserRuntime}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${expression};})()`;
const neutralTemplate = [
  {
    type: "plain",
    type2: "normal",
    text: "Synthetic neutral instruction",
    role: "system",
  },
];
const unknownJson = {
  nested: { retained: true, nullable: null },
  sequence: [false, 7, "retained"],
};

// Produce the public encrypted MessagePack preset envelope independently of the
// importer/exporter. Optional undefined values are valid packed input, but are
// not valid canonical command JSON and must be handled at the import boundary.
function packedPreset(preset) {
  const key = createHash("sha256").update("risupreset").digest();
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(12));
  const encrypted = Buffer.concat([
    cipher.update(encode(preset)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return compressSync(
    encode({ presetVersion: 2, type: "preset", preset: encrypted }),
  );
}

test(
  "original sparse preset file imports persist and apply on desktop and Android-like browsers",
  { timeout: 240000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-preset-file-ui-"));
    let runtime, frontend, browser;
    t.after(async () => {
      if (browser) await browser.close();
      if (frontend) await frontend.close();
      if (runtime) await runtime.close();
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const origins = [];
    runtime = await createRuntimeService({
      file: join(directory, "synthetic.sqlite"),
      initialize: true,
      origins,
      eventsPollMs: 20,
    });
    const values = { didFirstSetup: true, language: "en" };
    const fields = (
      await runtime.store.call(
        "readFields",
        Object.keys(values).map((key) => ({
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key,
        })),
      )
    ).fields;
    await runtime.store.call(
      "applyCommand",
      "synthetic-preset-import-settings",
      {
        type: "change-fields",
        edits: fields.map((field) => ({
          ...field,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          value: values[field.key],
        })),
      },
    );
    const settings = async () =>
      (await runtime.store.call("getResource", "settings", "global")).payload;
    const { createServer } = await import("vite");
    frontend = await createServer({
      configFile: resolve("vite.config.ts"),
      logLevel: "error",
      define: {
        "import.meta.env.VITE_RISU_ENTITY_RUNTIME": '"TRUE"',
        "import.meta.env.VITE_RISU_LEGAL_CONFIGURED": '"TRUE"',
      },
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        proxy: { "/api/runtime": { target: runtime.url, changeOrigin: true } },
      },
    });
    await frontend.listen();
    const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
    origins.push(url);
    browser = await launchChromium(directory);

    for (const device of ["desktop", "android-like"]) {
      for (const format of [
        "native-json",
        "st-missing-presence",
        "packed-optional",
        "nai-sparse",
      ]) {
        await t.test(device + " " + format, { timeout: 60000 }, async (sub) => {
          const page = await browser.page(
            "about:blank",
            await browser.newContext(),
            {
              viewport: { width: 1440, height: 900 },
              blockHttps: true,
            },
          );
          sub.after(() => page.close());
          if (device === "android-like") {
            await page.send("Emulation.setDeviceMetricsOverride", {
              width: 390,
              height: 844,
              deviceScaleFactor: 3,
              mobile: true,
            });
            await page.send("Emulation.setTouchEmulationEnabled", {
              enabled: true,
              maxTouchPoints: 5,
            });
            await page.send("Network.setUserAgentOverride", {
              userAgent:
                "Mozilla/5.0 (Linux; Android 14; Synthetic Phone) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
              platform: "Android",
            });
          }
          await page.send("Page.navigate", { url });
          await until(() =>
            page.evaluate(
              "!!document.querySelector('[data-runtime-ready=\"true\"]')",
            ),
          );
          await page.evaluate(
            `(()=>{window.presetImportErrors=[];window.addEventListener('error',event=>window.presetImportErrors.push(String(event.error?.message??event.message)));window.addEventListener('unhandledrejection',event=>window.presetImportErrors.push(String(event.reason?.message??event.reason)));})()`,
          );
          const baseline = [...(await settings()).presetIds];
          const name = "Synthetic sparse " + device + " " + format;
          const preset = {
            name,
            temperature: 43,
            maxResponse: 257,
            promptTemplate: neutralTemplate,
            synthetic_unknown_json: unknownJson,
          };
          const defaultNaiSettings =
            format === "nai-sparse"
              ? await page.evaluate(
                  `(async()=>{const {prebuiltPresets}=await import('/src/ts/process/templates/templates.ts');return JSON.parse(JSON.stringify(prebuiltPresets.NAI.NAISettings));})()`,
                )
              : null;
          let file;
          if (format === "packed-optional") {
            const packed = packedPreset({
              ...preset,
              optionalImportField: undefined,
              synthetic_packed_optionals: {
                omitted: undefined,
                retained: "packed",
              },
            });
            const bytes = await page.evaluate(
              `(async()=>{const {encodeRPack}=await import('/src/ts/rpack/rpack_js.js');return Array.from(await encodeRPack(Uint8Array.from(${JSON.stringify(Array.from(packed))})));})()`,
            );
            file = join(directory, name + ".risup");
            await writeFile(file, Buffer.from(bytes));
          } else {
            const data =
              format === "st-missing-presence"
                ? {
                    temperature: 0.43,
                    prompt_order: [
                      { order: [{ identifier: "main", enabled: true }] },
                    ],
                    prompts: [
                      {
                        identifier: "main",
                        content: neutralTemplate[0].text,
                        role: "system",
                      },
                    ],
                  }
                : format === "nai-sparse"
                  ? {
                      presetVersion: 3,
                      name,
                      parameters: {
                        temperature: 0.43,
                        max_length: 257,
                        repetition_penalty_presence: 0.7,
                      },
                    }
                  : preset;
            file = join(directory, name + ".json");
            await writeFile(file, JSON.stringify(data));
          }
          await page.evaluate(openPresetList);
          await page.send("Page.setInterceptFileChooserDialog", {
            enabled: true,
          });
          let chooser;
          const removeChooser = page.on("Page.fileChooserOpened", (event) => {
            chooser = event;
          });
          const point = await until(() =>
            page.evaluate(
              `(()=>{const button=document.querySelector('[data-runtime-preset-action="create"] + button');if(!button)return null;button.scrollIntoView({block:'center'});const rect=button.getBoundingClientRect();return{x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`,
            ),
          );
          if (device === "android-like") {
            await page.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [point],
            });
            await page.send("Input.dispatchTouchEvent", {
              type: "touchEnd",
              touchPoints: [],
            });
          } else {
            for (const type of ["mousePressed", "mouseReleased"]) {
              await page.send("Input.dispatchMouseEvent", {
                type,
                ...point,
                button: "left",
                buttons: type === "mousePressed" ? 1 : 0,
                clickCount: 1,
              });
            }
          }
          await until(() => chooser, Boolean, "original preset chooser");
          await page.send("DOM.setFileInputFiles", {
            files: [file],
            backendNodeId: chooser.backendNodeId,
          });
          removeChooser();
          const id = await until(
            async () => {
              const errors = await page.evaluate("window.presetImportErrors");
              assert.deepEqual(
                errors,
                [],
                device +
                  " " +
                  format +
                  " import rejected before canonical persistence",
              );
              return (await settings()).presetIds.find(
                (id) => !baseline.includes(id),
              );
            },
            Boolean,
            device + " " + format + " canonical import",
          );
          const row = await runtime.store.call("getResource", "preset", id);
          assert.equal(row.id, id);
          assert.equal(row.payload.temperature, 43);
          assert.ok(Number.isFinite(row.payload.PresensePenalty));
          assert.equal(row.payload.PresensePenalty, 70);
          if (format === "st-missing-presence") {
            assert.equal(row.payload.name, "Imported ST Preset");
            assert.equal(
              row.payload.promptTemplate[0].text,
              neutralTemplate[0].text,
            );
          } else if (format === "nai-sparse") {
            assert.equal(row.payload.name, name);
            assert.equal(row.payload.maxResponse, 257);
            assert.deepEqual(row.payload.NAISettings, {
              ...defaultNaiSettings,
              repostitionPenaltyPresence: 0.7,
            });
          } else {
            assert.equal(row.payload.name, name);
            assert.equal(row.payload.maxResponse, 257);
            assert.deepEqual(row.payload.synthetic_unknown_json, unknownJson);
          }
          if (format === "packed-optional") {
            assert.equal(
              Object.hasOwn(row.payload, "optionalImportField"),
              false,
            );
            assert.deepEqual(row.payload.synthetic_packed_optionals, {
              retained: "packed",
            });
          }
          await page.send("Page.reload", { ignoreCache: true });
          await until(() =>
            page.evaluate(
              "!!document.querySelector('[data-runtime-ready=\"true\"]')",
            ),
          );
          await page.evaluate(openPresetList);
          await until(() =>
            page.evaluate(
              `!!document.querySelector('[data-preset-id="${id}"]')`,
            ),
          );
          await page.evaluate(
            `document.querySelector('[data-preset-id="${id}"]').click()`,
          );
          await until(async () => {
            const value = await settings();
            return (
              value.presetIds[value.botPresetsId] === id &&
              value.temperature === 43
            );
          });
          await until(() =>
            page.evaluate(
              runtimeValue(
                `browserRuntime().model.database.botPresets[browserRuntime().model.database.botPresetsId]?.id===${JSON.stringify(id)}&&browserRuntime().model.database.temperature===43`,
              ),
            ),
          );
          const reloaded = await runtime.store.call(
            "getResource",
            "preset",
            id,
          );
          assert.deepEqual(reloaded.payload, row.payload);
          if (format === "native-json" || format === "packed-optional") {
            assert.deepEqual(
              await page.evaluate(
                runtimeValue(
                  `JSON.parse(JSON.stringify(browserRuntime().model.database.botPresets.find(p=>p.id===${JSON.stringify(id)}).synthetic_unknown_json))`,
                ),
              ),
              unknownJson,
            );
          }
          console.log(
            JSON.stringify({
              device,
              format,
              canonicalSaved: true,
              reloadAndApply: true,
              realProviderCalls: 0,
            }),
          );
        });
      }
    }
  },
);
