"use strict";

const { parse, HTMLElement, TextNode } = require("node-html-parser");
const { RuntimeError } = require("../entity/errors.cjs");

/**
 * A scratch DOM for original server plugin dialogs, not a rendered browser.
 * Its confirmation buttons become durable selections, and an answer dispatches
 * the original registered click callback. No DOM absence => automatic proceed.
 * Unsupported DOM operations poison the host even if a plugin catches them.
 */
function createPluginDom(options = {}) {
  const tree = parse("<html><head></head><body></body></html>");
  const nodes = new WeakMap();
  const states = new WeakMap();
  const actions = new Map();
  const dialogs = new Map();
  const documentListeners = new Map();
  let actionPosition = 0;
  let dialogPosition = 0;
  let visible = false;
  let scheduled = false;
  let closed = false;
  let failure;
  let active;

  function fail(error) {
    if (!failure) {
      failure = error instanceof Error ? error : new Error(String(error));
      try {
        options.onFailure?.(failure);
      } catch {}
    }
    return failure;
  }
  function healthy() {
    if (failure) throw failure;
    if (closed)
      throw new RuntimeError("PLUGIN_DOM_CLOSED", "Plugin DOM is closed");
    options.signal?.throwIfAborted();
  }
  function unsupported(surface, property) {
    return fail(
      new RuntimeError(
        "PLUGIN_DOM_UNSUPPORTED",
        `Server plugin DOM does not support ${surface}.${String(property)}`,
      ),
    );
  }
  function changed() {
    if (scheduled || closed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (closed || failure) return;
      try {
        inspect();
      } catch (error) {
        fail(error);
      }
    });
  }
  function escapeText(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function unwrap(value) {
    const state = states.get(value);
    if (!state)
      throw fail(
        new RuntimeError(
          "PLUGIN_DOM_INVALID_NODE",
          "Node belongs to another DOM",
        ),
      );
    return state.node;
  }
  function connected(node) {
    for (let current = node; current; current = current.parentNode)
      if (current === tree) return true;
    return false;
  }
  function list(node) {
    return node.childNodes.map(wrap);
  }
  function assignText(node, value) {
    if (node instanceof TextNode) node.rawText = escapeText(value);
    else node.set_content(escapeText(value));
    changed();
  }
  function listenerMap(state, type) {
    let listeners = state.listeners.get(type);
    if (!listeners) state.listeners.set(type, (listeners = new Map()));
    return listeners;
  }
  async function dispatch(node, type, init = {}) {
    healthy();
    const proxy = wrap(node),
      state = states.get(proxy);
    let propagationStopped = false;
    const event = {
      ...init,
      type,
      target: proxy,
      currentTarget: proxy,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        propagationStopped = true;
      },
      stopImmediatePropagation() {
        propagationStopped = true;
      },
    };
    for (const [listener, registration] of Array.from(
      listenerMap(state, type),
    )) {
      if (registration.once) listenerMap(state, type).delete(listener);
      try {
        if (typeof listener === "function") await listener.call(proxy, event);
        else await listener.handleEvent(event);
      } catch (error) {
        throw fail(error);
      }
      if (propagationStopped) break;
    }
    const handler = state.handlers.get(type);
    if (handler && !propagationStopped) {
      try {
        await handler.call(proxy, event);
      } catch (error) {
        throw fail(error);
      }
    }
    healthy();
    changed();
    return !event.defaultPrevented;
  }

  function wrap(node) {
    if (!node) return null;
    if (nodes.has(node)) return nodes.get(node);
    const state = {
      node,
      listeners: new Map(),
      handlers: new Map(),
      style: Object.create(null),
      properties: Object.create(null),
    };
    const style = new Proxy(state.style, {
      get(target, key) {
        if (key === "setProperty")
          return (property, value) => {
            target[property] = String(value);
            changed();
          };
        if (key === "getPropertyValue")
          return (property) => target[property] ?? "";
        if (key === "removeProperty")
          return (property) => {
            const old = target[property] ?? "";
            delete target[property];
            changed();
            return old;
          };
        if (key === Symbol.toStringTag) return "CSSStyleDeclaration";
        return target[key] ?? "";
      },
      set(target, key, value) {
        healthy();
        target[key] = String(value);
        changed();
        return true;
      },
    });
    const element = node instanceof HTMLElement;
    const classes = () =>
      element
        ? (node.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)
        : [];
    const setClasses = (values) => {
      node.setAttribute("class", values.join(" "));
      changed();
    };
    const classList = {
      add(...values) {
        setClasses(Array.from(new Set([...classes(), ...values.map(String)])));
      },
      remove(...values) {
        setClasses(classes().filter((value) => !values.includes(value)));
      },
      contains(value) {
        return classes().includes(value);
      },
      toggle(value, force) {
        const present = classes().includes(value),
          next = force === undefined ? !present : !!force;
        if (next) this.add(value);
        else this.remove(value);
        return next;
      },
      replace(before, after) {
        if (!this.contains(before)) return false;
        this.remove(before);
        this.add(after);
        return true;
      },
      get value() {
        return classes().join(" ");
      },
      [Symbol.iterator]() {
        return classes()[Symbol.iterator]();
      },
    };
    const dataset = new Proxy(Object.create(null), {
      get(_target, key) {
        return node.getAttribute(
          "data-" + String(key).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()),
        );
      },
      set(_target, key, value) {
        healthy();
        node.setAttribute(
          "data-" + String(key).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()),
          String(value),
        );
        changed();
        return true;
      },
    });
    const methods = {
      appendChild(child) {
        healthy();
        node.appendChild(unwrap(child));
        changed();
        return child;
      },
      removeChild(child) {
        healthy();
        if (unwrap(child).parentNode !== node)
          throw fail(new Error("Node is not a child"));
        node.removeChild(unwrap(child));
        changed();
        return child;
      },
      remove() {
        healthy();
        node.remove();
        changed();
      },
      append(...children) {
        healthy();
        for (const child of children)
          node.appendChild(
            typeof child === "string"
              ? new TextNode(escapeText(child))
              : unwrap(child),
          );
        changed();
      },
      prepend(...children) {
        healthy();
        for (const child of children.reverse()) {
          const raw =
            typeof child === "string"
              ? new TextNode(escapeText(child))
              : unwrap(child);
          raw.remove();
          raw.parentNode = node;
          node.childNodes.unshift(raw);
        }
        changed();
      },
      insertBefore(child, reference) {
        healthy();
        const raw = unwrap(child);
        if (reference === null) return this.appendChild(child);
        const index = node.childNodes.indexOf(unwrap(reference));
        if (index < 0) throw fail(new Error("Reference is not a child"));
        raw.remove();
        raw.parentNode = node;
        node.childNodes.splice(index, 0, raw);
        changed();
        return child;
      },
      replaceChild(child, previous) {
        this.insertBefore(child, previous);
        this.removeChild(previous);
        return previous;
      },
      replaceWith(child) {
        healthy();
        const parent = wrap(node.parentNode);
        if (parent) parent.replaceChild(child, proxy);
      },
      cloneNode(deep = false) {
        healthy();
        const cloned = element
          ? parse(node.toString()).firstChild
          : new TextNode(node.rawText);
        if (!deep && cloned instanceof HTMLElement) cloned.set_content("");
        return wrap(cloned);
      },
      contains(child) {
        for (let raw = unwrap(child); raw; raw = raw.parentNode)
          if (raw === node) return true;
        return false;
      },
      setAttribute(name, value) {
        healthy();
        if (!element) throw unsupported("Text", "setAttribute");
        node.setAttribute(String(name), String(value));
        changed();
      },
      getAttribute(name) {
        healthy();
        return element ? (node.getAttribute(String(name)) ?? null) : null;
      },
      hasAttribute(name) {
        healthy();
        return element && node.hasAttribute(String(name));
      },
      removeAttribute(name) {
        healthy();
        if (element) node.removeAttribute(String(name));
        changed();
      },
      querySelector(selector) {
        healthy();
        return element ? wrap(node.querySelector(String(selector))) : null;
      },
      querySelectorAll(selector) {
        healthy();
        return element ? node.querySelectorAll(String(selector)).map(wrap) : [];
      },
      addEventListener(type, listener, registration = {}) {
        healthy();
        if (
          typeof listener !== "function" &&
          typeof listener?.handleEvent !== "function"
        )
          throw fail(new Error("Invalid DOM listener"));
        listenerMap(state, String(type)).set(
          listener,
          typeof registration === "boolean" ? {} : registration,
        );
        changed();
      },
      removeEventListener(type, listener) {
        listenerMap(state, String(type)).delete(listener);
        changed();
      },
      dispatchEvent(event) {
        return dispatch(node, String(event.type), event);
      },
      click() {
        return dispatch(node, "click");
      },
    };
    const proxy = new Proxy(Object.create(null), {
      get(_target, property) {
        if (property === "then") return undefined;
        if (property === Symbol.toStringTag)
          return element ? "HTMLElement" : "Text";
        if (property in methods) return methods[property];
        if (property === "ownerDocument") return document;
        if (property === "style") return style;
        if (property === "classList") return classList;
        if (property === "dataset") return dataset;
        if (property === "nodeType") return node.nodeType;
        if (property === "nodeName" || property === "tagName")
          return element ? node.tagName : "#text";
        if (property === "parentNode" || property === "parentElement")
          return wrap(node.parentNode);
        if (property === "childNodes") return list(node);
        if (property === "children")
          return node.childNodes
            .filter((value) => value instanceof HTMLElement)
            .map(wrap);
        if (property === "firstChild" || property === "lastChild")
          return wrap(
            property === "firstChild" ? node.firstChild : node.lastChild,
          );
        if (
          property === "firstElementChild" ||
          property === "lastElementChild"
        ) {
          const children = node.childNodes.filter(
            (value) => value instanceof HTMLElement,
          );
          return wrap(
            property === "firstElementChild" ? children[0] : children.at(-1),
          );
        }
        if (property === "isConnected") return connected(node);
        if (property === "textContent" || property === "innerText")
          return node.text;
        if (property === "innerHTML")
          return element ? node.innerHTML : undefined;
        if (property === "outerHTML") return node.toString();
        if (property === "className")
          return element ? (node.getAttribute("class") ?? "") : "";
        if (property === "id")
          return element ? (node.getAttribute("id") ?? "") : "";
        if (
          property === "hidden" ||
          property === "disabled" ||
          property === "checked" ||
          property === "selected" ||
          property === "open"
        )
          return !!state.properties[property];
        if (
          [
            "type",
            "value",
            "title",
            "name",
            "placeholder",
            "href",
            "tabIndex",
          ].includes(property)
        )
          return state.properties[property] ?? "";
        if (typeof property === "string" && property.startsWith("on"))
          return state.handlers.get(property.slice(2)) ?? null;
        throw unsupported(element ? "Element" : "Text", property);
      },
      set(_target, property, value) {
        healthy();
        if (property === "textContent" || property === "innerText")
          assignText(node, value);
        else if (property === "innerHTML") {
          if (!element) throw unsupported("Text", property);
          node.set_content(String(value));
          changed();
        } else if (property === "id" || property === "className") {
          node.setAttribute(property === "id" ? "id" : "class", String(value));
          changed();
        } else if (
          [
            "hidden",
            "disabled",
            "checked",
            "selected",
            "open",
            "type",
            "value",
            "title",
            "name",
            "placeholder",
            "href",
            "tabIndex",
          ].includes(property)
        ) {
          state.properties[property] = value;
          changed();
        } else if (typeof property === "string" && property.startsWith("on")) {
          if (value !== null && typeof value !== "function")
            throw fail(new Error("Invalid DOM handler"));
          state.handlers.set(property.slice(2), value);
          changed();
        } else throw unsupported(element ? "Element" : "Text", property);
        return true;
      },
    });
    nodes.set(node, proxy);
    states.set(proxy, state);
    return proxy;
  }

  const documentMethods = {
    createElement(tag) {
      healthy();
      if (!/^[a-z][a-z\d:-]*$/i.test(String(tag)))
        throw fail(new Error("Invalid element tag"));
      return wrap(parse(`<${tag}></${tag}>`).firstChild);
    },
    createElementNS(_namespace, tag) {
      return this.createElement(tag);
    },
    createTextNode(text) {
      healthy();
      return wrap(new TextNode(escapeText(text)));
    },
    querySelector(selector) {
      healthy();
      return wrap(tree.querySelector(String(selector)));
    },
    querySelectorAll(selector) {
      healthy();
      return tree.querySelectorAll(String(selector)).map(wrap);
    },
    getElementById(id) {
      healthy();
      return wrap(
        tree
          .querySelectorAll("[id]")
          .find((node) => node.getAttribute("id") === String(id)),
      );
    },
    addEventListener(type, listener) {
      healthy();
      let entries = documentListeners.get(type);
      if (!entries) documentListeners.set(type, (entries = new Set()));
      entries.add(listener);
    },
    removeEventListener(type, listener) {
      documentListeners.get(type)?.delete(listener);
    },
  };
  const document = new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === Symbol.toStringTag) return "Document";
      if (property in documentMethods) return documentMethods[property];
      if (property === "head" || property === "body")
        return wrap(tree.querySelector(property));
      if (property === "documentElement")
        return wrap(tree.querySelector("html"));
      if (property === "hidden") return false;
      if (property === "visibilityState") return "visible";
      if (property === "readyState") return "complete";
      throw unsupported("Document", property);
    },
    set(_target, property) {
      throw unsupported("Document", property);
    },
  });

  function controls(node, dialogState) {
    return node
      .querySelectorAll("button")
      .filter((button) => {
        const state = states.get(wrap(button));
        return listenerMap(state, "click").size || state.handlers.get("click");
      })
      .map((button) => {
        const proxy = wrap(button),
          state = states.get(proxy);
        let action = state.action;
        if (!action) {
          action = {
            id: "plugin-dom-action-" + ++actionPosition,
            node: button,
          };
          state.action = action;
          actions.set(action.id, action);
        }
        action.dialog = dialogState;
        return {
          id: action.id,
          label: button.text.trim() || button.getAttribute("aria-label") || "",
          disabled: !!state.properties.disabled,
        };
      });
  }
  function descriptor(node, state) {
    const buttons = controls(node, state);
    return {
      type: "plugin-ui",
      id: state.id,
      mode: state.progress ? "progress" : "selection",
      visible,
      title: node.getAttribute("aria-label") ?? "",
      text: node.text.replace(/\s+/g, " ").trim(),
      actions: buttons,
    };
  }
  function inspect() {
    healthy();
    const current = new Set(tree.querySelectorAll('[role="dialog"]'));
    for (const [node, state] of dialogs) {
      if (current.has(node)) continue;
      if (state.selecting && !state.answering)
        throw fail(
          new RuntimeError(
            "PLUGIN_DOM_INTERACTION_CLOSED",
            "Original plugin dialog closed before its durable answer",
          ),
        );
      state.closed = true;
      if (active === state) active = undefined;
      dialogs.delete(node);
      options.onProgress?.({ type: "plugin-ui", id: state.id, mode: "closed" });
    }
    for (const node of current) {
      let state = dialogs.get(node);
      if (!state) {
        let ancestor = node;
        let progress = false;
        while (ancestor && ancestor !== tree) {
          if (
            ancestor instanceof HTMLElement &&
            (ancestor.getAttribute("class") ?? "")
              .split(/\s+/)
              .includes("at-coldstart-overlay")
          )
            progress = true;
          ancestor = ancestor.parentNode;
        }
        state = {
          id: "plugin-dom-dialog-" + ++dialogPosition,
          progress,
          selecting: false,
          answering: false,
          closed: false,
        };
        dialogs.set(node, state);
      }
      const view = descriptor(node, state);
      const serialized = JSON.stringify(view);
      if (state.previous !== serialized) {
        state.previous = serialized;
        options.onProgress?.(view);
      }
      if (state.progress || state.selecting || state.closed) continue;
      const buttons = view.actions.filter((button) => !button.disabled);
      if (!buttons.length)
        throw fail(
          new RuntimeError(
            "PLUGIN_DOM_INTERACTION_UNSUPPORTED",
            "Original plugin dialog has no actionable buttons",
          ),
        );
      if (buttons.some((button) => !button.label))
        throw fail(
          new RuntimeError(
            "PLUGIN_DOM_INTERACTION_UNSUPPORTED",
            "Original plugin dialog has an unnamed action",
          ),
        );
      if (typeof options.alertSelect !== "function")
        throw fail(
          new RuntimeError(
            "PLUGIN_DOM_INTERACTION_REQUIRED",
            "Durable plugin dialog selection is required",
          ),
        );
      if (active && active !== state)
        throw fail(
          new RuntimeError(
            "PLUGIN_DOM_INTERACTION_BUSY",
            "Original plugin opened multiple simultaneous confirmation dialogs",
          ),
        );
      state.selecting = true;
      active = state;
      const task = async () => {
        const result = await options.alertSelect(
          buttons.map((button) => button.label),
          view.text,
        );
        healthy();
        if (!connected(node) || state.closed)
          throw new RuntimeError(
            "PLUGIN_DOM_INTERACTION_CLOSED",
            "Original plugin dialog no longer exists",
          );
        const index =
          typeof result === "number"
            ? result
            : typeof result === "string" && /^\d+$/.test(result)
              ? Number(result)
              : NaN;
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= buttons.length
        )
          throw new RuntimeError(
            "PLUGIN_DOM_INVALID_ANSWER",
            "Plugin dialog answer does not select an original button",
          );
        state.answering = true;
        await dispatchAction(buttons[index].id, true);
        state.selecting = false;
        if (active === state) active = undefined;
        changed();
      };
      state.task = task().catch((error) => {
        fail(error);
      });
    }
  }
  async function dispatchAction(id, durableAnswer = false) {
    healthy();
    const action = actions.get(id);
    if (
      !action ||
      !connected(action.node) ||
      states.get(wrap(action.node)).properties.disabled
    )
      throw new RuntimeError(
        "STALE_PLUGIN_UI_ACTION",
        "Original plugin action is no longer available",
      );
    if (!durableAnswer && !action.dialog?.progress)
      throw new RuntimeError(
        "PLUGIN_UI_DURABLE_ANSWER_REQUIRED",
        "Confirmation buttons require a recorded durable interaction answer",
      );
    return dispatch(action.node, "click");
  }
  function stop() {
    if (closed) return;
    closed = true;
    actions.clear();
    dialogs.clear();
    documentListeners.clear();
    options.signal?.removeEventListener("abort", aborted);
  }
  function aborted() {
    fail(options.signal.reason ?? new Error("Plugin DOM aborted"));
    stop();
  }
  options.signal?.addEventListener("abort", aborted, { once: true });
  return {
    document,
    showContainer() {
      healthy();
      visible = true;
      changed();
      return true;
    },
    hideContainer() {
      healthy();
      visible = false;
      changed();
    },
    dispatchAction: (id) => dispatchAction(id),
    assertHealthy: healthy,
    check() {
      healthy();
      if (active)
        throw fail(
          new RuntimeError(
            "PLUGIN_DOM_INTERACTION_PENDING",
            "Plugin DOM confirmation is still awaiting a durable answer",
          ),
        );
    },
    stop,
  };
}

module.exports = { createPluginDom };
