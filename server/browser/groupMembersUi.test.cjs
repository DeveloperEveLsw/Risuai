"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { EntityStore } = require("../entity/store.cjs");
const { createRuntimeService } = require("../runtime/service.cjs");
const { createProductionService } = require("../runtime/production.cjs");
const { launchChromium } = require("./chromium.cjs");
async function until(read, predicate = Boolean) {
  const end = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(25);
  } while (Date.now() < end);
  throw Error("Synthetic group member UI timeout: " + JSON.stringify(value));
}
const ui = (body) =>
  `(async()=>{const {browserRuntime:r,RuntimeUIState:s}=await import('/src/ts/runtime/browserRuntimeState.svelte.ts');return ${body}})()`;
async function click(page, selector) {
  await until(() =>
    page.evaluate(
      `(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)return false;b.click();return true;})()`,
    ),
  );
}
async function textButton(page, text) {
  await until(() =>
    page.evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true;})()`,
    ),
  );
}
for (const built of [false, true])
  test(
    `${built ? "built authenticated" : "development"} original group member controls merge, fence dialog ownership and replay after all tabs close`,
    {
      timeout: 180000,
      skip: built && !process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
    },
    async (t) => {
      const directory = await fs.mkdtemp(
          join(tmpdir(), "risu-group-members-ui-"),
        ),
        file = join(directory, "entity.sqlite");
      let runtime,
        service,
        frontend,
        browser,
        release,
        hold = false,
        held = 0;
      const errors = [],
        observed = [],
        origins = [];
      t.after(async () => {
        release?.();
        await browser?.close();
        await frontend?.close();
        await (service ?? runtime)?.close();
        await fs.rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      });
      const store = new EntityStore(file);
      store.initializeState({
        settings: {
          didFirstSetup: true,
          language: "en",
          autoTranslate: false,
          sendWithEnter: true,
          aiModel: "gpt35",
          useStreaming: false,
          maxContext: 8000,
          maxResponse: 100,
          theme: "default",
        },
        resources: [],
      });
      for (const [id, name] of [
        ["alpha", "Alpha"],
        ["beta", "Beta"],
        ["gamma", "Gamma"],
      ])
        store.applyCommand("member-" + id, {
          type: "create-character",
          characterId: id,
          definition: {
            type: "character",
            name,
            firstMessage: "Synthetic greeting " + name,
            desc: "Synthetic",
            globalLore: [],
            triggerscript: [],
            customscript: [],
          },
        });
      for (const id of ["group", "other"])
        store.applyCommand(id, {
          type: "create-character",
          characterId: id,
          definition: {
            type: "group",
            name: id === "group" ? "Synthetic group" : "Synthetic other group",
            characters: id === "group" ? ["alpha", "beta"] : [],
            characterTalks: id === "group" ? [1, 1] : [],
            characterActive: id === "group" ? [true, true] : [],
            orderByOrder: false,
            autoMode: false,
            globalLore: [],
            triggerscript: [],
            customscript: [],
            unknown: { preserved: true },
          },
          chat: {
            chatId: id + "-chat",
            metadata: { name: "Synthetic " + id, localLore: [] },
          },
        });
      store.close();
      let url;
      if (built) {
        const passwordFile = join(directory, "password");
        await fs.writeFile(
          passwordFile,
          createHash("sha256").update("synthetic-password").digest("hex"),
        );
        service = await createProductionService({
          file,
          passwordFile,
          staticDirectory: process.env.RISU_DISPLAY_WORKER_BUILD_PATH,
          origin: "https://risu.test",
          insecureLocalTest: true,
          host: "127.0.0.1",
          port: 0,
          runtime: { eventsPollMs: 20, scheduler: { pollMs: 20 } },
        });
        runtime = service.runtime;
        url = service.url;
      } else {
        runtime = await createRuntimeService({
          file,
          origins,
          eventsPollMs: 20,
          scheduler: { pollMs: 20 },
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
            hmr: false,
            proxy: {
              "/api/runtime": { target: runtime.url, changeOrigin: true },
            },
          },
        });
        await frontend.listen();
        url = "http://127.0.0.1:" + frontend.httpServer.address().port;
        origins.push(url);
      }
      const original = runtime.store.call.bind(runtime.store);
      runtime.store.call = async (method, ...args) => {
        if (
          method === "applyCommand" &&
          args[1]?.type === "change-group-member"
        ) {
          observed.push({
            requestId: args[0],
            command: structuredClone(args[1]),
          });
          if (hold) {
            hold = false;
            held++;
            await new Promise((resolve) => {
              release = resolve;
            });
          }
        }
        return original(method, ...args);
      };
      const header = () => runtime.store.call("getCharacter", "group");
      const snapshot = (id) => runtime.store.call("snapshot", id);
      browser = await launchChromium(directory);
      const contextA = await browser.newContext(),
        contextB = await browser.newContext();
      async function open(context) {
        const page = await browser.page(url, context, {
          viewport: { width: 1440, height: 900 },
          blockHttps: true,
        });
        page.on("Runtime.exceptionThrown", (event) =>
          errors.push(
            event.exceptionDetails.exception?.description ??
              event.exceptionDetails.text,
          ),
        );
        if (built) {
          await until(() =>
            page.evaluate(
              "!!document.querySelector('input[name=password]')||!!document.querySelector('[data-runtime-ready=true]')",
            ),
          );
          await page.evaluate(
            "(()=>{const input=document.querySelector('input[name=password]');if(input){input.value='synthetic-password';document.querySelector('form').requestSubmit();}})()",
          );
        }
        await until(
          () =>
            page.evaluate(
              "({ready:!!document.querySelector('[data-runtime-ready=true]'),group:!!document.querySelector('[data-character-id=group]'),status:document.querySelector('[data-runtime-ready]')?.textContent,text:document.body?.textContent?.slice(-1000)})",
            ),
          (value) => value.ready && value.group,
        );
        await click(page, "[data-character-id=group]");
        await until(() =>
          page.evaluate(
            "!!document.querySelector('textarea.input-text')&&!document.querySelector('textarea.input-text').disabled",
          ),
        );
        await textButton(page, "Character");
        await until(() =>
          page.evaluate(
            "!!document.querySelector('[data-group-active=alpha] input')",
          ),
        );
        return page;
      }
      let a = await open(contextA),
        b = await open(contextB);
      const active = (page, id) =>
        page.evaluate(
          `document.querySelector('[data-group-active=${id}] input')?.checked`,
        );
      const pending = (page) =>
        page.evaluate(
          "!!document.querySelector('[data-group-active=alpha][aria-busy=true]')",
        );
      const settled = async () => {
        for (const page of [a, b])
          await until(
            () => pending(page),
            (v) => v === false,
          );
      };
      // Different member revisions merge even though both settings are portable arrays.
      hold = true;
      await click(a, "[data-group-active=alpha] input");
      await until(() => held === 1);
      assert.equal(await active(a, "alpha"), false);
      assert.equal((await header()).definition.characterActive[0], true);
      if (!built)
        assert.equal(
          await a.evaluate(
            ui(
              "r().model.database.characters[r().model.characterIndex('group')].characterActive[0]",
            ),
          ),
          true,
        );
      await click(b, '[data-group-talkness=beta][data-talkness-step="1"]');
      await until(header, (h) => h.definition.characterTalks[1] === 1 / 6);
      release();
      await until(header, (h) => h.definition.characterActive[0] === false);
      await settled();
      assert.deepEqual((await header()).definition.characterTalks, [1, 1 / 6]);
      await until(
        () => active(b, "alpha"),
        (value) => value === false,
      );
      // A same-member peer update rejects the held intent and restores confirmed UI.
      hold = true;
      await click(a, "[data-group-active=alpha] input");
      await until(() => held === 2);
      assert.equal(await active(a, "alpha"), true);
      await click(b, '[data-group-talkness=alpha][data-talkness-step="2"]');
      await until(header, (h) => h.definition.characterTalks[0] === 2 / 6);
      release();
      await until(
        () => active(a, "alpha"),
        (v) => v === false,
      );
      await until(() =>
        a.evaluate(
          "document.body.textContent.includes('변경을 반영하지 못했습니다')",
        ),
      );
      assert.equal((await header()).definition.characterActive[0], false);
      // The blocked alpha command cannot hold a beta command in the outbox.
      await click(a, "[data-group-active=beta] input");
      await until(header, (h) => h.definition.characterActive[1] === false);
      if (!built) {
        const blocked = await a.evaluate(
          ui("s.pending.find(e=>e.state==='blocked')?.requestId"),
        );
        assert.ok(blocked);
        await a.evaluate(ui(`r().discardCommand(${JSON.stringify(blocked)})`));
      } else {
        // Original runtime panel exposes discard for reviewable rejected commands.
        await textButton(a, "요청 취소");
      }
      // Pin original group/chat before confirmation, then navigate to another group.
      await click(a, "[data-group-add]");
      await click(a, 'button[aria-label="Character Gamma"]');
      await until(() =>
        a.evaluate(
          "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='YES')",
        ),
      );
      await click(a, "[data-character-id=other]");
      await textButton(a, "YES");
      await until(
        async () => ({
          header: await header(),
          status: await a.evaluate(
            "document.querySelector('[data-runtime-ready]')?.textContent",
          ),
        }),
        (value) => value.header.definition.characters.includes("gamma"),
      );
      const originalChat = await snapshot("group-chat"),
        other = await runtime.store.call("getCharacter", "other");
      assert.equal(originalChat.messages.length, 1);
      assert.equal(
        originalChat.messages[0].message.data,
        "Synthetic greeting Gamma",
      );
      assert.equal(originalChat.messages[0].message.saying, "gamma");
      assert.deepEqual(other.definition.characters, []);
      assert.equal((await snapshot("other-chat")).messages.length, 0);
      await click(a, "[data-character-id=group]");
      await textButton(a, "Character");
      await until(() =>
        a.evaluate(
          "!!document.querySelector('[data-group-remove=gamma] button')",
        ),
      );
      await until(() =>
        b.evaluate(
          "!!document.querySelector('[data-group-remove=gamma] button')",
        ),
      );
      await click(a, "[data-group-remove=gamma] button");
      await until(header, (h) => !h.definition.characters.includes("gamma"));
      assert.equal((await snapshot("group-chat")).messages.length, 1);
      // Add again without greeting; retained member revision must be fetched after removal.
      await click(a, "[data-group-add]");
      await click(a, 'button[aria-label="Character Gamma"]');
      await textButton(a, "NO");
      await until(header, (h) => h.definition.characters.includes("gamma"));
      assert.equal((await snapshot("group-chat")).messages.length, 1);
      // Original orderByOrder input also uses the durable field path.
      await a.evaluate(
        "(()=>{const label=[...document.querySelectorAll('label')].find(e=>e.textContent.includes('Order'));if(!label)throw Error('Order control missing');label.querySelector('input').click();})()",
      );
      await until(header, (h) => h.definition.orderByOrder === true);
      // Lose the receipt after durable local admission. Reopen the same IndexedDB
      // context and replay exactly the same immutable request, including remove.
      hold = true;
      await click(a, "[data-group-remove=gamma] button");
      await until(() => held === 3);
      const beforeCursor = (await header()).cursor;
      if (!built)
        await until(() =>
          a.evaluate(
            ui(
              "s.pending.some(e=>e.command.type==='change-group-member'&&e.command.action==='remove'&&e.command.memberId==='gamma')",
            ),
          ),
        );
      assert.ok((await header()).definition.characters.includes("gamma"));
      await a.close();
      await b.close();
      release();
      await until(header, (h) => !h.definition.characters.includes("gamma"));
      a = await open(contextA);
      b = await open(contextB);
      await until(() =>
        a.evaluate("!document.querySelector('[data-group-remove=gamma]')"),
      );
      await settled();
      assert.equal((await snapshot("group-chat")).messages.length, 1);
      assert.deepEqual((await header()).definition.unknown, {
        preserved: true,
      });
      if (!built) await until(() => a.evaluate(ui("s.pending.length===0")));
      const replayCommands = observed.filter(
        (x) => x.command.action === "remove" && x.command.memberId === "gamma",
      );
      assert.equal(new Set(replayCommands.map((x) => x.requestId)).size, 2); // two removals, replay ID unchanged
      assert.ok((await header()).cursor > beforeCursor);
      const replayChanges = (await runtime.store.call("changes", beforeCursor))
        .changes;
      assert.equal(
        replayChanges.filter(
          (change) =>
            change.type === "fields" &&
            change.id === "group" &&
            change.payload.fields.some((field) => field.key === "characters"),
        ).length,
        1,
      );
      assert.equal(
        (await runtime.store.call("readGroupMember", "group", "gamma")).member
          .revision,
        4,
      );
      assert.deepEqual(errors, []);
      console.log(
        JSON.stringify({
          built,
          groupCommands: observed.length,
          heldRequests: held,
          greetingCount: 1,
          allTabReplay: true,
          uncaughtErrors: errors.length,
        }),
      );
    },
  );
