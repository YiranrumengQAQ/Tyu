/*
 * JLC OS 0.5 · 宿主集成测试（零依赖，node --test 之外直接跑）
 *
 *   node web/0.5/tools/integration.mjs
 *
 * 用真 VM（jlc.js）+ 仓库自带 fake DOM，按宿主的真实装配方式
 * （真 createCapabilities + 真 createLocalApi + 真 IndexedDB 内存降级存储 + 真 state 水合）
 * 挂载全部 0.5 系统应用，验证：
 *   - 目录 / 权限表 / 版本 / 浏览器信息经 jlc:// 本地路由正确渲染
 *   - IndexedDB 状态水合（mount({ state })）生效
 *   - storagePut capability 真正写进本机存储
 *   - 未授权路由 403、跨应用命名空间隔离、system 路由仅限系统应用
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(new URL(import.meta.url)));
const WEB05 = resolve(HERE, "..");
process.chdir(resolve(HERE, "..", "..", "..")); // 仓库根：支持文件与相对路径

const { JLC } = await import(join(process.cwd(), "jlc.js"));
const { createDOM } = await import(join(process.cwd(), "support/fake-dom.js"));
const { parsePageMeta } = await import(join(WEB05, "host", "meta.js"));
const { createStore } = await import(join(WEB05, "host", "storage.js"));
const { createPermissions } = await import(join(WEB05, "host", "permissions.js"));
const { createFileHost } = await import(join(WEB05, "host", "files.js"));
const { createLocalApi } = await import(join(WEB05, "host", "localapi.js"));
const { createCapabilities, capabilityDomainsFor } = await import(join(WEB05, "host", "capabilities.js"));
const { Catalog } = await import(join(WEB05, "host", "index.js"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toText = (node) => (node.nodeType === 3 ? (node.data ?? "") : (node.childNodes ?? []).map(toText).join(""));

const store = createStore();
await store.open();
const permissions = createPermissions(store);
await permissions.hydrate();
const files = createFileHost(store);
await files.loadRecents();
const uiStub = { toast: () => {}, permissionToast: () => {} };
const themeState = { current: () => "auto", effective: () => "light", set: async () => {} };
const pwaStub = { statusText: () => "请走浏览器菜单：添加到主屏幕" };
const capabilityHub = createCapabilities({ permissions, files, ui: uiStub, pwa: pwaStub, installer: null, themeState, router: { go: () => {} }, store });

const catalog = new Catalog();
const catalogRaw = JSON.parse(readFileSync(join(WEB05, "apps.json"), "utf8"));
catalog.entries = catalogRaw.apps.map((entry) => ({
  name: entry.name,
  origin: entry.dir === "system" ? "system" : "shared",
  icon: entry.icon ?? "▫",
  src: entry.dir === "system" ? `./apps/${entry.name}.jlc` : `../apps/${entry.name}.jlc`,
  diskPath: entry.dir === "system" ? join(WEB05, "apps", `${entry.name}.jlc`) : join(WEB05, "..", "apps", `${entry.name}.jlc`),
}));
for (const entry of catalog.entries) {
  const source = readFileSync(entry.diskPath, "utf8");
  catalog.metaCache.set(entry.name + "|" + entry.origin, { source, meta: parsePageMeta(source, entry.name), bytes: new Blob([source]).size });
}
const localApi = createLocalApi({ store, permissions, files, catalog, ui: uiStub, hostVersion: "0.5.0", kernelVersion: JLC.VERSION, themeState });

async function mountApp(name, { grants = {}, seed = {} } = {}) {
  const entry = catalog.resolve(name);
  assert.ok(entry, `目录里有 ${name}`);
  const { source, meta } = await catalog.source(entry);
  if (entry.origin === "system") {
    for (const domain of capabilityDomainsFor(entry, meta)) {
      if (permissions.modeOf(name, domain) == null) await permissions.set(name, domain, "always");
    }
  }
  for (const [domain, mode] of Object.entries(grants)) await permissions.set(name, domain, mode);
  const state = Object.create(null);
  for (const [key, value] of Object.entries(seed)) {
    await store.kvSet(name, key, value);
    state[key] = value;
  }
  const capabilities = capabilityHub.build(name, meta, entry);
  const fetchImpl = localApi.fetchFor(name, meta, entry);
  const { document, target } = createDOM();
  const errors = [];
  const handle = JLC.mount(source, target, {
    state,
    policy: entry.origin === "system" ? "trusted" : (meta.policy || "open"),
    isolation: meta.isolation || "strict",
    fault: "degrade",
    autoDispose: true,
    capabilities,
    fetch: fetchImpl,
    id: `app-${name}`,
    document,
    onError: (e) => errors.push(e),
  });
  return { handle, target, errors, meta };
}

/* 1. home：目录渲染 */
{
  const { handle, target, errors } = await mountApp("home");
  await sleep(120);
  const html = toText(target);
  assert.ok(html.includes("应用"), "首页标题");
  assert.ok(html.includes("待办清单"), "0.5 todo 卡片");
  assert.ok(html.includes("本地笔记"), "notes 卡片");
  assert.ok(html.includes("palette") || html.includes("样式作用域"), "0.4 共享应用出现");
  assert.ok(!errors.length, "无运行期错误: " + errors.map((e) => e.message).join(";"));
  handle.unmount();
  console.log("  home ok");
}

/* 2. todo：state 水合 + storagePut 落盘 */
{
  const seed = { items: [{ id: 41, text: "水合任务甲", done: true }, { id: 42, text: "水合任务乙", done: false }], done: 1, nextId: 43 };
  const { handle, target, errors } = await mountApp("todo", { grants: { storage: "always" }, seed });
  await sleep(120);
  const html = toText(target);
  assert.ok(html.includes("水合任务甲"), "IndexedDB 状态被水合进应用");
  assert.ok(!html.includes("读 SPEC.md"), "种子数据被已存状态覆盖");
  handle.set("draft", "从测试写入的第三条");
  handle.call("add");
  await sleep(30);
  const saved = await store.kvGet("todo", "items");
  assert.equal(saved.length, 3, "storagePut 已落盘");
  assert.ok(saved.some((item) => item.text === "从测试写入的第三条"), "新任务进了本机库");
  assert.ok(toText(target).includes("从测试写入的第三条"), "界面同步更新");
  assert.ok(!errors.length, "无运行期错误: " + errors.map((e) => e.message).join(";"));
  handle.unmount();
  console.log("  todo ok（水合 + 持久化）");
}

/* 3. notes：水合到 textarea value */
{
  const seed = { notes: [{ id: 7, title: "水合笔记", body: "正文甲" }], currentId: 7, draftTitle: "水合笔记", draftBody: "正文甲" };
  const { handle, target, errors } = await mountApp("notes", { grants: { storage: "always", clipboard: "always", files: "always" }, seed });
  await sleep(120);
  const html = toText(target);
  assert.ok(html.includes("水合笔记"), "笔记标题水合");
  const textarea = target.querySelector ? target.querySelector("textarea") : null;
  const taValue = textarea ? (textarea.getAttribute("value") ?? textarea.value ?? "") : "";
  assert.ok(taValue.includes("正文甲"), "笔记正文水合（textarea value）");
  assert.ok(!errors.length, "无运行期错误: " + errors.map((e) => e.message).join(";"));
  handle.unmount();
  console.log("  notes ok");
}

/* 4. files：占位渲染 + 按钮 */
{
  const { handle, target, errors } = await mountApp("files", { grants: { files: "always" } });
  await sleep(120);
  const html = toText(target);
  assert.ok(html.includes("文件"), "标题");
  assert.ok(html.includes("打开文件"), "打开按钮渲染");
  assert.ok(!errors.length, "无运行期错误: " + errors.map((e) => e.message).join(";"));
  handle.unmount();
  console.log("  files ok");
}

/* 5. permissions：权限表渲染 + 档位 */
{
  await permissions.set("todo", "storage", "always");
  const { handle, target, errors } = await mountApp("permissions");
  await sleep(120);
  const html = toText(target);
  assert.ok(html.includes("权限中心"), "标题");
  assert.ok(html.includes("待办清单"), "应用行渲染");
  assert.ok(html.includes("始终"), "always 档位渲染");
  assert.ok(!errors.length, "无运行期错误: " + errors.map((e) => e.message).join(";"));
  handle.unmount();
  console.log("  permissions ok");
}

/* 6. settings：browser / version / storage 资源 */
{
  const { handle, target, errors } = await mountApp("settings", { grants: { browser: "always", pwa: "always", theme: "always" } });
  await sleep(120);
  const html = toText(target);
  assert.ok(html.includes("设置"), "标题");
  assert.ok(html.includes("跟随系统"), "主题按钮");
  assert.ok(html.includes("内核"), "关于区块");
  assert.ok(!errors.length, "无运行期错误: " + errors.map((e) => e.message).join(";"));
  handle.unmount();
  console.log("  settings ok");
}

/* 7. apps：目录列表 + shadow 标记 */
{
  const { handle, target, errors } = await mountApp("apps");
  await sleep(120);
  const html = toText(target);
  assert.ok(html.includes("应用目录"), "标题");
  assert.ok(html.includes("已被 0.5 同名应用覆盖"), "shadow 标记");
  assert.ok(!errors.length, "无运行期错误: " + errors.map((e) => e.message).join(";"));
  handle.unmount();
  console.log("  apps ok");
}

/* 8. 安全边界：未授权 403 / 跨应用隔离 / system 路由仅限系统应用 */
{
  // 用一个真正的 0.4 共享应用（palette）来验边界
  const entryUser = catalog.resolve("palette");
  assert.equal(entryUser.origin, "shared", "palette 是 0.4 共享应用");
  const userInfo = await catalog.source(entryUser);
  const userFetch = localApi.fetchFor("palette", userInfo.meta, entryUser);
  let r = await userFetch("jlc://clipboard/read");
  assert.equal(r.status, 403, "未授权 clipboard → 403");
  await permissions.set("palette", "storage", "always");
  r = await userFetch("jlc://storage/todo/items");
  assert.equal(r.status, 403, "有 storage 授权也不能跨应用命名空间 → 403");
  r = await userFetch("jlc://storage/palette/k", { method: "PUT", body: JSON.stringify({ a: 1 }) });
  assert.equal(r.status, 200, "自己的命名空间可写");
  r = await userFetch("jlc://meta/permissions");
  assert.equal(r.status, 403, "非系统应用读权限中心 → 403");
  r = await userFetch("jlc://data/clear-app/todo", { method: "PUT" });
  assert.equal(r.status, 403, "非系统应用清数据 → 403");
  const entrySys = catalog.resolve("permissions");
  const sysInfo = await catalog.source(entrySys);
  const sysFetch = localApi.fetchFor("permissions", sysInfo.meta, entrySys);
  r = await sysFetch("jlc://meta/permissions");
  assert.equal(r.status, 200, "系统应用读权限中心 → 200");
  console.log("  安全边界 ok");
}

/* 9. 0.4 共享应用经宿主通道挂载（宿主 fetch + 无额外 capability） */
{
  for (const name of ["todo", "palette", "json-browser", "tracer", "html-preview", "landscape"]) {
    const entry = catalog.entries.find((item) => item.name === name && item.origin === "shared");
    assert.ok(entry, `${name} 在 0.4 共享目录里`);
    const { source, meta } = await catalog.source(entry);
    const { document, target } = createDOM();
    const errors = [];
    const handle = JLC.mount(source, target, {
      policy: meta.policy || "open",
      isolation: meta.isolation || "strict",
      fault: "degrade",
      autoDispose: true,
      capabilities: capabilityHub.build(name, meta, entry),
      fetch: localApi.fetchFor(name, meta, entry),
      id: `app-04-${name}`,
      document,
      onError: (e) => errors.push(e),
    });
    await sleep(60);
    assert.ok(toText(target).length > 10, `${name} 渲染出内容`);
    assert.ok(!errors.length, `${name} 无运行期错误: ` + errors.map((e) => e.message).join(";"));
    handle.unmount();
    console.log(`  0.4 ${name} ok`);
  }
}

console.log("\n0.5 宿主集成测试全部通过 ✔");
