"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const { zipSync, strToU8 } = require("fflate");
async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("TTS editor condition timeout: " + JSON.stringify(value));
}
const selector = (key) => `[data-runtime-tts-field="${key}"]`;
async function editValue(page, key, value, kind = "input") {
  const select =
    selector(key) +
    (kind === "select"
      ? " select"
      : kind === "check"
        ? " input[type=checkbox]"
        : kind === "area"
          ? " textarea"
          : " input");
  await until(() =>
    page.evaluate(`!!document.querySelector(${JSON.stringify(select)})`),
  );
  await page.evaluate(
    `(()=>{const e=document.querySelector(${JSON.stringify(select)});${kind === "check" ? "e.checked" : "e.value"}=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
}
const mocks = `window.syntheticVoiceCalls=[];const originalFetch=window.fetch;window.fetch=async(input,init)=>{const url=typeof input==='string'?new URL(input,location.href):new URL(input.url??String(input),location.href);let data;
if(url.href==='https://api.elevenlabs.io/v1/voices')data={voices:[{voice_id:'synthetic-eleven',name:'Authored voice'}]};
else if(url.origin==='http://synthetic-voicevox.invalid'&&url.pathname==='/speakers')data=[{name:'Authored speaker',styles:[{name:'Authored style',id:7}]}];
else if(url.href==='https://api.fish.audio/model?self=true')data={items:[{_id:'synthetic-fish',title:'Authored model',description:'Neutral fixture'}]};
if(data){window.syntheticVoiceCalls.push(url.pathname);return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})}
if(url.origin!==location.origin)throw Error('External network blocked in synthetic TTS editor test');return originalFetch(input,init)};
if(window.speechSynthesis)window.speechSynthesis.getVoices=()=>[{name:'Authored web voice'}];`;

for (const options of [
  { name: "desktop", mobile: false, beta: false },
  { name: "mobile-general", mobile: true, beta: false },
  { name: "mobile-beta", mobile: true, beta: true },
])
  test(
    `${options.name}: original TTS controls preserve atomic provider changes, shared reference media, captured picker guards and offline field replay`,
    {
      timeout: 180000,
      skip:
        process.env.RISU_TTS_NEGATIVE === "TRUE" && options.name !== "desktop",
    },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "risu-tts-editor-"));
      let runtime, frontend, browser, a, b;
      t.after(async () => {
        if (a)
          console.log(
            JSON.stringify({
              layout: options.name,
              teardown: await a
                .evaluate("document.body.textContent.slice(-800)")
                .catch(() => null),
            }),
          );
        await browser?.close();
        await frontend?.close();
        await runtime?.close();
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
        origins,
        eventsPollMs: 20,
      });
      await runtime.scheduler.close();
      await runtime.store.call("applyCommand", "settings", {
        type: "put-resource",
        kind: "settings",
        resourceId: "global",
        expectedRevision: 0,
        payload: {
          didFirstSetup: true,
          language: "en",
          aiModel: "gpt35",
          betaMobileGUI: options.beta,
          voicevoxUrl: "http://synthetic-voicevox.invalid",
          fishSpeechKey: "synthetic-not-a-real-key",
        },
      });
      for (const id of ["c", "d"])
        await runtime.store.call("applyCommand", "create-" + id, {
          type: "create-character",
          characterId: id,
          chat: {
            chatId: "chat-" + id,
            metadata: { name: "Authored TTS test" },
          },
          definition: {
            type: "character",
            name: "Synthetic TTS " + id,
            desc: "Neutral authored fixture",
            firstMessage: "Synthetic greeting",
            ttsMode: id === "c" ? "novelai" : "openai",
            ttsSpeech: "seed",
            ...(id === "c"
              ? {
                  voicevoxConfig: {
                    SPEED_SCALE: 1,
                    syntheticUnknown: "retained",
                  },
                  oaiTTSConfig: {
                    enabled: false,
                    format: "mp3",
                    syntheticUnknown: { keep: true },
                  },
                  hfTTS: {
                    model: "seed-model",
                    language: "en",
                    syntheticUnknown: "retained",
                  },
                  fishSpeechConfig: {
                    model: {
                      title: "Keep title",
                      description: "Keep description",
                      syntheticUnknown: "nested",
                    },
                    chunk_length: 200,
                    normalize: false,
                    syntheticUnknown: "retained",
                  },
                  gptSoVitsConfig: {
                    ref_audio_data: {
                      fileName: "",
                      assetId: "",
                      syntheticUnknown: "nested",
                    },
                    syntheticUnknown: "retained",
                  },
                }
              : {}),
          },
        });
      const vite = await import("vite");
      const negative = process.env.RISU_TTS_NEGATIVE === "TRUE";
      const original = negative
        ? execFileSync(
            "git",
            ["show", "8f31f6d:src/lib/SideBars/CharConfig.svelte"],
            { encoding: "utf8" },
          )
        : null;
      frontend = await vite.createServer({
        configFile: resolve("vite.config.ts"),
        logLevel: "error",
        plugins: negative
          ? [
              {
                name: "pre-tts-negative-control",
                enforce: "pre",
                load(id) {
                  if (id === resolve("src/lib/SideBars/CharConfig.svelte"))
                    return original;
                },
              },
            ]
          : [],
        define: {
          "import.meta.env.VITE_RISU_ENTITY_RUNTIME": '"TRUE"',
          "import.meta.env.VITE_RISU_LEGAL_CONFIGURED": '"TRUE"',
        },
        server: {
          host: "127.0.0.1",
          port: 0,
          strictPort: false,
          proxy: {
            "/api/runtime": { target: runtime.url, changeOrigin: true },
          },
        },
      });
      await frontend.listen();
      const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
      origins.push(url);
      browser = await launchChromium(directory);
      const contexts = [await browser.newContext(), await browser.newContext()];
      const open = async (context) => {
        const p = await browser.page("about:blank", context, {
          viewport: { width: 1440, height: 900 },
          blockHttps: true,
        });
        if (options.mobile && context === contexts[0]) {
          await p.send("Emulation.setDeviceMetricsOverride", {
            width: 390,
            height: 844,
            deviceScaleFactor: 3,
            mobile: true,
          });
          await p.send("Emulation.setTouchEmulationEnabled", {
            enabled: true,
            maxTouchPoints: 5,
          });
          await p.send("Network.setUserAgentOverride", {
            userAgent:
              "Mozilla/5.0 (Linux; Android 14; Synthetic Phone) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
            platform: "Android",
          });
        }
        await p.send("Page.addScriptToEvaluateOnNewDocument", {
          source: mocks,
        });
        await p.send("Page.navigate", { url });
        await until(() =>
          p.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
        );
        return p;
      };
      a = await open(contexts[0]);
      b = await open(contexts[1]);
      const show = async (p, id = "c") => {
        await p.evaluate(
          `(async()=>{const s=await import('/src/ts/stores.svelte.ts');const{browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');s.settingsOpen.set(false);await r().selectCharacter(${JSON.stringify(id)},'chat-'+${JSON.stringify(id)});s.botMakerMode.set(true);s.sideBarStore.set(true);s.MobileSideBar.set(2);s.CharConfigSubMenu.set(5)})()`,
        );
        await until(() =>
          p.evaluate(
            negative
              ? "document.querySelectorAll('select').length>0"
              : "!!document.querySelector('[data-runtime-tts-settings]')",
          ),
        );
      };
      const character = async (id = "c") =>
        (await runtime.store.call("getCharacter", id)).definition;
      const commands = [];
      await a.send("Network.enable");
      a.on("Network.requestWillBeSent", (e) => {
        if (
          e.request.url.endsWith("/api/runtime/commands") &&
          e.request.postData
        ) {
          const c = JSON.parse(e.request.postData).command;
          if (c.type === "change-fields") commands.push(c);
        }
      });
      const before = await character();
      await show(a);
      await show(b);
      await delay(150);
      if (negative) {
        await a.evaluate(
          "(()=>{const e=document.querySelector('select');e.value='openai';e.dispatchEvent(new Event('change',{bubbles:true}));})()",
        );
        await delay(200);
        assert.equal((await character()).ttsMode, "novelai");
        assert.equal(
          await a.evaluate("document.querySelector('select').value"),
          "openai",
        );
        assert.equal(commands.length, 0);
        assert.equal(
          await b.evaluate("document.querySelector('select').value"),
          "novelai",
        );
        console.log(
          JSON.stringify({
            negativeControl: true,
            visibleEditNotStored: true,
            peerUnchanged: true,
          }),
        );
        return;
      }
      assert.deepEqual(await character(), before);
      assert.equal(commands.length, 0);
      assert.equal((await character()).naittsConfig, undefined);
      await editValue(a, "naittsConfig.customvoice", true, "check");
      await editValue(a, "naittsConfig.voice", "authored-seed");
      await editValue(a, "naittsConfig.version", "v1", "select");
      await until(
        character,
        (x) =>
          x.naittsConfig?.voice === "authored-seed" &&
          x.naittsConfig.version === "v1",
      );
      await editValue(a, "ttsMode", "openai", "select");
      await until(
        character,
        (x) => x.ttsMode === "openai" && x.ttsSpeech === "",
      );
      assert.ok(
        commands.some(
          (c) =>
            c.edits.some((e) => e.key === "ttsMode" && e.value === "openai") &&
            c.edits.some((e) => e.key === "ttsSpeech" && e.value === ""),
        ),
        "Mode and speech reset in one admission",
      );
      await editValue(a, "oaiVoice", "nova", "select");
      await editValue(a, "oaiTTSConfig.enabled", true, "check");
      for (const [key, value] of [
        ["voice", "Authored custom voice"],
        ["baseURL", "http://synthetic-tts.invalid/v1"],
        ["apiKey", "synthetic-key-not-real"],
        ["model", "authored-model"],
      ])
        await editValue(a, "oaiTTSConfig." + key, value);
      await editValue(a, "oaiTTSConfig.format", "wav", "select");
      await editValue(a, "ttsReadOnlyQuoted", true, "check");
      await until(
        character,
        (x) => x.oaiTTSConfig?.format === "wav" && x.ttsReadOnlyQuoted === true,
      );
      assert.deepEqual((await character()).oaiTTSConfig.syntheticUnknown, {
        keep: true,
      });
      await until(() =>
        b.evaluate(
          "document.getElementById('runtime-tts-oaiTTSConfig.model')?.value==='authored-model'",
        ),
      );
      await editValue(a, "ttsMode", "huggingface", "select");
      await until(() =>
        b.evaluate("!!document.getElementById('runtime-tts-hfTTS.model')"),
      );
      await Promise.all([
        editValue(a, "hfTTS.model", "Authored local model"),
        editValue(b, "ttsReadOnlyQuoted", false, "check"),
      ]);
      await until(
        character,
        (x) => x.hfTTS.model === "Authored local model" && !x.ttsReadOnlyQuoted,
      );
      assert.equal((await character()).hfTTS.syntheticUnknown, "retained");
      await editValue(a, "hfTTS.language", "ko");
      await until(character, (x) => x.hfTTS.language === "ko");
      await editValue(a, "ttsMode", "webspeech", "select");
      await editValue(a, "ttsSpeech", "Authored web voice", "select");
      await until(character, (x) => x.ttsSpeech === "Authored web voice");
      await editValue(a, "ttsMode", "elevenlab", "select");
      await editValue(a, "ttsSpeech", "synthetic-eleven", "select");
      await until(character, (x) => x.ttsSpeech === "synthetic-eleven");
      await editValue(a, "ttsMode", "VOICEVOX", "select");
      await editValue(
        a,
        "voicevoxConfig.speaker",
        JSON.stringify([{ name: "Authored style", id: "7" }]),
        "select",
      );
      await editValue(a, "ttsSpeech", "7", "select");
      for (const [key, value] of [
        ["SPEED_SCALE", 1.2],
        ["PITCH_SCALE", 0.1],
        ["VOLUME_SCALE", 0.8],
        ["INTONATION_SCALE", 1.1],
      ])
        await editValue(a, "voicevoxConfig." + key, value);
      await until(
        character,
        (x) =>
          x.voicevoxConfig?.INTONATION_SCALE === 1.1 && x.ttsSpeech === "7",
      );
      assert.equal(
        (await character()).voicevoxConfig.syntheticUnknown,
        "retained",
      );
      await editValue(a, "ttsMode", "fishspeech", "select");
      await editValue(
        a,
        "fishSpeechConfig.model._id",
        "synthetic-fish",
        "select",
      );
      await editValue(a, "fishSpeechConfig.chunk_length", 240);
      await editValue(a, "fishSpeechConfig.normalize", true, "check");
      await until(
        character,
        (x) =>
          x.fishSpeechConfig?.normalize &&
          x.fishSpeechConfig.model._id === "synthetic-fish",
      );
      assert.equal(
        (await character()).fishSpeechConfig.model.syntheticUnknown,
        "nested",
      );
      assert.equal(
        (await character()).fishSpeechConfig.model.title,
        "Keep title",
      );
      await editValue(a, "ttsMode", "gptsovits", "select");
      await editValue(
        a,
        "gptSoVitsConfig.url",
        "http://synthetic-sovits.invalid",
      );
      await editValue(a, "gptSoVitsConfig.ref_audio_path", "synthetic/path");
      for (const key of ["use_auto_path", "use_long_audio"]) {
        await editValue(a, "gptSoVitsConfig." + key, true, "check");
        await editValue(a, "gptSoVitsConfig." + key, false, "check");
      }
      await editValue(a, "gptSoVitsConfig.use_prompt", true, "check");
      await editValue(
        a,
        "gptSoVitsConfig.prompt",
        "Authored neutral audio script",
        "area",
      );
      await editValue(a, "gptSoVitsConfig.text_lang", "ko", "select");
      await editValue(a, "gptSoVitsConfig.prompt_lang", "en", "select");
      await editValue(a, "gptSoVitsConfig.text_split_method", "cut4", "select");
      for (const key of ["volume", "top_p", "temperature", "speed", "top_k"])
        await a.evaluate(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector("gptSoVitsConfig." + key) + " [role=slider]")});e.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));})()`,
        );
      await until(
        character,
        (x) =>
          x.gptSoVitsConfig?.prompt === "Authored neutral audio script" &&
          x.gptSoVitsConfig.text_split_method === "cut4" &&
          x.gptSoVitsConfig.volume < 1 &&
          x.gptSoVitsConfig.top_p < 1 &&
          x.gptSoVitsConfig.temperature < 0.7 &&
          x.gptSoVitsConfig.speed < 1 &&
          x.gptSoVitsConfig.top_k === 4,
      );
      assert.equal(
        (await character()).gptSoVitsConfig.syntheticUnknown,
        "retained",
      );
      const wav = Buffer.alloc(46);
      wav.write("RIFF");
      wav.writeUInt32LE(38, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(8000, 24);
      wav.writeUInt32LE(16000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(2, 40);
      const audioFile = join(directory, "authored.wav");
      await writeFile(audioFile, wav);
      const vitsFile = join(directory, "authored-vits.zip");
      const modelBytes = Uint8Array.from([0, 1, 2, 3]);
      await writeFile(
        vitsFile,
        zipSync({
          "/model.onnx": modelBytes,
          "config.json": strToU8('{"synthetic":true}'),
        }),
      );
      let chooser;
      a.on("Page.fileChooserOpened", (e) => {
        chooser = e;
      });
      await a.send("Page.setInterceptFileChooserDialog", { enabled: true });
      const beginPicker = async (text) => {
        await until(() =>
          a.evaluate(
            "(async()=>{const{RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return s.pending.length===0})()",
          ),
        );
        chooser = undefined;
        const point = await a.evaluate(
          `(()=>{const e=[...document.querySelectorAll('[data-runtime-tts-settings] button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        );
        for (const type of ["mousePressed", "mouseReleased"])
          await a.send("Input.dispatchMouseEvent", {
            type,
            ...point,
            button: "left",
            buttons: type === "mousePressed" ? 1 : 0,
            clickCount: 1,
          });
        await until(() => chooser);
      };
      const supply = (file) =>
        a.send("DOM.setFileInputFiles", {
          files: [file],
          backendNodeId: chooser.backendNodeId,
        });
      await beginPicker("Select File");
      await supply(audioFile);
      await until(
        async () => {
          const state = await a.evaluate(
            "(async()=>{const{RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return {error:s.error,pending:s.pending.map(x=>({state:x.state,type:x.command.type}))}})()",
          );
          if (state.error)
            throw Error("Reference audio failed: " + JSON.stringify(state));
          return character();
        },
        (x) => x.gptSoVitsConfig.ref_audio_data.fileName === "authored.wav",
      );
      const audio = (await character()).gptSoVitsConfig.ref_audio_data;
      assert.ok(audio.assetId.endsWith(".wav"));
      assert.equal(audio.syntheticUnknown, "nested");
      await until(() =>
        b.evaluate(
          "[...document.querySelectorAll('[data-runtime-tts-settings] button')].some(e=>e.textContent.trim()==='authored.wav')",
        ),
      );
      const bytes = await b.evaluate(
        `(async()=>{const {loadAsset}=await import('/src/ts/globalApi.svelte.ts');return Array.from(await loadAsset(${JSON.stringify(audio.assetId)}))})()`,
      );
      assert.deepEqual(Buffer.from(bytes), wav);
      // An upload captures mode as well as its aggregate; confirmed A→B→A must
      // invalidate it even though the visible mode has returned to the same value.
      await beginPicker("authored.wav");
      await editValue(b, "ttsMode", "huggingface", "select");
      await until(character, (x) => x.ttsMode === "huggingface");
      await editValue(b, "ttsMode", "gptsovits", "select");
      await until(character, (x) => x.ttsMode === "gptsovits");
      const settled = await character();
      await supply(audioFile);
      await until(() =>
        a.evaluate(
          "document.body.textContent.includes('The edited fields changed while waiting')",
        ),
      );
      assert.deepEqual(await character(), settled);
      await a.evaluate(
        "[...document.querySelectorAll('[role=status] button')].find(e=>e.textContent.trim()==='확인')?.click()",
      );
      await until(() =>
        a.evaluate(
          "(async()=>{const{RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return !s.error})()",
        ),
      );
      await editValue(a, "ttsMode", "vits", "select");
      await until(character, (x) => x.ttsMode === "vits");
      await beginPicker("Select Model");
      await supply(vitsFile);
      await until(
        async () => {
          const error = await a.evaluate(
            "(async()=>{const{RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return s.error})()",
          );
          if (error) throw Error("VITS action failed: " + error);
          return character();
        },
        (x) => x.vits?.name === "authored-vits.zip",
      );
      const model = (await character()).vits;
      assert.ok(model.id && model.files["model.onnx"]);
      const modelData = await b.evaluate(
        `(async()=>{const{loadAsset}=await import('/src/ts/globalApi.svelte.ts');return Array.from(await loadAsset(${JSON.stringify(model.files["model.onnx"])}))})()`,
      );
      assert.deepEqual(modelData, Array.from(modelBytes));
      await editValue(a, "ttsMode", "openai", "select");
      await until(() =>
        b.evaluate(
          "!!document.getElementById('runtime-tts-oaiTTSConfig.model')",
        ),
      );
      await a.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0,
      });
      await editValue(a, "oaiTTSConfig.model", "Offline local model");
      await editValue(b, "oaiTTSConfig.model", "Peer canonical model");
      await until(
        character,
        (x) => x.oaiTTSConfig.model === "Peer canonical model",
      );
      await a.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await until(() =>
        a.evaluate(
          "(async()=>{const{RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return s.pending.some(x=>x.state==='blocked')})()",
        ),
      );
      assert.ok(
        await a.evaluate(
          "document.body.textContent.includes('The entity has changed')",
        ),
      );
      await a.evaluate(
        "[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='서버 값 사용').click()",
      );
      await until(() =>
        a.evaluate(
          "document.getElementById('runtime-tts-oaiTTSConfig.model').value==='Peer canonical model'",
        ),
      );
      for (const p of [a, b])
        await p.send("Network.emulateNetworkConditions", {
          offline: true,
          latency: 0,
          downloadThroughput: 0,
          uploadThroughput: 0,
        });
      await editValue(a, "oaiTTSConfig.model", "Every tab offline model");
      await until(() =>
        a.evaluate(
          "(async()=>{const{RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return s.pending.length>0})()",
        ),
      );
      await a.close();
      a = undefined;
      await b.close();
      b = undefined;
      a = await open(contexts[0]);
      await until(
        character,
        (x) => x.oaiTTSConfig.model === "Every tab offline model",
      );
      await show(a);
      await a.evaluate(
        "(()=>{const e=document.getElementById('runtime-tts-oaiTTSConfig.model');e.value='Last old-owner edit';e.dispatchEvent(new Event('input',{bubbles:true}));window.navigateTtsOwner=(async()=>{const{browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');await r().selectCharacter('d','chat-d')})()})()",
      );
      await a.evaluate("window.navigateTtsOwner");
      await until(
        character,
        (x) => x.oaiTTSConfig.model === "Last old-owner edit",
      );
      await until(() =>
        a.evaluate("!!document.querySelector('[data-runtime-tts-settings]')"),
      );
      assert.equal((await character("d")).oaiTTSConfig, undefined);
      await editValue(a, "oaiTTSConfig.enabled", true, "check");
      await editValue(a, "oaiTTSConfig.model", "New owner model");
      await until(
        () => character("d"),
        (x) => x.oaiTTSConfig?.model === "New owner model",
      );
      assert.equal(
        (await character()).oaiTTSConfig.model,
        "Last old-owner edit",
      );
      await a.send("Page.reload");
      await until(() =>
        a.evaluate("!!document.querySelector('[data-runtime-ready=true]')"),
      );
      await show(a, "c");
      assert.equal(
        await a.evaluate(
          "document.getElementById('runtime-tts-oaiTTSConfig.model').value",
        ),
        "Last old-owner edit",
      );
      console.log(
        JSON.stringify({
          layout: options.name,
          mobileEmulation: options.mobile,
          betaBranch: options.beta,
          fieldsStored: 11,
          absentConfigNoWritesOnOpen: true,
          providerAndSpeechAtomic: true,
          unknownNestedFieldsPreserved: true,
          allProviderControlsEdited: true,
          referenceWavSharedAndFidelity: true,
          vitsPackageSharedAndFidelity: true,
          pickerModeAbaRejected: true,
          peerUpdates: true,
          differentFieldConcurrency: true,
          sameFieldConflictVisible: true,
          allTabsOfflineReplay: true,
          navigationOldOwnerFlushed: true,
          newOwnerSeparate: true,
          reloadRetained: true,
          physicalDevices: false,
          realProviderRequests: 0,
        }),
      );
    },
  );
