"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(50);
  } while (Date.now() < end);
  throw new Error("Synthetic library UI timeout: " + JSON.stringify(value));
}
const ui = (body) =>
  `(async()=>{const {browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${body}})()`;
async function input(page, id, value) {
  await until(() =>
    page.evaluate(`!!document.getElementById(${JSON.stringify(id)})`),
  );
  await page.evaluate(
    `(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
}
async function click(page, selector) {
  await until(() =>
    page.evaluate(
      `(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button)return false;button.click();return true;})()`,
    ),
  );
}
async function clickText(page, text) {
  await until(() =>
    page.evaluate(
      `(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)});if(!button)return false;button.click();return true;})()`,
    ),
  );
}
const presetList = `(async()=>{const stores=await import('/src/ts/stores.svelte.ts');stores.settingsOpen.set(false);stores.openPresetList.set(true);})()`;
const personaPage = `(async()=>{const stores=await import('/src/ts/stores.svelte.ts');stores.openPresetList.set(false);stores.SettingsMenuIndex.set(12);stores.settingsOpen.set(true);})()`;
test(
  "original library controls and shared persona/card PNG assets synchronize without conflicts, identity loss or render loops",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "risu-library-selection-ui-"),
    );
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
    const values = {
      didFirstSetup: true,
      language: "en",
      personaNote: true,
      temperature: 71,
      openAIKey: "SYNTHETIC-NOT-A-CREDENTIAL",
      proxyKey: "SYNTHETIC-NOT-A-PROXY-CREDENTIAL",
    };
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
    await runtime.store.call("applyCommand", "synthetic-selection-settings", {
      type: "change-fields",
      edits: fields.map((field) => ({
        ...field,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: values[field.key],
      })),
    });
    const settings = async () =>
      (await runtime.store.call("getResource", "settings", "global")).payload;
    const originalPreset = (await settings()).presetIds[0],
      originalPersona = (await settings()).personaIds[0];
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
    const open = async () => {
      const page = await browser.page(url, await browser.newContext(), {
        viewport: { width: 1440, height: 900 },
        blockHttps: true,
      });
      await until(() =>
        page.evaluate(
          "!!document.querySelector('[data-runtime-ready=\"true\"]')",
        ),
      );
      await page.evaluate(
        `(()=>{window.runtimeUncaughtErrors=[];window.addEventListener('error',event=>window.runtimeUncaughtErrors.push(String(event.error?.message??event.message)));window.addEventListener('unhandledrejection',event=>window.runtimeUncaughtErrors.push(String(event.reason)));})()`,
      );
      return page;
    };
    const a = await open(),
      b = await open();
    await a.evaluate(presetList);
    await click(a, '[data-runtime-preset-action="create"]');
    await until(async () => (await settings()).presetIds.length === 2);
    const created = (await settings()).presetIds.find(
      (id) => id !== originalPreset,
    );
    await until(() =>
      b.evaluate(
        ui(`r().model.database.botPresets.some(p=>p.id==='${created}')`),
      ),
    );
    await click(a, `[data-preset-id="${created}"]`);
    await until(
      async () =>
        (await settings()).presetIds[(await settings()).botPresetsId] ===
        created,
    );
    assert.equal(
      (await runtime.store.call("getResource", "preset", originalPreset))
        .payload.temperature,
      71,
    );
    await until(() =>
      b.evaluate(
        ui(
          `r().model.database.botPresets[r().model.database.botPresetsId]?.id==='${created}'`,
        ),
      ),
    );
    await a.evaluate(presetList);
    await click(a, '[data-runtime-preset-action="rename"]');
    await input(a, "runtime-preset-name-" + created, "Synthetic UI preset");
    await until(
      async () =>
        (await runtime.store.call("getResource", "preset", created)).payload
          .name === "Synthetic UI preset",
    );
    await a.evaluate(
      `(async()=>{const stores=await import('/src/ts/stores.svelte.ts');stores.openPresetList.set(false);})()`,
    );
    await a.evaluate(presetList);
    await click(
      a,
      `[data-preset-id="${created}"] [data-runtime-preset-action="copy"]`,
    );
    await until(async () => (await settings()).presetIds.length === 3);
    const copied = (await settings()).presetIds.find(
      (id) => ![originalPreset, created].includes(id),
    );
    assert.equal(
      (await runtime.store.call("getResource", "preset", copied)).payload.name,
      "Synthetic UI preset Copy",
    );
    await until(() =>
      a.evaluate(`!!document.querySelector('[data-preset-id="${copied}"]')`),
    );
    await a.evaluate(
      `(async()=>{const {RISU_PRESET_DRAG_TYPE}=await import('/src/ts/dragTypes.ts');const source=document.querySelector('[data-preset-id="${originalPreset}"]'),target=document.querySelector('[data-preset-id="${copied}"]'),dataTransfer=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,dataTransfer,clientY:target.getBoundingClientRect().bottom-1}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer}));source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}));})()`,
    );
    await until(
      async () => (await settings()).presetIds.at(-1) === originalPreset,
    );
    assert.equal(
      (await settings()).presetIds[(await settings()).botPresetsId],
      created,
    );
    await until(() =>
      b.evaluate(
        ui(
          `r().model.database.botPresets[r().model.database.botPresetsId]?.id==='${created}'`,
        ),
      ),
    );
    await a.evaluate(
      `(async()=>{const {downloadPreset,importPreset}=await import('/src/ts/storage/database.svelte.ts');const {browserRuntime}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');const db=browserRuntime().model.database;const index=db.botPresets.findIndex(p=>p.id==='${created}');window.presetRoundtripDone=false;void(async()=>{const encoded=await downloadPreset(index,'return');window.presetExportSanitized=encoded.data.openAIKey===''&&encoded.data.proxyKey==='';await importPreset({name:'Synthetic.risup',data:encoded.buf});window.presetRoundtripDone=true;})().catch(error=>{window.presetRoundtripError=String(error);});})()`,
    );
    await until(
      () =>
        a.evaluate(
          "({done:window.presetRoundtripDone,error:window.presetRoundtripError})",
        ),
      (value) => {
        if (value.error) throw Error(value.error);
        return value.done;
      },
    );
    assert.equal(await a.evaluate("window.presetExportSanitized"), true);
    assert.equal((await settings()).presetIds.length, 4);
    const imported = (await settings()).presetIds.find(
      (id) => ![originalPreset, created, copied].includes(id),
    );
    assert.equal(
      (await runtime.store.call("getResource", "preset", imported)).payload
        .name,
      "Synthetic UI preset",
    );
    assert.notEqual(imported, created);
    assert.equal(
      (await runtime.store.call("getResource", "preset", imported)).payload
        .openAIKey,
      "",
    );
    assert.equal(
      (await runtime.store.call("getResource", "preset", created)).payload
        .openAIKey,
      "SYNTHETIC-NOT-A-CREDENTIAL",
    );
    await a.evaluate(personaPage);
    await click(a, '[data-runtime-persona-action="create"] button');
    await until(() =>
      a.evaluate(
        `(async()=>{const {language}=await import('/src/lang/index.ts');const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===language.createfromScratch);if(!button)return false;button.click();return true;})()`,
      ),
    );
    await until(async () => (await settings()).personaIds.length === 2);
    const persona = (await settings()).personaIds.find(
      (id) => id !== originalPersona,
    );
    await until(
      async () =>
        (await settings()).personaIds[(await settings()).selectedPersona] ===
        persona,
    );
    await until(() =>
      a.evaluate(
        ui(
          `r().model.database.personas[r().model.database.selectedPersona]?.id==='${persona}'&&!document.querySelector('[data-runtime-persona-action="portrait"] input')?.checked`,
        ),
      ),
    );
    await click(a, '[data-runtime-persona-action="portrait"] input');
    await until(
      async () =>
        (await runtime.store.call("getResource", "persona", persona)).payload
          .largePortrait === true,
    );
    await until(() =>
      b.evaluate(
        ui(
          `r().model.database.personas.find(item=>item.id==='${persona}')?.largePortrait===true`,
        ),
      ),
    );
    await a.evaluate(
      `(async()=>{const {selectUserImg}=await import('/src/ts/persona.ts');const canvas=document.createElement('canvas');canvas.width=32;canvas.height=24;const context=canvas.getContext('2d');context.fillStyle='#3b82f6';context.fillRect(0,0,32,24);window.syntheticPng=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));window.assetUploadDone=false;void selectUserImg({name:'Synthetic.png',data:window.syntheticPng}).then(()=>window.assetUploadDone=true).catch(error=>window.assetUploadError=String(error));})()`,
    );
    await until(
      () =>
        a.evaluate(
          "({done:window.assetUploadDone,error:window.assetUploadError})",
        ),
      (value) => {
        if (value.error) throw Error(value.error);
        return value.done;
      },
    );
    const personaImage = (await settings()).userIcon;
    assert.match(personaImage, /^assets\/runtime\/[a-f0-9]{64}\.png$/);
    assert.equal(
      (await runtime.store.call("getResource", "persona", persona)).payload
        .icon,
      personaImage,
    );
    await until(() =>
      b.evaluate(
        ui(`r().model.database.userIcon===${JSON.stringify(personaImage)}`),
      ),
    );
    await until(() =>
      a.evaluate(
        `[...document.querySelectorAll('[style]')].some(element=>element.style.backgroundImage.includes('/api/runtime/assets/'))`,
      ),
    );
    const imageSize = await b.evaluate(
      ui(
        `new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve([image.naturalWidth,image.naturalHeight]);image.onerror=()=>reject(Error('Synthetic shared image failed'));image.src=r().assetUrl(${JSON.stringify(personaImage)});})`,
      ),
    );
    assert.deepEqual(imageSize, [32, 24]);
    await a.evaluate(
      ui(
        `(()=>{window.blockPersonaFields=true;const client=r().client,original=client.request;client.request=async(...args)=>{if(window.blockPersonaFields&&args[1]?.body&&JSON.parse(args[1].body).command?.type==='change-fields')throw new TypeError('Synthetic field admission offline');return original(...args);};return true;})()`,
      ),
    );
    await input(a, "runtime-persona-name", "Synthetic UI persona");
    await input(a, "runtime-persona-description", "Synthetic UI description");
    await b.evaluate(personaPage);
    await input(b, "runtime-persona-name", "Synthetic competing name");
    await until(
      async () => (await settings()).username === "Synthetic competing name",
    );
    await click(a, `[data-persona-id="${originalPersona}"]`);
    await until(() =>
      a.evaluate(
        ui(
          "s.pending.some(entry=>entry.command.type==='activate-library-resource')",
        ),
      ),
    );
    assert.equal(
      (await settings()).personaIds[(await settings()).selectedPersona],
      persona,
    );
    await a.evaluate(
      ui(
        "(()=>{window.blockPersonaFields=false;void r().client.flush();return true;})()",
      ),
    );
    await until(() =>
      a.evaluate(
        ui(
          "s.pending.some(entry=>entry.command.type==='change-fields'&&entry.state==='blocked')",
        ),
      ),
    );
    assert.equal(
      (await settings()).personaIds[(await settings()).selectedPersona],
      persona,
    );
    await until(() =>
      a.evaluate(
        "(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='내 변경 적용');if(!button)return false;button.click();return true;})()",
      ),
    );
    await until(
      async () =>
        (await settings()).personaIds[(await settings()).selectedPersona] ===
        originalPersona,
    );
    const captured = await runtime.store.call(
      "getResource",
      "persona",
      persona,
    );
    assert.equal(captured.payload.name, "Synthetic UI persona");
    assert.equal(captured.payload.personaPrompt, "Synthetic UI description");
    await b.evaluate(personaPage);
    await until(() =>
      b.evaluate(`!!document.querySelector('[data-persona-id="${persona}"]')`),
    );
    await click(b, `[data-persona-id="${persona}"]`);
    await until(
      async () => (await settings()).username === "Synthetic UI persona",
    );
    await until(() =>
      a.evaluate(
        ui(
          `r().model.database.personaPrompt==='Synthetic UI description'&&r().model.database.personas[r().model.database.selectedPersona]?.id==='${persona}'`,
        ),
      ),
    );
    await a.evaluate(
      `(async()=>{const {exportUserPersona}=await import('/src/ts/persona.ts');window.personaExportDone=false;void exportUserPersona(true).then(file=>{window.syntheticPersonaFile=file;window.personaExportDone=!!file?.data?.length;}).catch(error=>window.personaExportError=String(error));})()`,
    );
    await until(
      () =>
        a.evaluate(
          "({done:window.personaExportDone,error:window.personaExportError})",
        ),
      (value) => {
        if (value.error) throw Error(value.error);
        return value.done;
      },
    );
    await click(a, '[data-runtime-persona-action="delete"] button');
    await until(() =>
      a.evaluate(
        `[...document.querySelectorAll('h2')].some(element=>element.textContent==='Confirm')`,
      ),
    );
    await click(b, `[data-persona-id="${originalPersona}"]`);
    await until(
      async () =>
        (await settings()).personaIds[(await settings()).selectedPersona] ===
        originalPersona,
    );
    await clickText(a, "YES");
    await until(() =>
      a.evaluate(
        ui(
          "s.pending.some(entry=>entry.command.type==='delete-library-resource'&&entry.state==='blocked')",
        ),
      ),
    );
    assert.equal((await settings()).personaIds.length, 2);
    assert.equal(
      (await runtime.store.call("getResource", "persona", persona)).payload
        .name,
      "Synthetic UI persona",
    );
    await clickText(a, "요청 취소");
    await until(() =>
      a.evaluate(
        ui(
          "!s.pending.some(entry=>entry.command.type==='delete-library-resource')",
        ),
      ),
    );
    await click(a, `[data-persona-id="${persona}"]`);
    await until(
      async () =>
        (await settings()).personaIds[(await settings()).selectedPersona] ===
        persona,
    );
    await until(() =>
      a.evaluate(
        ui(
          `r().model.database.personas[r().model.database.selectedPersona]?.id==='${persona}'`,
        ),
      ),
    );
    await click(a, '[data-runtime-persona-action="delete"] button');
    await clickText(a, "YES");
    await until(async () => (await settings()).personaIds.length === 1);
    assert.equal(
      await runtime.store.call("getResource", "persona", persona),
      null,
    );
    await until(() =>
      b.evaluate(
        ui(
          `r().model.database.personas.length===1&&r().model.database.personas[0].id==='${originalPersona}'&&r().model.database.username===r().model.database.personas[0].name`,
        ),
      ),
    );
    await a.evaluate(presetList);
    await click(
      a,
      `[data-preset-id="${copied}"] [data-runtime-preset-action="delete"]`,
    );
    await clickText(a, "YES");
    await until(async () => (await settings()).presetIds.length === 3);
    assert.equal(
      (await settings()).presetIds[(await settings()).botPresetsId],
      created,
    );
    await click(
      a,
      `[data-preset-id="${created}"] [data-runtime-preset-action="delete"]`,
    );
    await clickText(a, "YES");
    await until(async () => (await settings()).presetIds.length === 2);
    assert.equal(
      (await settings()).presetIds[(await settings()).botPresetsId],
      originalPreset,
    );
    assert.equal((await settings()).temperature, 71);
    await until(() =>
      b.evaluate(
        ui(
          `r().model.database.botPresets.length===2&&r().model.database.botPresets[r().model.database.botPresetsId]?.id==='${originalPreset}'&&r().model.database.temperature===71`,
        ),
      ),
    );
    await a.evaluate(
      `(async()=>{const {importUserPersona}=await import('/src/ts/persona.ts');window.personaImportDone=false;void importUserPersona(window.syntheticPersonaFile).then(()=>window.personaImportDone=true).catch(error=>window.personaImportError=String(error));})()`,
    );
    await until(
      () =>
        a.evaluate(
          "({done:window.personaImportDone,error:window.personaImportError})",
        ),
      (value) => {
        if (value.error) throw Error(value.error);
        return value.done;
      },
    );
    await until(async () => (await settings()).personaIds.length === 2);
    const importedPersona = (await settings()).personaIds.find(
        (id) => id !== originalPersona,
      ),
      definition = (
        await runtime.store.call("getResource", "persona", importedPersona)
      ).payload;
    assert.equal(definition.name, "Synthetic UI persona");
    assert.equal(definition.personaPrompt, "Synthetic UI description");
    assert.notEqual(importedPersona, persona);
    assert.match(definition.icon, /^assets\/runtime\//);
    await clickText(a, "OK");
    const beforeImports = (
      await runtime.store.call("bootstrap")
    ).statistics.find((row) => row.settingsId === "global").imports;
    await a.evaluate(
      `(async()=>{const {importCharacterProcess,exportCharacterCard}=await import('/src/ts/characterCards.ts');const {PngChunk}=await import('/src/ts/pngChunk.ts');const {VirtualWriter}=await import('/src/ts/globalApi.svelte.ts');const {browserRuntime}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');const card={spec:'chara_card_v2',spec_version:'2.0',data:{name:'Synthetic asset card',description:'Synthetic neutral card description',first_mes:'Synthetic greeting',mes_example:'',scenario:'',system_prompt:'',post_history_instructions:'',alternate_greetings:[],tags:[],creator:'Synthetic',character_version:'1',extensions:{synthetic_unknown:{retained:true}}}};window.cardRoundtripDone=false;void(async()=>{const png=await PngChunk.write(window.syntheticPng,{chara:Buffer.from(JSON.stringify(card)).toString('base64')});await importCharacterProcess({name:'Synthetic-card.png',data:png});const first=browserRuntime().model.database.characters.find(value=>value.name===card.data.name);window.syntheticImportedCardId=first.chaId;const writer=new VirtualWriter();await exportCharacterCard(structuredClone(first),'png',{writer,spec:'v3'});if(!writer.buf.buffer.length)throw Error('Original card export produced no data');await importCharacterProcess({name:'Synthetic-roundtrip.png',data:writer.buf.buffer});window.cardRoundtripDone=true;})().catch(error=>window.cardRoundtripError=String(error));})()`,
    );
    await until(
      () =>
        a.evaluate(
          "({done:window.cardRoundtripDone,error:window.cardRoundtripError})",
        ),
      (value) => {
        if (value.error) throw Error(value.error);
        return value.done;
      },
    );
    await until(() =>
      b.evaluate(
        ui(
          `r().model.database.characters.filter(value=>value.name==='Synthetic asset card').length===2`,
        ),
      ),
    );
    const importedCards = (
      await runtime.store.call("bootstrap")
    ).characters.filter((value) => value.name === "Synthetic asset card");
    assert.equal(importedCards.length, 2);
    assert.equal(
      (await runtime.store.call("bootstrap")).statistics.find(
        (row) => row.settingsId === "global",
      ).imports,
      beforeImports + 2,
    );
    assert.notEqual(importedCards[0].id, importedCards[1].id);
    for (const card of importedCards) {
      const row = await runtime.store.call("getCharacter", card.id);
      assert.match(row.definition.image, /^assets\/runtime\//);
      assert.equal(row.definition.desc, "Synthetic neutral card description");
      assert.equal(row.definition.firstMessage, "Synthetic greeting");
      assert.equal(row.definition.extentions.synthetic_unknown.retained, true);
    }
    await a.evaluate(
      `(async()=>{const stores=await import('/src/ts/stores.svelte.ts');stores.openPresetList.set(false);stores.settingsOpen.set(false);})()`,
    );
    await until(() =>
      a.evaluate(`!!document.querySelector('textarea.input-text')`),
    );
    await a.evaluate(
      `(()=>{const input=document.querySelector('textarea.input-text');input.value='Synthetic unsent draft after card import';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await until(() =>
      a.evaluate(
        `document.querySelector('textarea.input-text')?.value==='Synthetic unsent draft after card import'`,
      ),
    );
    assert.deepEqual(await a.evaluate("window.runtimeUncaughtErrors"), []);
    assert.deepEqual(await b.evaluate("window.runtimeUncaughtErrors"), []);
    console.log(
      "Original preset/persona controls synchronize across two browsers with offline conflicts and deletion races. Shared persona images decode on both devices; original persona PNG and character PNG v2/v3 export/import retain synthetic content, unknown card extensions and new identities. Full assets/archive/file-picker/mobile/native-image capability acceptance remains required.",
    );
  },
);
