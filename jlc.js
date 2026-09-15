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
  BYTECODE_VERSION,
  JLCCompileError,
  JLCRuntimeError,
  JLCVerifyError,
  JLCPolicyError,
  JLCQuotaError,
  JLCIsolationError,
  OP,
  OP_SPEC,
  encodeModule,
  decodeModule,
  loadModule,
  verifyModule,
  auditModule,
  disassembleModule,
  resolvePolicy,
  checkPermissions,
  policyViolation,
  scopeStylesheet,
  SECURITY_PROFILES,
  POLICY_KEYS,
  SYSCALLS,
  JLCProgram,
  VMKernel,
  createVMKernel,
  JLCVM,
} from "./jlc-vm.js";
import { tokenize, Parser, parseSource, optimizeProgram, compileAst, CompilerKernel } from "./jlc-compiler.js";

export {
  VERSION,
  ABI_VERSION,
  BYTECODE_VERSION,
  JLCCompileError,
  JLCRuntimeError,
  JLCVerifyError,
  JLCPolicyError,
  JLCQuotaError,
  JLCIsolationError,
  OP,
  OP_SPEC,
  encodeModule,
  decodeModule,
  loadModule,
  verifyModule,
  auditModule,
  disassembleModule,
  resolvePolicy,
  checkPermissions,
  policyViolation,
  scopeStylesheet,
  SECURITY_PROFILES,
  POLICY_KEYS,
  SYSCALLS,
  createVMKernel,
  JLCVM,
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
