"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { parse } = require("node-html-parser");
const { EntityStore } = require("../entity/store.cjs");
const { createNativePluginCoordinator } = require("./nativePluginRuntime.cjs");
const { createPluginUIRuntime } = require("./pluginUIRuntime.cjs");
const {
  WYGLORE_RELEASE,
  readWygloreFixture,
} = require("./wygloreContract.cjs");

async function fixture(t) {
  const source = await readWygloreFixture(),
    native = await import(
      pathToFileURL(join(__dirname, "dist/extensionJob.mjs")).href
    );
  const store = new EntityStore(":memory:"),
    owners = [],
    rpc = { call: async (method, ...args) => store[method](...args) };
  t.after(async () => {
    for (const owner of owners) await owner.close();
    store.close();
  });
  store.initializeState(native.createInitialRuntimeState());
  const settings = store.getResource("settings", "global");
  store.applyCommand("settings", {
    type: "put-resource",
    kind: "settings",
    resourceId: "global",
    expectedRevision: settings.revision,
    payload: {
      ...settings.payload,
      pluginIds: ["wyglore"],
      aiModel: "reverse_proxy",
      customProxyRequestModel: "synthetic-model",
      forceReplaceUrl: "https://synthetic.invalid/v1/chat/completions",
      proxyKey: "synthetic-key",
      customTokenizer: "tik",
      mainPrompt: "Help the gardener.",
      maxContext: 8000,
      maxResponse: 200,
      useStreaming: false,
    },
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
      enabled: true,
      script: source,
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
  const namespace = {
    pluginId: "wyglore",
    bundleSha: WYGLORE_RELEASE.sha256,
    pluginEpoch: 0,
  };
  const initial = store.claimPluginStorage({
    namespace,
    writerId: "initial",
    authority: { kind: "browser" },
  });
  store.commitPluginStorage({
    lease: initial,
    expectedRevision: 0,
    commitId: "initial",
    writes: [
      {
        key: "wl.globalSettings.v1",
        value: JSON.stringify({
          coldStartAuto: false,
          backgroundFirstEnabled: true,
          speedMode: "fast",
          cbsToggleFloatEnabled: false,
          updateCheckEnabled: false,
        }),
      },
    ],
  });
  store.releasePluginStorage(initial);
  let requests = 0;
  async function providerFetch(url, init) {
    assert.equal(String(url), "https://synthetic.invalid/v1/chat/completions");
    assert.equal(JSON.parse(init.body).model, "synthetic-model");
    requests++;
    return Response.json({
      choices: [{ message: { content: "The blue flowers bloom." } }],
    });
  }
  store.enqueueJob("seed", {
    type: "send",
    chatId: "chat",
    input: "Tell me about the flowers.",
    messageId: "seed:input",
  });
  const claimed = store.claimJob("synthetic-web-worker"),
    coordinator = createNativePluginCoordinator({
      store: rpc,
      job: claimed.job,
      snapshot: claimed.snapshot,
      fetch: providerFetch,
    });
  try {
    const outcome = await native.executeExtensionJob(claimed, {
      appVer: "2026.8.250",
      providerFetch,
      preparePluginSnapshot: coordinator.prepareSnapshot,
      openPluginRuntime: coordinator.open,
      fetch: async (path) =>
        new Response(
          fs.readFileSync(join(__dirname, "../../public", path.slice(1))),
        ),
    });
    store.finishJob(claimed.job.id, claimed.job.owner, claimed.job.fence, {
      state: "completed",
      ...outcome,
    });
  } finally {
    await coordinator.release();
  }
  async function open() {
    const owner = await createPluginUIRuntime({
      store: rpc,
      pluginId: "wyglore",
      chatId: "chat",
      expectedChatEpoch: 0,
      providerFetch: async () => {
        throw Error(
          "No model request is necessary for synthetic manual UI edits",
        );
      },
    });
    owners.push(owner);
    return owner;
  }
  return { store, namespace, open, requests: () => requests };
}

function driver(owner) {
  const view = () => owner.snapshot();
  async function dispatch(find, type = "click", values = {}) {
    const snapshot = await view(),
      dom = parse(snapshot.html),
      element = typeof find === "string" ? dom.querySelector(find) : find(dom);
    assert.ok(element, "The original UI rendered the requested element");
    return (
      await owner.dispatch({
        scope: snapshot.scope,
        revision: snapshot.revision,
        eventId: "plugin-ui:" + randomUUID(),
        nodeId: element.getAttribute("data-risu-plugin-node"),
        type,
        ...values,
      })
    ).snapshot;
  }
  const button = (label) => (dom) =>
    dom
      .querySelectorAll("button")
      .findLast((element) => element.textContent.trim() === label);
  return { view, dispatch, button };
}

test(
  "original cards, HTML rings and relation list support inspector opening and multi-selection",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      d = driver(owner);
    let view = await d.dispatch('button[data-tab="web"]');
    const cards = parse(view.html).querySelectorAll(".at-unit-card");
    assert.ok(
      cards.length >= 2,
      "The real native canonical graph has rendered original cards",
    );
    assert.equal(parse(view.html).querySelector("canvas"), null);
    view = await d.dispatch(".at-unit-card");
    assert.match(parse(view.html).textContent, /원본에서 고치기/);
    view = await d.dispatch(d.button("닫기"));
    assert.ok(parse(view.html).querySelectorAll(".at-unit-card").length >= 2);
    view = await d.dispatch(d.button("나이테"));
    assert.ok(parse(view.html).querySelector("section header"));
    view = await d.dispatch("section header");
    assert.ok(parse(view.html).querySelector("section header"));
    view = await d.dispatch(d.button("관계"));
    assert.match(
      parse(view.html).textContent,
      /아직 대화에서 확인된 관계 기록이 없습니다/,
    );
    view = await d.dispatch(d.button("활성도 카드"));
    view = await d.dispatch(
      (dom) =>
        dom
          .querySelectorAll("label")
          .find((label) => label.textContent.includes("선택 모드"))
          .querySelector("input"),
      "change",
      { checked: true },
    );
    view = await d.dispatch(".at-unit-card");
    assert.match(parse(view.html).textContent, /1개 선택됨/);
    view = await d.dispatch((dom) => dom.querySelectorAll(".at-unit-card")[1]);
    assert.match(parse(view.html).textContent, /2개 선택됨/);
    view = await d.dispatch(d.button("선택 해제"));
    assert.doesNotMatch(parse(view.html).textContent, /[12]개 선택됨/);
    assert.equal(f.requests(), 1);
    assert.equal(f.store.snapshot("chat").messages.length, 2);
  },
);

test(
  "original create and edit forms synchronize unregistered control values and persist the same memory across UI owners",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      owner = await f.open(),
      d = driver(owner);
    await d.dispatch('button[data-tab="web"]');
    await d.dispatch(d.button("추가"));
    await d.dispatch('input[placeholder="기억을 구분할 짧은 이름"]', "input", {
      value: "Synthetic flower agreement",
    });
    await d.dispatch("select", "change", { value: "relation" });
    await d.dispatch(
      'textarea[placeholder="이 기억이 점화될 때 LLM에게 환기시킬 정보."]',
      "input",
      { value: "Green and Blue agreed to water the synthetic flowers." },
    );
    let view = await d.dispatch(d.button("저장"));
    assert.match(parse(view.html).textContent, /Synthetic flower agreement/);
    view = await d.dispatch(d.button("관계"));
    assert.match(
      parse(view.html).textContent,
      /Green and Blue agreed to water the synthetic flowers/,
    );
    await d.dispatch((dom) =>
      dom
        .querySelectorAll("button.wl-card")
        .find((card) =>
          card.textContent.includes("Synthetic flower agreement"),
        ),
    );
    view = await d.dispatch(d.button("편집"));
    assert.equal(
      view.controlStates.find((control) => control.tag === "SELECT").value,
      "relation",
      "Opening the original edit form must preserve its selected memory type",
    );
    await d.dispatch(
      'textarea[placeholder="이 기억이 점화될 때 LLM에게 환기시킬 정보."]',
      "input",
      { value: "Green and Blue agreed to water every Tuesday." },
    );
    await d.dispatch(d.button("저장"));
    await d.dispatch(d.button("닫기"));
    await owner.close();
    const reopened = await f.open(),
      next = driver(reopened);
    view = await next.dispatch('button[data-tab="web"]');
    assert.match(parse(view.html).textContent, /water every Tuesday/);
    await next.dispatch(d.button("관계"));
    assert.match(parse((await next.view()).html).textContent, /직접 다듬음/);
    assert.equal(f.requests(), 1);
    assert.equal(f.store.snapshot("chat").messages.length, 2);
  },
);
