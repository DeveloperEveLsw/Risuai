"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { createRuntimeService } = require("../runtime/service.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (predicate(last)) return last;
    await delay(50);
  } while (Date.now() < end);
  throw new Error("Synthetic lifecycle UI timed out: " + JSON.stringify(last));
}
const ui = (body) =>
  `(async()=>{const {RuntimeUIState:s,browserRuntime:r}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${body}})()`;
async function clickLabel(page, key) {
  await until(() =>
    page.evaluate(
      `(async()=>{const {language}=await import('/src/lang/index.ts');const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(key)}.split(".").reduce((value,key)=>value[key],language));if(!button)return false;button.click();return true;})()`,
    ),
  );
}
async function input(page, id, value) {
  await until(() =>
    page.evaluate(`!!document.getElementById(${JSON.stringify(id)})`),
  );
  await page.evaluate(
    `(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
}

test(
  "empty local database: original character/chat UI, full clone, two-device deletion and persistent native generation",
  { timeout: 180000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "risu-lifecycle-ui-"));
    let runtime,
      frontend,
      browser,
      provider,
      calls = 0;
    t.after(async () => {
      if (browser) await browser.close();
      if (frontend) await frontend.close();
      if (runtime) await runtime.close();
      if (provider) {
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
      }
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    provider = createServer(async (req, res) => {
      for await (const _chunk of req) {
      }
      calls++;
      res.setHeader("content-type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [{ delta: { content: "Synthetic lifecycle reply" } }],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const origins = [];
    runtime = await createRuntimeService({
      file: join(directory, "state.sqlite"),
      initialize: true,
      origins,
      eventsPollMs: 20,
      scheduler: { pollMs: 20 },
    });
    assert.equal((await runtime.store.call("bootstrap")).characters.length, 0);
    const defaults = await runtime.store.call(
      "getResource",
      "settings",
      "global",
    );
    assert.ok(defaults);
    assert.ok(
      (await runtime.store.call("bootstrap")).resources.some(
        (r) => r.kind === "preset",
      ),
    );
    const values = {
      language: "en",
      aiModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-lifecycle",
      customAPIFormat: 0,
      reverseProxyOobaMode: false,
      forceReplaceUrl:
        "http://127.0.0.1:" + provider.address().port + "/v1/chat/completions",
      proxyKey: "synthetic-lifecycle-key",
      useStreaming: true,
      customTokenizer: "tik",
      sendWithEnter: true,
      autoTranslate: false,
    };
    const targets = Object.keys(values).map((key) => ({
      scope: "resource",
      resourceKind: "settings",
      entityId: "global",
      key,
    }));
    const configure = async () => {
      const fields = (await runtime.store.call("readFields", targets)).fields;
      await runtime.store.call("applyCommand", "synthetic-settings", {
        type: "change-fields",
        edits: fields.map((f) => ({
          scope: f.scope,
          resourceKind: f.resourceKind,
          entityId: f.entityId,
          key: f.key,
          expectedRevision: f.revision,
          expectedEpoch: f.entityEpoch,
          value: values[f.key],
        })),
      });
    };
    const { createServer: createViteServer } = await import("vite");
    frontend = await createViteServer({
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
      const p = await browser.page(url, await browser.newContext(), {
        viewport: { width: 1440, height: 900 },
        blockHttps: true,
      });
      await until(
        () =>
          p.evaluate(
            "!!document.querySelector('[data-runtime-ready=\"true\"]')",
          ),
        Boolean,
        90000,
      );
      return p;
    };
    const a = await open(),
      b = await open();
    await until(() =>
      a.evaluate("!!document.querySelector('textarea.input-text')"),
    );
    await a.evaluate(
      "(()=>{const input=document.querySelector('textarea.input-text');input.value='Synthetic setup user';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
    );
    await clickLabel(a, "setup.setupMessageOption2");
    await until(() =>
      a.evaluate(ui("r().model.database.didFirstSetup&&!s.pending.length")),
    );
    assert.equal(
      (await runtime.store.call("getResource", "settings", "global")).payload
        .username,
      "Synthetic setup user",
    );
    await configure();
    await until(() =>
      a.evaluate(ui("r().model.database.aiModel==='reverse_proxy'")),
    );
    await until(() =>
      a.evaluate(
        `(async()=>{const{language}=await import('/src/lang/index.ts');const button=document.querySelector('button[aria-label="'+language.addCharacter+'"]');if(!button)return false;button.click();return true;})()`,
      ),
    );
    await clickLabel(a, "createfromScratch");
    await until(() => a.evaluate(ui("s.scopeReady")));
    const created = (await runtime.store.call("bootstrap")).characters;
    assert.equal(created.length, 1);
    const id = created[0].id;
    const first = (await runtime.store.call("listChats", id))[0].id;
    await until(() =>
      b.evaluate(`!!document.querySelector('[data-character-id="${id}"]')`),
    );
    await b.evaluate(
      `document.querySelector('[data-character-id="${id}"]').click()`,
    );
    await until(() => b.evaluate(ui("s.scopeReady")));
    await clickLabel(a, "character");
    await input(a, "runtime-character-name", "Synthetic created through UI");
    await input(
      a,
      "runtime-character-description",
      "Synthetic description edited through UI",
    );
    await input(
      a,
      "runtime-character-greeting",
      "Synthetic greeting edited through UI",
    );
    await until(async () => {
      const c = await runtime.store.call("getCharacter", id);
      return (
        c.definition.name === "Synthetic created through UI" &&
        c.definition.desc === "Synthetic description edited through UI" &&
        c.definition.firstMessage === "Synthetic greeting edited through UI"
      );
    });
    await until(() =>
      b.evaluate(
        ui(
          `r().model.database.characters.find(c=>c.chaId==='${id}').name==='Synthetic created through UI'`,
        ),
      ),
    );
    const modulePage = (open = true) =>
      `(async()=>{const stores=await import('/src/ts/stores.svelte.ts');stores.SettingsMenuIndex.set(14);stores.settingsOpen.set(${open});})()`;
    const moduleAction = (id, key) =>
      `(async()=>{const{language}=await import('/src/lang/index.ts');const button=document.querySelector('[data-module-id="${id}"] button[aria-label="'+language.${key}+'"]');if(!button)return false;button.click();return true;})()`;
    await a.evaluate(modulePage());
    await b.evaluate(modulePage());
    await until(() =>
      a.evaluate(
        `(async()=>{const{language}=await import('/src/lang/index.ts');const button=document.querySelector('button[aria-label="'+language.createModule+'"]');if(!button)return false;button.click();return true;})()`,
      ),
    );
    await input(a, "runtime-module-name", "Synthetic UI module");
    await input(a, "runtime-module-description", "Synthetic isolated draft");
    assert.equal(
      (await runtime.store.call("bootstrap")).resources.filter(
        (r) => r.kind === "module" && !r.deleted,
      ).length,
      0,
    );
    await clickLabel(a, "createModule");
    await until(async () =>
      (await runtime.store.call("bootstrap")).resources.some(
        (r) => r.kind === "module" && !r.deleted,
      ),
    );
    const moduleId = (await runtime.store.call("bootstrap")).resources.find(
      (r) => r.kind === "module" && !r.deleted,
    ).id;
    await until(() =>
      b.evaluate(`!!document.querySelector('[data-module-id="${moduleId}"]')`),
    );
    await until(() => a.evaluate(moduleAction(moduleId, "edit")));
    await until(() => b.evaluate(moduleAction(moduleId, "edit")));
    await input(a, "runtime-module-name", "Synthetic UI module edited");
    await input(b, "runtime-module-description", "Synthetic conflicting draft");
    assert.equal(
      (await runtime.store.call("getResource", "module", moduleId)).payload
        .name,
      "Synthetic UI module",
    );
    await clickLabel(a, "editModule");
    await until(
      async () =>
        (await runtime.store.call("getResource", "module", moduleId)).payload
          .name === "Synthetic UI module edited",
    );
    await clickLabel(b, "editModule");
    await until(() =>
      b.evaluate(
        ui(
          "s.pending.some(e=>e.command.type==='save-library-resource'&&e.state==='blocked')",
        ),
      ),
    );
    assert.equal(
      (await runtime.store.call("getResource", "module", moduleId)).payload
        .description,
      "Synthetic isolated draft",
    );
    await until(() =>
      b.evaluate(
        "(()=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='요청 취소');if(!button)return false;button.click();return true;})()",
      ),
    );
    await until(() =>
      b.evaluate(
        ui("!s.pending.some(e=>e.command.type==='save-library-resource')"),
      ),
    );
    await b.evaluate(modulePage(false));
    const imported = {
      type: "risuModule",
      id: "synthetic-file-id",
      name: "Synthetic output transform",
      description: "Synthetic JSON import",
      unknown: { retained: true },
      regex: [
        {
          comment: "Synthetic output regex",
          in: "Synthetic lifecycle reply",
          out: "Synthetic module reply",
          type: "editoutput",
        },
      ],
    };
    await a.evaluate(
      `(async()=>{const{importModule}=await import('/src/ts/process/modules.ts');await importModule({name:'Synthetic.json',data:new TextEncoder().encode(${JSON.stringify(JSON.stringify(imported))})});})()`,
    );
    const importedId = (await runtime.store.call("bootstrap")).resources
      .filter((r) => r.kind === "module" && !r.deleted)
      .find((r) => r.id !== moduleId).id;
    assert.notEqual(importedId, imported.id);
    assert.deepEqual(
      (await runtime.store.call("getResource", "module", importedId)).payload
        .unknown,
      { retained: true },
    );
    await until(() =>
      a.evaluate(
        `!!document.querySelector('[data-module-id="${importedId}"]')`,
      ),
    );
    await until(() => a.evaluate(moduleAction(importedId, "enableGlobal")));
    await until(async () =>
      (
        await runtime.store.call("getResource", "settings", "global")
      ).payload.enabledModules.includes(importedId),
    );
    await until(() =>
      b.evaluate(
        ui(`r().model.database.enabledModules.includes('${importedId}')`),
      ),
    );
    await a.evaluate(modulePage(false));
    await clickLabel(a, "Chat");
    await a.evaluate(
      "(()=>{const input=document.querySelector('textarea.input-text');input.value='Synthetic lifecycle input';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
    );
    await until(async () => {
      const saved = (await runtime.store.call("snapshot", first)).messages.some(
        (m) => m.message.data === "Synthetic module reply",
      );
      if (
        !saved &&
        (await runtime.store.call("listJobs", first)).some((j) =>
          ["failed", "interrupted", "cancelled"].includes(j.state),
        )
      )
        throw new Error(
          "Synthetic native UI failure: " +
            (await a.evaluate(
              ui(
                "JSON.stringify({error:s.error,pending:s.pending.map(e=>({type:e.command.type,state:e.state,error:e.error})),jobs:s.jobs.map(j=>({state:j.state,result:j.result})),aiModel:r().model.database.aiModel,apiType:r().model.database.apiType,model:r().model.database.customProxyRequestModel,scopeReady:s.scopeReady})",
              ),
            )),
        );
      return saved;
    });
    assert.equal(calls, 1);
    await until(() =>
      a.evaluate(ui("!s.jobs.some(j=>['queued','running'].includes(j.state))")),
    );
    await a.evaluate(modulePage());
    for (const resourceId of [moduleId, importedId]) {
      await until(() =>
        a.evaluate(
          `!!document.querySelector('[data-module-id="${resourceId}"]')`,
        ),
      );
      await until(() => a.evaluate(moduleAction(resourceId, "remove")));
      await until(() =>
        a.evaluate(
          "(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='YES');if(!button)return false;button.click();return true;})()",
        ),
      );
      await until(
        async () =>
          !(await runtime.store.call("getResource", "module", resourceId)),
      );
    }
    await until(() =>
      b.evaluate(
        ui(
          "r().model.database.modules.length===0&&r().model.database.enabledModules.length===0",
        ),
      ),
    );
    assert.deepEqual(
      (await runtime.store.call("getResource", "settings", "global")).payload
        .moduleIds,
      [],
    );
    await a.evaluate(modulePage(false));
    for (let i = 0; i < 110; i++)
      await runtime.store.call("applyCommand", "synthetic-history-" + i, {
        type: "append-message",
        chatId: first,
        messageId: "history-" + i,
        message: {
          role: "char",
          data: "Synthetic archived " + i,
          unknown: { retained: i },
        },
      });
    await clickLabel(a, "newChat");
    await until(
      async () => (await runtime.store.call("listChats", id)).length === 2,
    );
    await until(() =>
      a.evaluate(ui(`s.scopeReady&&r().model.activeChatId!=='${first}'`)),
    );
    await a.evaluate(
      `document.querySelector('[data-chat-id="${first}"]').click()`,
    );
    await until(() =>
      a.evaluate(ui(`s.scopeReady&&r().model.activeChatId==='${first}'`)),
    );
    assert.equal(
      await a.evaluate(ui("r().model.activeChat.message.length")),
      100,
    );
    const total = (await runtime.store.call("snapshot", first, { limit: 1000 }))
      .messages.length;
    assert.ok(total > 100);
    await a.evaluate(
      `document.querySelector('[data-chat-id="${first}"] [role=button]').click()`,
    );
    await clickLabel(a, "createCopy");
    await until(
      async () => (await runtime.store.call("listChats", id)).length === 3,
    );
    await until(() =>
      a.evaluate(ui(`s.scopeReady&&r().model.activeChatId!=='${first}'`)),
    );
    const copyId = await a.evaluate(ui("r().model.activeChatId"));
    const copy = await runtime.store.call("snapshot", copyId, { limit: 1000 });
    assert.equal(copy.messages.length, total);
    assert.deepEqual(copy.messages.at(-1).message.unknown, { retained: 109 });
    await until(() =>
      b.evaluate(
        ui(
          `r().model.database.characters.find(c=>c.chaId==='${id}').chats.length===3`,
        ),
      ),
    );
    await a.evaluate(
      `document.querySelector('[data-chat-id="${copyId}"]').querySelectorAll('[role=button]')[3].click()`,
    );
    await until(() =>
      a.evaluate(
        "(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='YES');if(!button)return false;button.click();return true;})()",
      ),
    );
    await until(
      async () => (await runtime.store.call("listChats", id)).length === 2,
    );
    await until(() =>
      a.evaluate(ui(`s.scopeReady&&r().model.activeChatId!=='${copyId}'`)),
    );
    await until(() =>
      b.evaluate(
        ui(
          `r().model.database.characters.find(c=>c.chaId==='${id}').chats.length===2`,
        ),
      ),
    );
    assert.equal(await b.evaluate(ui("r().model.activeChatId")), first);
    const removing = a.evaluate(
      `(async()=>{const{removeChar}=await import('/src/ts/characters.ts');await removeChar('${id}','Synthetic','normal');})()`,
    );
    for (let i = 0; i < 2; i++)
      await until(() =>
        a.evaluate(
          "(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='YES');if(!button)return false;button.click();return true;})()",
        ),
      );
    await removing;
    await until(async () =>
      Boolean((await runtime.store.call("bootstrap")).characters[0].trashTime),
    );
    assert.equal(
      await a.evaluate(
        ui(
          "r().model.activeChatId===null&&s.messages.length===0&&!s.scopeReady",
        ),
      ),
      true,
    );
    await until(() =>
      b.evaluate(
        ui(
          `!!r().model.database.characters.find(c=>c.chaId==='${id}').trashTime`,
        ),
      ),
    );
    await a.evaluate(ui(`r().restoreCharacter('${id}')`));
    await until(
      async () =>
        (await runtime.store.call("bootstrap")).characters[0].trashTime ===
        null,
    );
    await until(() =>
      b.evaluate(
        ui(
          `!r().model.database.characters.find(c=>c.chaId==='${id}').trashTime`,
        ),
      ),
    );
    assert.equal((await runtime.store.call("listChats", id)).length, 2);
    const savedJobId = (await runtime.store.call("listJobs", first))[0].id;
    await a.evaluate(
      `(async()=>{const{removeChar}=await import('/src/ts/characters.ts');await removeChar('${id}','Synthetic','permanentForce');})()`,
    );
    await until(
      async () =>
        (await runtime.store.call("bootstrap")).characters.length === 0,
    );
    await until(() =>
      b.evaluate(ui("r().model.database.characters.length===0&&!s.scopeReady")),
    );
    assert.equal(
      (
        await runtime.store
          .call("listJobs", first)
          .catch((e) => ({ code: e.code }))
      ).code,
      "NOT_FOUND",
    );
    assert.equal(
      (await runtime.store.call("getJob", savedJobId)).state,
      "completed",
    );
    assert.equal(calls, 1);
    console.log(
      "Empty-db original UI created/edited characters and module drafts; conflicting module edits stayed rejected; original JSON import and global enable fed native output regex; module deletion synchronized; full chat copy/delete/trash/restore retained terminal history.",
    );
  },
);
