/*
 * JLC Virtual Machine — 0.6.1 Full Runtime Takeover / Performance Kernel
 * A CSP-safe bytecode runtime for declarative web programs.
 * Copyright (c) 2026 JLC contributors. MIT licensed.
 *
 * This is the JLC-VM backend: it loads verified JLC bytecode modules
 * (.jbc), links them against a mount-time global table, and executes a
 * stack-based dispatch loop that drives Signals, Scopes, Effects and DOM.
 * It deliberately contains no Tokenizer or Parser: compiling JLC source
 * into bytecode is the job of jlc-compiler.js.
 *
 * 0.6.1 不升级 ABI（仍是 jlc-abi/3 / 字节码 v3）：0.4 / 0.5 / 0.6 的
 * .jbc 全部继续跑。本版把 0.6 已建立的全面接管能力做成大型项目可承载的
 * 高性能执行内核：
 *   Scheduler v2.1（老化 / 车道配额 / 饥饿营救）· VM Frame Budget ·
 *   DOM Transaction + Mutation Coalescing · EACH Diff Engine 2 + Keyed
 *   Node Cache · Reactive Batch 2.0 + Dependency Graph · Profile 2.0 ·
 *   Hot Path Cache · Resource Kernel 2.0（soft/hard）· Memory Accountant ·
 *   Delta Checkpoint · Fault Auto-Escalation · Leak Detector ·
 *   Network Scheduler · Cancellation Kernel。
 * 新增子系统拆分在 ./kernel/（单向依赖，对外表面不变）。
 */

export const VERSION = "0.6.1";
export const BYTECODE_VERSION = 3;
// 1 = 无需求清单的旧模块；2 = 0.4 模块；3 = 0.6 模块（新增能力图 / 资源清单 / 标志段）。
// 旧模块仍可装载，走兼容路径（运行期逐条把关 + 缺省资源清单）。
export const ACCEPTED_BYTECODE_VERSIONS = [1, 2, 3];
export const ABI_VERSION = "jlc-abi/3";
// ABI v3 的最低兼容内核：0.4 内核（jlc-abi/2）只能读 v1/v2，读 v3 会显式报错而不是误解码。
export const ABI_MIN_KERNEL = "0.6.0";
export const MAGIC = 0x4a4c4342; // "JLCB" — JLC Bytecode container

/* ---- 0.6.1 Performance Kernel 子系统（./kernel/，不反向依赖本文件） ---- */
import {
  FrameBudgetManager,
  DEFAULT_LANE_BUDGETS,
  LaneGovernor,
  DEFAULT_LANE_QUOTAS,
  DomTransaction,
  KeyedNodeCache,
  MemoryAccountant,
  estimateBytes,
  LeakDetector,
  LEAK_KINDS,
  CancellationRegistry,
  HotPathCache,
  describeDependencyGraph,
  dependentsOf,
  diffSignals,
  materializeSignals,
  promoteDependents,
  estimateEntryBytes,
} from "./kernel/index.js";

// 0.6.1 子系统对外出口：宿主可以直接 import { DomTransaction } from "./jlc-vm.js"。
export {
  FrameBudgetManager,
  DEFAULT_LANE_BUDGETS,
  LaneGovernor,
  DEFAULT_LANE_QUOTAS,
  DomTransaction,
  KeyedNodeCache,
  MemoryAccountant,
  estimateBytes,
  LeakDetector,
  LEAK_KINDS,
  CancellationRegistry,
  HotPathCache,
  describeDependencyGraph,
  dependentsOf,
  diffSignals,
  materializeSignals,
  promoteDependents,
  estimateEntryBytes,
};

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
  "indexOf", "copy", "scrollTo", "storage",
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
  // ---- 0.6 ----
  "capabilities", "resources", "permissionStrict",
]);

/** 能力授权表：接受树形（{ network: { http: true } }）或扁平（{ "network.http": true }）。 */
export function normalizeCapabilityGrants(input, prefix = "", out = {}) {
  if (input == null) return out;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new JLCRuntimeError(`capabilities 必须是对象，收到 ${Array.isArray(input) ? "数组" : typeof input}`);
  }
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !("grant" in value) && !("mode" in value) && !("expires" in value)) {
      normalizeCapabilityGrants(value, path, out);
      continue;
    }
    if (!isCapabilityPath(path)) {
      throw new JLCRuntimeError(`未知能力路径“${path}”：请查阅 CAPABILITY_PATHS（能力图是内核唯一权威）`);
    }
    out[path] = value;
  }
  return out;
}

/**
 * 资源限额表：只认 RESOURCE_KINDS，打错字段名直接拒绝（配额静默失效最危险）。
 * 0.6.1：每种资源既接受数字（= 硬限额，兼容 0.6），也接受
 * `{ soft, hard }`——soft 触发警告（burst 容忍区），hard 才抛 JLCQuotaError。
 */
export function normalizeResourceLimits(input) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new JLCRuntimeError("resources 必须是对象");
  const out = {};
  for (const [kind, value] of Object.entries(input)) {
    if (!RESOURCE_KINDS.includes(kind)) throw new JLCRuntimeError(`未知资源种类“${kind}”：可用 ${RESOURCE_KINDS.join(", ")}`);
    if (value !== null && typeof value === "object") {
      const hard = Math.max(0, Math.floor(Number(value.hard ?? value.limit ?? 0) || 0));
      const soft = Math.max(0, Math.floor(Number(value.soft ?? 0) || 0));
      if (soft > hard && hard > 0) throw new JLCRuntimeError(`资源 ${kind} 的 soft 限额不能高于 hard 限额`);
      out[kind] = { hard, soft };
      continue;
    }
    out[kind] = Math.max(0, Math.floor(Number(value) || 0));
  }
  return out;
}

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
    capabilities: merged.capabilities == null ? null : Object.freeze(normalizeCapabilityGrants(merged.capabilities)),
    resources: merged.resources == null ? null : Object.freeze(normalizeResourceLimits(merged.resources)),
    permissionStrict: Boolean(merged.permissionStrict),
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
  let violation = runtime.deniedSet?.has(key)
    ? runtime.deniedReasons?.get(key) ?? "策略拒绝"
    : policyViolation(runtime.policy, kind, detail);
  // 0.6：capability 走权限内核——它带状态（granted / session / once / suspended /
  // revoked / expired）与租约，运行中撤销立刻生效，不需要 unmount → mount。
  let fromPermission = false;
  if (!violation && kind === "capability" && runtime.permissions) {
    const decision = runtime.permissions.check(detail);
    if (!decision.ok) {
      violation = decision.reason ?? `能力 ${decision.path} 处于 ${decision.state}`;
      fromPermission = true;
    }
  }
  if (!violation) return "allow";
  // 权限内核的裁决不受 fault 档影响：撤销/暂停/租约到期必须立刻生效，
  // 否则「运行中撤销授权」就只是一句空话。
  if (fromPermission) {
    runtime.metrics.faults += 1;
    if (!runtime.denied.some((item) => item.key === key)) {
      runtime.denied.push({ kind, detail, reason: violation, message: message ?? null, key });
    }
    notePolicy(runtime, { action: "revoke", kind, detail, message: violation });
    return "skip";
  }
  if (isHardViolation(kind, detail)) {
    runtime.metrics.faults += 1;
    throw new JLCPolicyError(message ?? `${key} 属于内核硬限制，任何策略档与 fault 档都不放行：${violation}`);
  }
  const level = normalizeFaultLevel(runtime.faultMode, "recover");
  if (level === "ignore" || level === "recover") {
    notePolicy(runtime, { action: level === "ignore" ? "ignore" : "report", kind, detail, message: violation });
    return "allow";
  }
  if (level !== "stop") {
    runtime.metrics.faults += 1;
    if (!runtime.denied.some((item) => item.key === key)) {
      runtime.denied.push({ kind, detail, reason: violation, message: message ?? null, key });
    }
    notePolicy(runtime, { action: level, kind, detail, message: violation });
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
 * 0.6 内核子系统之一：故障阶梯（Fault Ladder）
 *
 * 0.3/0.4 只有 report / degrade / stop 三档，粒度太粗：一个组件崩了要么
 * 整页报错，要么静默降级。0.6 把它做成六级阶梯，由「故障发生在哪一层」
 * 决定用哪一级——内核级不变量违规永远 stop，组件级异常优先 restart，
 * 状态不一致才 rollback。
 * ================================================================ */

export const FAULT_LEVELS = Object.freeze(["ignore", "degrade", "recover", "restart", "rollback", "stop"]);

/** 0.6.1 自动升级链：本级动作失败 → 下一级接手（不新增第七级）。 */
export const FAULT_ESCALATION = Object.freeze({ restart: "rollback", rollback: "degrade" });

/** 旧档名 → 0.6 档名（兼容 0.3/0.4 的 report/warn/throw 写法）。 */
export const FAULT_ALIASES = Object.freeze({
  report: "recover",
  warn: "recover",
  audit: "recover",
  allow: "ignore",
  skip: "degrade",
  throw: "stop",
  fail: "stop",
  abort: "stop",
  unmount: "stop",
});

/** 每一级故障的语义：给宿主 UI、诊断器和文档共用的一张表。 */
export const FAULT_POLICY = Object.freeze({
  ignore: Object.freeze({ level: 0, label: "忽略", note: "不拦截、不记账：只用于受信调试", escalates: false }),
  degrade: Object.freeze({ level: 1, label: "降级", note: "跳过这一步，实例继续运行（可授予能力被收回）", escalates: false }),
  recover: Object.freeze({ level: 2, label: "恢复", note: "放行 + 记账 + 上报宿主，由宿主决定后续", escalates: false }),
  restart: Object.freeze({ level: 3, label: "重启组件", note: "销毁出错组件的作用域并重建（不牵连同批其它组件）", escalates: false }),
  rollback: Object.freeze({ level: 4, label: "回滚", note: "回到最近的运行时检查点，恢复 state / 组件树", escalates: true }),
  stop: Object.freeze({ level: 5, label: "停机", note: "卸载实例：内核不变量已不可信", escalates: true }),
});

export function normalizeFaultLevel(value, fallback = "recover") {
  if (value == null) return fallback;
  const text = String(value).toLowerCase();
  const resolved = FAULT_ALIASES[text] ?? text;
  return FAULT_LEVELS.includes(resolved) ? resolved : fallback;
}

/** 故障级别是否至少达到某一档（阶梯比较，宿主策略用）。 */
export function faultAtLeast(level, threshold) {
  return FAULT_POLICY[normalizeFaultLevel(level, "stop")].level >= FAULT_POLICY[normalizeFaultLevel(threshold, "stop")].level;
}

/* ================================================================
 * 0.6 内核子系统之二：优先级通道（Priority Lanes）
 *
 * 0.4 的调度器只有一个队列，用 priority 数字排序；0.6 把它显式化为
 * 8 条通道：用户输入永远抢在后台计算前面。数字越大优先级越低，
 * 与 0.4 的既有写法（0 最高）完全同序，旧代码不需要改。
 * ================================================================ */

export const PRIORITY = Object.freeze({
  SYSTEM: 0,
  INPUT: 1,
  INTERACTION: 2,
  RENDER: 3,
  EFFECT: 4,
  NETWORK: 5,
  BACKGROUND: 6,
  IDLE: 7,
});

export const PRIORITY_NAMES = Object.freeze(["system", "input", "interaction", "render", "effect", "network", "background", "idle"]);

const PRIORITY_BY_NAME = Object.freeze(Object.fromEntries(PRIORITY_NAMES.map((name, index) => [name, index])));

/** 接受数字、别名名字（"render"）或 F 通道对象；越界夹到 [0, 7]。 */
export function normalizePriority(value, fallback = PRIORITY.EFFECT) {
  if (value == null) return fallback;
  if (typeof value === "object" && value.name) return normalizePriority(value.priority ?? value.name, fallback);
  if (typeof value === "string") {
    const named = PRIORITY_BY_NAME[value.toLowerCase().replace(/^p/, "")];
    if (named != null) return named;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(PRIORITY.IDLE, Math.max(PRIORITY.SYSTEM, Math.trunc(numeric)));
}

/** 任务种类 → 默认通道：内核替应用决定「什么该先跑」。 */
export const TASK_PRIORITY = Object.freeze({
  system: PRIORITY.SYSTEM,
  input: PRIORITY.INPUT,
  interaction: PRIORITY.INTERACTION,
  render: PRIORITY.RENDER,
  view: PRIORITY.RENDER,
  effect: PRIORITY.EFFECT,
  derive: PRIORITY.RENDER,
  resource: PRIORITY.NETWORK,
  network: PRIORITY.NETWORK,
  timer: PRIORITY.BACKGROUND,
  background: PRIORITY.BACKGROUND,
  idle: PRIORITY.IDLE,
});

/* ================================================================
 * 0.6 内核子系统之三：能力图（Capability Graph）
 *
 * 0.4 的授权单位是「一条接口需求」（tag:iframe、host:http……）。
 * 0.6 把宿主能力显式建模成一棵树：每个叶子是一条可独立授予 / 撤销 /
 * 租约的能力路径。授权、权限中心、诊断面板、IPC 都读同一棵树。
 * ================================================================ */

const node = (label, children = null) => Object.freeze({ label, children: children ? Object.freeze(children) : null });

export const CAPABILITY_TREE = Object.freeze({
  dom: node("DOM 树", {
    read: node("读取节点与事件"),
    create: node("创建节点"),
    update: node("修改属性 / 文本 / 样式"),
    remove: node("移除节点"),
  }),
  network: node("网络", {
    http: node("HTTP / fetch"),
    websocket: node("WebSocket"),
    stream: node("流式响应 / SSE"),
  }),
  storage: node("存储", {
    memory: node("内存快照"),
    session: node("会话存储"),
    indexeddb: node("IndexedDB"),
    cache: node("缓存 / SW cache"),
    transaction: node("事务与回滚"),
    migration: node("结构迁移"),
  }),
  filesystem: node("文件系统", {
    read: node("读文件", { picker: node("文件选择器"), stream: node("读取流") }),
    write: node("写文件", { picker: node("保存对话框"), stream: node("写入流") }),
    directory: node("目录", { read: node("列目录"), write: node("写目录") }),
    download: node("导出下载"),
  }),
  browser: node("浏览器", {
    navigation: node("历史 / 路由"),
    title: node("标题与图标"),
    clipboard: node("剪贴板", { read: node("读剪贴板"), write: node("写剪贴板") }),
    fullscreen: node("全屏"),
    notification: node("系统通知"),
    share: node("系统分享"),
    theme: node("主题"),
    pwa: node("PWA 安装"),
    serviceWorker: node("Service Worker"),
    window: node("窗口级事件"),
  }),
  device: node("设备", {
    camera: node("摄像头"),
    microphone: node("麦克风"),
    geolocation: node("定位"),
    sensors: node("传感器"),
    vibrate: node("振动"),
    platform: node("平台信息"),
  }),
  compute: node("计算", {
    worker: node("Worker VM"),
    ipc: node("应用间 IPC"),
    timers: node("定时器"),
    frame: node("动画帧"),
    crypto: node("加密原语"),
    compression: node("压缩 / 解压"),
  }),
  process: node("进程管理", {
    appManager: node("应用管理"),
    permissionManager: node("权限管理"),
    inspector: node("检查器 / 诊断"),
    debugger: node("调试器"),
  }),
});

function flattenCapabilityTree(tree, prefix = "", out = []) {
  for (const [key, child] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(path);
    if (child.children) flattenCapabilityTree(child.children, path, out);
  }
  return out;
}

/** 全部合法能力路径（含中间节点），冻结后可直接给 UI 渲染权限面板。 */
export const CAPABILITY_PATHS = Object.freeze(flattenCapabilityTree(CAPABILITY_TREE));

const CAPABILITY_PATH_SET = new Set(CAPABILITY_PATHS);

/** 路径合法性：内核只认自己树里的路径，宿主不能凭空发明权限。 */
export function isCapabilityPath(path) {
  return CAPABILITY_PATH_SET.has(String(path));
}

/** 路径的祖先链：filesystem.read.picker → [filesystem, filesystem.read, filesystem.read.picker]。 */
export function capabilityAncestors(path) {
  const parts = String(path).split(".");
  const out = [];
  for (let index = 0; index < parts.length; index += 1) out.push(parts.slice(0, index + 1).join("."));
  return out;
}

/**
 * 旧宿主函数名 → 能力路径。0.5 的 Capability Hub 暴露的是 storagePut /
 * clipboardWrite 这类裸名字；0.6 内核认识它们，从而让旧宿主零改动接入能力图。
 * 宿主可用 mount({ capabilityPaths }) 覆盖或补充。
 */
export const CAPABILITY_ALIASES = Object.freeze({
  storagePut: "storage.indexeddb",
  storageGet: "storage.indexeddb",
  storageClear: "storage.indexeddb",
  storageKeys: "storage.indexeddb",
  indexeddb: "storage.indexeddb",
  clipboardWrite: "browser.clipboard.write",
  clipboardRead: "browser.clipboard.read",
  fileOpen: "filesystem.read.picker",
  fileSave: "filesystem.write.picker",
  fileRead: "filesystem.read",
  fileWrite: "filesystem.write",
  download: "filesystem.download",
  downloadJson: "filesystem.download",
  share: "browser.share",
  shareSupported: "browser.share",
  notify: "browser.notification",
  notifyStatus: "browser.notification",
  fullscreen: "browser.fullscreen",
  fullscreenActive: "browser.fullscreen",
  theme: "browser.theme",
  themeCurrent: "browser.theme",
  pwaInstall: "browser.pwa",
  pwaStatus: "browser.pwa",
  platform: "device.platform",
  isMobile: "device.platform",
  navigate: "browser.navigation",
  route: "browser.navigation",
  camera: "device.camera",
  microphone: "device.microphone",
  geolocation: "device.geolocation",
  worker: "compute.worker",
  spawnWorker: "compute.worker",
  ipc: "compute.ipc",
  debug: "process.inspector",
  inspect: "process.inspector",
});

/* ================================================================
 * 0.6 内核子系统之四：权限内核（Permission Kernel）
 *
 * 授权不再是一个 allow/deny 布尔的白名单，而是一组带状态与生命周期的
 * 记录：requested / granted / denied / session / once / persistent /
 * suspended / revoked / expired。运行中的实例被撤销授权后，后续每一次
 * 调用立刻失败——不需要 unmount → mount。
 * ================================================================ */

export const PERMISSION_STATES = Object.freeze([
  "requested", "granted", "denied", "session", "once", "persistent", "suspended", "revoked", "expired",
]);

const GRANT_MODES = new Set(["session", "once", "persistent"]);
const LIVE_STATES = new Set(["granted", "session", "once", "persistent"]);

export class PermissionKernel {
  /**
   * @param {object} options
   * @param {object} [options.grants]  路径或别名 → true/false/"session"/"once"/{grant, mode, expires}
   * @param {object} [options.aliases] 裸能力名 → 能力路径（默认 CAPABILITY_ALIASES）
   * @param {number} [options.now]     测试可注入的时钟
   */
  constructor(options = {}) {
    this.aliases = new Map(Object.entries({ ...CAPABILITY_ALIASES, ...(options.aliases ?? {}) }));
    this.records = new Map();
    this.strict = Boolean(options.strict);
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.audit = typeof options.audit === "function" ? options.audit : null;
    this.serial = 0;
    for (const [path, value] of Object.entries(options.grants ?? {})) this.define(path, value);
  }

  /** 行外名 → 路径：已注册别名、合法路径、或宿主临时登记的名字。 */
  pathOf(name) {
    const text = String(name ?? "");
    if (!text) return null;
    if (CAPABILITY_PATH_SET.has(text)) return text;
    const alias = this.aliases.get(text);
    if (alias) return alias;
    const trimmed = text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
    if (CAPABILITY_PATH_SET.has(trimmed)) return trimmed;
    return null;
  }

  /** 登记「裸函数名 → 能力路径」的映射（宿主自定义能力用）。 */
  register(name, path) {
    if (!isCapabilityPath(path)) throw new JLCRuntimeError(`未知能力路径“${path}”`);
    this.aliases.set(String(name), path);
    return this;
  }

  /** 声明/更新一条授权记录。value 可以是布尔、模式字符串或对象。 */
  define(pathOrName, value = true) {
    const path = this.pathOf(pathOrName) ?? String(pathOrName);
    const entry = this.records.get(path) ?? {
      path,
      state: "requested",
      mode: "session",
      expires: 0,
      used: 0,
      calls: 0,
      denials: 0,
      reason: null,
      since: this.now(),
      serial: (this.serial += 1),
    };
    if (value === false) {
      entry.state = "denied";
      entry.reason = "宿主显式拒绝";
    } else if (value === true) {
      entry.state = "session";
      entry.mode = "session";
      entry.expires = 0;
      entry.reason = null;
    } else if (typeof value === "string") {
      if (!GRANT_MODES.has(value)) throw new JLCRuntimeError(`未知授权模式“${value}”`);
      entry.state = value;
      entry.mode = value;
    } else if (value && typeof value === "object") {
      const mode = value.mode ?? (value.grant === false ? "denied" : "session");
      if (value.grant === false) {
        entry.state = "denied";
        entry.reason = value.reason ?? "宿主显式拒绝";
      } else {
        if (!GRANT_MODES.has(mode)) throw new JLCRuntimeError(`未知授权模式“${mode}”`);
        entry.state = mode;
        entry.mode = mode;
      }
      if (value.reason != null) entry.reason = String(value.reason);
      entry.expires = Number(value.expires ?? 0) || 0;
      entry.persistent = Boolean(value.persistent);
    }
    entry.since = this.now();
    this.records.set(path, entry);
    this.note("define", entry);
    return entry;
  }

  request(pathOrName, options = {}) {
    const entry = this.define(pathOrName, { grant: options.grant ?? false, mode: options.mode, expires: options.expires, reason: options.reason });
    if (options.grant) return entry;
    entry.state = "requested";
    this.note("request", entry);
    return entry;
  }

  grant(pathOrName, options = {}) {
    return this.define(pathOrName, { grant: true, mode: options.mode ?? "session", expires: options.expires, persistent: options.persistent });
  }

  deny(pathOrName, reason = null) {
    const entry = this.define(pathOrName, { grant: false, reason });
    entry.state = "denied";
    return entry;
  }

  /** 撤销：运行期立即生效，所有未来调用失败（已在飞行中的请求不受影响）。 */
  revoke(pathOrName, reason = "宿主撤销授权") {
    const path = this.pathOf(pathOrName) ?? String(pathOrName);
    const entry = this.records.get(path);
    if (!entry) return this.define(path, { grant: false, reason });
    entry.state = "revoked";
    entry.reason = reason;
    entry.expires = 0;
    this.note("revoke", entry);
    return entry;
  }

  suspend(pathOrName, reason = "宿主暂停授权") {
    const path = this.pathOf(pathOrName) ?? String(pathOrName);
    const entry = this.records.get(path);
    if (!entry) return this.define(path, { grant: false, reason });
    entry.state = "suspended";
    entry.reason = reason;
    this.note("suspend", entry);
    return entry;
  }

  restore(pathOrName, options = {}) {
    return this.grant(pathOrName, options);
  }

  /** 租约：到期自动失效（不需要定时器，判定是惰性的）。 */
  lease(pathOrName, ttlMs, options = {}) {
    return this.grant(pathOrName, { mode: options.mode ?? "session", expires: this.now() + Math.max(0, Number(ttlMs) || 0) });
  }

  /** 单点裁决：返回决策对象，永远不抛异常（抛不抛由调用方决定）。 */
  check(pathOrName) {
    const path = this.pathOf(pathOrName);
    if (!path) return Object.freeze({ ok: true, mapped: false, path: null, state: "unmapped", mode: null, reason: null });
    let entry = this.records.get(path);
    if (!entry) {
      // 中间节点授权：filesystem.read 授予 = 其下 picker / stream 全部可读。
      const chain = capabilityAncestors(path);
      for (let index = chain.length - 2; index >= 0; index -= 1) {
        const ancestor = this.records.get(chain[index]);
        if (ancestor && LIVE_STATES.has(ancestor.state)) {
          entry = ancestor;
          break;
        }
      }
    }
    if (!entry) {
      if (this.strict) {
        return Object.freeze({ ok: false, mapped: true, path, state: "requested", mode: null, reason: `能力 ${path} 未被授予（strict 权限模式）` });
      }
      return Object.freeze({ ok: true, mapped: true, path, state: "unmapped", mode: null, reason: null });
    }
    if (entry.expires > 0 && this.now() >= entry.expires) {
      entry.state = "expired";
      entry.reason = "授权租约到期";
      this.note("expire", entry, true);
    }
    if (!LIVE_STATES.has(entry.state)) {
      entry.denials += 1;
      this.note("deny", entry, true);
      return Object.freeze({ ok: false, mapped: true, path, state: entry.state, mode: entry.mode, reason: entry.reason ?? `能力 ${path} 处于 ${entry.state}` });
    }
    entry.calls += 1;
    if (entry.state === "once") {
      entry.used += 1;
      entry.state = "expired";
      entry.reason = "一次性授权已使用";
    }
    return Object.freeze({ ok: true, mapped: true, path, state: entry.state, mode: entry.mode, reason: null });
  }

  /** 管理视图：权限中心 / 权限面板直接渲染这张表。 */
  list() {
    return Object.freeze([...this.records.values()]
      .sort((left, right) => left.serial - right.serial)
      .map((entry) => Object.freeze({
        path: entry.path,
        state: entry.state,
        granted: LIVE_STATES.has(entry.state) && !(entry.expires > 0 && this.now() >= entry.expires),
        mode: entry.mode,
        expires: entry.expires,
        calls: entry.calls,
        denials: entry.denials,
        reason: entry.reason,
      })));
  }

  grantedPaths() {
    return this.list().filter((entry) => entry.granted).map((entry) => entry.path);
  }

  snapshot() {
    return Object.freeze({
      strict: this.strict,
      aliases: Object.freeze(Object.fromEntries(this.aliases)),
      records: Object.freeze([...this.records.values()].map((entry) => Object.freeze({ ...entry }))),
    });
  }

  restore(snapshot) {
    if (!snapshot) return this;
    this.strict = Boolean(snapshot.strict);
    this.aliases = new Map(Object.entries(snapshot.aliases ?? {}));
    this.records = new Map((snapshot.records ?? []).map((entry) => [entry.path, { ...entry }]));
    return this;
  }

  note(action, entry, throttled = false) {
    if (!this.audit) return;
    if (throttled && entry.denials % 8 !== 1) return;
    try {
      this.audit({ kernel: "permissions", action, path: entry.path, state: entry.state, mode: entry.mode, reason: entry.reason ?? null });
    } catch {
      // 审计回调异常不得影响内核执行
    }
  }
}

/* ================================================================
 * 0.6 内核子系统之五：资源内核（Resource Kernel）
 *
 * 0.4 的配额散落在策略里（maxDomNodes / maxStyleBytes / maxTotalSteps），
 * 且只覆盖三样东西。0.6 把它收成一个统一账本：CPU、DOM、effect、
 * scope、timer、listener、request、stream、worker、storage、memory……
 * 全都能记账、能限额、能快照，越界抛 JLCQuotaError（ENOSPC_QUOTA）。
 * ================================================================ */

export const RESOURCE_KINDS = Object.freeze([
  "cpu", "memory", "dom", "effects", "scopes", "styles", "timers", "listeners",
  "requests", "streams", "workers", "storage", "tasks", "checkpoints",
]);

/** 默认限额：0 或不写 = 不限（由策略档给上限）。 */
export const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  cpu: 0,
  memory: 0,
  dom: 0,
  effects: 0,
  scopes: 0,
  styles: 0,
  timers: 0,
  listeners: 0,
  requests: 0,
  streams: 0,
  workers: 4,
  storage: 0,
  tasks: 0,
  checkpoints: 8,
});

/* ================================================================
 * 0.6.1 资源内核 2.0（在 0.6 账本之上叠加）：
 *   soft limit  —— burst 容忍区，越过只发警告（不杀任务）；
 *   hard limit  —— 真正的配额出口，越过才抛 JLCQuotaError；
 *   warning     —— 首次越过 soft、以及每次越过 hard 前都记账。
 * 旧写法（纯数字）完全兼容：数字即 hard，soft 默认 = hard（无容忍区）。
 * ================================================================ */

export class ResourceKernel {
  constructor(runtime, limits = {}) {
    this.runtime = runtime;
    this.limits = { ...DEFAULT_RESOURCE_LIMITS };
    this.softLimits = new Map();
    for (const [kind, value] of Object.entries(limits ?? {})) this.setLimit(kind, value);
    this.counters = new Map();
    this.peaks = new Map();
    this.warnings = new Map(); // kind → 警告次数
    this.events = [];
    this.maxEvents = 64;
  }

  /** 限额写入：数字 = hard；{ soft, hard } = 双限。 */
  setLimit(kind, value) {
    if (!RESOURCE_KINDS.includes(kind)) throw new JLCRuntimeError(`未知资源种类“${kind}”`);
    if (value !== null && typeof value === "object") {
      const hard = Math.max(0, Math.floor(Number(value.hard ?? value.limit ?? 0) || 0));
      const soft = Math.max(0, Math.floor(Number(value.soft ?? 0) || 0));
      this.limits[kind] = hard;
      this.softLimits.set(kind, soft > 0 ? soft : 0);
    } else {
      this.limits[kind] = Math.max(0, Math.floor(Number(value) || 0));
      this.softLimits.set(kind, 0); // 0 = 未单独设置，按默认容忍区（80%）处理
    }
    return this;
  }

  limitOf(kind) {
    const value = Number(this.limits[kind] ?? 0);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /** soft 阈值：显式设置优先；否则默认硬限额的 80%（计划：80% 警告，100% 才错）。 */
  softLimitOf(kind) {
    const hard = this.limitOf(kind);
    if (hard <= 0) return 0;
    const configured = this.softLimits.get(kind) ?? 0;
    if (configured > 0) return Math.min(configured, hard);
    return Math.max(1, Math.ceil(hard * 0.8));
  }

  setSoftLimit(kind, value) {
    if (!RESOURCE_KINDS.includes(kind)) throw new JLCRuntimeError(`未知资源种类“${kind}”`);
    this.softLimits.set(kind, Math.max(0, Math.floor(Number(value) || 0)));
    return this;
  }

  /** 显式计数器（cpu / streams / workers / storage / memory）优先，其余读实时账本。 */
  derived(kind) {
    const metrics = this.runtime?.metrics;
    if (!metrics) return 0;
    switch (kind) {
      case "dom": return metrics.nodes;
      case "effects": return metrics.effects;
      case "scopes": return metrics.scopes;
      case "styles": return metrics.styles;
      case "timers": return metrics.timers;
      case "listeners": return metrics.listeners;
      case "requests": return metrics.requests;
      case "tasks": return this.runtime?.scheduler?.taskCount?.() ?? 0;
      // 0.6.1：memory 不再是手动计数器——Memory Accountant 按分户账实时折算（KB）。
      case "memory": return this.runtime?.memoryAccountant ? this.runtime.memoryAccountant.usageKB() : null;
      default: return null;
    }
  }

  usageOf(kind) {
    const derived = this.derived(kind);
    if (derived != null) return derived;
    return this.counters.get(kind) ?? 0;
  }

  peakOf(kind) {
    return this.peaks.get(kind) ?? this.usageOf(kind);
  }

  /**
   * 记账 + 配额裁决。这是内核里唯一的配额出口。
   * 0.6.1：越过 soft 只警告（短暂 burst 不杀任务）；越过 hard 才抛。
   */
  reserve(kind, amount = 1) {
    if (!RESOURCE_KINDS.includes(kind)) return null;
    const used = this.usageOf(kind);
    const limit = this.limitOf(kind);
    const next = used + amount;
    if (limit > 0 && next > limit) throw this.quota(kind, used, amount, limit);
    const soft = this.softLimitOf(kind);
    if (soft > 0 && next > soft && used <= soft) this.warnSoft(kind, next, soft, limit);
    if (this.derived(kind) == null) {
      this.counters.set(kind, next);
      this.peaks.set(kind, Math.max(this.peaks.get(kind) ?? 0, next));
    } else {
      this.peaks.set(kind, Math.max(this.peaks.get(kind) ?? 0, next));
    }
    return next;
  }

  warnSoft(kind, used, soft, hard) {
    this.warnings.set(kind, (this.warnings.get(kind) ?? 0) + 1);
    if (this.runtime?.counters) this.runtime.counters.warnings += 1;
    this.note({ kind, used, soft, hard, action: "warn" });
    const onWarn = this.runtime?.onWarn;
    if (typeof onWarn === "function") {
      try {
        onWarn({ code: "E_RESOURCE_WARN", resource: kind, used, soft, hard });
      } catch {
        // 警告回调异常不影响内核
      }
    }
  }

  release(kind, amount = 1) {
    const own = this.counters.get(kind);
    if (own == null) return this.usageOf(kind);
    const next = Math.max(0, own - amount);
    this.counters.set(kind, next);
    return next;
  }

  quota(kind, used, amount, limit) {
    const error = new JLCQuotaError(
      `资源 ${kind} 用量 ${used}${amount > 1 ? ` + ${amount}` : ""} 超过配额 ${kind}=${limit}（ENOSPC_QUOTA）`,
    );
    error.resource = kind;
    error.limit = limit;
    error.used = used;
    this.note({ kind, used, limit, action: "quota" });
    return error;
  }

  /** 单一资源视图：宿主监控面板直接用。 */
  usage() {
    const view = {};
    for (const kind of RESOURCE_KINDS) {
      const used = this.usageOf(kind);
      const limit = this.limitOf(kind);
      if (used === 0 && limit === 0 && !this.counters.has(kind)) continue;
      const soft = this.softLimitOf(kind);
      view[kind] = Object.freeze({
        used,
        limit,
        soft,
        peak: this.peakOf(kind),
        ratio: limit > 0 ? used / limit : 0,
        // 0.6.1：资源状态三态——ok / warn（越过 soft）/ quota（越过 hard）
        state: limit > 0 && used > limit ? "quota" : soft > 0 && used > soft ? "warn" : "ok",
        warnings: this.warnings.get(kind) ?? 0,
      });
    }
    return Object.freeze(view);
  }

  totals() {
    let warnings = 0;
    for (const count of this.warnings.values()) warnings += count;
    return Object.freeze({
      events: this.events.length,
      exceeded: this.events.filter((event) => event.action === "quota").length,
      warnings,
    });
  }

  note(event) {
    this.events.push({ at: Date.now(), ...event });
    if (this.events.length > this.maxEvents) this.events.shift();
    const audit = this.runtime?.policy?.audit;
    if (audit) {
      try {
        audit({ kernel: "resources", ...event });
      } catch {
        // 忽略审计回调异常
      }
    }
  }

  snapshot() {
    return Object.freeze({
      counters: Object.freeze(Object.fromEntries(this.counters)),
      limits: Object.freeze({ ...this.limits }),
      soft: Object.freeze(Object.fromEntries(this.softLimits)),
    });
  }

  restore(snapshot) {
    if (!snapshot) return this;
    this.counters = new Map(Object.entries(snapshot.counters ?? {}));
    this.limits = { ...this.limits, ...(snapshot.limits ?? {}) };
    if (snapshot.soft) this.softLimits = new Map(Object.entries(snapshot.soft));
    return this;
  }
}

/* ================================================================
 * 0.6 内核子系统之六：运行时检查点（Checkpoint / Rollback）
 *
 * fault: "rollback" 与 handle.rollback() 的落点。检查点捕获的是
 * 「可变状态」：全局 signal（state / derive / resource 快照）、白名单里的
 * 只读信号、权限与资源账本、调度器尚未派发的队列、组件树重放指令。
 * DOM 不拍照，而是靠 scope 重建 + 视图重跑回到一致状态——这就是
 * 「状态快照 + 结构重放」而不是「深拷贝 DOM」。
 * ================================================================ */

export class CheckpointStore {
  constructor(runtime, { limit = 8, delta = false } = {}) {
    this.runtime = runtime;
    this.limit = Math.max(1, limit);
    this.delta = Boolean(delta);
    this.entries = new Map();
    this.serial = 0;
    this.lastFullSignals = null; // delta 模式：最近一次拍照的全量基准
    this.bytes = 0;              // 全部条目自身占用（结构共享后的净占用）
  }

  capture(label, extra = null) {
    const runtime = this.runtime;
    if (!runtime || runtime.destroyed) return null;
    const signals = Object.create(null);
    for (const [name, slot] of runtime.globals?.names ?? []) {
      const binding = runtime.globals.bindings[slot];
      if (binding?.kind === "signal" && binding.signal.writable) signals[name] = binding.signal.value;
    }
    // 0.6.1 Checkpoint 2.0：delta 模式只存「相对上一份的变化」，其余结构共享。
    const changed = this.delta ? diffSignals(signals, this.lastFullSignals) : null;
    const isDelta = this.delta && changed != null;
    const entry = {
      label: String(label ?? `cp-${this.serial + 1}`),
      serial: (this.serial += 1),
      at: Date.now(),
      signals: isDelta ? null : Object.freeze(signals),
      signalNames: Object.freeze(Object.keys(signals)),
      changed: isDelta ? Object.freeze(changed) : null,
      base: isDelta ? this.lastLabel ?? null : null,
      delta: isDelta,
      permissions: runtime.permissions?.snapshot?.() ?? null,
      resources: runtime.resources?.snapshot?.() ?? null,
      faultCounts: runtime.metrics ? Object.freeze({ faults: runtime.metrics.faults, cycles: runtime.metrics.cycles }) : null,
      meta: extra ? Object.freeze({ ...extra }) : null,
    };
    this.lastFullSignals = signals;
    this.lastLabel = entry.label;
    const bytes = estimateEntryBytes(entry);
    entry.bytes = bytes;
    this.bytes += bytes;
    // 注意：条目在账本内保持可变——淘汰时 delta 依赖者要能被原地升级；
    // 对外视图（list()）仍然返回冻结副本。
    this.entries.set(entry.label, entry);
    runtime.memoryAccountant?.charge("checkpoints", bytes);
    if (this.entries.size > this.limit) {
      const oldest = [...this.entries.values()].sort((left, right) => left.serial - right.serial)[0];
      if (oldest) this.evict(oldest.label);
    }
    return Object.freeze({ ...this.entries.get(entry.label) });
  }

  evict(label) {
    const entry = this.entries.get(label);
    if (!entry) return;
    // delta 链保护：被淘汰者若还是别人的 base，先趁它还在账上把依赖者
    // 升级成完整快照，再执行删除——否则物化时链条断裂。
    promoteDependents(this.entries, label);
    this.entries.delete(label);
    this.bytes -= entry.bytes ?? 0;
    this.runtime?.memoryAccountant?.release("checkpoints", entry.bytes ?? 0);
    if (this.lastLabel === label) this.lastFullSignals = null;
  }

  /** 回滚：恢复 signal 值（在有界批次里触发重渲染），并返回被恢复的检查点。 */
  restore(label) {
    const runtime = this.runtime;
    const entry = this.entries.get(String(label));
    if (!entry || !runtime || runtime.destroyed) return null;
    // delta 条目沿 base 链物化出完整状态；完整条目原样使用。
    const signals = entry.delta || entry.base ? materializeSignals(this.entries, entry) : entry.signals;
    runtime.permissions?.restore?.(entry.permissions);
    runtime.resources?.restore?.(entry.resources);
    runtime.transaction(() => {
      for (const name of entry.signalNames) {
        const binding = runtime.globals?.resolve?.(name);
        if (binding?.kind === "signal" && binding.signal.writable) {
          binding.signal.set(sanitizeValue(Object.hasOwn(signals, name) ? signals[name] : null), true);
        }
      }
    });
    return entry;
  }

  list() {
    return Object.freeze([...this.entries.values()].map((entry) => Object.freeze({
      label: entry.label,
      at: entry.at,
      serial: entry.serial,
      signals: entry.signalNames.length,
      delta: Boolean(entry.delta),
      base: entry.base ?? null,
      bytes: entry.bytes ?? 0,
      meta: entry.meta,
    })));
  }

  drop(label) {
    if (!this.entries.has(String(label))) return false;
    this.evict(String(label));
    return true;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
    this.lastFullSignals = null;
    this.lastLabel = null;
  }
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
    runtime.resources?.reserve("scopes");
    this.runtime = runtime;
    this.parent = parent;
    this.label = label;
    this.children = new Set();
    this.disposables = new Set();
    this.disposed = false;
    this.replay = null; // 组件级重启（fault: "restart"）的重放钩子
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
    // 0.6.1 Cancellation Kernel：组件没了，它名下的任务/请求不许再跑。
    try {
      this.runtime?.cancelScope?.(this);
    } catch {
      // 取消失败不阻塞销毁流程
    }
    if (this.runtime) this.runtime.metrics.scopes -= 1;
    this.parent = null;
    this.runtime = null;
  }
}

class Effect {
  constructor(runtime, scope, callback, priority = 1, signal = null) {
    runtime.resources?.reserve("effects");
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
    // 0.6.1：Effect Dependency Graph 的节点登记（依赖图成为一等公民）。
    runtime.effectRegistry?.add(this);
    scope.adopt(this);
    this.run();
  }

  schedule() {
    if (this.disposed) return;
    // Reactive Batch 2.0：同一事务内重复入队直接合并（effect dedupe）。
    if (this.queued) {
      this.runtime.counters && (this.runtime.counters.effectDeduped += 1);
      return;
    }
    this.runtime.scheduler.enqueue(this);
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
      if (isYieldSignal(error)) throw error;
      if (this.runtime.initializing) throw error;
      // 0.6：effect 级错误走故障阶梯——degrade / recover / restart / rollback / stop
      this.runtime.handleFault(error, { phase: "effect", scope: this.scope, effect: this });
    } finally {
      ACTIVE_EFFECT = previous;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRun();
    this.scope?.disposables.delete(this);
    this.runtime.effectRegistry?.delete(this);
    this.runtime.metrics.effects -= 1;
    this.callback = null;
    this.signal = null;
    this.scope = null;
    this.runtime = null;
  }
}

/* ================================================================
 * 0.6 调度器 v2（Priority Scheduler + Cooperative Tasks）
 *
 * 0.4：单一队列 + 优先级数字排序 + 每 effect 错误边界。
 * 0.6：在其上叠加任务层——每个任务带通道（P0..P7）、预算、截止时间，
 *      预算耗尽时 VM 可以「保存状态 → 让出 → 下一轮恢复」，
 *      而不是把整个实例判死刑。
 *
 * 兼容性：queue / pending / flushing / enqueue() 的旧语义原样保留，
 * 0.4 的 effect 调度路径（含 1000 轮循环保护）走的还是同一条路。
 * ================================================================ */

let NEXT_TASK_ID = 1;

/** 协作式让出信号。它不是错误，是内核的控制流：捕获方必须原样续跑。 */
export class JLCYieldSignal extends Error {
  constructor(info = {}) {
    super(`JLC VM 让出执行权（${info.reason ?? "budget"}）`);
    this.name = "JLCYieldSignal";
    this.isYieldSignal = true;
    this.info = info;
  }
}

export function isYieldSignal(value) {
  return Boolean(value?.isYieldSignal);
}

/** 预算越界：不可续跑的执行路径超出 CPU 预算（内核的 EAGAIN / budget）。 */
export class JLCBudgetError extends JLCRuntimeError {
  constructor(message, info = {}) {
    super(message);
    this.name = "JLCBudgetError";
    this.code = "E_BUDGET";
    this.taskKind = info.kind ?? null;
    this.steps = info.steps ?? 0;
    this.budget = info.budget ?? 0;
  }
}

/* ================================================================
 * 0.6.1 Scheduler v2.1（在 0.6 任务层之上叠加公平性治理）
 *
 * 不新增通道：P0..P7 照旧。新增三个机制，全部由 LaneGovernor 裁决：
 *   1. Priority Aging      —— 等待越久有效优先级越高（有界）
 *   2. Lane Quota          —— 单车道连跑 N 片强制让出，先查其它车道
 *   3. Starvation Guard    —— 饥饿车道直接营救
 * 另接入 VM Frame Budget：一次 flush = 一帧，任务领取本帧内所属
 * 车道的动态截止时间；帧结束统一提交 DOM 事务。
 * ================================================================ */

class Scheduler {
  constructor(runtime) {
    this.runtime = runtime;
    this.queue = new Set();
    this.tasks = [];
    this.pending = false;
    this.flushing = false;
    this.current = null;
    this.seq = 0;
    // ---- 0.6.1 公平调度 ----
    this.governor = runtime?.options?.schedulerGovernor ?? null;
    this.frameBudget = runtime?.frameBudget ?? null;
    this.frame = null;
    this.lastLane = null;
    this.transactionSerial = 0;
  }

  taskCount() {
    return this.queue.size + this.tasks.length;
  }

  /** 0.4 兼容入口：effect 去重 + 微任务合并派发。 */
  enqueue(effect) {
    if (effect.disposed || effect.queued) return;
    effect.queued = true;
    this.queue.add(effect);
    this.wake();
  }

  /**
   * 0.6 任务入口。
   * @param {object} task
   * @param {string} [task.kind]      任务种类（决定默认通道）
   * @param {number|string} [task.priority]
   * @param {number} [task.budget]    指令预算（0 = 无限）
   * @param {number} [task.deadline]  绝对时间戳（ms）
   * @param {boolean} [task.sliceable] 是否允许协作式让出
   * @param {Function} task.run
   * @param {Function} [task.then]    续跑完成后收尾（承接 JS 收尾步骤）
   */
  submit(task) {
    if (!this.runtime || this.runtime.destroyed || typeof task?.run !== "function") return null;
    const kind = task.kind ?? "task";
    const priority = normalizePriority(task.priority ?? TASK_PRIORITY[kind] ?? PRIORITY.EFFECT);
    const deadline = Math.max(0, Number(task.deadline ?? 0) || 0);
    const normalized = {
      id: NEXT_TASK_ID++,
      seq: (this.seq += 1),
      kind,
      label: String(task.label ?? kind),
      priority,
      budget: Math.max(0, Number(task.budget ?? this.runtime.options.maxSliceSteps ?? 0) || 0),
      deadline,
      sliceable: Boolean(task.sliceable),
      yieldToHost: Boolean(task.yieldToHost),
      resumable: task.resumable !== false,
      run: task.run,
      then: typeof task.then === "function" ? task.then : null,
      settle: typeof task.settle === "function" ? task.settle : null,
      scope: task.scope ?? null,
      submitted: Date.now(),
      resumed: Boolean(task.resumed),
      // 0.6.1 Cancellation Kernel：每个任务一个取消令牌；续跑任务沿用原令牌。
      token: task.token ?? this.runtime.cancellation?.register({ label: String(task.label ?? kind), scope: task.scope ?? null }) ?? null,
      transaction: task.transaction ?? this.transactionSerial,
    };
    this.tasks.push(normalized);
    this.wake();
    return normalized;
  }

  /** 测试与宿主诊断用：当前任务视图（不含闭包）。 */
  pendingTasks() {
    return Object.freeze(this.tasks.map((task) => Object.freeze({
      id: task.id, kind: task.kind, label: task.label, priority: task.priority,
      budget: task.budget, deadline: task.deadline, sliceable: task.sliceable,
    })));
  }

  wake() {
    if (this.pending || this.runtime?.batchDepth > 0 || this.runtime?.destroyed) return;
    this.pending = true;
    const tick = () => {
      if (!this.runtime || this.runtime.destroyed) return;
      this.pending = false;
      this.flush();
    };
    // yieldToHost：让出一帧，让浏览器有机会绘制（大列表分片渲染用）。
    if (this.tasks.some((task) => task.yieldToHost && !task.resumed)) {
      const host = this.runtime.window;
      if (host?.requestAnimationFrame) host.requestAnimationFrame(() => tick());
      else (host?.setTimeout ?? setTimeout)(tick, 0);
      return;
    }
    queueMicrotask(tick);
  }

  /**
   * 0.6.1 公平选取：老化后的有效优先级 + 车道配额 + 饥饿营救。
   * 配额全部拒绝时回退到原始优先级选取，保证不会死锁。
   */
  takeTask() {
    const governor = this.governor;
    const now = Date.now();
    if (!governor) return this.pickByPriority(null, now);

    const pendingLanes = new Set(this.tasks.map((task) => task.priority));
    // 饥饿营救：先找被饿得最久的车道——它直接获得本轮选取权。
    const starved = governor.starvedLane(pendingLanes, now);
    if (starved != null) governor.rescues += 1;

    let chosen = this.pickByPriority(governor, now, starved);
    if (!chosen) chosen = this.pickByPriority(null, now); // 配额全拒 → 回退，绝不死锁
    if (chosen) {
      // 上一车道因配额被拦下、本轮换了车道 → 记一次强制让出。
      if (this.lastLane != null && chosen.priority !== this.lastLane && !governor.canRun(this.lastLane, pendingLanes)) {
        governor.noteForcedYield(this.lastLane);
      }
      governor.noteSwitched(this.lastLane, chosen.priority);
      governor.noteRan(chosen.priority, now);
      this.lastLane = chosen.priority;
      // VM Frame Budget：派发时刻领取本帧内该车道的动态截止时间。
      if (this.frameBudget?.enabled) {
        const frameDeadline = this.frameBudget.deadlineFor(this.frame ?? (this.frame = this.frameBudget.begin(now)), chosen.priority);
        if (frameDeadline > 0) chosen.deadline = chosen.deadline > 0 ? Math.min(chosen.deadline, frameDeadline) : frameDeadline;
      }
    }
    return chosen;
  }

  pickByPriority(governor, now, preferredLane = null) {
    let best = -1;
    let chosen = null;
    let chosenKey = null;
    const lanes = governor && preferredLane == null ? new Set(this.tasks.map((task) => task.priority)) : null;
    for (let index = 0; index < this.tasks.length; index += 1) {
      const candidate = this.tasks[index];
      if (candidate.token?.canceled) { this.tasks.splice(index, 1); index -= 1; continue; }
      if (preferredLane != null && candidate.priority !== preferredLane) continue;
      // 车道配额：连跑超片数的车道先让位（还有其它车道在等时）。
      if (governor && preferredLane == null && !governor.canRun(candidate.priority, lanes)) continue;
      const effective = governor ? governor.effectivePriority(candidate, now) : candidate.priority;
      const keyDeadline = candidate.deadline === 0 ? Number.POSITIVE_INFINITY : candidate.deadline;
      if (!chosen
        || effective < chosenKey[0]
        || (effective === chosenKey[0] && keyDeadline < chosenKey[1])
        || (effective === chosenKey[0] && keyDeadline === chosenKey[1] && candidate.seq < chosenKey[2])) {
        best = index;
        chosen = candidate;
        chosenKey = [effective, keyDeadline, candidate.seq];
      }
    }
    if (!chosen) return null;
    this.tasks.splice(best, 1);
    return chosen;
  }

  flush() {
    if (this.flushing || !this.runtime || this.runtime.destroyed) return;
    this.flushing = true;
    // 0.6.1：一次 flush 视为一帧——预算从这里开始算，帧末统一提交 DOM。
    if (this.frameBudget?.enabled && !this.frame) this.frame = this.frameBudget.begin();
    try {
      this.drain();
    } finally {
      this.flushing = false;
      this.frame = null;
      this.runtime.commitDom?.();
    }
  }

  /** 同步跑干：effect 批处理 → 任务队列，直到两个队列都空。 */
  drain() {
    const runtime = this.runtime;
    let rounds = 0;
    const stranded = [];
    try {
      while (this.queue.size || this.tasks.length) {
        if (++rounds > 1000) throw new JLCRuntimeError("响应式更新超过 1000 轮，可能存在循环依赖");
        while (this.queue.size && !runtime.destroyed) {
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
              if (isYieldSignal(error)) {
                // 协作式让出：本 effect 已切片的机器状态由续跑任务接手，
                // 同批其余 effect 照常执行（它们本来就与该 effect 无关）。
                this.adoptSuspension(error, effect);
                continue;
              }
              stranded.push(error);
              for (const rest of effects.slice(index + 1)) {
                try {
                  if (!rest.disposed) rest.run();
                } catch (nested) {
                  if (isYieldSignal(nested)) {
                    this.adoptSuspension(nested, rest);
                    continue;
                  }
                  stranded.push(nested);
                }
              }
              throw error;
            }
          }
        }
        if (runtime.destroyed) return;
        const task = this.tasks.length ? this.takeTask() : null;
        if (task) this.runTask(task);
      }
    } catch (error) {
      for (const effect of this.queue) effect.queued = false;
      this.queue.clear();
      for (const strandedError of stranded) runtime.reportError(strandedError);
      if (isYieldSignal(error)) {
        this.adoptSuspension(error, null);
        return;
      }
      runtime.handleFault(error, { phase: "scheduler" });
    }
  }

  runTask(task) {
    const runtime = this.runtime;
    // 0.6.1：已取消的任务不执行——组件没了，后台不许再动。
    if (task.token?.canceled || runtime.destroyed) {
      if (task.token) runtime.cancellation?.settle(task.token);
      task.settle?.(new JLCRuntimeError(`任务“${task.label}”已被取消`), null);
      return undefined;
    }
    const previous = this.current;
    this.current = task;
    runtime.counters.tasks += 1;
    try {
      const value = typeof task.run === "function" ? task.run(task) : undefined;
      this.current = previous;
      if (task.then) task.then(value, null, task);
      task.settle?.(null, value);
      return value;
    } catch (error) {
      this.current = previous;
      if (isYieldSignal(error)) {
        this.adoptSuspension(error, task);
        return undefined;
      }
      runtime.handleFault(error, { phase: "task", task });
      task.settle?.(error, null);
      return undefined;
    } finally {
      // 非挂起收尾：释放取消令牌（挂起续跑会沿用原令牌）。
      if (!runtime.machine?.suspended && task.token) runtime.cancellation?.settle(task.token);
    }
  }

  /** 把挂起的机器状态包成续跑任务：让出一轮，保证其它通道先跑。 */
  adoptSuspension(signal, owner) {
    const runtime = this.runtime;
    const machine = runtime?.machine;
    if (!runtime || runtime.destroyed || !machine?.suspended) return null;
    const info = signal.info ?? {};
    const parent = owner && typeof owner === "object" && "priority" in owner ? owner : null;
    const priority = normalizePriority(
      info.resumePriority ?? (parent ? Math.min(PRIORITY.IDLE, parent.priority + 1) : PRIORITY.EFFECT),
      PRIORITY.EFFECT,
    );
    const then = parent?.then ?? null;
    const task = this.submit({
      kind: parent?.kind ?? info.kind ?? "resume",
      label: `resume:${parent?.label ?? info.kind ?? "vm"}`,
      priority,
      budget: parent?.budget ?? runtime.options.maxSliceSteps ?? 0,
      deadline: info.deadline ?? parent?.deadline ?? 0,
      sliceable: true,
      resumed: true,
      // 续跑与原任务共享取消令牌：取消父任务 = 取消整条续跑链。
      token: parent?.token ?? null,
      scope: parent?.scope ?? null,
      run: () => machine.resumeSuspended(),
      then: then ? (value, _error, self) => then(value, null, self) : null,
      settle: parent?.settle ?? null,
    });
    runtime.counters.yields += 1;
    return task;
  }

  /* ---- 0.6.1 Cancellation Kernel 的调度器侧 ---- */

  /** 按 id / label 取消排队中的任务；返回取消数。 */
  cancelTask(query) {
    let count = 0;
    this.tasks = this.tasks.filter((task) => {
      const match = typeof query === "number"
        ? task.id === query
        : typeof query === "string"
          ? task.label === query || String(task.id) === query
          : typeof query === "function" ? query(task) : false;
      if (!match) return true;
      task.token?.cancel("host cancel");
      runtime_settleCanceled(this.runtime, task);
      count += 1;
      return false;
    });
    if (this.runtime?.counters) this.runtime.counters.cancels += count;
    return count;
  }

  /** scope 销毁：撤掉它名下所有排队任务。 */
  cancelScope(scope) {
    if (!scope) return 0;
    return this.cancelTask((task) => task.scope === scope);
  }

  /** 车道视图：每个通道的运行 / 强制让出 / 当前连击（Profile 2.0 用）。 */
  laneStats() {
    const pending = new Map();
    for (const task of this.tasks) pending.set(task.priority, (pending.get(task.priority) ?? 0) + 1);
    return Object.freeze({
      pending: Object.freeze(Object.fromEntries(pending)),
      queuedEffects: this.queue.size,
      governor: this.governor?.stats() ?? null,
      frameBudget: this.frameBudget?.stats() ?? null,
    });
  }

  clear() {
    for (const effect of this.queue) effect.queued = false;
    this.queue.clear();
    for (const task of this.tasks) {
      if (task.token) this.runtime?.cancellation?.settle(task.token);
      // 卸载语义：未跑完的任务静默了结（resolve），避免宿主挂起或出现未处理拒绝。
      task.settle?.(null, null);
    }
    this.tasks.length = 0;
    this.current = null;
    this.runtime = null;
  }
}

/** 取消排队任务时同步兑现它的 deferred（宿主不会永远等下去：以取消值了结）。 */
function runtime_settleCanceled(runtime, task) {
  try {
    task.settle?.(null, null);
  } catch {
    // settle 异常不影响其余取消
  }
  runtime?.cancellation?.settle(task.token);
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

const SECTION = {
  POOL: 1, GLOBALS: 2, FUNCS: 3, ACTIONS: 4, DECLS: 5, VIEW: 6, META: 7, MANIFEST: 8,
  // ---- ABI v3 新增段（v1/v2 模块不写这些段，解码器按缺省处理）----
  CAPABILITIES: 9, // 能力图路径清单（与指令流交叉核对）
  RESOURCES: 10,   // 资源清单：这个模块会用到哪些资源、静态上界是多少
  FLAGS: 11,       // 模块标志位：可重放 / 含网络 / 含定时器 / 含 frame ...
};

/** 资源清单种类（与 RESOURCE_KINDS 对齐的稳定编码，落进 .jbc 后不能改号）。 */
const RESOURCE_CODES = Object.freeze({ dom: 1, effects: 2, styles: 3, timers: 4, requests: 5, scopes: 6, listeners: 7, workers: 8, storage: 9, streams: 10 });
const RESOURCE_CODE_NAMES = Object.freeze(["", ...Object.keys(RESOURCE_CODES)]);
export const MODULE_FLAGS = Object.freeze({ deterministic: 1, network: 2, timers: 4, frames: 8, windowEvents: 16, workers: 32 });
const POOL_NULL = 0, POOL_TRUE = 1, POOL_FALSE = 2, POOL_NUM = 3, POOL_STR = 4;
export const REQUIREMENT_KINDS = ["tag", "frame", "url", "property", "attribute", "host", "window", "style", "capability"];
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
  // ---- ABI v3：能力清单 / 资源清单 / 标志位 ----
  {
    const analysis = moduleAnalysis(module) ?? analyzeModule(module, { mode: "normal" });
    const capabilities = new ByteWriter();
    const paths = analysis.capabilityPaths ?? [];
    capabilities.u16(paths.length);
    for (const path of paths) capabilities.str(path);
    sections.push([SECTION.CAPABILITIES, capabilities]);

    const resources = new ByteWriter();
    const manifest = resourceManifestOf(module, analysis);
    const entries = Object.entries(manifest).filter(([kind]) => RESOURCE_CODES[kind] != null);
    resources.u16(entries.length);
    for (const [kind, amount] of entries) {
      resources.u8(RESOURCE_CODES[kind]);
      resources.u32(Math.max(0, Math.min(0xffffffff, Math.floor(amount))));
    }
    sections.push([SECTION.RESOURCES, resources]);

    const flags = new ByteWriter();
    let bits = 0;
    if (analysis.determinism?.deterministic) bits |= MODULE_FLAGS.deterministic;
    for (const requirement of module.requirements ?? []) {
      if (requirement.key === "host:http") bits |= MODULE_FLAGS.network;
      if (requirement.key === "host:timer") bits |= MODULE_FLAGS.timers;
      if (requirement.kind === "frame") bits |= MODULE_FLAGS.frames;
      if (requirement.kind === "window") bits |= MODULE_FLAGS.windowEvents;
    }
    flags.u32(bits);
    sections.push([SECTION.FLAGS, flags]);
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

/**
 * 资源清单的静态上界：验证器数一遍指令流，给出「这个模块最多用多少资源」。
 * 这是给宿主看的需求声明，不是运行时账本（两者在 describe() 里分开呈现）。
 */
export function resourceManifestOf(module, analysis = null) {
  const manifest = Object.create(null);
  let dom = 0;
  let timers = 0;
  let effects = 0;
  let styles = 0;
  for (const func of module.functions) {
    let ip = 0;
    const code = func.code;
    while (ip < code.length) {
      const opcode = code[ip];
      const spec = OP_SPEC[opcode];
      if (!spec) break;
      ip += 1;
      let first = null;
      for (const descriptor of spec.operands) {
        if (descriptor === "B") { if (first == null) first = code[ip]; ip += 1; }
        else if (descriptor === "I") ip += 4;
        else { const value = (code[ip] << 8) | code[ip + 1]; if (first == null) first = value; ip += 2; }
      }
      if (opcode === OP.ELEM) dom += 1;
      else if (opcode === OP.TIMER) timers += 1;
      else if (opcode === OP.WHEN || opcode === OP.EACH) effects += 1;
    }
  }
  for (const declaration of module.declarations) {
    if (declaration.kind === "style") styles += 1;
    if (declaration.kind === "resource") effects += 1;
    if (declaration.kind === "derive") effects += 1;
  }
  if (dom) manifest.dom = dom;
  if (effects) manifest.effects = effects;
  if (timers) manifest.timers = timers;
  if (styles) manifest.styles = styles;
  const requests = (module.declarations ?? []).filter((declaration) => declaration.kind === "resource").length;
  if (requests) manifest.requests = requests;
  const paths = analysis?.capabilityPaths ?? [];
  if (paths.some((path) => path.startsWith("compute.worker"))) manifest.workers = 1;
  if (paths.some((path) => path.startsWith("storage"))) manifest.storage = 1;
  return manifest;
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
    // 0.6：未知段原样跳过——前向兼容比「拒绝一切未知」更适合分布式分发。
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
  if (payloads.has(SECTION.CAPABILITIES)) {
    const capabilities = new ByteReader(payloads.get(SECTION.CAPABILITIES), sourceName);
    const count = capabilities.u16();
    const paths = [];
    for (let index = 0; index < count; index += 1) {
      const path = capabilities.str();
      if (!isCapabilityPath(path)) throw new JLCVerifyError(`能力路径“${path}”不在内核能力图中`, sourceName);
      paths.push(path);
    }
    module.declaredCapabilities = Object.freeze(paths);
  }
  if (payloads.has(SECTION.RESOURCES)) {
    const resources = new ByteReader(payloads.get(SECTION.RESOURCES), sourceName);
    const count = resources.u16();
    const manifest = Object.create(null);
    for (let index = 0; index < count; index += 1) {
      const kind = RESOURCE_CODE_NAMES[resources.u8()];
      const amount = resources.u32();
      if (!kind) continue;
      manifest[kind] = amount;
    }
    module.resourceManifest = Object.freeze(manifest);
  }
  if (payloads.has(SECTION.FLAGS)) {
    module.flags = new ByteReader(payloads.get(SECTION.FLAGS), sourceName).u32();
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
  if (Array.isArray(module.declaredCapabilities)) Object.freeze(module.declaredCapabilities);
  if (Array.isArray(module.capabilityPaths)) Object.freeze(module.capabilityPaths);
  if (module.resourceManifest && !Object.isFrozen(module.resourceManifest)) Object.freeze(module.resourceManifest);
  return module;
}

/* ================================================================
 * 字节码验证器（Bytecode Verifier）
 * 载入期静态检查：操作码合法性、操作数边界、跳转目标落在指令边界、
 * 操作数栈深度一致性、元素游标配平 —— 等价 JVM 的 class 校验。
 * ================================================================ */

export function verifyModule(module, sourceName = "<jbc>", options = {}) {
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
    if (!Object.isFrozen(func)) func.maxStack = maxStack;
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

  // ---- Pass 6 / 7 / 9 / 10 / 11（0.6 多趟验证）----
  const mode = options.mode ?? "normal";
  const analysis = analyzeModule(module, { mode });
  attachAnalysis(module, analysis);
  // ABI v3：申报的能力清单只能少报不能多报——与接口清单同一条铁律。
  if (module.declaredCapabilities) {
    const actualPaths = new Set(analysis.capabilityPaths);
    const missing = module.declaredCapabilities.filter((path) => !actualPaths.has(path));
    if (missing.length) fail(`申报能力与指令流不一致，漏报接口：${missing.join(", ")}`);
  }
  if (module.resourceManifest) {
    const actualManifest = resourceManifestOf(module, analysis);
    const missing = Object.keys(module.resourceManifest).filter((kind) => !(kind in actualManifest));
    // 资源清单只做「上界合理性」检查：申报了却完全用不到的资源视为伪造。
    for (const kind of missing) {
      if (!(kind in actualManifest)) fail(`资源清单申报了未使用的资源“${kind}”`);
    }
  }
  if (!Object.isFrozen(module)) {
    module.capabilityPaths = analysis.capabilityPaths;
    module.resourceManifest = { ...resourceManifestOf(module, analysis), ...(module.resourceManifest ?? {}) };
  }
  if (analysis.errors.length) fail(`多趟验证失败：${analysis.errors[0]}`);
  if (options.report) return analysis;
  return module;
}

/* ================================================================
 * 0.6 多趟验证器（Multi-pass Verifier）
 *
 * 0.4 的 verifyModule 是一条流水线：线性扫描 → 栈深度工作表 → 结构引用。
 * 0.6 把它显式拆成 11 趟，并在原有「硬失败」之外增加两个只读分析：
 *
 *   Pass 6  CFG        建立控制流图：不可达块、非法跳转、循环回边
 *   Pass 7  抽象栈类型  只对「确定类型」报警（数组当函数调用这种），
 *                      默认 advisory，mode: "strict" 时升级为载入失败
 *   Pass 11 确定性      判断模块是否可重放（有没有 timer / http / 窗口事件）
 *
 * 副产品是 module.analysis：检查器、Profiler、调试器都读这一份数据。
 * ================================================================ */

export const VERIFIER_PASSES = Object.freeze([
  Object.freeze({ id: 1, name: "header", label: "魔数 / ABI / 版本 / 段结构" }),
  Object.freeze({ id: 2, name: "pool", label: "常量池类型与字符串引用" }),
  Object.freeze({ id: 3, name: "opcode", label: "操作码合法性与函数类型约束" }),
  Object.freeze({ id: 4, name: "operand", label: "操作数边界与索引范围" }),
  Object.freeze({ id: 5, name: "stack", label: "操作数栈深度一致性（工作表算法）" }),
  Object.freeze({ id: 6, name: "cfg", label: "控制流图：跳转边界 / 不可达 / 循环回边" }),
  Object.freeze({ id: 7, name: "types", label: "抽象栈类型（advisory，strict 档升级为失败）" }),
  Object.freeze({ id: 8, name: "structure", label: "函数 / action / 声明 / 视图引用完整性" }),
  Object.freeze({ id: 9, name: "manifest", label: "能力清单与指令流交叉核对" }),
  Object.freeze({ id: 10, name: "security", label: "安全不变量：硬限制 / 原型逃逸" }),
  Object.freeze({ id: 11, name: "determinism", label: "确定性：可重放性判定" }),
]);

const TYPE_UNKNOWN = "unknown";

/** 抽象类型格：常量池值 → 抽象类型。 */
function typeOfPoolValue(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  return TYPE_UNKNOWN;
}

function mergeType(left, right) {
  if (left === right) return left;
  if (left === TYPE_UNKNOWN || right === TYPE_UNKNOWN) return TYPE_UNKNOWN;
  return TYPE_UNKNOWN;
}

const CALLABLE_TYPES = new Set(["function", TYPE_UNKNOWN]);

/**
 * 控制流图：把指令流切成基本块，给出边、不可达块与循环回边。
 * 这是 Pass 6 的唯一数据源，也是 vm.graph() 渲染的内容。
 */
export function buildCFG(func, module = null) {
  const code = func.code;
  const instructionAt = new Map();
  const leaders = new Set([0]);
  let ip = 0;
  let truncated = false;
  // Pass A：线性解码，记录每条指令以及「块首」候选。
  // 块首 = 函数入口 ∪ 跳转目标 ∪ 终结指令的下一条。
  while (ip < code.length) {
    const start = ip;
    const opcode = code[ip];
    const spec = OP_SPEC[opcode];
    if (!spec) {
      instructionAt.set(start, { start, end: start + 1, opcode, name: `UNKNOWN(0x${opcode.toString(16)})`, values: [], jump: null });
      leaders.add(start + 1);
      ip += 1;
      continue;
    }
    ip += 1;
    const values = [];
    for (const descriptor of spec.operands) {
      if (descriptor === "B") {
        if (ip >= code.length) { truncated = true; break; }
        values.push(code[ip]);
        ip += 1;
      } else if (descriptor === "I") {
        if (ip + 4 > code.length) { truncated = true; break; }
        values.push(((code[ip] << 24) | (code[ip + 1] << 16) | (code[ip + 2] << 8) | code[ip + 3]) | 0);
        ip += 4;
      } else {
        if (ip + 2 > code.length) { truncated = true; break; }
        values.push((code[ip] << 8) | code[ip + 1]);
        ip += 2;
      }
    }
    const jump = spec.jump ?? null;
    instructionAt.set(start, { start, end: ip, opcode, values, name: spec.name, jump });
    if (jump) {
      const target = jump === "fornext" ? values[3] : jump === "return" ? null : values[0];
      if (target != null) leaders.add(target);
      if (jump !== "return") leaders.add(ip);
    }
  }
  leaders.add(code.length);

  // Pass B：按块首切基本块。
  const starts = [...leaders]
    .filter((offset) => offset <= code.length && (offset === code.length || instructionAt.has(offset)))
    .sort((left, right) => left - right);
  const blocks = [];
  const indexOfStart = new Map();
  for (const start of starts) {
    if (start === code.length) continue;
    const block = { id: blocks.length, start, end: start, instructions: [], successors: [], kind: "fallthrough", terminator: null };
    indexOfStart.set(start, block.id);
    let cursor = start;
    while (cursor < code.length) {
      const instruction = instructionAt.get(cursor);
      if (!instruction) break;
      block.instructions.push(instruction);
      block.end = instruction.end;
      if (instruction.jump) {
        block.terminator = instruction;
        break;
      }
      cursor = instruction.end;
      if (leaders.has(cursor)) break; // 下一条已是块首：本块到此为止
    }
    blocks.push(block);
  }

  // Pass C：连边。终结指令决定去向，其余落到紧随其后的块。
  for (const [index, block] of blocks.entries()) {
    const terminator = block.terminator;
    const next = blocks[index + 1] ?? null;
    if (!terminator) {
      block.kind = block.end >= code.length ? "exit" : "fallthrough";
      if (next && next.start === block.end) block.successors.push(next.id);
      continue;
    }
    const { jump, values } = terminator;
    if (jump === "return") {
      block.kind = "exit";
      continue;
    }
    const targetOffset = jump === "fornext" ? values[3] : values[0];
    const target = indexOfStart.get(targetOffset);
    block.kind = jump === "always" ? "jump" : "branch";
    if (target != null) block.successors.push(target);
    else block.successors.push(`orphan:${targetOffset}`);
    if (jump !== "always" && next && next.start === block.end) block.successors.push(next.id);
  }

  // Pass D：可达性 + 回边（目标在前的边 = 循环）。
  const reachable = new Set();
  const queue = [0];
  const loopEdges = [];
  const edges = [];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (typeof id !== "number" || reachable.has(id)) continue;
    const block = blocks[id];
    if (!block) continue;
    reachable.add(id);
    for (const successor of block.successors) {
      if (typeof successor !== "number") continue;
      const key = `${id}->${successor}`;
      if (!seen.has(key)) {
        seen.add(key);
        edges.push(key);
        const targetBlock = blocks[successor];
        if (targetBlock && targetBlock.start <= block.start) loopEdges.push(key);
      }
      queue.push(successor);
    }
  }
  return {
    function: func.name,
    kind: func.kind,
    blocks,
    edges,
    unreachable: blocks.filter((block) => !reachable.has(block.id)).map((block) => ({ id: block.id, start: block.start, end: block.end })),
    loopEdges,
    truncated,
  };
}

/** Pass 7：抽象栈类型分析——只在「确定类型冲突」时报警。 */
export function analyzeAbstractStack(func, module, options = {}) {
  const warnings = [];
  const code = func.code;
  const instructionAt = new Map();
  let ip = 0;
  while (ip < code.length) {
    const start = ip;
    const opcode = code[ip];
    const spec = OP_SPEC[opcode];
    if (!spec) break;
    ip += 1;
    const values = [];
    for (const descriptor of spec.operands) {
      if (descriptor === "B") values.push(code[ip++]);
      else if (descriptor === "I") { values.push(((code[ip] << 24) | (code[ip + 1] << 16) | (code[ip + 2] << 8) | code[ip + 3]) | 0); ip += 4; }
      else { values.push((code[ip] << 8) | code[ip + 1]); ip += 2; }
    }
    instructionAt.set(start, { start, end: ip, opcode, values });
  }

  const globalType = (slot) => {
    const name = module.globalRefs[slot];
    if (module.actions.some((action) => action.name === name)) return "function";
    if (module.declarations.some((declaration) => declaration.name === name)) return TYPE_UNKNOWN;
    return TYPE_UNKNOWN;
  };
  const pushTypeOf = (opcode, values) => {
    switch (opcode) {
      case OP.CONST: return typeOfPoolValue(module.pool[values[0]]);
      case OP.CONST_INT: return "number";
      case OP.CONST_NULL: return "null";
      case OP.BUILD_ARRAY: return "array";
      case OP.BUILD_OBJECT: return "object";
      case OP.GET_GLOBAL: return globalType(values[0]);
      default: return TYPE_UNKNOWN;
    }
  };

  const stackAt = new Map();
  const worklist = [[0, []]];
  let guard = 0;
  while (worklist.length && guard++ < 200_000) {
    const [offset, incoming] = worklist.pop();
    if (stackAt.has(offset)) continue;
    stackAt.set(offset, incoming.slice());
    let cursor = offset;
    const stack = incoming.slice();
    const pop = (count) => { for (let index = 0; index < count; index += 1) stack.pop(); };
    while (cursor < code.length) {
      const instruction = instructionAt.get(cursor);
      if (!instruction) break;
      const { opcode, values, end } = instruction;
      if (opcode === OP.CALL) {
        const argc = values[0];
        const callee = stack[stack.length - 1 - argc];
        if (callee != null && !CALLABLE_TYPES.has(callee)) {
          warnings.push(`${func.name}@${instruction.start}: 调用一个确定的${callee}值（不是函数）`);
        }
        pop(argc + 1);
        stack.push(TYPE_UNKNOWN);
      } else if (opcode === OP.GET_MEMBER) {
        const receiver = stack[stack.length - 1];
        if (receiver === "null") warnings.push(`${func.name}@${instruction.start}: 对确定为空的值取成员`);
        pop(1);
        stack.push(TYPE_UNKNOWN);
      } else if (opcode === OP.FOR_PREP) {
        stack.push("object"); // 迭代器
      } else if (opcode === OP.FOR_NEXT) {
        worklist.push([values[3], stack.slice(0, Math.max(0, stack.length - 1))]);
      } else if (opcode === OP.NOT || opcode === OP.NEG || opcode === OP.POS) {
        pop(1);
        stack.push(TYPE_UNKNOWN);
      } else if (opcode === OP.DUP) {
        stack.push(stack[stack.length - 1] ?? TYPE_UNKNOWN);
      } else {
        const delta = instructionStackDelta(opcode, values);
        if (delta < 0) pop(-delta);
        else if (delta > 0) stack.push(pushTypeOf(opcode, values));
      }

      let branched = false;
      if (opcode === OP.RETURN || opcode === OP.RETURN_NULL) break;
      if (instruction.opcode === OP.JUMP || (OP_SPEC[opcode]?.jump === "always")) {
        worklist.push([values[0], stack.slice()]);
        branched = true;
      } else if (opcode === OP.JUMP_IF_FALSE || opcode === OP.JUMP_IF_TRUE || opcode === OP.JUMP_IF_NONNULL || opcode === OP.JUMP_IF_NULL) {
        worklist.push([values[0], stack.slice()]);
      }
      if (branched) break;
      cursor = end;
      if (cursor >= code.length) break;
      if (stackAt.has(cursor)) break;
    }
  }
  return { warnings: [...new Set(warnings)], visited: stackAt.size };
}
/** Pass 11：确定性——决定这个模块能不能被快照重放。 */
function analyzeDeterminism(module, requirements) {
  const reasons = [];
  for (const requirement of requirements) {
    if (requirement.kind === "host" && requirement.detail === "http") reasons.push("host:http（网络不可重放）");
    if (requirement.kind === "host" && requirement.detail === "timer") reasons.push("host:timer（时间不可重放）");
    if (requirement.kind === "window") reasons.push("window:event（窗口事件不可重放）");
    if (requirement.kind === "frame") reasons.push("frame:iframe（第三方文档不可重放）");
  }
  return Object.freeze({ deterministic: reasons.length === 0, reasons: Object.freeze(reasons) });
}

/** Pass 9：把指令流扫描出的接口映射到能力图路径。 */
function capabilityPathsOf(requirements) {
  const paths = new Set();
  const map = {
    "host:http": "network.http",
    "host:navigate": "browser.navigation",
    "host:timer": "compute.timers",
    "host:title": "browser.title",
    "host:favicon": "browser.title",
    "host:emit": "dom.update",
    "window:event": "browser.window",
    "frame:iframe": "dom.create",
    "frame:srcdoc": "dom.create",
    "quota:dom": "dom.create",
    "quota:style": "dom.update",
    "quota:html": "dom.create",
  };
  for (const requirement of requirements) {
    const mapped = map[requirement.key];
    if (mapped && isCapabilityPath(mapped)) paths.add(mapped);
    if (requirement.kind === "capability") {
      const path = CAPABILITY_ALIASES[requirement.detail];
      if (path && isCapabilityPath(path)) paths.add(path);
    }
  }
  return [...paths].sort();
}

/** Pass 10：安全不变量——硬限制与原型逃逸。 */
function analyzeSecurity(module) {
  const warnings = [];
  for (const value of module.pool) {
    if (typeof value !== "string") continue;
    const lowered = value.toLowerCase();
    if (BLOCKED_KEYS.has(lowered) && BLOCKED_KEYS.has(value)) {
      warnings.push(`常量池出现原型逃逸键“${value}”：内核在任何路径下都不放行`);
    }
    for (const prefix of FORBIDDEN_URL_PREFIXES) {
      if (lowered.startsWith(prefix)) warnings.push(`常量池出现脚本型 URL 前缀“${prefix}”：一律净化`);
    }
  }
  return warnings;
}

const MODULE_ANALYSIS = new WeakMap();

/** 读取缓存的分析结果（冻结模块也能拿到）。 */
export function moduleAnalysis(module) {
  return MODULE_ANALYSIS.get(module) ?? module?.analysis ?? null;
}

function attachAnalysis(module, analysis) {
  MODULE_ANALYSIS.set(module, analysis);
  if (!Object.isFrozen(module)) {
    module.analysis = analysis;
    module.warnings = analysis.warnings;
  }
  return analysis;
}

/**
 * 完整分析：跑 Pass 6 / 7 / 9 / 10 / 11，产出只读分析对象。
 * 不需要抛错——verifyReport() 决定哪些是硬失败。
 */
export function analyzeModule(module, { mode = "normal" } = {}) {
  const strict = mode === "strict";
  const warnings = [];
  const errors = [];
  const functions = [];
  for (const func of module.functions) {
    let cfg = null;
    try {
      cfg = buildCFG(func, module);
    } catch (error) {
      errors.push(`CFG 构建失败（${func.name}）：${error.message}`);
      continue;
    }
    if (cfg.truncated) errors.push(`CFG 截断（${func.name}）：指令流末尾不完整`);
    if (cfg.unreachable.length) {
      const message = `${func.name}: ${cfg.unreachable.length} 个基本块不可达（@${cfg.unreachable.map((block) => block.start).join(", ")}）`;
      if (strict) errors.push(message);
      else warnings.push(message);
    }
    const types = analyzeAbstractStack(func, module, { strict });
    for (const warning of types.warnings) {
      if (strict) errors.push(warning);
      else warnings.push(warning);
    }
    functions.push(Object.freeze({
      name: func.name,
      kind: func.kind,
      maxStack: func.maxStack ?? 0,
      blocks: cfg.blocks.length,
      edges: cfg.edges.length,
      unreachable: cfg.unreachable.length,
      loops: cfg.loopEdges.length,
    }));
  }
  const requirements = module.requirements ?? [];
  const security = analyzeSecurity(module);
  for (const warning of security) warnings.push(warning);

  const declared = module.declaredRequirements ?? null;
  const actual = requirements.map((item) => item.key);
  const underReported = declared ? actual.filter((key) => !declared.includes(key)) : [];

  const analysis = Object.freeze({
    abi: ABI_VERSION,
    version: module.version,
    app: module.app,
    mode,
    passes: Object.freeze(VERIFIER_PASSES.map((pass) => pass.name)),
    functions: Object.freeze(functions),
    warnings: Object.freeze(warnings),
    errors: Object.freeze(errors),
    requirements: Object.freeze(actual),
    declaredRequirements: Object.freeze(declared ?? []),
    underReported: Object.freeze(underReported),
    capabilityPaths: Object.freeze(capabilityPathsOf(requirements)),
    determinism: analyzeDeterminism(module, requirements),
    security,
    stats: Object.freeze({
      functions: module.functions.length,
      actions: module.actions.length,
      declarations: module.declarations.length,
      pool: module.pool.length,
      globals: module.globalRefs.length,
      instructions: module.functions.reduce((sum, func) => sum + func.code.length, 0),
    }),
  });
  return analysis;
}

/**
 * 结构化验证报告：供工具链（IDE / CI / 检查器）消费，永不抛异常。
 * `mode: "strict"` 时 advisory 警告升级为失败。
 */
export function verifyReport(module, sourceName = "<jbc>", options = {}) {
  const mode = options.mode ?? "normal";
  const report = {
    ok: false,
    moduleName: sourceName,
    abi: ABI_VERSION,
    bytecodeVersion: module?.version ?? 0,
    mode,
    passes: [],
    warnings: [],
    errors: [],
    analysis: null,
  };
  try {
    if (module?.verified && moduleAnalysis(module)) {
      report.ok = true; // 已验证过的冻结模块：直接复用分析结果，不再重跑
    } else {
      verifyModule(module, sourceName, { mode });
      report.ok = true;
    }
  } catch (error) {
    report.errors.push(String(error?.message ?? error));
  }
  const analysis = moduleAnalysis(module) ?? analyzeModule(module ?? {}, { mode });
  report.analysis = analysis;
  report.warnings = [...analysis.warnings];
  if (analysis.errors.length) report.errors.push(...analysis.errors);
  if (report.errors.length) report.ok = false;
  report.passes = VERIFIER_PASSES.map((pass) => Object.freeze({
    id: pass.id,
    name: pass.name,
    label: pass.label,
    ok: !report.errors.some((message) => message.includes(pass.name)),
  }));
  return Object.freeze(report);
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
  const capabilities = module.capabilityPaths ?? moduleAnalysis(module)?.capabilityPaths ?? [];
  if (capabilities.length) {
    lines.push("");
    lines.push(".capabilities");
    for (const path of capabilities) lines.push(`  ${path}`);
  }
  if (module.resourceManifest && Object.keys(module.resourceManifest).length) {
    lines.push("");
    lines.push(".resources");
    for (const [kind, amount] of Object.entries(module.resourceManifest)) lines.push(`  ${kind} <= ${amount}`);
  }
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

  // 0.6.1：属性面写操作统一走 DOM 事务（未开启时直写，语义与 0.6 一致）。
  if (value == null || value === false) {
    domRemoveAttribute(runtime, element, name);
    if (["value", "checked", "selected", "disabled"].includes(name) && name in element) {
      domWriteProperty(runtime, element, name, name === "value" ? "" : false);
    }
    return;
  }
  domWriteAttribute(runtime, element, name, value);
  if (["value", "checked", "selected"].includes(name) && name in element) domWriteProperty(runtime, element, name, value);
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
  const nodes = runtime.metrics.nodes + 1;
  const limit = runtime.resources?.limitOf("dom") || runtime.policy?.maxDomNodes || 0;
  if (limit > 0 && nodes > limit) {
    throw new JLCQuotaError(`受管 DOM 节点数 ${nodes} 超过配额 maxDomNodes=${limit}（实例被拒绝继续创建节点）`);
  }
  // 0.6.1：soft 限额走资源内核统一记账（越过 80% 发警告；hard 由上面的检查兜底）。
  runtime.resources?.reserve("dom");
  runtime.ownedNodes.set(node, scope);
  runtime.metrics.nodes = nodes;
  // 0.6.1 Profile 2.0：DOM 生命周期记账（create / remove）。
  runtime.dom?.noteCreate(1);
  scope.own(() => {
    runtime.ownedNodes?.delete(node);
    if (runtime.metrics) runtime.metrics.nodes -= 1;
    runtime.dom?.noteRemove(1);
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
/** 协作式调度的预算检查粒度：每 N 条指令查一次预算/截止时间（关闭时零开销）。 */
const SLICE_CHECK_INTERVAL = 512;
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
    // ---- 0.6 协作式调度状态 ----
    this.dispatchDepth = 0;     // 当前 JS 调用链上有几层 dispatch（1 = 最外层）
    this.sliceableTask = null;  // 允许被切片的任务：只有它才能触发协作式让出
    this.suspended = null;      // 挂起现场（frames / stack / context / render / ip）
    this.entryFrame = null;
    this.baseFrames = 0;
    // ---- 0.6.1 Hot Path Cache：全局查找 / 函数元数据固化（链接后不变） ----
    this.hotCache = new HotPathCache(module);
  }

  /** 进入可切片窗口（由 Runtime.perform 驱动）：窗口内最外层 dispatch 可以让出。 */
  beginSlice(task) {
    const previous = this.sliceableTask;
    this.sliceableTask = task ?? null;
    return previous;
  }

  endSlice(previous) {
    this.sliceableTask = previous ?? null;
  }

  /** 最外层 dispatch 的入口记账：续跑要原样恢复这些字段。 */
  sliceAllowed() {
    return Boolean(this.sliceableTask) && this.dispatchDepth === 0;
  }

  /**
   * 协作式让出：保存 VM 现场 → 抛出控制流信号 → 由调度器在后续任务里续跑。
   * 只有在「最外层 dispatch + 可切片任务」时才允许；否则升级为预算错误，
   * 交给故障阶梯（restart / rollback / stop），绝不静默丢状态。
   */
  suspend(reason, info = {}, resumable = false) {
    const task = this.sliceableTask;
    if (!resumable) {
      throw new JLCBudgetError(
        `不可续跑的执行路径超出 ${reason === "deadline" ? "时间" : "指令"}预算（${task?.label ?? "host call"}），已交给故障阶梯`,
        { kind: task?.kind ?? null, steps: info.spent ?? 0, budget: info.budget ?? 0 },
      );
    }
    this.suspended = {
      reason,
      frames: this.frames,
      stack: this.stack,
      context: this.context,
      render: this.render,
      actionDepth: this.actionDepth,
      entryFrame: this.entryFrame,
      baseFrames: this.baseFrames,
      sliceableTask: task,
      spent: info.spent ?? 0,
      budget: info.budget ?? 0,
      deadline: info.deadline ?? 0,
      label: task?.label ?? null,
      kind: task?.kind ?? "task",
      at: Date.now(),
    };
    throw new JLCYieldSignal({ reason, kind: task?.kind ?? "task", label: task?.label ?? null, spent: info.spent ?? 0, budget: info.budget ?? 0, deadline: info.deadline ?? 0 });
  }

  /** 恢复挂起现场并继续执行到返回（可能再次挂起）。 */
  resumeSuspended() {
    const state = this.suspended;
    if (!state) throw new JLCRuntimeError("VM 没有可恢复的挂起现场");
    this.suspended = null;
    this.context = state.context;
    this.render = state.render;
    this.actionDepth = state.actionDepth;
    const previous = this.beginSlice(state.sliceableTask);
    try {
      return this.dispatch(state.entryFrame, { resume: true, baseFrames: state.baseFrames });
    } finally {
      this.endSlice(previous);
    }
  }

  link(bindings, links) {
    this.bindings = bindings;
    this.links = links;
    // 链接完成后全局表不再增删：name → binding 可以固化为 slot 直达。
    this.hotCache.invalidate();
  }

  /** 0.6.1 Global Lookup Cache：ref → binding 一级直达（miss 才回源）。 */
  bindingAt(ref) {
    const cached = this.hotCache.global(ref);
    if (cached) return cached;
    return this.hotCache.putGlobal(ref, this.bindings[this.links[ref]]);
  }

  /** 0.6.1 Hot Function Cache：funcIndex → 函数元数据直达。 */
  functionAt(funcIndex) {
    const cached = this.hotCache.func(funcIndex);
    if (cached) return cached;
    return this.hotCache.putFunc(funcIndex, this.functions[funcIndex]);
  }

  /** 入口：执行一个函数直到它返回（可重入）。 */
  runFunction(funcIndex, parent, scope, options = {}) {
    const func = this.functionAt(funcIndex);
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
      // 挂起时保留现场：frames / stack / context 由续跑任务接手，不能被截断。
      if (!this.suspended) {
        this.frames.length = framesLength;
        this.stack.length = stackLength;
        this.context = previousContext;
        this.actionDepth = previousDepth;
      }
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
      if (!this.suspended) {
        this.render = savedRender;
        this.context = savedContext;
        this.actionDepth = savedDepth;
      }
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
      if (!this.suspended) {
        this.frames.length = framesLength;
        this.stack.length = stackLength;
        this.context = savedContext;
        this.actionDepth = savedDepth;
      }
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
    runtime.resources?.reserve("timers");
    runtime.metrics.timers += 1;
    const chain = this.snapshotChain();
    const task = {
      mode,
      delay,
      nextRun: Date.now() + delay,
      funcIndex,
      chain,
      scope,
      active: true,
      release: null,
    };
    const cleanup = () => {
      if (!task.active) return;
      task.active = false;
      runtime.removeTimer(task);
      runtime.metrics.timers -= 1;
    };
    task.release = scope.own(cleanup);
    runtime.scheduleTimer(task);
  }

  dispatch(entryFrame, options = {}) {
    const stack = this.stack;
    const frames = this.frames;
    const baseFrames = options.baseFrames ?? frames.length;
    const context = this.context;
    const maxSteps = context.runtime.options.maxSteps;
    const maxTotalSteps = context.runtime.options.maxTotalSteps ?? 0;
    const metrics = context.runtime.metrics;
    const steps = context;
    this.dispatchDepth += 1;
    const outermost = this.dispatchDepth === 1;
    if (outermost) {
      this.entryFrame = entryFrame;
      this.baseFrames = baseFrames;
    }
    // 0.6 协作式切片：只有「最外层 dispatch + 可切片任务」才允许让出。
    const sliceTask = outermost && this.sliceableTask ? this.sliceableTask : null;
    const sliceBudget = sliceTask ? Math.max(0, Number(sliceTask.budget) || 0) : 0;
    const sliceDeadline = sliceTask ? Math.max(0, Number(sliceTask.deadline) || 0) : 0;
    const sliceEnabled = sliceBudget > 0 || sliceDeadline > 0;
    const profiling = context.runtime.profiling;
    let sliceSpent = 0;
    let sliceCountdown = SLICE_CHECK_INTERVAL;
    if (!options.resume) entryFrame.ip = 0;

    try {
    outer: while (true) {
      const frame = frames[frames.length - 1];
      const code = frame.func.code;
      let ip = frame.ip;

      try {
        while (true) {
          if (sliceEnabled && --sliceCountdown <= 0) {
            sliceCountdown = SLICE_CHECK_INTERVAL;
            sliceSpent += SLICE_CHECK_INTERVAL;
            if ((sliceBudget > 0 && sliceSpent >= sliceBudget) || (sliceDeadline > 0 && Date.now() >= sliceDeadline)) {
              frame.ip = ip;
              this.suspend(sliceBudget > 0 && sliceSpent >= sliceBudget ? "budget" : "deadline", {
                spent: sliceSpent, budget: sliceBudget, deadline: sliceDeadline,
              }, sliceTask !== null);
            }
          }
          const opcode = code[ip];
          if (profiling) context.runtime.bumpProfile(frame.func.name);
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
              const binding = this.bindingAt((code[ip] << 8) | code[ip + 1]);
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
              const binding = this.bindingAt(ref);
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
              const binding = this.bindingAt(ref);
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
    } finally {
      this.dispatchDepth -= 1;
    }
  }
}

/* ================================================================
 * 0.6.1 DOM Transaction Kernel 写路径
 *
 * 所有「属性面」写操作（text / attribute / class / style / property）
 * 统一走这里：开启事务时先进 Mutation Buffer（批内 coalescing），帧末
 * 一次提交；未开启时保持 0.6 的直写语义。结构面（insert/move/remove）
 * 即时落盘——兄弟链是锚点语义，不能缓冲——但照样记账。
 * ================================================================ */

function domWriteText(runtime, node, value) {
  if (runtime?.dom?.enabled && !runtime.destroyed) { runtime.dom.setText(node, value); return; }
  node.data = value;
}

function domWriteAttribute(runtime, element, name, value) {
  if (runtime?.dom?.enabled && !runtime.destroyed) { runtime.dom.setAttribute(element, name, value); return; }
  if (value === true) element.setAttribute(name, "");
  else element.setAttribute(name, String(value));
}

function domRemoveAttribute(runtime, element, name) {
  if (runtime?.dom?.enabled && !runtime.destroyed) { runtime.dom.removeAttribute(element, name); return; }
  element.removeAttribute(name);
}

function domWriteProperty(runtime, element, property, value) {
  if (runtime?.dom?.enabled && !runtime.destroyed) { runtime.dom.setProperty(element, property, value); return; }
  element[property] = value;
}

function domToggleClass(runtime, element, name, force) {
  if (runtime?.dom?.enabled && !runtime.destroyed) { runtime.dom.toggleClass(element, name, force); return; }
  element.classList.toggle(name, Boolean(force));
}

function domWriteStyle(runtime, element, property, value) {
  if (runtime?.dom?.enabled && !runtime.destroyed) {
    if (value == null) runtime.dom.removeStyleProperty(element, property);
    else runtime.dom.setStyleProperty(element, property, value);
    return;
  }
  if (value == null) element.style.removeProperty(property);
  else element.style.setProperty(property, String(value));
}

function domWriteCssText(runtime, element, text) {
  if (runtime?.dom?.enabled && !runtime.destroyed) { runtime.dom.setCssText(element, text); return; }
  element.style.cssText = text;
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
      // 0.6.1：text 写走 DOM 事务（同一帧内重复写只落最后一次）。
      domWriteText(runtime, text, toText(machine.runFunction(funcIndex, frame, textScope)));
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
    const runtime = machine.runtime;
    runtime.effect(scope, () => domToggleClass(runtime, element, className, Boolean(machine.runFunction(funcIndex, frame, scope))), 2);
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
    const runtime = machine.runtime;
    runtime.effect(scope, () => {
      const value = machine.runFunction(funcIndex, frame, scope);
      domWriteStyle(runtime, element, property, value == null || value === false ? null : String(value));
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
      domWriteProperty(runtime, element, property, value);
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
    const runtime = machine.runtime;
    let previous = new Set();
    runtime.effect(scope, () => {
      const value = machine.runFunction(funcIndex, frame, scope);
      if (ownData(value) && !Array.isArray(value)) {
        const next = new Set();
        for (const [property, child] of Object.entries(value)) {
          next.add(property);
          domWriteStyle(runtime, element, property, child == null || child === false ? null : String(child));
        }
        for (const property of previous) if (!next.has(property)) domWriteStyle(runtime, element, property, null);
        previous = next;
      } else {
        for (const property of previous) domWriteStyle(runtime, element, property, null);
        previous.clear();
        domWriteCssText(runtime, element, value == null ? "" : String(value));
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
      const eventRuntime = machine.runtime;
      eventRuntime.activity += 1; // 泄漏探测：用户输入 = 活动信号
      const eventContext = eventRuntime.context(scope);
      try {
        // 0.6：事件处理器跑在 INPUT 通道上——用户输入永远抢在后台计算前面。
        eventRuntime.perform({
          kind: "input",
          label: `event:${type}`,
          priority: PRIORITY.INPUT,
          sliceable: eventRuntime.options.maxSliceSteps > 0,
          run: () => eventRuntime.batch(() => {
            const result = machine.runFunction(funcIndex, eventFrame, scope);
            if (result?.[CALLABLE]) result.invoke([], eventContext);
          }),
        });
      } catch (error) {
        if (isYieldSignal(error)) throw error;
        eventRuntime.handleFault(error, { phase: "event", scope });
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
    let forceRebuild = false;
    const branchEffect = runtime.effect(controlScope, () => {
      const next = Boolean(machine.runFunction(testFunc, frame, controlScope));
      if (next === current && !forceRebuild) return;
      forceRebuild = false;
      branchScope?.dispose();
      clearBetween(start, end);
      branchScope = controlScope.child(next ? "when:yes" : "when:no");
      machine.runView(next ? yesFunc : noFunc, parent, end, branchScope, frame, namespace);
      current = next;
    });
    // 组件级重启（fault: "restart"）：销毁出错分支并原地重建。
    // 注意：重启请求是在出错组件内部发出的，外层 JS 还会继续往下跑
    // （比如把 current 写回旧值），所以重建必须用令牌而不是状态比较。
    const rebuildBranch = () => {
      forceRebuild = true;
      branchScope?.dispose();
      branchScope = null;
      clearBetween(start, end);
      branchEffect.schedule();
    };
    controlScope.replay = rebuildBranch;
    branchScope.replay = rebuildBranch;
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

    const eachEffect = runtime.effect(controlScope, () => {
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

      // 0.6.1：大列表分片渲染。每处理 chunk 项检查一次时间预算；超了就保存
      // 游标、让出一帧，下一轮重入时已建记录原样复用（幂等），只继续建剩下的。
      const slicing = runtime.renderSlicing();
      const deadline = slicing ? Date.now() + Math.max(1, runtime.options.frameBudgetMs || 6) : 0;
      let chunkLeft = slicing || 0;
      const nextRecords = new Map();
      // 0.6.1 Keyed Node Cache：key 再次出现 → 直接复用（scope/DOM/binding 全在），
      // 10000 items 改 1 item 时，其余 9999 项全部命中复用，不重建。
      const cache = runtime.nodeCache;
      const cacheOwner = cache ? controlScope : null;
      for (let index = 0; index < values.length; index += 1) {
        const key = keys[index];
        let record = records.get(key);
        if (record) {
          record.item.set(values[index], true);
          record.index?.set(index, true);
          cache?.hit(cacheOwner, key);
        } else {
          cache?.miss(cacheOwner, key);
          const recordScope = controlScope.child(`each:${toText(key)}`);
          const item = new Signal(runtime, values[index], false, itemName);
          const indexSignal = hasIndex ? new Signal(runtime, index, false, "index") : null;
          const bodyPreset = new Array(machine.functionAt(bodyFunc).nSlots).fill(null);
          bodyPreset[0] = item;
          if (hasIndex) bodyPreset[1] = indexSignal;
          const recordStart = runtime.document.createComment("jlc:item");
          const recordEnd = runtime.document.createComment("/jlc:item");
          insertInto(runtime, parent, recordStart, end);
          insertInto(runtime, parent, recordEnd, end);
          machine.runView(bodyFunc, parent, recordEnd, recordScope, frame, namespace, { preset: bodyPreset });
          record = { scope: recordScope, item, index: indexSignal, start: recordStart, end: recordEnd };
          // 立刻并入 live map：分片让出后重入时这些记录会被原样复用，
          // 否则每一片都会把前面的项再建一遍（重复节点）。
          records.set(key, record);
        }
        nextRecords.set(key, record);
        if (slicing && --chunkLeft <= 0) {
          chunkLeft = slicing;
          if (Date.now() >= deadline) {
            // 让出一帧：渲染续跑任务会在下一次调度里重新进入本 effect。
            runtime.scheduleRender("each:continue", () => eachEffect.schedule());
            return;
          }
        }
      }

      for (const [key, record] of records) {
        if (!nextRecords.has(key)) {
          cache?.release(cacheOwner, key);
          record.scope.dispose();
          record.item.detach();
          record.index?.detach();
          removeInclusive(record.start, record.end);
          runtime.dom?.noteRemove(2);
        }
      }
      records = nextRecords;

      // Diff Engine 2：只搬需要搬的。moveInclusive 对「已在目标位置」的区段
      // 直接短路，因此有序列表的原位更新是零搬运。
      let anchor = end;
      const ordered = [...records.values()];
      for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const record = ordered[index];
        if (record.end.nextSibling !== anchor) {
          moveInclusive(parent, record.start, record.end, anchor);
          runtime.dom?.noteMove(1);
        }
        anchor = record.start;
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
    // 组件级重启（fault: "restart"）：把列表项全部作废并原地重建。
    // 单项崩溃时 runtime.restartScope 只销毁那一项的 scope，然后让 owner 重放。
    const rebuildItems = () => {
      runtime.nodeCache?.releaseOwner(controlScope);
      for (const record of records.values()) {
        record.scope.dispose();
        record.item.detach();
        record.index?.detach();
        removeInclusive(record.start, record.end);
      }
      records = new Map();
      if (emptyRecord) {
        emptyRecord.scope.dispose();
        removeInclusive(emptyRecord.start, emptyRecord.end);
        emptyRecord = null;
      }
      eachEffect.schedule();
    };
    controlScope.replay = rebuildItems;
    for (const record of records.values()) record.scope.replay = () => rebuildItems();
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
    if (!Object.is(element[property], normalized)) domWriteProperty(runtime, element, property, normalized);
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

/* ================================================================
 * 0.6.1 宿主运行档（Runtime Presets）
 *
 * runtime: "full" 不是安全绕过——权限 / 能力 / 资源 / 隔离一项不少——
 * 而是把 0.6 建立的接管能力全部变成默认开启的执行形态：
 * 调度公平、帧预算、DOM 事务、响应式批、依赖图、增量检查点、
 * 内存分户、泄漏探测、网络调度、故障自动升级、取消内核。
 * 显式 options 永远覆盖预设（预设只是默认值）。
 * ================================================================ */

export const RUNTIME_PRESETS = Object.freeze({
  legacy: Object.freeze({}),
  full: Object.freeze({
    maxSliceSteps: 20_000,
    frameBudgetMs: 6,
    renderChunk: 64,
    sliceCheckInterval: 512,
    checkpointLimit: 8,
    fault: "restart",
    isolation: "strict",
    domTransaction: true,
    dependencyGraph: true,
    checkpointDelta: true,
    memoryAccounting: true,
    leakDetector: true,
    networkScheduling: true,
    faultEscalation: true,
    scheduler: Object.freeze({ maxConsecutiveSlices: 3, agingMs: 32, starvationMs: 96 }),
    resources: Object.freeze({ workers: 4, checkpoints: 8 }),
  }),
});

/** 解析 runtime 档：未知档位报错（静默忽略会把配置错误变成性能玄学）。 */
export function resolveRuntimePreset(name) {
  if (name == null || name === false) return RUNTIME_PRESETS.legacy;
  const preset = RUNTIME_PRESETS[name];
  if (!preset) throw new JLCRuntimeError(`未知 runtime 档“${name}”：可用 ${Object.keys(RUNTIME_PRESETS).join(" / ")}`);
  return preset;
}

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

  // 1. 字符串/数组索引查找：indexOf(haystack, needle)
  add("indexOf", ([haystack, needle]) => {
    if (typeof haystack === "string" || Array.isArray(haystack)) {
      return haystack.indexOf(needle);
    }
    return -1;
  });

  // 2. 原生剪贴板接管：copy(text)
  add("copy", ([value]) => {
    const text = String(value ?? "");
    try {
      if (runtime.window?.navigator?.clipboard) {
        runtime.window.navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    return false;
  });

  // 3. 页面视口平滑滚动：scrollTo(x, y)
  add("scrollTo", ([x, y]) => {
    try {
      runtime.window?.scrollTo?.({
        left: Number(x ?? 0),
        top: Number(y ?? 0),
        behavior: "smooth"
      });
    } catch {
      if (runtime.window) runtime.window.scrollX = Number(x ?? 0);
    }
    return null;
  });

  // 4. 虚拟持久化存储：storage(key, value?) —— 单参数读，双参数写
  add("storage", ([key, val]) => {
    const k = "jlc_store_" + String(key ?? "");
    try {
      const ls = runtime.window?.localStorage ?? globalThis.localStorage;
      if (!ls) return null;
      if (val === undefined) {
        const data = ls.getItem(k);
        return data ? JSON.parse(data) : null;
      } else {
        ls.setItem(k, JSON.stringify(sanitizeValue(val)));
        return val;
      }
    } catch {
      return null;
    }
  });

  return builtins;
}

class Runtime {
  constructor(kernel, target, rawOptions, contextOptions = {}) {
    this.kernel = kernel;
    this.target = target;
    this.document = target.ownerDocument ?? globalThis.document;
    this.window = this.document?.defaultView ?? globalThis.window;
    // 0.6.1：runtime 档只补默认值——宿主显式写的每一项都优先。
    const preset = resolveRuntimePreset(rawOptions.runtime ?? kernel.options.runtime);
    this.runtimePreset = rawOptions.runtime ?? null;
    const options = { ...preset, ...rawOptions };
    this.options = {
      maxSteps: options.maxSteps ?? kernel.options.maxSteps,
      maxLoop: options.maxLoop ?? kernel.options.maxLoop,
      autoDispose: options.autoDispose ?? kernel.options.autoDispose,
      maxTotalSteps: options.maxTotalSteps ?? kernel.options.maxTotalSteps ?? 0,
      // ---- 0.6 协作式调度（0 = 关闭，与 0.4 行为完全一致）----
      maxSliceSteps: Math.max(0, Math.floor(Number(options.maxSliceSteps ?? kernel.options.maxSliceSteps ?? 0) || 0)),
      frameBudgetMs: Math.max(0, Number(options.frameBudgetMs ?? kernel.options.frameBudgetMs ?? 0) || 0),
      sliceHostCalls: options.sliceHostCalls ?? kernel.options.sliceHostCalls ?? true,
      renderChunk: Math.max(0, Math.floor(Number(options.renderChunk ?? kernel.options.renderChunk ?? 128) || 0)),
      sliceCheckInterval: Math.max(64, Math.floor(Number(options.sliceCheckInterval ?? kernel.options.sliceCheckInterval ?? 512) || 512)),
      // ---- 0.6.1 网络调度：resource 请求经 P5 NETWORK 车道进调度器 ----
      networkScheduling: Boolean(options.networkScheduling ?? kernel.options.networkScheduling ?? false),
      networkTimeoutMs: Math.max(0, Math.floor(Number(options.networkTimeoutMs ?? kernel.options.networkTimeoutMs ?? 0) || 0)),
      networkRetries: Math.max(0, Math.floor(Number(options.networkRetries ?? kernel.options.networkRetries ?? 0) || 0)),
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
    // ---- 0.6 故障阶梯：旧档名（report / degrade / stop）自动升级为六级 ----
    this.faultMode = normalizeFaultLevel(options.fault ?? kernel.options.fault ?? "recover", "recover");
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
    // ---- 0.6.1 Performance Kernel 子系统（按依赖顺序实例化） ----
    this.activity = 0; // 用户侧动作计数（事件 / set / call），泄漏探测的「忙碌信号」
    this.effectRegistry = options.dependencyGraph !== false ? new Set() : null;
    this.cancellation = new CancellationRegistry();
    this.frameBudget = new FrameBudgetManager({ frameBudgetMs: options.frameBudgetMs ?? 0 });
    const schedulerOptions = options.scheduler && typeof options.scheduler === "object" ? options.scheduler : {};
    const laneQuotas = schedulerOptions.laneQuotas ?? schedulerOptions.quotas ?? null;
    this.options.schedulerGovernor = new LaneGovernor({
      quotas: laneQuotas,
      defaultQuota: schedulerOptions.maxConsecutiveSlices ?? 8,
      agingMs: schedulerOptions.agingMs ?? 32,
      maxAgingSteps: schedulerOptions.maxAgingSteps ?? 2,
      starvationMs: schedulerOptions.starvationMs ?? 96,
    });
    this.dom = new DomTransaction({ enabled: Boolean(options.domTransaction ?? preset.domTransaction ?? false) });
    this.nodeCache = new KeyedNodeCache({ maxSize: options.nodeCacheSize ?? 8192 });
    this.memoryAccountant = options.memoryAccounting ? new MemoryAccountant({ limit: options.memoryLimitKB ?? 0 }) : null;
    this.leakDetector = options.leakDetector
      ? new LeakDetector({
          intervalMs: typeof options.leakDetector === "object" ? options.leakDetector.intervalMs ?? 10_000 : 10_000,
          threshold: typeof options.leakDetector === "object" ? options.leakDetector.threshold ?? 64 : 64,
          onWarn: (info) => {
            this.counters && (this.counters.leakWarnings += 1);
            this.onWarn?.(info);
          },
        })
      : null;
    this.faultEscalation = options.faultEscalation ?? preset.faultEscalation ?? true;
    this.scheduler = new Scheduler(this);
    // ---- 0.6 内核子系统实例 ----
    const policyGrants = this.policy.capabilities ?? null;
    const mountGrants = options.grants ?? null;
    this.permissions = new PermissionKernel({
      grants: { ...(policyGrants ?? {}), ...(mountGrants ?? {}) },
      aliases: options.capabilityPaths ?? null,
      strict: Boolean(options.permissionStrict ?? this.policy.permissionStrict ?? false),
      audit: typeof this.policy.audit === "function" ? (event) => notePolicy(this, { action: "capability", ...event }) : null,
      now: options.now ?? null,
    });
    // 0.6.1：宿主显式写的 resources.dom（含 soft/hard 对象）优先于策略档的
    // maxDomNodes 默认值；未显式配置时仍按 0.6 语义从策略同步。
    const explicitResources = options.resources ?? null;
    this.resources = new ResourceKernel(this, {
      ...(this.policy.resources ?? null),
      ...(explicitResources ?? null),
      ...(this.policy.maxDomNodes && !explicitResources?.dom ? { dom: this.policy.maxDomNodes } : null),
    });
    this.checkpoints = new CheckpointStore(this, {
      limit: options.checkpointLimit ?? kernel.options.checkpointLimit ?? 8,
      // 0.6.1 Checkpoint 2.0：delta 快照（结构共享），不再每次整份复制 state。
      delta: Boolean(options.checkpointDelta ?? preset.checkpointDelta ?? false),
    });
    // ---- 0.6 诊断：默认零开销，只有 debug / profile 打开时才逐指令记账 ----
    this.profiling = Boolean(options.profile ?? options.debug ?? kernel.options.profile ?? kernel.options.debug ?? false);
    this.profileFunctions = new Map();
    this.domMutations = 0;
    this.onWarn = options.onWarn ?? kernel.options.onWarn ?? null;
    // 0.6.1 计数器扩展（旧字段一个不少，新增公平 / 事务 / 缓存 / 取消等维度）。
    this.counters = {
      tasks: 0, yields: 0, budgets: 0, renderSlices: 0, restarts: 0, rollbacks: 0, faults: 0,
      warnings: 0, cancels: 0, escalations: 0, effectDeduped: 0, transactions: 0,
      leakWarnings: 0, networkScheduled: 0,
    };
    this.capabilityPaths = Object.freeze({ ...(options.capabilityPaths ?? null) });
    // 【0.4.1 统一 Tick Wheel 调度】收归 every / after 独立闭包，合并微任务派发，杜绝高频掉帧
    this.timerTasks = new Set();
    this.activeTickHandle = null;
    this.scheduledTickTime = 0;
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
    if (this.batchDepth === 1) {
      // Reactive Batch 2.0：一批 state 变更 = 一个事务号 → 一次推导 → 一次渲染。
      this.counters.transactions += 1;
      this.scheduler.transactionSerial += 1;
    }
    try {
      return callback();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0) {
        this.commitDom(); // 批内同步写（如首屏）在这里兜底提交
        if (this.scheduler.queue.size && !this.scheduler.pending) {
          this.scheduler.pending = true;
          queueMicrotask(() => {
            if (!this.scheduler) return;
            this.scheduler.pending = false;
            this.scheduler.flush();
          });
        }
      }
    }
  }

  /** 0.6.1 DOM Transaction：统一提交点（perform / flush / batch 结束）。 */
  commitDom() {
    if (this.dom?.hasPending && !this.destroyed) this.dom.commit();
  }

  /** 纯通知通道：onError → 宿主；不参与故障决策（0.4 语义保留）。 */
  reportError(error) {
    const normalized = error instanceof Error ? error : new JLCRuntimeError(String(error));
    if (isYieldSignal(normalized)) throw normalized;
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

  /** onFault 通道：只报决策，不做动作。 */
  notifyFault(error, level = this.faultMode) {
    if (!this.onFault) return false;
    try {
      this.onFault(error, {
        code: error.code ?? "E_FAULT",
        mode: level,
        resource: error.resource ?? null,
        task: null,
      });
      return true;
    } catch (faultError) {
      console.error("JLC onFault failed", faultError);
      return false;
    }
  }

  /**
   * 0.6 故障阶梯的唯一出口：ignore → degrade → recover → restart → rollback → stop。
   * 内核不变量违规（隔离 / 校验 / 不可续跑预算）永远 stop，不受 fault 档影响。
   */
  faultLevelFor(error, context = {}) {
    const requested = normalizeFaultLevel(error?.faultLevel ?? this.faultMode, this.faultMode);
    if (error instanceof JLCVerifyError || error instanceof JLCIsolationError) return "stop";
    if (error?.code === "E_BUDGET") return requested === "stop" ? "stop" : (requested === "ignore" ? "ignore" : "recover");
    if (error?.isPolicyError) return requested;
    if (requested === "rollback" && this.checkpoints?.list().length) return "rollback";
    if (requested === "restart" && context.scope) return "restart";
    return requested;
  }

  /** 单级故障动作：成功返回 true，失败（如连续重启超限 / 无检查点）返回 false。 */
  applyFaultLevel(level, normalized, context) {
    switch (level) {
      case "ignore":
        return true;
      case "stop":
        this.notifyFault(normalized, level);
        this.unmountSelf?.();
        return true;
      case "rollback": {
        const entry = this.rollback();
        if (entry) {
          this.counters.rollbacks += 1;
          this.notifyFault(normalized, level);
          return true;
        }
        return false;
      }
      case "restart": {
        if (context.scope && this.restartScope(context.scope)) {
          this.counters.restarts += 1;
          this.notifyFault(normalized, level);
          return true;
        }
        return false;
      }
      case "degrade":
        this.notifyFault(normalized, level);
        return true;
      default: { // recover
        if (normalized.isPolicyError && this.notifyFault(normalized, level)) return true;
        this.reportError(normalized);
        return true;
      }
    }
  }

  /**
   * 0.6 故障阶梯 + 0.6.1 自动升级：
   * restart 连炸 3 次 → rollback → 仍失败 → degrade；内核不变量违规直接 stop。
   * `faultEscalation: false` 可以退回 0.6 的单级语义。
   */
  handleFault(error, context = {}) {
    const normalized = error instanceof Error ? error : new JLCRuntimeError(String(error));
    if (isYieldSignal(normalized)) throw normalized;
    let level = this.faultLevelFor(normalized, context);
    this.counters.faults += 1;
    if (normalized.isPolicyError || level === "stop") this.metrics.faults += 1;
    let attempts = 0;
    while (true) {
      if (this.applyFaultLevel(level, normalized, context)) return level;
      const next = this.faultEscalation ? FAULT_ESCALATION[level] : null;
      if (!next || attempts++ >= 4) {
        // 升级链用尽：按 0.6 语义上报，结局仍然可观察。
        if (normalized.isPolicyError && this.notifyFault(normalized, level)) return level;
        this.reportError(normalized);
        return level;
      }
      this.counters.escalations += 1;
      level = next;
    }
  }

  /** 组件级重启：销毁出错作用域并重放它的视图（错误边界的最小实现）。 */
  restartScope(scope, options = {}) {
    const maxRestarts = Math.max(1, Number(options.maxRestarts ?? 3) || 3);
    let owner = null;
    for (let current = scope; current; current = current.parent) {
      if (typeof current.replay === "function" && !current.disposed) {
        owner = current;
        break;
      }
    }
    if (!owner) return false; // 没有重放钩子：退回 recover，绝不半销毁
    owner.restarts = (owner.restarts ?? 0) + 1;
    if (owner.restarts > maxRestarts) {
      owner.restarts = 0;
      return false; // 反复重启仍失败：交给故障阶梯的下一级处理
    }
    if (scope && scope !== owner && !scope.disposed) scope.dispose(); // 只销毁出错的组件
    try {
      owner.replay();
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  /** 运行时检查点：state / derive / 权限 / 资源账本一起拍照。 */
  checkpoint(label, meta = null) {
    return this.checkpoints?.capture(label, meta) ?? null;
  }

  rollback(label) {
    const entry = label == null ? this.latestCheckpoint() : this.checkpoints?.restore(label);
    if (!entry) return null;
    this.counters.rollbacks += 1;
    // 回滚是宿主显式操作：同步跑干调度器，返回时视图已经和 state 一致。
    this.flush();
    return entry;
  }

  /** 同步跑干调度器（0.6：宿主可以直接要求「现在就把该做的做完」）。 */
  flush() {
    this.scheduler?.flush();
    return this;
  }

  /**
   * 渲染是否分片。开启条件与协作式调度一致（maxSliceSteps / frameBudgetMs），
   * 另可用 renderChunk 指定「一片至少处理多少项」，避免分片过碎把重入成本放大。
   */
  renderSlicing() {
    if (!this.options) return 0;
    if (!(this.options.maxSliceSteps > 0 || this.options.frameBudgetMs > 0)) return 0;
    return Math.max(1, Math.floor(this.options.renderChunk || 128));
  }

  /** 让出一次渲染机会：把剩余渲染排成下一帧的任务。 */
  scheduleRender(label, callback) {
    if (this.destroyed) return null;
    this.counters.renderSlices += 1;
    return this.scheduler.submit({
      kind: "render",
      label,
      priority: PRIORITY.RENDER,
      yieldToHost: true,
      run: () => callback(),
    });
  }

  latestCheckpoint() {
    const list = this.checkpoints?.list() ?? [];
    if (!list.length) return null;
    const last = list[list.length - 1];
    return this.checkpoints.restore(last.label);
  }

  /** 有界事务：一批 signal 变更合并成一次渲染提交。 */
  transaction(callback) {
    return this.batch(callback);
  }

  /** 逐指令热点统计（仅在 profiling 打开时被调用）。 */
  bumpProfile(name) {
    const entry = this.profileFunctions.get(name);
    if (entry) entry.count += 1;
    else this.profileFunctions.set(name, { name, count: 1 });
  }

  /**
   * 0.6 只读诊断视图 + 0.6.1 Profile 2.0 分区：
   * CPU / DOM / Scheduler / Yield / Memory / Effects / EACH / Network / Resource。
   * 旧字段（hot / counters / usage…）一个不少，新内容全部走 `sections`。
   */
  profile() {
    const total = [...this.profileFunctions.values()].reduce((sum, entry) => sum + entry.count, 0);
    const hot = [...this.profileFunctions.values()]
      .sort((left, right) => right.count - left.count)
      .slice(0, 12)
      .map((entry) => Object.freeze({
        function: entry.name,
        instructions: entry.count,
        share: total > 0 ? entry.count / total : 0,
      }));
    const counters = this.counters ?? {};
    const domStats = this.dom?.statsView() ?? null;
    const laneStats = this.scheduler?.laneStats?.() ?? null;
    const sections = Object.freeze({
      cpu: Object.freeze({ instructions: total, hot: Object.freeze(hot) }),
      dom: Object.freeze({
        create: domStats?.creates ?? 0,
        update: domStats?.applied ?? 0,
        remove: domStats?.removes ?? 0,
        move: domStats?.moves ?? 0,
        coalesced: domStats?.coalesced ?? 0,
        pending: domStats?.pending ?? 0,
        commits: domStats?.commits ?? 0,
        live: this.metrics.nodes,
      }),
      scheduler: Object.freeze({
        lanes: laneStats?.governor?.runs ?? Object.freeze({}),
        forcedYields: laneStats?.governor?.forcedYields ?? Object.freeze({}),
        agingBoosts: laneStats?.governor?.agingBoosts ?? 0,
        rescues: laneStats?.governor?.rescues ?? 0,
        frames: laneStats?.frameBudget?.frames ?? 0,
        tasks: counters.tasks ?? 0,
      }),
      yield: Object.freeze({
        renderSlices: counters.renderSlices ?? 0,
        vmYields: counters.yields ?? 0,
        budgets: counters.budgets ?? 0,
      }),
      memory: this.memory(),
      effects: Object.freeze({
        live: this.metrics.effects,
        deduped: counters.effectDeduped ?? 0,
        transactions: counters.transactions ?? 0,
        graph: this.effectRegistry ? Object.freeze({ nodes: this.effectRegistry.size }) : null,
      }),
      each: this.nodeCache?.stats() ?? Object.freeze({ size: 0, hits: 0, misses: 0, hitRate: 0 }),
      network: Object.freeze({
        live: this.metrics.requests,
        scheduled: counters.networkScheduled ?? 0,
      }),
      resource: this.resources?.usage() ?? Object.freeze({}),
      faults: Object.freeze({
        faults: counters.faults ?? 0,
        restarts: counters.restarts ?? 0,
        rollbacks: counters.rollbacks ?? 0,
        escalations: counters.escalations ?? 0,
        warnings: counters.warnings ?? 0,
        cancels: counters.cancels ?? 0,
      }),
      hotCache: this.machine?.hotCache?.statsView() ?? null,
      leaks: this.leakDetector ? this.leakDetector.report() : null,
    });
    return Object.freeze({
      app: this.module?.app ?? null,
      version: VERSION,
      runtime: this.runtimePreset,
      active: !this.destroyed,
      profiling: this.profiling,
      instructions: total,
      domMutations: this.domMutations,
      counters: Object.freeze({ ...counters }),
      usage: Object.freeze({ ...this.metrics }),
      resources: this.resources?.usage() ?? Object.freeze({}),
      hot: Object.freeze(hot),
      pending: this.scheduler?.pendingTasks?.() ?? Object.freeze([]),
      suspended: Boolean(this.machine?.suspended),
      checkpoints: this.checkpoints?.list() ?? Object.freeze([]),
      sections,
    });
  }

  /** VM 只读快照：把 state、权限、资源、任务、检查点打成一个对象。 */
  snapshot() {
    const state = Object.create(null);
    for (const [name, slot] of this.globals?.names ?? []) {
      const binding = this.globals.bindings[slot];
      if (binding?.kind === "signal") state[name] = sanitizeValue(binding.signal.value);
    }
    return Object.freeze({
      app: this.module?.app ?? null,
      scopeId: this.scopeId,
      state: Object.freeze(state),
      policy: this.describePolicy(),
      permissions: this.permissions?.list() ?? Object.freeze([]),
      resources: this.resources?.usage() ?? Object.freeze({}),
      checkpoints: this.checkpoints?.list() ?? Object.freeze([]),
      pendingTasks: this.scheduler?.pendingTasks?.() ?? Object.freeze([]),
      suspended: Boolean(this.machine?.suspended),
    });
  }

  makeDeferred() {
    let resolve = null;
    let reject = null;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return {
      promise,
      resolve,
      reject,
      settle(error, value) { if (error) reject(error); else resolve(value); },
    };
  }

  /**
   * 0.6 任务执行入口：同步执行，预算耗尽时可挂起并由调度器续跑。
   * `then` 承接内核 JS 的收尾步骤，因此续跑不会丢状态下文。
   */
  perform(task) {
    const definition = {
      kind: task.kind ?? "task",
      label: String(task.label ?? task.kind ?? "task"),
      priority: normalizePriority(task.priority ?? TASK_PRIORITY[task.kind] ?? PRIORITY.EFFECT),
      budget: Math.max(0, Number(task.budget ?? this.options.maxSliceSteps ?? 0) || 0),
      deadline: Math.max(0, Number(task.deadline ?? 0) || 0),
      sliceable: Boolean(task.sliceable),
      then: typeof task.then === "function" ? task.then : null,
      settle: task.deferred?.settle ?? null,
    };
    const machine = this.machine;
    const previousSlice = machine ? machine.beginSlice(definition.sliceable ? definition : null) : null;
    const previousCurrent = this.scheduler.current;
    this.scheduler.current = definition;
    try {
      const value = task.run(definition);
      if (definition.then) definition.then(value, null, definition);
      definition.settle?.(null, value);
      return value;
    } catch (error) {
      if (isYieldSignal(error)) {
        const continuation = this.scheduler.adoptSuspension(error, definition);
        return Object.freeze({ suspended: true, continuation, promise: task.deferred?.promise ?? null });
      }
      definition.settle?.(error, null);
      throw error;
    } finally {
      if (machine) machine.endSlice(previousSlice);
      this.scheduler.current = previousCurrent;
      // 0.6.1：每次任务窗口结束都提交 DOM 事务（挂起续跑时同样提交已写部分）。
      this.commitDom();
    }
  }

  /* ---- 0.6.1 宿主操作面：取消 / 内存 / 泄漏 / 依赖图 / VM 上下文 ---- */

  /** 取消任务：按 id / label / 谓词。调度器撤队列 + 令牌级联。 */
  cancelTask(query) {
    if (this.destroyed) return 0;
    const scheduled = this.scheduler?.cancelTask(query) ?? 0;
    const tokens = this.cancellation?.cancel(query, "host cancel") ?? 0;
    // 令牌里可能包含不在调度器队列里的单元（如挂起续跑链）
    if (tokens > 0 && this.machine?.suspended && !scheduled) {
      this.machine.suspended = null; // 续跑链已随令牌取消
    }
    return Math.max(scheduled, tokens);
  }

  /** scope 销毁级联：撤任务 + 撤令牌（定时器 / 监听器随 scope.own 已释放）。 */
  cancelScope(scope) {
    if (this.destroyed) return;
    this.scheduler?.cancelScope(scope);
    this.cancellation?.cancelScope(scope, "scope disposed");
    this.nodeCache?.releaseOwner(scope);
  }

  /** Memory Accountant 视图（分户账：state / checkpoint / task / cache…）。 */
  memory() {
    if (this.memoryAccountant && !this.destroyed) {
      // state 户按当前信号值实时折算；任务 / 缓存户按条目权重折算。
      let stateBytes = 0;
      for (const [name, slot] of this.globals?.names ?? []) {
        const binding = this.globals.bindings[slot];
        if (binding?.kind === "signal") stateBytes += 16 + name.length * 2 + estimateBytes(binding.signal.value);
      }
      this.memoryAccountant.setAccount("state", stateBytes);
      this.memoryAccountant.setAccount("tasks", (this.scheduler?.taskCount?.() ?? 0) * 256);
      this.memoryAccountant.setAccount("cache", (this.nodeCache?.size?.() ?? 0) * 96 + (this.machine?.hotCache ? 64 * this.machine.hotCache.globalSlots.length : 0));
    }
    const view = this.memoryAccountant?.usage() ?? Object.freeze({ totalBytes: 0, totalKB: 0, limitBytes: 0, accounts: Object.freeze({}) });
    return Object.freeze({
      ...view,
      checkpointsBytes: this.checkpoints?.bytes ?? 0,
      nodeCache: this.nodeCache?.stats() ?? null,
    });
  }

  /** 泄漏探测报告（样本 + 可疑项）。 */
  leaks() {
    if (!this.leakDetector) return Object.freeze({ enabled: false, suspected: Object.freeze([]), samples: Object.freeze([]) });
    return Object.freeze({ enabled: true, ...this.leakDetector.report() });
  }

  /** 给泄漏探测器采样用的当前计数快照。 */
  leakSnapshot() {
    return {
      scopes: this.metrics.scopes,
      effects: this.metrics.effects,
      listeners: this.metrics.listeners,
      timers: this.metrics.timers,
      requests: this.metrics.requests,
      tasks: this.scheduler?.taskCount?.() ?? 0,
      nodes: this.metrics.nodes,
      activity: this.activity,
    };
  }

  /** 0.6.1 Effect Dependency Graph：整图导出（只读）。 */
  dependencyGraph() {
    return describeDependencyGraph(this);
  }

  /** 改某个状态会牵动哪些 effect（沿派生状态传导的间接依赖也在内）。 */
  dependents(name) {
    return dependentsOf(this, name);
  }

  /**
   * 0.6.1 VM Execution Context：任何执行中的行为都能回答
   * 「我是谁、我在哪、我有什么权限、用了多少资源、属于哪个任务、出了错怎么恢复」。
   */
  vmContext() {
    return Object.freeze({
      module: Object.freeze({ app: this.module?.app ?? null, abi: ABI_VERSION, bytecodeVersion: this.module?.version ?? null }),
      machine: Object.freeze({
        frames: this.machine?.frames?.length ?? 0,
        stack: this.machine?.stack?.length ?? 0,
        suspended: Boolean(this.machine?.suspended),
        hotCache: this.machine?.hotCache?.statsView() ?? null,
      }),
      scope: Object.freeze({ label: this.rootScope?.label ?? null, scopes: this.metrics.scopes }),
      state: Object.freeze(this.stateNames()),
      permissions: Object.freeze({
        mode: this.policy.profile,
        capabilities: this.permissions?.list?.().length ?? 0,
      }),
      resources: this.resources?.usage() ?? Object.freeze({}),
      scheduler: Object.freeze({
        currentTask: this.scheduler?.current ? Object.freeze({ id: this.scheduler.current.id, label: this.scheduler.current.label, lane: this.scheduler.current.priority }) : null,
        pending: this.scheduler?.pendingTasks?.() ?? Object.freeze([]),
        lanes: this.scheduler?.laneStats?.() ?? null,
      }),
      checkpoint: Object.freeze({ entries: this.checkpoints?.list() ?? Object.freeze([]), delta: Boolean(this.checkpoints?.delta) }),
      fault: Object.freeze({ mode: this.faultMode, escalation: Boolean(this.faultEscalation), counters: Object.freeze({ ...this.counters }) }),
      profiler: Object.freeze({ enabled: this.profiling, instructions: [...(this.profileFunctions?.values?.() ?? [])].reduce((sum, entry) => sum + entry.count, 0) }),
      domTransaction: this.dom?.statsView() ?? null,
      cancellation: this.cancellation?.stats() ?? null,
    });
  }

  stateNames() {
    const names = [];
    for (const [name, slot] of this.globals?.names ?? []) {
      const binding = this.globals.bindings[slot];
      if (binding?.kind === "signal") names.push(name);
    }
    return names;
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
      faultLevel: this.faultMode,
      faultLadder: FAULT_LEVELS,
      capabilities: this.permissions?.list() ?? Object.freeze([]),
      resources: this.resources?.usage() ?? Object.freeze({}),
      scheduler: Object.freeze({
        lanes: PRIORITY_NAMES,
        maxSliceSteps: this.options?.maxSliceSteps ?? 0,
        frameBudgetMs: this.options?.frameBudgetMs ?? 0,
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
      // 0.6 内核视图：权限表 / 资源账本 / 任务与故障计数（全部只读）
      permissions: this.permissions?.list() ?? Object.freeze([]),
      resources: this.resources?.usage() ?? Object.freeze({}),
      checkpoints: this.checkpoints?.list() ?? Object.freeze([]),
      kernel: Object.freeze({
        faultLevel: this.faultMode,
        counters: Object.freeze({ ...(this.counters ?? {}) }),
        pendingTasks: this.scheduler?.pendingTasks?.() ?? Object.freeze([]),
        suspended: Boolean(this.machine?.suspended),
      }),
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
    this.resources?.reserve("listeners");
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

  scheduleTimer(task) {
    if (this.destroyed) return;
    this.timerTasks.add(task);
    if (this.activeTickHandle == null) {
      this.planNextTick();
    } else if (task.nextRun < this.scheduledTickTime) {
      if (this.window?.clearTimeout) this.window.clearTimeout(this.activeTickHandle);
      else clearTimeout(this.activeTickHandle);
      this.activeTickHandle = null;
      this.planNextTick();
    }
  }

  removeTimer(task) {
    if (!this.timerTasks) return;
    this.timerTasks.delete(task);
    if (this.timerTasks.size === 0 && this.activeTickHandle != null) {
      if (this.window?.clearTimeout) this.window.clearTimeout(this.activeTickHandle);
      else clearTimeout(this.activeTickHandle);
      this.activeTickHandle = null;
      this.scheduledTickTime = 0;
    }
  }

  planNextTick() {
    if (this.destroyed || !this.timerTasks || this.timerTasks.size === 0) return;
    if (this.activeTickHandle != null) return;
    const now = Date.now();
    let earliest = Infinity;
    for (const task of this.timerTasks) {
      if (task.nextRun < earliest) earliest = task.nextRun;
    }
    if (earliest === Infinity) return;
    const delay = Math.max(0, earliest - now);
    this.scheduledTickTime = earliest;
    const tick = () => {
      this.activeTickHandle = null;
      this.scheduledTickTime = 0;
      this.onTimerTick();
    };
    this.activeTickHandle = this.window?.setTimeout?.(tick, delay) ?? setTimeout(tick, delay);
  }

  onTimerTick() {
    if (this.destroyed || !this.timerTasks || this.timerTasks.size === 0) return;
    const now = Date.now();
    const ready = [];
    for (const task of this.timerTasks) {
      if (task.active && task.nextRun <= now + 2) {
        ready.push(task);
      }
    }
    for (const task of ready) {
      if (task.mode === 0) {
        task.release?.();
      } else {
        task.nextRun = now + task.delay;
      }
    }
    if (ready.length > 0) {
      this.batch(() => {
        for (const task of ready) {
          if (this.destroyed) break;
          if (task.scope && !task.scope.disposed && this.machine) {
            try {
              this.perform({
                kind: "timer",
                label: task.mode === 0 ? "after" : "every",
                priority: PRIORITY.BACKGROUND,
                sliceable: this.options.maxSliceSteps > 0,
                run: () => this.machine.runFunction(task.funcIndex, task.chain, task.scope),
              });
            } catch (error) {
              if (isYieldSignal(error)) throw error;
              this.handleFault(error, { phase: "timer", scope: task.scope });
            }
          }
        }
      });
    }
    this.planNextTick();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.activeTickHandle != null) {
      if (this.window?.clearTimeout) this.window.clearTimeout(this.activeTickHandle);
      else clearTimeout(this.activeTickHandle);
      this.activeTickHandle = null;
    }
    // 0.6.1：卸载 = 全量取消 + 停采样 + 丢弃未提交 DOM 写。
    this.leakDetector?.stop();
    this.cancellation?.clear();
    this.dom?.discard();
    this.nodeCache?.clear();
    this.timerTasks?.clear();
    this.timerTasks = null;
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
    if (this.machine) {
      this.machine.suspended = null;
      this.machine.sliceableTask = null;
    }
    this.machine = null;
    this.profileFunctions = null;
    this.links = null;
    this.routeSignal = null;
    this.scrollSignal = null;
    this.capabilities = null;
    this.permissions = null;
    this.resources = null;
    this.checkpoints?.clear?.();
    this.checkpoints = null;
    this.counters = null;
    this.initialState = null;
    this.onError = null;
    this.onWarn = null;
    this.options = null;
    this.kernel = null;
    this.ownedNodes?.clear();
    this.ownedNodes = null;
    this.denied = null;
    this.effectRegistry?.clear();
    this.effectRegistry = null;
    this.cancellation = null;
    this.dom = null;
    this.nodeCache = null;
    this.memoryAccountant = null;
    this.leakDetector = null;
    this.frameBudget = null;
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
    runtime.resources?.reserve("requests");
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
    // ---- 0.6.1 Network Scheduler：P5 车道 + 超时 + 有限重试 ----
    const timeoutMs = runtime.options.networkTimeoutMs ?? 0;
    const maxRetries = runtime.options.networkRetries ?? 0;
    let attempts = 0;
    let timeoutHandle = null;
    const fail = (error) => {
      if (!finish() || runtime.destroyed || error?.name === "AbortError") return;
      signal.set(resourceSnapshot(resource, previous?.data ?? null, Object.freeze({
        name: String(error?.name ?? "Error"),
        message: String(error?.message ?? error),
      }), false, null), true);
    };
    const fire = () => {
      if (!active || runtime.destroyed) return;
      attempts += 1;
      if (timeoutMs > 0 && controller) {
        const setTimeoutFn = runtime.window?.setTimeout ?? setTimeout;
        timeoutHandle = setTimeoutFn(() => { if (active) controller.abort?.(); }, timeoutMs);
      }
      let pending;
      try {
        pending = Promise.resolve(runtime.fetch(descriptor.url, fetchOptions));
      } catch (error) {
        fail(error);
        return;
      }
      pending.then(async (response) => {
        if (timeoutHandle != null) { (runtime.window?.clearTimeout ?? clearTimeout)(timeoutHandle); timeoutHandle = null; }
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
      }).catch((error) => {
        if (timeoutHandle != null) { (runtime.window?.clearTimeout ?? clearTimeout)(timeoutHandle); timeoutHandle = null; }
        // 重试只针对传输层失败（非 Abort、非 HTTP 状态），且仍然活着。
        if (active && !runtime.destroyed && error?.name !== "AbortError" && attempts <= maxRetries) {
          scheduleNetwork();
          return;
        }
        fail(error);
      });
    };
    const scheduleNetwork = () => {
      if (runtime.options.networkScheduling && runtime.scheduler && !runtime.destroyed) {
        // 网络任务进 P5 NETWORK 车道：不挤占 INPUT / RENDER，受资源配额与取消内核管辖。
        runtime.counters.networkScheduled += 1;
        runtime.scheduler.submit({
          kind: "network",
          label: `net:${declaration.name}`,
          priority: PRIORITY.NETWORK,
          run: () => fire(),
        });
      } else {
        fire();
      }
    };
    ACTIVE_EFFECT.onCleanup(() => {
      if (timeoutHandle != null) { (runtime.window?.clearTimeout ?? clearTimeout)(timeoutHandle); timeoutHandle = null; }
    });
    scheduleNetwork();
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

export function resolveModule(value) {
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
        runtime.activity += 1; // 泄漏探测：宿主写状态 = 用户侧活动
        runtime.batch(() => binding.signal.set(sanitizeValue(value)));
        return handle;
      },
      call(name, ...argumentsList) {
        if (!active) throw new JLCRuntimeError("应用已卸载");
        const value = bindingValue(runtime.globals.resolve(name));
        if (!value?.[CALLABLE]) throw new JLCRuntimeError(`“${name}”不是 action`);
        runtime.activity += 1; // 泄漏探测：宿主调 action = 用户侧活动
        // 0.6.1 统一管线：capability → permission → resource → scheduler → VM，
        // host call 不再有绕过调度器的旁路（切片开启时同样可让出续跑）。
        const args = argumentsList.map((argument) => sanitizeValue(argument));
        let result = null;
        // 0.6：宿主调用也走任务层。开切片时若预算耗尽，返回 Promise（异步完成），
        // 否则保持 0.4 的同步语义。
        const sliceable = runtime.options.maxSliceSteps > 0 && runtime.options.sliceHostCalls !== false;
        const deferred = sliceable ? runtime.makeDeferred() : null;
        const outcome = runtime.perform({
          kind: "interaction",
          label: `call:${name}`,
          priority: PRIORITY.INTERACTION,
          sliceable,
          deferred,
          run: () => runtime.batch(() => value.invoke(args, runtime.context(rootScope))),
          then: (value_) => { result = value_; },
        });
        if (outcome?.suspended) return deferred.promise.then(() => sanitizeValue(result));
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
      // ---- 0.6 宿主接管面：授权 / 撤销 / 检查点 / 诊断 ----
      /** 运行期授予能力（路径或裸能力名），立即生效。 */
      grant(path, options = {}) {
        if (!active) throw new JLCRuntimeError("应用已卸载");
        return runtime.permissions.grant(path, options);
      },
      /** 运行期撤销能力：所有未来调用立刻失败，不需要重新挂载。 */
      revoke(path, reason) {
        if (!active) throw new JLCRuntimeError("应用已卸载");
        return runtime.permissions.revoke(path, reason);
      },
      /** 能力图视图：路径 / 状态 / 租约 / 调用与拒绝计数。 */
      capabilities() {
        return Object.freeze(runtime.permissions?.list() ?? []);
      },
      /** 资源账本视图。 */
      resources() {
        return runtime.resources?.usage() ?? Object.freeze({});
      },
      /** 打检查点（state / 权限 / 资源一起拍照）。 */
      checkpoint(label, meta) {
        if (!active) throw new JLCRuntimeError("应用已卸载");
        return runtime.checkpoint(label ?? `cp:${runtime.metrics.cycles}`, meta);
      },
      /** 回滚到检查点（省略 label = 最近一个）。 */
      rollback(label) {
        if (!active) throw new JLCRuntimeError("应用已卸载");
        return runtime.rollback(label);
      },
      /** 只读诊断视图：热点函数 / 资源 / 任务 / 挂起状态。 */
      profile() {
        return runtime.destroyed ? Object.freeze({ active: false }) : runtime.profile();
      },
      /** 只读快照：state + 策略 + 权限 + 资源 + 检查点。 */
      snapshot() {
        return runtime.destroyed ? Object.freeze({ active: false }) : runtime.snapshot();
      },
      /** 尚未派发的调度任务（大型项目排查「谁在抢主线程」）。 */
      tasks() {
        return runtime.scheduler?.pendingTasks?.() ?? Object.freeze([]);
      },
      // ---- 0.6.1 宿主接管面：取消 / 内存 / 泄漏 / 依赖图 / VM 上下文 ----
      /** 取消任务：按 id / label / 谓词。组件没了，后台任务不许再动。 */
      cancel(query) {
        if (!active) throw new JLCRuntimeError("应用已卸载");
        return runtime.cancelTask(query);
      },
      /** VM Execution Context：我是谁 / 我在哪 / 有什么权限 / 用了多少资源。 */
      context() {
        return runtime.destroyed ? Object.freeze({ active: false }) : runtime.vmContext();
      },
      /** Memory Accountant：state / checkpoint / task / cache 分户账。 */
      memory() {
        return runtime.destroyed ? Object.freeze({ active: false }) : runtime.memory();
      },
      /** 泄漏探测报告（未开启时 enabled: false）。 */
      leaks() {
        return runtime.destroyed ? Object.freeze({ active: false }) : runtime.leaks();
      },
      /** Effect Dependency Graph：整图导出（只读）。 */
      dependencyGraph() {
        return runtime.destroyed ? Object.freeze({ signals: Object.freeze([]), effects: Object.freeze([]), edges: Object.freeze([]) }) : runtime.dependencyGraph();
      },
      /** 改某个状态会牵动哪些 effect（含经由派生状态的间接依赖）。 */
      dependents(name) {
        return runtime.destroyed ? Object.freeze([]) : runtime.dependents(name);
      },
      /** 车道视图：运行数 / 强制让出 / 饥饿营救 / 帧预算（Scheduler v2.1）。 */
      lanes() {
        return runtime.scheduler?.laneStats?.() ?? Object.freeze({});
      },
      /** 采样一次泄漏探测（测试与手动巡检用）。 */
      sampleLeaks() {
        if (!active || !runtime.leakDetector) return handle.leaks();
        runtime.leakDetector.sample(runtime.leakSnapshot());
        return handle.leaks();
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
      // 0.6：首屏渲染也是一个可切片任务——大到需要分帧时，VM 保存现场、
      // 让出、下一轮续跑，而不是把主线程钉死。预算为 0（默认）时行为与 0.4 完全一致。
      runtime.perform({
        kind: "view",
        label: `mount:${appName}`,
        priority: PRIORITY.RENDER,
        sliceable: runtime.options.maxSliceSteps > 0 || runtime.options.frameBudgetMs > 0,
        run: () => runtime.machine.runView(module.view, target, end, rootScope, null, null),
        then: () => {
          setupAutoDispose(runtime, start, end, handle.unmount);
          runtime.initializing = false;
        },
      });
      // 0.6.1：泄漏探测随挂载启动（自动采样；也可用 handle.sampleLeaks() 手动巡检）。
      runtime.leakDetector?.start(() => runtime.leakSnapshot(), runtime.window ?? globalThis);
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
