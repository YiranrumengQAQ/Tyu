import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDOM } from "../support/fake-dom.js";

/*
 * 游乐场产物测试：web/ 下的生成物必须真的能跑。
 * 这些用例同时充当「产物漂移」检查——改了 web/apps/*.jlc 或运行时源码却不跑
 * npm run build:web，这里就会红。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");
const exists = (relative) => {
  try {
    readFileSync(join(ROOT, relative));
    return true;
  } catch {
    return false;
  }
};

/** 产物是经典脚本（IIFE），在 Node 里用 new Function 直接求值即可。 */
function evaluate(relative, name) {
  if (!exists(relative)) throw new Error(`缺少产物 ${relative}：请先运行 npm run build:web`);
  // eslint-disable-next-line no-new-func
  new Function(read(relative))();
  const value = globalThis[name];
  if (!value) throw new Error(`${relative} 没有挂出 globalThis.${name}`);
  return value;
}

const runtime = evaluate("web/jlc-runtime.js", "JLCRuntime");
const full = evaluate("web/jlc-full.js", "JLCFull");
const registry = evaluate("web/registry.js", "JLC_REGISTRY");

function inlineBytecode(html) {
  const block = /<script id="jlc-module" type="text\/jbc"[^>]*>\s*([\s\S]*?)\s*<\/script>/.exec(html);
  if (!block) throw new Error("页面里找不到内联的 script[type=\"text/jbc\"]");
  const binary = Buffer.from(block[1].replace(/\s+/gu, ""), "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

test("游乐场产物与运行时版本一致", () => {
  assert.equal(registry.version, runtime.VERSION);
  assert.equal(registry.abi, runtime.ABI_VERSION);
  assert.equal(registry.bytecode, runtime.BYTECODE_VERSION);
  assert.ok(registry.apps.length >= 4, "至少要有几个演示应用");
  assert.deepEqual(registry.apps.map((app) => app.name), [...registry.apps.map((app) => app.name)].sort());
  for (const profile of ["strict", "open", "trusted"]) {
    const entry = registry.profiles.find((item) => item.name === profile);
    assert.ok(entry, `注册表要公开 ${profile} 档的策略字段`);
    assert.equal(entry.policy.profile, profile);
    assert.equal(typeof entry.policy.fingerprint, "string");
    assert.equal(entry.policy.allowSandboxedFrames, profile !== "strict");
    assert.equal(entry.policy.allowDataUrls, profile !== "strict");
  }
});

test("仅运行时的经典脚本能装载并渲染沙箱页里的字节码", () => {
  const app = registry.apps.find((item) => item.policy === "strict") ?? registry.apps[0];
  const bytes = inlineBytecode(read(`web/apps/${app.name}.html`));
  const module = runtime.loadModule(bytes, { sourceName: `${app.name}.jbc` });
  assert.equal(module.verified, true);
  assert.equal(module.app, app.app);

  const kernel = runtime.createVMKernel({ fault: "degrade", isolation: "soft" });
  const { document, target } = createDOM();
  const handle = kernel.mount(module, target, { document, policy: app.policy });
  assert.equal(handle.active, true);
  assert.match(target.textContent, /\S/u);

  const usage = handle.inspect();
  assert.ok(usage.scopes > 0);
  assert.equal(usage.denials, 0, `${app.name} 在自己声明的 ${app.policy} 档下不该被收回接口`);
  assert.deepEqual(handle.permissions().filter((item) => !item.granted), []);

  handle.unmount();
  assert.equal(target.textContent, "");
  assert.equal(kernel.list().length, 0);
});

test("VM 内核没有编译器：游乐场页面无法自行编译源码", () => {
  const kernel = runtime.createVMKernel();
  assert.throws(() => kernel.compile("app A { view { text 1; } }"), /不包含编译器/u);
  assert.throws(() => kernel.parse("app A {}"), /不包含 Parser/u);
  assert.throws(() => kernel.mount("app A { view { text 1; } }", createDOM().target), /只能挂载字节码模块/u);
});

test("页面内联的 .jbc 与源文件重新编译的结果逐字节一致", () => {
  for (const app of registry.apps) {
    const source = read(`web/apps/${app.name}.jlc`);
    const program = full.JLC.compile(source, { sourceName: `web/apps/${app.name}.jlc`, policy: app.policy, policyMode: "manifest" });
    const rebuilt = Buffer.from(program.serialize()).toString("base64");
    const embedded = Buffer.from(inlineBytecode(read(`web/apps/${app.name}.html`))).toString("base64");
    assert.equal(embedded, rebuilt, `${app.name}.html 里的字节码过期了：跑 npm run build:web`);
  }
});

test("接口清单与注册表一致，且各档位的收回预告可信", () => {
  for (const app of registry.apps) {
    const module = full.JLC.compile(read(`web/apps/${app.name}.jlc`), { sourceName: app.name, policy: app.policy, policyMode: "manifest" }).module;
    const fromModule = (module.requirements ?? []).map((item) => `${item.kind}:${item.detail}`).sort();
    assert.deepEqual(app.requirements.map((item) => item.key).sort(), fromModule, `${app.name} 的清单与源文件不一致`);

    // 声明档必须全部授予，否则页面根本不该出现在注册表里
    assert.deepEqual(Object.keys(app.denialsByProfile[app.policy]).length ? app.denialsByProfile[app.policy] : [], [], `${app.name} 在 ${app.policy} 档下有被收回的接口`);
    if (app.name === "html-preview") {
      assert.deepEqual(app.denialsByProfile.strict.map((item) => item.key).sort(), ["frame:iframe", "frame:srcdoc"]);
      assert.deepEqual(app.denialsByProfile.trusted.map((item) => item.key), []);
    }
    if (app.name === "palette") {
      // 字面量 data: URL 进了静态清单，但 URL 类接口默认只在中立化时记账：
      // 除非策略打开 strictUrls，它不构成装载期拒绝。
      assert.ok(app.requirements.some((item) => item.kind === "url" && item.detail === "data:"));
      assert.deepEqual(app.denialsByProfile.strict, []);
      const strictUrls = full.JLC.checkPolicy(
        full.JLC.compile(read(`web/apps/${app.name}.jlc`), { sourceName: app.name, policy: "strict", policyMode: "defer" }),
        { profile: "strict", strictUrls: true },
      );
      assert.deepEqual(strictUrls.map((item) => item.key), ["url:data:"]);
    }
    if (app.name === "tracer") {
      assert.deepEqual(app.denialsByProfile.strict.map((item) => item.key), ["window:event"]);
    }
    if (app.name === "json-browser") {
      // 端点是派生值：清单判不出来，strict 下只能靠运行时 sanitizer 兜底
      assert.deepEqual(app.denialsByProfile.strict, []);
    }
  }
});

test("应用页是零依赖的：没有 ES module、没有远程资源", () => {
  for (const app of registry.apps) {
    const html = read(`web/apps/${app.name}.html`);
    assert.match(html, /<script src="\.\.\/jlc-runtime\.js"><\/script>/u);
    assert.match(html, /<script src="\.\.\/app-page\.js"><\/script>/u);
    assert.match(html, /data-policy="strict|data-policy="open|data-policy="trusted"/u);
    assert.doesNotMatch(html, /<script type="module"/u, "opaque origin 下 module 会被 CORS 拦");
    assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/u, "除 SVG 命名空间外不该有外链");
    assert.doesNotMatch(html, /\bfetch\(|XMLHttpRequest/u);
  }
});

test("控制台脚本与沙箱胶水语法正确，并只经由 postMessage 通信", () => {
  const console_ = read("web/console.js");
  const glue = read("web/app-page.js");
  assert.match(glue, /global\.parent\.postMessage\(message, "\*"\)/u);
  assert.match(glue, /event\.source !== global\.parent/u, "必须拒绝非宿主指令");
  assert.match(console_, /postMessage\(\{ type: "jlc:load", jbc: state\.compiled\.jbc \}, "\*"\)/u);
  assert.doesNotMatch(console_, /contentDocument|contentWindow\.(?:document|location\s*=)/u, "控制台不得直接摸沙箱框架的内部");
  // 两个脚本都能被解析（语法错误会在这里抛）
  new Function(console_);
  new Function(glue);
});
