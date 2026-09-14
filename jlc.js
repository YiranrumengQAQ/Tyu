/*
 * JLC Kernel
 * A CSP-safe, dependency-free translation kernel for declarative web programs.
 * Copyright (c) 2026 JLC contributors. MIT licensed.
 */

const VERSION = "0.1.0";
const CALLABLE = Symbol("jlc.callable");
const REQUEST = Symbol("jlc.request");
const RESOURCE_META = new WeakMap();
const BLOCKED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const BLOCKED_TAGS = new Set(["script", "iframe", "object", "embed", "base", "meta"]);
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href", "xlinkhref"]);
const BLOCKED_PROPERTIES = new Set(["innerhtml", "outerhtml", "srcdoc"]);
const ASSIGNMENT_OPERATORS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "??="]);
const BINARY_PRECEDENCE = new Map([
  ["??", 1], ["||", 2], ["&&", 3],
  ["==", 4], ["!=", 4], ["===", 4], ["!==", 4],
  ["<", 5], ["<=", 5], [">", 5], [">=", 5], ["in", 5],
  ["+", 6], ["-", 6], ["*", 7], ["/", 7], ["%", 7], ["**", 8],
]);

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

function isIdentifierStart(character) {
  return character != null && /[\p{L}_$]/u.test(character);
}

function isIdentifierPart(character) {
  return character != null && /[\p{L}\p{N}_$]/u.test(character);
}

function tokenize(source, sourceName = "<jlc>") {
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const token = (type, value, start, startLine, startColumn) => {
    tokens.push({ type, value, start, end: index, line: startLine, column: startColumn });
  };

  const advance = () => {
    const character = source[index++];
    if (character === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return character;
  };

  const fail = (message, start = index, startLine = line, startColumn = column) => {
    throw new JLCCompileError(message, {
      start,
      line: startLine,
      column: startColumn,
    }, sourceName);
  };

  while (index < source.length) {
    const character = source[index];

    if (/\s/u.test(character)) {
      advance();
      continue;
    }

    if (character === "/" && source[index + 1] === "/") {
      advance();
      advance();
      while (index < source.length && source[index] !== "\n") advance();
      continue;
    }

    if (character === "/" && source[index + 1] === "*") {
      const start = index;
      const startLine = line;
      const startColumn = column;
      advance();
      advance();
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        advance();
      }
      if (index >= source.length) fail("未结束的块注释", start, startLine, startColumn);
      advance();
      advance();
      continue;
    }

    const start = index;
    const startLine = line;
    const startColumn = column;

    if (isIdentifierStart(character)) {
      let value = "";
      while (isIdentifierPart(source[index])) value += advance();
      token("identifier", value, start, startLine, startColumn);
      continue;
    }

    if (/\d/u.test(character) || (character === "." && /\d/u.test(source[index + 1] ?? ""))) {
      let value = "";
      if (character === ".") value += advance();
      while (/\d/u.test(source[index] ?? "")) value += advance();
      if (source[index] === "." && /\d/u.test(source[index + 1] ?? "")) {
        value += advance();
        while (/\d/u.test(source[index] ?? "")) value += advance();
      }
      if (source[index] === "e" || source[index] === "E") {
        value += advance();
        if (source[index] === "+" || source[index] === "-") value += advance();
        if (!/\d/u.test(source[index] ?? "")) fail("无效的科学计数法", start, startLine, startColumn);
        while (/\d/u.test(source[index] ?? "")) value += advance();
      }
      token("number", Number(value), start, startLine, startColumn);
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      const quote = advance();
      let value = "";
      let closed = false;
      while (index < source.length) {
        const current = advance();
        if (current === quote) {
          closed = true;
          break;
        }
        if (current === "\\") {
          if (index >= source.length) break;
          if (quote === "`" && source[index] !== "`") {
            // Backticks are intended for CSS: preserve CSS escapes verbatim.
            value += "\\";
            continue;
          }
          const escaped = advance();
          const simple = {
            n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v",
            0: "\0", "\\": "\\", "'": "'", '"': '"', "`": "`",
          };
          if (Object.hasOwn(simple, escaped)) {
            value += simple[escaped];
          } else if (escaped === "x") {
            const hex = source.slice(index, index + 2);
            if (!/^[\da-f]{2}$/iu.test(hex)) fail("无效的十六进制转义", start, startLine, startColumn);
            value += String.fromCodePoint(Number.parseInt(hex, 16));
            advance();
            advance();
          } else if (escaped === "u") {
            if (source[index] === "{") {
              advance();
              let hex = "";
              while (index < source.length && source[index] !== "}") hex += advance();
              if (source[index] !== "}" || !/^[\da-f]{1,6}$/iu.test(hex)) {
                fail("无效的 Unicode 转义", start, startLine, startColumn);
              }
              advance();
              value += String.fromCodePoint(Number.parseInt(hex, 16));
            } else {
              const hex = source.slice(index, index + 4);
              if (!/^[\da-f]{4}$/iu.test(hex)) fail("无效的 Unicode 转义", start, startLine, startColumn);
              value += String.fromCodePoint(Number.parseInt(hex, 16));
              for (let count = 0; count < 4; count += 1) advance();
            }
          } else {
            value += escaped;
          }
        } else {
          value += current;
        }
      }
      if (!closed) fail("未结束的字符串", start, startLine, startColumn);
      token("string", value, start, startLine, startColumn);
      continue;
    }

    const operators = ["===", "!==", "??=", "**", "==", "!=", "<=", ">=", "&&", "||", "??", "+=", "-=", "*=", "/=", "%="];
    const operator = operators.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      for (let count = 0; count < operator.length; count += 1) advance();
      token("operator", operator, start, startLine, startColumn);
      continue;
    }

    if ("{}()[],:;.?+-*/%!=<>".includes(character)) {
      const value = advance();
      token("punctuation", value, start, startLine, startColumn);
      continue;
    }

    fail(`无法识别的字符 ${JSON.stringify(character)}`, start, startLine, startColumn);
  }

  tokens.push({ type: "eof", value: "<eof>", start: index, end: index, line, column });
  return tokens;
}

class Parser {
  constructor(source, options = {}) {
    this.sourceName = options.sourceName ?? "<jlc>";
    this.tokens = tokenize(source, this.sourceName);
    this.position = 0;
  }

  current(offset = 0) {
    return this.tokens[Math.min(this.position + offset, this.tokens.length - 1)];
  }

  advance() {
    const current = this.current();
    if (current.type !== "eof") this.position += 1;
    return current;
  }

  error(message, at = this.current()) {
    throw new JLCCompileError(message, at, this.sourceName);
  }

  is(value) {
    return this.current().value === value;
  }

  isWord(value) {
    return this.current().type === "identifier" && this.current().value === value;
  }

  match(value) {
    if (!this.is(value)) return false;
    this.advance();
    return true;
  }

  matchWord(value) {
    if (!this.isWord(value)) return false;
    this.advance();
    return true;
  }

  expect(value, message = `应为“${value}”`) {
    if (!this.is(value)) this.error(message);
    return this.advance();
  }

  expectWord(value, message = `应为关键字“${value}”`) {
    if (!this.isWord(value)) this.error(message);
    return this.advance();
  }

  expectIdentifier(message = "应为标识符") {
    if (this.current().type !== "identifier") this.error(message);
    return this.advance();
  }

  terminator() {
    if (this.match(";")) return;
    if (this.is("}")) return;
    this.error("语句末尾缺少分号“;”");
  }

  parseProgram() {
    const start = this.current();
    this.expectWord("app", "JLC 程序必须以 app 开始");
    const name = this.expectIdentifier("app 后必须有应用名").value;
    this.expect("{");

    const declarations = [];
    let view = null;
    while (!this.is("}")) {
      if (this.current().type === "eof") this.error("app 块未结束");
      if (this.matchWord("state")) {
        const identifier = this.expectIdentifier("state 后必须有状态名");
        this.expect("=");
        declarations.push({ type: "StateDeclaration", name: identifier.value, value: this.parseExpression(), loc: identifier });
        this.terminator();
      } else if (this.matchWord("derive")) {
        const identifier = this.expectIdentifier("derive 后必须有派生状态名");
        this.expect("=");
        declarations.push({ type: "DeriveDeclaration", name: identifier.value, value: this.parseExpression(), loc: identifier });
        this.terminator();
      } else if (this.matchWord("resource")) {
        const identifier = this.expectIdentifier("resource 后必须有资源名");
        this.expect("=");
        declarations.push({ type: "ResourceDeclaration", name: identifier.value, value: this.parseExpression(), loc: identifier });
        this.terminator();
      } else if (this.matchWord("action")) {
        declarations.push(this.parseAction());
      } else if (this.matchWord("style")) {
        const loc = this.current();
        declarations.push({ type: "StyleDeclaration", value: this.parseExpression(), loc });
        this.terminator();
      } else if (this.matchWord("view")) {
        if (view) this.error("一个 app 只能声明一个 view");
        view = { type: "View", children: this.parseViewBlock() };
      } else {
        this.error(`app 中不支持“${this.current().value}”，可用 state、derive、resource、action、style 或 view`);
      }
    }
    this.expect("}");
    if (this.current().type !== "eof") this.error("app 结束后存在多余内容");
    if (!view) this.error("app 必须声明 view", start);
    return { type: "Program", name, declarations, view, loc: start };
  }

  parseAction() {
    const identifier = this.expectIdentifier("action 后必须有动作名");
    const parameters = [];
    this.expect("(");
    if (!this.is(")")) {
      do {
        const parameter = this.expectIdentifier("无效的动作参数");
        let defaultValue = null;
        if (this.match("=")) defaultValue = this.parseExpression();
        parameters.push({ name: parameter.value, defaultValue, loc: parameter });
      } while (this.match(","));
    }
    this.expect(")");
    return {
      type: "ActionDeclaration",
      name: identifier.value,
      parameters,
      body: this.parseStatementBlock(),
      loc: identifier,
    };
  }

  parseViewBlock() {
    this.expect("{");
    const children = [];
    while (!this.is("}")) {
      if (this.current().type === "eof") this.error("view 块未结束");
      children.push(this.parseViewNode());
    }
    this.expect("}");
    return children;
  }

  parseViewNode() {
    if (this.matchWord("text")) {
      const loc = this.current();
      const value = this.parseExpression();
      this.terminator();
      return { type: "TextNode", value, loc };
    }

    if (this.matchWord("when")) {
      const loc = this.current(-1);
      this.expect("(");
      const test = this.parseExpression();
      this.expect(")");
      const consequent = this.parseViewBlock();
      const alternate = this.matchWord("else") ? this.parseViewBlock() : [];
      return { type: "WhenNode", test, consequent, alternate, loc };
    }

    if (this.matchWord("each")) {
      const loc = this.current(-1);
      this.expect("(");
      const item = this.expectIdentifier("each 需要项目变量").value;
      let index = null;
      if (this.match(",")) index = this.expectIdentifier("无效的索引变量").value;
      this.expectWord("in", "each 变量后应为 in");
      const iterable = this.parseExpression();
      let key = null;
      if (this.matchWord("key")) key = this.parseExpression();
      this.expect(")");
      const body = this.parseViewBlock();
      const alternate = this.matchWord("else") ? this.parseViewBlock() : [];
      return { type: "EachNode", item, index, iterable, key, body, alternate, loc };
    }

    const tagToken = this.expectIdentifier("view 中应为元素、text、when 或 each");
    let tag = tagToken.value;
    while (this.match("-")) tag += `-${this.expectIdentifier("自定义元素名的连字符后缺少名称").value}`;
    const attributes = [];
    if (this.match("(")) {
      if (!this.is(")")) {
        do {
          const first = this.expectIdentifier("无效的属性名");
          let name = first.value;
          while (this.is(":") || this.is(".")) {
            const separator = this.advance().value;
            name += `${separator}${this.expectIdentifier("属性修饰符不完整").value}`;
          }
          this.expect("=");
          let value;
          if (name.startsWith("on:") && this.is("{")) {
            value = { type: "EventBlock", body: this.parseStatementBlock(), loc: first };
          } else {
            value = this.parseExpression();
          }
          attributes.push({ type: "Attribute", name, value, loc: first });
        } while (this.match(","));
      }
      this.expect(")");
    }
    let children = [];
    if (this.is("{")) children = this.parseViewBlock();
    else this.terminator();
    return { type: "ElementNode", tag, attributes, children, loc: tagToken };
  }

  parseStatementBlock() {
    this.expect("{");
    const statements = [];
    while (!this.is("}")) {
      if (this.current().type === "eof") this.error("动作块未结束");
      statements.push(this.parseStatement());
    }
    this.expect("}");
    return statements;
  }

  parseStatement() {
    const loc = this.current();
    if (this.matchWord("let")) {
      const identifier = this.expectIdentifier("let 后必须有变量名");
      const value = this.match("=") ? this.parseExpression() : { type: "Literal", value: null, loc: identifier };
      this.terminator();
      return { type: "LetStatement", name: identifier.value, value, loc };
    }

    if (this.matchWord("if")) {
      this.expect("(");
      const test = this.parseExpression();
      this.expect(")");
      const consequent = this.parseStatementBlock();
      let alternate = [];
      if (this.matchWord("else")) {
        alternate = this.matchWord("if")
          ? [{ type: "IfStatement", ...this.parseIfTail(), loc: this.current(-1) }]
          : this.parseStatementBlock();
      }
      return { type: "IfStatement", test, consequent, alternate, loc };
    }

    if (this.matchWord("for")) {
      this.expect("(");
      const item = this.expectIdentifier("for 需要项目变量").value;
      let index = null;
      if (this.match(",")) index = this.expectIdentifier("无效的索引变量").value;
      this.expectWord("in", "for 变量后应为 in");
      const iterable = this.parseExpression();
      this.expect(")");
      return { type: "ForStatement", item, index, iterable, body: this.parseStatementBlock(), loc };
    }

    if (this.matchWord("return")) {
      const value = this.is(";") || this.is("}") ? null : this.parseExpression();
      this.terminator();
      return { type: "ReturnStatement", value, loc };
    }

    if (this.matchWord("after") || this.matchWord("every")) {
      const mode = this.current(-1).value;
      this.expect("(");
      const delay = this.parseExpression();
      this.expect(")");
      return { type: "TimerStatement", mode, delay, body: this.parseStatementBlock(), loc };
    }

    const expression = this.parseExpression();
    if (ASSIGNMENT_OPERATORS.has(this.current().value)) {
      const operator = this.advance().value;
      const value = this.parseExpression();
      this.terminator();
      return { type: "AssignmentStatement", target: expression, operator, value, loc };
    }
    this.terminator();
    return { type: "ExpressionStatement", expression, loc };
  }

  parseIfTail() {
    this.expect("(");
    const test = this.parseExpression();
    this.expect(")");
    const consequent = this.parseStatementBlock();
    let alternate = [];
    if (this.matchWord("else")) {
      alternate = this.matchWord("if")
        ? [{ type: "IfStatement", ...this.parseIfTail(), loc: this.current(-1) }]
        : this.parseStatementBlock();
    }
    return { test, consequent, alternate };
  }

  parseExpression(minimumPrecedence = 0) {
    let left = this.parseUnary();
    while (true) {
      const value = this.current().value;
      const precedence = BINARY_PRECEDENCE.get(value);
      if (precedence == null || precedence < minimumPrecedence) break;
      const operator = this.advance();
      const right = this.parseExpression(precedence + (value === "**" ? 0 : 1));
      left = { type: "BinaryExpression", operator: value, left, right, loc: operator };
    }
    if (minimumPrecedence === 0 && this.match("?")) {
      const consequent = this.parseExpression();
      this.expect(":");
      const alternate = this.parseExpression();
      left = { type: "ConditionalExpression", test: left, consequent, alternate, loc: left.loc };
    }
    return left;
  }

  parseUnary() {
    if (["!", "-", "+"].includes(this.current().value) || this.isWord("not")) {
      const operator = this.advance();
      return { type: "UnaryExpression", operator: operator.value, argument: this.parseUnary(), loc: operator };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  parsePostfix(base) {
    let expression = base;
    while (true) {
      if (this.match(".")) {
        const property = this.expectIdentifier("点号后缺少属性名");
        expression = {
          type: "MemberExpression",
          object: expression,
          property: { type: "Literal", value: property.value, loc: property },
          computed: false,
          loc: property,
        };
      } else if (this.match("[")) {
        const property = this.parseExpression();
        this.expect("]");
        expression = { type: "MemberExpression", object: expression, property, computed: true, loc: property.loc };
      } else if (this.match("(")) {
        const argumentsList = [];
        if (!this.is(")")) {
          do argumentsList.push(this.parseExpression()); while (this.match(","));
        }
        this.expect(")");
        expression = { type: "CallExpression", callee: expression, arguments: argumentsList, loc: expression.loc };
      } else {
        break;
      }
    }
    return expression;
  }

  parsePrimary() {
    const current = this.current();
    if (current.type === "number" || current.type === "string") {
      this.advance();
      return { type: "Literal", value: current.value, loc: current };
    }
    if (current.type === "identifier") {
      if (["true", "false", "null"].includes(current.value)) {
        this.advance();
        return {
          type: "Literal",
          value: current.value === "true" ? true : current.value === "false" ? false : null,
          loc: current,
        };
      }
      this.advance();
      return { type: "Identifier", name: current.value, loc: current };
    }
    if (this.match("(")) {
      const expression = this.parseExpression();
      this.expect(")");
      return expression;
    }
    if (this.match("[")) {
      const elements = [];
      if (!this.is("]")) {
        do elements.push(this.parseExpression()); while (this.match(",") && !this.is("]"));
      }
      this.expect("]");
      return { type: "ArrayExpression", elements, loc: current };
    }
    if (this.match("{")) {
      const properties = [];
      if (!this.is("}")) {
        do {
          const key = this.current();
          if (key.type !== "identifier" && key.type !== "string" && key.type !== "number") {
            this.error("对象键必须是名称、字符串或数字");
          }
          this.advance();
          let value;
          if (this.match(":")) value = this.parseExpression();
          else if (key.type === "identifier") value = { type: "Identifier", name: key.value, loc: key };
          else this.error("非标识符对象键后缺少冒号");
          properties.push({ key: String(key.value), value, loc: key });
        } while (this.match(",") && !this.is("}"));
      }
      this.expect("}");
      return { type: "ObjectExpression", properties, loc: current };
    }
    this.error(`无法解析表达式“${current.value}”`);
  }
}

function deepFreeze(value, seen = new WeakSet()) {
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

class Environment {
  constructor(parent = null) {
    this.parent = parent;
    this.bindings = new Map();
  }

  define(name, binding) {
    if (this.bindings.has(name)) throw new JLCRuntimeError(`名称“${name}”重复定义`);
    this.bindings.set(name, binding);
    return binding;
  }

  resolve(name) {
    if (this.bindings.has(name)) return this.bindings.get(name);
    if (this.parent) return this.parent.resolve(name);
    throw new JLCRuntimeError(`未定义名称“${name}”`);
  }

  clear() {
    this.bindings.clear();
    this.parent = null;
  }
}

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

function bindingValue(binding) {
  if (binding.kind === "signal") return binding.signal.get();
  return binding.value;
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

function evaluate(expression, environment, context) {
  context.steps += 1;
  if (context.steps > context.runtime.options.maxSteps) throw new JLCRuntimeError("单次动作运算步数超限");

  switch (expression.type) {
    case "Literal":
      return expression.value;
    case "Identifier":
      return bindingValue(environment.resolve(expression.name));
    case "ArrayExpression":
      return expression.elements.map((element) => evaluate(element, environment, context));
    case "ObjectExpression": {
      const output = Object.create(null);
      for (const property of expression.properties) output[property.key] = evaluate(property.value, environment, context);
      return output;
    }
    case "MemberExpression":
      return readMember(evaluate(expression.object, environment, context), evaluate(expression.property, environment, context));
    case "UnaryExpression": {
      const value = evaluate(expression.argument, environment, context);
      if (expression.operator === "!" || expression.operator === "not") return !value;
      if (expression.operator === "-") return -requireNumber(value);
      if (expression.operator === "+") return requireNumber(value);
      throw new JLCRuntimeError(`不支持一元运算符 ${expression.operator}`);
    }
    case "BinaryExpression":
      return evaluateBinary(expression, environment, context);
    case "ConditionalExpression":
      return evaluate(expression.test, environment, context)
        ? evaluate(expression.consequent, environment, context)
        : evaluate(expression.alternate, environment, context);
    case "CallExpression": {
      const callee = evaluate(expression.callee, environment, context);
      if (!callee?.[CALLABLE]) throw new JLCRuntimeError("只能调用 JLC action、内建函数或显式 capability");
      const argumentsList = expression.arguments.map((argument) => evaluate(argument, environment, context));
      return callee.invoke(argumentsList, context);
    }
    default:
      throw new JLCRuntimeError(`未知表达式 ${expression.type}`);
  }
}

function evaluateBinary(expression, environment, context) {
  const operator = expression.operator;
  const left = evaluate(expression.left, environment, context);
  if (operator === "&&") return left && evaluate(expression.right, environment, context);
  if (operator === "||") return left || evaluate(expression.right, environment, context);
  if (operator === "??") return left ?? evaluate(expression.right, environment, context);
  const right = evaluate(expression.right, environment, context);
  switch (operator) {
    case "+":
      return typeof left === "string" || typeof right === "string"
        ? `${left ?? ""}${right ?? ""}`
        : requireNumber(left) + requireNumber(right);
    case "-": return requireNumber(left) - requireNumber(right);
    case "*": return requireNumber(left) * requireNumber(right);
    case "/": return requireNumber(left) / requireNumber(right);
    case "%": return requireNumber(left) % requireNumber(right);
    case "**": return requireNumber(left) ** requireNumber(right);
    case "==": case "===": return Object.is(left, right);
    case "!=": case "!==": return !Object.is(left, right);
    case "<": return left < right;
    case "<=": return left <= right;
    case ">": return left > right;
    case ">=": return left >= right;
    case "in": return ownData(right) && Object.hasOwn(right, safeKey(left));
    default: throw new JLCRuntimeError(`不支持二元运算符 ${operator}`);
  }
}

function lvalueParts(expression, environment, context) {
  if (expression.type === "Identifier") return { name: expression.name, keys: [] };
  if (expression.type !== "MemberExpression") throw new JLCRuntimeError("赋值左侧必须是状态或状态字段");
  const keys = [];
  let current = expression;
  while (current.type === "MemberExpression") {
    keys.unshift(safeKey(evaluate(current.property, environment, context)));
    current = current.object;
  }
  if (current.type !== "Identifier") throw new JLCRuntimeError("嵌套赋值必须始于状态名");
  return { name: current.name, keys };
}

function immutableSet(root, keys, value) {
  if (!keys.length) return value;
  const [key, ...rest] = keys;
  const array = Array.isArray(root);
  const output = array ? [...root] : Object.assign(Object.create(null), ownData(root) ? root : null);
  output[key] = immutableSet(readMember(root, key), rest, value);
  return output;
}

function assign(expression, value, environment, context) {
  const { name, keys } = lvalueParts(expression, environment, context);
  const binding = environment.resolve(name);
  if (binding.kind === "signal") {
    if (!binding.signal.writable) throw new JLCRuntimeError(`“${name}”是只读状态`);
    const next = keys.length ? immutableSet(binding.signal.get(), keys, sanitizeValue(value)) : sanitizeValue(value);
    binding.signal.set(next);
    return next;
  }
  if (binding.kind === "local" && binding.writable) {
    binding.value = keys.length ? immutableSet(binding.value, keys, sanitizeValue(value)) : sanitizeValue(value);
    return binding.value;
  }
  throw new JLCRuntimeError(`“${name}”不可赋值`);
}

const RETURN = Symbol("return");

function executeStatements(statements, environment, context) {
  for (const statement of statements) {
    context.steps += 1;
    if (context.steps > context.runtime.options.maxSteps) throw new JLCRuntimeError("单次动作运算步数超限");
    switch (statement.type) {
      case "LetStatement":
        environment.define(statement.name, {
          kind: "local",
          value: sanitizeValue(evaluate(statement.value, environment, context)),
          writable: true,
        });
        break;
      case "AssignmentStatement": {
        const previous = statement.operator === "=" ? null : evaluate(statement.target, environment, context);
        const incoming = evaluate(statement.value, environment, context);
        let next = incoming;
        if (statement.operator === "+=") next = typeof previous === "string" || typeof incoming === "string"
          ? `${previous ?? ""}${incoming ?? ""}` : requireNumber(previous) + requireNumber(incoming);
        else if (statement.operator === "-=") next = requireNumber(previous) - requireNumber(incoming);
        else if (statement.operator === "*=") next = requireNumber(previous) * requireNumber(incoming);
        else if (statement.operator === "/=") next = requireNumber(previous) / requireNumber(incoming);
        else if (statement.operator === "%=") next = requireNumber(previous) % requireNumber(incoming);
        else if (statement.operator === "??=") next = previous ?? incoming;
        assign(statement.target, next, environment, context);
        break;
      }
      case "ExpressionStatement":
        evaluate(statement.expression, environment, context);
        break;
      case "IfStatement": {
        const branch = evaluate(statement.test, environment, context) ? statement.consequent : statement.alternate;
        const result = executeStatements(branch, new Environment(environment), context);
        if (result?.type === RETURN) return result;
        break;
      }
      case "ForStatement": {
        const values = normalizeIterable(evaluate(statement.iterable, environment, context));
        if (values.length > context.runtime.options.maxLoop) throw new JLCRuntimeError("for 循环项目数超限");
        for (let index = 0; index < values.length; index += 1) {
          const child = new Environment(environment);
          child.define(statement.item, { kind: "local", value: values[index], writable: false });
          if (statement.index) child.define(statement.index, { kind: "local", value: index, writable: false });
          const result = executeStatements(statement.body, child, context);
          if (result?.type === RETURN) return result;
        }
        break;
      }
      case "ReturnStatement":
        return { type: RETURN, value: statement.value ? evaluate(statement.value, environment, context) : null };
      case "TimerStatement":
        createTimer(statement, environment, context);
        break;
      default:
        throw new JLCRuntimeError(`未知语句 ${statement.type}`);
    }
  }
  return null;
}

function createTimer(statement, environment, context) {
  const delay = Math.max(0, requireNumber(evaluate(statement.delay, environment, context), "定时器延迟"));
  const { runtime, scope } = context;
  if (!scope || scope.disposed) throw new JLCRuntimeError("定时器没有可用的生命周期作用域");
  runtime.metrics.timers += 1;
  let active = true;
  let timer;
  const cleanup = () => {
    if (!active) return;
    active = false;
    if (statement.mode === "after") {
      if (runtime.window?.clearTimeout) runtime.window.clearTimeout(timer);
      else clearTimeout(timer);
    } else if (runtime.window?.clearInterval) runtime.window.clearInterval(timer);
    else clearInterval(timer);
    runtime.metrics.timers -= 1;
  };
  const release = scope.own(cleanup);
  const run = () => {
    if (!active || runtime.destroyed) return;
    if (statement.mode === "after") release();
    const timerContext = runtime.context(scope);
    try {
      runtime.batch(() => executeStatements(statement.body, new Environment(environment), timerContext));
    } catch (error) {
      runtime.reportError(error);
    }
  };
  if (statement.mode === "after") timer = runtime.window?.setTimeout?.(run, delay) ?? setTimeout(run, delay);
  else timer = runtime.window?.setInterval?.(run, delay) ?? setInterval(run, delay);
}

function normalizeIterable(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  if (ownData(value)) return Object.values(value);
  return [];
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
    this.environment = new Environment();
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
    for (const binding of this.environment?.bindings.values() ?? []) {
      if (binding.kind === "signal") binding.signal.detach();
    }
    this.routeSignal?.detach();
    this.environment?.clear();
    this.rootScope = null;
    this.environment = null;
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

function installEnvironment(runtime, program) {
  const environment = runtime.environment;
  const reserved = new Set();
  const define = (name, binding) => {
    if (reserved.has(name) || environment.bindings.has(name)) throw new JLCRuntimeError(`名称“${name}”重复定义`);
    environment.define(name, binding);
  };

  for (const [name, binding] of createBuiltins(runtime)) {
    reserved.add(name);
    environment.define(name, binding);
  }
  environment.define("$route", { kind: "signal", signal: runtime.routeSignal });
  reserved.add("$route");

  for (const [name, function_] of Object.entries(runtime.capabilities ?? {})) {
    if (reserved.has(name)) throw new JLCRuntimeError(`capability“${name}”与内建名称冲突`);
    if (typeof function_ !== "function") throw new JLCRuntimeError(`capability“${name}”必须是函数`);
    reserved.add(name);
    environment.define(name, {
      kind: "value",
      value: callable(name, (argumentsList) => {
        const result = function_(...argumentsList);
        if (result && typeof result.then === "function") {
          throw new JLCRuntimeError(`同步表达式中的 capability“${name}”不能返回 Promise，请使用 resource + http`);
        }
        return sanitizeValue(result);
      }),
    });
  }

  const declarations = program.declarations.filter((declaration) => declaration.type !== "StyleDeclaration");
  for (const declaration of declarations) {
    if (reserved.has(declaration.name) || environment.bindings.has(declaration.name)) {
      throw new JLCRuntimeError(`声明名“${declaration.name}”重复或被保留`);
    }
    if (declaration.type === "StateDeclaration") {
      define(declaration.name, { kind: "signal", signal: new Signal(runtime, null, true, declaration.name) });
    } else if (declaration.type === "DeriveDeclaration") {
      define(declaration.name, { kind: "signal", signal: new Signal(runtime, null, false, declaration.name) });
    } else if (declaration.type === "ResourceDeclaration") {
      define(declaration.name, { kind: "signal", signal: new Signal(runtime, null, false, declaration.name) });
    } else if (declaration.type === "ActionDeclaration") {
      define(declaration.name, { kind: "value", value: createAction(runtime, declaration, environment) });
    }
  }

  const initialContext = runtime.context();
  for (const declaration of declarations) {
    if (declaration.type !== "StateDeclaration") continue;
    const overridden = Object.hasOwn(runtime.initialState, declaration.name);
    const value = overridden ? runtime.initialState[declaration.name] : evaluate(declaration.value, environment, initialContext);
    environment.resolve(declaration.name).signal.set(sanitizeValue(value), true);
  }

  for (const declaration of declarations) {
    if (declaration.type !== "DeriveDeclaration") continue;
    const signal = environment.resolve(declaration.name).signal;
    runtime.effect(runtime.rootScope, () => {
      signal.computing = true;
      try {
        signal.set(sanitizeValue(evaluate(declaration.value, environment, runtime.context())), true);
      } finally {
        signal.computing = false;
      }
    }, 0, signal);
  }

  for (const declaration of declarations) {
    if (declaration.type === "ResourceDeclaration") installResource(runtime, declaration, environment);
  }

  if (runtime.window?.addEventListener) {
    runtime.listen(runtime.rootScope, runtime.window, "popstate", () => {
      runtime.routeSignal.set(createRouteSnapshot(runtime.window), true);
    });
  }
}

function createAction(runtime, declaration, closure) {
  return callable(declaration.name, (argumentsList, parentContext) => {
    if (parentContext.depth >= 100) throw new JLCRuntimeError("action 调用深度超过 100");
    const environment = new Environment(closure);
    const context = {
      runtime,
      scope: parentContext.scope ?? runtime.rootScope,
      steps: parentContext.steps,
      depth: parentContext.depth + 1,
    };
    for (let index = 0; index < declaration.parameters.length; index += 1) {
      const parameter = declaration.parameters[index];
      const value = index < argumentsList.length
        ? argumentsList[index]
        : parameter.defaultValue
          ? evaluate(parameter.defaultValue, environment, context)
          : null;
      environment.define(parameter.name, { kind: "local", value: sanitizeValue(value), writable: true });
    }
    const result = executeStatements(declaration.body, environment, context);
    parentContext.steps = context.steps;
    return result?.type === RETURN ? result.value : null;
  });
}

function resourceSnapshot(resource, data = null, error = null, loading = false, status = null) {
  const snapshot = Object.freeze({ data, error, loading, status });
  RESOURCE_META.set(snapshot, resource);
  return snapshot;
}

function installResource(runtime, declaration, environment) {
  const signal = environment.resolve(declaration.name).signal;
  const refresh = new Signal(runtime, 0, true, `${declaration.name}:reload`);
  const resource = {
    reload() {
      refresh.set(refresh.get() + 1);
    },
  };
  signal.set(resourceSnapshot(resource, null, null, true, null), true);

  runtime.effect(runtime.rootScope, () => {
    refresh.get();
    const descriptor = evaluate(declaration.value, environment, runtime.context());
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

function installStyles(runtime, program) {
  for (const declaration of program.declarations) {
    if (declaration.type !== "StyleDeclaration") continue;
    const style = runtime.document.createElement("style");
    style.setAttribute("data-jlc-style", program.name);
    (runtime.document.head ?? runtime.target).appendChild(style);
    runtime.rootScope.own(() => style.remove());
    runtime.effect(runtime.rootScope, () => {
      style.textContent = String(evaluate(declaration.value, runtime.environment, runtime.context()) ?? "");
    });
  }
}

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

function installAttribute(attribute, element, environment, scope, runtime) {
  const name = attribute.name;
  if (name.startsWith("on:")) {
    installEvent(attribute, element, environment, scope, runtime);
    return;
  }
  if (name.startsWith("bind:")) {
    installBinding(attribute, element, environment, scope, runtime);
    return;
  }
  if (name.startsWith("class:")) {
    const className = name.slice(6).replaceAll(":", "-");
    runtime.effect(scope, () => element.classList.toggle(className, Boolean(evaluate(attribute.value, environment, runtime.context(scope)))), 2);
    return;
  }
  if (name.startsWith("style:")) {
    const property = name.slice(6).replaceAll(":", "-");
    runtime.effect(scope, () => {
      const value = evaluate(attribute.value, environment, runtime.context(scope));
      if (value == null || value === false) element.style.removeProperty(property);
      else element.style.setProperty(property, String(value));
    }, 2);
    return;
  }
  if (name.startsWith("prop:")) {
    const property = safeKey(name.slice(5));
    const normalizedProperty = property.toLowerCase();
    if (BLOCKED_PROPERTIES.has(normalizedProperty) || normalizedProperty.startsWith("on")) {
      throw new JLCRuntimeError(`安全模式禁止设置 DOM property“${property}”`);
    }
    runtime.effect(scope, () => {
      let value = evaluate(attribute.value, environment, runtime.context(scope));
      if (URL_ATTRIBUTES.has(normalizedProperty)) value = sanitizeUrl(value);
      element[property] = value;
    });
    return;
  }
  if (name === "style") {
    let previous = new Set();
    runtime.effect(scope, () => {
      const value = evaluate(attribute.value, environment, runtime.context(scope));
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
    return;
  }
  runtime.effect(scope, () => setNormalAttribute(element, name, evaluate(attribute.value, environment, runtime.context(scope))));
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

function installEvent(attribute, element, environment, scope, runtime) {
  const specification = attribute.name.slice(3);
  const [type, ...modifiers] = specification.split(".");
  if (!type) throw new JLCRuntimeError("事件名不能为空");
  const modifierSet = new Set(modifiers);
  const options = {
    capture: modifierSet.has("capture"),
    once: modifierSet.has("once"),
    passive: modifierSet.has("passive"),
  };
  runtime.listen(scope, element, type, (event) => {
    if (modifierSet.has("self") && event.target !== element) return;
    if (modifierSet.has("prevent") && !options.passive) event.preventDefault();
    if (modifierSet.has("stop")) event.stopPropagation();
    const eventEnvironment = new Environment(environment);
    eventEnvironment.define("$event", { kind: "value", value: eventSnapshot(event) });
    const context = runtime.context(scope);
    try {
      runtime.batch(() => {
        if (attribute.value.type === "EventBlock") {
          executeStatements(attribute.value.body, eventEnvironment, context);
        } else {
          const result = evaluate(attribute.value, eventEnvironment, context);
          if (result?.[CALLABLE]) result.invoke([], context);
        }
      });
    } catch (error) {
      runtime.reportError(error);
    }
  }, options);
}

function installBinding(attribute, element, environment, scope, runtime) {
  const property = safeKey(attribute.name.slice(5));
  if (!property) throw new JLCRuntimeError("bind 缺少属性名");
  lvalueParts(attribute.value, environment, runtime.context(scope));
  runtime.effect(scope, () => {
    const value = evaluate(attribute.value, environment, runtime.context(scope));
    const normalized = property === "checked" ? Boolean(value) : value ?? "";
    if (!Object.is(element[property], normalized)) element[property] = normalized;
  });
  const eventType = property === "value" && ["INPUT", "TEXTAREA"].includes(element.tagName)
    ? "input"
    : "change";
  runtime.listen(scope, element, eventType, () => {
    try {
      runtime.batch(() => assign(attribute.value, property === "checked" ? Boolean(element[property]) : element[property], environment, runtime.context(scope)));
    } catch (error) {
      runtime.reportError(error);
    }
  });
}

function registerOwnedNode(runtime, scope, node) {
  runtime.ownedNodes.set(node, scope);
  scope.own(() => runtime.ownedNodes?.delete(node));
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

function renderNodes(nodes, parent, before, environment, scope, runtime, namespace = null) {
  for (const node of nodes) {
    if (node.type === "TextNode") {
      const text = runtime.document.createTextNode("");
      const textScope = scope.child("text");
      registerOwnedNode(runtime, textScope, text);
      parent.insertBefore(text, before);
      runtime.effect(textScope, () => {
        text.data = toText(evaluate(node.value, environment, runtime.context(textScope)));
      });
    } else if (node.type === "ElementNode") {
      const created = createElement(runtime.document, node.tag, namespace);
      const childScope = scope.child(`<${node.tag}>`);
      registerOwnedNode(runtime, childScope, created.element);
      const attributeLayer = (attribute) => {
        if (attribute.name === "class" || attribute.name === "style") return 0;
        if (attribute.name.startsWith("class:") || attribute.name.startsWith("style:") || attribute.name.startsWith("bind:")) return 2;
        return 1;
      };
      for (const attribute of [...node.attributes].sort((left, right) => attributeLayer(left) - attributeLayer(right))) {
        installAttribute(attribute, created.element, environment, childScope, runtime);
      }
      renderNodes(node.children, created.element, null, environment, childScope, runtime, created.namespace);
      parent.insertBefore(created.element, before);
    } else if (node.type === "WhenNode") {
      renderWhen(node, parent, before, environment, scope, runtime, namespace);
    } else if (node.type === "EachNode") {
      renderEach(node, parent, before, environment, scope, runtime, namespace);
    } else {
      throw new JLCRuntimeError(`未知视图节点 ${node.type}`);
    }
  }
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

function renderWhen(node, parent, before, environment, scope, runtime, namespace) {
  const start = runtime.document.createComment("jlc:when");
  const end = runtime.document.createComment("/jlc:when");
  parent.insertBefore(start, before);
  parent.insertBefore(end, before);
  const controlScope = scope.child("when");
  let branchScope = null;
  let current = null;
  runtime.effect(controlScope, () => {
    const next = Boolean(evaluate(node.test, environment, runtime.context(controlScope)));
    if (next === current) return;
    branchScope?.dispose();
    clearBetween(start, end);
    branchScope = controlScope.child(next ? "when:yes" : "when:no");
    renderNodes(next ? node.consequent : node.alternate, parent, end, environment, branchScope, runtime, namespace);
    current = next;
  });
}

function renderEach(node, parent, before, environment, scope, runtime, namespace) {
  const start = runtime.document.createComment("jlc:each");
  const end = runtime.document.createComment("/jlc:each");
  parent.insertBefore(start, before);
  parent.insertBefore(end, before);
  const controlScope = scope.child("each");
  let records = new Map();
  let emptyRecord = null;

  runtime.effect(controlScope, () => {
    const values = normalizeIterable(evaluate(node.iterable, environment, runtime.context(controlScope)));
    if (values.length > runtime.options.maxLoop) throw new JLCRuntimeError("each 项目数超限");
    const keys = [];
    const seen = new Set();
    for (let index = 0; index < values.length; index += 1) {
      let key = index;
      if (node.key) {
        const keyEnvironment = new Environment(environment);
        keyEnvironment.define(node.item, { kind: "local", value: values[index], writable: false });
        if (node.index) keyEnvironment.define(node.index, { kind: "local", value: index, writable: false });
        key = evaluate(node.key, keyEnvironment, runtime.context(controlScope));
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
        const recordEnvironment = new Environment(environment);
        const item = new Signal(runtime, values[index], false, node.item);
        const indexSignal = node.index ? new Signal(runtime, index, false, node.index) : null;
        recordEnvironment.define(node.item, { kind: "signal", signal: item });
        if (node.index) recordEnvironment.define(node.index, { kind: "signal", signal: indexSignal });
        const recordStart = runtime.document.createComment("jlc:item");
        const recordEnd = runtime.document.createComment("/jlc:item");
        parent.insertBefore(recordStart, end);
        parent.insertBefore(recordEnd, end);
        renderNodes(node.body, parent, recordEnd, recordEnvironment, recordScope, runtime, namespace);
        record = { scope: recordScope, environment: recordEnvironment, item, index: indexSignal, start: recordStart, end: recordEnd };
      }
      nextRecords.set(key, record);
    }

    for (const [key, record] of records) {
      if (!nextRecords.has(key)) {
        record.scope.dispose();
        record.item.detach();
        record.index?.detach();
        record.environment.clear();
        removeInclusive(record.start, record.end);
      }
    }
    records = nextRecords;

    let cursor = end;
    const ordered = [...records.values()];
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      moveInclusive(parent, ordered[index].start, ordered[index].end, cursor);
      cursor = ordered[index].start;
    }

    if (values.length === 0 && !emptyRecord) {
      const emptyStart = runtime.document.createComment("jlc:empty");
      const emptyEnd = runtime.document.createComment("/jlc:empty");
      parent.insertBefore(emptyStart, end);
      parent.insertBefore(emptyEnd, end);
      const emptyScope = controlScope.child("each:empty");
      renderNodes(node.alternate, parent, emptyEnd, environment, emptyScope, runtime, namespace);
      emptyRecord = { scope: emptyScope, start: emptyStart, end: emptyEnd };
    } else if (values.length > 0 && emptyRecord) {
      emptyRecord.scope.dispose();
      removeInclusive(emptyRecord.start, emptyRecord.end);
      emptyRecord = null;
    }
  });
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

export class JLCProgram {
  constructor(kernel, ast, source, sourceName) {
    this.kernel = kernel;
    this.ast = ast;
    this.source = source;
    this.sourceName = sourceName;
    Object.freeze(this);
  }

  mount(target, options = {}) {
    return this.kernel.mount(this, target, options);
  }
}

export class JLCKernel {
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

  tokenize(source, options = {}) {
    return tokenize(String(source), options.sourceName ?? "<jlc>").map((item) => Object.freeze({ ...item }));
  }

  parse(source, options = {}) {
    return deepFreeze(new Parser(String(source), options).parseProgram());
  }

  compile(source, options = {}) {
    const text = String(source);
    const sourceName = options.sourceName ?? "<jlc>";
    return new JLCProgram(this, this.parse(text, { sourceName }), text, sourceName);
  }

  mount(sourceOrProgram, targetOrSelector, options = {}) {
    let program = sourceOrProgram instanceof JLCProgram ? sourceOrProgram : this.compile(sourceOrProgram, options);
    const appName = program.ast.name;
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
        return sanitizeValue(bindingValue(runtime.environment.resolve(name)));
      },
      set(name, value) {
        if (!active) throw new JLCRuntimeError("应用已卸载");
        const binding = runtime.environment.resolve(name);
        if (binding.kind !== "signal" || !binding.signal.writable) throw new JLCRuntimeError(`“${name}”不是可写状态`);
        runtime.batch(() => binding.signal.set(sanitizeValue(value)));
        return handle;
      },
      call(name, ...argumentsList) {
        if (!active) throw new JLCRuntimeError("应用已卸载");
        const value = bindingValue(runtime.environment.resolve(name));
        if (!value?.[CALLABLE]) throw new JLCRuntimeError(`“${name}”不是 action`);
        const result = runtime.batch(() => value.invoke(argumentsList.map((value_) => sanitizeValue(value_)), runtime.context(rootScope)));
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
      start = runtime.document.createComment(`jlc:${program.ast.name}`);
      end = runtime.document.createComment(`/jlc:${program.ast.name}`);
      target.appendChild(start);
      target.appendChild(end);
      installEnvironment(runtime, program.ast);
      installStyles(runtime, program.ast);
      renderNodes(program.ast.view.children, target, end, runtime.environment, rootScope, runtime);
      setupAutoDispose(runtime, start, end, handle.unmount);
      runtime.initializing = false;
      // The mounted graph no longer needs source or AST. A retained handle can
      // therefore release a very large compiled program after unmount.
      program = null;
      return Object.freeze(handle);
    } catch (error) {
      runtime.initializing = false;
      handle.unmount();
      if (error instanceof JLCCompileError || error instanceof JLCRuntimeError) throw error;
      throw new JLCRuntimeError(`挂载 ${appName} 失败`, error);
    }
  }

  async boot(root = globalThis.document, options = {}) {
    if (!root?.querySelectorAll) throw new JLCRuntimeError("boot 需要 Document 或 Element");
    const scripts = [...root.querySelectorAll('script[type="text/jlc"]')];
    const handles = [];
    try {
      for (const script of scripts) {
        const source = script.src
          ? await (options.fetch ?? globalThis.fetch)(script.src).then((response) => {
            if (!response.ok) throw new JLCRuntimeError(`无法加载 ${script.src}: HTTP ${response.status}`);
            return response.text();
          })
          : script.textContent;
        const selector = script.dataset?.target;
        const target = selector ? (script.ownerDocument ?? root).querySelector(selector) : script.nextElementSibling;
        if (!target) throw new JLCRuntimeError("text/jlc 脚本需要 data-target，或紧邻一个挂载元素");
        let state = options.state;
        if (script.dataset?.state) state = JSON.parse(script.dataset.state);
        handles.push(this.mount(this.compile(source, { sourceName: script.src || "<inline-jlc>" }), target, { ...options, state }));
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
