"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const { EntityStore } = require("../entity/store.cjs");
const { AssetStorage } = require("../runtime/assets.cjs");
const { readArchive } = require("../entity/archive.cjs");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Synthetic complete backup UI timeout: " + JSON.stringify(value));
}

test(
  "original dataset and full backup include unopened characters, all history and server-only PNG/WAV without hydrating browser DBState",
  { timeout: 150000 },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-full-backup-ui-"));
    let runtime, frontend, browser;
    t.after(async () => {
      await browser?.close();
      await frontend?.close();
      await runtime?.close();
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const origins = [];
    runtime = await createRuntimeService({
      file: join(root, "state.sqlite"),
      initialize: true,
      origins,
      eventsPollMs: 20,
    });
    const fields = (
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
    await runtime.store.call("applyCommand", "settings", {
      type: "change-fields",
      edits: fields.map((field) => ({
        ...field,
        expectedRevision: field.revision,
        expectedEpoch: field.entityEpoch,
        value: field.key === "language" ? "en" : true,
      })),
    });
    const authority = (await runtime.store.call("bootstrap")).serverId;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=",
      "base64",
    );
    const wav = Buffer.alloc(76);
    wav.write("RIFF");
    wav.writeUInt32LE(68, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(32, 40);
    const asset = async (body, extension) => {
      const response = await fetch(
        runtime.url + "/api/runtime/assets?extension=" + extension,
        {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "risu-runtime-id": authority,
          },
          body,
        },
      );
      assert.equal(response.status, 200);
      return await response.json();
    };
    const image = await asset(png, "png"),
      audio = await asset(wav, "wav");
    for (const id of ["a", "b"]) {
      await runtime.store.call("applyCommand", "character-" + id, {
        type: "create-character",
        characterId: id,
        definition: {
          name: "Synthetic " + id,
          type: "character",
          desc: "Synthetic unopened description " + id,
          firstMessage: "",
          image: image.path,
          globalLore: [{ key: "Synthetic", content: "Neutral" }],
          additionalAssets: [["synthetic-audio", audio.path, "wav"]],
          unknownExtension: { neutral: id },
        },
      });
    }
    for (const [id, characterId, count] of [
      ["a1", "a", 210],
      ["b1", "b", 1],
      ["b2", "b", 2],
    ]) {
      await runtime.store.call("applyCommand", "chat-" + id, {
        type: "create-chat",
        characterId,
        chatId: id,
        metadata: { name: "Synthetic " + id, unknownChat: { retained: true } },
        messages: Array.from({ length: count }, (_, i) => ({
          id: id + "-" + i,
          message: {
            role: i % 2 ? "char" : "user",
            data: "Synthetic neutral " + id + " " + i,
            chatId: id + "-" + i,
          },
        })),
      });
    }
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
    browser = await launchChromium(root);
    const page = await browser.page(url, await browser.newContext(), {
      viewport: { width: 1440, height: 900 },
      blockHttps: true,
    });
    await until(() =>
      page.evaluate(
        "!!document.querySelector('[data-runtime-ready=true]')&&!!document.querySelector('[data-character-id=a]')",
      ),
    );
    await page.evaluate(
      "document.querySelector('[data-character-id=a]').click()",
    );
    await until(() =>
      page.evaluate(
        "import('/src/ts/storage/database.svelte.ts').then(m=>m.getDatabase().characters.find(c=>c.chaId==='a')?.chats?.some(c=>c.message?.length===100))",
      ),
    );
    const peer = await browser.page(url, await browser.newContext(), {
      viewport: { width: 1440, height: 900 },
      blockHttps: true,
    });
    await until(() =>
      peer.evaluate(
        "!!document.querySelector('[data-runtime-ready=true]')&&!!document.querySelector('[data-character-id=b]')",
      ),
    );
    await peer.evaluate(
      "document.querySelector('[data-character-id=b]').click()",
    );
    await until(() =>
      peer.evaluate(
        "import('/src/ts/storage/database.svelte.ts').then(m=>m.getDatabase().characters.find(c=>c.chaId==='b')?.chats?.length===2)",
      ),
    );
    for (const p of [page, peer]) {
      await until(() =>
        p.evaluate("!!document.querySelector('textarea.input-text')"),
      );
      await p.evaluate(
        "(()=>{window.archiveInput=document.querySelector('textarea.input-text');window.archiveInput.value='Synthetic unsent draft';window.archiveInput.dispatchEvent(new Event('input',{bubbles:true}));})()",
      );
    }
    const peerBefore = await peer.evaluate(
      "import('/src/ts/storage/database.svelte.ts').then(m=>m.getDatabase().characters.map(c=>({id:c.chaId,desc:c.desc,chats:c.chats.map(t=>({id:t.id,count:t.message.length}))})))",
    );
    await page.evaluate(`(()=>{window.completeExportDone=false;window.completeExportError='';void(async()=>{
    const {getDatabase}=await import('/src/ts/storage/database.svelte.ts');
    const {LocalWriter}=await import('/src/ts/globalApi.svelte.ts');
    const {decodeRisuSave}=await import('/src/ts/storage/risuSave.ts');
    const shape=()=>getDatabase().characters.map(c=>({id:c.chaId,desc:c.desc,chats:c.chats.map(t=>({id:t.id,count:t.message.length}))}));
    const before=shape(),click=HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click=function(){if(this.download==='dataset.json'){window.datasetReady=fetch(this.href).then(r=>r.json()).then(v=>window.completeDataset=v);return;}return click.call(this);};
    try{await (await import('/src/ts/storage/exportAsDataset.ts')).exportAsDataset();await window.datasetReady;}finally{HTMLAnchorElement.prototype.click=click;}
    const init=LocalWriter.prototype.init, chunks=[];
    LocalWriter.prototype.init=async function(){this.writer=new WritableStream({write:chunk=>chunks.push(new Uint8Array(chunk)),close:()=>window.completeBackupClosed=true}).getWriter();return true;};
    try{await (await import('/src/ts/drive/backuplocal.ts')).SaveLocalBackup();}finally{LocalWriter.prototype.init=init;}
    const bytes=new Uint8Array(chunks.reduce((n,b)=>n+b.length,0));let at=0;for(const part of chunks){bytes.set(part,at);at+=part.length;}
    const entries=[];at=0;const view=new DataView(bytes.buffer);
    while(at<bytes.length){const nl=view.getUint32(at,true);at+=4;const name=new TextDecoder().decode(bytes.subarray(at,at+nl));at+=nl;const dl=view.getUint32(at,true);at+=4;const data=bytes.subarray(at,at+dl);at+=dl;entries.push({name,data});}
    const db=await decodeRisuSave(entries.find(e=>e.name==='database.risudat').data);
    window.completeExportObservation={before,after:shape(),dataset:window.completeDataset.map(d=>({name:d.name,description:d.description,count:d.chats.length})),backup:db.characters.map(c=>({id:c.chaId,unknown:c.unknownExtension,chats:c.chats.map(t=>({id:t.id,count:t.message.length,unknown:t.unknownChat}))})),entryNames:entries.map(e=>e.name),closed:window.completeBackupClosed};
    window.completeBackupBytes=Array.from(bytes);
  })().then(()=>window.completeExportDone=true).catch(e=>window.completeExportError=String(e.stack??e));})()`);
    const done = await until(
      () =>
        page.evaluate(
          "({done:window.completeExportDone,error:window.completeExportError})",
        ),
      (v) => v.done || v.error,
    );
    assert.equal(done.error, "");
    const result = await page.evaluate("window.completeExportObservation");
    console.log("complete-export-observation:", JSON.stringify(result));
    if (process.env.RISU_ARCHIVE_EXPORT_OBSERVATION)
      await fs.writeFile(
        process.env.RISU_ARCHIVE_EXPORT_OBSERVATION,
        JSON.stringify(result, null, 2) + "\n",
      );
    assert.deepEqual(
      {
        datasetCounts: result.dataset.map((d) => d.count),
        backupCounts: result.backup.flatMap((c) => c.chats.map((t) => t.count)),
        assets: result.entryNames
          .filter((n) => n !== "database.risudat")
          .sort(),
      },
      {
        datasetCounts: [210, 1, 2],
        backupCounts: [210, 1, 2],
        assets: [image.id, audio.id].sort(),
      },
    );
    assert.equal(
      result.dataset[1].description,
      "Synthetic unopened description b",
    );
    assert.deepEqual(result.before, result.after);
    assert.equal(result.closed, true);
    assert.deepEqual(result.backup[1].unknown, { neutral: "b" });
    assert.deepEqual(result.backup[1].chats[1].unknown, { retained: true });
    const peerAfter = await peer.evaluate(
      "import('/src/ts/storage/database.svelte.ts').then(m=>m.getDatabase().characters.map(c=>({id:c.chaId,desc:c.desc,chats:c.chats.map(t=>({id:t.id,count:t.message.length}))})))",
    );
    assert.deepEqual(peerAfter, peerBefore);
    for (const p of [page, peer])
      assert.equal(
        await p.evaluate(
          "window.archiveInput===document.querySelector('textarea.input-text')&&window.archiveInput.value==='Synthetic unsent draft'",
        ),
        true,
      );

    // Use bytes emitted by the real original writer, with the documented CLI.
    const bytes = Buffer.from(
      await page.evaluate("window.completeBackupBytes"),
    );
    const backupPath = join(root, "actual-original-ui.bin"),
      inventoryPath = join(root, "inventory.json"),
      restoredPath = join(root, "restored.sqlite");
    await fs.writeFile(backupPath, bytes);
    const { stdout: inventoryOutput } = await promisify(execFile)(
      process.execPath,
      ["server/runtime/inventoryBackup.cjs", backupPath, inventoryPath],
    );
    const inventoryReport = JSON.parse(inventoryOutput);
    const inventoryBytes = await fs.readFile(inventoryPath);
    assert.equal(inventoryReport.backupSha256, sha(bytes));
    assert.equal(inventoryReport.inventorySha256, sha(inventoryBytes));
    assert.equal(inventoryReport.contentsDecoded, false);
    assert.equal(inventoryReport.entries, 3);
    console.log(
      "complete-backup-cli-inventory:",
      JSON.stringify(inventoryReport),
    );
    const { stdout } = await promisify(execFile)(process.execPath, [
      "server/runtime/restoreBackup.cjs",
      backupPath,
      inventoryPath,
      restoredPath,
      sha(bytes),
      sha(inventoryBytes),
    ]);
    const report = JSON.parse(stdout.trim().split("\n").at(-1));
    assert.equal(report.restored, true);
    assert.equal(report.counts.messages, 213);
    assert.equal(report.counts.assets, 2);
    assert.deepEqual(report.remapped, {
      character: 0,
      chat: 0,
      message: 0,
      resource: 0,
    });
    const original = await (
      await fetch(runtime.url + "/api/runtime/archive", {
        headers: { "risu-runtime-id": authority },
      })
    ).json();
    const restored = new EntityStore(restoredPath);
    try {
      const archive = JSON.parse(readArchive(restored.db));
      delete original.database.account;
      assert.deepEqual(archive.database, original.database);
      assert.deepEqual(archive.assets, original.assets);
      const storage = new AssetStorage(
        restoredPath,
        { call: (method, ...args) => restored[method](...args) },
        archive.serverId,
      );
      assert.deepEqual(Buffer.from(await storage.read(image.path)), png);
      assert.deepEqual(Buffer.from(await storage.read(audio.path)), wav);
    } finally {
      restored.close();
    }
    console.log("complete-backup-cli-roundtrip:", JSON.stringify(report));

    // Corrupt the actual stored blob (same length); integrity must reject success.
    const blob = join(
      root,
      "state.sqlite.assets",
      authority,
      image.digest + ".blob",
    );
    const corrupt = Buffer.from(png);
    corrupt[corrupt.length - 1] ^= 1;
    await fs.writeFile(blob, corrupt);
    const failure = await page.evaluate(`(async()=>{
    const {LocalWriter}=await import('/src/ts/globalApi.svelte.ts');
    const stores=await import('/src/ts/stores.svelte.ts');
    const init=LocalWriter.prototype.init, chunks=[];let aborted=false,alert;
    const stop=stores.alertStore.subscribe(v=>alert=v);
    LocalWriter.prototype.init=async function(){this.writer=new WritableStream({write:chunk=>chunks.push(new Uint8Array(chunk)),abort:()=>aborted=true}).getWriter();return true;};
    try{await (await import('/src/ts/drive/backuplocal.ts')).SaveLocalBackup();return {aborted,alert,containsDatabase:new TextDecoder().decode(new Uint8Array(chunks.flatMap(c=>Array.from(c)))).includes('database.risudat')};}finally{LocalWriter.prototype.init=init;stop();}
  })()`);
    assert.equal(failure.aborted, true);
    assert.equal(failure.alert.type, "error");
    assert.match(failure.alert.msg, /checksum mismatch/);
    assert.equal(failure.containsDatabase, false);
    await fs.writeFile(blob, png);
    console.log(
      "complete-backup-corruption-rejected:",
      JSON.stringify(failure),
    );

    // Drive the existing two confirmations and the original partial entry point.
    await page.evaluate(`(()=>{window.partialDone=false;window.partialError='';void(async()=>{
    const {LocalWriter}=await import('/src/ts/globalApi.svelte.ts');const {decodeRisuSave}=await import('/src/ts/storage/risuSave.ts');
    const init=LocalWriter.prototype.init,chunks=[];
    LocalWriter.prototype.init=async function(){this.writer=new WritableStream({write:chunk=>chunks.push(new Uint8Array(chunk))}).getWriter();return true;};
    try{await (await import('/src/ts/drive/backuplocal.ts')).SavePartialLocalBackup();}finally{LocalWriter.prototype.init=init;}
    const bytes=new Uint8Array(chunks.flatMap(c=>Array.from(c))),view=new DataView(bytes.buffer),names=[];let at=0,db;
    while(at<bytes.length){const nl=view.getUint32(at,true);at+=4;const name=new TextDecoder().decode(bytes.subarray(at,at+nl));at+=nl;const dl=view.getUint32(at,true);at+=4;names.push(name);if(name==='database.risudat')db=await decodeRisuSave(bytes.subarray(at,at+dl));at+=dl;}
    window.partialObservation={names,counts:db.characters.flatMap(c=>c.chats.map(t=>t.message.length))};
  })().then(()=>window.partialDone=true).catch(e=>window.partialError=String(e.stack??e));})()`);
    for (let i = 0; i < 2; i++) {
      await until(() =>
        page.evaluate(
          "(async()=>{let alert;const stores=await import('/src/ts/stores.svelte.ts');const stop=stores.alertStore.subscribe(v=>alert=v);stop();return alert.type==='ask';})()",
        ),
      );
      await page.evaluate(
        "import('/src/ts/stores.svelte.ts').then(m=>m.alertStore.set({type:'none',msg:'yes'}))",
      );
      await delay(30);
    }
    const partialDone = await until(
      () =>
        page.evaluate("({done:window.partialDone,error:window.partialError})"),
      (v) => v.done || v.error,
    );
    assert.equal(partialDone.error, "");
    const partial = await page.evaluate("window.partialObservation");
    assert.deepEqual(partial.names, [image.id, "database.risudat"]);
    assert.deepEqual(partial.counts, [210, 1, 2]);
    console.log(
      "original-partial-backup-observation:",
      JSON.stringify(partial),
    );
    const pending = await page.evaluate(`(async()=>{
      const {browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');
      r().setField({scope:'resource',resourceKind:'settings',entityId:'global',key:'unknownArchiveFixture'},'Synthetic pending');
      try{await r().exportArchive();return 'unexpected-success';}catch(e){return e.message;}
    })()`);
    assert.match(pending, /pending changes/);
    await until(() =>
      page.evaluate(
        "(async()=>{const {browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');try{await r().exportArchive();return true;}catch(e){if(e.message.includes('pending changes'))return false;throw e;}})()",
      ),
    );
    const cancellation = await page.evaluate(`(async()=>{
      const {LocalWriter}=await import('/src/ts/globalApi.svelte.ts');const stores=await import('/src/ts/stores.svelte.ts');let alert;
      const init=LocalWriter.prototype.init,stop=stores.alertStore.subscribe(v=>alert=v);LocalWriter.prototype.init=async()=>false;
      try{await (await import('/src/ts/drive/backuplocal.ts')).SaveLocalBackup();return alert.type;}finally{LocalWriter.prototype.init=init;stop();}
    })()`);
    assert.equal(cancellation, "none");
    const target = {
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key: "archiveMissingFixture",
    };
    const field = (await runtime.store.call("readFields", [target])).fields[0];
    await runtime.store.call("applyCommand", "missing-fixture", {
      type: "change-fields",
      edits: [
        {
          ...target,
          expectedRevision: field.revision,
          expectedEpoch: field.entityEpoch,
          value: "Synthetic inline assets/runtime/" + "f".repeat(64) + ".wav",
        },
      ],
    });
    const missing = await page.evaluate(`(async()=>{
      const {LocalWriter}=await import('/src/ts/globalApi.svelte.ts');const stores=await import('/src/ts/stores.svelte.ts');let initialized=false,alert;
      const init=LocalWriter.prototype.init,stop=stores.alertStore.subscribe(v=>alert=v);LocalWriter.prototype.init=async()=>{initialized=true;return false;};
      try{await (await import('/src/ts/drive/backuplocal.ts')).SaveLocalBackup();return {initialized,alert};}finally{LocalWriter.prototype.init=init;stop();}
    })()`);
    assert.equal(missing.initialized, false);
    assert.equal(missing.alert.type, "error");
    assert.match(missing.alert.msg, /assets missing from server storage/);
    console.log(
      "complete-backup-pending-cancel-missing:",
      JSON.stringify({ pending, cancellation, missing }),
    );
  },
);
