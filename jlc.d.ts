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
  /** ABI v3：申报的能力图路径（与指令流交叉核对，只能少报不能多报）。 */
  readonly declaredCapabilities?: readonly string[];
  /** 验证器从指令流重算出的能力图路径。 */
  readonly capabilityPaths?: readonly string[];
  /** 资源清单：kind → 静态上界（`resourceManifestOf()` 的产物）。 */
  readonly resourceManifest?: Readonly<Record<string, number>>;
  /** 模块标志位（`MODULE_FLAGS` 位图：deterministic / network / timers / frames / windowEvents / workers）。 */
  readonly flags?: number;
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
  // ---- 0.6：宿主接管面 ----
  /** 运行期授予能力（路径或裸名），立即生效。 */
  grant(path: string, options?: { mode?: JLCPermissionMode; expires?: number }): JLCGrantRecord;
  /** 运行期撤销能力：所有未来调用立刻失败，不需要重新挂载。 */
  revoke(path: string, reason?: string): JLCGrantRecord;
  /** 能力图视图：路径 / 状态 / 租约 / 调用与拒绝计数。 */
  capabilities(): readonly JLCGrantRecord[];
  /** 资源账本视图。 */
  resources(): Readonly<Record<string, { readonly used: number; readonly limit: number; readonly peak: number; readonly ratio: number }>>;
  /** 打运行时检查点（state / 权限 / 资源一起拍照）。 */
  checkpoint(label?: string, meta?: Record<string, unknown>): JLCheckpointEntry | null;
  /** 回滚到检查点（省略 label = 最近一个）；返回时视图已与 state 一致。 */
  rollback(label?: string): JLCheckpointEntry | null;
  /** 只读诊断视图：热点函数 / 资源 / 任务 / 挂起状态 / 检查点。 */
  profile(): JLCProfile;
  /** 只读快照：state + 策略 + 权限 + 资源 + 检查点。 */
  snapshot(): Readonly<Record<string, unknown>>;
  /** 尚未派发的调度任务。 */
  tasks(): readonly Record<string, unknown>[];
  // ---- 0.6.1：性能内核操作面 ----
  /** 取消任务：按 id / label / 谓词。组件销毁会级联取消其名下任务。 */
  cancel(query: number | string | ((task: Record<string, unknown>) => boolean)): number;
  /** VM Execution Context：我是谁 / 在哪 / 有什么权限 / 用了多少资源 / 出错怎么恢复。 */
  context(): Readonly<Record<string, unknown>>;
  /** Memory Accountant：state / checkpoint / task / cache 分户账（字节）。 */
  memory(): Readonly<Record<string, unknown>>;
  /** 泄漏探测报告（未开启时 enabled: false）。 */
  leaks(): Readonly<Record<string, unknown>>;
  /** 手动采样一次泄漏探测（测试 / 巡检用）。 */
  sampleLeaks(): Readonly<Record<string, unknown>>;
  /** Effect Dependency Graph：信号 / effect / 订阅边（只读）。 */
  dependencyGraph(): Readonly<Record<string, unknown>>;
  /** 改某个状态会牵动哪些 effect（含经由派生状态的间接依赖）。 */
  dependents(name: string): readonly Record<string, unknown>[];
  /** Scheduler v2.1 车道视图：运行数 / 强制让出 / 饥饿营救 / 帧预算。 */
  lanes(): Readonly<Record<string, unknown>>;
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
  // ---- 0.6 ----
  /** 解析后的故障级别：数字越小越先跑；与 0.4 的数字优先级同序。 */
  faultStopLevel?: JLCFaultLevel;
  /** 运行期授予的能力：路径或裸能力名 → 授权值（支持 `{ grant, mode, expires }`）。 */
  grants?: Record<string, unknown>;
  /** 裸能力名 → 能力路径（宿主自定义能力用；内置别名见 `CAPABILITY_ALIASES`）。 */
  capabilityPaths?: Record<string, string>;
  /** 资源限额：`RESOURCE_KINDS` 的任意子集；0.6.1 起每种资源可用 `{ soft, hard }` 双限额。 */
  resources?: Record<string, number | { soft?: number; hard?: number; limit?: number }>;
  /** 检查点数量上限（默认 8）。 */
  checkpointLimit?: number;
  /** 协作式调度：单次任务的指令预算（0 = 关闭，行为与 0.4 一致）。 */
  maxSliceSteps?: number;
  /** 协作式调度：单次任务的时间预算（毫秒，0 = 关闭）。 */
  frameBudgetMs?: number;
  /** 宿主同步调用是否参与切片；关闭时保持同步语义（默认 true）。 */
  sliceHostCalls?: boolean;
  /** 打开逐指令热点统计（默认 false，零开销）。 */
  profile?: boolean;
  debug?: boolean;
  // ---- 0.6.1 Performance Kernel ----
  /** 运行档：`"full"` = 全部接管子系统启用（调度公平 / 帧预算 / DOM 事务 / 依赖图 /
   *  增量检查点 / 内存分户 / 泄漏探测 / 网络调度 / 故障自动升级 / 取消内核）。 */
  runtime?: "full" | "legacy";
  /** 首次越过资源 soft 限额时的回调。 */
  onWarn?: (info: { code: string; resource?: string; kind?: string; used?: number }) => void;
  /** Scheduler v2.1 参数：连续片数上限 / 老化 / 饥饿阈值 / 按车道配额。 */
  scheduler?: {
    maxConsecutiveSlices?: number;
    agingMs?: number;
    maxAgingSteps?: number;
    starvationMs?: number;
    laneQuotas?: Record<number, number>;
  };
  /** 渲染分片大小（配合协作式调度的大列表分帧）。 */
  renderChunk?: number;
  /** 切片预算检查粒度（指令数）。 */
  sliceCheckInterval?: number;
  /** DOM Transaction Kernel：属性面写操作先进 Mutation Buffer，批内合并，统一提交。 */
  domTransaction?: boolean;
  /** Checkpoint 2.0：delta 快照（结构共享），只存相对上一份的变化。 */
  checkpointDelta?: boolean;
  /** Memory Accountant：内存分户账（state / checkpoint / task / cache）。 */
  memoryAccounting?: boolean;
  /** 内存上限（KB，0 = 不限；超限由资源内核裁决）。 */
  memoryLimitKB?: number;
  /** Leak Detector：true = 默认参数；对象可调 intervalMs / threshold。 */
  leakDetector?: boolean | { intervalMs?: number; threshold?: number };
  /** 故障自动升级（restart 耗尽 → rollback → degrade）。默认 true。 */
  faultEscalation?: boolean;
  /** Network Scheduler：resource 请求经 P5 NETWORK 车道 + 超时 + 重试。 */
  networkScheduling?: boolean;
  /** 网络请求超时（毫秒，0 = 不限）。 */
  networkTimeoutMs?: number;
  /** 网络请求传输层失败重试次数（默认 0）。 */
  networkRetries?: number;
  /** Keyed Node Cache 上限。 */
  nodeCacheSize?: number;
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
  /** 0.6：结构化验证报告（11 趟，永不抛异常）。 */
  verify(sourceOrProgram: unknown, options?: { mode?: "normal" | "strict"; sourceName?: string }): JLCVerifyReport;
  /** 0.6：控制流图文本（`options.text === false` 时返回原始 CFG 数组）。 */
  graph(sourceOrProgram: unknown, options?: { text?: boolean }): string | readonly unknown[];
  /** 0.6：模块分析视图（CFG 统计 / 能力路径 / 确定性 / 警告）。 */
  analyze(sourceOrProgram: unknown): JLCAnalysis;
  /** 0.6：全内核诊断汇总。 */
  profileAll(): readonly JLCProfile[];
  /** 0.6：全内核资源汇总。 */
  resources(): Readonly<Record<string, { used: number; limit: number; peak: number }>>;
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

/* ================================================================
 * 0.6 内核子系统
 * ================================================================ */

export type JLCFaultLevel = "ignore" | "degrade" | "recover" | "restart" | "rollback" | "stop";
export type JLCPermissionMode = "session" | "once" | "persistent";
export type JLCPermissionState =
  | "requested" | "granted" | "denied" | "session" | "once"
  | "persistent" | "suspended" | "revoked" | "expired";

export interface JLCGrantRecord {
  readonly path: string;
  readonly state: JLCPermissionState;
  readonly granted: boolean;
  readonly mode: JLCPermissionMode | null;
  readonly expires: number;
  readonly calls: number;
  readonly denials: number;
  readonly reason: string | null;
}

export interface JLCheckpointEntry {
  readonly label: string;
  readonly serial: number;
  readonly at: number;
  readonly signalNames: readonly string[];
}

export interface JLCProfile {
  readonly app: string | null;
  readonly version?: string;
  readonly runtime?: string | null;
  readonly active: boolean;
  readonly profiling: boolean;
  readonly instructions: number;
  readonly domMutations: number;
  readonly counters: Readonly<Record<string, number>>;
  readonly usage: Readonly<Record<string, number>>;
  readonly resources: Readonly<Record<string, { readonly used: number; readonly limit: number; readonly peak: number }>>;
  readonly hot: ReadonlyArray<{ readonly function: string; readonly instructions: number; readonly share: number }>;
  readonly pending: readonly Record<string, unknown>[];
  readonly suspended: boolean;
  readonly checkpoints: readonly JLCheckpointEntry[];
  /** 0.6.1 Profile 2.0 分区：cpu / dom / scheduler / yield / memory / effects /
   *  each / network / resource / faults / hotCache / leaks。 */
  readonly sections?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface JLCAnalysis {
  readonly abi: string;
  readonly version: number;
  readonly app: string;
  readonly mode: string;
  readonly passes: readonly string[];
  readonly functions: ReadonlyArray<{
    readonly name: string;
    readonly kind: "expr" | "body" | "view";
    readonly maxStack: number;
    readonly blocks: number;
    readonly edges: number;
    readonly unreachable: number;
    readonly loops: number;
  }>;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly requirements: readonly string[];
  readonly capabilityPaths: readonly string[];
  readonly determinism: { readonly deterministic: boolean; readonly reasons: readonly string[] };
  readonly stats: Readonly<Record<string, number>>;
}

export interface JLCVerifyReport {
  readonly ok: boolean;
  readonly moduleName: string;
  readonly abi: string;
  readonly bytecodeVersion: number;
  readonly mode: string;
  readonly passes: ReadonlyArray<{ readonly id: number; readonly name: string; readonly label: string; readonly ok: boolean }>;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  readonly analysis: JLCAnalysis | null;
}

export interface JLCBlock {
  readonly id: number;
  readonly start: number;
  readonly end: number;
  readonly kind: "fallthrough" | "branch" | "jump" | "exit";
  readonly successors: readonly (number | string)[];
}

export interface JLCControlFlowGraph {
  readonly function: string;
  readonly kind: string;
  readonly blocks: readonly JLCBlock[];
  readonly edges: readonly string[];
  readonly unreachable: readonly { readonly id: number; readonly start: number; readonly end: number }[];
  readonly loopEdges: readonly string[];
  readonly truncated: boolean;
}

export interface JLCPermissionKernelOptions {
  readonly grants?: Record<string, unknown>;
  readonly aliases?: Record<string, string>;
  readonly strict?: boolean;
  readonly now?: () => number;
}

export class PermissionKernel {
  constructor(options?: JLCPermissionKernelOptions);
  pathOf(name: string): string | null;
  register(name: string, path: string): this;
  define(pathOrName: string, value?: unknown): JLCGrantRecord;
  grant(pathOrName: string, options?: { mode?: JLCPermissionMode; expires?: number }): JLCGrantRecord;
  deny(pathOrName: string, reason?: string | null): JLCGrantRecord;
  revoke(pathOrName: string, reason?: string): JLCGrantRecord;
  suspend(pathOrName: string, reason?: string): JLCGrantRecord;
  lease(pathOrName: string, ttlMs: number, options?: { mode?: JLCPermissionMode }): JLCGrantRecord;
  check(pathOrName: string): { readonly ok: boolean; readonly path: string | null; readonly state: string; readonly reason: string | null };
  list(): readonly JLCGrantRecord[];
  snapshot(): Readonly<Record<string, unknown>>;
  restore(snapshot: unknown): this;
}

export class ResourceKernel {
  constructor(runtime: unknown, limits?: Record<string, number>);
  limitOf(kind: string): number;
  setLimit(kind: string, value: number): this;
  usageOf(kind: string): number;
  reserve(kind: string, amount?: number): number | null;
  release(kind: string, amount?: number): number;
  usage(): Readonly<Record<string, { readonly used: number; readonly limit: number; readonly peak: number; readonly ratio: number }>>;
  snapshot(): Readonly<Record<string, unknown>>;
  restore(snapshot: unknown): this;
}

export class CheckpointStore {
  constructor(runtime: unknown, options?: { limit?: number });
  capture(label?: string, extra?: Record<string, unknown> | null): JLCheckpointEntry | null;
  restore(label: string): JLCheckpointEntry | null;
  list(): readonly JLCheckpointEntry[];
  drop(label: string): boolean;
  clear(): void;
}

export class JLCYieldSignal extends Error {
  readonly isYieldSignal: true;
  readonly info: Readonly<Record<string, unknown>>;
}
export class JLCBudgetError extends JLCRuntimeError {
  readonly code: "E_BUDGET";
  readonly budget: number;
  readonly steps: number;
}
export function isYieldSignal(value: unknown): boolean;

export function normalizeFaultLevel(value: unknown, fallback?: JLCFaultLevel): JLCFaultLevel;
export function normalizePriority(value: unknown, fallback?: number): number;
export function normalizeCapabilityGrants(input: unknown): Record<string, unknown>;
export function normalizeResourceLimits(input: unknown): Record<string, number>;
export function isCapabilityPath(path: string): boolean;
export function capabilityAncestors(path: string): readonly string[];
export function buildCFG(func: JLCBytecodeFunction, module?: JLCBytecodeModule): JLCControlFlowGraph;
export function analyzeAbstractStack(func: JLCBytecodeFunction, module: JLCBytecodeModule, options?: { strict?: boolean }): { readonly warnings: readonly string[]; readonly visited: number };
export function analyzeModule(module: JLCBytecodeModule, options?: { mode?: "normal" | "strict" }): JLCAnalysis;
export function moduleAnalysis(module: JLCBytecodeModule): JLCAnalysis | null;
export function verifyReport(module: JLCBytecodeModule, sourceName?: string, options?: { mode?: "normal" | "strict" }): JLCVerifyReport;
export function resourceManifestOf(module: JLCBytecodeModule, analysis?: JLCAnalysis | null): Record<string, number>;

export const FAULT_LEVELS: readonly JLCFaultLevel[];
export const FAULT_ALIASES: Readonly<Record<string, JLCFaultLevel>>;
export const FAULT_POLICY: Readonly<Record<JLCFaultLevel, { readonly level: number; readonly label: string; readonly note: string }>>;
export const PRIORITY: Readonly<{ SYSTEM: 0; INPUT: 1; INTERACTION: 2; RENDER: 3; EFFECT: 4; NETWORK: 5; BACKGROUND: 6; IDLE: 7 }>;
export const PRIORITY_NAMES: readonly string[];
export const TASK_PRIORITY: Readonly<Record<string, number>>;
export const CAPABILITY_TREE: Readonly<Record<string, unknown>>;
export const CAPABILITY_PATHS: readonly string[];
export const CAPABILITY_ALIASES: Readonly<Record<string, string>>;
export const PERMISSION_STATES: readonly JLCPermissionState[];
export const RESOURCE_KINDS: readonly string[];
export const DEFAULT_RESOURCE_LIMITS: Readonly<Record<string, number>>;
export const VERIFIER_PASSES: ReadonlyArray<{ readonly id: number; readonly name: string; readonly label: string }>;
export const MODULE_FLAGS: Readonly<Record<string, number>>;
export const ABI_MIN_KERNEL: string;

/* ================================================================
 * 0.6.1 Performance Kernel 表面
 * ================================================================ */

/** 运行档预设：`full` = 全部接管子系统启用；显式 mount options 永远覆盖预设。 */
export const RUNTIME_PRESETS: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
export function resolveRuntimePreset(name: string | null | undefined): Readonly<Record<string, unknown>>;
/** 故障自动升级链：本级动作失败 → 下一级接手（不新增第七级）。 */
export const FAULT_ESCALATION: Readonly<Record<string, JLCFaultLevel>>;

export class FrameBudgetManager {
  constructor(options?: { frameBudgetMs?: number; laneBudgets?: Record<number, number> });
  readonly enabled: boolean;
  begin(now?: number): Readonly<Record<string, unknown>>;
  deadlineFor(frame: unknown, lane: number): number;
  stats(): Readonly<Record<string, unknown>>;
}

export class LaneGovernor {
  constructor(options?: { quotas?: Record<number, number>; defaultQuota?: number; agingMs?: number; maxAgingSteps?: number; starvationMs?: number });
  effectivePriority(task: { priority: number; submitted?: number }, now?: number): number;
  canRun(lane: number, pendingLanes: Set<number>): boolean;
  starvedLane(pendingLanes: Set<number>, now?: number): number | null;
  noteRan(lane: number, now?: number): void;
  stats(): Readonly<Record<string, unknown>>;
}

export class DomTransaction {
  constructor(options?: { enabled?: boolean });
  readonly enabled: boolean;
  readonly hasPending: boolean;
  commit(): number;
  discard(): void;
  statsView(): Readonly<Record<string, number>>;
}

export class KeyedNodeCache {
  constructor(options?: { maxSize?: number });
  hit(owner: unknown, key: unknown): unknown;
  miss(owner: unknown, key: unknown): unknown;
  release(owner: unknown, key: unknown): void;
  releaseOwner(owner: unknown): void;
  size(): number;
  stats(): Readonly<Record<string, number>>;
}

export class MemoryAccountant {
  constructor(options?: { limit?: number });
  charge(account: string, bytes: number): number;
  release(account: string, bytes: number): number;
  total(): number;
  usageKB(): number;
  usage(): Readonly<Record<string, unknown>>;
}

export class LeakDetector {
  constructor(options?: { intervalMs?: number; windowSize?: number; threshold?: number; onWarn?: (info: Record<string, unknown>) => void });
  sample(snapshot: Record<string, number>, now?: number): Record<string, unknown>;
  report(): Readonly<Record<string, unknown>>;
  start(readSnapshot: () => Record<string, number>, host?: unknown): () => void;
  stop(): void;
}

export class CancellationRegistry {
  register(options?: { label?: string; scope?: unknown }): {
    readonly id: number;
    canceled: boolean;
    cancel(reason?: string): boolean;
    onCancel(callback: (reason: string) => void): void;
  };
  cancel(query: number | string | ((token: unknown) => boolean), reason?: string): number;
  cancelScope(scope: unknown, reason?: string): number;
  alive(): readonly { readonly id: number; readonly label: string }[];
  stats(): Readonly<Record<string, number>>;
}

export class HotPathCache {
  constructor(module?: { globalRefs?: unknown[]; functions?: unknown[] });
  statsView(): Readonly<Record<string, number>>;
}

export function estimateBytes(value: unknown): number;
export function describeDependencyGraph(runtime: unknown): Readonly<Record<string, unknown>>;
export function dependentsOf(runtime: unknown, name: string): readonly Record<string, unknown>[];
