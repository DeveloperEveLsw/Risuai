"use strict";

// Feasibility probe only. Authentication, durable ownership, HTML isolation,
// file transfers, browser layout feedback and transport are not supplied here.
// Its purpose is to prove that original DOM event closures can stay alongside
// the original server memory engine, rather than booting a second browser writer.
function createWygloreRemoteDOMProbe(window, scope) {
  const ids = new WeakMap();
  const elements = new Map();
  let nextId = 1;
  let revision = 0;
  function snapshot() {
    revision += 1;
    for (const element of window.document.body.querySelectorAll("*")) {
      let id = ids.get(element);
      if (!id) {
        id = String(nextId++);
        ids.set(element, id);
      }
      elements.set(id, element);
      element.setAttribute("data-wl-server-node", id);
    }
    return {
      scope,
      revision,
      styles: [...window.document.head.querySelectorAll("style")].map(
        (style) => style.textContent,
      ),
      html: window.document.body.innerHTML,
    };
  }
  function dispatch(request) {
    if (request.scope !== scope) throw new Error("UI scope differs");
    if (request.revision !== revision) throw new Error("UI revision is stale");
    if (!["click", "input", "change"].includes(request.type))
      throw new Error("UI event is unsupported");
    const target = elements.get(request.elementId);
    if (!target?.isConnected) throw new Error("UI element is stale");
    if (request.value !== undefined) {
      if (typeof request.value !== "string" || request.value.length > 65536)
        throw new Error("UI value is invalid");
      if (!["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
        throw new Error("UI value target is invalid");
      target.value = request.value;
    }
    if (request.checked !== undefined) {
      if (
        typeof request.checked !== "boolean" ||
        target.tagName !== "INPUT" ||
        target.type !== "checkbox"
      )
        throw new Error("UI checked target is invalid");
      target.checked = request.checked;
    }
    revision += 1;
    return target.dispatchEvent(
      new window.Event(request.type, { bubbles: true }),
    );
  }
  return { snapshot, dispatch };
}

module.exports = { createWygloreRemoteDOMProbe };
