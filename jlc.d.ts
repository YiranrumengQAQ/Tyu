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

export class JLCProgram {
  readonly kernel: JLCKernel;
  readonly ast: JLCProgramAst;
  readonly source: string;
  readonly sourceName: string;
  mount(target: string | Element, options?: JLCMountOptions): JLCAppHandle;
}

export class JLCKernel {
  readonly version: string;
  readonly options: Readonly<Required<Omit<JLCKernelOptions, "fetch" | "onError">> & Pick<JLCKernelOptions, "fetch" | "onError">>;
  constructor(options?: JLCKernelOptions);
  tokenize(source: string, options?: { sourceName?: string }): readonly JLCToken[];
  parse(source: string, options?: { sourceName?: string }): JLCProgramAst;
  compile(source: string, options?: { sourceName?: string }): JLCProgram;
  mount(source: string | JLCProgram, target: string | Element, options?: JLCMountOptions): JLCAppHandle;
  boot(root?: Document | Element, options?: JLCMountOptions): Promise<JLCAppHandle[]>;
}

export function createKernel(options?: JLCKernelOptions): JLCKernel;
export const JLC: JLCKernel;
export default JLC;
