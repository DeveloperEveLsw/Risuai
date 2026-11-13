"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID, createHash } = require("node:crypto");
const { parse } = require("node-html-parser");
const { EntityStore } = require("../entity/store.cjs");
const { createPluginUIRuntime } = require("./pluginUIRuntime.cjs");
const {
  WYGLORE_RELEASE,
  defaultWygloreFixturePath,
} = require("./wygloreContract.cjs");
const path =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const actual = {
  skip: fs.existsSync(path) ? false : "Fetch the pinned public WygLore fixture",
  timeout: 30000,
};
async function fixture(t, options = {}) {
  const native = await import(
    pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
  );
  const store = new EntityStore(":memory:");
  store.initializeState(native.createInitialRuntimeState());
  const settings = store.getResource("settings", "global");
  store.applyCommand("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: settings.revision,
    payload: { ...settings.payload, pluginIds: ["wyglore"] },
  });
  store.applyCommand("plugin", {
    type: "put-resource",
    kind: "plugin",
    resourceId: "wyglore",
    expectedRevision: 0,
    payload: {
      id: "wyglore",
      name: WYGLORE_RELEASE.name,
      version: "3.0",
      script: fs.readFileSync(path, "utf8"),
      enabled: true,
      realArg: {},
    },
  });
  store.applyCommand("character", {
    type: "create-character",
    characterId: "garden",
    definition: {
      type: "character",
      name: "Green",
      desc: "Green tends blue flowers.",
      firstMessage: "Welcome to the garden.",
      globalLore: [],
      triggerscript: [],
    },
    chat: {
      chatId: "chat",
      metadata: { name: "Synthetic garden", localLore: [] },
    },
  });
  for (let index = 0; index < (options.messages ?? 0); index++)
    store.applyCommand("message:" + index, {
      type: "append-message",
      chatId: "chat",
      messageId: "synthetic-history:" + index,
      message: {
        role: index % 2 ? "user" : "char",
        data: "Green waters the blue flowers in the garden.",
      },
    });
  const namespace = {
    pluginId: "wyglore",
    bundleSha: WYGLORE_RELEASE.sha256,
    pluginEpoch: store.getResource("plugin", "wyglore").entityEpoch,
  };
  const lease = store.claimPluginStorage({
    namespace,
    writerId: "initial",
    authority: { kind: "browser" },
  });
  store.commitPluginStorage({
    lease,
    expectedRevision: 0,
    commitId: "initial",
    writes: [
      {
        key: "wl.globalSettings.v1",
        value: JSON.stringify({
          coldStartAuto: false,
          speedMode: "fast",
          cbsToggleFloatEnabled: undefined,
          updateCheckEnabled: false,
          rerankerApiKey: "synthetic-no-real-key",
        }),
      },
      ...(options.auxiliaryConfigured
        ? [
            {
              key: "wl.llm.config",
              value: JSON.stringify({
                completeProviderId: "custom-openai",
                completeModel: "synthetic-test",
                maxConcurrent: 3,
              }),
            },
            { key: "wl.provider.custom-openai.apiKey", value: "synthetic-key" },
            {
              key: "wl.provider.custom-openai.baseUrl",
              value: "https://synthetic.invalid/v1",
            },
          ]
        : []),
    ],
  });
  store.releasePluginStorage(lease);
  let requests = 0;
  const owners = [];
  t.after(async () => {
    for (const owner of owners) await owner.close();
    store.close();
  });
  return {
    store,
    namespace,
    requests: () => requests,
    async open() {
      const owner = await createPluginUIRuntime({
        store: { call: async (method, ...args) => store[method](...args) },
        pluginId: "wyglore",
        chatId: "chat",
        expectedChatEpoch: 0,
        providerFetch: async () => {
          requests++;
          throw new Error("Unexpected synthetic provider request");
        },
      });
      owners.push(owner);
      return owner;
    },
    canonicalDigest() {
      const rows = ["characters", "chats", "messages", "resources"].map(
        (table) =>
          store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
      return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    },
  };
}
function click(view, element) {
  assert.ok(element, "the reviewed original control must exist");
  return {
    scope: view.scope,
    revision: view.revision,
    eventId: "plugin-ui:" + randomUUID(),
    nodeId: element.getAttribute("data-risu-plugin-node"),
    type: "click",
  };
}
function button(view, label) {
  return parse(view.html)
    .querySelectorAll("button")
    .find((element) => element.textContent.trim() === label);
}
async function backup(owner) {
  let view = await owner.snapshot();
  view = (
    await owner.dispatch(
      click(
        view,
        parse(view.html).querySelector('button[data-tab="dataRecovery"]'),
      ),
    )
  ).snapshot;
  return (await owner.dispatch(click(view, button(view, "백업 · 정리"))))
    .snapshot;
}
async function waitEffect(owner, kind) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const view = await owner.snapshot();
    const effect = view.effects.find((effect) => effect.kind === kind);
    if (effect) return effect;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(
    "The original handler did not request the expected " +
      kind +
      " interaction",
  );
}
async function upload(owner, effect, payload) {
  return owner.resolveEffect({
    effectId: effect.id,
    eventId: effect.eventId,
    kind: "file",
    file: { name: "synthetic.json", text: JSON.stringify(payload) },
  });
}
function importEnvelope(label) {
  if (label === "설정만 가져오기")
    return {
      kind: "association-tree-settings",
      pluginVersion: "3.1.6",
      params: { shortTermWindow: 7 },
    };
  return {
    kind: "association-tree-snapshot",
    exportVersion: 2,
    unitCount: 1,
    snapshot: {
      version: 3,
      pluginVersion: "3.1.6",
      params: { shortTermWindow: 11 },
      units: [
        {
          id: "synthetic-import-memory",
          type: "note",
          name: "Imported blue flowers",
          content: "Green remembered the imported blue flowers.",
          keywords: ["blue", "flowers"],
          flags: {},
          associations: {},
        },
      ],
    },
  };
}
for (const label of [
  "파일에서 가져오기 (JSON)",
  "설정만 가져오기",
  "전체 가져오기 (뜰 포함)",
]) {
  test(
    "the actual " +
      label +
      " awaits explicit approval, then runs its original import and survives a new owner",
    actual,
    async (t) => {
      const f = await fixture(t),
        owner = await f.open();
      const view = await backup(owner),
        request = click(view, button(view, label));
      const before = f.store.readAllPluginStorage(f.namespace),
        canonical = f.canonicalDigest();
      const pending = owner.dispatch(request);
      pending.catch(() => {});
      const file = await waitEffect(owner, "file");
      assert.deepEqual(
        f.store.readAllPluginStorage(f.namespace),
        before,
        "The pending file picker must not publish plugin storage",
      );
      await upload(owner, file, importEnvelope(label));
      const confirm = await waitEffect(owner, "confirm");
      assert.equal(confirm.eventId, request.eventId);
      assert.match(confirm.text, /덮어씁니다/);
      assert.deepEqual(
        f.store.readAllPluginStorage(f.namespace),
        before,
        "A Promise must never auto-approve original overwrite",
      );
      assert.equal(f.canonicalDigest(), canonical);
      await owner.resolveEffect({
        effectId: confirm.id,
        eventId: confirm.eventId,
        kind: "confirm",
        accepted: true,
      });
      const result = await pending;
      assert.match(
        parse(result.snapshot.html).textContent,
        label === "설정만 가져오기"
          ? /설정 1개 적용 완료/
          : /가져오기 완료|전체 복원 완료/,
      );
      assert.equal(result.snapshot.effects.length, 0);
      assert.equal(
        f.store.readPluginUIEvent({
          sessionId: owner.scope.sessionId,
          eventId: request.eventId,
        }).state,
        "completed",
      );
      assert.equal(f.requests(), 0);
      const plugin = f.store.getResource("plugin", "wyglore");
      assert.equal(
        createHash("sha256").update(plugin.payload.script).digest("hex"),
        WYGLORE_RELEASE.sha256,
      );
      if (label === "설정만 가져오기")
        assert.equal(owner.parameters().shortTermWindow, 7);
      await owner.close();
      const reopened = await f.open();
      if (label === "설정만 가져오기")
        assert.equal(reopened.parameters().shortTermWindow, 7);
      else {
        let next = await reopened.snapshot();
        next = (
          await reopened.dispatch(
            click(
              next,
              parse(next.html).querySelector('button[data-tab="web"]'),
            ),
          )
        ).snapshot;
        assert.match(parse(next.html).textContent, /Imported blue flowers/);
      }
      assert.equal(f.requests(), 0);
    },
  );
}

test(
  "actual invalid settings import is rejected by original format validation after approval without changing settings or source",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      view = await backup(owner);
    const request = click(view, button(view, "설정만 가져오기"));
    const parameters = owner.parameters(),
      canonical = f.canonicalDigest();
    const pending = owner.dispatch(request);
    pending.catch(() => {});
    await upload(owner, await waitEffect(owner, "file"), { wrongFormat: true });
    const confirm = await waitEffect(owner, "confirm");
    await owner.resolveEffect({
      effectId: confirm.id,
      eventId: confirm.eventId,
      kind: "confirm",
      accepted: true,
    });
    const result = await pending;
    assert.match(
      parse(result.snapshot.html).textContent,
      /가져오기 실패:.*params/,
    );
    assert.deepEqual(owner.parameters(), parameters);
    assert.equal(f.canonicalDigest(), canonical);
    assert.equal(f.requests(), 0);
  },
);

test(
  "changing a consumed source while original import awaits approval rejects the stale realm before any imported graph is published",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      view = await backup(owner);
    const request = click(view, button(view, "전체 가져오기 (뜰 포함)"));
    const before = f.store.readAllPluginStorage(f.namespace);
    const pending = owner.dispatch(request);
    pending.catch(() => {});
    await upload(
      owner,
      await waitEffect(owner, "file"),
      importEnvelope("전체 가져오기 (뜰 포함)"),
    );
    const confirm = await waitEffect(owner, "confirm");
    const settings = f.store.getResource("settings", "global");
    f.store.applyCommand("source-changed", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: settings.revision,
      payload: {
        ...settings.payload,
        mainPrompt: "Changed while approval was pending.",
      },
    });
    const changedCanonical = f.canonicalDigest();
    await assert.rejects(
      owner.resolveEffect({
        effectId: confirm.id,
        eventId: confirm.eventId,
        kind: "confirm",
        accepted: true,
      }),
      (error) => error.code === "REVISION_CONFLICT",
    );
    await owner.close();
    await assert.rejects(pending);
    assert.deepEqual(f.store.readAllPluginStorage(f.namespace), before);
    assert.equal(f.canonicalDigest(), changedCanonical);
    assert.equal(f.requests(), 0);
    assert.equal(
      f.store.readPluginUIEvent({
        sessionId: owner.scope.sessionId,
        eventId: request.eventId,
      }).state,
      "failed",
    );
  },
);

test(
  "the original floating emergency-release button fails sticky before it can save or report successful reactivation",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open();
    assert.equal(owner.parameters().cbsToggleFloatEnabled, true);
    let view = await owner.snapshot();
    view = (
      await owner.dispatch(
        click(
          view,
          parse(view.html).querySelector('button[data-tab="semantic"]'),
        ),
      )
    ).snapshot;
    view = (await owner.dispatch(click(view, button(view, "흡수 설정"))))
      .snapshot;
    const request = click(view, button(view, "비상탈출 해제"));
    const before = f.store.readAllPluginStorage(f.namespace),
      canonical = f.canonicalDigest();
    await assert.rejects(owner.dispatch(request), {
      code: "PLUGIN_UI_CAPABILITY_REQUIRED",
    });
    assert.throws(() => owner.ensureHealthy(), {
      code: "PLUGIN_UI_CAPABILITY_REQUIRED",
    });
    assert.deepEqual(f.store.readAllPluginStorage(f.namespace), before);
    assert.equal(f.canonicalDigest(), canonical);
    const receipt = f.store.readPluginUIEvent({
      sessionId: owner.scope.sessionId,
      eventId: request.eventId,
    });
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.code, "PLUGIN_UI_CAPABILITY_REQUIRED");
    await owner.close();
    const next = f.store.claimPluginStorage({
      namespace: f.namespace,
      writerId: "following-owner",
      authority: { kind: "browser" },
    });
    f.store.releasePluginStorage(next);
    assert.equal(f.requests(), 0);
  },
);

async function recovery(owner, label) {
  let view = await owner.snapshot();
  view = (
    await owner.dispatch(
      click(
        view,
        parse(view.html).querySelector('button[data-tab="semantic"]'),
      ),
    )
  ).snapshot;
  view = (await owner.dispatch(click(view, button(view, "맥락 따라잡기"))))
    .snapshot;
  return click(view, button(view, label));
}
for (const label of ["맥락 따라잡기 실행", "손실 복구"]) {
  test(
    "the actual large " +
      label +
      " keeps its event open for consent and rejects without a model request or any canonical write",
    actual,
    async (t) => {
      const f = await fixture(t, { messages: 110, auxiliaryConfigured: true }),
        owner = await f.open();
      const request = await recovery(owner, label);
      const before = f.store.readAllPluginStorage(f.namespace),
        canonical = f.canonicalDigest();
      const pending = owner.dispatch(request);
      pending.catch(() => {});
      const confirm = await waitEffect(owner, "confirm");
      assert.equal(confirm.eventId, request.eventId);
      assert.match(
        confirm.text,
        label === "손실 복구" ? /손실 복구/ : /맥락 따라잡기 실행/,
      );
      assert.equal(f.requests(), 0);
      assert.deepEqual(f.store.readAllPluginStorage(f.namespace), before);
      assert.equal(f.canonicalDigest(), canonical);
      assert.equal(
        (await owner.snapshot()).busy,
        true,
        "The original fire-and-forget button must now return its helper Promise",
      );
      await owner.resolveEffect({
        effectId: confirm.id,
        eventId: confirm.eventId,
        kind: "confirm",
        accepted: false,
      });
      const result = await pending;
      assert.equal(result.snapshot.effects.length, 0);
      assert.deepEqual(f.store.readAllPluginStorage(f.namespace), before);
      assert.equal(f.canonicalDigest(), canonical);
      assert.equal(f.requests(), 0);
      assert.equal(
        f.store.readPluginUIEvent({
          sessionId: owner.scope.sessionId,
          eventId: request.eventId,
        }).state,
        "completed",
      );
    },
  );
}

test(
  "the original synchronous telemetry clear callback awaits acceptance before clearing its log",
  actual,
  async (t) => {
    const f = await fixture(t),
      owner = await f.open();
    let view = await owner.snapshot();
    view = (
      await owner.dispatch(
        click(view, parse(view.html).querySelector('button[data-tab="about"]')),
      )
    ).snapshot;
    view = (await owner.dispatch(click(view, button(view, "로그이력"))))
      .snapshot;
    const request = click(view, button(view, "비우기")),
      canonical = f.canonicalDigest();
    const pending = owner.dispatch(request);
    pending.catch(() => {});
    const confirm = await waitEffect(owner, "confirm");
    assert.match(confirm.text, /로그 \d+건/);
    assert.equal((await owner.snapshot()).busy, true);
    await owner.resolveEffect({
      effectId: confirm.id,
      eventId: confirm.eventId,
      kind: "confirm",
      accepted: true,
    });
    const result = await pending;
    assert.match(parse(result.snapshot.html).textContent, /비웠습니다/);
    assert.equal(result.snapshot.effects.length, 0);
    assert.equal(f.canonicalDigest(), canonical);
    assert.equal(f.requests(), 0);
  },
);

test(
  "actual recovery approval is fenced against a source edit while its complete async helper is awaiting consent",
  actual,
  async (t) => {
    const f = await fixture(t, { messages: 110, auxiliaryConfigured: true }),
      owner = await f.open();
    const request = await recovery(owner, "손실 복구"),
      before = f.store.readAllPluginStorage(f.namespace);
    const pending = owner.dispatch(request);
    pending.catch(() => {});
    const confirm = await waitEffect(owner, "confirm");
    const settings = f.store.getResource("settings", "global");
    f.store.applyCommand("source-edit-during-recovery", {
      type: "put-resource",
      kind: "settings",
      resourceId: "global",
      expectedRevision: settings.revision,
      payload: {
        ...settings.payload,
        mainPrompt: "A new source configuration during recovery approval.",
      },
    });
    const changedCanonical = f.canonicalDigest();
    await assert.rejects(
      owner.resolveEffect({
        effectId: confirm.id,
        eventId: confirm.eventId,
        kind: "confirm",
        accepted: true,
      }),
      (error) => error.code === "REVISION_CONFLICT",
    );
    await owner.close();
    await assert.rejects(pending);
    assert.deepEqual(f.store.readAllPluginStorage(f.namespace), before);
    assert.equal(f.canonicalDigest(), changedCanonical);
    assert.equal(f.requests(), 0);
  },
);
