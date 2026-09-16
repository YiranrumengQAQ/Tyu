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

export const VERSION = "0.4.0";
export const BYTECODE_VERSION = 2;
export const ACCEPTED_BYTECODE_VERSIONS = [1, 2]; // 1 = 无需求清单的旧模块，运行期仍逐条把关
export const ABI_VERSION = "jlc-abi/2";
export const MAGIC = 0x4a4c4342; // "JLCB" — JLC Bytecode container

const CALLABLE = Symbol("jlc.callable");
const REQUEST = Symbol("jlc.request");
const RESOURCE_META = new WeakMap();
const IFRAME_STATE = new WeakMap();

/* ---- 不可协商的硬限制：任何策略档都无权打开（内核的“内核态代码”） ---- */
export const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const HARD_BLOCKED_TAGS = new Set(["script", "object", "embed", "base"]);
export const HARD_BLOCKED_PROPERTIES = new Set(["innerhtml", "outerhtml", "srcdoc"]);
export const FORBIDDEN_URL_PREFIXES = ["javascript:", "vbscript:", "livescript:", "mocha:", "data:text/html"];

/* ---- 由策略（profile）决定的部分：0.2 里写死，0.3 变成数据 ---- */
export const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href", "xlinkhref", "srcdoc"]);
export const BLOCKED_TAGS = HARD_BLOCKED_TAGS; // 兼容 0.2 的导出名
export const BLOCKED_PROPERTIES = HARD_BLOCKED_PROPERTIES;
// window 位（64）：监听挂到 window 上，但生命周期仍归该元素的 Scope 管。
export const EVENT_MODIFIERS = ["prevent", "stop", "self", "once", "capture", "passive", "window"];
export const EVENT_MODIFIER_BITS = { prevent: 1, stop: 2, self: 4, once: 8, capture: 16, passive: 32, window: 64 };
export const BUILTIN_NAMES = [
  "len", "string", "number", "bool", "upper", "lower", "trim", "join", "slice", "at",
  "get", "has", "keys", "values", "entries", "range", "append", "prepend", "removeAt",
  "replaceAt", "merge", "json", "parseJson", "min", "max", "round", "floor", "ceil",
  "abs", "clamp", "now", "http", "reload", "navigate", "replace", "emit", "title", "favicon",
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

/** 策略拒绝：字节码申请了宿主不授予的接口（内核的 EPERM）。 */
export class JLCPolicyError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "JLCPolicyError";
    this.code = "EPERM_POLICY";
    this.isPolicyError = true;
  }
}

/** 配额越界：实例超出宿主分配的资源预算（内核的 ENOSPC / RLIMIT）。 */
export class JLCQuotaError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "JLCQuotaError";
    this.code = "ENOSPC_QUOTA";
    this.isPolicyError = true;
  }
}

/** 隔离违规：试图在应用子树之外读写 DOM（内核的 EPERM on mm）。 */
export class JLCIsolationError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "JLCIsolationError";
    this.code = "EPERM_REALM";
    this.isPolicyError = true;
  }
}

/* ================================================================
 * 安全策略引擎（Security Policy / Capability Table）
 *
 * 0.2：安全 = 写死的黑名单 + 编译器语法拒绝。
 * 0.3：安全 = 「字节码申报接口需求 → 载入期按策略裁决 → 运行期强制不变量」。
 *
 * 这带来一个反直觉但正确的结果：语言可以放开（iframe、data:、自定义元素、
 * 窗口事件都能写），而系统更安全——因为能力按实例授予、不可协商的加固项由
 * 内核补齐（sandbox 不可覆盖、URL 走 WHATWG 白名单解析），越权在挂载期
 * 就整体失败，留下半个界面的情况不再存在。
 * ================================================================ */

export const URL_SCHEME_SAFE = Object.freeze(["about:", "http:", "https:", "mailto:", "tel:", "sms:", "ftp:", "geo:"]);
export const URL_SCHEME_MEDIA = Object.freeze([...URL_SCHEME_SAFE, "blob:", "data:", "srcdoc:", "magnet:"]);

export const SECURITY_PROFILES = Object.freeze({
  strict: {
    label: "严格档 · 与 0.2 行为等价",
    urlSchemes: URL_SCHEME_SAFE,
    allowDataUrls: false,
    allowBlobUrls: false,
    allowCustomElements: false,
    allowEventAttributes: false,
    allowSandboxedFrames: false,
    allowHtmlInjection: false,
    allowNetwork: true,
    allowNavigation: true,
    allowTimer: true,
    allowWindowEvents: false,
    allowStyleScopingRelax: false,
    frameSandbox: "",
    frameMinIntervalMs: 16,
    htmlMaxChars: 0,
    blockedTags: ["script", "object", "embed", "base", "meta"],
    maxDomNodes: 4000,
    maxStyleBytes: 65536,
    styleScoping: "off",
    strictUrls: false,
    gateMode: "audit",
  },
  open: {
    label: "开放档 · 更像真实浏览器，但每个特权都带内核加固",
    urlSchemes: URL_SCHEME_MEDIA,
    allowDataUrls: true,
    allowBlobUrls: true,
    allowCustomElements: true,
    allowEventAttributes: false,
    allowSandboxedFrames: true,
    allowHtmlInjection: true,
    allowNetwork: true,
    allowNavigation: true,
    allowTimer: true,
    allowWindowEvents: true,
    allowStyleScopingRelax: true,
    frameSandbox: "allow-scripts allow-forms allow-popups",
    frameMinIntervalMs: 4,
    htmlMaxChars: 256 * 1024,
    blockedTags: ["script", "object", "embed", "base"],
    maxDomNodes: 20000,
    maxStyleBytes: 131072,
    styleScoping: "prefix",
    strictUrls: false,
    gateMode: "audit",
  },
  trusted: {
    label: "受信档 · 第一方字节码：放开界面，仍禁 innerHTML 与脚本 URL",
    urlSchemes: URL_SCHEME_MEDIA,
    allowDataUrls: true,
    allowBlobUrls: true,
    allowCustomElements: true,
    allowEventAttributes: false,
    allowSandboxedFrames: true,
    allowHtmlInjection: true,
    allowNetwork: true,
    allowNavigation: true,
    allowTimer: true,
    allowWindowEvents: true,
    allowStyleScopingRelax: true,
    frameSandbox: "allow-scripts allow-forms allow-popups allow-modals allow-same-origin",
    frameMinIntervalMs: 0,
    htmlMaxChars: 2 * 1024 * 1024,
    blockedTags: ["script", "object", "embed", "base"],
    maxDomNodes: 60000,
    maxStyleBytes: 512 * 1024,
    styleScoping: "off",
    strictUrls: false,
    gateMode: "audit",
  },
});

export const POLICY_KEYS = Object.freeze([
  "urlSchemes", "allowDataUrls", "allowBlobUrls", "allowCustomElements", "allowEventAttributes",
  "allowSandboxedFrames", "allowHtmlInjection", "allowNetwork", "allowNavigation", "allowTimer",
  "allowCustomEvents", "allowDocumentTitle", "allowWindowEvents", "allowStyleScopingRelax",
  "frameSandbox", "frameMinIntervalMs", "htmlMaxChars",
  "maxDomNodes", "maxStyleBytes", "styleScoping", "gateMode", "blockedTags", "blockedProperties",
  "blockedAttributes", "strictUrls", "capabilityAllowlist", "audit", "label",
]);

/** 策略字段 → 人类可读说明；同时是文档与 playground 权限面板的唯一数据源。 */
export const SYSCALLS = Object.freeze([
  { permission: "tag:<自定义元素>", field: "allowCustomElements", note: "连字符标签（Web Components 可以自己 attachShadow）" },
  { permission: "frame:iframe", field: "allowSandboxedFrames", note: "可创建 <iframe>；内核强制补 sandbox/referrerpolicy/loading" },
  { permission: "frame:srcdoc", field: "allowHtmlInjection", note: "向沙箱 frame 注入 HTML（走 iframe.srcdoc / Blob，永不走 innerHTML）" },
  { permission: "url:<scheme>", field: "urlSchemes", note: "URL 属性允许协议；默认只净化不拒挂载，strictUrls: true 时升级为挂载期失败" },
  { permission: "attr:on*", field: "allowEventAttributes", note: "直接写 on* 字符串属性；默认必须用 on:* 事件动作" },
  { permission: "prop:innerHTML", field: "allowHtmlInjection", note: "写 HTML 解析类 property：一律拒绝（用 frame:srcdoc 代替）" },
  { permission: "host:http", field: "allowNetwork", note: "resource / http() 出网请求" },
  { permission: "host:navigate", field: "allowNavigation", note: "history.pushState / replaceState（路由）" },
  { permission: "host:timer", field: "allowTimer", note: "after / every；every 周期可被 frameMinIntervalMs 抬升" },
  { permission: "host:event", field: "allowCustomEvents", note: "emit() 派发 CustomEvent" },
  { permission: "host:title", field: "allowDocumentTitle", note: "title() 写 document.title" },
  { permission: "host:favicon", field: "allowDocumentTitle", note: "favicon() 写 link[rel=icon]（SVG 源码自动转 data: URL，其余走 URL 净化）" },
  { permission: "window:event", field: "allowWindowEvents", note: "app 级 onWindow 监听（宿主代持，随实例卸载而解绑）" },
  { permission: "style:url", field: "allowDataUrls", note: "CSS url() 中的 data: 资源" },
  { permission: "style:global", field: "styleScoping", note: "style 声明是否被重写为只作用于本实例子树（prefix = 隔离，off = 全局）" },
  { permission: "quota:dom", field: "maxDomNodes", note: "本实例可同时存在的受管节点数" },
  { permission: "quota:style", field: "maxStyleBytes", note: "单个 style 声明的字节数上限" },
  { permission: "quota:html", field: "htmlMaxChars", note: "单个 srcdoc 的字符数上限" },
]);

const DEFAULT_BLOCKED_TAGS = new Set(["script", "object", "embed", "base", "meta"]);
const DEFAULT_BLOCKED_PROPERTIES = new Set(["innerhtml", "outerhtml", "srcdoc", "contentwindow", "contentdocument", "location", "document", "defaultview", "parentnode", "host"]);
const DEFAULT_BLOCKED_ATTRIBUTES = new Set(["formaction"]);

const toSet = (value, fallback) => {
  if (value == null) return new Set(fallback);
  return new Set(Array.isArray(value) ? value : [...value]);
};

function fingerprintOf(values) {
  let hash = 0x811c9dc5;
  for (const text of values) {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x20;
  }
  return `0x${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** 解析策略：档名（可带覆盖项）或内联对象，结果冻结并带指纹。 */
export function resolvePolicy(input = "strict") {
  const requested = typeof input === "string" ? { profile: input } : (input ?? {});
  if (requested !== null && typeof requested !== "object") {
    throw new JLCRuntimeError(`策略必须是档名或对象，收到 ${typeof requested}`);
  }
  const knownKeys = new Set([...POLICY_KEYS, "profile", "name"]);
  for (const key of Object.keys(requested)) {
    // 打错的字段名会静默失效——在安全策略里这是最糟的失败模式，直接拒绝。
    if (!knownKeys.has(key)) {
      throw new JLCRuntimeError(`未知策略字段“${key}”：可用字段 ${POLICY_KEYS.join(", ")}`);
    }
  }
  const name = requested.profile ?? requested.name ?? "strict";
  const base = SECURITY_PROFILES[name];
  const profileName = base ? name : "custom";
  const template = base ?? SECURITY_PROFILES.strict;
  const merged = { ...template, ...requested };
  const policy = {
    version: 1,
    profile: profileName,
    label: merged.label ?? template.label ?? `策略 ${profileName}`,
    urlSchemes: Object.freeze(
      (Array.isArray(merged.urlSchemes) ? merged.urlSchemes : URL_SCHEME_SAFE)
        .map((scheme) => (scheme.endsWith(":") ? scheme.toLowerCase() : `${String(scheme).toLowerCase()}:`)),
    ),
    allowDataUrls: Boolean(merged.allowDataUrls),
    allowBlobUrls: Boolean(merged.allowBlobUrls),
    allowCustomElements: Boolean(merged.allowCustomElements),
    allowEventAttributes: Boolean(merged.allowEventAttributes),
    allowSandboxedFrames: Boolean(merged.allowSandboxedFrames),
    allowHtmlInjection: Boolean(merged.allowHtmlInjection),
    allowNetwork: merged.allowNetwork !== false,
    allowNavigation: merged.allowNavigation !== false,
    allowTimer: merged.allowTimer !== false,
    allowCustomEvents: merged.allowCustomEvents !== false,
    allowDocumentTitle: merged.allowDocumentTitle !== false,
    allowWindowEvents: Boolean(merged.allowWindowEvents),
    allowStyleScopingRelax: Boolean(merged.allowStyleScopingRelax),
    frameSandbox: String(merged.frameSandbox ?? ""),
    frameMinIntervalMs: Math.max(0, Number(merged.frameMinIntervalMs ?? 16) || 0),
    htmlMaxChars: Math.max(0, Math.floor(Number(merged.htmlMaxChars ?? 0) || 0)),
    strictUrls: Boolean(merged.strictUrls),
    maxDomNodes: Math.max(1, Math.floor(Number(merged.maxDomNodes ?? 4000) || 1)),
    maxStyleBytes: Math.max(0, Math.floor(Number(merged.maxStyleBytes ?? 65536) || 0)),
    styleScoping: merged.styleScoping === "off" ? "off" : "prefix",
    gateMode: merged.gateMode === "error" ? "error" : "audit",
    blockedTags: toSet(merged.blockedTags, DEFAULT_BLOCKED_TAGS),
    blockedProperties: toSet(merged.blockedProperties, DEFAULT_BLOCKED_PROPERTIES),
    blockedAttributes: toSet(merged.blockedAttributes, DEFAULT_BLOCKED_ATTRIBUTES),
    capabilityAllowlist: merged.capabilityAllowlist == null ? null : Object.freeze([...merged.capabilityAllowlist]),
    audit: typeof merged.audit === "function" ? merged.audit : null,
  };
  // 指纹覆盖全部策略字段（label 只用于显示，不参与）：任何一处不同，指纹就不同。
  policy.fingerprint = fingerprintOf(Object.keys(policy).sort().flatMap((key) => {
    if (key === "label" || key === "fingerprint") return [];
    const value = policy[key];
    if (value == null) return [`${key}=none`];
    if (typeof value === "function") return [`${key}=fn`];
    if (value instanceof Set) return [`${key}=${[...value].sort().join("|")}`];
    if (Array.isArray(value)) return [`${key}=${value.join("|")}`];
    return [`${key}=${value}`];
  }));
  return Object.freeze(policy);
}

const FALLBACK_STRICT_POLICY = resolvePolicy("strict");

function notePolicy(runtime, entry) {
  const audit = runtime?.policy?.audit;
  if (!audit) return;
  try {
    audit({ ...entry, app: runtime.module?.app ?? runtime.scopeId, policy: runtime.policy.profile, at: Date.now() });
  } catch {
    // 审计回调异常不得影响内核执行
  }
}

/** 硬限制：任何 fault 档都不能绕过（降级只针对「可授予的能力」）。 */
function isHardViolation(kind, detail) {
  const value = String(detail ?? "").toLowerCase();
  if (kind === "tag") return HARD_BLOCKED_TAGS.has(value);
  if (kind === "property") return HARD_BLOCKED_PROPERTIES.has(value);
  if (kind === "url") return FORBIDDEN_URL_PREFIXES.some((prefix) => value.startsWith(prefix));
  return false;
}

/** 单条接口需求对策略的判定：返回拒绝原因，null 表示允许。审计与运行期共用。 */
export function policyViolation(policy, kind, detail) {
  const value = String(detail ?? "");
  if (kind === "tag") {
    const tag = value.toLowerCase();
    if (HARD_BLOCKED_TAGS.has(tag)) return `硬限制：<${tag}> 不属于任何策略档`;
    if (tag === "iframe") return policy.allowSandboxedFrames ? null : "allowSandboxedFrames = false";
    if (tag.includes("-") && !policy.allowCustomElements) return "allowCustomElements = false";
    if (policy.blockedTags.has(tag)) return `blockedTags 命中 <${tag}>`;
    return null;
  }
  if (kind === "frame") {
    if (!policy.allowSandboxedFrames) return "allowSandboxedFrames = false";
    if (value === "srcdoc" && !policy.allowHtmlInjection) return "allowHtmlInjection = false（注入 HTML 需单独授予）";
    return null;
  }
  if (kind === "url") {
    // 默认「净化而不是拒绝挂载」：写坏的 URL 变成 about:blank，页面照常活著。
    // 需要把非法协议升级成挂载期硬失败的宿主，打开 strictUrls。
    if (!policy.strictUrls) return null;
    if (FORBIDDEN_URL_PREFIXES.some((prefix) => value.startsWith(prefix))) return "不可协商：脚本型 URL 协议永禁";
    if (value === "data:") return policy.allowDataUrls ? null : "allowDataUrls = false";
    if (value === "blob:") return policy.allowBlobUrls ? null : "allowBlobUrls = false";
    if (value === "srcdoc:") return policy.allowSandboxedFrames && policy.allowHtmlInjection ? null : "srcdoc: 需要 frame + HTML 注入两项授权";
    return policy.urlSchemes.includes(value) ? null : `协议 ${value} 不在 urlSchemes 白名单`;
  }
  if (kind === "property") {
    const property = value.toLowerCase();
    if (HARD_BLOCKED_PROPERTIES.has(property)) return "硬限制：HTML 解析类 property 永禁，请改用沙箱 frame";
    if (property.startsWith("on")) return policy.allowEventAttributes ? null : "allowEventAttributes = false";
    return policy.blockedProperties.has(property) ? "blockedProperties 命中" : null;
  }
  if (kind === "attribute") {
    if (/^on/iu.test(value)) return policy.allowEventAttributes ? null : "allowEventAttributes = false，事件请写 on:*";
    return policy.blockedAttributes.has(value.toLowerCase()) ? "blockedAttributes 命中" : null;
  }
  if (kind === "host") {
    if (value === "http") return policy.allowNetwork ? null : "allowNetwork = false";
    if (value === "navigate" || value === "replace") return policy.allowNavigation ? null : "allowNavigation = false";
    if (value === "timer") return policy.allowTimer ? null : "allowTimer = false";
    if (value === "emit") return policy.allowCustomEvents ? null : "allowCustomEvents = false";
    if (value === "title") return policy.allowDocumentTitle ? null : "allowDocumentTitle = false";
    if (value === "favicon") return policy.allowDocumentTitle ? null : "allowDocumentTitle = false";
    return null;
  }
  if (kind === "window") return policy.allowWindowEvents ? null : "allowWindowEvents = false";
  if (kind === "capability") {
    if (!policy.capabilityAllowlist) return null;
    return policy.capabilityAllowlist.includes(value) ? null : "capability 不在 capabilityAllowlist 白名单内";
  }
  return null;
}

/**
 * 载入期唯一的强制点：静态接口 → 策略裁决。
 * mode = "stop" 时返回全部越权项（由调用方决定抛出）；这里只算不改。
 */
export function checkPermissions(requirements, policy) {
  const denied = [];
  const seen = new Set();
  for (const requirement of requirements ?? []) {
    const reason = policyViolation(policy, requirement.kind, requirement.detail);
    if (!reason) continue;
    const key = `${requirement.kind}:${requirement.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    denied.push({ ...requirement, reason, key });
  }
  return denied;
}

function requirementKey(kind, detail) {
  return `${kind}:${detail ?? ""}`;
}

/**
 * 运行期接口闸门。返回 "allow" 或 "skip"（降级：跳过这一步，实例继续跑）。
 * stop 档在挂载期就整体失败，这里只兜住动态面（值相关的 URL、配额等）。
 */
function guardSurface(runtime, kind, detail, message) {
  if (!runtime) return "allow";
  const key = requirementKey(kind, detail);
  const violation = runtime.deniedSet?.has(key)
    ? runtime.deniedReasons?.get(key) ?? "策略拒绝"
    : policyViolation(runtime.policy, kind, detail);
  if (!violation) return "allow";
  if (isHardViolation(kind, detail)) {
    runtime.metrics.faults += 1;
    throw new JLCPolicyError(message ?? `${key} 属于内核硬限制，任何策略档与 fault 档都不放行：${violation}`);
  }
  if (runtime.faultMode === "report") {
    notePolicy(runtime, { action: "report", kind, detail, message: violation });
    return "allow";
  }
  if (runtime.faultMode === "degrade") {
    runtime.metrics.faults += 1;
    if (!runtime.denied.some((item) => item.key === key)) {
      runtime.denied.push({ kind, detail, reason: violation, message: message ?? null, key });
    }
    notePolicy(runtime, { action: "degrade", kind, detail, message: violation });
    return "skip";
  }
  throw new JLCPolicyError(message ?? `策略 ${runtime.policy.profile} 拒绝接口 ${key}：${violation}`);
}

function policyDeny(runtime, kind, detail, message) {
  if (guardSurface(runtime, kind, detail, message) === "skip") return true;
  return false;
}

function policyAllow(runtime, kind, detail, message) {
  if (runtime?.policy?.audit && message) notePolicy(runtime, { action: "allow", kind, detail, message });
}

/* ================================================================
 * 接口清单（Manifest）：从指令流静态扫描，不可伪造
 * ================================================================ */

const RESOLVED_ATTRIBUTE_NAMES = new Map();

function resolveAttributeName(rawName) {
  let name = RESOLVED_ATTRIBUTE_NAMES.get(rawName);
  if (name !== undefined) return name;
  name = String(rawName ?? "");
  if (name.startsWith("attr:")) name = name.slice(5).replaceAll(":", "-");
  else if (name.startsWith("data:")) name = `data-${name.slice(5).replaceAll(":", "-")}`;
  else if (name.startsWith("aria:")) name = `aria-${name.slice(5).replaceAll(":", "-")}`;
  RESOLVED_ATTRIBUTE_NAMES.set(rawName, name);
  return name;
}

function urlSchemeOf(text) {
  const compact = String(text ?? "").replace(/[\u0000-\u0020]+/gu, "");
  const match = compact.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:)/u);
  return match ? match[1].toLowerCase() : null;
}

/**
 * 扫描视图/动作指令，收集模块真正会调用的宿主接口。
 * 与 .jbc 的 MANIFEST 段交叉核对：申报少了 → 载入失败（防伪造）。
 */
export function auditModule(module) {
  const found = new Map();
  const add = (kind, detail, where) => {
    const key = requirementKey(kind, detail);
    if (!found.has(key)) found.set(key, { kind, detail, key, sites: [] });
    const entry = found.get(key);
    if (entry.sites.length < 4) entry.sites.push(where);
  };
  for (const func of module.functions) {
    const code = func.code;
    let ip = 0;
    while (ip < code.length) {
      const at = ip;
      const opcode = code[ip];
      const spec = OP_SPEC[opcode];
      if (!spec) { ip += 1; continue; }
      ip += 1;
      const values = [];
      for (const descriptor of spec.operands) {
        if (descriptor === "B") values.push(code[ip++]);
        else if (descriptor === "I") {
          values.push(((code[ip] << 24) | (code[ip + 1] << 16) | (code[ip + 2] << 8) | code[ip + 3]) | 0);
          ip += 4;
        } else {
          values.push((code[ip] << 8) | code[ip + 1]);
          ip += 2;
        }
      }
      switch (opcode) {
        case OP.ELEM: {
          const tag = String(module.pool[values[0]] ?? "").toLowerCase();
          // <iframe> 只申报 frame:*，避免同一处越权被记成两条。
          if (tag === "iframe") add("frame", "iframe", `${func.name}@${at}`);
          else add("tag", tag, `${func.name}@${at}`);
          break;
        }
        case OP.ATTR_STATIC:
        case OP.ATTR: {
          const name = resolveAttributeName(module.pool[values[0]]);
          // srcdoc 一律按 frame:srcdoc 记账：即使降级成了占位元素，也不该被记成两次。
          if (name === "srcdoc") add("frame", "srcdoc", `${func.name}@${at}`);
          if (/^on/iu.test(name)) add("attribute", name, `${func.name}@${at}`);
          if (URL_ATTRIBUTES.has(name.toLowerCase()) && opcode === OP.ATTR_STATIC) {
            const scheme = urlSchemeOf(module.pool[values[1]]);
            if (scheme) add("url", scheme, `${func.name}@${at}`);
          }
          break;
        }
        case OP.PROP_SET: {
          const property = String(module.pool[values[0]] ?? "").toLowerCase();
          if (property) add("property", property, `${func.name}@${at}`);
          break;
        }
        case OP.GET_GLOBAL: {
          const name = module.globalRefs[values[0]];
          if (name === "http") add("host", "http", `${func.name}@${at}`);
          else if (name === "navigate" || name === "replace") add("host", "navigate", `${func.name}@${at}`);
          else if (name === "emit") add("host", "emit", `${func.name}@${at}`);
          else if (name === "title") add("host", "title", `${func.name}@${at}`);
          else if (name === "favicon") add("host", "favicon", `${func.name}@${at}`);
          break;
        }
        case OP.TIMER:
          add("host", "timer", `${func.name}@${at}`);
          break;
        case OP.EVENT:
          if (values[1] & 64) add("window", "event", `${func.name}@${at}`);
          break;
        default:
          break;
      }
    }
  }
  return [...found.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
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

  if (value instanceof Map) {
    const output = Object.create(null);
    seen.set(value, output);
    for (const [key, child] of value) {
      const safe = String(key);
      if (!BLOCKED_KEYS.has(safe)) output[safe] = sanitizeValue(child, seen, depth + 1);
    }
    return output;
  }
  if (value instanceof Set) {
    const output = [];
    seen.set(value, output);
    for (const child of value) output.push(sanitizeValue(child, seen, depth + 1));
    return output;
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

function callable(name, invoke, extra = null) {
  const value = { [CALLABLE]: true, name, invoke };
  if (extra) Object.assign(value, extra);
  return Object.freeze(value);
}

function requireNumber(value, name = "值") {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    const shown = typeof value === "string" ? `“${value.slice(0, 40)}”` : String(value).slice(0, 40);
    throw new JLCRuntimeError(`${name}必须是有限数字，收到 ${shown}`);
  }
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
  if (array && /^(0|[1-9]\d*)$/u.test(key) && Number(key) > output.length) {
    // 越界下标写成密集数组，避免留下 new Array(n) 的空洞（hole 会让后续读取变成 undefined）。
    while (output.length < Number(key)) output.push(null);
  }
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
    const stranded = [];
    try {
      while (this.queue.size) {
        if (++rounds > 1000) throw new JLCRuntimeError("响应式更新超过 1000 轮，可能存在循环依赖");
        const effects = [...this.queue].sort((left, right) => left.priority - right.priority || left.id - right.id);
        this.queue.clear();
        for (let index = 0; index < effects.length; index += 1) {
          const effect = effects[index];
          effect.queued = false;
          if (effect.disposed) continue;
          // 一个 effect 抛错不能连累同批未执行的 effect：剩下的先跑完，错误最后上报。
          try {
            effect.run();
          } catch (error) {
            stranded.push(error);
            for (const rest of effects.slice(index + 1)) {
              try {
                if (!rest.disposed) rest.run();
              } catch (nested) {
                stranded.push(nested);
              }
            }
            throw error;
          }
        }
      }
    } catch (error) {
      for (const effect of this.queue) effect.queued = false;
      this.queue.clear();
      for (const strandedError of stranded) this.runtime.reportError(strandedError);
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
  JUMP_IF_NONNULL: 0x49,
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
  [OP.EACH]: { name: "EACH", operands: "FFFFPSBS", stack: 0, dom: true },
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

const SECTION = { POOL: 1, GLOBALS: 2, FUNCS: 3, ACTIONS: 4, DECLS: 5, VIEW: 6, META: 7, MANIFEST: 8 };
const POOL_NULL = 0, POOL_TRUE = 1, POOL_FALSE = 2, POOL_NUM = 3, POOL_STR = 4;
const REQUIREMENT_KINDS = ["tag", "frame", "url", "property", "attribute", "host", "window", "style", "capability"];
const REQUIREMENT_KIND_CODES = Object.fromEntries(REQUIREMENT_KINDS.map((name, index) => [name, index + 1]));
const REQUIREMENT_KIND_NAMES = ["", ...REQUIREMENT_KINDS];
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
  {
    // MANIFEST：接口申报清单（权威版本由验证器从指令流重算，此处仅镜像）
    const manifest = new ByteWriter();
    const requirements = module.requirements ?? [];
    manifest.u16(requirements.length);
    for (const requirement of requirements) {
      manifest.u8(REQUIREMENT_KIND_CODES[requirement.kind] ?? 0);
      manifest.str(String(requirement.detail ?? ""));
    }
    sections.push([SECTION.MANIFEST, manifest]);
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
  if (!ACCEPTED_BYTECODE_VERSIONS.includes(version)) {
    throw new JLCVerifyError(`不支持的字节码版本 ${version}（本内核 ABI ${ABI_VERSION}，接受 ${ACCEPTED_BYTECODE_VERSIONS.join("/") || version}）`, sourceName);
  }
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
  if (payloads.has(SECTION.MANIFEST)) {
    const manifest = new ByteReader(payloads.get(SECTION.MANIFEST), sourceName);
    const count = manifest.u16();
    const declared = [];
    for (let index = 0; index < count; index += 1) {
      const kind = REQUIREMENT_KIND_NAMES[manifest.u8()] ?? "tag";
      declared.push(`${kind}:${manifest.str()}`);
    }
    module.declaredRequirements = declared;
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
  if (Array.isArray(module.requirements)) {
    for (const requirement of module.requirements) {
      if (Array.isArray(requirement.sites)) Object.freeze(requirement.sites);
      Object.freeze(requirement);
    }
    Object.freeze(module.requirements);
  }
  if (Array.isArray(module.declaredRequirements)) Object.freeze(module.declaredRequirements);
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
        if (descriptor === "F" && value !== NO_FUNC && value >= module.functions.length) fail(`${func.name}@${start}: 函数索引越界`);
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

  // 接口清单（capability manifest）：从指令流静态重算，申报段只能少报不能多报。
  // 已冻结的模块说明它刚被解开、清单已在解码期算过，这里只核对。
  const audit = auditModule(module);
  if (!Object.isFrozen(module)) module.requirements = audit;
  const declared = module.declaredRequirements;
  if (declared) {
    const actual = new Set(audit.map((item) => item.key));
    const missing = [...actual].filter((key) => !declared.includes(key));
    if (missing.length) fail(`申报清单与指令流不一致，漏报接口：${missing.join(", ")}`);
  }
  return module;
}

/* ================================================================
 * 反汇编器（调试视图）
 * ================================================================ */

export function disassembleModule(module) {
  const lines = [];
  const requirements = module.requirements ?? [];
  lines.push(`; JLC bytecode module — app ${module.app} (${module.sourceName})`);
  lines.push(`; version ${module.version}, abi ${ABI_VERSION}, pool ${module.pool.length}, globals ${module.globalRefs.length}, functions ${module.functions.length}`);
  lines.push(`; interfaces required: ${requirements.length}`);
  lines.push("");
  lines.push(".pool");
  module.pool.forEach((value, index) => {
    lines.push(`  [${index}] ${typeof value === "string" ? JSON.stringify(value) : String(value)}`);
  });
  if (requirements.length) {
    lines.push("");
    lines.push(".requires");
    for (const requirement of requirements) {
      const sites = (requirement.sites ?? []).slice(0, 2).join(", ");
      lines.push(`  ${requirement.key}${sites ? `   ; ${sites}` : ""}`);
    }
  }
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
          else if (descriptor === "F") parts.push(value === NO_FUNC ? "—" : `fn#${value} ${module.functions[value]?.name ?? "?"}`);
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

const INERT_URL = "about:blank";

/**
 * 策略化 URL 净化：白名单协议 + WHATWG 解析（不再靠 startsWith 猜）。
 * 返回 null 表示「本策略不允许」——调用点决定是替换成 about:blank 还是抛策略陷阱。
 */
export function sanitizeUrlWithPolicy(value, policy, { base = null, allowRelative = true } = {}) {
  const text = String(value ?? "").trim();
  if (text === "") return "";
  const compact = text.replace(/[\u0000-\u001f\u007f\u0020]+/gu, "").toLowerCase();
  for (const prefix of FORBIDDEN_URL_PREFIXES) if (compact.startsWith(prefix)) return null;
  if (base === null && !/^[a-z][a-z0-9+.-]*:/iu.test(text)) return allowRelative ? text : null;
  let parsed = null;
  try {
    parsed = base ? new URL(text, base) : new URL(text);
  } catch {
    // 相对 URL：解析不了就按同文档片段处理，交由浏览器上下文决定。
    return allowRelative ? text : null;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (FORBIDDEN_URL_PREFIXES.some((prefix) => `${scheme}${parsed.href.slice(scheme.length, scheme.length + 16)}`.startsWith(prefix))) return null;
  if (scheme === "data:") return policy.allowDataUrls && SAFE_DATA_MIMES.test(parsed.href.slice(0, 96)) ? text : null;
  if (scheme === "blob:") return policy.allowBlobUrls ? text : null;
  if (scheme === "srcdoc:") return policy.allowSandboxedFrames && policy.allowHtmlInjection ? text : null;
  return policy.urlSchemes.includes(scheme) ? text : null;
}

const SAFE_DATA_MIMES = /^data:\s*(image\/(png|gif|webp|avif|bmp|jpe?g|svg\+xml)|text\/plain|application\/json|font\/(woff2?|otf|ttf)|audio\/(mpeg|wav|ogg)|video\/(mp4|webm))[,;.]/iu;

function sanitizeUrl(value, policy) {
  const sanitized = sanitizeUrlWithPolicy(value, policy);
  return sanitized === null ? INERT_URL : sanitized;
}

/** 沙箱 frame 的不可协商加固：sandbox 永远由内核写，应用改不掉。 */
const FRAME_SANDBOX_FORBIDDEN = /^sandbox$/iu;
const FRAME_URL_ATTRIBUTES = new Set(["src", "href", "formaction"]);

function frameStateOf(element, runtime, scope) {
  let state = IFRAME_STATE.get(element);
  if (!state) {
    state = { sandbox: runtime.policy.frameSandbox, blobUrl: null, pending: null, srcdoc: "" };
    IFRAME_STATE.set(element, state);
    scope.own(() => {
      if (state.blobUrl && runtime.window?.URL?.revokeObjectURL) runtime.window.URL.revokeObjectURL(state.blobUrl);
      state.blobUrl = null;
      IFRAME_STATE.delete(element);
    });
  }
  return state;
}

function setFrameSource(element, runtime, scope, kind, value) {
  const policy = runtime.policy;
  const state = frameStateOf(element, runtime, scope);
  const text = value == null ? "" : String(value);
  if (kind === "sandbox") {
    // 不可协商：sandbox 只由策略写。应用改它的尝试被忽略并记账，而不是把整块界面搞崩。
    notePolicy(runtime, { action: "ignore", kind: "frame", detail: "sandbox", message: "sandbox 由内核托管：请用 policy.frameSandbox 调整" });
    runtime.metrics.faults += 1;
    return;
  }
  if (kind === "srcdoc") {
    if (policyDeny(runtime, "frame", "srcdoc", `策略 ${policy.profile} 未授予 HTML 注入（frame:srcdoc）`)) return;
    if (policy.htmlMaxChars > 0 && text.length > policy.htmlMaxChars) {
      const message = `srcdoc 长度 ${text.length} 超过配额 htmlMaxChars=${policy.htmlMaxChars}`;
      if (runtime.faultMode === "degrade") {
        runtime.metrics.faults += 1;
        runtime.denied.push({ kind: "quota", detail: "htmlMaxChars", reason: message, key: "quota:html" });
        notePolicy(runtime, { action: "degrade", kind: "quota", detail: "html", message });
        return;
      }
      throw new JLCQuotaError(message);
    }
    state.pending = text;
    state.srcdoc = text;
    // 大文档走 Blob URL：小文档走 srcdoc——两条路都在 opaque 沙箱里。
    const createObjectURL = runtime.window?.URL?.createObjectURL ?? globalThis.URL?.createObjectURL;
    if (text.length > 4096 && createObjectURL && typeof Blob === "function") {
      const blob = new Blob([text], { type: "text/html;charset=utf-8" });
      const nextUrl = createObjectURL.call(runtime.window?.URL ?? globalThis.URL, blob);
      if (state.blobUrl && runtime.window?.URL?.revokeObjectURL) runtime.window.URL.revokeObjectURL(state.blobUrl);
      state.blobUrl = nextUrl;
      element.setAttribute("src", nextUrl);
      element.removeAttribute("srcdoc");
      return;
    }
    if (state.blobUrl) {
      runtime.window?.URL?.revokeObjectURL?.(state.blobUrl);
      state.blobUrl = null;
      element.removeAttribute("src");
    }
    element.setAttribute("srcdoc", text);
    return;
  }
  if (/^srcdoc:/iu.test(text)) {
    setFrameSource(element, runtime, scope, "srcdoc", text.replace(/^srcdoc:/iu, ""));
    return;
  }
  const sanitized = sanitizeUrl(text, policy);
  if (sanitized === INERT_URL && text !== "") {
    notePolicy(runtime, { action: "neutralize", kind: "url", detail: "frame:src", message: `frame src“${text.slice(0, 64)}”协议不在白名单，已替换为 about:blank` });
  } else {
    policyAllow(runtime, "frame", "src", null);
  }
  element.setAttribute("src", sanitized);
}

function setNormalAttribute(element, rawName, value, runtime = null, scope = null) {
  const policy = runtime?.policy;
  let name = rawName;
  if (name.startsWith("attr:")) name = name.slice(5).replaceAll(":", "-");
  if (name.startsWith("data:")) name = `data-${name.slice(5).replaceAll(":", "-")}`;
  if (name.startsWith("aria:")) name = `aria-${name.slice(5).replaceAll(":", "-")}`;
  if (/^on/iu.test(name)) {
    if (policy?.allowEventAttributes === true) {
      // 只有宿主显式授权才允许字符串事件属性——这是真正的逃逸口，默认（含 open 档）关闭。
      policyAllow(runtime, "attribute", name, "allowEventAttributes：字符串事件属性由宿主自担风险");
      if (value == null || value === false) element.removeAttribute(name);
      else element.setAttribute(name, String(value));
      return;
    }
    throw new JLCRuntimeError(`禁止直接设置事件属性“${name}”，请使用 on:${name.slice(2)}`);
  }
  const localName = (element.localName ?? element.tagName ?? "").toLowerCase();
  if (localName === "iframe" && (name === "srcdoc" || name === "sandbox")) {
    setFrameSource(element, runtime, scope, name, value);
    return;
  }
  if (policy?.blockedAttributes.has(name.toLowerCase())) {
    policyDeny(runtime, "attribute", name, `策略 ${policy.profile} 禁止属性“${name}”`);
  }
  if (name === "srcdoc" && localName !== "iframe") {
    // 非 frame 元素上的 srcdoc 没有意义：仍然按 frame:srcdoc 授权，避免同一处申请被记两遍。
    if (policyDeny(runtime, "frame", "srcdoc", `策略 ${(policy ?? FALLBACK_STRICT_POLICY).profile} 未授予 HTML 注入（frame:srcdoc）`)) return;
  }
  if (URL_ATTRIBUTES.has(name.toLowerCase())) {
    const before = value;
    value = sanitizeUrl(value, policy ?? FALLBACK_STRICT_POLICY);
    if (value === INERT_URL && before != null && String(before).trim() !== "") {
      runtime.neutralized += 1;
      notePolicy(runtime, { action: "neutralize", kind: "url", detail: name, message: `“${String(before).slice(0, 64)}”不在协议白名单，已替换为 about:blank` });
    }
  }
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

function createElement(documentObject, tag, namespace, runtime = null, scope = null) {
  const normalized = tag.toLowerCase();
  const policy = runtime?.policy;
  if (HARD_BLOCKED_TAGS.has(normalized)) {
    throw new JLCPolicyError(`禁止创建 <${normalized}>：硬限制，任何策略档与 fault 档都不放行`);
  }
  const surfaceKind = normalized === "iframe" ? "frame" : "tag";
  if (policy && guardSurface(runtime, surfaceKind, normalized) === "skip") {
    // 降级：换成专属占位元素——结构仍然配平，越权点肉眼可见，也不会撞应用自己的类名。
    const substitute = documentObject.createElement("jlc-denied");
    substitute.setAttribute("data-jlc-denied", normalized);
    substitute.setAttribute("class", "jlc-denied");
    substitute.setAttribute("role", "note");
    return { element: substitute, namespace: null, denied: normalized };
  }
  const svgNamespace = "http://www.w3.org/2000/svg";
  const nextNamespace = normalized === "svg" ? svgNamespace : namespace;
  const element = nextNamespace
    ? documentObject.createElementNS(nextNamespace, tag)
    : documentObject.createElement(tag);
  if (normalized === "iframe" && runtime) {
    // 内核托管的加固项：先写死，应用的属性覆盖不了（sandbox 走策略值）。
    element.setAttribute("sandbox", policy.frameSandbox);
    if (!element.getAttribute("referrerpolicy")) element.setAttribute("referrerpolicy", "no-referrer");
    element.setAttribute("loading", "lazy");
    frameStateOf(element, runtime, scope);
    policyAllow(runtime, "frame", "iframe", null);
  }
  return { element, namespace: nextNamespace };
}

function registerOwnedNode(runtime, scope, node) {
  runtime.ownedNodes.set(node, scope);
  const nodes = (runtime.metrics.nodes += 1);
  const limit = runtime.policy?.maxDomNodes ?? 0;
  if (limit > 0 && nodes > limit) {
    throw new JLCQuotaError(`受管 DOM 节点数 ${nodes} 超过配额 maxDomNodes=${limit}（实例被拒绝继续创建节点）`);
  }
  scope.own(() => {
    runtime.ownedNodes?.delete(node);
    if (runtime.metrics) runtime.metrics.nodes -= 1;
  });
}

/* ---- 隔离域（realm）：strict 档下应用只能在自己的子树里写 DOM ---- */
function withinRealm(runtime, node) {
  const root = runtime?.realmElement ?? runtime?.target;
  if (!root || !node) return false;
  if (node === root) return true;
  if (typeof root.contains === "function" && root.contains(node)) return true;
  if (typeof node.contains === "function" && node.contains(root)) return true; // 临时脱离文档的自建子树
  if (typeof node.compareDocumentPosition === "function") return (node.compareDocumentPosition(root) & 16) === 16;
  for (let current = node.parentNode; current; current = current.parentNode) if (current === root) return true;
  return false;
}

function insertInto(runtime, parent, node, before) {
  if (runtime?.isolation === "strict") {
    // 强制断言：父节点必须位于当前实例的隔离域内。
    // 唯一豁免：尚未接入文档、且由本运行时自建的构建中游标父节点——
    // 它接入文档的那一刻仍会经过本函数统一把关，逃不出隔离域。
    // 由此杜绝任何对宿主根容器外部的节点插入（包括外部传入的游离节点）。
    if (parent && !withinRealm(runtime, parent)) {
      const ownBuild = !parent.isConnected && runtime.ownedNodes?.has(parent);
      if (!ownBuild) {
        throw new JLCIsolationError(
          `[沙箱违规] isolation: "strict" 禁止将 <${String(node?.nodeName ?? "?").toLowerCase()}> 插入到应用子树之外（目标容器 <${String(parent.nodeName ?? "?").toLowerCase()}>）`,
        );
      }
    }
  }
  parent.insertBefore(node, before ?? null);
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

/* ---- style 声明的作用域化：让每个实例只影响自己的子树 ---- */
const CSS_SCOPABLE_BLOCKS = /^@(media|supports|container|layer)\b/iu;
const CSS_UNSCOPABLE_BLOCKS = /^@(keyframes|-webkit-keyframes|font-face|font-feature-values|counter-style|property|page)\b/iu;

const ROOT_SELECTOR = /^(?::root|html(?:\s*>\s*body)?|body)\b/iu;

function scopeSelectorFor(selector, scopeSelector) {
  if (ROOT_SELECTOR.test(selector)) {
    const rest = selector.replace(ROOT_SELECTOR, "").replace(/^\s*[> ]\s*/u, "").trim();
    return rest ? `${scopeSelector} ${rest}` : scopeSelector;
  }
  return `${scopeSelector} ${selector}, ${selector}:where(${scopeSelector})`;
}

function splitSelectors(prelude) {
  const parts = [];
  let depth = 0;
  let current = "";
  let quote = null;
  for (let index = 0; index < prelude.length; index += 1) {
    const char = prelude[index];
    if (quote) {
      current += char;
      if (char === "\\") { current += prelude[++index] ?? ""; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * 把一份 CSS 文本限定在 scopeSelector 之内：
 *   `:where(scope) S, S:where(scope)` —— 两条都不改变原选择器特异度。
 * `html` / `body` / `:root` 映射到作用域根本身。@media/@supports 递归处理，
 * @keyframes 一类无法作用域的块原样保留。
 */
export function scopeStylesheet(text, scopeSelector, depth = 0) {
  const source = String(text ?? "");
  if (depth > 4) return source;
  let output = "";
  let index = 0;
  let prelude = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? source.length : end + 2;
      prelude += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") cursor += 2;
        else if (source[cursor] === char) { cursor += 1; break; }
        else cursor += 1;
      }
      prelude += source.slice(index, cursor);
      index = cursor;
      continue;
    }
    if (char === "{") {
      let cursor = index + 1;
      let balance = 1;
      while (cursor < source.length && balance > 0) {
        const current = source[cursor];
        if (current === "/" && source[cursor + 1] === "*") {
          const end = source.indexOf("*/", cursor + 2);
          cursor = end < 0 ? source.length : end + 2;
          continue;
        }
        if (current === '"' || current === "'") {
          let inner = cursor + 1;
          while (inner < source.length) {
            if (source[inner] === "\\") inner += 2;
            else if (source[inner] === current) { inner += 1; break; }
            else inner += 1;
          }
          cursor = inner;
          continue;
        }
        if (current === "{") balance += 1;
        if (current === "}") balance -= 1;
        cursor += 1;
      }
      const body = source.slice(index + 1, Math.max(index + 1, cursor - 1));
      const trimmedPrelude = prelude.trim();
      prelude = "";
      if (CSS_SCOPABLE_BLOCKS.test(trimmedPrelude)) {
        output += `${trimmedPrelude}{${scopeStylesheet(body, scopeSelector, depth + 1)}}`;
      } else if (CSS_UNSCOPABLE_BLOCKS.test(trimmedPrelude) || trimmedPrelude === "") {
        output += `${trimmedPrelude}{${body}}`;
      } else {
        const scoped = splitSelectors(trimmedPrelude)
          .map((selector) => selector.trim())
          .filter(Boolean)
          .map((selector) => scopeSelectorFor(selector, scopeSelector))
          .join(",\n");
        output += `${scoped}{${body}}\n`;
      }
      index = cursor;
      continue;
    }
    if (char === "}") {
      // 深度错乱：交回上层处理，避免死循环。
      index += 1;
      continue;
    }
    prelude += char;
    index += 1;
  }
  return output;
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
    if (this.runtime) {
      if (func.maxStack > this.runtime.peakStack) this.runtime.peakStack = func.maxStack;
      if (this.frames.length > this.runtime.peakFrames) this.runtime.peakFrames = this.frames.length;
    }
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
    if (guardSurface(runtime, "host", "timer", `策略 ${runtime.policy.profile} 未授予定时器（allowTimer）`) === "skip") return;
    const scope = this.context?.scope;
    if (!scope || scope.disposed) throw new JLCRuntimeError("定时器没有可用的生命周期作用域");
    const minimum = runtime.policy?.frameMinIntervalMs ?? 0;
    if (mode === 1 && minimum > 0 && delay < minimum) {
      delay = minimum;
      notePolicy(runtime, { action: "clamp", kind: "host", detail: "every", message: `every 周期被抬到策略下限 ${minimum}ms` });
    }
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
    const maxTotalSteps = context.runtime.options.maxTotalSteps ?? 0;
    const metrics = context.runtime.metrics;
    const steps = context;
    entryFrame.ip = 0;

    outer: while (true) {
      const frame = frames[frames.length - 1];
      const code = frame.func.code;
      let ip = frame.ip;

      try {
        while (true) {
          const opcode = code[ip];
          if (NO_STEP[opcode] === 0) {
            metrics.cycles += 1;
            if (++steps.steps > maxSteps) throw new JLCRuntimeError("单次动作运算步数超限");
            if (maxTotalSteps > 0 && metrics.cycles > maxTotalSteps) {
              throw new JLCQuotaError(`实例累计执行 ${metrics.cycles} 步，超过预算 maxTotalSteps=${maxTotalSteps}`);
            }
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
            case OP.JUMP_IF_NONNULL: {
              // `a ?? b`：弹出栈顶副本，非 null 直接跳到右值之后（栈上保留 a）。
              const target = (code[ip] << 8) | code[ip + 1];
              ip += 2;
              if (stack.pop() != null) ip = target;
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
    const childScope = cursor.scope.child(`<${tag}>`);
    const created = createElement(machine.runtime.document, tag, cursor.namespace, machine.runtime, childScope);
    if (created.denied) {
      created.element.appendChild(machine.runtime.document.createTextNode(`接口 <${tag}> 被策略 ${machine.runtime.policy.profile} 拒绝`));
    }
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
    insertInto(machine.runtime, entry.outerParent, entry.element, entry.outerBefore);
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
    insertInto(runtime, cursor.parent, text, cursor.before);
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
    setNormalAttribute(cursor.parent, name, value, machine.runtime, cursor.scope);
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
    machine.runtime.effect(scope, () => setNormalAttribute(element, name, machine.runFunction(funcIndex, frame, scope), machine.runtime, scope), 1);
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
    const runtime = machine.runtime;
    const normalized = property.toLowerCase();
    if (HARD_BLOCKED_PROPERTIES.has(normalized)) {
      throw new JLCRuntimeError(`禁止设置 DOM property“${property}”：HTML 解析类 property 永远不属于 JLC，请改用沙箱 frame`);
    }
    const propertyDenied = guardSurface(runtime, "property", normalized) === "skip";
    runtime.effect(scope, () => {
      if (propertyDenied) return;
      let value = machine.runFunction(funcIndex, frame, scope);
      if (URL_ATTRIBUTES.has(normalized)) value = sanitizeUrl(value, runtime.policy);
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
    // 修饰符位 64 = frame：监听挂到 window（窗口事件），生命周期仍归本元素 Scope 管。
    const useWindow = Boolean(modifiers & 64) && machine.runtime.policy.allowWindowEvents;
    if (Boolean(modifiers & 64) && !machine.runtime.policy.allowWindowEvents) {
      guardSurface(machine.runtime, "window", "event", `策略 ${machine.runtime.policy.profile} 未授予窗口事件委托（on:window:*）`);
    }
    const listenTarget = useWindow ? (machine.runtime.window ?? element) : element;
    machine.runtime.listen(scope, listenTarget, type, (event) => {
      if (!useWindow && (modifiers & 4) && event.target !== element) return;
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
    insertInto(runtime, parent, start, before);
    insertInto(runtime, parent, end, before);
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
    insertInto(runtime, parent, start, before);
    insertInto(runtime, parent, end, before);
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
          insertInto(runtime, parent, recordStart, end);
          insertInto(runtime, parent, recordEnd, end);
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
        insertInto(runtime, parent, emptyStart, end);
        insertInto(runtime, parent, emptyEnd, end);
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
  unary("parseJson", (value) => {
    try {
      return sanitizeValue(JSON.parse(String(value ?? "")));
    } catch (error) {
      throw new JLCRuntimeError(`parseJson 解析失败：${error instanceof Error ? error.message : String(error)}`, error);
    }
  });
  add("min", (values) => Math.min(...values.map((value) => requireNumber(value))));
  add("max", (values) => Math.max(...values.map((value) => requireNumber(value))));
  unary("round", (value) => Math.round(requireNumber(value)));
  unary("floor", (value) => Math.floor(requireNumber(value)));
  unary("ceil", (value) => Math.ceil(requireNumber(value)));
  unary("abs", (value) => Math.abs(requireNumber(value)));
  add("clamp", ([value, minimum, maximum]) => Math.min(requireNumber(maximum), Math.max(requireNumber(minimum), requireNumber(value))));
  add("now", () => Date.now());

  add("http", ([url, options = Object.create(null)]) => {
    if (guardSurface(runtime, "host", "http", `策略 ${runtime.policy.profile} 未授予出网请求（host:http）`) === "skip") {
      return null;
    }
    const request = Object.create(null);
    request[REQUEST] = true;
    request.url = String(url ?? "");
    request.options = sanitizeValue(options);
    return Object.freeze(request);
  });
  add("reload", ([snapshot]) => {
    const resource = ownData(snapshot) ? RESOURCE_META.get(snapshot) : null;
    if (!resource) throw new JLCRuntimeError("reload 参数必须是 resource 状态（或本实例未授予 host:http）");
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
    if (guardSurface(runtime, "host", "emit", `策略 ${runtime.policy.profile} 未授予自定义事件（host:event）`) === "skip") return false;
    if (!runtime.target?.dispatchEvent) return false;
    const EventClass = runtime.window?.CustomEvent ?? globalThis.CustomEvent;
    if (!EventClass) return false;
    return runtime.target.dispatchEvent(new EventClass(String(name), { bubbles: true, cancelable: true, detail: sanitizeValue(detail) }));
  });
  add("title", ([value]) => {
    if (guardSurface(runtime, "host", "title", `策略 ${runtime.policy.profile} 未授予改标题（host:title）`) === "skip") return null;
    const titleText = String(value ?? "");
    if (runtime.document) runtime.document.title = titleText;
    return null;
  });
  // 【0.4 全权接管】动态设置 Favicon：SVG 源码转 data: URL，其余走策略 URL 净化。
  add("favicon", ([svgOrUrl]) => {
    if (guardSurface(runtime, "host", "favicon", `策略 ${runtime.policy.profile} 未授予改图标（host:favicon）`) === "skip") return null;
    if (!runtime.document) return null;
    let link = runtime.document.querySelector?.("link[rel~='icon']") ?? null;
    if (!link) {
      // 兜底：宿主 querySelector 不支持 ~= 属性选择器时，逐个比对 rel 词表
      for (const candidate of runtime.document.querySelectorAll?.("link") ?? []) {
        if (String(candidate.getAttribute?.("rel") ?? "").split(/\s+/u).includes("icon")) {
          link = candidate;
          break;
        }
      }
    }
    if (!link) {
      link = runtime.document.createElement("link");
      link.rel = "icon";
      link.setAttribute?.("rel", "icon"); // 兜住不做属性反射的极简 DOM shim
      (runtime.document.head ?? runtime.target).appendChild(link);
    }
    const raw = String(svgOrUrl ?? "");
    link.href = raw.startsWith("<svg")
      ? "data:image/svg+xml," + encodeURIComponent(raw)
      : sanitizeUrl(raw, runtime.policy);
    return null;
  });

  return builtins;
}

class Runtime {
  constructor(kernel, target, options, contextOptions = {}) {
    this.kernel = kernel;
    this.target = target;
    this.document = target.ownerDocument ?? globalThis.document;
    this.window = this.document?.defaultView ?? globalThis.window;
    this.options = {
      maxSteps: options.maxSteps ?? kernel.options.maxSteps,
      maxLoop: options.maxLoop ?? kernel.options.maxLoop,
      autoDispose: options.autoDispose ?? kernel.options.autoDispose,
      maxTotalSteps: options.maxTotalSteps ?? kernel.options.maxTotalSteps ?? 0,
    };
    // ---- 策略 / 隔离 / 配额（0.3 的“管理面”） ----
    this.policy = resolvePolicy(options.policy ?? contextOptions.policy ?? kernel.options.policy ?? "strict");
    this.isolation = options.isolation ?? kernel.options.isolation ?? "soft";
    this.realmElement = this.target ?? null;
    this.scopeId = options.id ?? null;
    this.peakStack = 0;
    this.peakFrames = 0;
    this.deniedSet = null;
    this.deniedReasons = null;
    this.neutralized = 0;
    this.faultMode = options.fault ?? kernel.options.fault ?? "report";
    this.onError = options.onError ?? kernel.options.onError;
    this.onFault = options.onFault ?? kernel.options.onFault;
    this.fetch = options.fetch ?? kernel.options.fetch ?? this.window?.fetch?.bind(this.window) ?? globalThis.fetch?.bind(globalThis);
    this.initialState = options.state && typeof options.state === "object" ? options.state : Object.create(null);
    this.capabilities = options.capabilities ?? Object.create(null);
    this.ownedNodes = new Map();
    this.metrics = {
      scopes: 0, effects: 0, listeners: 0, timers: 0, requests: 0,
      nodes: 0, cycles: 0, faults: 0, denials: 0, styles: 0,
    };
    this.options.maxTotalSteps = this.options.maxTotalSteps ?? 0;
    this.denied = [];
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
    // 【0.4 全权接管】宿主窗口滚动状态封装为内核只读 Signal（$scroll）。
    this.scrollSignal = new Signal(this, Object.freeze({ x: 0, y: 0 }), false, "$scroll");
    if (this.window?.addEventListener) {
      this.listen(this.rootScope, this.window, "scroll", () => {
        if (this.destroyed) return;
        this.scrollSignal.set(Object.freeze({
          x: this.window?.scrollX || 0,
          y: this.window?.scrollY || 0,
        }), true);
      }, { passive: true });
    }
  }

  context(scope = this.rootScope) {
    return { runtime: this, scope, steps: 0, depth: 0 };
  }

  /** 卸载/快照用的统一账本：把只读计数并进 inspect 结果。 */
  ledger() {
    return Object.freeze({ ...this.metrics, peakStack: this.peakStack, peakFrames: this.peakFrames, neutralized: this.neutralized });
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
    if (normalized.isPolicyError && this.faultMode !== "report") {
      this.metrics.faults += 1;
      if (this.faultMode === "stop") {
        this.unmountSelf?.();
        return;
      }
      if (this.onFault) {
        try {
          this.onFault(normalized, { code: normalized.code ?? "E_FAULT", mode: this.faultMode });
          return;
        } catch (faultError) {
          console.error("JLC onFault failed", faultError);
        }
      }
    }
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

  /** 策略说明 + 指纹：宿主 UI 直接可读，不必自己拼。 */
  describePolicy() {
    return Object.freeze({
      profile: this.policy.profile,
      label: this.policy.label,
      fingerprint: this.policy.fingerprint,
      abi: ABI_VERSION,
      frameSandbox: this.policy.frameSandbox,
      frameMinIntervalMs: this.policy.frameMinIntervalMs,
      urlSchemes: this.policy.urlSchemes,
      styleScoping: this.policy.styleScoping,
      isolation: this.isolation,
      faultMode: this.faultMode,
      scopeId: this.scopeId,
      quotas: Object.freeze({
        maxDomNodes: this.policy.maxDomNodes,
        maxStyleBytes: this.policy.maxStyleBytes,
        htmlMaxChars: this.policy.htmlMaxChars,
        maxTotalSteps: this.options?.maxTotalSteps ?? 0,
      }),
    });
  }

  /** 管理视图：接口清单 + 被拒记录 + 资源用量。多页面管理台直接吃这个对象。 */
  describeInstance(module) {
    const requirements = module?.requirements ?? [];
    return Object.freeze({
      app: module?.app ?? null,
      abi: ABI_VERSION,
      bytecodeVersion: module?.version ?? 0,
      policy: this.describePolicy(),
      granted: Object.freeze(requirements
        .filter((item) => !this.deniedSet?.has(item.key))
        .map((item) => Object.freeze({ kind: item.kind, detail: item.detail, key: item.key }))),
      denied: Object.freeze((this.denied ?? []).map((item) => Object.freeze({ ...item }))),
      usage: Object.freeze({ ...this.metrics }),
    });
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
    if (guardSurface(this, "host", "navigate", `策略 ${this.policy.profile} 未授予路由（host:navigate）`) === "skip") return;
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
    this.scrollSignal?.detach();
    this.globals?.clear();
    this.rootScope = null;
    this.globals = null;
    this.module = null;
    this.machine = null;
    this.links = null;
    this.routeSignal = null;
    this.scrollSignal = null;
    this.capabilities = null;
    this.initialState = null;
    this.onError = null;
    this.options = null;
    this.kernel = null;
    this.ownedNodes?.clear();
    this.ownedNodes = null;
    this.denied = null;
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
  // 暴露 actionIndex：字节码 CALL 走内联压帧快路径，而不是绕道宿主 invoke。
  return callable(action.name, (argumentsList, parentContext) => {
    if ((parentContext?.depth ?? 0) >= 100) throw new JLCRuntimeError("action 调用深度超过 100");
    return runtime.machine.enterAction(actionIndex, argumentsList, parentContext);
  }, { actionIndex });
}

function capabilityCallable(name, function_, runtime = null) {
  return callable(name, (argumentsList) => {
    if (runtime && guardSurface(runtime, "capability", name) === "skip") return null;
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
  table.define("$scroll", { kind: "signal", signal: runtime.scrollSignal });
  reserved.add("$scroll");

  for (const [name, function_] of Object.entries(runtime.capabilities ?? {})) {
    if (reserved.has(name)) throw new JLCRuntimeError(`capability“${name}”与内建名称冲突`);
    if (typeof function_ !== "function") throw new JLCRuntimeError(`capability“${name}”必须是函数`);
    reserved.add(name);
    table.define(name, { kind: "value", value: capabilityCallable(name, function_, runtime) });
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
    if (!descriptor?.[REQUEST]) {
      if (descriptor === null) {
        // host:http 被策略收回：resource 直接判为不可用，界面仍然工作
        signal.set(resourceSnapshot(resource, null, Object.freeze({ name: "PolicyDenied", message: "host:http 未授予，resource 不会发起请求" }), false, null), true);
        return;
      }
      throw new JLCRuntimeError(`resource“${declaration.name}”必须使用 http(...)`);
    }
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
  let index = 0;
  for (const declaration of module.declarations) {
    if (declaration.kind !== "style") continue;
    index += 1;
    const style = runtime.document.createElement("style");
    style.setAttribute("data-jlc-style", module.app);
    style.setAttribute("data-jlc-owner", runtime.scopeId ?? module.app);
    if (runtime.scopeId) style.setAttribute("id", `${runtime.scopeId}-style-${index}`);
    (runtime.document.head ?? runtime.target).appendChild(style);
    runtime.metrics.styles += 1;
    runtime.rootScope.own(() => {
      style.remove();
      if (runtime.metrics) runtime.metrics.styles -= 1;
    });
    const scoped = runtime.policy.styleScoping === "prefix"
      ? `[data-jlc-app="${runtime.scopeId}"]`
      : null;
    runtime.effect(runtime.rootScope, () => {
      const raw = String(machine.runFunction(declaration.func, null, runtime.rootScope) ?? "");
      const limit = runtime.policy.maxStyleBytes;
      if (limit > 0 && raw.length > limit) {
        throw new JLCQuotaError(`style 声明 ${raw.length} 字节超过配额 maxStyleBytes=${limit}`);
      }
      style.textContent = scoped ? scopeStylesheet(raw, scoped) : raw;
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
      // 被搬走 ≠ 被删除：节点仍在文档里时不销毁。
      // 但 strict 隔离档下「搬出应用子树」等同于放弃所有权。
      if (node.isConnected && (runtime.isolation !== "strict" || withinRealm(runtime, node))) return;
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
      maxTotalSteps: options.maxTotalSteps ?? 0,
      autoDispose: options.autoDispose ?? true,
      onError: options.onError ?? null,
      onFault: options.onFault ?? null,
      fetch: options.fetch ?? null,
      policy: options.policy ?? "strict",
      isolation: options.isolation ?? "soft",
      fault: options.fault ?? "stop",
    });
    this.version = VERSION;
    this.abi = ABI_VERSION;
    this.instances = new Set();
    this.serial = 0;
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

  /** 内核级策略预设：`kernel.policy("open")` 拿到解析并冻结后的策略对象。 */
  policy(nameOrOverride) {
    return resolvePolicy(nameOrOverride ?? this.options.policy);
  }

  /** 全部在册实例的管理视图（多页面管理台用）。 */
  list() {
    return [...this.instances].map((handle) => handle.describe());
  }

  /** 一次性卸掉内核里所有实例：等价 `init 0`。 */
  demountAll() {
    const count = this.instances.size;
    for (const handle of [...this.instances]) handle.unmount();
    return count;
  }

  /** 反汇编字节码模块、JLCProgram 或 .jbc 二进制（调试视图）。 */
  disassemble(source) {
    const module = resolveModule(source);
    return module ? disassembleModule(module) : "";
  }

  mount(sourceOrModule, targetOrSelector, options = {}) {
    const kernel = this;
    const module = resolveModule(sourceOrModule);
    if (!module) {
      throw new JLCRuntimeError("VM 内核只能挂载字节码模块、JLCProgram 或 .jbc 二进制；编译 JLC 源码请使用完整内核");
    }
    const appName = module.app;
    const documentObject = options.document ?? globalThis.document;
    const target = typeof targetOrSelector === "string" ? documentObject?.querySelector(targetOrSelector) : targetOrSelector;
    if (!target?.insertBefore) throw new JLCRuntimeError("mount 目标不存在或不是 DOM 元素");
    const runtime = new Runtime(this, target, options);
    runtime.scopeId = options.id ?? `jlc-${this.serial += 1}`;

    // 装载期裁决：静态接口清单 → 策略。stop 档在渲染任何节点之前整体失败。
    const requirements = module.requirements ?? [];
    const denials = checkPermissions(requirements, runtime.policy);
    runtime.deniedSet = new Set(denials.map((item) => item.key));
    runtime.deniedReasons = new Map(denials.map((item) => [item.key, item.reason]));
    runtime.metrics.denials = denials.length;
    if (runtime.faultMode !== "stop") {
      runtime.denied = denials.map((item) => ({ kind: item.kind, detail: item.detail, reason: item.reason, key: item.key }));
    }
    for (const denial of denials) notePolicy(runtime, { action: "deny", kind: denial.kind, detail: denial.detail, message: denial.reason });
    if (denials.length && runtime.faultMode === "stop") {
      throw new JLCPolicyError(
        `策略 ${runtime.policy.profile} 拒绝挂载 ${appName}：` +
        denials.map((item) => `${item.kind}:${item.detail}（${item.reason}）`).join("；"),
      );
    }
    if (runtime.policy.styleScoping === "prefix") target.setAttribute?.("data-jlc-app", runtime.scopeId);
    if (runtime.isolation === "strict") {
      runtime.realmElement = options.realmRoot ?? target.parentElement ?? target;
      target.setAttribute?.("data-jlc-realm", runtime.scopeId);
    }
    runtime.peakStack = module.functions.reduce((peak, func) => Math.max(peak, func.maxStack ?? 0), 0);
    let start = null;
    let end = null;
    let active = true;
    let rootScope = runtime.rootScope;
    let finalMetrics = null;
    let finalDescription = runtime.describeInstance(module);

    const handle = {
      get active() { return active; },
      get name() { return appName; },
      get(name) {
        if (!active) throw new JLCRuntimeError("应用已卸载");
        const binding = runtime.globals.resolve(name);
        const value = bindingValue(binding);
        if (value?.[CALLABLE]) {
          return Object.freeze({ kind: value.actionIndex == null ? "builtin" : "action", name: value.name });
        }
        return sanitizeValue(value);
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
        return Object.freeze({ ...(active ? runtime.ledger() : finalMetrics), active });
      },
      unmount() {
        if (!active) return;
        active = false;
        kernel.instances.delete(handle);
        runtime.destroy();
        if (start && end) removeInclusive(start, end);
        target.removeAttribute?.("data-jlc-app");
        target.removeAttribute?.("data-jlc-realm");
        finalMetrics = {
          scopes: 0, effects: 0, listeners: 0, timers: 0, requests: 0,
          nodes: 0, cycles: runtime.metrics.cycles, faults: runtime.metrics.faults,
          denials: runtime.metrics.denials, styles: 0,
          peakStack: runtime.peakStack, peakFrames: runtime.peakFrames, neutralized: runtime.neutralized,
        };
        start = null;
        end = null;
        rootScope = null;
      },
      /** 装载期声明的宿主接口（可授予 / 被拒），管理台直接渲染这张表。 */
      permissions() {
        return Object.freeze(module.requirements.map((item) => Object.freeze({
          kind: item.kind,
          detail: item.detail,
          granted: !runtime.deniedSet?.has(item.key),
          reason: runtime.deniedReasons?.get(item.key) ?? null,
        })));
      },
      /** 运行时快照：作用域、接口清单、策略与用量。 */
      describe() {
        return runtime.destroyed ? finalDescription : (finalDescription = runtime.describeInstance(module));
      },
      /** 隔离域内的根：多页面管理台据此判断「这个实例只能碰这块 DOM」。 */
      get scopeId() {
        return runtime.scopeId;
      },
      policy() {
        return runtime.describePolicy();
      },
    };

    try {
      if (options.replace !== false) target.replaceChildren?.();
      this.instances.add(handle);
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
      if (error instanceof JLCCompileError || error instanceof JLCRuntimeError || error instanceof JLCVerifyError || error.isPolicyError) throw error;
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
