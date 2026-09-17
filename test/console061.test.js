import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as JLCModule from "../jlc.js";
import { createDOM } from "../support/fake-dom.js";

/*
 * 0.6.1 Runtime Console（web/0.6/index.html）回归测试：
 * 0.6.1 把控制台从「0.6 API 演示」升级为「runtime: full 的统一接管入口」。
 * 这里守住三件事：
 *   1) 页面真的以 runtime: "full" + 计划 §25 的推荐默认值挂载；
 *   2) 页面引用的 0.6.1 表面（cancel / sampleLeaks / context / lanes /
 *      memory / dependencyGraph / profile().sections）全部存在且形状稳定；
 *   3) 内嵌演示应用在全档位下可编译、可挂载、可操作。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = readFileSync(join(ROOT, "web/0.6/index.html"), "utf8");

function embeddedSource() {
  const match = /const source = String\.raw`([\s\S]*?)`;/.exec(HTML);
  assert.ok(match, "控制台必须内嵌一份 .jlc 演示源码");
  return match[1];
}

test("web/0.6 控制台已升级为 0.6.1 Runtime Console（runtime: full 统一入口）", () => {
  assert.match(HTML, /JLC 0\.6\.1 Runtime Console/u, "标题必须宣告 0.6.1");
  assert.match(HTML, /runtime:\s*"full"/u, "挂载必须走 runtime: full 档");
  assert.match(HTML, /frameBudgetMs:\s*6/u, "推荐默认值：帧预算 6ms");
  assert.match(HTML, /maxSliceSteps:\s*20_000/u, "推荐默认值：切片预算 20000");
  assert.match(HTML, /renderChunk:\s*64/u, "推荐默认值：渲染分片 64");
  assert.match(HTML, /checkpointLimit:\s*8/u, "推荐默认值：检查点 8 个");
  assert.match(HTML, /soft:\s*15_000,\s*hard:\s*20_000/u, "资源内核 2.0：dom 双限额");
  // 0.6.1 新操作面都要有真实按钮
  for (const action of ["cancel", "leak", "context", "patch1", "huge"]) {
    assert.match(HTML, new RegExp(`data-act="${action}"`, "u"), `缺少 ${action} 操作按钮`);
  }
});

test("web/0.6 控制台：页面导入的 0.6.1 符号全部存在", () => {
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(HTML);
  const imported = /import\s+[A-Za-z_$][\w$]*\s*,\s*\{([^}]*)\}\s*from\s*"[^"]+"/.exec(script[1]);
  assert.ok(imported, "控制台必须从 jlc.js 具名导入内核表面");
  for (const name of imported[1].split(",").map((item) => item.trim()).filter(Boolean)) {
    assert.ok(name in JLCModule, `jlc.js 必须导出 ${name}`);
  }
});

test("web/0.6 控制台：全档位挂载演示应用并操作 0.6.1 表面", async () => {
  const program = JLCModule.JLC.compile(embeddedSource(), { sourceName: "kernel-demo.jlc" });
  const report = JLCModule.JLC.verify(program);
  assert.equal(report.ok, true, `验证必须通过：${report.errors.join(" / ")}`);
  assert.equal(report.passes.length, 11);

  const { document, target } = createDOM();
  const handle = program.mount(target, {
    document,
    runtime: "full",
    policy: "open",
    profile: true,
    resources: { dom: { soft: 15000, hard: 20000 }, checkpoints: 8, workers: 4 },
    capabilities: { storagePut: () => true, mirror: () => "mirror ok" },
    capabilityPaths: { storagePut: "storage.indexeddb", mirror: "browser.navigation" },
    grants: { "storage.indexeddb": { mode: "session" } },
    state: { count: 0, rows: [] },
  });
  handle.flush();
  assert.match(target.textContent, /count=0/u);

  // runtime: full 的默认形态
  assert.equal(handle.policy().isolation, "strict");
  assert.equal(handle.policy().faultLevel, "restart");

  // Profile 2.0 分区 + 0.6.1 只读视图
  const profile = handle.profile();
  for (const section of ["cpu", "dom", "scheduler", "yield", "memory", "effects", "each", "network", "resource", "faults", "hotCache", "leaks"]) {
    assert.ok(section in profile.sections, `profile().sections.${section}`);
  }
  assert.equal(handle.leaks().enabled, true);
  assert.ok(handle.memory().accounts.state > 0);
  assert.equal(handle.context().module.abi, "jlc-abi/3");
  assert.ok(handle.lanes().frameBudget.enabled);
  assert.ok(Array.isArray(handle.dependencyGraph().signals));

  // delta 检查点 + 回滚
  handle.checkpoint("console");
  handle.set("count", 7);
  handle.flush();
  assert.equal(handle.get("count"), 7);
  handle.rollback("console");
  handle.flush();
  assert.equal(handle.get("count"), 0, "delta 检查点回滚照常工作");

  // EACH Diff 2：渲染一批行，再改一行，不新建节点
  await handle.call("grow", 128);
  handle.flush();
  const createdBefore = handle.profile().sections.dom.create;
  await handle.call("patchOne");
  handle.flush();
  assert.equal(handle.profile().sections.dom.create, createdBefore, "改 1 行不新建节点");

  // 取消内核：空队列取消 0 个也不许报错
  assert.equal(typeof handle.cancel(() => true), "number");
  assert.equal(typeof handle.sampleLeaks().enabled, "boolean");

  handle.unmount();
});
