"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
const { EntityStore } = require("../entity/store.cjs");
const {
  snapshotEnd,
} = require("../../src/ts/runtime/serverSnapshotProtocol.mjs");
const sha = (b) => createHash("sha256").update(b).digest("hex");

async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(30);
  } while (Date.now() < end);
  throw Error("Synthetic server snapshot UI timeout: " + JSON.stringify(value));
}
const shape =
  "import('/src/ts/storage/database.svelte.ts').then(m=>m.getDatabase().characters.map(c=>({id:c.chaId,desc:c.desc,chats:c.chats.map(t=>({id:t.id,count:t.message.length}))})))";

test(
  "actual Settings download restores jobs and alternatives through the CLI, preserves two partial browser projections, and rejects corrupted transfers and pending edits",
  { timeout: 180000 },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), "risu-snapshot-ui-")),
      file = join(root, "source.sqlite");
    const frontends = [],
      runtimes = [];
    let browser;
    t.after(async () => {
      await browser?.close();
      for (const f of frontends) await f.close();
      for (const r of runtimes) await r.close();
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const origins = [],
      runtime = await createRuntimeService({
        file,
        initialize: true,
        origins,
        eventsPollMs: 20,
      });
    runtimes.push(runtime);
    const call = (method, ...args) => runtime.store.call(method, ...args);
    const settings = (
      await call(
        "readFields",
        ["didFirstSetup", "language"].map((key) => ({
          scope: "resource",
          resourceKind: "settings",
          entityId: "global",
          key,
        })),
      )
    ).fields;
    await call("applyCommand", "settings", {
      type: "change-fields",
      edits: settings.map((f) => ({
        ...f,
        expectedRevision: f.revision,
        expectedEpoch: f.entityEpoch,
        value: f.key === "language" ? "en" : true,
      })),
    });
    const authority = (await call("bootstrap")).serverId;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=",
      "base64",
    );
    const image = await runtime.assets.upload([png], "png");
    await call("applyCommand", "extra-settings", {
      type: "put-resource",
      kind: "settings",
      resourceId: "auxiliary",
      expectedRevision: 0,
      payload: { unknown: "Synthetic complete state" },
    });
    for (const id of ["c", "other"])
      await call("applyCommand", "character-" + id, {
        type: "create-character",
        characterId: id,
        definition: {
          type: "character",
          name: "Synthetic " + id,
          desc: "Synthetic neutral " + id,
          firstMessage: "",
          image: image.path,
          unknown: { kept: true },
        },
        chat: {
          chatId: id === "c" ? "a" : "b",
          metadata: { name: "Synthetic history", localLore: [] },
          messages:
            id === "c"
              ? Array.from({ length: 120 }, (_, i) => ({
                  id: "history-" + i,
                  message: {
                    role: i % 2 ? "char" : "user",
                    data: "Synthetic history " + i,
                  },
                }))
              : [],
        },
      });
    await call("enqueueJob", "completed", {
      type: "send",
      chatId: "a",
      input: "Synthetic",
      messageId: "input",
    });
    let job = (await call("claimJob", "synthetic-worker")).job;
    const outcome = (job, messages, extra = {}) => ({
      chatId: job.chatId,
      expectedRevision: job.startedRevision,
      expectedContentRevision: job.startedContentRevision,
      characterReads: [
        { id: job.chatId === "a" ? "c" : "other", expectedEpoch: 0 },
      ],
      messages,
      ...extra,
    });
    await call("finishJob", job.id, job.owner, job.fence, {
      state: "completed",
      writeSet: outcome(job, [
        {
          id: "input",
          expectedRevision: 0,
          message: { role: "user", data: "Synthetic" },
        },
        {
          id: "reply",
          expectedRevision: 0,
          message: {
            role: "char",
            data: "Synthetic original reply",
            generationInfo: { generationId: "gen" },
          },
        },
      ]),
      result: {
        rerolls: {
          gen: ["Synthetic original reply", "Synthetic provider alternative"],
        },
      },
    });
    const first = (await call("snapshot", "a")).messages.at(-1);
    await call("enqueueJob", "regenerated", {
      type: "reroll",
      chatId: "a",
      messageId: first.id,
      expectedRevision: first.revision,
      expectedChatEpoch: 0,
    });
    job = (await call("claimJob", "synthetic-worker")).job;
    await call("finishJob", job.id, job.owner, job.fence, {
      state: "completed",
      writeSet: outcome(
        job,
        [
          {
            id: "replacement",
            expectedRevision: 0,
            message: {
              role: "char",
              data: "Synthetic regenerated reply",
              generationInfo: { generationId: "regen" },
            },
          },
        ],
        {
          deleteMessages: [{ id: first.id, expectedRevision: first.revision }],
        },
      ),
      result: {},
    });
    await call("enqueueJob", "failure", {
      type: "send",
      chatId: "b",
      input: "Synthetic",
      messageId: "failed-input",
    });
    job = (await call("claimJob", "synthetic-worker")).job;
    await call("writeJobProgress", job.id, job.owner, job.fence, {}, [
      {
        request: 1,
        mode: "model",
        type: "success",
        complete: true,
        candidates: [
          { key: "0", role: "char", data: "Synthetic provider result" },
        ],
      },
    ]);
    await call("finishJob", job.id, job.owner, job.fence, {
      state: "failed",
      result: {
        code: "SYNTHETIC_FAILURE",
        uncommitted: {
          writeSet: outcome(job, [
            {
              id: "failed-reply",
              expectedRevision: 0,
              message: {
                role: "char",
                data: "Synthetic retained complete reply",
              },
            },
          ]),
        },
      },
    });
    const failed = await call("getJob", "failure");
    assert.equal((await call("previewJobResult", "failure")).canRecover, true);

    const { createServer } = await import("vite");
    async function frontendFor(runtime, origins) {
      const frontend = await createServer({
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
          proxy: {
            "/api/runtime": { target: runtime.url, changeOrigin: true },
          },
        },
      });
      frontends.push(frontend);
      await frontend.listen();
      const url = "http://127.0.0.1:" + frontend.httpServer.address().port;
      origins.push(url);
      return url;
    }
    const url = await frontendFor(runtime, origins);
    browser = await launchChromium(root);
    async function open(url, id) {
      const page = await browser.page(url, await browser.newContext(), {
        viewport: { width: 1440, height: 900 },
        blockHttps: true,
      });
      await until(() =>
        page.evaluate(
          `!!document.querySelector('[data-runtime-ready=true]')&&!!document.querySelector('[data-character-id=${id}]')`,
        ),
      );
      await page.evaluate(
        `document.querySelector('[data-character-id=${id}]').click()`,
      );
      await until(() =>
        page.evaluate("!!document.querySelector('textarea.input-text')"),
      );
      return page;
    }
    const page = await open(url, "c"),
      peer = await open(url, "other");
    await until(() =>
      page.evaluate(
        "import('/src/ts/storage/database.svelte.ts').then(m=>m.getDatabase().characters.find(c=>c.chaId==='c')?.chats[0]?.message.length===100)",
      ),
    );
    for (const p of [page, peer])
      await p.evaluate(
        "(()=>{window.snapshotInput=document.querySelector('textarea.input-text');window.snapshotInput.value='Synthetic unsent draft';window.snapshotInput.dispatchEvent(new Event('input',{bubbles:true}));})()",
      );
    const before = await page.evaluate(shape),
      peerBefore = await peer.evaluate(shape);
    await page.evaluate(`(async()=>{
    const {LocalWriter}=await import('/src/ts/globalApi.svelte.ts');window.snapshotOriginalInit=LocalWriter.prototype.init;
    window.snapshotWriteObservation={chunks:[],closed:false,aborted:false};
    LocalWriter.prototype.init=async function(name,extensions){window.snapshotWriteObservation.name=name;window.snapshotWriteObservation.extensions=extensions;
      this.writer=new WritableStream({write:chunk=>window.snapshotWriteObservation.chunks.push(Array.from(chunk)),close:()=>window.snapshotWriteObservation.closed=true,abort:()=>window.snapshotWriteObservation.aborted=true}).getWriter();return true;};
    const stores=await import('/src/ts/stores.svelte.ts');window.snapshotStopAlert=stores.alertStore.subscribe(v=>window.snapshotAlert=v);stores.SettingsMenuIndex.set(0);stores.settingsOpen.set(true);
  })()`);
    await until(() =>
      page.evaluate(
        "!!document.querySelector('[data-runtime-server-backup] button')",
      ),
    );
    await page.evaluate(
      "document.querySelector('[data-runtime-server-backup] button').click()",
    );
    await until(() =>
      page.evaluate(
        "window.snapshotWriteObservation.closed||window.snapshotWriteObservation.aborted",
      ),
    );
    const observation = await page.evaluate(
      "({name:window.snapshotWriteObservation.name,extensions:window.snapshotWriteObservation.extensions,closed:window.snapshotWriteObservation.closed,aborted:window.snapshotWriteObservation.aborted,alert:window.snapshotAlert})",
    );
    assert.equal(observation.closed, true);
    assert.equal(observation.aborted, false);
    assert.equal(observation.alert.type, "normal");
    assert.deepEqual(observation.extensions, ["risusnapshot"]);
    const bytes = Buffer.from(
      await page.evaluate("window.snapshotWriteObservation.chunks.flat()"),
    );
    assert.ok(bytes.subarray(-8).equals(Buffer.from(snapshotEnd)));
    assert.deepEqual(await page.evaluate(shape), before);
    assert.deepEqual(await peer.evaluate(shape), peerBefore);
    assert.equal(
      await peer.evaluate(
        "window.snapshotInput===document.querySelector('textarea.input-text')&&window.snapshotInput.value==='Synthetic unsent draft'",
      ),
      true,
    );
    await page.evaluate(
      "import('/src/ts/stores.svelte.ts').then(m=>{m.settingsOpen.set(false);m.alertStore.set({type:'none',msg:''});})",
    );
    // Original settings navigation unmounts the chat. Separately test the same export
    // action while both chat screens remain mounted; navigation is not export churn.
    await until(() =>
      page.evaluate("!!document.querySelector('textarea.input-text')"),
    );
    await page.evaluate(
      "(()=>{window.snapshotInput=document.querySelector('textarea.input-text');window.snapshotInput.value='Synthetic unsent draft';window.snapshotInput.dispatchEvent(new Event('input',{bubbles:true}));})()",
    );
    await page.evaluate(
      "import('/src/ts/drive/serverSnapshotBackup.ts').then(m=>m.saveServerSnapshotBackup())",
    );
    for (const p of [page, peer])
      assert.equal(
        await p.evaluate(
          "window.snapshotInput===document.querySelector('textarea.input-text')&&window.snapshotInput.value==='Synthetic unsent draft'",
        ),
        true,
      );

    const backup = join(root, "actual-settings.risusnapshot"),
      restoredFile = join(root, "restored.sqlite");
    await fs.writeFile(backup, bytes);
    const { stdout } = await promisify(execFile)(process.execPath, [
      "server/runtime/restoreServerSnapshot.cjs",
      backup,
      restoredFile,
      sha(bytes),
    ]);
    const report = JSON.parse(stdout.trim());
    assert.equal(report.untouchedDataIdentical, true);
    assert.notEqual(report.serverId, authority);
    assert.equal(report.assetBlobs, 1);
    assert.equal(report.automaticExternalReplay, false);
    const restored = new EntityStore(restoredFile);
    try {
      assert.deepEqual(restored.getJob("failure"), failed);
      assert.equal(restored.previewJobResult("failure").canRecover, true);
      assert.equal(
        restored.getResource("settings", "auxiliary").payload.unknown,
        "Synthetic complete state",
      );
      assert.ok(
        restored.db.prepare("SELECT COUNT(*) AS count FROM reply_choices").get()
          .count >= 2,
      );
      assert.equal(
        restored.db.prepare("SELECT COUNT(*) AS count FROM reply_batches").get()
          .count,
        2,
      );
    } finally {
      restored.close();
    }
    const restoredOrigins = [],
      restoredRuntime = await createRuntimeService({
        file: restoredFile,
        origins: restoredOrigins,
        eventsPollMs: 20,
      });
    runtimes.push(restoredRuntime);
    const restoredUrl = await frontendFor(restoredRuntime, restoredOrigins),
      restoredPage = await open(restoredUrl, "other");
    await until(() =>
      restoredPage.evaluate(
        "!!document.querySelector('[data-runtime-result=failure]')",
      ),
    );
    await restoredPage.evaluate(
      "document.querySelector('[data-runtime-failed-jobs]').open=true;document.querySelector('[data-runtime-result=failure]').click()",
    );
    await until(() =>
      restoredPage.evaluate(
        "!!document.querySelector('[data-runtime-recover]')",
      ),
    );
    assert.equal(
      await restoredPage.evaluate(
        "document.querySelector('[data-runtime-result-review] textarea').value",
      ),
      "Synthetic retained complete reply",
    );
    assert.equal(
      (await restoredRuntime.store.call("getJob", "failure")).state,
      "failed",
    );
    const restoredChoice = (
      await restoredRuntime.store.call("snapshot", "a")
    ).messages.at(-1);
    const choice = await restoredRuntime.store.call(
      "readReplyChoices",
      "a",
      restoredChoice.id,
      restoredChoice.revision,
      0,
    );
    assert.equal(choice.batch.count, 2);
    await restoredRuntime.store.call("applyCommand", "restored-choice", {
      type: "move-reply-choice",
      ...choice.target,
      direction: "previous",
    });
    assert.equal(
      (await restoredRuntime.store.call("snapshot", "a")).messages.at(-1)
        .message.data,
      "Synthetic original reply",
    );

    // The real downloaded body can be HTTP 200 yet incomplete; validation must abort the writer.
    const blob = join(file + ".assets", authority, image.digest + ".blob"),
      corrupt = Buffer.from(png);
    corrupt[0] ^= 1;
    await fs.writeFile(blob, corrupt);
    const failure = await page.evaluate(`(async()=>{
    const {saveServerSnapshotBackup}=await import('/src/ts/drive/serverSnapshotBackup.ts');window.snapshotWriteObservation={chunks:[],closed:false,aborted:false};
    await saveServerSnapshotBackup();return {closed:window.snapshotWriteObservation.closed,aborted:window.snapshotWriteObservation.aborted,alert:window.snapshotAlert};
  })()`);
    assert.equal(failure.closed, false);
    assert.equal(failure.aborted, true);
    assert.equal(failure.alert.type, "error");
    assert.match(failure.alert.msg, /checksum|incomplete/);
    await fs.writeFile(blob, png);
    const pending = await page.evaluate(`(async()=>{
    const {browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');r().setField({scope:'resource',resourceKind:'settings',entityId:'global',key:'syntheticSnapshotPending'},'Synthetic pending');
    let writes=0;try{await r().exportServerSnapshot(async()=>{writes++;});return {error:'unexpected-success',writes};}catch(e){return {error:e.message,writes};}
  })()`);
    assert.match(pending.error, /pending changes/);
    assert.equal(pending.writes, 0);
    const cancelled = await page.evaluate(`(async()=>{
    const {LocalWriter}=await import('/src/ts/globalApi.svelte.ts');LocalWriter.prototype.init=async()=>false;
    try{await (await import('/src/ts/drive/serverSnapshotBackup.ts')).saveServerSnapshotBackup();return window.snapshotAlert.type;}finally{LocalWriter.prototype.init=window.snapshotOriginalInit;window.snapshotStopAlert();}
  })()`);
    assert.equal(cancelled, "none");
    const evidence = {
      observation: { ...observation, alert: { type: observation.alert.type } },
      bytes: bytes.length,
      backupSha256: sha(bytes),
      report,
      browserProjectionsPreserved: true,
      inputNodesPreserved: true,
      restoredResultReview: true,
      restoredBatchSelection: true,
      corruption: failure,
      pending,
      cancelled,
    };
    console.log("server-snapshot-ui-observation:", JSON.stringify(evidence));
    if (process.env.RISU_SERVER_SNAPSHOT_OBSERVATION)
      await fs.writeFile(
        process.env.RISU_SERVER_SNAPSHOT_OBSERVATION,
        JSON.stringify(evidence, null, 2) + "\n",
      );
  },
);
