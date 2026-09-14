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
}

export interface JLCMetrics {
  readonly scopes: number;
  readonly effects: number;
  readonly listeners: number;
  readonly timers: number;
  readonly requests: number;
  readonly active: boolean;
}

export interface JLCAppHandle {
  readonly active: boolean;
  readonly name: string;
  get<T = unknown>(name: string): T;
  set(name: string, value: unknown): this;
  call<T = unknown>(name: string, ...args: unknown[]): T;
  flush(): this;
  inspect(): JLCMetrics;
  unmount(): void;
}

export interface JLCMountOptions {
  document?: Document;
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
  onError?: (error: Error) => void;
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
  readonly options: Readonly<Required<Omit<JLCKernelOptions, "fetch" | "onError">> & Pick<JLCKernelOptions, "fetch" | "onError">>;
  constructor(options?: JLCKernelOptions);
  tokenize(source: string, options?: { sourceName?: string }): readonly JLCToken[];
  parse(source: string, options?: { sourceName?: string }): JLCProgramAst;
  compile(source: string, options?: { sourceName?: string; optimize?: boolean }): JLCProgram;
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
  constructor(options?: JLCKernelOptions);
  load(bytes: Uint8Array, options?: { sourceName?: string }): JLCBytecodeModule;
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
export function disassembleModule(module: JLCBytecodeModule): string;

export const JLC: JLCKernel;
export const JLCVM: VMKernel;
export default JLC;
