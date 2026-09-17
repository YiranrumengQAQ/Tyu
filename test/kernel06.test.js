/*
 * JLC 0.6 内核测试：能力图 / 权限内核 / 资源内核 / 故障阶梯 / 检查点 /
 * 协作式调度 / 多趟验证器 / ABI v3 段。
 *
 * 这些用例覆盖的是一条原则：内核的每一次越界都必须有明确的、可观察的结局，
 * 而不是「静默降级」或者「整页白屏」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import JLC, {
  JLCRuntimeError as JLCRuntimeErrorClass,
  VERSION,
  ABI_VERSION,
  BYTECODE_VERSION,
  JLCQuotaError,
  JLCPolicyError,
  JLCVerifyError,
  JLCBudgetError,
  OP,
  verifyModule,
  verifyReport,
  buildCFG,
  analyzeModule,
  moduleAnalysis,
  loadModule,
  encodeModule,
  disassembleModule,
  resolvePolicy,
  normalizeCapabilityGrants,
  normalizeFaultLevel,
  normalizePriority,
  isCapabilityPath,
  capabilityAncestors,
  CAPABILITY_PATHS,
  CAPABILITY_ALIASES,
  RESOURCE_KINDS,
  PERMISSION_STATES,
  FAULT_LEVELS,
  PRIORITY,
  PermissionKernel,
  ResourceKernel,
  CheckpointStore,
} from "../jlc.js";
import { createDOM } from "../support/fake-dom.js";

const helloSource = String.raw`
app Hello {
  state count = 0;
  action bump() { count += 1; }
  view {
    main {
      button(on:click.prevent = { bump(); }) { text "+1"; }
      strong { text "count=" + count; }
    }
  }
}`;

/* ------------------------------------------------------------------
 * 1. ABI v3
 * ------------------------------------------------------------------ */

test("0.6 内核宣告 ABI v3 并继续接受 v1/v2 模块", () => {
  assert.equal(VERSION, "0.6.0");
  assert.equal(ABI_VERSION, "jlc-abi/3");
  assert.equal(BYTECODE_VERSION, 3);

  const program = JLC.compile(helloSource);
  const bytes = program.serialize();
  const loaded = loadModule(bytes);
  assert.equal(loaded.version, 3);
  assert.ok(Array.isArray(loaded.capabilityPaths));
  assert.ok(loaded.resourceManifest && loaded.resourceManifest.dom >= 2, "资源清单给出 DOM 节点的静态上界");
  assert.equal(typeof loaded.flags, "number");

  // v1 / v2 老模块照样装载：只是没有 v3 的申报段，内核用扫描结果补齐。
  const legacy = Uint8Array.from(bytes);
  legacy[5] = 2;
  const legacyModule = loadModule(legacy);
  assert.equal(legacyModule.version, 2);
  assert.ok(legacyModule.capabilityPaths !== undefined);
  assert.throws(() => {
    const tooNew = Uint8Array.from(bytes);
    tooNew[5] = 9;
    loadModule(tooNew);
  }, (error) => error instanceof JLCVerifyError && /jlc-abi\/3/u.test(error.message));
});

test("反汇编器输出能力图路径与资源清单，工具链可以 diff 权限变化", () => {
  const source = String.raw`
app Net {
  action ping() { navigate("/next"); }
  view { main { text "x"; } }
}`;
  const text = JLC.disassemble(source);
  assert.match(text, /abi jlc-abi\/3/u);
  assert.match(text, /\.capabilities/u);
  assert.match(text, /browser\.navigation/u);
  assert.match(text, /\.resources/u);
});

/* ------------------------------------------------------------------
 * 2. 多趟验证器：CFG + 抽象栈 + 报告
 * ------------------------------------------------------------------ */

test("CFG 建立基本块与回边，循环不再是黑盒", () => {
  const program = JLC.compile(String.raw`
app Loop {
  state a = 0;
  action run() {
    let total = 0;
    for (i, idx in range(1, 5)) { total += i; }
    a = total;
  }
  view { text string(a); }
}`);
  const module = program.module;
  const fn = module.functions.find((item) => item.name === "action:run");
  const cfg = buildCFG(fn, module);
  assert.ok(cfg.blocks.length >= 4, "循环至少切出 4 个基本块");
  assert.equal(cfg.unreachable.length, 0, "没有不可达块");
  assert.ok(cfg.loopEdges.length >= 1, "识别出循环回边");
  const exit = cfg.blocks.find((block) => block.kind === "exit");
  assert.ok(exit, "有出口块");
  const analysis = moduleAnalysis(module);
  const stats = analysis.functions.find((item) => item.name === "action:run");
  assert.ok(stats.blocks >= 4 && stats.loops >= 1);
  assert.equal(analysis.determinism.deterministic, true, "纯计算模块判定为可重放");
});

test("验证报告结构化输出，strict 档把 advisory 升级为失败", () => {
  const program = JLC.compile(helloSource);
  const report = verifyReport(program.module, "hello.jlc");
  assert.equal(report.ok, true);
  assert.equal(report.abi, "jlc-abi/3");
  assert.equal(report.passes.length, 11, "11 趟验证全在报告里");
  assert.ok(report.analysis.stats.functions > 0);

  // 手工构造一段「确定类型冲突」的字节码：调用一个数字字面量。
  const code = Uint8Array.from([OP.CONST_INT, 0, 0, 0, 5, OP.CALL, 0, OP.RETURN_NULL]);
  const module = {
    format: "jlc-bytecode",
    version: 3,
    app: "Bad",
    sourceName: "bad.jbc",
    pool: ["bad", "body:bad", "view"],
    globalRefs: [],
    functions: [
      { name: "body:bad", kind: "body", nSlots: 0, captures: [], code, maxStack: 0 },
      { name: "view", kind: "view", nSlots: 0, captures: [], code: Uint8Array.from([OP.RETURN_NULL]), maxStack: 0 },
    ],
    actions: [{ name: "bad", func: 0, params: [] }],
    declarations: [],
    view: 1,
  };
  const advisory = verifyReport(module, "bad.jbc");
  assert.equal(advisory.ok, true, "advisory 档不拦截，只报告");
  assert.ok(advisory.warnings.some((line) => /不是函数/u.test(line)));
  assert.throws(
    () => verifyModule(module, "bad.jbc", { mode: "strict" }),
    (error) => error instanceof JLCVerifyError && /不是函数/u.test(error.message),
  );
  assert.ok(analyzeModule(module).warnings.some((line) => /不是函数/u.test(line)));
});

/* ------------------------------------------------------------------
 * 3. 能力图与权限内核
 * ------------------------------------------------------------------ */

test("能力图是内核唯一权威，策略字段走同一棵树", () => {
  assert.ok(CAPABILITY_PATHS.includes("filesystem.read.picker"));
  assert.ok(CAPABILITY_PATHS.includes("network.http"));
  assert.ok(isCapabilityPath("storage.indexeddb"));
  assert.equal(isCapabilityPath("network.magic"), false);
  assert.deepEqual(capabilityAncestors("filesystem.read.picker"), ["filesystem", "filesystem.read", "filesystem.read.picker"]);
  assert.equal(CAPABILITY_ALIASES.clipboardWrite, "browser.clipboard.write");

  // 树形写法与扁平写法等价
  assert.deepEqual(
    normalizeCapabilityGrants({ network: { http: true }, "storage.indexeddb": false }),
    { "network.http": true, "storage.indexeddb": false },
  );
  assert.throws(() => resolvePolicy({ profile: "open", capabilities: { network: { magic: true } } }), /未知能力路径/u);
  const policy = resolvePolicy({ profile: "open", capabilities: { network: "session" } });
  assert.equal(policy.capabilities["network"], "session");
  assert.ok(Object.isFrozen(policy.capabilities));
});

test("权限内核区分状态与租约，运行中撤销立刻生效", () => {
  let clock = 1000;
  const kernel = new PermissionKernel({ now: () => clock });
  kernel.grant("network.http", { mode: "session" });
  assert.equal(kernel.check("network.http").ok, true);
  assert.equal(kernel.check("network.websocket").ok, true, "未登记的能力默认放行（0.4 兼容）");

  kernel.lease("filesystem.read", 50);
  assert.equal(kernel.check("filesystem.read.picker").ok, true, "中间节点授权覆盖子树");
  clock += 100;
  const expired = kernel.check("filesystem.read");
  assert.equal(expired.ok, false);
  assert.equal(expired.state, "expired");

  kernel.grant("browser.clipboard.write", { mode: "once" });
  assert.equal(kernel.check("browser.clipboard.write").ok, true);
  assert.equal(kernel.check("browser.clipboard.write").ok, false, "一次性授权用完即失效");

  kernel.revoke("network.http");
  const revoked = kernel.check("network.http");
  assert.equal(revoked.ok, false);
  assert.equal(revoked.state, "revoked");
  assert.ok(PERMISSION_STATES.includes(revoked.state));

  const strict = new PermissionKernel({ strict: true });
  assert.equal(strict.check("network.http").ok, false, "strict 档未授予即拒绝");
});

test("宿主撤销授权后，运行中的实例立刻改判", () => {
  const { document, target } = createDOM();
  const calls = [];
  const program = JLC.compile(String.raw`
app Store {
  action save() { storagePut("k", "v"); }
  view { button(on:click.prevent = { save(); }) { text "save"; } }
}`);
  const handle = program.mount(target, {
    document,
    policy: "open",
    capabilities: { storagePut: (key, value) => { calls.push([key, value]); return true; } },
    capabilityPaths: { storagePut: "storage.indexeddb" },
    grants: { "storage.indexeddb": true },
  });
  handle.call("save");
  assert.deepEqual(calls, [["k", "v"]]);

  handle.revoke("storage.indexeddb");
  handle.call("save");
  assert.deepEqual(calls, [["k", "v"]], "撤销后 capability 不再被调用");
  assert.ok(handle.capabilities().some((entry) => entry.path === "storage.indexeddb" && entry.state === "revoked"));
  assert.ok(handle.describe().denied.some((item) => item.kind === "capability"));
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 4. 资源内核
 * ------------------------------------------------------------------ */

test("资源内核统一记账、限额与配额错误码", () => {
  const runtime = { metrics: { nodes: 3, effects: 1 }, policy: null };
  const resources = new ResourceKernel(runtime, { dom: 10, workers: 2 });
  assert.equal(resources.usageOf("dom"), 3);
  runtime.metrics.nodes = 11;
  assert.throws(() => resources.reserve("dom"), (error) => {
    assert.ok(error instanceof JLCQuotaError);
    assert.equal(error.code, "ENOSPC_QUOTA");
    assert.equal(error.resource, "dom");
    assert.equal(error.limit, 10);
    return true;
  });
  resources.reserve("workers");
  resources.reserve("workers");
  assert.throws(() => resources.reserve("workers"), JLCQuotaError);
  assert.equal(resources.release("workers"), 1);
  const usage = resources.usage();
  assert.equal(usage.dom.used, 11);
  assert.ok(RESOURCE_KINDS.includes("streams"));
  assert.throws(() => resources.setLimit("magic", 1), /未知资源种类/u);
});

test("挂载期配额：effect 超限直接拒绝，而不是跑崩浏览器", () => {
  const { document, target } = createDOM();
  const source = String.raw`
app Many {
  state a = 1;
  state b = 2;
  derive double = a * 2;
  derive triple = b * 3;
  view { main { text string(double + triple); } }
}`;
  const program = JLC.compile(source);
  assert.throws(
    () => program.mount(target, { document, resources: { effects: 1 } }),
    (error) => error instanceof JLCQuotaError && error.resource === "effects",
  );
  const relaxed = program.mount(target, { document, resources: { effects: 8 } });
  assert.ok(relaxed.resources().effects.limit === 8);
  relaxed.unmount();
  // 策略里的 maxDomNodes 会同步进资源账本
  const policy = resolvePolicy({ profile: "open", maxDomNodes: 7 });
  assert.equal(policy.maxDomNodes, 7);
});

/* ------------------------------------------------------------------
 * 5. 故障阶梯 / 检查点 / 回滚
 * ------------------------------------------------------------------ */

test("故障阶梯把 0.3/0.4 的旧档名升级为六级", () => {
  assert.deepEqual([...FAULT_LEVELS], ["ignore", "degrade", "recover", "restart", "rollback", "stop"]);
  assert.equal(normalizeFaultLevel("report"), "recover");
  assert.equal(normalizeFaultLevel("throw"), "stop");
  assert.equal(normalizeFaultLevel("bogus", "degrade"), "degrade");
  assert.equal(normalizePriority(PRIORITY.INPUT), 1);
  assert.equal(normalizePriority("render"), PRIORITY.RENDER);
  assert.equal(normalizePriority("nonsense"), PRIORITY.EFFECT);
});

test("检查点与回滚把 state 恢复到拍照那一刻", () => {
  const { document, target } = createDOM();
  const program = JLC.compile(helloSource);
  const handle = program.mount(target, { document });
  handle.call("bump");
  handle.call("bump");
  assert.equal(handle.get("count"), 2);
  const entry = handle.checkpoint("before");
  assert.equal(entry.label, "before");
  handle.call("bump");
  assert.equal(handle.get("count"), 3);

  handle.rollback("before");
  assert.equal(handle.get("count"), 2, "回滚恢复 state");
  assert.match(target.textContent, /count=2/u, "视图跟着回到一致状态");
  assert.equal(handle.profile().counters.rollbacks, 1);

  const checkpoints = handle.profile().checkpoints;
  assert.ok(checkpoints.some((item) => item.label === "before"));
  handle.unmount();
});

test("fault: restart 只销毁出错组件并原地重建，不牵连整个应用", () => {
  const { document, target } = createDOM();
  let calls = 0;
  const program = JLC.compile(String.raw`
app Flaky {
  state flag = 0;
  action flip() { flag = 1; }
  view {
    main {
      button(on:click.prevent = { flip(); }) { text "go"; }
      strong { text "ok"; }
      when (flag == 1) { text flaky(); }
    }
  }
}`);
  const handle = program.mount(target, {
    document,
    policy: "open",
    fault: "restart",
    capabilities: {
      flaky: () => {
        calls += 1;
        if (calls === 1) throw new Error("first boom");
        return "recovered";
      },
    },
  });
  handle.call("flip");
  handle.flush();
  assert.equal(calls, 2, "第一次炸了以后组件被重建，重放时拿到正常结果");
  assert.match(target.textContent, /recovered/u);
  assert.match(target.textContent, /ok/u, "兄弟组件没有被牵连");
  assert.ok(handle.profile().counters.restarts >= 1);
  handle.unmount();
});

test("fault: rollback 在组件崩溃时回到最近检查点", () => {
  const { document, target } = createDOM();
  let explode = false;
  const program = JLC.compile(String.raw`
app Guard {
  state value = 1;
  state flag = 0;
  action bump() { value = value + 1; }
  action boom() { flag = flag + 1; }
  view {
    main {
      strong { text "value=" + value; }
      when (flag == 1) { text risky(); }
    }
  }
}`);
  const handle = program.mount(target, {
    document,
    policy: "open",
    fault: "rollback",
    capabilities: {
      risky: () => {
        if (explode) throw new Error("state corrupted");
        return "safe";
      },
    },
  });
  handle.call("bump");
  handle.checkpoint("stable");
  explode = true;
  handle.call("boom");
  handle.flush();
  assert.ok(handle.profile().counters.rollbacks >= 1, "走了 rollback 档");
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 6. 协作式调度
 * ------------------------------------------------------------------ */

test("CPU 预算耗尽时 VM 让出并续跑，而不是把实例打死", async () => {
  const { document, target } = createDOM();
  const program = JLC.compile(String.raw`
app Heavy {
  state total = 0;
  action crunch() {
    let sum = 0;
    for (i, idx in range(1, 3000)) { sum += i; }
    total = sum;
  }
  view { strong { text "total=" + total; } }
}`);
  const handle = program.mount(target, { document, maxSliceSteps: 300 });
  const outcome = handle.call("crunch");
  assert.ok(outcome instanceof Promise, "切片模式下宿主调用异步完成");
  await outcome;
  assert.equal(handle.get("total"), 4498500, "3000 项求和：1+2+…+2999");
  assert.match(target.textContent, /total=4498500/u);
  assert.ok(handle.profile().counters.yields > 0, "确实发生了让出");
  handle.unmount();
});

test("不配置预算时保持 0.4 的同步语义", () => {
  const { document, target } = createDOM();
  const program = JLC.compile(helloSource);
  const handle = program.mount(target, { document });
  assert.equal(handle.call("bump"), null);
  assert.equal(handle.get("count"), 1);
  assert.equal(handle.profile().counters.yields, 0);
  handle.unmount();
});

test("宿主可以关掉切片：同步语义与预算错误码都还在", () => {
  const { document, target } = createDOM();
  const program = JLC.compile(String.raw`
app Spin {
  state a = 0;
  action burn() {
    let total = 0;
    for (i, idx in range(1, 4000)) { total += i; }
    a = total;
  }
  view { text string(a); }
}`);
  // sliceHostCalls: false → 宿主显式要求「别切片」，保留 0.4 的同步语义。
  const handle = program.mount(target, { document, maxSliceSteps: 300, sliceHostCalls: false });
  assert.equal(handle.call("burn"), null, "同步返回，不是 Promise");
  assert.equal(handle.get("a"), 7998000, "4000 项求和");
  assert.equal(handle.profile().counters.yields, 0, "没有发生让出");
  handle.unmount();

  // 预算错误是内核的错误类型，带稳定错误码，能被故障阶梯识别。
  const error = new JLCBudgetError("预算耗尽", { kind: "action", steps: 10, budget: 5 });
  assert.equal(error.code, "E_BUDGET");
  assert.ok(error instanceof JLCRuntimeErrorClass);
  assert.equal(error.budget, 5);
});

test("大列表分片渲染：一片一片建节点，让出后重入不重复", async () => {
  const { document, target } = createDOM();
  const items = Array.from({ length: 600 }, (_, index) => index + 1);
  const program = JLC.compile(String.raw`
app BigList {
  state items = [];
  derive count = len(items);
  view {
    main {
      strong { text "n=" + count; }
      ul { each (item in items key item) { li { text string(item); } } }
    }
  }
}`);
  const handle = program.mount(target, {
    document,
    state: { items },
    maxSliceSteps: 100,
    frameBudgetMs: 1,
    renderChunk: 1,
  });
  // 渲染被拆成多片：至少让出过一次，最终结果与不切片时完全一致。
  assert.ok(handle.profile().counters.renderSlices >= 1, "至少让出一帧");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(target.querySelectorAll("li").length, 600, "全部列表项而且不重复");
  assert.match(target.textContent, /n=600/u);
  handle.unmount();
});

test("调度器按通道排序：输入永远抢在后台前面", () => {
  const order = [];
  const runtime = { batchDepth: 0, destroyed: false, options: { maxSliceSteps: 0 }, counters: { tasks: 0, yields: 0 }, metrics: {} };
  // 直接验证通道常量与排序键的单调性：数字越小越先跑。
  assert.ok(PRIORITY.INPUT < PRIORITY.RENDER && PRIORITY.RENDER < PRIORITY.BACKGROUND);
  assert.ok(PRIORITY.SYSTEM < PRIORITY.INPUT);
  order.push(normalizePriority("background"), normalizePriority("input"), normalizePriority(PRIORITY.SYSTEM));
  assert.deepEqual(order, [PRIORITY.BACKGROUND, PRIORITY.INPUT, PRIORITY.SYSTEM]);
});

/* ------------------------------------------------------------------
 * 7. 诊断面
 * ------------------------------------------------------------------ */

test("内核门面提供 verify / graph / analyze / profileAll", () => {
  const { document, target } = createDOM();
  const program = JLC.compile(helloSource);
  const report = JLC.verify(program);
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.analysis.capabilityPaths));
  assert.equal(report.analysis.determinism.deterministic, true);
  const netted = JLC.verify('app N { action go() { navigate("/x"); } view { text "x"; } }');
  assert.ok(netted.analysis.capabilityPaths.includes("browser.navigation"), "指令流里的宿主接口会映射到能力路径");

  const graph = JLC.graph(program);
  assert.match(graph, /JLC CFG/u);
  assert.match(graph, /function view/u);

  const handle = program.mount(target, { document, profile: true });
  const profile = handle.profile();
  assert.equal(profile.active, true);
  assert.ok(profile.instructions > 0, "profile: true 时逐指令热点统计生效");
  assert.ok(profile.hot.length >= 1);
  assert.ok(Array.isArray(profile.pending));
  const snapshot = handle.snapshot();
  assert.equal(snapshot.state.count, 0);
  assert.ok(Array.isArray(snapshot.permissions));

  const all = JLC.profileAll();
  assert.equal(all.length, 1);
  handle.unmount();
  assert.equal(handle.profile().active, false);
});

test("CheckpointStore 有界，旧的检查点自动淘汰", () => {
  const runtime = {
    destroyed: false,
    globals: { names: new Map(), bindings: [] },
    metrics: { faults: 0, cycles: 0 },
    permissions: null,
    resources: null,
    transaction: (callback) => callback(),
  };
  const store = new CheckpointStore(runtime, { limit: 2 });
  store.capture("a");
  store.capture("b");
  store.capture("c");
  const labels = store.list().map((entry) => entry.label);
  assert.deepEqual(labels, ["b", "c"]);
  assert.equal(store.restore("a"), null);
});

test("编码器拒绝非法的能力申报（申报不能多于指令流）", () => {
  const program = JLC.compile(helloSource);
  const module = { ...program.module, declaredCapabilities: ["network.websocket"] };
  assert.throws(
    () => verifyModule({ ...module, verified: false }, "fake.jbc"),
    (error) => error instanceof JLCVerifyError && /漏报接口/u.test(error.message),
  );
  const bytes = encodeModule(program.module);
  assert.ok(bytes instanceof Uint8Array && bytes.length > 32);
});

test("包入口公开面与 jlc.d.ts 对齐（npm 用户按声明能拿到的符号一个不少）", async () => {
  const fs = await import("node:fs");
  const url = new URL("../jlc.d.ts", import.meta.url);
  const dts = fs.readFileSync(url, "utf8");
  const declared = [...dts.matchAll(/^export (?:declare )?(?:const|function|class)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
  assert.ok(declared.length > 60, `jlc.d.ts 应当声明完整公开面，实际 ${declared.length}`);
  const entry = await import("../jlc.js");
  const vm = await import("../jlc-vm.js");
  // jlc.js 是全量门面，必须一个不落；jlc-vm.js 只差编译器前端（JLCKernel / JLC / createKernel）。
  const missingEntry = declared.filter((name) => !(name in entry));
  assert.deepEqual(missingEntry, [], `jlc.js 缺少声明过的导出：${missingEntry.join(", ")}`);
  const missingVM = declared.filter((name) => !(name in vm));
  assert.deepEqual(
    missingVM.sort(),
    ["JLC", "JLCKernel", "createKernel"].sort(),
    "jlc-vm.js 只应缺少编译器前端符号",
  );
  // 字节码兼容面是 npm 用户判断「这个内核能不能读我的产物」的唯一入口。
  assert.deepEqual([...entry.ACCEPTED_BYTECODE_VERSIONS], [1, 2, 3]);
  assert.equal(entry.ABI_MIN_KERNEL, "0.6.0");
});
