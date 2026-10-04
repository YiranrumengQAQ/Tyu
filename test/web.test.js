import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JLC } from "../jlc.js";
import { FakeEvent, createDOM } from "../support/fake-dom.js";

/*
 * JLC OS（0.4 全权内核形态）测试：
 *   web/index.html 是不含任何业务标签的 Bootloader，按 URL Hash 拉取纯文本 .jlc；
 *   语法自愈、字节码编译、DOM/事件/样式/标题/图标/滚动接管全部由内核完成。
 * 这里同时守住「去 .html 化」红线：web/apps/ 永远只允许 .jlc。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

function readMeta(source, name) {
  const block = /^\/\*\*?\s*@jlc-page([\s\S]*?)\*\//.exec(source);
  const meta = { name, policy: "open", isolation: "soft", fault: "degrade" };
  if (!block) return meta;
  for (const line of block[1].split("\n")) {
    const match = /^\s*\*\s*([A-Za-z-]+)\s*:([^*]*)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (key in meta) meta[key] = value;
  }
  return meta;
}

const APP_NAMES = readdirSync(join(ROOT, "web/apps"))
  .filter((file) => file.endsWith(".jlc"))
  .sort()
  .map((file) => file.slice(0, -4));

/* ------------------------------------------------------------------
 * 1. Bootloader 与去 .html 化
 * ------------------------------------------------------------------ */

test("web/index.html 是极简纯内核 Bootloader：无业务标签，哈希路由进内核", () => {
  const html = read("web/index.html");
  assert.match(html, /<div id="kernel-viewport"><\/div>/u, "整个视口是唯一的物理挂载点");
  assert.match(html, /import\s*\{\s*JLC\s*\}\s*from\s*"\.\.\/jlc\.js"/u, "内核从仓库根的 ES Module 引入");
  assert.match(html, /location\.hash\.replace\(\/\^#\\\/\?\/,\s*""\)/u, "通过 URL Hash 选择 .jlc 应用");
  assert.match(html, /\.\/apps\/todo\.jlc/u, "默认加载 todo.jlc");
  assert.match(html, /fetch\(jlcFile/u, ".jlc 以纯文本方式拉取");
  assert.match(html, /policy:\s*"open"/u);
  assert.match(html, /isolation:\s*"strict"/u);
  assert.match(html, /autoDispose:\s*true/u);
  assert.match(html, /hashchange[\s\S]*location\.reload\(\)/u, "哈希切换走整页重载");
  // Bootloader 里不允许出现任何旧游乐场的痕迹
  assert.doesNotMatch(html, /iframe|registry|console\.js|app-page/u);
});

test("web/apps/ 已彻底去 .html 化：只剩纯文本 .jlc", () => {
  const files = readdirSync(join(ROOT, "web/apps"));
  assert.deepEqual(files.filter((file) => file.endsWith(".html")), [], "不允许残留任何 .html 业务页");
  assert.ok(APP_NAMES.length >= 4, "演示应用仍在册");
  assert.ok(APP_NAMES.includes("todo"), "Bootloader 的默认应用必须存在");
  for (const name of APP_NAMES) {
    const source = read(`web/apps/${name}.jlc`);
    assert.doesNotMatch(source, /<script/u, ".jlc 是纯文本业务代码");
  }
});

/* ------------------------------------------------------------------
 * 2. 每个 .jlc 应用都能被内核编译并在声明档下挂得住
 * ------------------------------------------------------------------ */

test("所有 .jlc 应用按声明策略档编译通过且无收回接口", () => {
  for (const name of APP_NAMES) {
    const source = read(`web/apps/${name}.jlc`);
    const meta = readMeta(source, name);
    const program = JLC.compile(source, {
      sourceName: `web/apps/${name}.jlc`,
      policy: meta.policy,
      policyMode: "manifest",
    });
    assert.equal(program.module.verified, true, `${name} 的字节码应通过验证`);
    const denials = JLC.checkPolicy(program, meta.policy);
    assert.deepEqual(denials, [], `${name} 在声明的 ${meta.policy} 档下不该有被收回的接口`);

    // .jbc 往返一致：部署链路只认字节码，往返必须无损
    const bytes = program.serialize();
    assert.ok(bytes.length > 0);
    assert.ok(program.module.functions.length > 0, `${name} 编译出了函数体`);
    assert.ok(JLC.disassemble(program).length > 0, `${name} 可反汇编`);
  }
});

test("默认应用 todo.jlc 的列表交互真的改状态（回归：事件体读不到 each 变量）", () => {
  // 症状：勾选/删除全都毫无反应——事件体里 `item.id` 解析到了事件帧的 $event 快照。
  const { document, target } = createDOM();
  const handle = JLC.mount(read("web/apps/todo.jlc"), target, { document, policy: "open", isolation: "strict", autoDispose: true });
  const rows = () => [...target.querySelectorAll("li")];
  assert.match(target.textContent, /待办 1 \/ 2 项/u, "初始摘要可见");

  const boxes = [...target.querySelectorAll("input")].filter((node) => node.getAttribute("type") === "checkbox");
  assert.equal(boxes.length, 2);
  boxes[1].checked = true;
  boxes[1].dispatchEvent(new FakeEvent("change", { bubbles: true }));
  handle.flush?.();
  assert.equal(rows()[1].classList.contains("done"), true, "第 2 行应被勾选");
  assert.match(target.textContent, /待办 0 \/ 2 项/u, "摘要随状态更新");

  const removeButtons = [...target.querySelectorAll("button")].filter((node) => node.textContent.trim() === "×");
  assert.equal(removeButtons.length, 2);
  removeButtons[0].dispatchEvent(new FakeEvent("click", { bubbles: true }));
  handle.flush?.();
  assert.equal(rows().length, 1, "第 1 行应被删除");
  assert.match(target.textContent, /写完 0.3 的策略层/u, "留下的是第 2 行");
  handle.unmount();
});

test("默认应用 todo.jlc 能被内核全权挂载并渲染", () => {
  const { document, target } = createDOM();
  const source = read("web/apps/todo.jlc");
  const handle = JLC.mount(source, target, { document, policy: "open", isolation: "strict", autoDispose: true });
  assert.equal(handle.active, true);
  assert.match(target.textContent, /\S/u, "内核接管后视口里有内容");
  const usage = handle.inspect();
  assert.ok(usage.scopes > 0);
  assert.equal(usage.denials, 0, "todo 不依赖任何可被收回的宿主接口");
  handle.unmount();
  assert.equal(target.textContent, "");
});

/* ------------------------------------------------------------------
 * 3. 0.4 自愈引擎：宽容解析
 * ------------------------------------------------------------------ */

function withCapturedWarnings(callback) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { warnings, result: callback() };
  } finally {
    console.warn = original;
  }
}

test("自愈引擎：对象字面量里误写的 = 自动降级为 :", () => {
  // 把 : 写成 = 的代码疏忽，不应中断编译
  const { warnings, result } = withCapturedWarnings(() => JLC.compile(
    'app Fix { state box = { a = 1, b: 2 }; view { text box.a + box.b; } }',
  ));
  assert.ok(warnings.some((line) => line.includes("[JLC Parser 自动修复]") && line.includes("“=”")), "应给出自动修复警告");
  const { document, target } = createDOM();
  const handle = result.mount(target, { document, policy: "strict" });
  assert.match(target.textContent, /3/u, "= 与 : 混写的对象字面量照常求值");
  handle.unmount();
});

test("自愈引擎：语句末尾漏写分号时自动补齐（遇到关键字 / 闭合括号 / 文件结束）", () => {
  const source = [
    "app Asi {",
    "  state count = 0",           // app 声明后漏写 ;（下一个是 derive 关键字）
    "  derive doubled = count * 2;",
    "  action bump() {",
    "    count = count + 1",       // 动作体里漏写 ;（下一个是 return 关键字）
    "    return",                  // 块尾 + 文件结束场景由 } 与 eof 兜底
    "  }",
    "  view { text doubled; }",
    "}",
  ].join("\n");
  const { warnings, result } = withCapturedWarnings(() => JLC.compile(source));
  assert.ok(warnings.some((line) => line.includes("[JLC Parser 自动修复]") && line.includes("“;”")), "应给出分号补齐警告");
  const { document, target } = createDOM();
  const handle = result.mount(target, { document, policy: "strict" });
  assert.match(target.textContent, /0/u);
  handle.call("bump");
  handle.flush();
  assert.match(target.textContent, /2/u, "自动补齐后的语义与显式分号一致");
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 4. 内核接管宿主：favicon() 与 $scroll
 * ------------------------------------------------------------------ */

test("favicon() 全权接管图标：SVG 转 data: URL，普通 URL 走策略净化", () => {
  const source = 'app Icon { action setIcon(v) { favicon(v); } view { text "icon"; } }';
  const { document, target } = createDOM();
  const handle = JLC.compile(source).mount(target, { document, policy: "open" });

  handle.call("setIcon", "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
  let link = document.head.querySelector("link");
  assert.ok(link, "内核为宿主创建了 link[rel=icon]");
  assert.equal(link.getAttribute("rel"), "icon");
  assert.ok(link.href.startsWith("data:image/svg+xml,"), "SVG 源码被编码为 data: URL");

  handle.call("setIcon", "javascript:alert(1)");
  assert.equal(link.href, "about:blank", "脚本型 URL 被净化为 about:blank");
  assert.equal(document.head.querySelectorAll("link").length, 1, "复用同一个 link 节点");
  handle.unmount();
});

test("favicon() / title() 受 allowDocumentTitle 策略闸控制", () => {
  const source = 'app Chrome { action decorate() { title("X"); favicon("https://x.test/i.png"); } view { text "c"; } }';
  const { document, target } = createDOM();
  const handle = JLC.compile(source).mount(target, {
    document,
    policy: { profile: "open", allowDocumentTitle: false },
    fault: "degrade",
  });
  handle.call("decorate");
  assert.equal(document.title, "", "策略收回后标题保持不动");
  assert.equal(document.head.querySelectorAll("link").length, 0, "策略收回后不触碰图标");
  assert.ok(handle.inspect().faults >= 1);
  handle.unmount();
});

test("$scroll 是内核自带的只读窗口滚动 Signal", () => {
  const source = 'app Scroll { view { text string($scroll.y); } }';
  const { document, target, window } = createDOM();
  const handle = JLC.compile(source).mount(target, { document, policy: "strict" });
  assert.equal(handle.get("$scroll").x, 0);
  assert.equal(handle.get("$scroll").y, 0);
  assert.match(target.textContent, /0/u);

  window.scrollX = 12;
  window.scrollY = 340;
  window.dispatchEvent({ type: "scroll" });
  handle.flush();
  assert.equal(handle.get("$scroll").x, 12, "滚动事件由内核代持并写入信号");
  assert.equal(handle.get("$scroll").y, 340);
  assert.match(target.textContent, /340/u, "视图随 $scroll 响应式更新");
  assert.throws(() => handle.set("$scroll", { x: 1, y: 1 }), /只读|不是可写/u, "宿主侧也不能写 $scroll");
  handle.unmount();

  // 应用源码里给 $scroll 赋值：编译期就被拦下
  assert.throws(
    () => JLC.compile('app NoWrite { view { text 1; } action bad() { $scroll = 1; } }'),
    /只读状态/u,
    "$scroll 在编译期就是只读保留信号",
  );
});

test("strict 隔离域拒绝把节点插到应用子树之外", () => {
  const { document, target } = createDOM();
  const outside = document.createElement("section");
  document.body.appendChild(outside);
  const program = JLC.compile('app Reach { state on = true; view { when (on) { p { text "x"; } } } }');
  assert.throws(
    () => program.mount(outside, { document, policy: "open", isolation: "strict", realmRoot: target }),
    (error) => error.name === "JLCIsolationError" && /应用子树之外/.test(error.message),
  );
  assert.equal(outside.textContent, "", "越权写入没有留下任何节点");
});

/* ------------------------------------------------------------------
 * 4. 共享设计系统与离线清单：两边都得对得上
 * ------------------------------------------------------------------ */

test("web/tokens.css 覆盖所有 .jlc 应用引用的 CSS 变量", () => {
  // 回归：0.4 应用直接引用 --ink/--border/--surface…，这些变量原先只定义在
  // web/0.5/shell.css 里，于是 0.4 Bootloader（web/index.html）下的应用全是裸样式。
  const tokens = read("web/tokens.css");
  const shared = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/giu)].map((match) => match[1]));
  const shell = new Set([...read("web/0.5/shell.css").matchAll(/(--[a-z0-9-]+)\s*:/giu)].map((match) => match[1]));
  assert.ok(shared.has("--ink") && shared.has("--border") && shared.has("--surface"), "基础变量在 tokens.css 里");

  const sources = [
    ...readdirSync(join(ROOT, "web/apps")).filter((file) => file.endsWith(".jlc")).map((file) => `web/apps/${file}`),
    ...readdirSync(join(ROOT, "web/0.5/apps")).filter((file) => file.endsWith(".jlc")).map((file) => `web/0.5/apps/${file}`),
  ];
  const missing = [];
  for (const path of sources) {
    const source = read(path);
    const local = new Set([...source.matchAll(/(--[a-z0-9-]+)\s*:/giu)].map((match) => match[1]));
    for (const match of source.matchAll(/var\((--[a-z0-9-]+)/giu)) {
      const name = match[1];
      if (shared.has(name) || local.has(name) || shell.has(name)) continue;
      missing.push(`${path}: ${name}`);
    }
  }
  assert.deepEqual(missing, [], `这些变量没有任何一处定义：${missing.join("、")}`);
});

test("0.4 Bootloader 引了共享设计系统，两个页面用同一份", () => {
  const boot = read("web/index.html");
  assert.match(boot, /<link rel="stylesheet" href="\.\/tokens\.css"/u, "0.4 页面引入 tokens.css");
  assert.match(read("web/0.5/index.html"), /<link rel="stylesheet" href="\.\.\/tokens\.css"/u, "0.5 页面也引入同一份");
  assert.doesNotMatch(read("web/0.5/shell.css"), /:root\s*\{/u, "变量只留一份，不在 shell.css 里重复定义");
});

test("Service Worker 的 precache 清单全部真实存在（addAll 是原子的，少一个就整站离线失败）", () => {
  const source = read("sw.js");
  const block = /const PRECACHE = \[([\s\S]*?)\]\.map/u.exec(source);
  assert.ok(block, "sw.js 里有 PRECACHE 清单");
  const paths = [...block[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  assert.ok(paths.length > 20, "清单不是空的");
  const missing = paths.filter((path) => !existsSync(join(ROOT, path)));
  assert.deepEqual(missing, [], `清单里有仓库中不存在的文件：${missing.join("、")}`);
  assert.ok(paths.includes("web/tokens.css"), "共享设计系统要进离线缓存");
});
