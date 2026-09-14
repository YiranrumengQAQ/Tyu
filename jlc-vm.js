/*
 * JLC Virtual Machine
 * A CSP-safe bytecode runtime for declarative web programs.
 * Copyright (c) 2026 JLC contributors. MIT licensed.
 *
 * This is the JLC-VM backend: it loads verified JLC bytecode modules
 * (.jbc), links them against a mount-time global table, and executes a
 * stack-based dispatch loop that drives Signals, Scopes, Effects and DOM.
 * It deliberately contains no Tokenizer or Parser: compiling JLC source
 * into bytecode is the job of jlc-compiler.js.
 */

export const VERSION = "0.2.0";
export const BYTECODE_VERSION = 1;
export const MAGIC = 0x4a4c4342; // "JLCB" — JLC Bytecode container

const CALLABLE = Symbol("jlc.callable");
const REQUEST = Symbol("jlc.request");
const RESOURCE_META = new WeakMap();
export const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const BLOCKED_TAGS = new Set(["script", "iframe", "object", "embed", "base", "meta"]);
export const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href", "xlinkhref"]);
export const BLOCKED_PROPERTIES = new Set(["innerhtml", "outerhtml", "srcdoc"]);
export const EVENT_MODIFIERS = ["prevent", "stop", "self", "once", "capture", "passive"];
export const EVENT_MODIFIER_BITS = { prevent: 1, stop: 2, self: 4, once: 8, capture: 16, passive: 32 };
export const BUILTIN_NAMES = [
  "len", "string", "number", "bool", "upper", "lower", "trim", "join", "slice", "at",
  "get", "has", "keys", "values", "entries", "range", "append", "prepend", "removeAt",
  "replaceAt", "merge", "json", "parseJson", "min", "max", "round", "floor", "ceil",
  "abs", "clamp", "now", "http", "reload", "navigate", "replace", "emit", "title",
];
export const NO_FUNC = 0xffff;

export class JLCCompileError extends SyntaxError {
  constructor(message, token, sourceName = "<jlc>") {
    const location = token ? `${sourceName}:${token.line}:${token.column}` : sourceName;
    super(`${location} ${message}`);
    this.name = "JLCCompileError";
    this.sourceName = sourceName;
    this.line = token?.line ?? 0;
    this.column = token?.column ?? 0;
    this.offset = token?.start ?? 0;
  }
}

export class JLCRuntimeError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "JLCRuntimeError";
  }
}

export class JLCVerifyError extends Error {
  constructor(message, moduleName = "<jbc>") {
    super(`${moduleName} ${message}`);
    this.name = "JLCVerifyError";
    this.moduleName = moduleName;
  }
}

/* ================================================================
 * 数据模型
 * ================================================================ */

export function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function sanitizeValue(value, seen = new WeakMap(), depth = 0) {
  if (value == null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") throw new JLCRuntimeError(`JLC 数据不能包含 ${typeof value}`);
  if (depth > 100) throw new JLCRuntimeError("数据嵌套超过 100 层");
  if (seen.has(value)) throw new JLCRuntimeError("JLC 数据必须是无循环的树");
  if (value[CALLABLE] || value[REQUEST]) {
    throw new JLCRuntimeError("action 和 request 描述符不能作为普通数据保存或导出");
  }

  const output = Array.isArray(value) ? [] : Object.create(null);
  seen.set(value, output);
  if (Array.isArray(value)) {
    if (value.length > 100_000) throw new JLCRuntimeError("单个数组不能超过 100000 项");
    for (const item of value) output.push(sanitizeValue(item, seen, depth + 1));
  } else {
    const entries = Object.entries(value);
    if (entries.length > 10_000) throw new JLCRuntimeError("单个对象不能超过 10000 个字段");
    for (const [key, child] of entries) {
      if (!BLOCKED_KEYS.has(key)) output[key] = sanitizeValue(child, seen, depth + 1);
    }
  }
  return output;
}

function safeKey(value) {
  const key = String(value);
  if (BLOCKED_KEYS.has(key)) throw new JLCRuntimeError(`禁止访问字段“${key}”`);
  return key;
}

function callable(name, invoke) {
  return Object.freeze({ [CALLABLE]: true, name, invoke });
}

function requireNumber(value, name = "值") {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new JLCRuntimeError(`${name}必须是有限数字`);
  return number;
}

function ownData(value) {
  return value != null && typeof value === "object";
}

function readMember(object, property) {
  if (object == null) return null;
  const key = safeKey(property);
  if (typeof object === "string") {
    if (key === "length") return object.length;
    if (/^(0|[1-9]\d*)$/u.test(key)) return object[Number(key)] ?? null;
    return null;
  }
  if (Array.isArray(object)) {
    if (key === "length") return object.length;
    if (/^(0|[1-9]\d*)$/u.test(key)) return object[Number(key)] ?? null;
    return null;
  }
  if (ownData(object) && Object.hasOwn(object, key)) return object[key];
  return null;
}

function immutableSet(root, keys, value) {
  if (!keys.length) return value;
  const [key, ...rest] = keys;
  const array = Array.isArray(root);
  const output = array ? [...root] : Object.assign(Object.create(null), ownData(root) ? root : null);
  output[key] = immutableSet(readMember(root, key), rest, value);
  return output;
}

function normalizeIterable(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  if (ownData(value)) return Object.values(value);
  return [];
}

function bindingValue(binding) {
  if (binding.kind === "signal") return binding.signal.get();
  return binding.value;
}

/* ================================================================
 * 响应式核心：Signal / Scope / Effect / Scheduler
 * ================================================================ */

let ACTIVE_EFFECT = null;
let NEXT_EFFECT_ID = 1;

class Signal {
  constructor(runtime, value, writable = true, name = "signal") {
    this.runtime = runtime;
    this.value = value;
    this.writable = writable;
    this.name = name;
    this.subscribers = new Set();
    this.computing = false;
  }

  get() {
    if (this.computing && ACTIVE_EFFECT?.signal === this) {
      throw new JLCRuntimeError(`派生状态“${this.name}”直接引用了自身`);
    }
    if (ACTIVE_EFFECT && !ACTIVE_EFFECT.disposed) {
      this.subscribers.add(ACTIVE_EFFECT);
      ACTIVE_EFFECT.dependencies.add(this);
    }
    return this.value;
  }

  set(value, internal = false) {
    if (!internal && !this.writable) throw new JLCRuntimeError(`“${this.name}”是只读状态`);
    if (Object.is(this.value, value)) return;
    this.value = value;
    for (const subscriber of [...this.subscribers]) subscriber.schedule();
  }

  detach() {
    this.subscribers.clear();
    this.runtime = null;
    this.value = null;
  }
}

class Scope {
  constructor(runtime, parent = null, label = "scope") {
    this.runtime = runtime;
    this.parent = parent;
    this.label = label;
    this.children = new Set();
    this.disposables = new Set();
    this.disposed = false;
    if (parent) parent.children.add(this);
    runtime.metrics.scopes += 1;
  }

  child(label) {
    if (this.disposed) throw new JLCRuntimeError("无法在已销毁作用域内创建资源");
    return new Scope(this.runtime, this, label);
  }

  own(cleanup) {
    if (this.disposed) {
      cleanup();
      return () => {};
    }
    const scope = this;
    const disposable = {
      active: true,
      dispose() {
        if (!this.active) return;
        this.active = false;
        scope.disposables.delete(this);
        cleanup();
      },
    };
    this.disposables.add(disposable);
    return () => disposable.dispose();
  }

  adopt(disposable) {
    if (this.disposed) disposable.dispose();
    else this.disposables.add(disposable);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.parent) this.parent.children.delete(this);
    const children = [...this.children];
    const disposables = [...this.disposables];
    this.children.clear();
    this.disposables.clear();
    for (let index = children.length - 1; index >= 0; index -= 1) children[index].dispose();
    for (let index = disposables.length - 1; index >= 0; index -= 1) {
      try {
        disposables[index].dispose();
      } catch (error) {
        this.runtime?.reportError(error);
      }
    }
    if (this.runtime) this.runtime.metrics.scopes -= 1;
    this.parent = null;
    this.runtime = null;
  }
}

class Effect {
  constructor(runtime, scope, callback, priority = 1, signal = null) {
    this.runtime = runtime;
    this.scope = scope;
    this.callback = callback;
    this.priority = priority;
    this.signal = signal;
    this.id = NEXT_EFFECT_ID++;
    this.dependencies = new Set();
    this.cleanups = new Set();
    this.disposed = false;
    this.queued = false;
    runtime.metrics.effects += 1;
    scope.adopt(this);
    this.run();
  }

  schedule() {
    if (!this.disposed) this.runtime.scheduler.enqueue(this);
  }

  onCleanup(cleanup) {
    this.cleanups.add(cleanup);
  }

  clearRun() {
    for (const dependency of this.dependencies) dependency.subscribers.delete(this);
    this.dependencies.clear();
    for (const cleanup of this.cleanups) {
      try {
        cleanup();
      } catch (error) {
        this.runtime.reportError(error);
      }
    }
    this.cleanups.clear();
  }

  run() {
    if (this.disposed) return;
    this.queued = false;
    this.clearRun();
    const previous = ACTIVE_EFFECT;
    ACTIVE_EFFECT = this;
    try {
      this.callback();
    } catch (error) {
      if (this.runtime.initializing) throw error;
      this.runtime.reportError(error);
    } finally {
      ACTIVE_EFFECT = previous;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRun();
    this.scope?.disposables.delete(this);
    this.runtime.metrics.effects -= 1;
    this.callback = null;
    this.signal = null;
    this.scope = null;
    this.runtime = null;
  }
}

class Scheduler {
  constructor(runtime) {
    this.runtime = runtime;
    this.queue = new Set();
    this.pending = false;
    this.flushing = false;
  }

  enqueue(effect) {
    if (effect.disposed || effect.queued) return;
    effect.queued = true;
    this.queue.add(effect);
    if (!this.pending && this.runtime.batchDepth === 0) {
      this.pending = true;
      queueMicrotask(() => {
        if (!this.runtime) return;
        this.pending = false;
        this.flush();
      });
    }
  }

  flush() {
    if (this.flushing || this.runtime.destroyed) return;
    this.flushing = true;
    let rounds = 0;
    try {
      while (this.queue.size) {
        if (++rounds > 1000) throw new JLCRuntimeError("响应式更新超过 1000 轮，可能存在循环依赖");
        const effects = [...this.queue].sort((left, right) => left.priority - right.priority || left.id - right.id);
        this.queue.clear();
        for (const effect of effects) effect.run();
      }
    } catch (error) {
      for (const effect of this.queue) effect.queued = false;
      this.queue.clear();
      this.runtime.reportError(error);
    } finally {
      this.flushing = false;
    }
  }

  clear() {
    for (const effect of this.queue) effect.queued = false;
    this.queue.clear();
    this.runtime = null;
  }
}

/* ================================================================
 * 全局槽表（载入期链接的全局环境）
 * ================================================================ */

class GlobalTable {
  constructor() {
    this.names = new Map();
    this.bindings = [];
  }

  define(name, binding) {
    if (this.names.has(name)) throw new JLCRuntimeError(`名称“${name}”重复定义`);
    this.names.set(name, this.bindings.length);
    this.bindings.push(binding);
    return binding;
  }

  has(name) {
    return this.names.has(name);
  }

  resolve(name) {
    const slot = this.names.get(name);
    if (slot == null) throw new JLCRuntimeError(`未定义名称“${name}”`);
    return this.bindings[slot];
  }

  clear() {
    this.names.clear();
    this.bindings.length = 0;
  }
}

/* ================================================================
 * 指令集（Opcode table）
 * ================================================================ */

export const OP = {
  NOP: 0x00,
  CONST: 0x01,
  CONST_INT: 0x02,
  CONST_NULL: 0x03,
  POP: 0x04,
  DUP: 0x05,
  BUILD_ARRAY: 0x06,
  BUILD_OBJECT: 0x07,

  GET_LOCAL: 0x10,
  GET_GLOBAL: 0x11,
  SET_LOCAL: 0x12,
  DEF_LOCAL: 0x13,
  SET_GLOBAL: 0x14,
  SET_GLOBAL_PATH: 0x15,
  SET_LOCAL_PATH: 0x16,
  GET_MEMBER: 0x17,

  ADD: 0x20,
  SUB: 0x21,
  MUL: 0x22,
  DIV: 0x23,
  MOD: 0x24,
  POW: 0x25,
  EQ: 0x26,
  LT: 0x27,
  LE: 0x28,
  GT: 0x29,
  GE: 0x2a,
  IN: 0x2b,
  NOT: 0x2c,
  NEG: 0x2d,
  POS: 0x2e,
  COALESCE: 0x2f,

  JUMP: 0x40,
  JUMP_IF_FALSE: 0x41,
  JUMP_IF_TRUE: 0x42,
  JUMP_IF_NULL: 0x43,
  FOR_PREP: 0x44,
  FOR_NEXT: 0x45,
  RETURN: 0x46,
  RETURN_NULL: 0x47,
  CALL: 0x48,

  TIMER: 0x50,

  ELEM: 0x60,
  ELEM_END: 0x61,
  TEXT: 0x62,
  ATTR_STATIC: 0x63,
  ATTR: 0x64,
  CLASS_TOGGLE: 0x65,
  STYLE_PROP: 0x66,
  PROP_SET: 0x67,
  STYLE_OBJECT: 0x68,
  BIND_VALUE: 0x69,
  BIND_CHECKED: 0x6a,
  EVENT: 0x6b,
  WHEN: 0x6c,
  EACH: 0x6d,
};

// Operand descriptors: P=pool:u16 F=func:u16 R=globalref:u16 S=slot:u16
//                     B=u8 T=jump target:u16 I=i32
export const OP_SPEC = {
  [OP.NOP]: { name: "NOP", operands: "", stack: 0 },
  [OP.CONST]: { name: "CONST", operands: "P", stack: 1 },
  [OP.CONST_INT]: { name: "CONST_INT", operands: "I", stack: 1 },
  [OP.CONST_NULL]: { name: "CONST_NULL", operands: "", stack: 1 },
  [OP.POP]: { name: "POP", operands: "", stack: -1 },
  [OP.DUP]: { name: "DUP", operands: "", stack: 1 },
  [OP.BUILD_ARRAY]: { name: "BUILD_ARRAY", operands: "B", stack: "array" },
  [OP.BUILD_OBJECT]: { name: "BUILD_OBJECT", operands: "B", stack: "object" },

  [OP.GET_LOCAL]: { name: "GET_LOCAL", operands: "BS", stack: 1 },
  [OP.GET_GLOBAL]: { name: "GET_GLOBAL", operands: "R", stack: 1 },
  [OP.SET_LOCAL]: { name: "SET_LOCAL", operands: "BS", stack: -1 },
  [OP.DEF_LOCAL]: { name: "DEF_LOCAL", operands: "S", stack: -1 },
  [OP.SET_GLOBAL]: { name: "SET_GLOBAL", operands: "R", stack: -1 },
  [OP.SET_GLOBAL_PATH]: { name: "SET_GLOBAL_PATH", operands: "RB", stack: "setpath" },
  [OP.SET_LOCAL_PATH]: { name: "SET_LOCAL_PATH", operands: "BSB", stack: "setpath" },
  [OP.GET_MEMBER]: { name: "GET_MEMBER", operands: "", stack: -1 },

  [OP.ADD]: { name: "ADD", operands: "", stack: -1 },
  [OP.SUB]: { name: "SUB", operands: "", stack: -1 },
  [OP.MUL]: { name: "MUL", operands: "", stack: -1 },
  [OP.DIV]: { name: "DIV", operands: "", stack: -1 },
  [OP.MOD]: { name: "MOD", operands: "", stack: -1 },
  [OP.POW]: { name: "POW", operands: "", stack: -1 },
  [OP.EQ]: { name: "EQ", operands: "", stack: -1 },
  [OP.LT]: { name: "LT", operands: "", stack: -1 },
  [OP.LE]: { name: "LE", operands: "", stack: -1 },
  [OP.GT]: { name: "GT", operands: "", stack: -1 },
  [OP.GE]: { name: "GE", operands: "", stack: -1 },
  [OP.IN]: { name: "IN", operands: "", stack: -1 },
  [OP.NOT]: { name: "NOT", operands: "", stack: 0 },
  [OP.NEG]: { name: "NEG", operands: "", stack: 0 },
  [OP.POS]: { name: "POS", operands: "", stack: 0 },
  [OP.COALESCE]: { name: "COALESCE", operands: "", stack: -1 },

  [OP.JUMP]: { name: "JUMP", operands: "T", stack: 0, jump: "always" },
  [OP.JUMP_IF_FALSE]: { name: "JUMP_IF_FALSE", operands: "T", stack: -1, jump: "branch" },
  [OP.JUMP_IF_TRUE]: { name: "JUMP_IF_TRUE", operands: "T", stack: -1, jump: "branch" },
  [OP.JUMP_IF_NULL]: { name: "JUMP_IF_NULL", operands: "T", stack: 0, jump: "branchKeep" },
  [OP.JUMP_IF_NONNULL]: { name: "JUMP_IF_NONNULL", operands: "T", stack: -1, jump: "branch" },
  [OP.FOR_PREP]: { name: "FOR_PREP", operands: "", stack: 0 },
  [OP.FOR_NEXT]: { name: "FOR_NEXT", operands: "SSBT", stack: 0, jump: "fornext" },
  [OP.RETURN]: { name: "RETURN", operands: "", stack: -1, jump: "return" },
  [OP.RETURN_NULL]: { name: "RETURN_NULL", operands: "", stack: 0, jump: "return" },
  [OP.CALL]: { name: "CALL", operands: "B", stack: "call" },

  [OP.TIMER]: { name: "TIMER", operands: "BF", stack: -1 },

  [OP.ELEM]: { name: "ELEM", operands: "P", stack: 0, dom: true },
  [OP.ELEM_END]: { name: "ELEM_END", operands: "", stack: 0, dom: true },
  [OP.TEXT]: { name: "TEXT", operands: "F", stack: 0, dom: true },
  [OP.ATTR_STATIC]: { name: "ATTR_STATIC", operands: "PP", stack: 0, dom: true },
  [OP.ATTR]: { name: "ATTR", operands: "PF", stack: 0, dom: true },
  [OP.CLASS_TOGGLE]: { name: "CLASS_TOGGLE", operands: "PF", stack: 0, dom: true },
  [OP.STYLE_PROP]: { name: "STYLE_PROP", operands: "PF", stack: 0, dom: true },
  [OP.PROP_SET]: { name: "PROP_SET", operands: "PF", stack: 0, dom: true },
  [OP.STYLE_OBJECT]: { name: "STYLE_OBJECT", operands: "F", stack: 0, dom: true },
  [OP.BIND_VALUE]: { name: "BIND_VALUE", operands: "FF", stack: 0, dom: true },
  [OP.BIND_CHECKED]: { name: "BIND_CHECKED", operands: "FF", stack: 0, dom: true },
  [OP.EVENT]: { name: "EVENT", operands: "PBF", stack: 0, dom: true },
  [OP.WHEN]: { name: "WHEN", operands: "FFF", stack: 0, dom: true },
  [OP.EACH]: { name: "EACH", operands: "PPPPPSBS", stack: 0, dom: true },
};

export const FUNCTION_KIND = { EXPR: "expr", BODY: "body", VIEW: "view" };

const KIND_OPS = {
  expr: new Set([
    OP.NOP, OP.CONST, OP.CONST_INT, OP.CONST_NULL, OP.POP, OP.DUP,
    OP.BUILD_ARRAY, OP.BUILD_OBJECT, OP.GET_LOCAL, OP.GET_GLOBAL, OP.GET_MEMBER,
    OP.ADD, OP.SUB, OP.MUL, OP.DIV, OP.MOD, OP.POW, OP.EQ, OP.LT, OP.LE, OP.GT,
    OP.GE, OP.IN, OP.NOT, OP.NEG, OP.POS, OP.COALESCE,
    OP.JUMP, OP.JUMP_IF_FALSE, OP.JUMP_IF_TRUE, OP.JUMP_IF_NULL, OP.JUMP_IF_NONNULL,
    OP.CALL, OP.RETURN, OP.RETURN_NULL,
  ]),
  body: new Set([
    OP.NOP, OP.CONST, OP.CONST_INT, OP.CONST_NULL, OP.POP, OP.DUP,
    OP.BUILD_ARRAY, OP.BUILD_OBJECT, OP.GET_LOCAL, OP.GET_GLOBAL, OP.GET_MEMBER,
    OP.ADD, OP.SUB, OP.MUL, OP.DIV, OP.MOD, OP.POW, OP.EQ, OP.LT, OP.LE, OP.GT,
    OP.GE, OP.IN, OP.NOT, OP.NEG, OP.POS, OP.COALESCE,
    OP.JUMP, OP.JUMP_IF_FALSE, OP.JUMP_IF_TRUE, OP.JUMP_IF_NULL, OP.JUMP_IF_NONNULL,
    OP.SET_LOCAL, OP.DEF_LOCAL, OP.SET_GLOBAL, OP.SET_GLOBAL_PATH, OP.SET_LOCAL_PATH,
    OP.FOR_PREP, OP.FOR_NEXT, OP.RETURN, OP.RETURN_NULL, OP.CALL, OP.TIMER,
  ]),
  view: new Set([
    OP.NOP, OP.ELEM, OP.ELEM_END, OP.TEXT, OP.ATTR_STATIC, OP.ATTR, OP.CLASS_TOGGLE,
    OP.STYLE_PROP, OP.PROP_SET, OP.STYLE_OBJECT, OP.BIND_VALUE, OP.BIND_CHECKED,
    OP.EVENT, OP.WHEN, OP.EACH, OP.RETURN_NULL,
  ]),
};

function instructionStackDelta(opcode, values) {
  switch (opcode) {
    case OP.BUILD_ARRAY: return 1 - values[0];
    case OP.BUILD_OBJECT: return 1 - 2 * values[0];
    case OP.CALL: return -values[0];
    case OP.SET_GLOBAL_PATH: return -1 - values[1];
    case OP.SET_LOCAL_PATH: return -1 - values[2];
    default: return OP_SPEC[opcode].stack;
  }
}

/* ================================================================
 * 二进制读写（大端，与 JVM class 文件一致）
 * ================================================================ */

class ByteWriter {
  constructor() {
    this.bytes = [];
  }

  u8(value) {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value) {
    this.bytes.push((value >> 8) & 0xff, value & 0xff);
    return this;
  }

  u32(value) {
    this.bytes.push((value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
    return this;
  }

  f64(value) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, false);
    for (let index = 0; index < 8; index += 1) this.bytes.push(view.getUint8(index));
    return this;
  }

  str(text) {
    const encoded = new TextEncoder().encode(String(text));
    this.u32(encoded.length);
    for (const byte of encoded) this.bytes.push(byte);
    return this;
  }

  raw(bytes) {
    for (const byte of bytes) this.bytes.push(byte);
    return this;
  }

  toUint8Array() {
    return Uint8Array.from(this.bytes);
  }
}

class ByteReader {
  constructor(bytes, moduleName) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.ip = 0;
    this.moduleName = moduleName;
  }

  fail(message) {
    throw new JLCVerifyError(`偏移 ${this.ip}: ${message}`, this.moduleName);
  }

  need(count) {
    if (this.ip + count > this.bytes.length) this.fail("字节流意外截断");
  }

  u8() {
    this.need(1);
    return this.bytes[this.ip++];
  }

  u16() {
    this.need(2);
    const value = (this.bytes[this.ip] << 8) | this.bytes[this.ip + 1];
    this.ip += 2;
    return value;
  }

  u32() {
    this.need(4);
    const value = this.view.getUint32(this.ip, false);
    this.ip += 4;
    return value;
  }

  f64() {
    this.need(8);
    const value = this.view.getFloat64(this.ip, false);
    this.ip += 8;
    return value;
  }

  str() {
    const length = this.u32();
    this.need(length);
    const slice = this.bytes.subarray(this.ip, this.ip + length);
    this.ip += length;
    return new TextDecoder().decode(slice);
  }
}

/* ================================================================
 * .jbc 序列化 / 反序列化
 * ================================================================ */

const SECTION = { POOL: 1, GLOBALS: 2, FUNCS: 3, ACTIONS: 4, DECLS: 5, VIEW: 6, META: 7 };
const POOL_NULL = 0, POOL_TRUE = 1, POOL_FALSE = 2, POOL_NUM = 3, POOL_STR = 4;
const DECL_KIND = { state: 0, derive: 1, resource: 2, style: 3 };
const DECL_KIND_NAMES = ["state", "derive", "resource", "style"];
const KIND_CODES = { expr: 0, body: 1, view: 2 };
const KIND_CODE_NAMES = ["expr", "body", "view"];

export function encodeModule(module) {
  const writer = new ByteWriter();
  writer.u32(MAGIC);
  writer.u16(BYTECODE_VERSION);
  writer.u16(0); // flags

  const sections = [];
  {
    const pool = new ByteWriter();
    pool.u16(module.pool.length);
    for (const value of module.pool) {
      if (value == null) pool.u8(POOL_NULL);
      else if (value === true) pool.u8(POOL_TRUE);
      else if (value === false) pool.u8(POOL_FALSE);
      else if (typeof value === "number") { pool.u8(POOL_NUM); pool.f64(value); }
      else if (typeof value === "string") { pool.u8(POOL_STR); pool.str(value); }
      else throw new JLCVerifyError(`常量池不支持类型 ${typeof value}`);
    }
    sections.push([SECTION.POOL, pool]);
  }
  {
    const globals = new ByteWriter();
    globals.u16(module.globalRefs.length);
    for (const name of module.globalRefs) globals.u16(poolIndexOf(module, name));
    sections.push([SECTION.GLOBALS, globals]);
  }
  {
    const funcs = new ByteWriter();
    funcs.u16(module.functions.length);
    for (const func of module.functions) {
      funcs.u16(poolIndexOf(module, func.name));
      funcs.u8(KIND_CODES[func.kind] ?? 0);
      funcs.u16(func.nSlots);
      funcs.u8(0); // reserved: capture count
      funcs.u32(func.code.length);
      funcs.raw(func.code);
    }
    sections.push([SECTION.FUNCS, funcs]);
  }
  {
    const actions = new ByteWriter();
    actions.u16(module.actions.length);
    for (const action of module.actions) {
      actions.u16(poolIndexOf(module, action.name));
      actions.u16(action.func);
      actions.u8(action.params.length);
      for (const parameter of action.params) {
        actions.u16(poolIndexOf(module, parameter.name));
        actions.u16(parameter.defaultFunc);
      }
    }
    sections.push([SECTION.ACTIONS, actions]);
  }
  {
    const decls = new ByteWriter();
    decls.u16(module.declarations.length);
    for (const declaration of module.declarations) {
      decls.u8(DECL_KIND[declaration.kind]);
      decls.u16(poolIndexOf(module, declaration.name));
      decls.u16(declaration.func);
    }
    sections.push([SECTION.DECLS, decls]);
  }
  {
    const view = new ByteWriter();
    view.u16(module.view);
    sections.push([SECTION.VIEW, view]);
  }
  {
    const meta = new ByteWriter();
    meta.u16(poolIndexOf(module, module.app));
    meta.str(module.sourceName);
    meta.u16(0); // reserved
    sections.push([SECTION.META, meta]);
  }

  writer.u16(sections.length);
  for (const [id, payload] of sections) {
    const bytes = payload.toUint8Array();
    writer.u8(id);
    writer.u16(0);
    writer.u32(bytes.length);
    writer.raw(bytes);
  }
  return writer.toUint8Array();
}

function poolIndexOf(module, text) {
  const index = module.pool.indexOf(text);
  if (index < 0) throw new JLCVerifyError(`常量池缺少“${text}”`);
  return index;
}

export function decodeModule(bytes, { sourceName = "<jbc>", verify = true } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const reader = new ByteReader(data, sourceName);
  if (reader.u32() !== MAGIC) throw new JLCVerifyError("魔数不匹配，不是 .jbc 字节码", sourceName);
  const version = reader.u16();
  if (version !== BYTECODE_VERSION) throw new JLCVerifyError(`不支持的字节码版本 ${version}`, sourceName);
  reader.u16(); // flags

  const sectionCount = reader.u16();
  const payloads = new Map();
  for (let index = 0; index < sectionCount; index += 1) {
    const id = reader.u8();
    reader.u16();
    const length = reader.u32();
    reader.need(length);
    if (payloads.has(id)) throw new JLCVerifyError(`段 ${id} 重复出现`, sourceName);
    payloads.set(id, data.subarray(reader.ip, reader.ip + length));
    reader.ip += length;
  }
  for (const required of [SECTION.POOL, SECTION.GLOBALS, SECTION.FUNCS, SECTION.ACTIONS, SECTION.DECLS, SECTION.VIEW, SECTION.META]) {
    if (!payloads.has(required)) throw new JLCVerifyError(`缺少必需段 ${required}`, sourceName);
  }

  const module = {
    format: "jlc-bytecode",
    version,
    app: "",
    sourceName,
    pool: [],
    globalRefs: [],
    functions: [],
    actions: [],
    declarations: [],
    view: 0,
    verified: false,
  };

  {
    const pool = new ByteReader(payloads.get(SECTION.POOL), sourceName);
    const count = pool.u16();
    for (let index = 0; index < count; index += 1) {
      const tag = pool.u8();
      if (tag === POOL_NULL) module.pool.push(null);
      else if (tag === POOL_TRUE) module.pool.push(true);
      else if (tag === POOL_FALSE) module.pool.push(false);
      else if (tag === POOL_NUM) module.pool.push(pool.f64());
      else if (tag === POOL_STR) module.pool.push(pool.str());
      else throw new JLCVerifyError(`常量池条目 ${index} 类型非法（${tag}）`, sourceName);
    }
  }
  {
    const globals = new ByteReader(payloads.get(SECTION.GLOBALS), sourceName);
    const count = globals.u16();
    for (let index = 0; index < count; index += 1) {
      const name = module.pool[globals.u16()];
      if (typeof name !== "string") throw new JLCVerifyError(`全局引用 ${index} 未指向字符串常量`, sourceName);
      module.globalRefs.push(name);
    }
  }
  {
    const funcs = new ByteReader(payloads.get(SECTION.FUNCS), sourceName);
    const count = funcs.u16();
    for (let index = 0; index < count; index += 1) {
      const name = module.pool[funcs.u16()];
      const kindCode = funcs.u8();
      const kind = KIND_CODE_NAMES[kindCode];
      if (!kind) throw new JLCVerifyError(`函数 ${index} 类型非法（${kindCode}）`, sourceName);
      const nSlots = funcs.u16();
      const captures = funcs.u8();
      for (let capture = 0; capture < captures; capture += 1) funcs.u16(); // reserved
      const codeLength = funcs.u32();
      funcs.need(codeLength);
      const code = funcs.bytes.slice(funcs.ip, funcs.ip + codeLength);
      funcs.ip += codeLength;
      module.functions.push({ name: String(name ?? `func${index}`), kind, nSlots, captures: [], code, maxStack: 0 });
    }
  }
  {
    const actions = new ByteReader(payloads.get(SECTION.ACTIONS), sourceName);
    const count = actions.u16();
    for (let index = 0; index < count; index += 1) {
      const name = module.pool[actions.u16()];
      const func = actions.u16();
      const paramCount = actions.u8();
      const params = [];
      for (let parameter = 0; parameter < paramCount; parameter += 1) {
        const paramName = module.pool[actions.u16()];
        const defaultFunc = actions.u16();
        params.push({ name: String(paramName ?? `p${parameter}`), defaultFunc });
      }
      module.actions.push({ name: String(name ?? `action${index}`), func, params });
    }
  }
  {
    const decls = new ByteReader(payloads.get(SECTION.DECLS), sourceName);
    const count = decls.u16();
    for (let index = 0; index < count; index += 1) {
      const kindCode = decls.u8();
      const kind = DECL_KIND_NAMES[kindCode];
      if (!kind) throw new JLCVerifyError(`声明 ${index} 类型非法（${kindCode}）`, sourceName);
      const name = module.pool[decls.u16()];
      const func = decls.u16();
      module.declarations.push({ kind, name: String(name ?? `decl${index}`), func });
    }
  }
  module.view = new ByteReader(payloads.get(SECTION.VIEW), sourceName).u16();
  {
    const meta = new ByteReader(payloads.get(SECTION.META), sourceName);
    module.app = String(module.pool[meta.u16()] ?? "App");
    module.sourceName = meta.str();
  }

  if (verify) verifyModule(module, sourceName);
  module.verified = true;
  return freezeModule(module);
}

function freezeModule(module) {
  // Uint8Array 指令流不能 Object.freeze，逐层冻结其余结构。
  Object.freeze(module);
  Object.freeze(module.pool);
  Object.freeze(module.globalRefs);
  for (const func of module.functions) Object.freeze(func);
  Object.freeze(module.functions);
  for (const action of module.actions) {
    for (const parameter of action.params) Object.freeze(parameter);
    Object.freeze(action.params);
    Object.freeze(action);
  }
  Object.freeze(module.actions);
  for (const declaration of module.declarations) Object.freeze(declaration);
  Object.freeze(module.declarations);
  return module;
}

/* ================================================================
 * 字节码验证器（Bytecode Verifier）
 * 载入期静态检查：操作码合法性、操作数边界、跳转目标落在指令边界、
 * 操作数栈深度一致性、元素游标配平 —— 等价 JVM 的 class 校验。
 * ================================================================ */

export function verifyModule(module, sourceName = "<jbc>") {
  const fail = (message) => { throw new JLCVerifyError(message, sourceName); };

  if (!module || module.format !== "jlc-bytecode") fail("不是 JLC 字节码模块");
  if (!Array.isArray(module.pool)) fail("常量池缺失");
  if (module.pool.length > 0x10000) fail("常量池超过 65536 项");
  for (const [index, value] of module.pool.entries()) {
    if (value != null && typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string") {
      fail(`常量池条目 ${index} 类型非法`);
    }
  }
  if (module.functions.length > 0x10000) fail("函数表超过 65536 项");
  if (module.globalRefs.length > 0x10000) fail("全局引用表超过 65536 项");
  const stringPool = new Map();
  for (const [index, value] of module.pool.entries()) {
    if (typeof value === "string" && !stringPool.has(value)) stringPool.set(value, index);
  }
  const requirePooled = (name, what) => {
    if (typeof name !== "string" || !stringPool.has(name)) fail(`${what}“${name}”不在字符串常量池中`);
  };

  module.functions.forEach((func, index) => {
    if (!KIND_OPS[func.kind]) fail(`函数 ${index} 类型非法`);
    const code = func.code;
    if (!(code instanceof Uint8Array)) fail(`函数 ${func.name} 缺少指令流`);
    if (code.length > 0xffff) fail(`函数 ${func.name} 指令流超过 64KB`);
    if (func.nSlots > 0x10000) fail(`函数 ${func.name} 局部槽过多`);

    // Pass 1: 线性扫描 —— 操作码合法、操作数完整、记录指令边界。
    const boundaries = new Set();
    const instructionAt = new Map();
    let ip = 0;
    while (ip < code.length) {
      const start = ip;
      const opcode = code[ip];
      const operation = OP_SPEC[opcode];
      if (!operation) fail(`${func.name}@${start}: 未知操作码 0x${opcode.toString(16)}`);
      if (!KIND_OPS[func.kind].has(opcode)) {
        fail(`${func.name}@${start}: ${operation.name} 不允许出现在 ${func.kind} 函数中`);
      }
      ip += 1;
      const values = [];
      for (const descriptor of operation.operands) {
        let value;
        if (descriptor === "P" || descriptor === "F" || descriptor === "R" || descriptor === "S" || descriptor === "T") {
          if (ip + 2 > code.length) fail(`${func.name}@${start}: 操作数越界`);
          value = (code[ip] << 8) | code[ip + 1];
          ip += 2;
        } else if (descriptor === "B") {
          if (ip + 1 > code.length) fail(`${func.name}@${start}: 操作数越界`);
          value = code[ip];
          ip += 1;
        } else {
          if (ip + 4 > code.length) fail(`${func.name}@${start}: 操作数越界`);
          value = (code[ip] << 24) | (code[ip + 1] << 16) | (code[ip + 2] << 8) | code[ip + 3];
          ip += 4;
        }
        values.push(value);
        if (descriptor === "P" && value >= module.pool.length) fail(`${func.name}@${start}: 常量池索引越界`);
        if (descriptor === "F" && value >= module.functions.length) fail(`${func.name}@${start}: 函数索引越界`);
        if (descriptor === "R" && value >= module.globalRefs.length) fail(`${func.name}@${start}: 全局引用越界`);
        if (descriptor === "S") {
          //槽位边界检查只对“当前帧”槽位有意义：
          //  DEF_LOCAL / FOR_NEXT：恒为当前帧；GET_LOCAL/SET_LOCAL(路径)首操作数是 depth。
          const ownFrame = opcode === OP.DEF_LOCAL || opcode === OP.FOR_NEXT
            || ((opcode === OP.GET_LOCAL || opcode === OP.SET_LOCAL || opcode === OP.SET_LOCAL_PATH) && values[0] === 0);
          if (ownFrame && value >= func.nSlots) fail(`${func.name}@${start}: 局部槽 ${value} 超出函数槽位数 ${func.nSlots}`);
        }
      }
      boundaries.add(start);
      instructionAt.set(start, { start, end: ip, opcode, operation, values });
    }
    boundaries.add(code.length);

    // Pass 2: 可达性 + 操作数栈深度一致性（工作表算法）。
    const expectedExit = func.kind === FUNCTION_KIND.EXPR ? 1 : 0;
    const depths = new Map();
    const cursors = new Map();
    const worklist = [0];
    let maxStack = 0;
    const visit = (offset, depth, cursor) => {
      if (offset > code.length) fail(`${func.name}: 跳转目标越界`);
      if (!boundaries.has(offset)) fail(`${func.name}: 跳转目标 0x${offset.toString(16)} 落在指令中间`);
      const known = depths.get(offset);
      if (known != null) {
        if (known !== depth) fail(`${func.name}@${offset}: 操作数栈深度不一致（${known} ≠ ${depth}）`);
        if (func.kind === FUNCTION_KIND.VIEW && cursors.get(offset) !== cursor) {
          fail(`${func.name}@${offset}: 元素游标深度不一致`);
        }
        return;
      }
      depths.set(offset, depth);
      cursors.set(offset, cursor);
      worklist.push(offset);
    };
    depths.set(0, 0);
    cursors.set(0, 0);

    while (worklist.length) {
      let at = worklist.pop();
      let depth = depths.get(at);
      let cursor = cursors.get(at) ?? 0;
      let walking = true;
      while (walking) {
        if (at >= code.length) {
          if (depth !== expectedExit) fail(`${func.name}@${at}: 函数出口栈深度为 ${depth}，应为 ${expectedExit}`);
          if (func.kind === FUNCTION_KIND.VIEW && cursor !== 0) fail(`${func.name}: 函数出口元素游标未闭合`);
          break;
        }
        const instruction = instructionAt.get(at);
        if (!instruction) fail(`${func.name}: 指令边界损坏 @${at}`);
        const { opcode, operation, values, end } = instruction;

        if (opcode === OP.ELEM) cursor += 1;
        if (opcode === OP.ELEM_END) {
          if (cursor === 0) fail(`${func.name}@${at}: ELEM_END 没有匹配的 ELEM`);
          cursor -= 1;
        }

        depth += instructionStackDelta(opcode, values);
        if (depth < 0) fail(`${func.name}@${at}: 操作数栈下溢`);
        if (depth > maxStack) maxStack = depth;
        if (depth > 0x1000) fail(`${func.name}@${at}: 操作数栈深度超限`);

        if (operation.jump === "always") { visit(values[0], depth, cursor); walking = false; }
        else if (operation.jump === "return") { walking = false; }
        else if (operation.jump === "fornext") visit(values[3], depth - 1, cursor);
        else if (operation.jump === "branch" || operation.jump === "branchKeep") visit(values[0], depth, cursor);

        if (!walking) break;
        const next = end;
        if (next >= code.length) {
          if (depth !== expectedExit) fail(`${func.name}: 函数出口栈深度为 ${depth}，应为 ${expectedExit}`);
          if (func.kind === FUNCTION_KIND.VIEW && cursor !== 0) fail(`${func.name}: 函数出口元素游标未闭合`);
          break;
        }
        const knownDepth = depths.get(next);
        if (knownDepth != null) {
          if (knownDepth !== depth) fail(`${func.name}@${next}: 操作数栈深度不一致（${knownDepth} ≠ ${depth}）`);
          if (func.kind === FUNCTION_KIND.VIEW && cursors.get(next) !== cursor) fail(`${func.name}@${next}: 元素游标深度不一致`);
          break;
        }
        depths.set(next, depth);
        cursors.set(next, cursor);
        at = next;
      }
    }
    func.maxStack = maxStack;
  });

  // 结构引用检查。
  for (const [index, action] of module.actions.entries()) {
    const func = module.functions[action.func];
    if (!func || func.kind !== FUNCTION_KIND.BODY) fail(`action ${index} 未指向语句函数`);
    for (const parameter of action.params) {
      if (parameter.defaultFunc !== NO_FUNC) {
        const fallback = module.functions[parameter.defaultFunc];
        if (!fallback || fallback.kind !== FUNCTION_KIND.EXPR) fail(`action ${action.name} 参数默认值必须是表达式函数`);
      }
    }
  }
  for (const [index, declaration] of module.declarations.entries()) {
    const func = module.functions[declaration.func];
    if (!func || func.kind !== FUNCTION_KIND.EXPR) fail(`声明 ${index}（${declaration.kind} ${declaration.name}）未指向表达式函数`);
  }
  const view = module.functions[module.view];
  if (!view || view.kind !== FUNCTION_KIND.VIEW) fail("view 未指向视图函数");
  for (const name of module.globalRefs) requirePooled(name, "全局引用");
  for (const action of module.actions) requirePooled(action.name, "action 名");
  for (const declaration of module.declarations) requirePooled(declaration.name, "声明名");
  return module;
}

/* ================================================================
 * 反汇编器（调试视图）
 * ================================================================ */

export function disassembleModule(module) {
  const lines = [];
  lines.push(`; JLC bytecode module — app ${module.app} (${module.sourceName})`);
  lines.push(`; version ${module.version}, pool ${module.pool.length}, globals ${module.globalRefs.length}, functions ${module.functions.length}`);
  lines.push("");
  lines.push(".pool");
  module.pool.forEach((value, index) => {
    lines.push(`  [${index}] ${typeof value === "string" ? JSON.stringify(value) : String(value)}`);
  });
  lines.push("");
  lines.push(".globals");
  module.globalRefs.forEach((name, index) => lines.push(`  [${index}] ${name}`));
  lines.push("");
  module.functions.forEach((func, funcIndex) => {
    lines.push(`.function ${func.name} #${funcIndex} kind=${func.kind} slots=${func.nSlots} maxStack=${func.maxStack ?? "?"}`);
    let ip = 0;
    const code = func.code;
    while (ip < code.length) {
      const operation = OP_SPEC[code[ip]];
      const start = ip;
      ip += 1;
      const parts = [];
      for (const descriptor of operation.operands) {
        if (descriptor === "P" || descriptor === "F" || descriptor === "R" || descriptor === "S" || descriptor === "T") {
          const value = (code[ip] << 8) | code[ip + 1];
          if (descriptor === "P") parts.push(`pool[${value}] ${JSON.stringify(module.pool[value])}`);
          else if (descriptor === "F") parts.push(`fn#${value} ${module.functions[value]?.name ?? "?"}`);
          else if (descriptor === "R") parts.push(`global[${value}] ${module.globalRefs[value]}`);
          else if (descriptor === "S") parts.push(`slot ${value}`);
          else parts.push(`-> 0x${value.toString(16)}`);
          ip += 2;
        } else if (descriptor === "B") {
          parts.push(String(code[ip]));
          ip += 1;
        } else if (descriptor === "I") {
          const value = (code[ip] << 24) | (code[ip + 1] << 16) | (code[ip + 2] << 8) | code[ip + 3];
          parts.push(String(value));
          ip += 4;
        }
      }
      lines.push(`  0x${start.toString(16).padStart(4, "0")}  ${operation.name.padEnd(16)} ${parts.join(", ")}`);
    }
    lines.push("");
  });
  lines.push(".actions");
  module.actions.forEach((action) => {
    const parameters = action.params
      .map((parameter) => `${parameter.name}${parameter.defaultFunc === NO_FUNC ? "" : ` = fn#${parameter.defaultFunc}`}`)
      .join(", ");
    lines.push(`  ${action.name}(${parameters}) -> fn#${action.func}`);
  });
  lines.push(".declarations");
  module.declarations.forEach((declaration) => {
    lines.push(`  ${declaration.kind} ${declaration.name} = fn#${declaration.func}`);
  });
  lines.push(`.view fn#${module.view}`);
  return lines.join("\n");
}

/* ================================================================
 * DOM 翻译助手（与 AST 版语义一致）
 * ================================================================ */

function toText(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function normalizeClass(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String).join(" ");
  if (ownData(value)) return Object.entries(value).filter(([, enabled]) => enabled).map(([name]) => name).join(" ");
  return value == null ? "" : String(value);
}

function sanitizeUrl(value) {
  const text = String(value ?? "").trim();
  const compact = text.replace(/[\u0000-\u0020]/gu, "").toLowerCase();
  if (compact.startsWith("javascript:") || compact.startsWith("vbscript:") || compact.startsWith("data:text/html")) return "about:blank";
  return text;
}

function setNormalAttribute(element, rawName, value) {
  let name = rawName;
  if (name.startsWith("attr:")) name = name.slice(5).replaceAll(":", "-");
  if (name.startsWith("data:")) name = `data-${name.slice(5).replaceAll(":", "-")}`;
  if (name.startsWith("aria:")) name = `aria-${name.slice(5).replaceAll(":", "-")}`;
  if (/^on/iu.test(name)) throw new JLCRuntimeError(`禁止直接设置事件属性“${name}”，请使用 on:${name.slice(2)}`);
  if (URL_ATTRIBUTES.has(name.toLowerCase())) value = sanitizeUrl(value);
  if (name === "class") value = normalizeClass(value);

  if (value == null || value === false) {
    element.removeAttribute(name);
    if (["value", "checked", "selected", "disabled"].includes(name) && name in element) {
      element[name] = name === "value" ? "" : false;
    }
    return;
  }
  if (value === true) element.setAttribute(name, "");
  else element.setAttribute(name, String(value));
  if (["value", "checked", "selected"].includes(name) && name in element) element[name] = value;
}

function eventSnapshot(event) {
  const target = event?.target;
  return Object.freeze({
    type: String(event?.type ?? ""),
    value: target && "value" in target ? String(target.value ?? "") : null,
    checked: target && "checked" in target ? Boolean(target.checked) : null,
    key: event?.key == null ? null : String(event.key),
    code: event?.code == null ? null : String(event.code),
    button: Number(event?.button ?? 0),
    x: Number(event?.clientX ?? 0),
    y: Number(event?.clientY ?? 0),
    alt: Boolean(event?.altKey),
    ctrl: Boolean(event?.ctrlKey),
    shift: Boolean(event?.shiftKey),
    meta: Boolean(event?.metaKey),
    detail: (() => {
      try { return sanitizeValue(event?.detail ?? null); } catch { return null; }
    })(),
  });
}

function createElement(documentObject, tag, namespace) {
  const normalized = tag.toLowerCase();
  if (BLOCKED_TAGS.has(normalized)) throw new JLCRuntimeError(`安全模式禁止创建 <${tag}>`);
  const svgNamespace = "http://www.w3.org/2000/svg";
  const nextNamespace = normalized === "svg" ? svgNamespace : namespace;
  const element = nextNamespace
    ? documentObject.createElementNS(nextNamespace, tag)
    : documentObject.createElement(tag);
  return { element, namespace: nextNamespace };
}

function registerOwnedNode(runtime, scope, node) {
  runtime.ownedNodes.set(node, scope);
  scope.own(() => runtime.ownedNodes?.delete(node));
}

function clearBetween(start, end) {
  let node = start.nextSibling;
  while (node && node !== end) {
    const next = node.nextSibling;
    node.remove();
    node = next;
  }
}

function removeInclusive(start, end) {
  let node = start;
  while (node) {
    const next = node.nextSibling;
    node.remove();
    if (node === end) break;
    node = next;
  }
}

function moveInclusive(parent, start, end, before) {
  if (end.nextSibling === before) return;
  const fragment = parent.ownerDocument.createDocumentFragment();
  let node = start;
  while (node) {
    const next = node.nextSibling;
    fragment.appendChild(node);
    if (node === end) break;
    node = next;
  }
  parent.insertBefore(fragment, before);
}

/* ================================================================
 * JLC-VM 执行引擎：栈式调度循环（Bytecode Dispatch Loop）
 * ================================================================ */

const MAX_ACTION_DEPTH = 100;
const NO_STEP = new Uint8Array(256);
for (const opcode of [OP.NOP, OP.POP, OP.DUP, OP.JUMP, OP.JUMP_IF_FALSE, OP.JUMP_IF_TRUE, OP.JUMP_IF_NULL, OP.RETURN_NULL]) {
  NO_STEP[opcode] = 1;
}

class Machine {
  constructor(runtime, module) {
    this.runtime = runtime;
    this.module = module;
    this.functions = module.functions;
    this.pool = module.pool;
    this.bindings = null;
    this.links = null;
    this.stack = [];
    this.frames = [];
    this.render = null;
    this.context = null;
    this.actionDepth = 0;
  }

  link(bindings, links) {
    this.bindings = bindings;
    this.links = links;
  }

  /** 入口：执行一个函数直到它返回（可重入）。 */
  runFunction(funcIndex, parent, scope, options = {}) {
    const func = this.functions[funcIndex];
    const slots = options.preset && options.preset.length >= func.nSlots
      ? options.preset
      : new Array(func.nSlots).fill(null);
    const frame = { func, ip: 0, base: this.stack.length, slots, parent, isAction: false };
    const framesLength = this.frames.length;
    const stackLength = this.stack.length;
    const previousContext = this.context;
    const previousDepth = this.actionDepth;
    if (options.fresh !== false || !this.context) {
      this.context = this.runtime.context(scope ?? this.runtime.rootScope);
      this.actionDepth = 0;
    }
    this.frames.push(frame);
    try {
      return this.dispatch(frame);
    } finally {
      this.frames.length = framesLength;
      this.stack.length = stackLength;
      this.context = previousContext;
      this.actionDepth = previousDepth;
    }
  }

  /** 视图片段执行：维护 DOM 游标栈。 */
  runView(funcIndex, parent, before, scope, frame, namespace, options = {}) {
    const savedRender = this.render;
    const savedContext = this.context;
    const savedDepth = this.actionDepth;
    this.render = { cursors: [{ parent, before, scope, namespace }] };
    this.context = this.runtime.context(scope ?? this.runtime.rootScope);
    this.actionDepth = 0;
    try {
      return this.runFunction(funcIndex, frame ?? null, scope, { ...options, fresh: false });
    } finally {
      this.render = savedRender;
      this.context = savedContext;
      this.actionDepth = savedDepth;
    }
  }

  /** action 调用：由 callable.invoke（宿主侧入口）触发。 */
  enterAction(actionIndex, argumentsList, parentContext) {
    if (this.actionDepth >= MAX_ACTION_DEPTH) throw new JLCRuntimeError("action 调用深度超过 100");
    const savedContext = this.context;
    const savedDepth = this.actionDepth;
    const framesLength = this.frames.length;
    const stackLength = this.stack.length;
    this.context = parentContext ?? this.runtime.context(this.runtime.rootScope);
    this.actionDepth += 1;
    try {
      const frame = this.actionFrame(actionIndex, argumentsList);
      this.frames.push(frame);
      return this.dispatch(frame);
    } finally {
      this.frames.length = framesLength;
      this.stack.length = stackLength;
      this.context = savedContext;
      this.actionDepth = savedDepth;
    }
  }

  actionFrame(actionIndex, argumentsList) {
    const action = this.module.actions[actionIndex];
    const func = this.functions[action.func];
    const slots = new Array(func.nSlots).fill(null);
    for (let index = 0; index < action.params.length; index += 1) {
      const parameter = action.params[index];
      let value;
      if (index < argumentsList.length) value = argumentsList[index];
      else if (parameter.defaultFunc !== NO_FUNC) {
        value = this.runFunction(parameter.defaultFunc, { slots, parent: null }, null, { fresh: false });
      } else value = null;
      slots[index] = sanitizeValue(value);
    }
    return { func, ip: 0, base: this.stack.length, slots, parent: null, isAction: true };
  }

  /** 定时器体捕获创建瞬间的整条局部变量链（快照语义）。 */
  snapshotChain() {
    let chain = null;
    for (const frame of this.frames) chain = { slots: frame.slots.slice(), parent: chain };
    return chain;
  }

  createTimer(mode, delay, funcIndex) {
    const runtime = this.runtime;
    delay = Math.max(0, requireNumber(delay, "定时器延迟"));
    const scope = this.context?.scope;
    if (!scope || scope.disposed) throw new JLCRuntimeError("定时器没有可用的生命周期作用域");
    runtime.metrics.timers += 1;
    let active = true;
    let timer;
    const cleanup = () => {
      if (!active) return;
      active = false;
      if (mode === 0) {
        if (runtime.window?.clearTimeout) runtime.window.clearTimeout(timer);
        else clearTimeout(timer);
      } else if (runtime.window?.clearInterval) runtime.window.clearInterval(timer);
      else clearInterval(timer);
      runtime.metrics.timers -= 1;
    };
    const release = scope.own(cleanup);
    const chain = this.snapshotChain();
    const run = () => {
      if (!active || runtime.destroyed) return;
      if (mode === 0) release();
      try {
        runtime.batch(() => this.runFunction(funcIndex, chain, scope));
      } catch (error) {
        runtime.reportError(error);
      }
    };
    if (mode === 0) timer = runtime.window?.setTimeout?.(run, delay) ?? setTimeout(run, delay);
    else timer = runtime.window?.setInterval?.(run, delay) ?? setInterval(run, delay);
  }

  dispatch(entryFrame) {
    const stack = this.stack;
    const frames = this.frames;
    const baseFrames = frames.length;
    const context = this.context;
    const maxSteps = context.runtime.options.maxSteps;
    const steps = context;
    entryFrame.ip = 0;

    outer: while (true) {
      const frame = frames[frames.length - 1];
      const code = frame.func.code;
      let ip = frame.ip;

      try {
        while (true) {
          const opcode = code[ip];
          if (NO_STEP[opcode] === 0 && ++steps.steps > maxSteps) {
            throw new JLCRuntimeError("单次动作运算步数超限");
          }
          ip += 1;

          switch (opcode) {
            case OP.NOP:
              break;
            case OP.CONST:
              stack.push(this.pool[(code[ip] << 8) | code[ip + 1]]);
              ip += 2;
              break;
            case OP.CONST_INT:
              stack.push((code[ip] << 24) | (code[ip + 1] << 16) | (code[ip + 2] << 8) | code[ip + 3]);
              ip += 4;
              break;
            case OP.CONST_NULL:
              stack.push(null);
              break;
            case OP.POP:
              stack.pop();
              break;
            case OP.DUP:
              stack.push(stack[stack.length - 1]);
              break;
            case OP.BUILD_ARRAY: {
              const count = code[ip++];
              stack.push(stack.splice(stack.length - count));
              break;
            }
            case OP.BUILD_OBJECT: {
              const count = code[ip++];
              const values = stack.splice(stack.length - 2 * count);
              const object = Object.create(null);
              for (let index = 0; index < count; index += 1) {
                object[values[index * 2]] = values[index * 2 + 1];
              }
              stack.push(object);
              break;
            }

            case OP.GET_LOCAL: {
              const depth = code[ip++];
              const slot = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              let target = frame;
              for (let hop = 0; hop < depth; hop += 1) target = target.parent;
              if (!target) throw new JLCRuntimeError("局部变量帧越界");
              const value = target.slots[slot];
              stack.push(value instanceof Signal ? value.get() : value);
              break;
            }
            case OP.GET_GLOBAL: {
              const binding = this.bindings[this.links[(code[ip] << 8) | code[ip + 1]]];
              ip += 2;
              stack.push(binding.kind === "signal" ? binding.signal.get() : binding.value);
              break;
            }
            case OP.SET_LOCAL: {
              const depth = code[ip++];
              const slot = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              const value = sanitizeValue(stack.pop());
              let target = frame;
              for (let hop = 0; hop < depth; hop += 1) target = target.parent;
              const current = target.slots[slot];
              if (current instanceof Signal) current.set(value);
              else target.slots[slot] = value;
              break;
            }
            case OP.DEF_LOCAL: {
              const slot = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              frame.slots[slot] = sanitizeValue(stack.pop());
              break;
            }
            case OP.SET_GLOBAL: {
              const ref = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              const binding = this.bindings[this.links[ref]];
              const value = sanitizeValue(stack.pop());
              if (binding.kind !== "signal") throw new JLCRuntimeError(`“${this.module.globalRefs[ref]}”不可赋值`);
              if (!binding.signal.writable) throw new JLCRuntimeError(`“${this.module.globalRefs[ref]}”是只读状态`);
              binding.signal.set(value);
              break;
            }
            case OP.SET_GLOBAL_PATH: {
              // 栈布局：[value, key1, key2, …]（key 最后压入，先弹出）
              const ref = (code[ip] << 8) | code[ip + 1];
              const count = code[ip + 2];
              ip += 3;
              const binding = this.bindings[this.links[ref]];
              const keys = [];
              for (let index = 0; index < count; index += 1) keys.push(safeKey(stack.pop()));
              keys.reverse();
              const value = sanitizeValue(stack.pop());
              if (binding.kind !== "signal") throw new JLCRuntimeError(`“${this.module.globalRefs[ref]}”不可赋值`);
              if (!binding.signal.writable) throw new JLCRuntimeError(`“${this.module.globalRefs[ref]}”是只读状态`);
              binding.signal.set(immutableSet(binding.signal.get(), keys, value));
              break;
            }
            case OP.SET_LOCAL_PATH: {
              // 栈布局：[value, key1, key2, …]
              const depth = code[ip++];
              const slot = (code[ip] << 8) | code[ip + 1];
              const count = code[ip + 2];
              ip += 3;
              const keys = [];
              for (let index = 0; index < count; index += 1) keys.push(safeKey(stack.pop()));
              keys.reverse();
              const value = sanitizeValue(stack.pop());
              let target = frame;
              for (let hop = 0; hop < depth; hop += 1) target = target.parent;
              const current = target.slots[slot];
              if (current instanceof Signal) {
                if (!current.writable) throw new JLCRuntimeError(`“${current.name}”是只读状态`);
                current.set(immutableSet(current.get(), keys, value));
              } else {
                target.slots[slot] = immutableSet(current, keys, value);
              }
              break;
            }
            case OP.GET_MEMBER: {
              const key = stack.pop();
              stack.push(readMember(stack.pop(), key));
              break;
            }

            case OP.ADD: {
              const b = stack.pop();
              const a = stack.pop();
              stack.push(typeof a === "string" || typeof b === "string" ? `${a ?? ""}${b ?? ""}` : requireNumber(a) + requireNumber(b));
              break;
            }
            case OP.SUB: { const b = stack.pop(); const a = stack.pop(); stack.push(requireNumber(a) - requireNumber(b)); break; }
            case OP.MUL: { const b = stack.pop(); const a = stack.pop(); stack.push(requireNumber(a) * requireNumber(b)); break; }
            case OP.DIV: { const b = stack.pop(); const a = stack.pop(); stack.push(requireNumber(a) / requireNumber(b)); break; }
            case OP.MOD: { const b = stack.pop(); const a = stack.pop(); stack.push(requireNumber(a) % requireNumber(b)); break; }
            case OP.POW: { const b = stack.pop(); const a = stack.pop(); stack.push(requireNumber(a) ** requireNumber(b)); break; }
            case OP.EQ: { const b = stack.pop(); const a = stack.pop(); stack.push(Object.is(a, b)); break; }
            case OP.LT: { const b = stack.pop(); const a = stack.pop(); stack.push(a < b); break; }
            case OP.LE: { const b = stack.pop(); const a = stack.pop(); stack.push(a <= b); break; }
            case OP.GT: { const b = stack.pop(); const a = stack.pop(); stack.push(a > b); break; }
            case OP.GE: { const b = stack.pop(); const a = stack.pop(); stack.push(a >= b); break; }
            case OP.IN: {
              const b = stack.pop();
              const a = stack.pop();
              stack.push(ownData(b) && Object.hasOwn(b, safeKey(a)));
              break;
            }
            case OP.NOT: stack.push(!stack.pop()); break;
            case OP.NEG: stack.push(-requireNumber(stack.pop())); break;
            case OP.POS: stack.push(requireNumber(stack.pop())); break;
            case OP.COALESCE: { const b = stack.pop(); const a = stack.pop(); stack.push(a ?? b); break; }

            case OP.JUMP:
              ip = (code[ip] << 8) | code[ip + 1];
              break;
            case OP.JUMP_IF_FALSE: {
              const target = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              if (!stack.pop()) ip = target;
              break;
            }
            case OP.JUMP_IF_TRUE: {
              const target = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              if (stack.pop()) ip = target;
              break;
            }
            case OP.JUMP_IF_NULL: {
              const target = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              if (stack[stack.length - 1] == null) ip = target;
              break;
            }
            case OP.FOR_PREP: {
              const values = normalizeIterable(stack.pop());
              if (values.length > context.runtime.options.maxLoop) throw new JLCRuntimeError("for 循环项目数超限");
              stack.push({ values, index: 0 });
              break;
            }
            case OP.FOR_NEXT: {
              const itemSlot = (code[ip] << 8) | code[ip + 1];
              const indexSlot = (code[ip + 2] << 8) | code[ip + 3];
              const hasIndex = code[ip + 4];
              const target = (code[ip + 5] << 8) | code[ip + 6];
              ip += 7;
              const iterator = stack[stack.length - 1];
              if (iterator.index >= iterator.values.length) {
                stack.pop();
                ip = target;
              } else {
                frame.slots[itemSlot] = iterator.values[iterator.index];
                if (hasIndex) frame.slots[indexSlot] = iterator.index;
                iterator.index += 1;
              }
              break;
            }
            case OP.RETURN: {
              const value = stack.pop();
              const finished = frames.pop();
              if (finished.isAction) this.actionDepth -= 1;
              if (frames.length < baseFrames) return value;
              stack.push(value);
              continue outer;
            }
            case OP.RETURN_NULL: {
              const finished = frames.pop();
              if (finished.isAction) this.actionDepth -= 1;
              if (frames.length < baseFrames) return null;
              stack.push(null);
              continue outer;
            }
            case OP.CALL: {
              const argc = code[ip++];
              const args = argc ? stack.splice(stack.length - argc) : [];
              const callee = stack.pop();
              if (!callee || callee[CALLABLE] !== true) {
                throw new JLCRuntimeError("只能调用 JLC action、内建函数或显式 capability");
              }
              if (typeof callee.actionIndex === "number") {
                if (this.actionDepth >= MAX_ACTION_DEPTH) throw new JLCRuntimeError("action 调用深度超过 100");
                this.actionDepth += 1;
                frame.ip = ip;
                frames.push(this.actionFrame(callee.actionIndex, args));
                continue outer;
              }
              stack.push(callee.invoke(args, context));
              break;
            }

            case OP.TIMER: {
              const mode = code[ip++];
              const funcIndex = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              this.createTimer(mode, stack.pop(), funcIndex);
              break;
            }

            default: {
              const handler = DOM_OPS[opcode];
              if (!handler) throw new JLCRuntimeError(`VM 遇到未知指令 0x${opcode.toString(16)}`);
              frame.ip = ip;
              ip = handler(this, code, ip, frame, context);
              break;
            }
          }
        }
      } catch (error) {
        frame.ip = ip;
        throw error;
      } finally {
        frame.ip = ip;
      }
    }
  }
}

/** DOM / 视图指令处理器：ELEM、ATTR、TEXT、WHEN、EACH …… */
const DOM_OPS = {
  [OP.ELEM](machine, code, ip, _frame, _context) {
    const render = requireRender(machine);
    const cursor = render.cursors[render.cursors.length - 1];
    const tag = machine.pool[(code[ip] << 8) | code[ip + 1]];
    ip += 2;
    const created = createElement(machine.runtime.document, tag, cursor.namespace);
    const childScope = cursor.scope.child(`<${tag}>`);
    registerOwnedNode(machine.runtime, childScope, created.element);
    render.cursors.push({
      parent: created.element,
      before: null,
      scope: childScope,
      namespace: created.namespace,
      element: created.element,
      outerParent: cursor.parent,
      outerBefore: cursor.before,
    });
    return ip;
  },
  [OP.ELEM_END](machine, _code, ip) {
    const render = requireRender(machine);
    const entry = render.cursors.pop();
    entry.outerParent.insertBefore(entry.element, entry.outerBefore);
    return ip;
  },
  [OP.TEXT](machine, code, ip, frame) {
    const render = requireRender(machine);
    const cursor = render.cursors[render.cursors.length - 1];
    const funcIndex = (code[ip] << 8) | code[ip + 1];
    ip += 2;
    const runtime = machine.runtime;
    const text = runtime.document.createTextNode("");
    const textScope = cursor.scope.child("text");
    registerOwnedNode(runtime, textScope, text);
    cursor.parent.insertBefore(text, cursor.before);
    runtime.effect(textScope, () => {
      text.data = toText(machine.runFunction(funcIndex, frame, textScope));
    });
    return ip;
  },
  [OP.ATTR_STATIC](machine, code, ip) {
    const render = requireRender(machine);
    const cursor = render.cursors[render.cursors.length - 1];
    const name = machine.pool[(code[ip] << 8) | code[ip + 1]];
    const value = machine.pool[(code[ip + 2] << 8) | code[ip + 3]];
    ip += 4;
    setNormalAttribute(cursor.parent, name, value);
    return ip;
  },
  [OP.ATTR](machine, code, ip, frame) {
    const render = requireRender(machine);
    const cursor = render.cursors[render.cursors.length - 1];
    const name = machine.pool[(code[ip] << 8) | code[ip + 1]];
    const funcIndex = (code[ip + 2] << 8) | code[ip + 3];
    ip += 4;
    const element = cursor.parent;
    const scope = cursor.scope;
    machine.runtime.effect(scope, () => setNormalAttribute(element, name, machine.runFunction(funcIndex, frame, scope)), 1);
    return ip;
  },
  [OP.CLASS_TOGGLE](machine, code, ip, frame) {
    const render = requireRender(machine);
    const cursor = render.cursors[render.cursors.length - 1];
    const className = machine.pool[(code[ip] << 8) | code[ip + 1]];
    const funcIndex = (code[ip + 2] << 8) | code[ip + 3];
    ip += 4;
    const element = cursor.parent;
    const scope = cursor.scope;
    machine.runtime.effect(scope, () => element.classList.toggle(className, Boolean(machine.runFunction(funcIndex, frame, scope))), 2);
    return ip;
  },
  [OP.STYLE_PROP](machine, code, ip, frame) {
    const render = requireRender(machine);
    const cursor = render.cursors[render.cursors.length - 1];
    const property = machine.pool[(code[ip] << 8) | code[ip + 1]];
    const funcIndex = (code[ip + 2] << 8) | code[ip + 3];
    ip += 4;
    const element = cursor.parent;
    const scope = cursor.scope;
    machine.runtime.effect(scope, () => {
      const value = machine.runFunction(funcIndex, frame, scope);
      if (value == null || value === false) element.style.removeProperty(property);
      else element.style.setProperty(property, String(value));
    }, 2);
    return ip;
  },
  [OP.PROP_SET](machine, code, ip, frame) {
    const render = requireRender(machine);
    const cursor = render.cursors[render.cursors.length - 1];
    const property = machine.pool[(code[ip] << 8) | code[ip + 1]];
    const funcIndex = (code[ip + 2] << 8) | code[ip + 3];
    ip += 4;
    const element = cursor.parent;
    const scope = cursor.scope;
    const normalized = property.toLowerCase();
    machine.runtime.effect(scope, () => {
      let value = machine.runFunction(funcIndex, frame, scope);
      if (URL_ATTRIBUTES.has(normalized)) value = sanitizeUrl(value);
      element[property] = value;
    });
    return ip;
  },
  [OP.STYLE_OBJECT](machine, code, ip, frame) {
    const render = requireRender(machine);
    const cursor = render.cursors[render.cursors.length - 1];
    const funcIndex = (code[ip] << 8) | code[ip + 1];
    ip += 2;
    const element = cursor.parent;
    const scope = cursor.scope;
    let previous = new Set();
    machine.runtime.effect(scope, () => {
      const value = machine.runFunction(funcIndex, frame, scope);
      if (ownData(value) && !Array.isArray(value)) {
        const next = new Set();
        for (const [property, child] of Object.entries(value)) {
          next.add(property);
          if (child == null || child === false) element.style.removeProperty(property);
          else element.style.setProperty(property, String(child));
        }
        for (const property of previous) if (!next.has(property)) element.style.removeProperty(property);
        previous = next;
      } else {
        for (const property of previous) element.style.removeProperty(property);
        previous.clear();
        element.style.cssText = value == null ? "" : String(value);
      }
    });
    return ip;
  },
  [OP.BIND_VALUE](machine, code, ip, frame) {
    return installBind(machine, code, ip, frame, false);
  },
  [OP.BIND_CHECKED](machine, code, ip, frame) {
    return installBind(machine, code, ip, frame, true);
  },
  [OP.EVENT](machine, code, ip, frame) {
    const render = requireRender(machine);
    const cursor = render.cursors[render.cursors.length - 1];
    const type = machine.pool[(code[ip] << 8) | code[ip + 1]];
    const modifiers = code[ip + 2];
    const funcIndex = (code[ip + 3] << 8) | code[ip + 4];
    ip += 5;
    const element = cursor.parent;
    const scope = cursor.scope;
    const options = {
      capture: Boolean(modifiers & 16),
      once: Boolean(modifiers & 8),
      passive: Boolean(modifiers & 32),
    };
    machine.runtime.listen(scope, element, type, (event) => {
      if (modifiers & 4 && event.target !== element) return;
      if (modifiers & 1 && !options.passive) event.preventDefault();
      if (modifiers & 2) event.stopPropagation();
      const eventFrame = { slots: [eventSnapshot(event)], parent: frame };
      const eventContext = machine.runtime.context(scope);
      try {
        machine.runtime.batch(() => {
          const result = machine.runFunction(funcIndex, eventFrame, scope);
          if (result?.[CALLABLE]) result.invoke([], eventContext);
        });
      } catch (error) {
        machine.runtime.reportError(error);
      }
    }, options);
    return ip;
  },
  [OP.WHEN](machine, code, ip, frame) {
    const render = requireRender(machine);
    const cursor = render.cursors[render.cursors.length - 1];
    const testFunc = (code[ip] << 8) | code[ip + 1];
    const yesFunc = (code[ip + 2] << 8) | code[ip + 3];
    const noFunc = (code[ip + 4] << 8) | code[ip + 5];
    ip += 6;
    const runtime = machine.runtime;
    const parent = cursor.parent;
    const before = cursor.before;
    const namespace = cursor.namespace;
    const start = runtime.document.createComment("jlc:when");
    const end = runtime.document.createComment("/jlc:when");
    parent.insertBefore(start, before);
    parent.insertBefore(end, before);
    const controlScope = cursor.scope.child("when");
    let branchScope = null;
    let current = null;
    runtime.effect(controlScope, () => {
      const next = Boolean(machine.runFunction(testFunc, frame, controlScope));
      if (next === current) return;
      branchScope?.dispose();
      clearBetween(start, end);
      branchScope = controlScope.child(next ? "when:yes" : "when:no");
      machine.runView(next ? yesFunc : noFunc, parent, end, branchScope, frame, namespace);
      current = next;
    });
    return ip;
  },
  [OP.EACH](machine, code, ip, frame) {
    const render = requireRender(machine);
    const cursor = render.cursors[render.cursors.length - 1];
    const iterFunc = (code[ip] << 8) | code[ip + 1];
    const keyFunc = (code[ip + 2] << 8) | code[ip + 3];
    const bodyFunc = (code[ip + 4] << 8) | code[ip + 5];
    const emptyFunc = (code[ip + 6] << 8) | code[ip + 7];
    const itemName = machine.pool[(code[ip + 8] << 8) | code[ip + 9]];
    const itemSlot = (code[ip + 10] << 8) | code[ip + 11];
    const hasIndex = code[ip + 12] !== 0;
    const indexSlot = (code[ip + 13] << 8) | code[ip + 14];
    ip += 15;
    const runtime = machine.runtime;
    const parent = cursor.parent;
    const before = cursor.before;
    const namespace = cursor.namespace;
    const start = runtime.document.createComment("jlc:each");
    const end = runtime.document.createComment("/jlc:each");
    parent.insertBefore(start, before);
    parent.insertBefore(end, before);
    const controlScope = cursor.scope.child("each");
    let records = new Map();
    let emptyRecord = null;

    runtime.effect(controlScope, () => {
      const values = normalizeIterable(machine.runFunction(iterFunc, frame, controlScope));
      if (values.length > runtime.options.maxLoop) throw new JLCRuntimeError("each 项目数超限");
      const keys = [];
      const seen = new Set();
      for (let index = 0; index < values.length; index += 1) {
        let key = index;
        if (keyFunc !== NO_FUNC) {
          const preset = new Array(machine.functions[keyFunc].nSlots).fill(null);
          preset[0] = values[index];
          if (hasIndex) preset[1] = index;
          key = machine.runFunction(keyFunc, frame, controlScope, { preset });
        }
        if (seen.has(key)) throw new JLCRuntimeError(`each 出现重复 key：${toText(key)}`);
        seen.add(key);
        keys.push(key);
      }

      const nextRecords = new Map();
      for (let index = 0; index < values.length; index += 1) {
        const key = keys[index];
        let record = records.get(key);
        if (record) {
          record.item.set(values[index], true);
          record.index?.set(index, true);
        } else {
          const recordScope = controlScope.child(`each:${toText(key)}`);
          const item = new Signal(runtime, values[index], false, itemName);
          const indexSignal = hasIndex ? new Signal(runtime, index, false, "index") : null;
          const bodyPreset = new Array(machine.functions[bodyFunc].nSlots).fill(null);
          bodyPreset[0] = item;
          if (hasIndex) bodyPreset[1] = indexSignal;
          const recordStart = runtime.document.createComment("jlc:item");
          const recordEnd = runtime.document.createComment("/jlc:item");
          parent.insertBefore(recordStart, end);
          parent.insertBefore(recordEnd, end);
          machine.runView(bodyFunc, parent, recordEnd, recordScope, frame, namespace, { preset: bodyPreset });
          record = { scope: recordScope, item, index: indexSignal, start: recordStart, end: recordEnd };
        }
        nextRecords.set(key, record);
      }

      for (const [key, record] of records) {
        if (!nextRecords.has(key)) {
          record.scope.dispose();
          record.item.detach();
          record.index?.detach();
          removeInclusive(record.start, record.end);
        }
      }
      records = nextRecords;

      let anchor = end;
      const ordered = [...records.values()];
      for (let index = ordered.length - 1; index >= 0; index -= 1) {
        moveInclusive(parent, ordered[index].start, ordered[index].end, anchor);
        anchor = ordered[index].start;
      }

      if (values.length === 0 && !emptyRecord) {
        const emptyStart = runtime.document.createComment("jlc:empty");
        const emptyEnd = runtime.document.createComment("/jlc:empty");
        parent.insertBefore(emptyStart, end);
        parent.insertBefore(emptyEnd, end);
        const emptyScope = controlScope.child("each:empty");
        machine.runView(emptyFunc, parent, emptyEnd, emptyScope, frame, namespace);
        emptyRecord = { scope: emptyScope, start: emptyStart, end: emptyEnd };
      } else if (values.length > 0 && emptyRecord) {
        emptyRecord.scope.dispose();
        removeInclusive(emptyRecord.start, emptyRecord.end);
        emptyRecord = null;
      }
    });
    return ip;
  },
};

function requireRender(machine) {
  if (!machine.render) throw new JLCRuntimeError("DOM 指令只能在视图函数中执行");
  return machine.render;
}

function installBind(machine, code, ip, frame, checked) {
  const render = requireRender(machine);
  const cursor = render.cursors[render.cursors.length - 1];
  const getFunc = (code[ip] << 8) | code[ip + 1];
  const setFunc = (code[ip + 2] << 8) | code[ip + 3];
  ip += 4;
  const property = checked ? "checked" : "value";
  const element = cursor.parent;
  const scope = cursor.scope;
  const runtime = machine.runtime;
  runtime.effect(scope, () => {
    const value = machine.runFunction(getFunc, frame, scope);
    const normalized = checked ? Boolean(value) : value ?? "";
    if (!Object.is(element[property], normalized)) element[property] = normalized;
  });
  const eventType = !checked && ["INPUT", "TEXTAREA"].includes(element.tagName) ? "input" : "change";
  runtime.listen(scope, element, eventType, () => {
    try {
      runtime.batch(() => machine.runFunction(setFunc, frame, scope, {
        preset: [checked ? Boolean(element[property]) : element[property]],
      }));
    } catch (error) {
      runtime.reportError(error);
    }
  });
  return ip;
}

/* ================================================================
 * 运行时宿主（Runtime）
 * ================================================================ */

function createRouteSnapshot(windowObject) {
  if (!windowObject?.location) return Object.freeze({ path: "/", query: Object.freeze(Object.create(null)), hash: "", state: null });
  const query = Object.create(null);
  try {
    const parameters = new URLSearchParams(windowObject.location.search ?? "");
    for (const [key, value] of parameters) {
      if (Object.hasOwn(query, key)) query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
      else query[key] = value;
    }
  } catch {
    // A non-browser test location may not fully implement URL semantics.
  }
  return Object.freeze({
    path: windowObject.location.pathname ?? "/",
    query: Object.freeze(query),
    hash: (windowObject.location.hash ?? "").replace(/^#/u, ""),
    state: sanitizeValue(windowObject.history?.state ?? null),
  });
}

function createBuiltins(runtime) {
  const builtins = new Map();
  const add = (name, function_) => builtins.set(name, { kind: "value", value: callable(name, function_) });
  const unary = (name, function_) => add(name, ([value]) => function_(value));

  add("len", ([value]) => value == null ? 0 : typeof value === "string" || Array.isArray(value) ? value.length : ownData(value) ? Object.keys(value).length : 0);
  unary("string", (value) => value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
  unary("number", (value) => requireNumber(value));
  unary("bool", (value) => Boolean(value));
  unary("upper", (value) => String(value ?? "").toUpperCase());
  unary("lower", (value) => String(value ?? "").toLowerCase());
  unary("trim", (value) => String(value ?? "").trim());
  add("join", ([value, separator = ","]) => Array.isArray(value) ? value.join(String(separator)) : "");
  add("slice", ([value, start = 0, end]) => typeof value === "string" || Array.isArray(value) ? value.slice(Number(start), end == null ? undefined : Number(end)) : null);
  add("at", ([value, index]) => typeof value === "string" || Array.isArray(value) ? value.at(Number(index)) ?? null : null);
  add("get", ([value, key, fallback = null]) => readMember(value, key) ?? fallback);
  add("has", ([value, key]) => ownData(value) && Object.hasOwn(value, safeKey(key)));
  unary("keys", (value) => ownData(value) ? Object.keys(value).filter((key) => !BLOCKED_KEYS.has(key)) : []);
  unary("values", (value) => ownData(value) ? Object.entries(value).filter(([key]) => !BLOCKED_KEYS.has(key)).map(([, child]) => child) : []);
  unary("entries", (value) => ownData(value) ? Object.entries(value).filter(([key]) => !BLOCKED_KEYS.has(key)).map(([key, child]) => [key, child]) : []);
  add("range", ([start, end, step = 1]) => {
    let from = requireNumber(start);
    let to = end == null ? from : requireNumber(end);
    if (end == null) from = 0;
    const stride = requireNumber(step);
    if (stride === 0) throw new JLCRuntimeError("range 步长不能为 0");
    const output = [];
    for (let value = from; stride > 0 ? value < to : value > to; value += stride) {
      if (output.length >= runtime.options.maxLoop) throw new JLCRuntimeError("range 结果超限");
      output.push(value);
    }
    return output;
  });
  add("append", ([value, ...items]) => [...(Array.isArray(value) ? value : []), ...items]);
  add("prepend", ([value, ...items]) => [...items, ...(Array.isArray(value) ? value : [])]);
  add("removeAt", ([value, index]) => {
    const output = Array.isArray(value) ? [...value] : [];
    output.splice(Number(index), 1);
    return output;
  });
  add("replaceAt", ([value, index, item]) => {
    const output = Array.isArray(value) ? [...value] : [];
    output[Number(index)] = item;
    return output;
  });
  add("merge", (values) => Object.assign(Object.create(null), ...values.filter((value) => ownData(value) && !Array.isArray(value))));
  unary("json", (value) => JSON.stringify(value));
  unary("parseJson", (value) => sanitizeValue(JSON.parse(String(value))));
  add("min", (values) => Math.min(...values.map((value) => requireNumber(value))));
  add("max", (values) => Math.max(...values.map((value) => requireNumber(value))));
  unary("round", (value) => Math.round(requireNumber(value)));
  unary("floor", (value) => Math.floor(requireNumber(value)));
  unary("ceil", (value) => Math.ceil(requireNumber(value)));
  unary("abs", (value) => Math.abs(requireNumber(value)));
  add("clamp", ([value, minimum, maximum]) => Math.min(requireNumber(maximum), Math.max(requireNumber(minimum), requireNumber(value))));
  add("now", () => Date.now());

  add("http", ([url, options = Object.create(null)]) => {
    const request = Object.create(null);
    request[REQUEST] = true;
    request.url = String(url ?? "");
    request.options = sanitizeValue(options);
    return Object.freeze(request);
  });
  add("reload", ([snapshot]) => {
    const resource = ownData(snapshot) ? RESOURCE_META.get(snapshot) : null;
    if (!resource) throw new JLCRuntimeError("reload 参数必须是 resource 状态");
    resource.reload();
    return null;
  });
  add("navigate", ([url, state = null]) => {
    runtime.navigate(String(url), sanitizeValue(state), false);
    return null;
  });
  add("replace", ([url, state = null]) => {
    runtime.navigate(String(url), sanitizeValue(state), true);
    return null;
  });
  add("emit", ([name, detail = null]) => {
    if (!runtime.target?.dispatchEvent) return false;
    const EventClass = runtime.window?.CustomEvent ?? globalThis.CustomEvent;
    if (!EventClass) return false;
    return runtime.target.dispatchEvent(new EventClass(String(name), { detail: sanitizeValue(detail), bubbles: true }));
  });
  add("title", ([value]) => {
    if (runtime.document) runtime.document.title = String(value ?? "");
    return null;
  });

  return builtins;
}

class Runtime {
  constructor(kernel, target, options) {
    this.kernel = kernel;
    this.target = target;
    this.document = target.ownerDocument ?? globalThis.document;
    this.window = this.document?.defaultView ?? globalThis.window;
    this.options = {
      maxSteps: options.maxSteps ?? kernel.options.maxSteps,
      maxLoop: options.maxLoop ?? kernel.options.maxLoop,
      autoDispose: options.autoDispose ?? kernel.options.autoDispose,
    };
    this.onError = options.onError ?? kernel.options.onError;
    this.fetch = options.fetch ?? kernel.options.fetch ?? this.window?.fetch?.bind(this.window) ?? globalThis.fetch?.bind(globalThis);
    this.initialState = options.state && typeof options.state === "object" ? options.state : Object.create(null);
    this.capabilities = options.capabilities ?? Object.create(null);
    this.ownedNodes = new Map();
    this.metrics = { scopes: 0, effects: 0, listeners: 0, timers: 0, requests: 0 };
    this.batchDepth = 0;
    this.destroyed = false;
    this.initializing = true;
    this.scheduler = new Scheduler(this);
    this.globals = new GlobalTable();
    this.module = null;
    this.machine = null;
    this.links = null;
    this.rootScope = new Scope(this, null, "app");
    this.routeSignal = new Signal(this, createRouteSnapshot(this.window), false, "$route");
  }

  context(scope = this.rootScope) {
    return { runtime: this, scope, steps: 0, depth: 0 };
  }

  effect(scope, callback, priority = 1, signal = null) {
    return new Effect(this, scope, callback, priority, signal);
  }

  batch(callback) {
    this.batchDepth += 1;
    try {
      return callback();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.scheduler.queue.size && !this.scheduler.pending) {
        this.scheduler.pending = true;
        queueMicrotask(() => {
          if (!this.scheduler) return;
          this.scheduler.pending = false;
          this.scheduler.flush();
        });
      }
    }
  }

  reportError(error) {
    const normalized = error instanceof Error ? error : new JLCRuntimeError(String(error));
    if (this.onError) {
      try {
        this.onError(normalized);
      } catch (handlerError) {
        console.error("JLC onError failed", handlerError);
      }
    } else {
      console.error("JLC runtime error", normalized);
    }
  }

  listen(scope, target, type, listener, options = {}) {
    if (!target?.addEventListener) throw new JLCRuntimeError("目标不支持事件监听");
    let release = null;
    const registeredListener = options.once
      ? function onceListener(...argumentsList) {
        try {
          return listener.apply(this, argumentsList);
        } finally {
          // Native `once` removes the listener but cannot update ownership
          // metrics; releasing here also drops the retained callback eagerly.
          release?.();
        }
      }
      : listener;
    let actualOptions = options;
    let controller = null;
    const AbortControllerClass = this.window?.AbortController ?? globalThis.AbortController;
    if (AbortControllerClass) {
      try {
        controller = new AbortControllerClass();
        actualOptions = { ...options, signal: controller.signal };
      } catch {
        controller = null;
      }
    }
    try {
      target.addEventListener(type, registeredListener, actualOptions);
    } catch {
      controller = null;
      actualOptions = options;
      target.addEventListener(type, registeredListener, actualOptions);
    }
    this.metrics.listeners += 1;
    release = scope.own(() => {
      try {
        controller?.abort();
        target.removeEventListener(type, registeredListener, actualOptions);
      } finally {
        this.metrics.listeners -= 1;
      }
    });
    return release;
  }

  navigate(url, state, replace) {
    if (!this.window?.history) throw new JLCRuntimeError("当前环境不支持路由");
    try {
      if (replace) this.window.history.replaceState(state, "", url);
      else this.window.history.pushState(state, "", url);
      this.routeSignal.set(createRouteSnapshot(this.window), true);
    } catch (error) {
      throw new JLCRuntimeError(`无法导航到“${url}”`, error);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rootScope?.dispose();
    this.scheduler?.clear();
    for (const binding of this.globals?.bindings ?? []) {
      if (binding.kind === "signal") binding.signal.detach();
    }
    this.routeSignal?.detach();
    this.globals?.clear();
    this.rootScope = null;
    this.globals = null;
    this.module = null;
    this.machine = null;
    this.links = null;
    this.routeSignal = null;
    this.capabilities = null;
    this.initialState = null;
    this.onError = null;
    this.options = null;
    this.kernel = null;
    this.ownedNodes?.clear();
    this.ownedNodes = null;
    this.target = null;
    this.document = null;
    this.window = null;
    this.fetch = null;
    this.scheduler = null;
  }
}

/* ================================================================
 * 链接与安装（verify → link → execute）
 * ================================================================ */

function actionCallable(runtime, actionIndex) {
  const action = runtime.module.actions[actionIndex];
  return callable(action.name, (argumentsList, parentContext) => {
    if ((parentContext?.depth ?? 0) >= 100) throw new JLCRuntimeError("action 调用深度超过 100");
    return runtime.machine.enterAction(actionIndex, argumentsList, parentContext);
  });
}

function capabilityCallable(name, function_) {
  return callable(name, (argumentsList) => {
    const result = function_(...argumentsList);
    if (result && typeof result.then === "function") {
      throw new JLCRuntimeError(`同步表达式中的 capability“${name}”不能返回 Promise，请使用 resource + http`);
    }
    return sanitizeValue(result);
  });
}

function installEnvironment(runtime, module) {
  const table = runtime.globals;
  const reserved = new Set();

  for (const [name, binding] of createBuiltins(runtime)) {
    reserved.add(name);
    table.define(name, binding);
  }
  table.define("$route", { kind: "signal", signal: runtime.routeSignal });
  reserved.add("$route");

  for (const [name, function_] of Object.entries(runtime.capabilities ?? {})) {
    if (reserved.has(name)) throw new JLCRuntimeError(`capability“${name}”与内建名称冲突`);
    if (typeof function_ !== "function") throw new JLCRuntimeError(`capability“${name}”必须是函数`);
    reserved.add(name);
    table.define(name, { kind: "value", value: capabilityCallable(name, function_) });
  }

  runtime.module = module;
  runtime.machine = new Machine(runtime, module);

  for (const declaration of module.declarations) {
    if (declaration.kind === "style") continue;
    if (reserved.has(declaration.name) || table.has(declaration.name)) {
      throw new JLCRuntimeError(`声明名“${declaration.name}”重复或被保留`);
    }
    reserved.add(declaration.name);
    if (declaration.kind === "state") {
      table.define(declaration.name, { kind: "signal", signal: new Signal(runtime, null, true, declaration.name) });
    } else {
      table.define(declaration.name, { kind: "signal", signal: new Signal(runtime, null, false, declaration.name) });
    }
  }

  for (const [index, action] of module.actions.entries()) {
    if (reserved.has(action.name) || table.has(action.name)) {
      throw new JLCRuntimeError(`声明名“${action.name}”重复或被保留`);
    }
    reserved.add(action.name);
    table.define(action.name, { kind: "value", value: actionCallable(runtime, index) });
  }

  // 链接：把模块的全局引用解析为全局槽表索引（等价 JVM 的动态链接）。
  const links = new Int32Array(module.globalRefs.length);
  for (let index = 0; index < module.globalRefs.length; index += 1) {
    const name = module.globalRefs[index];
    if (!table.has(name)) throw new JLCRuntimeError(`未定义名称“${name}”`);
    links[index] = table.names.get(name);
  }
  runtime.links = links;
  runtime.machine.link(table.bindings, links);

  // 初始化：state 初值 → derive → resource，与 AST 版语义一致。
  const machine = runtime.machine;
  for (const declaration of module.declarations) {
    if (declaration.kind !== "state") continue;
    const overridden = Object.hasOwn(runtime.initialState, declaration.name);
    const value = overridden ? runtime.initialState[declaration.name] : machine.runFunction(declaration.func, null, runtime.rootScope);
    table.resolve(declaration.name).signal.set(sanitizeValue(value), true);
  }

  for (const declaration of module.declarations) {
    if (declaration.kind !== "derive") continue;
    const signal = table.resolve(declaration.name).signal;
    runtime.effect(runtime.rootScope, () => {
      signal.computing = true;
      try {
        signal.set(sanitizeValue(machine.runFunction(declaration.func, null, runtime.rootScope)), true);
      } finally {
        signal.computing = false;
      }
    }, 0, signal);
  }

  for (const declaration of module.declarations) {
    if (declaration.kind === "resource") installResource(runtime, declaration);
  }

  if (runtime.window?.addEventListener) {
    runtime.listen(runtime.rootScope, runtime.window, "popstate", () => {
      runtime.routeSignal.set(createRouteSnapshot(runtime.window), true);
    });
  }
}

function resourceSnapshot(resource, data = null, error = null, loading = false, status = null) {
  const snapshot = Object.freeze({ data, error, loading, status });
  RESOURCE_META.set(snapshot, resource);
  return snapshot;
}

function installResource(runtime, declaration) {
  const machine = runtime.machine;
  const signal = runtime.globals.resolve(declaration.name).signal;
  const refresh = new Signal(runtime, 0, true, `${declaration.name}:reload`);
  const resource = {
    reload() {
      refresh.set(refresh.get() + 1);
    },
  };
  signal.set(resourceSnapshot(resource, null, null, true, null), true);

  runtime.effect(runtime.rootScope, () => {
    refresh.get();
    const descriptor = machine.runFunction(declaration.func, null, runtime.rootScope);
    if (!descriptor?.[REQUEST]) throw new JLCRuntimeError(`resource“${declaration.name}”必须使用 http(...)`);
    if (!runtime.fetch) throw new JLCRuntimeError("当前环境没有 fetch，mount 时可注入 options.fetch");

    // Read without dependency tracking: a resource must react to its request
    // expression and reload token, never to the snapshot it produces itself.
    const previous = signal.value;
    signal.set(resourceSnapshot(resource, previous?.data ?? null, null, true, previous?.status ?? null), true);
    const Controller = runtime.window?.AbortController ?? globalThis.AbortController;
    const controller = Controller ? new Controller() : null;
    let active = true;
    runtime.metrics.requests += 1;
    const finish = () => {
      if (!active) return false;
      active = false;
      runtime.metrics.requests -= 1;
      return true;
    };
    ACTIVE_EFFECT.onCleanup(() => {
      controller?.abort();
      finish();
    });

    const requestOptions = descriptor.options ?? Object.create(null);
    const headers = Object.assign(Object.create(null), requestOptions.headers ?? null);
    let body = requestOptions.body ?? undefined;
    if (body != null && typeof body === "object") {
      body = JSON.stringify(body);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    }
    const fetchOptions = {
      method: String(requestOptions.method ?? "GET").toUpperCase(),
      headers,
      body,
      credentials: requestOptions.credentials ?? "same-origin",
      signal: controller?.signal,
    };
    const fail = (error) => {
      if (!finish() || runtime.destroyed || error?.name === "AbortError") return;
      signal.set(resourceSnapshot(resource, previous?.data ?? null, Object.freeze({
        name: String(error?.name ?? "Error"),
        message: String(error?.message ?? error),
      }), false, null), true);
    };
    let pending;
    try {
      pending = Promise.resolve(runtime.fetch(descriptor.url, fetchOptions));
    } catch (error) {
      fail(error);
      return;
    }
    pending.then(async (response) => {
      let data;
      const mode = requestOptions.as ?? "auto";
      if (mode === "text") data = await response.text();
      else if (mode === "blob") data = await response.blob();
      else {
        const type = response.headers?.get?.("content-type") ?? "";
        data = mode === "json" || type.includes("json") ? await response.json() : await response.text();
      }
      const safeData = mode === "blob" ? null : sanitizeValue(data);
      if (!finish() || runtime.destroyed) return;
      if (response.ok) signal.set(resourceSnapshot(resource, safeData, null, false, response.status), true);
      else signal.set(resourceSnapshot(resource, safeData, Object.freeze({ message: `HTTP ${response.status}`, status: response.status }), false, response.status), true);
    }).catch(fail);
  }, 1);
}

function installStyles(runtime, module) {
  const machine = runtime.machine;
  for (const declaration of module.declarations) {
    if (declaration.kind !== "style") continue;
    const style = runtime.document.createElement("style");
    style.setAttribute("data-jlc-style", module.app);
    (runtime.document.head ?? runtime.target).appendChild(style);
    runtime.rootScope.own(() => style.remove());
    runtime.effect(runtime.rootScope, () => {
      style.textContent = String(machine.runFunction(declaration.func, null, runtime.rootScope) ?? "");
    });
  }
}

function setupAutoDispose(runtime, start, end, unmount) {
  if (!runtime.options.autoDispose) return;
  const Observer = runtime.window?.MutationObserver ?? globalThis.MutationObserver;
  const root = runtime.document?.documentElement;
  if (!Observer || !root) return;
  let everConnected = Boolean(start.isConnected && end.isConnected);
  let queued = false;
  const observer = new Observer((records) => {
    if (runtime.destroyed) return;
    if (start.isConnected && end.isConnected) {
      everConnected = true;
    } else if (everConnected && !queued) {
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!runtime.destroyed && (!start.isConnected || !end.isConnected)) unmount();
      });
      return;
    }

    // DOM manipulated by host code still obeys JLC ownership: detached text or
    // element nodes immediately lose their effects/listeners and child scopes.
    const visitRemoved = (node) => {
      if (node.isConnected) return; // It was moved, not removed.
      const ownedScope = runtime.ownedNodes.get(node);
      if (ownedScope) {
        ownedScope.dispose();
        return;
      }
      for (const child of node.childNodes ?? []) visitRemoved(child);
    };
    for (const record of records) {
      for (const node of record.removedNodes ?? []) visitRemoved(node);
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  runtime.rootScope.own(() => observer.disconnect());
}

/* ================================================================
 * 程序与内核
 * ================================================================ */

export class JLCProgram {
  constructor(kernel, module, { ast = null, source = null, sourceName = "<jlc>" } = {}) {
    this.kernel = kernel;
    this.module = module;
    this.ast = ast;
    this.source = source;
    this.sourceName = sourceName;
    Object.freeze(this);
  }

  get name() {
    return this.module.app;
  }

  serialize() {
    return encodeModule(this.module);
  }

  disassemble() {
    return disassembleModule(this.module);
  }

  mount(target, options = {}) {
    return this.kernel.mount(this, target, options);
  }
}

function resolveModule(value) {
  if (value instanceof JLCProgram) {
    if (!value.module.verified) verifyModule(value.module, value.sourceName);
    return value.module;
  }
  if (value && value.format === "jlc-bytecode") {
    if (!value.verified) verifyModule(value, value.sourceName ?? "<jbc>");
    return value;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return loadModule(value instanceof Uint8Array ? value : new Uint8Array(value), { sourceName: "<jbc>" });
  }
  return null;
}

export function loadModule(bytes, { sourceName = "<jbc>" } = {}) {
  return decodeModule(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { sourceName });
}

export class VMKernel {
  constructor(options = {}) {
    this.options = Object.freeze({
      maxSteps: options.maxSteps ?? 100_000,
      maxLoop: options.maxLoop ?? 10_000,
      autoDispose: options.autoDispose ?? true,
      onError: options.onError ?? null,
      fetch: options.fetch ?? null,
    });
    this.version = VERSION;
  }

  /** 仅运行时内核：不能编译源码，只能装载字节码。 */
  compile() {
    throw new JLCRuntimeError("VM 内核不包含编译器：请使用完整内核 JLC.compile() 或 jlc-compiler.js 先生成字节码");
  }

  tokenize() {
    throw new JLCRuntimeError("VM 内核不包含 Tokenizer：请使用完整内核 JLC.tokenize()");
  }

  parse() {
    throw new JLCRuntimeError("VM 内核不包含 Parser：请使用完整内核 JLC.parse()");
  }

  load(bytes, options = {}) {
    return loadModule(bytes, options);
  }

  /** 反汇编字节码模块、JLCProgram 或 .jbc 二进制（调试视图）。 */
  disassemble(source) {
    const module = resolveModule(source);
    return module ? disassembleModule(module) : "";
  }

  mount(sourceOrModule, targetOrSelector, options = {}) {
    const module = resolveModule(sourceOrModule);
    if (!module) {
      throw new JLCRuntimeError("VM 内核只能挂载字节码模块、JLCProgram 或 .jbc 二进制；编译 JLC 源码请使用完整内核");
    }
    const appName = module.app;
    const documentObject = options.document ?? globalThis.document;
    const target = typeof targetOrSelector === "string" ? documentObject?.querySelector(targetOrSelector) : targetOrSelector;
    if (!target?.insertBefore) throw new JLCRuntimeError("mount 目标不存在或不是 DOM 元素");
    const runtime = new Runtime(this, target, options);
    let start = null;
    let end = null;
    let active = true;
    let rootScope = runtime.rootScope;
    let finalMetrics = null;

    const handle = {
      get active() { return active; },
      get name() { return appName; },
      get(name) {
        if (!active) throw new JLCRuntimeError("应用已卸载");
        return sanitizeValue(bindingValue(runtime.globals.resolve(name)));
      },
      set(name, value) {
        if (!active) throw new JLCRuntimeError("应用已卸载");
        const binding = runtime.globals.resolve(name);
        if (binding.kind !== "signal" || !binding.signal.writable) throw new JLCRuntimeError(`“${name}”不是可写状态`);
        runtime.batch(() => binding.signal.set(sanitizeValue(value)));
        return handle;
      },
      call(name, ...argumentsList) {
        if (!active) throw new JLCRuntimeError("应用已卸载");
        const value = bindingValue(runtime.globals.resolve(name));
        if (!value?.[CALLABLE]) throw new JLCRuntimeError(`“${name}”不是 action`);
        const result = runtime.batch(() => value.invoke(argumentsList.map((argument) => sanitizeValue(argument)), runtime.context(rootScope)));
        return sanitizeValue(result);
      },
      flush() {
        if (active) runtime.scheduler.flush();
        return handle;
      },
      inspect() {
        return Object.freeze({ ...(active ? runtime.metrics : finalMetrics), active });
      },
      unmount() {
        if (!active) return;
        active = false;
        runtime.destroy();
        if (start && end) removeInclusive(start, end);
        finalMetrics = { scopes: 0, effects: 0, listeners: 0, timers: 0, requests: 0 };
        start = null;
        end = null;
        rootScope = null;
      },
    };

    try {
      if (options.replace !== false) target.replaceChildren?.();
      start = runtime.document.createComment(`jlc:${appName}`);
      end = runtime.document.createComment(`/jlc:${appName}`);
      target.appendChild(start);
      target.appendChild(end);
      installEnvironment(runtime, module);
      installStyles(runtime, module);
      runtime.machine.runView(module.view, target, end, rootScope, null, null);
      setupAutoDispose(runtime, start, end, handle.unmount);
      runtime.initializing = false;
      return Object.freeze(handle);
    } catch (error) {
      runtime.initializing = false;
      handle.unmount();
      if (error instanceof JLCCompileError || error instanceof JLCRuntimeError || error instanceof JLCVerifyError) throw error;
      throw new JLCRuntimeError(`挂载 ${appName} 失败`, error);
    }
  }

  /** 挂载 <script type="text/jbc">：src 指向 .jbc 文件，或内联 base64。 */
  async boot(root = globalThis.document, options = {}) {
    if (!root?.querySelectorAll) throw new JLCRuntimeError("boot 需要 Document 或 Element");
    const scripts = [...root.querySelectorAll("script")]
      .filter((script) => (script.getAttribute?.("type") ?? script.type) === "text/jbc");
    const handles = [];
    try {
      for (const script of scripts) {
        let bytes;
        if (script.src) {
          const response = await (options.fetch ?? globalThis.fetch)(script.src);
          if (!response.ok) throw new JLCRuntimeError(`无法加载 ${script.src}: HTTP ${response.status}`);
          bytes = new Uint8Array(await response.arrayBuffer());
        } else {
          const text = (script.textContent ?? "").replace(/\s+/gu, "");
          const binary = atob(text);
          bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        }
        const selector = script.dataset?.target;
        const target = selector ? (script.ownerDocument ?? root).querySelector(selector) : script.nextElementSibling;
        if (!target) throw new JLCRuntimeError("text/jbc 脚本需要 data-target，或紧邻一个挂载元素");
        let state = options.state;
        if (script.dataset?.state) state = JSON.parse(script.dataset.state);
        handles.push(this.mount(loadModule(bytes, { sourceName: script.src || "<inline-jbc>" }), target, { ...options, state }));
      }
      return handles;
    } catch (error) {
      for (const handle of handles) handle.unmount();
      throw error;
    }
  }
}

export function createVMKernel(options = {}) {
  return new VMKernel(options);
}

export const JLCVM = new VMKernel();
export default JLCVM;
