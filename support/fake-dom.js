export class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail ?? null;
    this.bubbles = options.bubbles ?? false;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    Object.assign(this, options);
  }

  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

class FakeStyle {
  constructor() {
    this.values = new Map();
    this.cssText = "";
  }

  setProperty(name, value) {
    this.values.set(name, String(value));
  }

  removeProperty(name) {
    const previous = this.values.get(name) ?? "";
    this.values.delete(name);
    return previous;
  }

  getPropertyValue(name) {
    return this.values.get(name) ?? "";
  }
}

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  toggle(name, force) {
    const names = new Set((this.element.getAttribute("class") ?? "").split(/\s+/u).filter(Boolean));
    const enabled = force == null ? !names.has(name) : Boolean(force);
    if (enabled) names.add(name);
    else names.delete(name);
    if (names.size) this.element.setAttribute("class", [...names].join(" "));
    else this.element.removeAttribute("class");
    return enabled;
  }

  contains(name) {
    return (this.element.getAttribute("class") ?? "").split(/\s+/u).includes(name);
  }
}

export class FakeNode {
  constructor(ownerDocument, nodeType) {
    this.ownerDocument = ownerDocument;
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }

  get isConnected() {
    let current = this;
    while (current) {
      if (current.nodeType === 9) return true;
      current = current.parentNode;
    }
    return false;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] ?? null;
  }

  get nextElementSibling() {
    let current = this.nextSibling;
    while (current && current.nodeType !== 1) current = current.nextSibling;
    return current;
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  insertBefore(node, before) {
    if (node.nodeType === 11) {
      const children = [...node.childNodes];
      for (const child of children) this.insertBefore(child, before);
      return node;
    }
    if (before != null && before.parentNode !== this) throw new Error("NotFoundError");
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = before == null ? this.childNodes.length : this.childNodes.indexOf(before);
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index < 0) throw new Error("NotFoundError");
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    for (const node of nodes) this.appendChild(node);
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  contains(node) {
    for (let current = node ?? null; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  get textContent() {
    if (this.nodeType === 3) return this.data;
    if (this.nodeType === 8) return "";
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    if (this.nodeType === 3) {
      this.data = String(value ?? "");
      return;
    }
    this.replaceChildren();
    if (value != null && value !== "") this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }
}

class FakeText extends FakeNode {
  constructor(ownerDocument, data) {
    super(ownerDocument, 3);
    this.data = String(data);
  }
}

class FakeComment extends FakeNode {
  constructor(ownerDocument, data) {
    super(ownerDocument, 8);
    this.data = String(data);
  }
}

class FakeFragment extends FakeNode {
  constructor(ownerDocument) {
    super(ownerDocument, 11);
  }
}

export class FakeElement extends FakeNode {
  constructor(ownerDocument, tagName, namespaceURI = null) {
    super(ownerDocument, 1);
    this.tagName = String(tagName).toUpperCase();
    this.localName = String(tagName).toLowerCase();
    this.namespaceURI = namespaceURI;
    this.attributes = new Map();
    this.style = new FakeStyle();
    this.classList = new FakeClassList(this);
    this.listeners = new Map();
    this.value = "";
    this.checked = false;
    this.selected = false;
    this.disabled = false;
    this.dataset = Object.create(null);
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (name === "data-target") this.dataset.target = String(value);
    if (name === "data-state") this.dataset.state = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name));
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  addEventListener(type, listener, options = {}) {
    const entry = { listener, options };
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(entry);
    options.signal?.addEventListener?.("abort", () => this.listeners.get(type)?.delete(entry), { once: true });
  }

  removeEventListener(type, listener) {
    const entries = this.listeners.get(type);
    if (!entries) return;
    for (const entry of entries) if (entry.listener === listener) entries.delete(entry);
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    for (const entry of [...(this.listeners.get(event.type) ?? [])]) {
      entry.listener.call(this, event);
      if (entry.options?.once) this.listeners.get(event.type)?.delete(entry);
    }
    if (event.bubbles && !event.propagationStopped) this.parentNode?.dispatchEvent?.(event);
    return !event.defaultPrevented;
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }
}

function descendants(root) {
  const output = [];
  for (const child of root.childNodes) {
    if (child.nodeType === 1) output.push(child);
    output.push(...descendants(child));
  }
  return output;
}

function matches(element, selector) {
  if (selector.startsWith("#")) return element.getAttribute("id") === selector.slice(1);
  if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
  const attribute = selector.match(/^([\w-]+)?\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/u);
  if (attribute) {
    const [, tag, name, value] = attribute;
    return (!tag || element.localName === tag.toLowerCase())
      && element.hasAttribute(name)
      && (value == null || element.getAttribute(name) === value);
  }
  return element.localName === selector.toLowerCase();
}

function queryAll(root, selector) {
  return descendants(root).filter((element) => matches(element, selector));
}

class FakeWindow {
  constructor() {
    this.AbortController = globalThis.AbortController;
    this.CustomEvent = FakeEvent;
    this.listeners = new Map();
    this.location = { pathname: "/", search: "", hash: "" };
    this.history = {
      state: null,
      pushState: (state, _title, url) => this.updateLocation(state, url),
      replaceState: (state, _title, url) => this.updateLocation(state, url),
    };
    this.setTimeout = globalThis.setTimeout.bind(globalThis);
    this.clearTimeout = globalThis.clearTimeout.bind(globalThis);
    this.setInterval = globalThis.setInterval.bind(globalThis);
    this.clearInterval = globalThis.clearInterval.bind(globalThis);
  }

  updateLocation(state, url) {
    const parsed = new URL(url, "https://jlc.test");
    this.history.state = state;
    this.location.pathname = parsed.pathname;
    this.location.search = parsed.search;
    this.location.hash = parsed.hash;
  }

  addEventListener(type, listener, options = {}) {
    const entry = { listener, options };
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(entry);
    options.signal?.addEventListener?.("abort", () => this.listeners.get(type)?.delete(entry), { once: true });
  }

  removeEventListener(type, listener) {
    for (const entry of this.listeners.get(type) ?? []) if (entry.listener === listener) this.listeners.get(type).delete(entry);
  }

  dispatchEvent(event) {
    for (const entry of [...(this.listeners.get(event.type) ?? [])]) entry.listener(event);
  }
}

export class FakeDocument extends FakeNode {
  constructor() {
    super(null, 9);
    this.ownerDocument = this;
    this.defaultView = new FakeWindow();
    this.documentElement = new FakeElement(this, "html");
    this.head = new FakeElement(this, "head");
    this.body = new FakeElement(this, "body");
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.title = "";
  }

  createElement(tagName) { return new FakeElement(this, tagName); }
  createElementNS(namespace, tagName) { return new FakeElement(this, tagName, namespace); }
  createTextNode(data) { return new FakeText(this, data); }
  createComment(data) { return new FakeComment(this, data); }
  createDocumentFragment() { return new FakeFragment(this); }
  querySelector(selector) { return queryAll(this, selector)[0] ?? null; }
  querySelectorAll(selector) { return queryAll(this, selector); }
}

export function createDOM() {
  const document = new FakeDocument();
  const target = document.createElement("div");
  target.setAttribute("id", "app");
  document.body.appendChild(target);
  return { document, window: document.defaultView, target };
}
