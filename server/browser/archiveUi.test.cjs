"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
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
    await delay(50);
  } while (Date.now() < end);
  throw new Error("Synthetic archive timeout: " + JSON.stringify(value));
}

async function phase(page, body) {
  await page.evaluate(`(()=>{
    window.archiveDone=false;window.archiveError="";
    void(async()=>{${body}})().then(()=>window.archiveDone=true)
      .catch(error=>window.archiveError=String(error.stack??error));
  })()`);
  const result = await until(
    () =>
      page.evaluate("({done:window.archiveDone,error:window.archiveError})"),
    (value) => value.done || value.error,
  );
  assert.equal(result.error, "");
}

test(
  "original CharX and risum packages preserve shared media and reject incomplete assets",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-archive-ui-"));
    let runtime, frontend, browser;
    t.after(async () => {
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
      initialize: true,
      origins,
      eventsPollMs: 20,
    });
    const edits = (
      await runtime.store.call(
        "readFields",
        ["didFirstSetup", "language"].map((key) => ({
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key,
        })),
      )
    ).fields;
    await runtime.store.call("applyCommand", "archive-initial-settings", {
      type: "change-fields",
      edits: edits.map((field) => ({
        ...field,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: field.key === "language" ? "en" : true,
      })),
    });
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
        "(()=>{window.archiveUncaught=[];addEventListener('error',e=>window.archiveUncaught.push(String(e.error??e.message)));addEventListener('unhandledrejection',e=>window.archiveUncaught.push(String(e.reason)));})()",
      );
      return page;
    };
    const a = await open(),
      b = await open();

    await phase(
      a,
      `
    const {saveAsset}=await import('/src/ts/globalApi.svelte.ts');
    const {createBlankChar}=await import('/src/ts/characters.ts');
    const {compressImage,getImageType}=await import('/src/ts/media/index.ts');
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=24;
    const context=canvas.getContext('2d');context.fillStyle='#22c55e';context.fillRect(0,0,32,24);
    const png=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));
    const wav=new Uint8Array(44+1600);const view=new DataView(wav.buffer);
    const text=(offset,value)=>wav.set(new TextEncoder().encode(value),offset);
    text(0,'RIFF');view.setUint32(4,wav.length-8,true);text(8,'WAVE');text(12,'fmt ');
    view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,8000,true);view.setUint32(28,16000,true);view.setUint16(32,2,true);
    view.setUint16(34,16,true);text(36,'data');view.setUint32(40,1600,true);
    const originalEncodedImage=await compressImage(png);
    window.archiveMedia={png:Array.from(originalEncodedImage),wav:Array.from(wav),imageMime:getImageType(originalEncodedImage)==='WEBP'?'image/webp':'image/png'};
    const pngPath=await saveAsset(png,'','Synthetic.png'),wavPath=await saveAsset(wav,'','Synthetic.wav');
    const char=createBlankChar();char.name='Synthetic archive card';char.desc='Synthetic neutral description';char.firstMessage='Synthetic neutral greeting';
    char.image=pngPath;char.additionalAssets=[['합성 그림',pngPath,'png'],['합성 소리',wavPath,'wav']];
    char.extentions={...char.extentions,synthetic_unknown:{retained:true}};
    window.archiveSource=char;
    window.archiveModule={id:'synthetic-source-module',name:'Synthetic archive module',description:'Synthetic module description',assets:char.additionalAssets,regex:[{type:'editoutput',in:'BASE',out:'IMPORTED',ableFlag:false}],lorebook:[],trigger:[],synthetic_unknown:{retained:true}};
  `,
    );
    const media = await a.evaluate("window.archiveMedia");

    for (const format of ["charx", "charxJpeg"]) {
      await phase(
        a,
        `
      const {exportCharacterCard,importCharacterProcess}=await import('/src/ts/characterCards.ts');
      const {VirtualWriter}=await import('/src/ts/globalApi.svelte.ts');
      const {browserRuntime}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');
      const writer=new VirtualWriter();await exportCharacterCard(structuredClone(window.archiveSource),${JSON.stringify(format)},{writer,spec:'v3'});
      if(!writer.buf.buffer.length)throw Error('Empty original archive export');
      window.archivePackage=Array.from(writer.buf.buffer);
      const before=new Set(browserRuntime().model.database.characters.map(c=>c.chaId));
      await importCharacterProcess({name:${JSON.stringify(format === "charx" ? "Synthetic.charx" : "Synthetic.jpeg")},data:writer.buf.buffer});
      window.archiveImportedId=browserRuntime().model.database.characters.find(c=>!before.has(c.chaId))?.chaId;
    `,
      );
      const id = await a.evaluate("window.archiveImportedId");
      assert.ok(id);
      const row = await runtime.store.call("getCharacter", id);
      assert.equal(row.definition.desc, "Synthetic neutral description");
      assert.equal(row.definition.firstMessage, "Synthetic neutral greeting");
      assert.deepEqual(row.definition.extentions.synthetic_unknown, {
        retained: true,
      });
      assert.equal(row.definition.additionalAssets.length, 2);
      for (const [name, path, extension] of row.definition.additionalAssets) {
        assert.equal(name, extension === "wav" ? "합성 소리" : "합성 그림");
        assert.ok(
          path.endsWith("." + extension),
          "Original archive media extension must reach shared storage",
        );
        const metadata = await runtime.store.call(
          "getAsset",
          path.split("/").at(-1),
        );
        assert.equal(
          metadata.mime,
          extension === "wav" ? "audio/wav" : media.imageMime,
        );
        assert.deepEqual(
          Array.from(await runtime.assets.read(path)),
          media[extension],
        );
      }
      await until(() =>
        b.evaluate(
          `(async()=>{const {browserRuntime}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return browserRuntime().model.database.characters.some(c=>c.chaId===${JSON.stringify(id)})})()`,
        ),
      );
      const wav = row.definition.additionalAssets.find(
        (asset) => asset[2] === "wav",
      )[1];
      await phase(
        b,
        `
      const {getFileSrc,readImage}=await import('/src/ts/globalApi.svelte.ts');
      window.archiveReadback=Array.from(await readImage(${JSON.stringify(wav)}));
      const audio=document.createElement('audio');audio.preload='metadata';
      const loaded=new Promise((resolve,reject)=>{audio.onloadedmetadata=resolve;audio.onerror=()=>reject(Error('Shared WAV failed to decode'));});
      audio.src=await getFileSrc(${JSON.stringify(wav)});document.body.append(audio);await loaded;
      window.archiveAudioDuration=audio.duration;audio.remove();
    `,
      );
      assert.deepEqual(await b.evaluate("window.archiveReadback"), media.wav);
      assert.ok(
        Math.abs((await b.evaluate("window.archiveAudioDuration")) - 0.1) <
          0.005,
      );
    }

    await phase(
      a,
      `
    const {exportModuleLegacy,importModule}=await import('/src/ts/process/modules.ts');
    const packed=await exportModuleLegacy(window.archiveModule,{saveData:false,alertEnd:false});
    window.archiveRisum=Array.from(packed);await importModule({name:'Synthetic.risum',data:packed});
  `,
    );
    const moduleIds = (await runtime.store.call("bootstrap")).resources
      .filter((r) => r.kind === "module" && !r.deleted)
      .map((r) => r.id);
    assert.equal(moduleIds.length, 1);
    const moduleId = moduleIds[0];
    assert.ok(moduleId);
    const definition = (
      await runtime.store.call("getResource", "module", moduleId)
    ).payload;
    assert.deepEqual(definition.synthetic_unknown, { retained: true });
    assert.equal(definition.regex[0].out, "IMPORTED");
    for (const [name, path, extension] of definition.assets) {
      assert.equal(name, extension === "wav" ? "합성 소리" : "합성 그림");
      assert.ok(path.endsWith("." + extension));
      assert.deepEqual(
        Array.from(await runtime.assets.read(path)),
        media[extension],
      );
    }
    await b.evaluate(
      "(async()=>{const stores=await import('/src/ts/stores.svelte.ts');stores.SettingsMenuIndex.set(14);stores.settingsOpen.set(true);})()",
    );
    await until(() =>
      b.evaluate(`!!document.querySelector('[data-module-id="${moduleId}"]')`),
    );

    await phase(
      a,
      `
      const {exportModule,importModule}=await import('/src/ts/process/modules.ts');
      const {VirtualWriter}=await import('/src/ts/globalApi.svelte.ts');
      const writer=new VirtualWriter();
      await exportModule({...window.archiveModule,name:'Synthetic modern module',icon:window.archiveSource.image},{writer,alertEnd:false});
      if(!writer.buf.buffer.length)throw Error('Empty original module export');
      await importModule({name:'Synthetic-module.charx',data:writer.buf.buffer});
    `,
    );
    const modernId = (await runtime.store.call("bootstrap")).resources.find(
      (r) => r.kind === "module" && !r.deleted && r.id !== moduleId,
    ).id;
    const modern = (await runtime.store.call("getResource", "module", modernId))
      .payload;
    assert.equal(modern.name, "Synthetic modern module");
    assert.equal(modern.description, "Synthetic module description");
    assert.equal(modern.regex[0].out, "IMPORTED");
    assert.match(modern.icon, /^assets\/runtime\//);
    assert.equal(modern.assets.length, 2);
    for (const [, path, extension] of modern.assets) {
      assert.ok(path.endsWith("." + extension));
      assert.deepEqual(
        Array.from(await runtime.assets.read(path)),
        media[extension],
      );
    }
    assert.equal(
      (await runtime.store.call("bootstrap")).characters.length,
      2,
      "Module conversion must not install a temporary character",
    );
    await until(() =>
      b.evaluate(`!!document.querySelector('[data-module-id="${modernId}"]')`),
    );

    const before = (await runtime.store.call("bootstrap")).resources
      .filter((r) => r.kind === "module")
      .map((r) => r.id);
    await phase(
      a,
      `
    const {importModule}=await import('/src/ts/process/modules.ts');
    const {encodeRPack}=await import('/src/ts/rpack/rpack_js.js');
    const module={...window.archiveModule,name:'Incomplete synthetic module'};
    const main=await encodeRPack(Buffer.from(JSON.stringify({type:'risuModule',module})));
    const packed=new Uint8Array(7+main.length);packed[0]=111;packed[1]=0;
    new DataView(packed.buffer).setUint32(2,main.length,true);packed.set(main,6);packed[packed.length-1]=0;
    await importModule({name:'Incomplete.risum',data:packed});
    const {alertStore}=await import('/src/ts/stores.svelte.ts');let current;const unsubscribe=alertStore.subscribe(value=>current=value);unsubscribe();window.archiveRejectedAlert=current.type;
  `,
    );
    const after = (await runtime.store.call("bootstrap")).resources
      .filter((r) => r.kind === "module")
      .map((r) => r.id);
    assert.deepEqual(
      after,
      before,
      "Incomplete asset list must not install a canonical module",
    );
    assert.equal(await a.evaluate("window.archiveRejectedAlert"), "error");

    for (const invalid of ["truncated", "bad-magic", "trailing"]) {
      await phase(
        a,
        `
        const {importModule}=await import('/src/ts/process/modules.ts');
        const kind=${JSON.stringify(invalid)};
        let data=Uint8Array.from(window.archiveRisum);
        if(kind==='truncated')data=data.slice(0,10);
        else if(kind==='bad-magic')data=new Uint8Array([0]);
        else data=new Uint8Array([...data,4]);
        await importModule({name:'Invalid.risum',data});
      `,
      );
      assert.deepEqual(
        (await runtime.store.call("bootstrap")).resources
          .filter((r) => r.kind === "module")
          .map((r) => r.id),
        before,
      );
    }

    await phase(
      a,
      `
      const {createBaseV3,importCharacterProcess}=await import('/src/ts/characterCards.ts');
      const {CharXWriter}=await import('/src/ts/process/processzip.ts');
      const {VirtualWriter}=await import('/src/ts/globalApi.svelte.ts');
      const card=createBaseV3(structuredClone(window.archiveSource));
      card.data.assets=[{type:'icon',name:'main',ext:'png',uri:'embeded://assets/missing.png'}];
      window.archiveRejectCard=card;
      const writer=new VirtualWriter();const archive=new CharXWriter(writer);
      await archive.init();await archive.write('card.json',JSON.stringify(card));await archive.end();
      window.archiveMissingFileError='';
      try{await importCharacterProcess({name:'Missing.charx',data:writer.buf.buffer});}
      catch(error){window.archiveMissingFileError=String(error);}
    `,
    );
    assert.match(
      await a.evaluate("window.archiveMissingFileError"),
      /not found/,
    );
    assert.equal((await runtime.store.call("bootstrap")).characters.length, 2);
    for (const kind of ["invalid-deflate", "declared-oversize"]) {
      const card = await a.evaluate("window.archiveRejectCard");
      card.data.assets[0].uri = "embeded://assets/bad.png";
      const packed = zipSync({
        "card.json": [strToU8(JSON.stringify(card)), { level: 0 }],
        "assets/bad.png": [Uint8Array.from(media.png), { level: 6 }],
      });
      const view = new DataView(
        packed.buffer,
        packed.byteOffset,
        packed.byteLength,
      );
      let offset = 0;
      for (; offset < packed.length - 30; offset++) {
        if (view.getUint32(offset, true) !== 0x04034b50) continue;
        const length = view.getUint16(offset + 26, true);
        if (
          new TextDecoder().decode(
            packed.subarray(offset + 30, offset + 30 + length),
          ) === "assets/bad.png"
        )
          break;
      }
      assert.ok(offset < packed.length - 30);
      if (kind === "declared-oversize")
        view.setUint32(offset + 22, 50 * 1024 * 1024 + 1, true);
      else
        packed[
          offset +
            30 +
            view.getUint16(offset + 26, true) +
            view.getUint16(offset + 28, true)
        ] = 6;
      await phase(
        a,
        `
        const {importCharacterProcess}=await import('/src/ts/characterCards.ts');window.archiveCorruptError='';
        try{await importCharacterProcess({name:'Corrupt.charx',data:Uint8Array.from(${JSON.stringify(Array.from(packed))})});}
        catch(error){window.archiveCorruptError=String(error);}
      `,
      );
      assert.match(
        await a.evaluate("window.archiveCorruptError"),
        kind === "declared-oversize" ? /50 MiB/ : /invalid block type/,
      );
      assert.equal(
        (await runtime.store.call("bootstrap")).characters.length,
        2,
      );
    }
    let rejectedUploads = 0;
    const originalUpload = runtime.assets.upload;
    runtime.assets.upload = () => {
      rejectedUploads += 1;
      return Promise.reject(new Error("Synthetic asset upload unavailable"));
    };
    try {
      await phase(
        a,
        `
        const {importCharacterProcess}=await import('/src/ts/characterCards.ts');window.archiveUploadError='';
        try{await importCharacterProcess({name:'Unavailable.jpeg',data:Uint8Array.from(window.archivePackage)});}
        catch(error){window.archiveUploadError=String(error);}
      `,
      );
      assert.ok(
        rejectedUploads > 0,
        "Failure must reach the real HTTP upload route",
      );
      assert.match(
        await a.evaluate("window.archiveUploadError"),
        /failed|unavailable|error/i,
      );
      assert.equal(
        (await runtime.store.call("bootstrap")).characters.length,
        2,
      );
    } finally {
      runtime.assets.upload = originalUpload;
    }

    await phase(
      a,
      `
      const {importModule}=await import('/src/ts/process/modules.ts');
      const {encodeRPack}=await import('/src/ts/rpack/rpack_js.js');
      const module={id:'synthetic-empty-source',name:'Synthetic empty module',description:'',assets:null,synthetic_unknown:{retained:true}};
      const main=await encodeRPack(Buffer.from(JSON.stringify({type:'risuModule',module})));
      const packed=new Uint8Array(7+main.length);packed[0]=111;packed[1]=0;
      new DataView(packed.buffer).setUint32(2,main.length,true);packed.set(main,6);packed[packed.length-1]=0;
      await importModule({name:'Empty.risum',data:packed});
    `,
    );
    const empty = (await runtime.store.call("bootstrap")).resources.find(
      (r) => r.kind === "module" && !r.deleted && !before.includes(r.id),
    );
    assert.ok(empty);
    const emptyDefinition = (
      await runtime.store.call("getResource", "module", empty.id)
    ).payload;
    assert.equal(emptyDefinition.assets, null);
    assert.deepEqual(emptyDefinition.synthetic_unknown, { retained: true });
    assert.deepEqual(await a.evaluate("window.archiveUncaught"), []);
    assert.deepEqual(await b.evaluate("window.archiveUncaught"), []);
    t.diagnostic(
      "Original CharX/JPEG and legacy/modern module archives retain original encoded images, WAV bytes and Unicode names across two devices. Unknown character/legacy-module fields and nullable empty assets survive. Missing/truncated/trailing data, corrupt deflate, declared oversize and real HTTP upload failure reject canonical installation without uncaught errors. Full archive/history/native/mobile acceptance remains required.",
    );
  },
);
