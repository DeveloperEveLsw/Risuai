type AuthoredAttribute = {
  namespace: string | null;
  name: string;
  localName: string;
  value: string;
};
const attributeKey = (attribute: Attr) =>
  JSON.stringify([attribute.namespaceURI, attribute.localName]);
const attributes = (element: Element) =>
  new Map(
    Array.from(element.attributes, (attribute) => [
      attributeKey(attribute),
      {
        namespace: attribute.namespaceURI,
        name: attribute.name,
        localName: attribute.localName,
        value: attribute.value,
      },
    ]),
  );
const compatible = (a: Node, b: Node) =>
  a.nodeType === b.nodeType &&
  (!(a instanceof Element) ||
    (b instanceof Element &&
      a.localName === b.localName &&
      a.namespaceURI === b.namespaceURI));

/** Patch already sanitized HTML in an owned sibling range. Authored attributes
 * stay separate from live input/image state; no captures or assets are owned here.
 */
export class StableDisplayDom {
  private start: Comment;
  private end: Comment;
  private html: string | undefined;
  private closed = false;
  private authored = new WeakMap<Element, Map<string, AuthoredAttribute>>();
  private textareaText = new WeakMap<HTMLTextAreaElement, string>();
  constructor(private root: HTMLElement) {
    this.start = root.ownerDocument.createComment("risu-display-start");
    this.end = root.ownerDocument.createComment("risu-display-end");
    root.append(this.start, this.end);
  }
  private key(node: Node, desired = false) {
    if (!(node instanceof Element)) return undefined;
    const id = desired
      ? node.getAttribute("id")
      : this.authored.get(node)?.get('[null,"id"]')?.value;
    return id
      ? JSON.stringify([node.namespaceURI, node.localName, id])
      : undefined;
  }
  private stamp(node: Node) {
    const pending = [node];
    while (pending.length) {
      const current = pending.pop();
      if (current instanceof Element)
        this.authored.set(current, attributes(current));
      if (current instanceof HTMLTextAreaElement)
        this.textareaText.set(current, current.textContent ?? "");
      for (const child of current.childNodes) pending.push(child);
    }
  }
  private patch(node: Node, desired: Node, depth: number) {
    if (!(node instanceof Element) || !(desired instanceof Element)) {
      if (node.nodeValue !== desired.nodeValue)
        node.nodeValue = desired.nodeValue;
      return;
    }
    const previous = this.authored.get(node) ?? attributes(node);
    const next = attributes(desired);
    for (const [key, attribute] of previous) {
      if (!next.has(key)) {
        if (attribute.name === "class")
          for (const token of attribute.value.split(/\s+/).filter(Boolean))
            node.classList.remove(token);
        else node.removeAttributeNS(attribute.namespace, attribute.localName);
      }
    }
    for (const [key, attribute] of next) {
      const before = previous.get(key);
      if (before?.value === attribute.value) continue;
      if (attribute.name === "class") {
        for (const token of (before?.value ?? "").split(/\s+/).filter(Boolean))
          node.classList.remove(token);
        for (const token of attribute.value.split(/\s+/).filter(Boolean))
          node.classList.add(token);
      } else
        node.setAttributeNS(
          attribute.namespace,
          attribute.name,
          attribute.value,
        );
    }
    const changed = (name: string) =>
      previous.get(JSON.stringify([null, name]))?.value !==
      next.get(JSON.stringify([null, name]))?.value;
    if (node instanceof HTMLImageElement && changed("src")) {
      // A new authored source invalidates the original named-image resolver's
      // transient status and style. Unchanged sources retain their loaded URL.
      node.removeAttribute("noimage");
      for (const name of Array.from(node.classList))
        if (
          name === "root-loaded-image" ||
          name.startsWith("root-loaded-image-")
        )
          node.classList.remove(name);
    }
    if (
      node instanceof HTMLInputElement &&
      desired instanceof HTMLInputElement
    ) {
      if (changed("value")) node.value = desired.value;
      if (changed("checked")) node.checked = desired.checked;
    }
    if (
      node instanceof HTMLOptionElement &&
      desired instanceof HTMLOptionElement
    )
      if (changed("selected")) node.selected = desired.selected;
    this.authored.set(node, next);
    if (depth < 128)
      this.children(
        node,
        Array.from(desired.childNodes),
        undefined,
        undefined,
        depth + 1,
      );
    else {
      // Deep authored trees retain their outer owner, with a replacement fallback
      // below the diff limit rather than recursive JavaScript stack exhaustion.
      while (node.firstChild) node.removeChild(node.firstChild);
      for (const child of desired.childNodes) {
        const copy = child.cloneNode(true);
        this.stamp(copy);
        node.appendChild(copy);
      }
    }
    if (
      node instanceof HTMLTextAreaElement &&
      desired instanceof HTMLTextAreaElement
    ) {
      const text = desired.textContent ?? "";
      if (this.textareaText.get(node) !== text) node.value = desired.value;
      this.textareaText.set(node, text);
    }
  }
  private children(
    parent: Node,
    desired: Node[],
    start?: Node,
    end?: Node,
    depth = 0,
  ) {
    const old: Node[] = [];
    for (
      let node = start ? start.nextSibling : parent.firstChild;
      node && node !== end;
      node = node.nextSibling
    )
      old.push(node);
    const unique = (nodes: Node[], isDesired: boolean) => {
      const map = new Map<string, Node | null>();
      for (const node of nodes) {
        const key = this.key(node, isDesired);
        if (key) map.set(key, map.has(key) ? null : node);
      }
      return map;
    };
    const oldKeys = unique(old, false),
      nextKeys = unique(desired, true);
    const used = new Set<Node>();
    let cursor = start ? start.nextSibling : parent.firstChild;
    for (let index = 0; index < desired.length; index++) {
      const target = desired[index],
        key = this.key(target, true);
      let node = key && nextKeys.get(key) ? oldKeys.get(key) : old[index];
      if (
        !node ||
        used.has(node) ||
        !compatible(node, target) ||
        (this.key(node) && this.key(node) !== key)
      ) {
        node = target.cloneNode(true);
        this.stamp(node);
      } else this.patch(node, target, depth);
      used.add(node);
      if (node !== cursor) parent.insertBefore(node, cursor ?? end ?? null);
      cursor = node.nextSibling;
    }
    for (const node of old) if (!used.has(node)) parent.removeChild(node);
  }
  update(html: string) {
    if (this.closed || html === this.html) return;
    const active = this.root.ownerDocument.activeElement;
    const focused =
      active instanceof HTMLElement && this.root.contains(active)
        ? active
        : undefined;
    const input =
      focused instanceof HTMLInputElement ||
      focused instanceof HTMLTextAreaElement
        ? focused
        : undefined;
    const selection = input && {
      value: input.value,
      start: input.selectionStart,
      end: input.selectionEnd,
      direction: input.selectionDirection,
    };
    const template = this.root.ownerDocument.createElement("template");
    template.innerHTML = html;
    this.children(
      this.root,
      Array.from(template.content.childNodes),
      this.start,
      this.end,
    );
    this.html = html;
    if (
      focused?.isConnected &&
      this.root.contains(focused) &&
      focused !== this.root.ownerDocument.activeElement
    ) {
      focused.focus({ preventScroll: true });
      if (
        selection &&
        input.value === selection.value &&
        selection.start !== null &&
        selection.end !== null
      )
        input.setSelectionRange(
          selection.start,
          selection.end,
          selection.direction ?? undefined,
        );
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (let node = this.start.nextSibling; node && node !== this.end;) {
      const next = node.nextSibling;
      node.parentNode?.removeChild(node);
      node = next;
    }
    this.start.remove();
    this.end.remove();
    this.html = undefined;
    this.authored = new WeakMap();
    this.textareaText = new WeakMap();
  }
}
