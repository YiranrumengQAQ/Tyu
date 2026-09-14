/*
 * JLC Compiler
 * JLC 源码 → Tokenizer → Parser → 优化器（常量折叠 / 死代码消除）→ 字节码生成器
 * Copyright (c) 2026 JLC contributors. MIT licensed.
 *
 * 输出 JLC 字节码模块（可由 encodeModule 序列化为 .jbc 二进制），
 * 供 jlc-vm.js 的 JLC-VM 装载、验证、链接并执行。
 */

import {
  JLCCompileError,
  JLCVerifyError,
  deepFreeze,
  verifyModule,
  encodeModule,
  disassembleModule,
  loadModule,
  OP,
  OP_SPEC,
  NO_FUNC,
  BLOCKED_TAGS,
  BLOCKED_PROPERTIES,
  URL_ATTRIBUTES,
  EVENT_MODIFIERS,
  EVENT_MODIFIER_BITS,
  BUILTIN_NAMES,
  BLOCKED_KEYS,
  FUNCTION_KIND,
  VERSION,
} from "./jlc-vm.js";

export { JLCCompileError, JLCVerifyError };

const ASSIGNMENT_OPERATORS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "??="]);
const BINARY_PRECEDENCE = new Map([
  ["??", 1], ["||", 2], ["&&", 3],
  ["==", 4], ["!=", 4], ["===", 4], ["!==", 4],
  ["<", 5], ["<=", 5], [">", 5], [">=", 5], ["in", 5],
  ["+", 6], ["-", 6], ["*", 7], ["/", 7], ["%", 7], ["**", 8],
]);
const BINARY_OPCODES = new Map([
  ["+", OP.ADD], ["-", OP.SUB], ["*", OP.MUL], ["/", OP.DIV], ["%", OP.MOD], ["**", OP.POW],
  ["==", OP.EQ], ["===", OP.EQ], ["<", OP.LT], ["<=", OP.LE], [">", OP.GT], [">=", OP.GE], ["in", OP.IN],
]);
const COMPOUND_OPCODES = new Map([
  ["+=", OP.ADD], ["-=", OP.SUB], ["*=", OP.MUL], ["/=", OP.DIV], ["%=", OP.MOD], ["??=", OP.COALESCE],
]);

const RESERVED_READONLY_VALUES = new Set([...BUILTIN_NAMES]);
const RESERVED_READONLY_SIGNALS = new Set(["$route"]);

/* ================================================================
 * 词法分析（Tokenizer）
 * ================================================================ */

function isIdentifierStart(character) {
  return character != null && /[\p{L}_$]/u.test(character);
}

function isIdentifierPart(character) {
  return character != null && /[\p{L}\p{N}_$]/u.test(character);
}

export function tokenize(source, sourceName = "<jlc>") {
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

/* ================================================================
 * 语法分析（Parser）
 * ================================================================ */

export class Parser {
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

export function parseSource(source, options = {}) {
  return deepFreeze(new Parser(String(source), options).parseProgram());
}

/* ================================================================
 * 优化器：常量折叠 + 死代码消除（编译期离线完成）
 * ================================================================ */

function literalNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function foldArithmetic(operator, left, right) {
  const numeric = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new RangeError("非有限数字");
    return number;
  };
  switch (operator) {
    case "+":
      return typeof left === "string" || typeof right === "string" ? `${left ?? ""}${right ?? ""}` : numeric(left) + numeric(right);
    case "-": return numeric(left) - numeric(right);
    case "*": return numeric(left) * numeric(right);
    case "/": return numeric(left) / numeric(right);
    case "%": return numeric(left) % numeric(right);
    case "**": return numeric(left) ** numeric(right);
    case "==": case "===": return Object.is(left, right);
    case "!=": case "!==": return !Object.is(left, right);
    case "<": return left < right;
    case "<=": return left <= right;
    case ">": return left > right;
    case ">=": return left >= right;
    default: return undefined;
  }
}

export function optimizeProgram(program) {
  const fold = (node) => {
    if (!node || typeof node !== "object") return node;
    switch (node.type) {
      case "ArrayExpression": {
        const elements = node.elements.map(fold);
        return elements.every((element, index) => element === node.elements[index]) ? node : { ...node, elements };
      }
      case "ObjectExpression": {
        const properties = node.properties.map((property) => {
          const value = fold(property.value);
          return value === property.value ? property : { ...property, value };
        });
        return properties.every((property, index) => property === node.properties[index]) ? node : { ...node, properties };
      }
      case "MemberExpression": {
        const object = fold(node.object);
        const property = fold(node.property);
        return object === node.object && property === node.property ? node : { ...node, object, property };
      }
      case "UnaryExpression": {
        const argument = fold(node.argument);
        if (argument.type === "Literal") {
          const value = argument.value;
          if (node.operator === "!" || node.operator === "not") return { type: "Literal", value: !value, loc: node.loc };
          try {
            const numeric = Number(value);
            if (Number.isFinite(numeric)) {
              if (node.operator === "-") return { type: "Literal", value: -numeric, loc: node.loc };
              if (node.operator === "+") return { type: "Literal", value: numeric, loc: node.loc };
            }
          } catch { /* 保持运行期报错 */ }
        }
        return argument === node.argument ? node : { ...node, argument };
      }
      case "BinaryExpression": {
        const left = fold(node.left);
        const right = fold(node.right);
        const operator = node.operator;
        if (operator === "&&" && left.type === "Literal") return left.value ? right : left;
        if (operator === "||" && left.type === "Literal") return left.value ? left : right;
        if (operator === "??" && left.type === "Literal") return left.value == null ? right : left;
        if (left.type === "Literal" && right.type === "Literal" && operator !== "in") {
          try {
            const value = foldArithmetic(operator, left.value, right.value);
            if (value !== undefined) return { type: "Literal", value, loc: node.loc };
          } catch { /* 保持运行期报错 */ }
        }
        return left === node.left && right === node.right ? node : { ...node, left, right };
      }
      case "ConditionalExpression": {
        const test = fold(node.test);
        if (test.type === "Literal") return fold(test.value ? node.consequent : node.alternate);
        const consequent = fold(node.consequent);
        const alternate = fold(node.alternate);
        return test === node.test && consequent === node.consequent && alternate === node.alternate
          ? node
          : { ...node, test, consequent, alternate };
      }
      case "CallExpression": {
        const callee = fold(node.callee);
        const arguments_ = node.arguments.map(fold);
        return callee === node.callee && arguments_.every((argument, index) => argument === node.arguments[index])
          ? node
          : { ...node, callee, arguments: arguments_ };
      }
      default:
        return node;
    }
  };

  const pure = (node) => {
    if (!node || typeof node !== "object") return true;
    switch (node.type) {
      case "Literal": return true;
      case "ArrayExpression": return node.elements.every(pure);
      case "ObjectExpression": return node.properties.every((property) => pure(property.value));
      case "UnaryExpression": return pure(node.argument);
      case "BinaryExpression": return pure(node.left) && pure(node.right);
      case "ConditionalExpression": return pure(node.test) && pure(node.consequent) && pure(node.alternate);
      default: return false; // Call / Member / Identifier 都可能抛错或产生副作用
    }
  };

  const declaresLocals = (statements) => statements.some((statement) =>
    statement.type === "LetStatement"
    || statement.type === "ForStatement"
    || (statement.type === "IfStatement" && (declaresLocals(statement.consequent) || declaresLocals(statement.alternate))));

  const foldBlock = (statements) => {
    const output = [];
    for (const statement of statements) {
      switch (statement.type) {
        case "LetStatement":
          output.push({ ...statement, value: fold(statement.value) });
          break;
        case "AssignmentStatement":
          output.push({ ...statement, value: fold(statement.value) });
          break;
        case "ExpressionStatement": {
          const expression = fold(statement.expression);
          if (!pure(expression)) output.push({ ...statement, expression });
          break;
        }
        case "IfStatement": {
          const test = fold(statement.test);
          if (test.type === "Literal") {
            const chosen = test.value ? statement.consequent : statement.alternate;
            if (!declaresLocals(chosen)) {
              output.push(...foldBlock(chosen));
              break;
            }
          }
          output.push({
            ...statement,
            test,
            consequent: foldBlock(statement.consequent),
            alternate: foldBlock(statement.alternate),
          });
          break;
        }
        case "ForStatement":
          output.push({ ...statement, iterable: fold(statement.iterable), body: foldBlock(statement.body) });
          break;
        case "ReturnStatement":
          output.push({ ...statement, value: statement.value ? fold(statement.value) : null });
          break;
        case "TimerStatement":
          output.push({ ...statement, delay: fold(statement.delay), body: foldBlock(statement.body) });
          break;
        default:
          output.push(statement);
      }
    }
    // 死代码消除：顶层 return 之后的语句不可达。
    const returnIndex = output.findIndex((statement) => statement.type === "ReturnStatement");
    return returnIndex >= 0 ? output.slice(0, returnIndex + 1) : output;
  };

  const foldView = (nodes) => nodes.map((node) => {
    switch (node.type) {
      case "TextNode":
        return { ...node, value: fold(node.value) };
      case "ElementNode":
        return {
          ...node,
          attributes: node.attributes.map((attribute) => {
            if (attribute.value?.type === "EventBlock") {
              return { ...attribute, value: { ...attribute.value, body: foldBlock(attribute.value.body) } };
            }
            return { ...attribute, value: fold(attribute.value) };
          }),
          children: foldView(node.children),
        };
      case "WhenNode": {
        const test = fold(node.test);
        if (test.type === "Literal") return { ...node, type: "__Fragment", children: foldView(test.value ? node.consequent : node.alternate) };
        return { ...node, test, consequent: foldView(node.consequent), alternate: foldView(node.alternate) };
      }
      case "EachNode":
        return {
          ...node,
          iterable: fold(node.iterable),
          key: node.key ? fold(node.key) : null,
          body: foldView(node.body),
          alternate: foldView(node.alternate),
        };
      default:
        return node;
    }
  }).flatMap((node) => (node.type === "__Fragment" ? node.children : [node]));

  return {
    ...program,
    declarations: program.declarations.map((declaration) => {
      if (declaration.type === "ActionDeclaration") {
        return {
          ...declaration,
          parameters: declaration.parameters.map((parameter) => ({
            ...parameter,
            defaultValue: parameter.defaultValue ? fold(parameter.defaultValue) : null,
          })),
          body: foldBlock(declaration.body),
        };
      }
      if (declaration.type === "StyleDeclaration") return { ...declaration, value: fold(declaration.value) };
      return { ...declaration, value: fold(declaration.value) };
    }),
    view: { ...program.view, children: foldView(program.view.children) },
  };
}

/* ================================================================
 * 字节码生成器（Code Generator）
 * ================================================================ */

const GLOBAL_SCOPE = { boundary: false, names: new Map(), parent: null, global: true };

class LexicalScope {
  constructor(parent, boundary) {
    this.parent = parent;
    this.boundary = boundary;
    this.names = new Map();
    this.builder = parent ? parent.builder : null;
  }

  declareFixed(name, slot, writable) {
    this.names.set(name, { slot, writable });
  }

  declare(name, writable, loc, sourceName) {
    if (this.names.has(name)) {
      throw new JLCCompileError(`名称“${name}”重复定义`, loc, sourceName);
    }
    const slot = this.builder.slot(loc);
    this.names.set(name, { slot, writable });
    return slot;
  }

  resolve(name) {
    let depth = 0;
    for (let node = this; node; node = node.parent) {
      const found = node.names.get(name);
      if (found) return { slot: found.slot, writable: found.writable, depth };
      if (node.boundary) depth += 1;
    }
    return null;
  }
}

class FuncBuilder {
  constructor(module, kind, name, parentScope) {
    this.module = module;
    this.kind = kind;
    this.name = name;
    this.code = [];
    this.nSlots = 0;
    this.patches = [];
    this.scope = new LexicalScope(parentScope ?? GLOBAL_SCOPE, true);
    this.scope.builder = this;
  }

  error(message, loc) {
    throw new JLCCompileError(message, loc, this.module.sourceName);
  }

  slot(loc) {
    if (this.nSlots >= 0xfffe) this.error(`函数“${this.name}”局部变量过多`, loc);
    return this.nSlots++;
  }

  byte(value) {
    this.code.push(value & 0xff);
  }

  u16(value) {
    if (value > 0xffff) this.error(`函数“${this.name}”操作数越界`);
    this.code.push((value >> 8) & 0xff, value & 0xff);
  }

  i32(value) {
    const signed = value | 0;
    this.code.push((signed >>> 24) & 0xff, (signed >> 16) & 0xff, (signed >> 8) & 0xff, signed & 0xff);
  }

  op(opcode) {
    this.code.push(opcode);
  }

  here() {
    return this.code.length;
  }

  /** 发射跳转并返回待修补位置。 */
  jump(opcode) {
    this.op(opcode);
    const at = this.code.length;
    this.u16(0);
    this.patches.push(at);
    return at;
  }

  patch(at, target) {
    this.code[at] = (target >> 8) & 0xff;
    this.code[at + 1] = target & 0xff;
  }

  resolve() {
    for (const at of this.patches) {
      const target = this.code[at] << 8 | this.code[at + 1];
      if (target === 0) this.error(`函数“${this.name}”存在未闭合的跳转`);
    }
    return Uint8Array.from(this.code);
  }
}

class Codegen {
  constructor(sourceName) {
    this.sourceName = sourceName;
    this.pool = [];
    this.poolKeys = new Map();
    this.globalRefs = [];
    this.globalRefKeys = new Map();
    this.functions = [];
    this.actions = [];
    this.declarations = [];
    this.declKinds = new Map();
    this.view = NO_FUNC;
  }

  error(message, loc) {
    throw new JLCCompileError(message, loc, this.sourceName);
  }

  constant(value) {
    const key = typeof value === "number"
      ? `n:${Object.is(value, -0) ? "-0" : String(value)}`
      : `${typeof value}:${String(value)}`;
    let index = this.poolKeys.get(key);
    if (index == null) {
      if (this.pool.length >= 0x10000) this.error("常量池超过 65536 项");
      index = this.pool.length;
      this.pool.push(value);
      this.poolKeys.set(key, index);
    }
    return index;
  }

  ref(name) {
    this.constant(name); // 全局名进入字符串常量池（.jbc 校验要求）
    let index = this.globalRefKeys.get(name);
    if (index == null) {
      if (this.globalRefs.length >= 0x10000) this.error("全局引用超过 65536 项");
      index = this.globalRefs.length;
      this.globalRefs.push(name);
      this.globalRefKeys.set(name, index);
    }
    return index;
  }

  buildFunction(kind, name, compile, parentScope = null) {
    this.constant(name); // 函数名进入常量池
    const builder = new FuncBuilder(this, kind, name, parentScope);
    compile(builder, builder.scope);
    if (kind === FUNCTION_KIND.BODY) {
      builder.op(OP.RETURN_NULL);
    } else if (kind === FUNCTION_KIND.EXPR) {
      builder.op(OP.RETURN); // 栈顶即表达式值
    } else {
      builder.op(OP.RETURN_NULL); // 视图结构执行完毕
    }
    const code = builder.resolve();
    if (code.length > 0xffff) this.error(`函数“${name}”指令流超过 64KB`);
    this.functions.push({ name, kind, nSlots: builder.nSlots, captures: [], code, maxStack: 0 });
    return this.functions.length - 1;
  }

  exprFunction(expression, name, parentScope) {
    return this.buildFunction(FUNCTION_KIND.EXPR, name, (builder, scope) => {
      this.compileExpression(builder, scope, expression);
    }, parentScope);
  }

  viewFunction(children, name, parentScope) {
    return this.buildFunction(FUNCTION_KIND.VIEW, name, (builder, scope) => {
      this.compileViewNodes(builder, scope, children);
    }, parentScope);
  }

  /* ---------------- 表达式 ---------------- */

  compileExpression(builder, scope, node) {
    switch (node.type) {
      case "Literal": {
        const value = node.value;
        if (value == null) builder.op(OP.CONST_NULL);
        else if (typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) {
          builder.op(OP.CONST_INT);
          builder.i32(value);
        } else {
          builder.op(OP.CONST);
          builder.u16(this.constant(value));
        }
        return;
      }
      case "Identifier": {
        const resolved = scope.resolve(node.name);
        if (resolved) {
          builder.op(OP.GET_LOCAL);
          builder.byte(resolved.depth);
          builder.u16(resolved.slot);
        } else {
          builder.op(OP.GET_GLOBAL);
          builder.u16(this.ref(node.name));
        }
        return;
      }
      case "ArrayExpression": {
        for (const element of node.elements) this.compileExpression(builder, scope, element);
        builder.op(OP.BUILD_ARRAY);
        builder.byte(node.elements.length);
        return;
      }
      case "ObjectExpression": {
        for (const property of node.properties) {
          builder.op(OP.CONST);
          builder.u16(this.constant(property.key));
          this.compileExpression(builder, scope, property.value);
        }
        builder.op(OP.BUILD_OBJECT);
        builder.byte(node.properties.length);
        return;
      }
      case "MemberExpression": {
        this.compileExpression(builder, scope, node.object);
        this.compileExpression(builder, scope, node.property);
        builder.op(OP.GET_MEMBER);
        return;
      }
      case "UnaryExpression": {
        this.compileExpression(builder, scope, node.argument);
        if (node.operator === "!" || node.operator === "not") builder.op(OP.NOT);
        else if (node.operator === "-") builder.op(OP.NEG);
        else if (node.operator === "+") builder.op(OP.POS);
        else this.error(`不支持一元运算符 ${node.operator}`, node.loc);
        return;
      }
      case "BinaryExpression": {
        const operator = node.operator;
        if (operator === "&&") {
          this.compileExpression(builder, scope, node.left);
          builder.op(OP.DUP);
          const jump = builder.jump(OP.JUMP_IF_FALSE);
          builder.op(OP.POP);
          this.compileExpression(builder, scope, node.right);
          builder.patch(jump, builder.here());
          return;
        }
        if (operator === "||") {
          this.compileExpression(builder, scope, node.left);
          builder.op(OP.DUP);
          const jump = builder.jump(OP.JUMP_IF_TRUE);
          builder.op(OP.POP);
          this.compileExpression(builder, scope, node.right);
          builder.patch(jump, builder.here());
          return;
        }
        if (operator === "??") {
          this.compileExpression(builder, scope, node.left);
          builder.op(OP.DUP);
          const jump = builder.jump(OP.JUMP_IF_NONNULL);
          builder.op(OP.POP);
          this.compileExpression(builder, scope, node.right);
          builder.patch(jump, builder.here());
          return;
        }
        if (operator === "!=" || operator === "!==") {
          this.compileExpression(builder, scope, node.left);
          this.compileExpression(builder, scope, node.right);
          builder.op(OP.EQ);
          builder.op(OP.NOT);
          return;
        }
        const opcode = BINARY_OPCODES.get(operator);
        if (!opcode) this.error(`不支持二元运算符 ${operator}`, node.loc);
        this.compileExpression(builder, scope, node.left);
        this.compileExpression(builder, scope, node.right);
        builder.op(opcode);
        return;
      }
      case "ConditionalExpression": {
        this.compileExpression(builder, scope, node.test);
        const elseJump = builder.jump(OP.JUMP_IF_FALSE);
        this.compileExpression(builder, scope, node.consequent);
        const endJump = builder.jump(OP.JUMP);
        builder.patch(elseJump, builder.here());
        this.compileExpression(builder, scope, node.alternate);
        builder.patch(endJump, builder.here());
        return;
      }
      case "CallExpression": {
        if (node.arguments.length > 255) this.error("调用参数超过 255 个", node.loc);
        this.compileExpression(builder, scope, node.callee);
        for (const argument of node.arguments) this.compileExpression(builder, scope, argument);
        builder.op(OP.CALL);
        builder.byte(node.arguments.length);
        return;
      }
      default:
        this.error(`未知表达式 ${node.type}`, node.loc);
    }
  }

  /* ---------------- 语句 ---------------- */

  compileStatements(builder, scope, statements) {
    for (const statement of statements) {
      switch (statement.type) {
        case "LetStatement": {
          this.compileExpression(builder, scope, statement.value);
          const slot = scope.declare(statement.name, true, statement.loc, this.sourceName);
          builder.op(OP.DEF_LOCAL);
          builder.u16(slot);
          break;
        }
        case "AssignmentStatement":
          this.compileAssignment(builder, scope, statement);
          break;
        case "ExpressionStatement":
          this.compileExpression(builder, scope, statement.expression);
          builder.op(OP.POP);
          break;
        case "IfStatement": {
          this.compileExpression(builder, scope, statement.test);
          const elseJump = builder.jump(OP.JUMP_IF_FALSE);
          this.compileStatements(builder, new LexicalScope(scope, false), statement.consequent);
          const endJump = builder.jump(OP.JUMP);
          builder.patch(elseJump, builder.here());
          this.compileStatements(builder, new LexicalScope(scope, false), statement.alternate);
          builder.patch(endJump, builder.here());
          break;
        }
        case "ForStatement": {
          this.compileExpression(builder, scope, statement.iterable);
          builder.op(OP.FOR_PREP);
          const loopScope = new LexicalScope(scope, false);
          const itemSlot = loopScope.declare(statement.item, false, statement.loc, this.sourceName);
          let indexSlot = 0;
          let hasIndex = 0;
          if (statement.index) {
            indexSlot = loopScope.declare(statement.index, false, statement.loc, this.sourceName);
            hasIndex = 1;
          }
          const bodyStart = builder.here();
          builder.op(OP.FOR_NEXT);
          builder.u16(itemSlot);
          builder.u16(indexSlot);
          builder.byte(hasIndex);
          const exitJumpAt = builder.code.length;
          builder.u16(0);
          this.compileStatements(builder, loopScope, statement.body);
          builder.op(OP.JUMP);
          builder.u16(bodyStart);
          builder.patch(exitJumpAt, builder.here());
          break;
        }
        case "ReturnStatement": {
          if (statement.value) this.compileExpression(builder, scope, statement.value);
          else builder.op(OP.CONST_NULL);
          builder.op(OP.RETURN);
          break;
        }
        case "TimerStatement": {
          const mode = statement.mode === "after" ? 0 : 1;
          const funcIndex = this.buildFunction(FUNCTION_KIND.BODY, `timer:${statement.mode}`, (inner, innerScope) => {
            this.compileStatements(inner, innerScope, statement.body);
          }, scope);
          this.compileExpression(builder, scope, statement.delay);
          builder.op(OP.TIMER);
          builder.byte(mode);
          builder.u16(funcIndex);
          break;
        }
        default:
          this.error(`未知语句 ${statement.type}`, statement.loc);
      }
    }
  }

  lvalueParts(node, loc) {
    const keys = [];
    let current = node;
    while (current.type === "MemberExpression") {
      keys.unshift(current.property);
      current = current.object;
    }
    if (current.type !== "Identifier") this.error("赋值左侧必须是状态或状态字段", loc);
    return { root: current, keys };
  }

  compileAssignment(builder, scope, statement) {
    const { root, keys } = this.lvalueParts(statement.target, statement.loc);
    const resolved = scope.resolve(root.name);
    const compound = statement.operator !== "=" && COMPOUND_OPCODES.get(statement.operator);

    if (resolved) {
      if (!resolved.writable) this.error(`“${root.name}”不可赋值`, statement.loc);
      if (compound) {
        builder.op(OP.GET_LOCAL);
        builder.byte(resolved.depth);
        builder.u16(resolved.slot);
        for (const key of keys) {
          this.compileExpression(builder, scope, key);
          builder.op(OP.GET_MEMBER);
        }
        this.compileExpression(builder, scope, statement.value);
        builder.op(compound);
      } else {
        this.compileExpression(builder, scope, statement.value);
      }
      if (keys.length) {
        if (keys.length > 255) this.error("赋值路径过深", statement.loc);
        for (const key of keys) this.compileExpression(builder, scope, key);
        builder.op(OP.SET_LOCAL_PATH);
        builder.byte(resolved.depth);
        builder.u16(resolved.slot);
        builder.byte(keys.length);
      } else {
        builder.op(OP.SET_LOCAL);
        builder.byte(resolved.depth);
        builder.u16(resolved.slot);
      }
      return;
    }

    // 全局（或 mount 时注入的 capability）：静态只读检查 + 全局引用。
    this.checkGlobalWritable(root.name, statement.loc);
    const ref = this.ref(root.name);
    if (compound) {
      builder.op(OP.GET_GLOBAL);
      builder.u16(ref);
      for (const key of keys) {
        this.compileExpression(builder, scope, key);
        builder.op(OP.GET_MEMBER);
      }
      this.compileExpression(builder, scope, statement.value);
      builder.op(compound);
    } else {
      this.compileExpression(builder, scope, statement.value);
    }
    if (keys.length) {
      if (keys.length > 255) this.error("赋值路径过深", statement.loc);
      for (const key of keys) this.compileExpression(builder, scope, key);
      builder.op(OP.SET_GLOBAL_PATH);
      builder.u16(ref);
      builder.byte(keys.length);
    } else {
      builder.op(OP.SET_GLOBAL);
      builder.u16(ref);
    }
  }

  checkGlobalWritable(name, loc) {
    if (this.declKinds.get(name) === "derive" || this.declKinds.get(name) === "resource") {
      this.error(`“${name}”是只读状态`, loc);
    }
    if (this.declKinds.get(name) === "action" || RESERVED_READONLY_VALUES.has(name)) {
      this.error(`“${name}”不可赋值`, loc);
    }
    if (RESERVED_READONLY_SIGNALS.has(name)) this.error(`“${name}”是只读状态`, loc);
  }

  /* ---------------- 视图 ---------------- */

  compileViewNodes(builder, scope, nodes) {
    for (const node of nodes) {
      switch (node.type) {
        case "TextNode": {
          const funcIndex = this.exprFunction(node.value, "text", scope);
          builder.op(OP.TEXT);
          builder.u16(funcIndex);
          break;
        }
        case "ElementNode": {
          if (BLOCKED_TAGS.has(node.tag.toLowerCase())) {
            this.error(`安全模式禁止创建 <${node.tag}>`, node.loc);
          }
          builder.op(OP.ELEM);
          builder.u16(this.constant(node.tag));
          for (const attribute of this.sortAttributes(node.attributes)) {
            this.compileAttribute(builder, scope, attribute);
          }
          this.compileViewNodes(builder, scope, node.children);
          builder.op(OP.ELEM_END);
          break;
        }
        case "WhenNode": {
          const testFunc = this.exprFunction(node.test, "when:test", scope);
          const yesFunc = this.viewFunction(node.consequent, "when:yes", scope);
          const noFunc = this.viewFunction(node.alternate, "when:no", scope);
          builder.op(OP.WHEN);
          builder.u16(testFunc);
          builder.u16(yesFunc);
          builder.u16(noFunc);
          break;
        }
        case "EachNode": {
          const iterFunc = this.exprFunction(node.iterable, "each:items", scope);
          let keyFunc = NO_FUNC;
          if (node.key) {
            keyFunc = this.buildFunction(FUNCTION_KIND.EXPR, "each:key", (inner, innerScope) => {
              innerScope.declareFixed(node.item, 0, false);
              inner.nSlots = Math.max(inner.nSlots, 1);
              if (node.index) {
                innerScope.declareFixed(node.index, 1, false);
                inner.nSlots = Math.max(inner.nSlots, 2);
              }
              this.compileExpression(inner, innerScope, node.key);
            }, scope);
          }
          const bodyFunc = this.buildFunction(FUNCTION_KIND.VIEW, "each:body", (inner, innerScope) => {
            innerScope.declareFixed(node.item, 0, false);
            inner.nSlots = Math.max(inner.nSlots, 1);
            if (node.index) {
              innerScope.declareFixed(node.index, 1, false);
              inner.nSlots = Math.max(inner.nSlots, 2);
            }
            this.compileViewNodes(inner, innerScope, node.body);
          }, scope);
          const emptyFunc = this.viewFunction(node.alternate, "each:empty", scope);
          builder.op(OP.EACH);
          builder.u16(iterFunc);
          builder.u16(keyFunc);
          builder.u16(bodyFunc);
          builder.u16(emptyFunc);
          builder.u16(this.constant(node.item));
          builder.u16(0);
          builder.byte(node.index ? 1 : 0);
          builder.u16(node.index ? 1 : 0);
          break;
        }
        default:
          this.error(`未知视图节点 ${node.type}`, node.loc);
      }
    }
  }

  sortAttributes(attributes) {
    const layer = (attribute) => {
      if (attribute.name === "class" || attribute.name === "style") return 0;
      if (attribute.name.startsWith("class:") || attribute.name.startsWith("style:") || attribute.name.startsWith("bind:")) return 2;
      return 1;
    };
    return [...attributes].sort((left, right) => layer(left) - layer(right));
  }

  compileAttribute(builder, scope, attribute) {
    const name = attribute.name;
    const literalValue = attribute.value?.type === "Literal" && attribute.value.type === "Literal" ? attribute.value : null;

    if (name.startsWith("on:")) {
      const specification = name.slice(3);
      const [type, ...modifiers] = specification.split(".");
      if (!type) this.error("事件名不能为空", attribute.loc);
      let mask = 0;
      for (const modifier of modifiers) {
        const bit = EVENT_MODIFIER_BITS[modifier];
        if (!bit) this.error(`未知的事件修饰符“${modifier}”`, attribute.loc);
        mask |= bit;
      }
      let funcIndex;
      // 统一事件帧约定：事件体/事件表达式都在“事件帧”之上执行，
      // $event 位于事件帧槽 0（相对当前函数帧 depth 1）。
      const eventFrame = new LexicalScope(scope, false);
      eventFrame.declareFixed("$event", 0, false);
      if (attribute.value.type === "EventBlock") {
        funcIndex = this.buildFunction(FUNCTION_KIND.BODY, `event:${type}`, (inner, innerScope) => {
          this.compileStatements(inner, innerScope, attribute.value.body);
        }, eventFrame);
      } else {
        funcIndex = this.exprFunction(attribute.value, `event:${type}`, eventFrame);
      }
      builder.op(OP.EVENT);
      builder.u16(this.constant(type));
      builder.byte(mask);
      builder.u16(funcIndex);
      return;
    }

    if (name.startsWith("bind:")) {
      const property = name.slice(5);
      if (property !== "value" && property !== "checked") {
        this.error(`bind 仅支持 value / checked，收到“${property}”`, attribute.loc);
      }
      const { root, keys } = this.lvalueParts(attribute.value, attribute.loc);
      if (scope.resolve(root.name)) this.error(`“${root.name}”不可赋值`, attribute.loc);
      this.checkGlobalWritable(root.name, attribute.loc);
      const ref = this.ref(root.name);
      const getFunc = this.exprFunction(attribute.value, `bind:${property}:get`, scope);
      const setFunc = this.buildFunction(FUNCTION_KIND.BODY, `bind:${property}:set`, (inner, innerScope) => {
        // 绑定写入帧：槽 0 是来自 DOM 的新值（depth 0）。
        inner.nSlots = Math.max(inner.nSlots, 1);
        for (const key of keys) this.compileExpression(inner, innerScope, key);
        inner.op(OP.GET_LOCAL);
        inner.byte(0);
        inner.u16(0);
        inner.op(OP.SET_GLOBAL_PATH);
        inner.u16(ref);
        inner.byte(keys.length);
      }, scope);
      builder.op(property === "checked" ? OP.BIND_CHECKED : OP.BIND_VALUE);
      builder.u16(getFunc);
      builder.u16(setFunc);
      return;
    }

    if (name.startsWith("class:")) {
      const className = name.slice(6).replaceAll(":", "-");
      const funcIndex = this.exprFunction(attribute.value, `class:${className}`, scope);
      builder.op(OP.CLASS_TOGGLE);
      builder.u16(this.constant(className));
      builder.u16(funcIndex);
      return;
    }

    if (name.startsWith("style:")) {
      const property = name.slice(6).replaceAll(":", "-");
      const funcIndex = this.exprFunction(attribute.value, `style:${property}`, scope);
      builder.op(OP.STYLE_PROP);
      builder.u16(this.constant(property));
      builder.u16(funcIndex);
      return;
    }

    if (name.startsWith("prop:")) {
      const property = name.slice(5);
      const normalized = property.toLowerCase();
      if (BLOCKED_KEYS.has(property)) this.error(`禁止访问字段“${property}”`, attribute.loc);
      if (BLOCKED_PROPERTIES.has(normalized) || normalized.startsWith("on")) {
        this.error(`安全模式禁止设置 DOM property“${property}”`, attribute.loc);
      }
      const funcIndex = this.exprFunction(attribute.value, `prop:${property}`, scope);
      builder.op(OP.PROP_SET);
      builder.u16(this.constant(property));
      builder.u16(funcIndex);
      return;
    }

    // 普通 attr / data:* / aria:* / class / style
    let resolved = name;
    if (resolved.startsWith("attr:")) resolved = resolved.slice(5).replaceAll(":", "-");
    else if (resolved.startsWith("data:")) resolved = `data-${resolved.slice(5).replaceAll(":", "-")}`;
    else if (resolved.startsWith("aria:")) resolved = `aria-${resolved.slice(5).replaceAll(":", "-")}`;
    if (/^on/iu.test(resolved)) {
      this.error(`禁止直接设置事件属性“${resolved}”，请使用 on:${resolved.slice(2)}`, attribute.loc);
    }
    // 常量属性在编译期折叠为 ATTR_STATIC（零运行时开销）。
    if (attribute.value?.type === "Literal") {
      builder.op(OP.ATTR_STATIC);
      builder.u16(this.constant(name));
      builder.u16(this.constant(attribute.value.value));
      return;
    }
    const funcIndex = this.exprFunction(attribute.value, `attr:${name}`, scope);
    if (name === "style") {
      builder.op(OP.STYLE_OBJECT);
      builder.u16(funcIndex);
    } else {
      builder.op(OP.ATTR);
      builder.u16(this.constant(name));
      builder.u16(funcIndex);
    }
  }

  /* ---------------- 程序 ---------------- */

  compileProgram(program) {
    // 预扫描声明种类，供赋值只读检查使用。
    for (const declaration of program.declarations) {
      if (declaration.type === "StateDeclaration") this.declKinds.set(declaration.name, "state");
      else if (declaration.type === "DeriveDeclaration") this.declKinds.set(declaration.name, "derive");
      else if (declaration.type === "ResourceDeclaration") this.declKinds.set(declaration.name, "resource");
      else if (declaration.type === "ActionDeclaration") this.declKinds.set(declaration.name, "action");
    }

    for (const declaration of program.declarations) {
      if (declaration.type === "ActionDeclaration" || declaration.type === "StyleDeclaration") continue;
      const kind = declaration.type === "StateDeclaration" ? "state"
        : declaration.type === "DeriveDeclaration" ? "derive"
        : "resource";
      const funcIndex = this.exprFunction(declaration.value, `${kind}:${declaration.name}`, null);
      this.constant(declaration.name);
      this.declarations.push({ kind, name: declaration.name, func: funcIndex });
    }

    for (const declaration of program.declarations) {
      if (declaration.type === "StyleDeclaration") {
        const funcIndex = this.exprFunction(declaration.value, "style", null);
        this.constant("");
        this.declarations.push({ kind: "style", name: "", func: funcIndex });
        continue;
      }
      if (declaration.type !== "ActionDeclaration") continue;
      const funcIndex = this.buildFunction(FUNCTION_KIND.BODY, `action:${declaration.name}`, (builder, scope) => {
        declaration.parameters.forEach((parameter, index) => {
          scope.declareFixed(parameter.name, index, true);
        });
        builder.nSlots = Math.max(builder.nSlots, declaration.parameters.length);
        this.compileStatements(builder, scope, declaration.body);
      });
      this.constant(declaration.name);
      const params = declaration.parameters.map((parameter, index) => {
        this.constant(parameter.name);
        if (!parameter.defaultValue) return { name: parameter.name, defaultFunc: NO_FUNC };
        const defaultFunc = this.buildFunction(FUNCTION_KIND.EXPR, `default:${declaration.name}#${index}`, (builder) => {
          // 默认值表达式位于“参数帧”之上：参数槽 depth 1。
          const parameterFrame = new LexicalScope(GLOBAL_SCOPE, false);
          for (let prior = 0; prior < index; prior += 1) {
            parameterFrame.declareFixed(declaration.parameters[prior].name, prior, true);
          }
          const boundary = new LexicalScope(parameterFrame, true);
          boundary.builder = builder;
          this.compileExpression(builder, boundary, parameter.defaultValue);
        });
        return { name: parameter.name, defaultFunc };
      });
      this.actions.push({ name: declaration.name, func: funcIndex, params });
    }

    this.view = this.viewFunction(program.view.children, "view", null);

    this.constant(program.name); // app 名进入常量池（.jbc 元数据段要求）
    return {
      format: "jlc-bytecode",
      version: 1,
      app: program.name,
      sourceName: this.sourceName,
      pool: this.pool,
      globalRefs: this.globalRefs,
      functions: this.functions,
      actions: this.actions,
      declarations: this.declarations,
      view: this.view,
      verified: false,
    };
  }
}

export function compileAst(source, options = {}) {
  const sourceName = options.sourceName ?? "<jlc>";
  let ast = parseSource(String(source), { sourceName });
  if (options.optimize !== false) {
    ast = deepFreeze(optimizeProgram(ast)); // 优化后的 AST 重新冻结
  }
  const gen = new Codegen(sourceName);
  const module = gen.compileProgram(ast);
  verifyModule(module, sourceName);
  module.verified = true;
  return { module, ast, sourceName };
}

export class CompilerKernel {
  constructor(options = {}) {
    this.options = options;
    this.version = VERSION;
  }

  tokenize(source, options = {}) {
    return tokenize(String(source), options.sourceName ?? "<jlc>").map((item) => Object.freeze({ ...item }));
  }

  parse(source, options = {}) {
    return parseSource(String(source), options);
  }

  compileModule(source, options = {}) {
    return compileAst(source, options);
  }

  encode(module) {
    return encodeModule(module);
  }

  disassemble(module) {
    return disassembleModule(module);
  }

  load(bytes, options) {
    return loadModule(bytes, options);
  }
}
