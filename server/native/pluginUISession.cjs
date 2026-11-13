"use strict";

const { createHash, randomUUID } = require("node:crypto");
const cssTools = require("@adobe/css-tools");
const { RuntimeError } = require("../entity/errors.cjs");

const NODE_ATTRIBUTE = "data-risu-plugin-node";
const EVENT_ATTRIBUTE = "data-risu-plugin-events";
const TYPES = new Set(["click", "input", "change", "blur", "keydown"]);
const WINDOWS = new WeakMap();
const EVENT_PROTOTYPES = new WeakMap();
const SELECT_PROTOTYPES = new WeakMap();
// Some DOM implementations expose SELECT through a proxy and bind methods to
// its underlying node. A private symbol gives both views the same identity
// without adding attributes to the original plugin DOM.
const NODE_IDENTITY = Symbol("risuPluginUINodeIdentity");
function nodeIdentity(node) {
  if (!node[NODE_IDENTITY]) node[NODE_IDENTITY] = Object.freeze({});
  return node[NODE_IDENTITY];
}
const TAGS = new Set(
  "div span button label input textarea select option optgroup fieldset legend details summary p em strong b i u s small code pre ul ol li table thead tbody tfoot tr th td hr br section article header footer main nav aside h1 h2 h3 h4 h5 h6 a img svg path g circle rect line polyline polygon ellipse title desc defs use".split(
    " ",
  ),
);
const ATTRIBUTES = new Set(
  "id class role title type name placeholder min max step minlength maxlength pattern inputmode autocomplete rows cols wrap multiple disabled readonly required checked selected open hidden tabindex for value width height viewbox fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset d points cx cy r rx ry x y x1 y1 x2 y2 opacity transform xmlns".split(
    " ",
  ),
);
const INPUTS = new Set([
  "text",
  "search",
  "password",
  "email",
  "url",
  "tel",
  "number",
  "range",
  "checkbox",
  "radio",
  "button",
]);
const BLOCKED = new Set([
  "script",
  "style",
  "link",
  "meta",
  "base",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "source",
  "track",
  "form",
  "canvas",
  "foreignobject",
]);

function error(code, message) {
  return new RuntimeError(code, message);
}
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  throw error(
    "INVALID_PLUGIN_UI",
    "Plugin UI protocol accepts only JSON values",
  );
}
function encode(value) {
  return JSON.stringify(canonical(value));
}
function copy(value) {
  return JSON.parse(encode(value));
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function integer(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}
function text(value, bytes = 256) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= bytes
  );
}
function scopeOf(value) {
  const keys = [
    "sessionId",
    "pluginId",
    "bundleSha",
    "pluginEpoch",
    "characterId",
    "chatId",
    "chatEpoch",
    "writerId",
    "writerFence",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    !keys
      .filter(
        (key) => !["pluginEpoch", "chatEpoch", "writerFence"].includes(key),
      )
      .every((key) => text(value[key])) ||
    !/^[a-f0-9]{64}$/.test(value.bundleSha) ||
    !integer(value.pluginEpoch) ||
    !integer(value.chatEpoch) ||
    !integer(value.writerFence, 1)
  )
    throw error(
      "INVALID_PLUGIN_UI_SCOPE",
      "Plugin UI requires an exact installed-plugin, chat and writer incarnation",
    );
  return copy(value);
}
function cssPlain(value) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\\r?\n/g, "")
    .replace(/\\([a-f\d]{1,6})\s?/gi, (_match, hex) =>
      String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)),
    )
    .replace(/\\([^\r\n])/g, "$1")
    .toLowerCase();
}
function safeCssValue(value) {
  return !/(?:url\s*\(|image-set\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|@import|@namespace|@charset|behavior\s*:|-moz-binding|[\0<>])/i.test(
    cssPlain(value),
  );
}
function sanitizeCss(source) {
  if (typeof source !== "string") return "";
  let ast;
  try {
    ast = cssTools.parse(source);
  } catch {
    throw error(
      "INVALID_PLUGIN_UI_CSS",
      "Original plugin UI has unsupported CSS syntax",
    );
  }
  function declarations(values) {
    return (values || []).filter(
      (item) =>
        item.type === "declaration" &&
        !/^(?:behavior|-moz-binding)$/i.test(item.property) &&
        safeCssValue(item.property + ":" + item.value),
    );
  }
  function rules(values) {
    return (values || []).flatMap((rule) => {
      if (rule.type === "rule")
        return rule.selectors.every(safeCssValue)
          ? [{ ...rule, declarations: declarations(rule.declarations) }]
          : [];
      if (["media", "supports", "document", "host"].includes(rule.type)) {
        if (
          rule.type === "document" ||
          !safeCssValue(rule.media || rule.supports || "")
        )
          return [];
        return [{ ...rule, rules: rules(rule.rules) }];
      }
      if (rule.type === "keyframes")
        return [
          {
            ...rule,
            keyframes: (rule.keyframes || []).map((frame) => ({
              ...frame,
              declarations: declarations(frame.declarations),
            })),
          },
        ];
      if (rule.type === "font-face")
        return [{ ...rule, declarations: declarations(rule.declarations) }];
      return [];
    });
  }
  ast.stylesheet.rules = rules(ast.stylesheet.rules);
  return cssTools.stringify(ast, { compress: true });
}
function sanitizeInlineStyle(source) {
  const result = sanitizeCss(`x{${source}}`);
  return result.startsWith("x{") && result.endsWith("}")
    ? result.slice(2, -1)
    : "";
}

function listenerPrototype(window) {
  for (
    let prototype = Object.getPrototypeOf(window.document);
    prototype;
    prototype = Object.getPrototypeOf(prototype)
  )
    if (
      Object.hasOwn(prototype, "addEventListener") &&
      Object.hasOwn(prototype, "removeEventListener")
    )
      return prototype;
  throw error(
    "PLUGIN_UI_DOM_REQUIRED",
    "Server DOM must expose its event target prototype",
  );
}
function installTracker(window, handlers) {
  const prototype = listenerPrototype(window);
  let registry = EVENT_PROTOTYPES.get(prototype);
  if (!registry) {
    registry = {
      originalAdd: prototype.addEventListener,
      originalRemove: prototype.removeEventListener,
      sessions: new Map(),
    };
    const session = (target) => {
      const owner =
        target?.ownerDocument?.defaultView ?? target?.defaultView ?? target;
      return registry.sessions.get(owner);
    };
    registry.add = function (...args) {
      const handler = session(this);
      return (handler?.add ?? registry.originalAdd).apply(this, args);
    };
    registry.remove = function (...args) {
      const handler = session(this);
      return (handler?.remove ?? registry.originalRemove).apply(this, args);
    };
    prototype.addEventListener = registry.add;
    prototype.removeEventListener = registry.remove;
    EVENT_PROTOTYPES.set(prototype, registry);
  }
  registry.sessions.set(window, handlers);
  return {
    originalAdd: registry.originalAdd,
    originalRemove: registry.originalRemove,
    stop() {
      registry.sessions.delete(window);
      if (registry.sessions.size) return;
      if (prototype.addEventListener === registry.add)
        prototype.addEventListener = registry.originalAdd;
      if (prototype.removeEventListener === registry.remove)
        prototype.removeEventListener = registry.originalRemove;
      EVENT_PROTOTYPES.delete(prototype);
    },
  };
}

function installOptionInsertions(window) {
  let prototype = Object.getPrototypeOf(window.document.documentElement);
  let keys;
  while (prototype) {
    keys = Object.getOwnPropertySymbols(prototype).filter(
      (key) =>
        ["appendChild", "insertBefore"].includes(key.description) &&
        typeof prototype[key] === "function",
    );
    if (keys.length === 2) break;
    prototype = Object.getPrototypeOf(prototype);
  }
  if (!prototype) return () => {};
  let registry = SELECT_PROTOTYPES.get(prototype);
  if (!registry) {
    registry = { owners: new Set(), methods: [] };
    function selectedOptions(node, result = []) {
      if (node?.tagName === "OPTION" && node.selected) result.push(node);
      for (const child of node?.childNodes ?? [])
        selectedOptions(child, result);
      return result;
    }
    for (const key of keys) {
      const original = prototype[key];
      const wrapped = function (...args) {
        const selected = registry.owners.has(this.ownerDocument?.defaultView)
          ? selectedOptions(args[0])
          : [];
        const result = original.apply(this, args);
        // HappyDOM 20.1.0 confuses selected-option count with option index while
        // connecting a preselected option. During connection its selector cache
        // can also be stale. Reapply the actual incoming selected properties
        // after insertion completes, using the original option setter against
        // the complete tree. No plugin-specific value or handler is fabricated.
        for (const option of selected) {
          const select = option.closest("select");
          if (select && registry.owners.has(select.ownerDocument?.defaultView))
            option.selected = true;
        }
        return result;
      };
      registry.methods.push({ key, original, wrapped });
      prototype[key] = wrapped;
    }
    SELECT_PROTOTYPES.set(prototype, registry);
  }
  registry.owners.add(window);
  return () => {
    registry.owners.delete(window);
    if (registry.owners.size) return;
    for (const { key, original, wrapped } of registry.methods)
      if (prototype[key] === wrapped) prototype[key] = original;
    SELECT_PROTOTYPES.delete(prototype);
  };
}

function installSelectSemantics(window) {
  const prototype = window.HTMLSelectElement?.prototype;
  if (!prototype) return () => {};
  let base = prototype,
    descriptor;
  while (
    base &&
    !(descriptor = Object.getOwnPropertyDescriptor(base, "selectedOptions"))
  )
    base = Object.getPrototypeOf(base);
  if (typeof descriptor?.get !== "function") return () => {};
  const previous = Object.getOwnPropertyDescriptor(
    prototype,
    "selectedOptions",
  );
  const restoreInsertions = installOptionInsertions(window);
  const collections = new WeakMap();
  // HappyDOM caches selectedOptions by its unchanged option-node list. Changing
  // an option's selected property does not invalidate that cache. Keep the
  // original collection's type, but read its contents from current properties.
  Object.defineProperty(prototype, "selectedOptions", {
    configurable: true,
    get() {
      const identity = nodeIdentity(this);
      let collection = collections.get(identity);
      if (!collection) {
        const select = this;
        const current = () =>
          Array.from(select.options).filter((option) => option.selected);
        collection = new Proxy(descriptor.get.call(this), {
          get(target, key) {
            if (key === "length") return current().length;
            if (key === Symbol.iterator)
              return function* () {
                yield* current();
              };
            if (key === "item") return (index) => current()[index] ?? null;
            if (key === "namedItem")
              return (name) =>
                current().find(
                  (option) =>
                    option.id === name || option.getAttribute("name") === name,
                ) ?? null;
            if (typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key))
              return current()[Number(key)];
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        collections.set(identity, collection);
      }
      return collection;
    },
  });
  return () => {
    if (previous) Object.defineProperty(prototype, "selectedOptions", previous);
    else delete prototype.selectedOptions;
    restoreInsertions();
  };
}

/**
 * One original DOM/engine writer in an isolated native process. UI events call
 * the original server closures; the browser receives only sanitized render data.
 * Create this session before original plugin boot so listeners are tracked.
 * Authentication and SQLite fencing live in the required guard/receipt adapter.
 */
function createPluginUISession(window, options) {
  if (
    !window?.document ||
    typeof window.EventTarget?.prototype?.addEventListener !== "function"
  )
    throw error(
      "PLUGIN_UI_DOM_REQUIRED",
      "An actual server DOM implementation is required",
    );
  const scope = scopeOf(options?.scope);
  if (
    typeof options.guard !== "function" ||
    typeof options.settle !== "function" ||
    typeof options.checkpoint !== "function" ||
    !["read", "admit", "complete", "fail"].every(
      (method) => typeof options.receipts?.[method] === "function",
    )
  )
    throw error(
      "PLUGIN_UI_HOST_REQUIRED",
      "Plugin UI requires fenced guard, original lifecycle, atomic checkpoint and durable event receipts",
    );
  if (WINDOWS.has(window))
    throw error(
      "PLUGIN_UI_OWNER_EXISTS",
      "This original DOM already has a UI owner",
    );
  const limits = {
    htmlBytes: 1024 * 1024,
    styleBytes: 256 * 1024,
    nodes: 10000,
    valueBytes: 65536,
    ...options.limits,
  };
  if (Object.values(limits).some((value) => !integer(value, 1)))
    throw error(
      "INVALID_PLUGIN_UI_LIMIT",
      "Plugin UI budgets must be positive safe integers",
    );
  WINDOWS.set(window, scope.sessionId);
  const ids = new WeakMap(),
    listeners = new WeakMap(),
    pending = new Set();
  let elements = new Map(),
    revision = 0,
    signature,
    view,
    failure,
    closed = false,
    busy = false,
    tail = Promise.resolve();
  const scopeHash = encode(scope);
  let tracker, originalAdd, originalRemove;
  function fail(cause) {
    if (!failure) {
      failure = cause instanceof Error ? cause : new Error(String(cause));
      try {
        options.onFailure?.(failure);
      } catch {}
    }
    return failure;
  }
  function healthy() {
    if (failure) throw failure;
    if (closed)
      throw error("PLUGIN_UI_CLOSED", "Original plugin UI session is closed");
    options.signal?.throwIfAborted();
  }
  async function guard() {
    healthy();
    await options.guard(copy(scope));
    healthy();
  }
  function queue(operation) {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }
  function registrations(target, type) {
    const identity = nodeIdentity(target);
    let types = listeners.get(identity);
    if (!types) listeners.set(identity, (types = new Map()));
    let entries = types.get(type);
    if (!entries) types.set(type, (entries = []));
    return entries;
  }
  const patchedAdd = function (type, listener, argument) {
    if (!listener || closed)
      return originalAdd.call(this, type, listener, argument);
    const capture =
      typeof argument === "boolean" ? argument : !!argument?.capture;
    const entries = registrations(this, String(type));
    const previous = entries.find(
      (entry) => entry.listener === listener && entry.capture === capture,
    );
    if (previous) return;
    const target = this;
    const registration = { listener, capture, wrapped: null };
    registration.wrapped = function (event) {
      if (argument?.once) entries.splice(entries.indexOf(registration), 1);
      if (closed || failure || options.signal?.aborted) return;
      try {
        const result =
          typeof listener === "function"
            ? listener.call(target, event)
            : listener.handleEvent(event);
        if (result?.then) {
          const task = Promise.resolve(result)
            .catch((cause) => {
              throw fail(cause);
            })
            .finally(() => pending.delete(task));
          pending.add(task);
          task.catch(() => {});
        }
        return result;
      } catch (cause) {
        throw fail(cause);
      }
    };
    entries.push(registration);
    return originalAdd.call(this, type, registration.wrapped, argument);
  };
  const patchedRemove = function (type, listener, argument) {
    const capture =
      typeof argument === "boolean" ? argument : !!argument?.capture;
    const entries = registrations(this, String(type));
    const index = entries.findIndex(
      (entry) => entry.listener === listener && entry.capture === capture,
    );
    if (index < 0) return originalRemove.call(this, type, listener, argument);
    const registration = entries.splice(index, 1)[0];
    return originalRemove.call(this, type, registration.wrapped, argument);
  };
  tracker = installTracker(window, { add: patchedAdd, remove: patchedRemove });
  originalAdd = tracker.originalAdd;
  originalRemove = tracker.originalRemove;
  const restoreSelect = installSelectSemantics(window);

  function nativeValueSync(element) {
    if (disabled(element) || element.readOnly) return false;
    if (["TEXTAREA", "SELECT"].includes(element.tagName)) return true;
    if (element.tagName !== "INPUT") return false;
    const type = element.type.toLowerCase();
    return INPUTS.has(type) && type !== "button";
  }
  function eventTypes(element) {
    const result = [];
    for (const type of TYPES) {
      // Original modal forms can read .value only in their save callback,
      // without registering an input listener. These narrowly scoped native
      // events synchronize that connected, editable control's own properties;
      // they do not admit an unregistered click or keyboard handler.
      let found =
        nativeValueSync(element) && ["input", "change", "blur"].includes(type);
      for (let target = element; target; target = target.parentNode) {
        if (
          listeners.get(nodeIdentity(target))?.get(type)?.length ||
          typeof target["on" + type] === "function"
        ) {
          found = true;
          break;
        }
      }
      if (found) result.push(type);
    }
    return result;
  }
  function disabled(element) {
    return (
      !!element.disabled ||
      element.closest("[inert]") ||
      (element.closest("fieldset[disabled]") && element.tagName !== "LEGEND")
    );
  }
  function form(element, clone) {
    if (element.tagName === "INPUT") {
      const type = element.type.toLowerCase();
      if (!INPUTS.has(type)) {
        clone.setAttribute("disabled", "");
        clone.setAttribute(
          "data-risu-plugin-unavailable",
          type === "file" ? "file-transfer" : "input-type",
        );
        return false;
      }
      clone.setAttribute("type", type);
      clone.setAttribute("value", element.value);
      if (["checkbox", "radio"].includes(type)) {
        if (element.checked) clone.setAttribute("checked", "");
        else clone.removeAttribute("checked");
      }
      if (element.indeterminate)
        clone.setAttribute("data-risu-plugin-indeterminate", "true");
    }
    if (element.tagName === "TEXTAREA") clone.textContent = element.value;
    if (element.tagName === "OPTION") {
      if (element.selected) clone.setAttribute("selected", "");
      else clone.removeAttribute("selected");
    }
    return true;
  }
  function render() {
    healthy();
    const nextElements = new Map();
    const controlStates = [];
    const document = window.document;
    const cloneDocument = document.implementation.createHTMLDocument("");
    let nodes = 0;
    function cloneNode(original) {
      if (original.nodeType === 3)
        return cloneDocument.createTextNode(original.textContent ?? "");
      if (original.nodeType !== 1) return null;
      if (++nodes > limits.nodes)
        throw error(
          "PLUGIN_UI_LIMIT",
          "Original plugin UI exceeds its node budget",
        );
      const tag = original.tagName.toLowerCase();
      if (BLOCKED.has(tag)) return null;
      if (!TAGS.has(tag)) {
        const fragment = cloneDocument.createDocumentFragment();
        for (const child of original.childNodes) {
          const cloned = cloneNode(child);
          if (cloned) fragment.appendChild(cloned);
        }
        return fragment;
      }
      const clone =
        original.namespaceURI === "http://www.w3.org/2000/svg"
          ? cloneDocument.createElementNS(
              original.namespaceURI,
              original.tagName,
            )
          : cloneDocument.createElement(tag);
      for (const attribute of original.attributes) {
        const name = attribute.name.toLowerCase(),
          value = attribute.value;
        if (
          name.startsWith("on") ||
          name.startsWith("data-risu-plugin-") ||
          name === "srcdoc"
        )
          continue;
        if (name === "style") {
          const style = sanitizeInlineStyle(value);
          if (style) clone.setAttribute("style", style);
          continue;
        }
        if (
          name === "src" &&
          tag === "img" &&
          /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(
            value,
          ) &&
          Buffer.byteLength(value) <= limits.htmlBytes / 4
        ) {
          clone.setAttribute("src", value);
          continue;
        }
        if (
          (name === "href" || name === "xlink:href") &&
          tag === "use" &&
          /^#[a-z\d_-]+$/i.test(value)
        ) {
          clone.setAttribute("href", value);
          continue;
        }
        if (
          ATTRIBUTES.has(name) ||
          /^aria-[a-z\d-]+$/.test(name) ||
          /^data-(?:wl|at)-[a-z\d-]+$/.test(name) ||
          name === "data-tab"
        )
          clone.setAttribute(attribute.name, value);
      }
      const inputSupported = form(original, clone);
      if (tag !== "textarea")
        for (const child of original.childNodes) {
          const cloned = cloneNode(child);
          if (cloned) clone.appendChild(cloned);
        }
      const identity = nodeIdentity(original);
      let id = ids.get(identity);
      if (!id) {
        id = randomUUID();
        ids.set(identity, id);
      }
      nextElements.set(id, original);
      clone.setAttribute(NODE_ATTRIBUTE, id);
      if (["INPUT", "TEXTAREA", "SELECT"].includes(original.tagName))
        controlStates.push({
          nodeId: id,
          tag: original.tagName,
          type: original.tagName === "INPUT" ? original.type : "",
          value: original.value,
          checked: original.tagName === "INPUT" ? original.checked : false,
          indeterminate:
            original.tagName === "INPUT" ? original.indeterminate : false,
          selectedValues:
            original.tagName === "SELECT"
              ? Array.from(original.selectedOptions, (option) => option.value)
              : [],
          selectedIndex:
            original.tagName === "SELECT" ? original.selectedIndex : -1,
        });
      const events =
        inputSupported && !disabled(original) ? eventTypes(original) : [];
      if (events.length) clone.setAttribute(EVENT_ATTRIBUTE, events.join(" "));
      if (nativeValueSync(original))
        clone.setAttribute("data-risu-plugin-value-sync", "true");
      // No browser-native submit/navigation occurs when the trusted forwarder
      // sends click to the original server closure.
      if (tag === "button") clone.setAttribute("type", "button");
      return clone;
    }
    for (const child of document.body.childNodes) {
      const clone = cloneNode(child);
      if (clone) cloneDocument.body.appendChild(clone);
    }
    const html = cloneDocument.body.innerHTML;
    const styles = Array.from(
      document.head.querySelectorAll("style"),
      (element) => sanitizeCss(element.textContent || ""),
    );
    if (
      Buffer.byteLength(html) > limits.htmlBytes ||
      styles.reduce((sum, style) => sum + Buffer.byteLength(style), 0) >
        limits.styleBytes
    )
      throw error(
        "PLUGIN_UI_LIMIT",
        "Original plugin UI exceeds its render byte budget",
      );
    const nextSignature = digest(
      encode({
        html,
        styles,
        controlStates,
        busy,
        visible: options.visible?.() ?? true,
      }),
    );
    if (signature !== nextSignature) {
      signature = nextSignature;
      revision++;
    }
    elements = nextElements;
    view = {
      scope: copy(scope),
      revision,
      html,
      styles,
      controlStates,
      visible: options.visible?.() ?? true,
      busy,
      capabilities: {
        events: [...TYPES],
        nativeFormValueSync: true,
        fileTransfers: false,
        layoutFeedback: false,
        pluginJavaScript: false,
      },
    };
    return copy(view);
  }
  async function settle() {
    while (pending.size) {
      await Promise.all([...pending]);
      healthy();
    }
    await options.settle();
    healthy();
  }
  function validateRequest(request) {
    const allowed = [
      "scope",
      "revision",
      "eventId",
      "nodeId",
      "type",
      "value",
      "checked",
      "selectedValues",
      "key",
    ];
    if (
      !request ||
      typeof request !== "object" ||
      Object.keys(request).some((key) => !allowed.includes(key))
    )
      throw error(
        "INVALID_PLUGIN_UI_EVENT",
        "Plugin UI event contains unknown fields",
      );
    if (encode(scopeOf(request.scope)) !== scopeHash)
      throw error(
        "PLUGIN_UI_SCOPE_CHANGED",
        "Plugin UI writer or chat scope differs",
      );
    if (
      !integer(request.revision, 1) ||
      !/^plugin-ui:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        request.eventId,
      ) ||
      !text(request.nodeId) ||
      !TYPES.has(request.type)
    )
      throw error(
        "INVALID_PLUGIN_UI_EVENT",
        "Plugin UI event identity or type is invalid",
      );
    if (
      request.value !== undefined &&
      (typeof request.value !== "string" ||
        Buffer.byteLength(request.value) > limits.valueBytes)
    )
      throw error(
        "INVALID_PLUGIN_UI_VALUE",
        "Plugin UI value exceeds its text budget",
      );
    if (request.checked !== undefined && typeof request.checked !== "boolean")
      throw error(
        "INVALID_PLUGIN_UI_VALUE",
        "Plugin UI checked value must be boolean",
      );
    if (
      request.selectedValues !== undefined &&
      (!Array.isArray(request.selectedValues) ||
        request.selectedValues.length > 1024 ||
        request.selectedValues.some(
          (value) =>
            typeof value !== "string" ||
            Buffer.byteLength(value) > limits.valueBytes,
        ) ||
        new Set(request.selectedValues).size !== request.selectedValues.length)
    )
      throw error(
        "INVALID_PLUGIN_UI_VALUE",
        "Plugin UI selected values are invalid",
      );
    if (
      request.type === "keydown"
        ? !["Escape", "Enter", "Tab"].includes(request.key)
        : request.key !== undefined
    )
      throw error(
        "INVALID_PLUGIN_UI_EVENT",
        "Plugin UI keyboard key is unsupported",
      );
    return copy(request);
  }
  function validateTarget(request) {
    if (request.revision !== revision)
      throw error(
        "PLUGIN_UI_REVISION_CHANGED",
        "Original plugin UI changed; obtain a fresh snapshot",
      );
    const target = elements.get(request.nodeId);
    if (!target?.isConnected || target.ownerDocument !== window.document)
      throw error(
        "PLUGIN_UI_NODE_CHANGED",
        "Original plugin UI element no longer exists",
      );
    if (disabled(target))
      throw error(
        "PLUGIN_UI_DISABLED",
        "Original plugin UI element is disabled",
      );
    if (!eventTypes(target).includes(request.type))
      throw error(
        "INVALID_PLUGIN_UI_EVENT",
        "Original plugin UI does not allow this event",
      );
    const tag = target.tagName;
    const formTarget = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
    const type = tag === "INPUT" ? target.type.toLowerCase() : "";
    if (tag === "INPUT" && !INPUTS.has(type))
      throw error(
        "PLUGIN_UI_CAPABILITY_REQUIRED",
        "This original input requires an additional transfer capability",
      );
    if (
      (request.value !== undefined ||
        request.checked !== undefined ||
        request.selectedValues !== undefined) &&
      (!formTarget ||
        target.readOnly ||
        !["input", "change", "blur", "keydown"].includes(request.type))
    )
      throw error(
        "INVALID_PLUGIN_UI_VALUE",
        "Original plugin UI target cannot accept a form value",
      );
    if (
      request.checked !== undefined &&
      (tag !== "INPUT" ||
        !["checkbox", "radio"].includes(type) ||
        request.value !== undefined ||
        request.selectedValues !== undefined)
    )
      throw error(
        "INVALID_PLUGIN_UI_VALUE",
        "Checked payload requires the original checkbox/radio target",
      );
    if (
      tag === "INPUT" &&
      ["checkbox", "radio"].includes(type) &&
      request.value !== undefined
    )
      throw error(
        "INVALID_PLUGIN_UI_VALUE",
        "Checkbox/radio text value cannot be changed by an event",
      );
    if (
      (["input", "change"].includes(request.type) ||
        (request.type === "blur" && nativeValueSync(target))) &&
      (!formTarget ||
        (tag === "INPUT" && ["checkbox", "radio"].includes(type)
          ? request.checked === undefined
          : request.value === undefined &&
            request.selectedValues === undefined))
    )
      throw error(
        "INVALID_PLUGIN_UI_VALUE",
        "Original form event requires its actual control value",
      );
    if (
      request.selectedValues !== undefined &&
      (tag !== "SELECT" ||
        !target.multiple ||
        request.value !== undefined ||
        request.checked !== undefined)
    )
      throw error(
        "INVALID_PLUGIN_UI_VALUE",
        "Selected-values payload requires the original multiple select",
      );
    if (
      tag === "SELECT" &&
      (request.value !== undefined || request.selectedValues !== undefined)
    ) {
      const values = request.selectedValues ?? [request.value];
      if (target.multiple && request.selectedValues === undefined)
        throw error(
          "INVALID_PLUGIN_UI_VALUE",
          "Multiple select requires all actual selected values",
        );
      for (const value of values)
        if (
          !Array.from(target.options).some(
            (option) =>
              option.value === value &&
              !option.disabled &&
              !option.closest("optgroup[disabled]"),
          )
        )
          throw error(
            "INVALID_PLUGIN_UI_VALUE",
            "Selected value is not an enabled original option",
          );
    }
    if (
      request.value !== undefined &&
      tag === "INPUT" &&
      ["number", "range"].includes(type)
    ) {
      const value = Number(request.value);
      if (
        !Number.isFinite(value) ||
        !request.value.trim() ||
        (target.min && value < Number(target.min)) ||
        (target.max && value > Number(target.max))
      )
        throw error(
          "INVALID_PLUGIN_UI_VALUE",
          "Numeric value is outside the original control range",
        );
    }
    if (
      request.value !== undefined &&
      tag !== "SELECT" &&
      target.maxLength >= 0 &&
      request.value.length > target.maxLength
    )
      throw error(
        "INVALID_PLUGIN_UI_VALUE",
        "Text exceeds the original control maxlength",
      );
    return target;
  }
  async function dispatch(rawRequest) {
    const request = validateRequest(rawRequest);
    const requestHash = digest(encode(request));
    return queue(async () => {
      await guard();
      const prior = await options.receipts.read(copy(scope), request.eventId);
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw error(
            "IDEMPOTENCY_CONFLICT",
            "Plugin UI event ID was reused with different input",
          );
        if (prior.state !== "completed")
          throw error(
            "PLUGIN_UI_EVENT_UNCERTAIN",
            "Original plugin UI event was admitted without a confirmed completion; automatic replay is disabled",
          );
        return {
          eventId: request.eventId,
          appliedRevision: prior.appliedRevision,
          replayed: true,
          snapshot: render(),
        };
      }
      // Original panels can start a queued session synchronization without
      // returning its promise from their DOM handler. The host's lifecycle
      // seam waits for that exact original tail before accepting new values.
      if (options.prepareEvent) await options.prepareEvent();
      else await settle();
      await guard();
      render(); // Detect original timer/property changes before accepting stale DOM.
      const target = validateTarget(request);
      const admitted = await options.receipts.admit(copy(scope), {
        eventId: request.eventId,
        requestHash,
        revision,
        nodeId: request.nodeId,
        type: request.type,
      });
      if (
        !admitted ||
        admitted.requestHash !== requestHash ||
        admitted.state !== "admitted"
      )
        throw error(
          "PLUGIN_UI_EVENT_UNCERTAIN",
          "Plugin UI event admission is not confirmed",
        );
      busy = true;
      try {
        await guard();
        if (request.value !== undefined) target.value = request.value;
        if (request.checked !== undefined) target.checked = request.checked;
        if (request.selectedValues !== undefined)
          for (const option of target.options)
            option.selected = request.selectedValues.includes(option.value);
        const event =
          request.type === "keydown"
            ? new window.KeyboardEvent("keydown", {
                key: request.key,
                bubbles: true,
                cancelable: true,
              })
            : request.type === "click"
              ? new window.MouseEvent("click", {
                  bubbles: true,
                  cancelable: true,
                })
              : new window.Event(request.type, {
                  bubbles: request.type !== "blur",
                  cancelable: true,
                });
        target.dispatchEvent(event);
        await settle();
        await guard();
        const snapshot = render();
        await options.checkpoint({
          scope: copy(scope),
          eventId: request.eventId,
          requestHash,
          appliedRevision: snapshot.revision,
        });
        await guard();
        const completed = await options.receipts.complete(copy(scope), {
          eventId: request.eventId,
          requestHash,
          appliedRevision: snapshot.revision,
        });
        if (
          !completed ||
          completed.state !== "completed" ||
          completed.requestHash !== requestHash ||
          completed.appliedRevision !== snapshot.revision
        )
          throw error(
            "PLUGIN_UI_EVENT_UNCERTAIN",
            "Plugin UI acknowledgement is not confirmed",
          );
        busy = false;
        return {
          eventId: request.eventId,
          appliedRevision: snapshot.revision,
          replayed: false,
          snapshot: render(),
        };
      } catch (cause) {
        busy = false;
        fail(cause);
        try {
          await options.receipts.fail(copy(scope), {
            eventId: request.eventId,
            requestHash,
            code: cause.code ?? "PLUGIN_UI_EXECUTION_FAILED",
          });
        } catch {}
        throw cause;
      }
    });
  }
  function close() {
    if (closed) return;
    closed = true;
    tracker.stop();
    restoreSelect();
    WINDOWS.delete(window);
    elements.clear();
    options.signal?.removeEventListener("abort", aborted);
  }
  function aborted() {
    fail(
      options.signal.reason ??
        error("PLUGIN_UI_CANCELLED", "Plugin UI owner was cancelled"),
    );
    close();
  }
  options.signal?.addEventListener("abort", aborted, { once: true });
  return {
    snapshot: (request = {}) => {
      const read = async () => {
        await guard();
        return render();
      };
      return request.whileBusy === true ? read() : queue(read);
    },
    dispatch,
    scope: copy(scope),
    nodeId: (element) => ids.get(nodeIdentity(element)) ?? null,
    assertHealthy: healthy,
    /** Discards this view; owner must abort unfinished work and release its lease. */
    close,
    /** Complete original callbacks/checkpoint before coordinator lease release. */
    closeAndCheckpoint: () =>
      queue(async () => {
        await guard();
        await settle();
        await options.checkpoint();
        await guard();
        close();
      }),
  };
}

function pluginUiPreviewDocument(snapshot) {
  if (
    !snapshot ||
    typeof snapshot.html !== "string" ||
    !Array.isArray(snapshot.styles)
  )
    throw error("INVALID_PLUGIN_UI", "Plugin UI snapshot is required");
  // Output from the session is already sanitized. This helper is deliberately
  // script-free. The actual browser host supplies its separately trusted renderer
  // and a nonce/source-checked MessageChannel in an opaque sandbox iframe.
  const styles = snapshot.styles
    .map((style) => `<style>${sanitizeCss(style)}</style>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">${styles}</head><body>${snapshot.html}</body></html>`;
}

module.exports = {
  createPluginUISession,
  sanitizeCss,
  sanitizeInlineStyle,
  pluginUiPreviewDocument,
  NODE_ATTRIBUTE,
  EVENT_ATTRIBUTE,
};
