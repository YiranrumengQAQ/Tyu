/*
 * JLC Kernel — 全量门面（编译器前端 + 字节码虚拟机）
 * A CSP-safe, dependency-free bytecode kernel for declarative web programs.
 * Copyright (c) 2026 JLC contributors. MIT licensed.
 *
 * 翻译链：
 *   JLC source → Tokenizer → Parser → 优化器 → Code Generator → 字节码模块
 *             → Verifier → Linker → JLC-VM 调度循环 → 响应式 DOM
 *
 * 仅部署运行时？使用 jlc-vm.js（不含 Tokenizer/Parser）+ .jbc 字节码文件。
 */

import {
  VERSION,
  ABI_VERSION,
  ABI_MIN_KERNEL,
  BYTECODE_VERSION,
  ACCEPTED_BYTECODE_VERSIONS,
  JLCCompileError,
  JLCRuntimeError,
  JLCVerifyError,
  JLCPolicyError,
  JLCQuotaError,
  JLCIsolationError,
  JLCProgram,
  VMKernel,
  OP,
  OP_SPEC,
  encodeModule,
  decodeModule,
  loadModule,
  verifyModule,
  verifyReport,
  resolveModule,
  auditModule,
  analyzeModule,
  moduleAnalysis,
  buildCFG,
  analyzeAbstractStack,
  disassembleModule,
  resolvePolicy,
  checkPermissions,
  policyViolation,
  scopeStylesheet,
  resourceManifestOf,
  SECURITY_PROFILES,
  POLICY_KEYS,
  SYSCALLS,
  REQUIREMENT_KINDS,
  HARD_BLOCKED_TAGS,
  HARD_BLOCKED_PROPERTIES,
  FAULT_LEVELS,
  FAULT_ALIASES,
  FAULT_POLICY,
  normalizeFaultLevel,
  PRIORITY,
  PRIORITY_NAMES,
  TASK_PRIORITY,
  normalizePriority,
  CAPABILITY_TREE,
  CAPABILITY_PATHS,
  CAPABILITY_ALIASES,
  isCapabilityPath,
  capabilityAncestors,
  normalizeCapabilityGrants,
  normalizeResourceLimits,
  PermissionKernel,
  ResourceKernel,
  CheckpointStore,
  RESOURCE_KINDS,
  DEFAULT_RESOURCE_LIMITS,
  PERMISSION_STATES,
  VERIFIER_PASSES,
  MODULE_FLAGS,
  JLCYieldSignal,
  isYieldSignal,
  JLCBudgetError,
  createVMKernel,
  JLCVM,
  // ---- 0.6.1 Performance Kernel ----
  RUNTIME_PRESETS,
  resolveRuntimePreset,
  FAULT_ESCALATION,
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
} from "./jlc-vm.js";
import { tokenize, Parser, parseSource, optimizeProgram, compileAst, CompilerKernel } from "./jlc-compiler.js";

export {
  VERSION,
  ABI_VERSION,
  ABI_MIN_KERNEL,
  BYTECODE_VERSION,
  ACCEPTED_BYTECODE_VERSIONS,
  JLCCompileError,
  JLCRuntimeError,
  JLCVerifyError,
  JLCPolicyError,
  JLCQuotaError,
  JLCIsolationError,
  JLCProgram,
  VMKernel,
  OP,
  OP_SPEC,
  encodeModule,
  decodeModule,
  loadModule,
  verifyModule,
  verifyReport,
  resolveModule,
  auditModule,
  analyzeModule,
  moduleAnalysis,
  buildCFG,
  analyzeAbstractStack,
  disassembleModule,
  resolvePolicy,
  checkPermissions,
  policyViolation,
  scopeStylesheet,
  resourceManifestOf,
  SECURITY_PROFILES,
  POLICY_KEYS,
  SYSCALLS,
  REQUIREMENT_KINDS,
  HARD_BLOCKED_TAGS,
  HARD_BLOCKED_PROPERTIES,
  FAULT_LEVELS,
  FAULT_ALIASES,
  FAULT_POLICY,
  normalizeFaultLevel,
  PRIORITY,
  PRIORITY_NAMES,
  TASK_PRIORITY,
  normalizePriority,
  CAPABILITY_TREE,
  CAPABILITY_PATHS,
  CAPABILITY_ALIASES,
  isCapabilityPath,
  capabilityAncestors,
  normalizeCapabilityGrants,
  normalizeResourceLimits,
  PermissionKernel,
  ResourceKernel,
  CheckpointStore,
  RESOURCE_KINDS,
  DEFAULT_RESOURCE_LIMITS,
  PERMISSION_STATES,
  VERIFIER_PASSES,
  MODULE_FLAGS,
  JLCYieldSignal,
  isYieldSignal,
  JLCBudgetError,
  createVMKernel,
  JLCVM,
  // ---- 0.6.1 Performance Kernel ----
  RUNTIME_PRESETS,
  resolveRuntimePreset,
  FAULT_ESCALATION,
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
  tokenize,
  Parser,
  optimizeProgram,
};

const compiler = new CompilerKernel();

/** 全量内核 = VM 运行时 + 编译器前端。 */
export class JLCKernel extends VMKernel {
  tokenize(source, options = {}) {
    return compiler.tokenize(source, options);
  }

  parse(source, options = {}) {
    return parseSource(String(source), options);
  }

  /** 编译：JLC 源码 → 优化 → 字节码模块（已验证 + 接口清单）。 */
  compile(source, options = {}) {
    const sourceName = options.sourceName ?? "<jlc>";
    const { module, ast } = compileAst(source, { ...options, sourceName });
    return new JLCProgram(this, module, { ast, source: String(source), sourceName });
  }

  /** 构建期策略预检：同一份 resolvePolicy + checkPermissions，编译器和 VM 共用。 */
  checkPolicy(sourceOrProgram, policy) {
    const module = sourceOrProgram instanceof JLCProgram ? sourceOrProgram.module : this.compile(String(sourceOrProgram)).module;
    return checkPermissions(module.requirements ?? [], resolvePolicy(policy));
  }

  /** 可用策略档与全部可授予接口（管理台直接渲染）。 */
  policies() {
    return Object.keys(SECURITY_PROFILES).map((name) => ({ name, policy: resolvePolicy(name) }));
  }

  /** 结构化验证报告（0.6 多趟验证：永不抛错，工具链友好）。 */
  verify(sourceOrProgram, options = {}) {
    const module = this.resolveModuleFor(sourceOrProgram);
    return verifyReport(module, options.sourceName ?? module.sourceName ?? "<jbc>", options);
  }

  /** 控制流图文本（Pass 6 的调试视图）。 */
  graph(sourceOrProgram, options = {}) {
    const module = this.resolveModuleFor(sourceOrProgram);
    const analysis = moduleAnalysis(module);
    const lines = [`; JLC CFG — app ${module.app} (abi ${ABI_VERSION}, ${analysis?.functions.length ?? module.functions.length} functions)`];
    for (const func of module.functions) {
      const cfg = buildCFG(func, module);
      lines.push("", `function ${func.name} (${func.kind}, ${cfg.blocks.length} blocks, ${cfg.loopEdges.length} loop edges)`);
      for (const block of cfg.blocks) {
        const arrow = block.successors.length ? ` --> ${block.successors.join(", ")}` : "";
        lines.push(`  [B${block.id}] @${block.start}..${block.end} ${block.terminator?.name ?? block.instructions.at(-1)?.name ?? "?"}${arrow}`);
      }
      if (cfg.unreachable.length) lines.push(`  unreachable: ${cfg.unreachable.map((block) => `B${block.id}@${block.start}`).join(", ")}`);
    }
    if (options.text !== false) return lines.join("\n");
    return module.functions.map((func) => buildCFG(func, module));
  }

  /** 模块分析视图（CFG 统计 / 能力路径 / 确定性 / 警告）。 */
  analyze(sourceOrProgram) {
    const module = this.resolveModuleFor(sourceOrProgram);
    return moduleAnalysis(module) ?? analyzeModule(module);
  }

  resolveModuleFor(sourceOrProgram) {
    const module = resolveModule(sourceOrProgram);
    if (module) return module;
    if (typeof this.compile === "function") return this.compile(String(sourceOrProgram)).module;
    throw new JLCRuntimeError("VM 内核只能分析字节码模块或 .jbc 二进制；源码请使用完整内核");
  }

  /** 全部在册实例的诊断汇总（系统监视器）。 */
  profileAll() {
    return Object.freeze([...this.instances].map((handle) => handle.profile()));
  }

  /** 全内核资源账本汇总。 */
  resources() {
    const total = {};
    for (const handle of this.instances) {
      const usage = handle.resources();
      for (const [kind, entry] of Object.entries(usage)) {
        const slot = total[kind] ?? (total[kind] = { used: 0, limit: 0, peak: 0 });
        slot.used += entry.used;
        slot.limit += entry.limit;
        slot.peak += entry.peak;
      }
    }
    return Object.freeze(total);
  }

  /** 反汇编程序或模块（调试视图）。 */
  disassemble(sourceOrProgram) {
    const module = sourceOrProgram instanceof JLCProgram
      ? sourceOrProgram.module
      : sourceOrProgram?.format === "jlc-bytecode"
        ? sourceOrProgram
        : this.compile(String(sourceOrProgram)).module;
    return disassembleModule(module);
  }

  /** 序列化为 .jbc 二进制。 */
  serialize(sourceOrProgram, options = {}) {
    const program = sourceOrProgram instanceof JLCProgram
      ? sourceOrProgram
      : this.compile(String(sourceOrProgram), options);
    return program.serialize();
  }

  mount(sourceOrProgram, targetOrSelector, options = {}) {
    if (typeof sourceOrProgram === "string") {
      // 挂载期的 policy 由 VM 裁决（含 fault 档）；构建期预检请显式用 JLC.compile(src, { policy })。
      const { policy, ...compileOptions } = options;
      return this.compile(sourceOrProgram, { ...compileOptions, policyMode: "defer" }).mount(targetOrSelector, options);
    }
    return super.mount(sourceOrProgram, targetOrSelector, options);
  }

  /** 挂载 <script type="text/jlc">（编译执行）与 <script type="text/jbc">（字节码执行）。 */
  async boot(root = globalThis.document, options = {}) {
    if (!root?.querySelectorAll) throw new JLCRuntimeError("boot 需要 Document 或 Element");
    const scripts = [...root.querySelectorAll("script")]
      .filter((script) => ["text/jlc", "text/jbc"].includes(script.getAttribute?.("type") ?? script.type ?? ""));
    const handles = [];
    try {
      for (const script of scripts) {
        const selector = script.dataset?.target;
        const target = selector ? (script.ownerDocument ?? root).querySelector(selector) : script.nextElementSibling;
        if (!target) throw new JLCRuntimeError("text/jlc 脚本需要 data-target，或紧邻一个挂载元素");
        let state = options.state;
        if (script.dataset?.state) state = JSON.parse(script.dataset.state);
        const mountOptions = { ...options, state };
        if ((script.getAttribute?.("type") ?? script.type) === "text/jbc") {
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
          handles.push(this.mount(loadModule(bytes, { sourceName: script.src || "<inline-jbc>" }), target, mountOptions));
        } else {
          const source = script.src
            ? await (options.fetch ?? globalThis.fetch)(script.src).then((response) => {
              if (!response.ok) throw new JLCRuntimeError(`无法加载 ${script.src}: HTTP ${response.status}`);
              return response.text();
            })
            : script.textContent;
          handles.push(this.mount(this.compile(source, { sourceName: script.src || "<inline-jlc>" }), target, mountOptions));
        }
      }
      return handles;
    } catch (error) {
      for (const handle of handles) handle.unmount();
      throw error;
    }
  }
}

export function createKernel(options = {}) {
  return new JLCKernel(options);
}

export const JLC = new JLCKernel();
export default JLC;
