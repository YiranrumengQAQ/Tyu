import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as JLCModule from "../jlc.js";
import { createDOM } from "../support/fake-dom.js";

/*
 * 0.6 内核控制台（web/0.6/index.html）回归测试：
 * 它不是一个静态说明页——页面里每个按钮都在调真实的内核 API。
 * 这里守住两件事：
 *   1) 页面内嵌的 .jlc 演示应用必须能编译、能通过 11 趟验证、能真的挂上去；
 *   2) 面板依赖的 0.6 表面（capabilities / resources / profile / checkpoint /
 *      rollback / grant / revoke / verify / graph）必须存在且形状稳定。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(ROOT, "web/0.6/index.html"), "utf8");

/** 从 HTML 里抠出控制台演示应用的源码（页面用 String.raw 内联同一份）。 */
function embeddedSource() {
  const match = /const source = String\.raw`([\s\S]*?)`;/.exec(HTML);
  assert.ok(match, "控制台必须内嵌一份 .jlc 演示源码");
  return match[1];
}

/** 页面 <script type="module"> 里从 jlc.js 具名导入的符号。 */
function importedNames() {
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(HTML);
  assert.ok(script, "控制台必须有内联 module 脚本");
  const imported = /import\s+[A-Za-z_$][\w$]*\s*,\s*\{([^}]*)\}\s*from\s*"[^"]+"/.exec(script[1]);
  assert.ok(imported, "控制台必须从 jlc.js 具名导入 0.6 表面");
  return imported[1].split(",").map((name) => name.trim()).filter(Boolean);
}

test("web/0.6 内核控制台：导入的内核符号全部存在", () => {
  for (const name of importedNames()) {
    assert.ok(name in JLCModule, `jlc.js 必须导出 ${name}`);
  }
  assert.ok(JLCModule.CAPABILITY_PATHS.length > 0, "能力图必须有路径");
  assert.deepEqual(
    [...JLCModule.FAULT_LEVELS],
    ["ignore", "degrade", "recover", "restart", "rollback", "stop"],
    "六级故障阶梯的顺序是内核契约",
  );
});

test("web/0.6 内核控制台：演示应用可编译、可验证、可挂载", () => {
  const program = JLCModule.JLC.compile(embeddedSource(), { sourceName: "kernel-demo.jlc" });
  const report = JLCModule.JLC.verify(program);
  assert.equal(report.ok, true, `验证必须通过：${report.errors.join(" / ")}`);
  assert.equal(report.passes.length, 11, "11 趟验证一趟不少");
  assert.equal(report.analysis.determinism.deterministic, true);
  assert.ok(Array.isArray(report.analysis.capabilityPaths), "分析结果要带能力路径");

  const { document, target } = createDOM();
  // 演示应用声明了两项宿主能力（storagePut / mirror）：不提供就无法挂载
  // ——这正是 0.6 的「没有 VM 授权就没有宿主能力」。
  const handle = program.mount(target, {
    document,
    policy: "open",
    fault: "restart",
    profile: true,
    capabilities: { storagePut: () => true, mirror: () => "mirror ok" },
    capabilityPaths: { storagePut: "storage.indexeddb", mirror: "browser.navigation" },
    grants: { "storage.indexeddb": { mode: "session" } },
  });
  handle.flush();
  assert.match(target.textContent, /count=0/u);
  assert.match(target.textContent, /count ≤ 3/u);
  handle.unmount();
});

test("web/0.6 内核控制台：面板读取的 0.6 视图形状稳定", async () => {
  const { document, target } = createDOM();
  const events = [];
  const handle = JLCModule.JLC.compile(embeddedSource()).mount(target, {
    document,
    policy: "open",
    fault: "restart",
    profile: true,
    capabilities: {
      storagePut: (key, value) => events.push(`put:${key}=${value}`),
      mirror: () => "mirror ok",
    },
    capabilityPaths: { storagePut: "storage.indexeddb", mirror: "browser.navigation" },
    grants: { "storage.indexeddb": { mode: "session" } },
    state: { count: 0, rows: [] },
  });
  handle.flush();

  // 能力图视图：路径 / 状态 / 模式 / 调用计数
  const [grant] = handle.capabilities();
  assert.equal(grant.path, "storage.indexeddb");
  assert.equal(grant.granted, true);
  assert.equal(grant.mode, "session");

  // 宿主直接调用 action：能力被记账
  await handle.call("bump");
  handle.flush();
  assert.deepEqual(events, ["put:count=1"]);
  assert.equal(handle.capabilities()[0].calls, 1);

  // 撤销后同一个 action 照样 +1，但宿主能力被内核拦下并记账
  handle.revoke("storage.indexeddb");
  await handle.call("bump");
  handle.flush();
  assert.equal(handle.get("count"), 2);
  assert.equal(handle.capabilities()[0].granted, false);
  assert.equal(handle.capabilities()[0].denials, 1);
  assert.deepEqual(events, ["put:count=1"], "撤销之后不可能再碰到宿主函数");

  // 资源内核：dom 用量 + 限额视图
  const resources = handle.resources();
  assert.ok(resources.dom.used > 0);
  assert.ok(resources.dom.limit > 0);
  assert.ok("checkpoints" in resources);

  // 检查点 / 回滚
  handle.checkpoint("test");
  handle.set("count", 42);
  handle.flush();
  assert.equal(handle.get("count"), 42);
  assert.equal(handle.rollback().label, "test");
  handle.flush();
  assert.equal(handle.get("count"), 2, "回滚要把 state 恢复到检查点那一刻");

  // 诊断：profile / tasks / snapshot
  const profile = handle.profile();
  assert.equal(typeof profile.counters.tasks, "number");
  assert.ok(Array.isArray(profile.hot));
  assert.ok(Array.isArray(profile.checkpoints));
  assert.ok(Array.isArray(handle.tasks()));
  assert.ok(Object.keys(handle.snapshot()).length > 0);

  handle.unmount();
});
