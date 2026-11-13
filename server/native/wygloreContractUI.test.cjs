"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { defaultWygloreFixturePath } = require("./wygloreContract.cjs");
const { makeWygloreContractFixture } = require("./wygloreContractFixtures.cjs");
const { createWygloreRemoteDOMProbe } = require("./wygloreContractUI.cjs");

const fixturePath =
  process.env.RISU_WYGLORE_PLUGIN_PATH || defaultWygloreFixturePath();
const available = fs.existsSync(fixturePath);
const actual = {
  skip: available
    ? false
    : "Fetch author fixture: node server/native/wygloreContract.cjs fetch",
};

async function until(predicate) {
  const untilAt = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > untilAt)
      throw new Error("Original UI did not finish rendering");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test(
  "original setting UI renders and remote change calls the same server engine closure",
  actual,
  async () => {
    const { Window } = await import(
      pathToFileURL(require.resolve("happy-dom")).href
    );
    const window = new Window({
      url: "https://synthetic.invalid",
      settings: {
        disableCSSFileLoading: true,
        disableJavaScriptFileLoading: true,
      },
    });
    const fixture = makeWygloreContractFixture();
    fixture.attachDOM(window);
    try {
      const lifecycle = await fixture.boot(
        fs.readFileSync(fixturePath, "utf8"),
      );
      const setting = fixture.registrations.find(
        (registration) => registration.type === "setting",
      );
      await setting.args[1]();
      assert.equal(
        window.document.querySelectorAll("button[data-tab]").length,
        7,
      );
      assert.ok(window.document.head.querySelector("style"));
      const remote = createWygloreRemoteDOMProbe(window, fixture.chat.id);
      let rendered = remote.snapshot();
      const advanced = window.document.querySelector(
        'button[data-tab="settings"]',
      );
      remote.dispatch({
        scope: fixture.chat.id,
        revision: rendered.revision,
        elementId: advanced.getAttribute("data-wl-server-node"),
        type: "click",
      });
      await until(() =>
        [...window.document.querySelectorAll("label")].some((label) =>
          label.textContent.includes("백그라운드 진행 우선 켜기"),
        ),
      );
      rendered = remote.snapshot();
      const label = [...window.document.querySelectorAll("label")].find(
        (candidate) =>
          candidate.textContent.includes("백그라운드 진행 우선 켜기"),
      );
      const toggle = label.querySelector('input[type="checkbox"]');
      const change = {
        scope: fixture.chat.id,
        revision: rendered.revision,
        elementId: toggle.getAttribute("data-wl-server-node"),
        type: "change",
        checked: false,
      };
      assert.equal(lifecycle.parameters().backgroundFirstEnabled, true);
      remote.dispatch(change);
      assert.equal(lifecycle.parameters().backgroundFirstEnabled, false);
      assert.throws(() => remote.dispatch(change), /revision is stale/);
      await fixture.settle();
      assert.equal(
        JSON.parse(fixture.storage.get("wl.globalSettings.v1"))
          .backgroundFirstEnabled,
        false,
      );
      rendered = remote.snapshot();
      assert.throws(
        () =>
          remote.dispatch({
            ...change,
            revision: rendered.revision,
            scope: "different-chat",
          }),
        /scope differs/,
      );
      assert.equal(
        fixture.calls.some((call) => call.method === "provider"),
        false,
      );
    } finally {
      await fixture.close();
      await window.happyDOM.cancelAsync();
      window.close();
    }
  },
);

test(
  "original memory UI renders completed server extraction and removed elements reject later events",
  actual,
  async () => {
    const { Window } = await import(
      pathToFileURL(require.resolve("happy-dom")).href
    );
    const window = new Window({
      url: "https://synthetic.invalid",
      settings: {
        disableCSSFileLoading: true,
        disableJavaScriptFileLoading: true,
      },
    });
    const fixture = makeWygloreContractFixture({ longChat: true });
    fixture.attachDOM(window);
    try {
      const lifecycle = await fixture.boot(
        fs.readFileSync(fixturePath, "utf8"),
      );
      await fixture.hooks.beforeRequest[0](
        [{ role: "user", content: "Remember Green and the blue garden." }],
        "model",
      );
      await fixture.settle();
      assert.equal(lifecycle.unitsCount(), 3);
      await fixture.registrations
        .find((registration) => registration.type === "setting")
        .args[1]();
      const remote = createWygloreRemoteDOMProbe(window, fixture.chat.id);
      const rendered = remote.snapshot();
      const memoryTab = window.document.querySelector('button[data-tab="web"]');
      remote.dispatch({
        scope: fixture.chat.id,
        revision: rendered.revision,
        elementId: memoryTab.getAttribute("data-wl-server-node"),
        type: "click",
      });
      await until(() =>
        window.document.body.textContent.includes(
          "Green waters the blue garden flowers",
        ),
      );
      const memory = remote.snapshot();
      assert.match(memory.html, /Green waters the blue garden flowers/);
      assert.ok(memory.styles.length > 0);
      const target = window.document.querySelector(
        "button[data-wl-server-node]",
      );
      const staleId = target.getAttribute("data-wl-server-node");
      target.remove();
      assert.throws(
        () =>
          remote.dispatch({
            scope: fixture.chat.id,
            revision: memory.revision,
            elementId: staleId,
            type: "click",
          }),
        /element is stale/,
      );
      await fixture.settle();
    } finally {
      await fixture.close();
      await window.happyDOM.cancelAsync();
      window.close();
    }
  },
);
