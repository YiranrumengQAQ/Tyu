export interface JLCToken {
  readonly type: "identifier" | "number" | "string" | "operator" | "punctuation" | "eof";
  readonly value: string | number;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface JLCAstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface JLCProgramAst extends JLCAstNode {
  readonly type: "Program";
  readonly name: string;
  readonly declarations: readonly JLCAstNode[];
  readonly view: JLCAstNode;
}

/** JLC 字节码函数（code 为大端指令流）。 */
export interface JLCBytecodeFunction {
  readonly name: string;
  readonly kind: "expr" | "body" | "view";
  readonly nSlots: number;
  readonly captures: readonly number[];
  readonly code: Uint8Array;
  readonly maxStack: number;
}

export interface JLCBytecodeAction {
  readonly name: string;
  readonly func: number;
  readonly params: ReadonlyArray<{ readonly name: string; readonly defaultFunc: number }>;
}

export interface JLCBytecodeDeclaration {
  readonly kind: "state" | "derive" | "resource" | "style";
  readonly name: string;
  readonly func: number;
}

/** JLC 字节码模块：.jbc 二进制的内存表示。 */
export interface JLCBytecodeModule {
  readonly format: "jlc-bytecode";
  readonly version: number;
  readonly app: string;
  readonly sourceName: string;
  readonly pool: ReadonlyArray<string | number | boolean | null>;
  readonly globalRefs: readonly string[];
  readonly functions: ReadonlyArray<JLCBytecodeFunction>;
  readonly actions: ReadonlyArray<JLCBytecodeAction>;
  readonly declarations: ReadonlyArray<JLCBytecodeDeclaration>;
  readonly view: number;
  readonly verified: boolean;
  /** 静态接口清单（验证器重算后的权威版本）。 */
  readonly requirements?: readonly JLCRequirement[];
  /** MANIFEST 段里的原始申报，只用于交叉核对。 */
  readonly declaredRequirements?: readonly string[];
}

export interface JLCMetrics {
  readonly scopes: number;
  readonly effects: number;
  readonly listeners: number;
  readonly timers: number;
  readonly requests: number;
  readonly nodes: number;
  readonly styles: number;
  readonly cycles: number;
  readonly faults: number;
  readonly denials: number;
  readonly neutralized: number;
  readonly peakStack: number;
  readonly peakFrames: number;
  readonly active: boolean;
}

export type JLCProfileName = "strict" | "open" | "trusted" | (string & {});
export type JLCFaultMode = "stop" | "degrade" | "report";
export type JLCIsolationMode = "soft" | "strict";
export type JLCRequirementKind =
  | "tag" | "frame" | "url" | "property" | "attribute" | "host" | "window" | "style" | "capability";

/** 应用静态申报的宿主接口（.jbc 的 MANIFEST 段是它的镜像）。 */
export interface JLCRequirement {
  readonly kind: JLCRequirementKind;
  readonly detail: string;
  readonly key: `${JLCRequirementKind}:${string}`;
  readonly sites: readonly string[];
}

/** resolvePolicy() 的输入：档名，或档名 + 覆盖项。 */
export interface JLCPolicyOverride {
  profile?: JLCProfileName;
  label?: string;
  urlSchemes?: readonly string[];
  allowDataUrls?: boolean;
  allowBlobUrls?: boolean;
  allowCustomElements?: boolean;
  allowEventAttributes?: boolean;
  allowSandboxedFrames?: boolean;
  allowHtmlInjection?: boolean;
  allowNetwork?: boolean;
  allowNavigation?: boolean;
  allowTimer?: boolean;
  allowCustomEvents?: boolean;
  allowDocumentTitle?: boolean;
  allowWindowEvents?: boolean;
  allowStyleScopingRelax?: boolean;
  frameSandbox?: string;
  frameMinIntervalMs?: number;
  htmlMaxChars?: number;
  strictUrls?: boolean;
  maxDomNodes?: number;
  maxStyleBytes?: number;
  styleScoping?: "off" | "prefix";
  gateMode?: "audit" | "error";
  blockedTags?: readonly string[];
  blockedProperties?: readonly string[];
  blockedAttributes?: readonly string[];
  capabilityAllowlist?: readonly string[] | null;
  audit?: ((entry: JLCPolicyEvent) => void) | null;
}

export interface JLCPolicy
  extends Readonly<Required<Omit<
    JLCPolicyOverride,
    "capabilityAllowlist" | "audit" | "blockedTags" | "blockedProperties" | "blockedAttributes"
  >>> {
  readonly version: number;
  readonly profile: JLCProfileName;
  readonly fingerprint: string;
  readonly capabilityAllowlist: readonly string[] | null;
  readonly audit: ((entry: JLCPolicyEvent) => void) | null;
  readonly urlSchemes: readonly string[];
  readonly blockedTags: ReadonlySet<string>;
  readonly blockedProperties: ReadonlySet<string>;
  readonly blockedAttributes: ReadonlySet<string>;
}

export type JLCPolicyInput = JLCProfileName | JLCPolicyOverride | null | undefined;

export interface JLCPolicyEvent {
  readonly action: "deny" | "skip" | "ignore" | "neutralize" | "quota" | "allow";
  readonly kind: JLCRequirementKind | string;
  readonly detail: string;
  readonly message: string;
}

export interface JLCDenial {
  readonly kind: JLCRequirementKind;
  readonly detail: string;
  readonly key: string;
  readonly reason: string;
  readonly sites?: readonly string[];
}

export interface JLCPolicyDescription {
  readonly profile: JLCProfileName;
  readonly label: string;
  readonly fingerprint: string;
  readonly abi: string;
  readonly frameSandbox: string;
  readonly frameMinIntervalMs: number;
  readonly urlSchemes: readonly string[];
  readonly styleScoping: "off" | "prefix";
  readonly isolation: JLCIsolationMode;
  readonly faultMode: JLCFaultMode;
  readonly scopeId: string | null;
  readonly quotas: Readonly<Record<string, number>>;
}

export interface JLCPolicyReport {
  readonly profile: JLCPolicyDescription;
  readonly requirements: readonly JLCRequirement[];
  readonly granted: ReadonlyArray<{ readonly kind: JLCRequirementKind; readonly detail: string; readonly key: string }>;
  readonly denied: readonly JLCDenial[];
  readonly audit: readonly JLCRequirement[];
}

export interface JLCInstanceDescription {
  readonly app: string | null;
  readonly abi: string;
  readonly bytecodeVersion: number;
  readonly policy: JLCPolicyDescription;
  readonly granted: ReadonlyArray<{ readonly kind: JLCRequirementKind; readonly detail: string; readonly key: string }>;
  readonly denied: readonly JLCDenial[];
  readonly usage: Readonly<JLCMetrics>;
}

export interface JLCAppHandle {
  readonly active: boolean;
  readonly name: string;
  /** 实例隔离域标识（`isolation: "strict"` 时写进 `data-jlc-app` / `data-jlc-realm`）。 */
  readonly scopeId: string | null;
  /** 读取状态或 action 句柄；action 返回冻结的 `{ kind, name }`。 */
  get<T = unknown>(name: string): T;
  set(name: string, value: unknown): this;
  call<T = unknown>(name: string, ...args: unknown[]): T;
  flush(): this;
  inspect(): JLCMetrics;
  /** 逐条接口裁决（装载期静态清单 × 当前策略）。 */
  permissions(): ReadonlyArray<{
    readonly kind: JLCRequirementKind;
    readonly detail: string;
    readonly granted: boolean;
    readonly reason: string | null;
  }>;
  /** 运行时快照：策略 + 清单 + 用量。 */
  describe(): JLCInstanceDescription;
  /** 当前生效的策略描述（含指纹与配额）。 */
  policy(): JLCPolicyDescription;
  unmount(): void;
}

export interface JLCMountOptions {
  document?: Document;
  /** 策略档或「档 + 覆盖项」；决定本实例能碰宿主的哪些接口。 */
  policy?: JLCPolicyInput;
  /** 违反策略时的行为：整体失败 / 降级并记账 / 只记录。默认 `stop`。 */
  fault?: JLCFaultMode;
  /** 实例隔离域：`strict` 时越界 DOM 操作抛 JLCIsolationError。 */
  isolation?: JLCIsolationMode;
  /** 隔离域根元素，默认挂载点的父元素。 */
  realmRoot?: Element;
  /** 实例生命周期内的累计指令上限（0 = 不限）。 */
  maxTotalSteps?: number;
  /** 实例标识，默认自增 `jlc-N`。 */
  id?: string;
  /** 每次策略裁决（拒绝 / 跳过 / 中和 / 配额）都会回调。 */
  onFault?: ((info: JLCPolicyEvent) => void) | null;
  state?: Record<string, unknown>;
  capabilities?: Record<string, (...args: unknown[]) => unknown>;
  fetch?: typeof globalThis.fetch;
  replace?: boolean;
  autoDispose?: boolean;
  maxSteps?: number;
  maxLoop?: number;
  sourceName?: string;
  onError?: (error: Error) => void;
}

export interface JLCKernelOptions {
  fetch?: typeof globalThis.fetch;
  autoDispose?: boolean;
  maxSteps?: number;
  maxLoop?: number;
  maxTotalSteps?: number;
  onError?: (error: Error) => void;
  onFault?: ((info: JLCPolicyEvent) => void) | null;
  /** 内核级默认策略档（挂载时可覆盖）。 */
  policy?: JLCPolicyInput;
  isolation?: JLCIsolationMode;
  fault?: JLCFaultMode;
}

/**
 * 三类安全失败共用 `isPolicyError` 标记（宿主可以一次认全），用 `code` 区分种类：
 * `EPERM_POLICY`（策略拒绝）、`ENOSPC_QUOTA`（配额 / 预算越界）、`EPERM_REALM`（越出隔离域）。
 */
export class JLCPolicyError extends Error {
  readonly name: "JLCPolicyError";
  readonly code: "EPERM_POLICY";
  readonly isPolicyError: true;
}

/** 配额越界：maxDomNodes、maxStyleBytes、htmlMaxChars、maxTotalSteps。 */
export class JLCQuotaError extends Error {
  readonly name: "JLCQuotaError";
  readonly code: "ENOSPC_QUOTA";
  readonly isPolicyError: true;
}

/** 隔离违规：在应用子树之外读写 DOM。 */
export class JLCIsolationError extends Error {
  readonly name: "JLCIsolationError";
  readonly code: "EPERM_REALM";
  readonly isPolicyError: true;
}

export class JLCCompileError extends SyntaxError {
  readonly sourceName: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

export class JLCRuntimeError extends Error {}

/** 字节码验证失败（载入期静态检查）。 */
export class JLCVerifyError extends Error {
  readonly moduleName: string;
}

/** 编译产物：字节码模块 + 可选的源码与 AST。 */
export class JLCProgram {
  readonly kernel: JLCKernel;
  readonly module: JLCBytecodeModule;
  readonly ast: JLCProgramAst | null;
  readonly source: string | null;
  readonly sourceName: string;
  readonly name: string;
  serialize(): Uint8Array;
  disassemble(): string;
  mount(target: string | Element, options?: JLCMountOptions): JLCAppHandle;
}

export interface JLCOpcodeSpec {
  readonly name: string;
  readonly operands: string;
  readonly stack: number | string;
  readonly jump?: string;
}

/** 指令集：操作码 → 汇编名 / 操作数布局 / 栈效应。 */
export const OP: Readonly<Record<string, number>>;
export const OP_SPEC: Readonly<Record<number, JLCOpcodeSpec>>;

export class JLCKernel {
  readonly version: string;
  readonly abi: string;
  readonly options: Readonly<Required<Omit<JLCKernelOptions, "fetch" | "onError" | "onFault" | "policy" | "fault" | "isolation">> & Partial<JLCKernelOptions>>;
  constructor(options?: JLCKernelOptions);
  tokenize(source: string, options?: { sourceName?: string }): readonly JLCToken[];
  parse(source: string, options?: { sourceName?: string }): JLCProgramAst;
  compile(source: string, options?: { sourceName?: string; optimize?: boolean; policy?: JLCPolicyInput; policyMode?: "gate" | "manifest" | "defer" }): JLCProgram;
  /** 构建期预检：同一份 resolvePolicy + checkPermissions，返回被拒接口清单。 */
  checkPolicy(sourceOrProgram: string | JLCProgram, policy?: JLCPolicyInput): readonly JLCDenial[];
  /** 可用档位与解析后的策略对象（管理台直接渲染）。 */
  policies(): ReadonlyArray<{ readonly name: string; readonly policy: JLCPolicy }>;
  serialize(source: string | JLCProgram, options?: { sourceName?: string }): Uint8Array;
  disassemble(sourceOrProgram: string | JLCProgram | JLCBytecodeModule): string;
  mount(
    source: string | JLCProgram | JLCBytecodeModule | Uint8Array,
    target: string | Element,
    options?: JLCMountOptions,
  ): JLCAppHandle;
  boot(root?: Document | Element, options?: JLCMountOptions): Promise<JLCAppHandle[]>;
}

/**
 * 仅运行时内核（jlc-vm.js）：不含 Tokenizer / Parser，
 * 只能装载并执行 .jbc 字节码。
 */
export class VMKernel {
  readonly version: string;
  readonly abi: string;
  readonly options: Readonly<JLCKernelOptions>;
  /** 在册实例的管理视图。 */
  readonly instances: ReadonlySet<JLCAppHandle>;
  constructor(options?: JLCKernelOptions);
  load(bytes: Uint8Array, options?: { sourceName?: string }): JLCBytecodeModule;
  /** 解析并冻结策略（不挂载）。 */
  policy(nameOrOverride?: JLCPolicyInput): JLCPolicy;
  list(): readonly JLCInstanceDescription[];
  demountAll(): number;
  mount(
    module: JLCBytecodeModule | JLCProgram | Uint8Array,
    target: string | Element,
    options?: JLCMountOptions,
  ): JLCAppHandle;
  boot(root?: Document | Element, options?: JLCMountOptions): Promise<JLCAppHandle[]>;
}

export function createKernel(options?: JLCKernelOptions): JLCKernel;
export function createVMKernel(options?: JLCKernelOptions): VMKernel;
export function loadModule(bytes: Uint8Array, options?: { sourceName?: string }): JLCBytecodeModule;
export function encodeModule(module: JLCBytecodeModule): Uint8Array;
export function decodeModule(bytes: Uint8Array, options?: { sourceName?: string; verify?: boolean }): JLCBytecodeModule;
export function verifyModule(module: JLCBytecodeModule, sourceName?: string): JLCBytecodeModule;
/** 从指令流静态重算接口清单（MANIFEST 段的权威版本由此产生）。 */
export function auditModule(module: JLCBytecodeModule): readonly JLCRequirement[];
/** 解析策略：档名或「档名 + 覆盖项」，结果冻结并带指纹；未知字段名直接抛错。 */
export function resolvePolicy(input?: JLCPolicyInput): JLCPolicy;
/** 静态清单 × 策略 → 被拒接口（装载期裁决的同一函数）。 */
export function checkPermissions(requirements: readonly JLCRequirement[], policy: JLCPolicy): readonly JLCDenial[];
/** 单条接口是否被策略拒绝；返回 null 表示放行，返回字符串表示原因。 */
export function policyViolation(kind: JLCRequirementKind, detail: string, policy: JLCPolicy): string | null;
/** 把一份样式表限定到某个选择器前缀（`styleScoping: "prefix"` 用的就是它）。 */
export function scopeStylesheet(css: string, scopeSelector: string): string;
export const SECURITY_PROFILES: Readonly<Record<string, JLCPolicyOverride>>;
export const POLICY_KEYS: readonly string[];
export const SYSCALLS: ReadonlyArray<{ readonly permission: string; readonly field: string; readonly note: string }>;
export const REQUIREMENT_KINDS: readonly JLCRequirementKind[];
export const HARD_BLOCKED_TAGS: ReadonlySet<string>;
export const HARD_BLOCKED_PROPERTIES: ReadonlySet<string>;
export const VERSION: string;
export const ABI_VERSION: string;
export const BYTECODE_VERSION: number;
export const ACCEPTED_BYTECODE_VERSIONS: readonly number[];
export function disassembleModule(module: JLCBytecodeModule): string;

export const JLC: JLCKernel;
export const JLCVM: VMKernel;
export default JLC;
