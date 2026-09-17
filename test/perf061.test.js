/*
 * JLC 0.6.1 — Full Runtime Takeover / Performance Kernel 测试
 *
 * 本版不改 ABI、不加新 VM 能力：考核的是「0.6 的全面接管在大型项目下
 * 跑得快、跑得稳、跑得久」。每个子系统都有独立用例：
 *
 *   Scheduler v2.1（老化 / 车道配额 / 饥饿营救）· Frame Budget ·
 *   DOM Transaction + Coalescing · EACH Diff 2 + Keyed Node Cache ·
 *   Reactive Batch 2.0 + Dependency Graph · Profile 2.0 · Hot Path Cache ·
 *   Resource Kernel 2.0（soft/hard）· Memory Accountant · Delta Checkpoint ·
 *   Fault Auto-Escalation · Leak Detector · Network Scheduler ·
 *   Cancellation Kernel · runtime: "full" · VM Execution Context。
 */

import test from "node:test";
import assert from "node:assert/strict";
import JLC, {
  VERSION,
  ABI_VERSION,
  BYTECODE_VERSION,
  ACCEPTED_BYTECODE_VERSIONS,
  RUNTIME_PRESETS,
  resolveRuntimePreset,
  FAULT_ESCALATION,
  FrameBudgetManager,
  LaneGovernor,
  DomTransaction,
  KeyedNodeCache,
  MemoryAccountant,
  estimateBytes,
  LeakDetector,
  CancellationRegistry,
} from "../jlc.js";
import { createDOM } from "../support/fake-dom.js";

const counterSource = String.raw`
app Counter {
  state count = 0;
  state name = "idle";
  derive double = count * 2;
  action bump() { count += 1; }
  action multi() { count += 1; count += 1; count += 1; }
  action rename(word) { name = word; }
  view {
    main {
      button(on:click.prevent = { bump(); }) { text "+1" }
      strong { text "count=" + count + " double=" + double }
      em { text "name=" + name }
    }
  }
}`;

// each 不带 key 表达式：按索引复用记录——「改 1 项只更新 1 项」的最小复现。
// （带表达式 key 的复用路径由 KeyedNodeCache 单测与分片重入测试覆盖。）
const listSource = String.raw`
app BigList {
  state rows = [];
  action grow(n) { rows = range(1, n); }
  action patch(i, v) { rows = replaceAt(rows, i, v); }
  view {
    main {
      ul { each (row in rows) { li { text "#" + string(row) } } }
    }
  }
}`;

function mount(source, options = {}) {
  const { document, target } = createDOM();
  const handle = JLC.compile(source).mount(target, { document, ...options });
  return { handle, target, document };
}

/* ------------------------------------------------------------------
 * 0. ABI 锁死：版本升 0.6.1，ABI 不动
 * ------------------------------------------------------------------ */

test("0.6.1：VERSION 升级，ABI / 字节码版本锁死不动", () => {
  assert.equal(VERSION, "0.6.1");
  assert.equal(ABI_VERSION, "jlc-abi/3");
  assert.equal(BYTECODE_VERSION, 3);
  assert.deepEqual([...ACCEPTED_BYTECODE_VERSIONS], [1, 2, 3], "0.4 / 0.5 / 0.6 的 .jbc 全部继续跑");
  assert.throws(() => resolveRuntimePreset("turbo"), /未知 runtime 档/, "未知运行档必须显式报错");
  assert.equal(Object.keys(resolveRuntimePreset(null)).length, 0, "缺省档 = 0.6 行为");
  assert.ok(RUNTIME_PRESETS.full.maxSliceSteps > 0, "full 档默认开启协作式调度");
});

/* ------------------------------------------------------------------
 * 1. Scheduler v2.1：老化 / 车道配额 / 饥饿营救
 * ------------------------------------------------------------------ */

test("Scheduler v2.1：Priority Aging 有界提升", () => {
  const governor = new LaneGovernor({ agingMs: 10, maxAgingSteps: 2 });
  const now = Date.now();
  const fresh = { priority: 6, submitted: now };
  const waiting = { priority: 6, submitted: now - 50 };
  assert.equal(governor.effectivePriority(fresh, now), 6, "新任务不提升");
  assert.equal(governor.effectivePriority(waiting, now), 4, "等待 5 个 agingMs 只提升 2 级（有界）");
});

test("Scheduler v2.1：Lane Quota 强制让出 + 饥饿营救", () => {
  const governor = new LaneGovernor({ defaultQuota: 3 });
  // P6 连跑 3 片后，还有 P1 在等 → 必须让出
  governor.noteRan(6); governor.noteRan(6); governor.noteRan(6);
  assert.equal(governor.canRun(6, new Set([1, 6])), false, "连跑满配额且别的车道在等 → 让出");
  assert.equal(governor.canRun(6, new Set([6])), true, "只有自己排队 → 不必空转");
  governor.noteForcedYield(6);
  assert.equal(governor.canRun(6, new Set([1, 6])), true, "强制让出后重新可跑");
  // 饥饿营救：P6 上次运行是很久以前 → 被认作饥饿车道
  const now = Date.now();
  governor.noteRan(6, now - 200);
  assert.equal(governor.starvedLane(new Set([6]), now), 6);
  assert.equal(governor.starvedLane(new Set([6]), now - 150), null, "刚跑过不算饥饿");
  const stats = governor.stats();
  assert.equal(stats.forcedYields["6"], 1);
});

test("Scheduler v2.1：挂载后可观察车道治理与帧预算", async () => {
  const { handle } = mount(listSource, {
    runtime: "full",
    policy: "open",
    resources: { dom: 20000 },
  });
  await handle.call("grow", 600);
  handle.flush();
  const lanes = handle.lanes();
  assert.ok(lanes.governor, "LaneGovernor 必须就位");
  assert.equal(typeof lanes.governor.runs, "object", "车道运行数被记账");
  assert.ok(lanes.frameBudget.frames >= 1, "flush = 一帧，帧预算被启用");
  assert.ok(lanes.frameBudget.enabled, "full 档帧预算开启");
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 2. VM Frame Budget：动态车道份额
 * ------------------------------------------------------------------ */

test("Frame Budget：紧急车道先预留，渲染用剩余，余量留给低车道", () => {
  const manager = new FrameBudgetManager({ frameBudgetMs: 8 });
  const frame = manager.begin(1000);
  assert.equal(frame.deadlines[0], 1000.5, "SYSTEM 0.5ms");
  assert.equal(frame.deadlines[1], 1001.5, "INPUT 累计 1.5ms");
  assert.equal(frame.deadlines[2], 1002.5, "INTERACTION 累计 2.5ms");
  assert.equal(frame.deadlines[3], 1005.5, "RENDER 累计 5.5ms");
  assert.equal(frame.deadlines[4], 1006.5, "EFFECT 累计 6.5ms");
  assert.equal(frame.deadlines[6], 1008, "BACKGROUND 用整帧余量");
  const disabled = new FrameBudgetManager({ frameBudgetMs: 0 });
  assert.equal(disabled.deadlineFor(disabled.begin(), 3), 0, "关闭帧预算 = 无截止时间（0.6 语义）");
});

/* ------------------------------------------------------------------
 * 3. DOM Transaction Kernel + Mutation Coalescing
 * ------------------------------------------------------------------ */

test("DOM Transaction：重复属性写被合并，一次提交落盘", () => {
  const { document } = createDOM();
  const tx = new DomTransaction();
  const text = document.createTextNode("");
  // A.text = 1 → 2 → 3：只落 3
  tx.setText(text, "1");
  tx.setText(text, "2");
  tx.setText(text, "3");
  const el = document.createElement("div");
  // class add → remove → add：净结果 add 一次
  tx.toggleClass(el, "hot", true);
  tx.toggleClass(el, "hot", false);
  tx.toggleClass(el, "hot", true);
  // attr 后写覆盖前写
  tx.setAttribute(el, "title", "a");
  tx.setAttribute(el, "title", "b");
  assert.equal(tx.stats.coalesced, 5, "2 次 text + 2 次 class + 1 次 attr 被消掉");
  assert.equal(tx.commit(), 3, "三个净操作一次提交");
  assert.equal(text.data, "3");
  assert.ok(el.classList.contains("hot"));
  assert.equal(el.getAttribute("title"), "b");
  assert.equal(tx.stats.commits, 1);
});

test("DOM Transaction：cssText 覆盖逐属性 style，结构记账齐全", () => {
  const { document } = createDOM();
  const tx = new DomTransaction();
  const el = document.createElement("div");
  tx.setStyleProperty(el, "color", "red");
  tx.setStyleProperty(el, "top", "1px");
  tx.setCssText(el, "margin: 0");
  assert.equal(tx.commit(), 1, "逐属性 style 被 cssText 吞并");
  assert.equal(el.style.cssText, "margin: 0");
  tx.noteCreate(3); tx.noteRemove(1); tx.noteMove(2);
  const stats = tx.statsView();
  assert.equal(stats.creates, 3);
  assert.equal(stats.removes, 1);
  assert.equal(stats.moves, 2);
});

test("DOM Transaction：runtime: full 下挂载渲染走事务提交", async () => {
  const { handle, target } = mount(counterSource, { runtime: "full", policy: "open" });
  assert.match(target.textContent, /count=0/u);
  await handle.call("multi");
  handle.flush();
  assert.match(target.textContent, /count=3/u, "事务提交后 DOM 与 state 一致");
  const dom = handle.profile().sections.dom;
  assert.ok(dom.commits >= 1, "至少发生一次统一提交");
  assert.ok(dom.create > 0 && dom.live > 0, "DOM 生命周期被记账");
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 4. EACH Diff Engine 2 + Keyed Node Cache
 * ------------------------------------------------------------------ */

test("EACH Diff 2：改 1 项只更新 1 项，其余全部命中复用", async () => {
  const { handle, target } = mount(listSource, { policy: "open" });
  await handle.call("grow", 65); // range(1, 65) = 64 项
  handle.flush();
  const before = handle.profile().sections.dom.create;
  await handle.call("patch", 3, 999);
  handle.flush();
  const each = handle.profile().sections.each;
  assert.ok(each.misses >= 64, `首屏 64 项全建（misses=${each.misses}）`);
  assert.ok(each.hits >= 63, `改 1 项后其余命中复用（hits=${each.hits}）`);
  const after = handle.profile().sections.dom.create;
  assert.equal(after, before, "修改单项不新建任何节点");
  assert.match(target.textContent, /#999/u);
  handle.unmount();
});

test("EACH Diff 2：KeyedNodeCache 命中率与淘汰", () => {
  const cache = new KeyedNodeCache({ maxSize: 3 });
  const owner = {};
  cache.miss(owner, 1); cache.miss(owner, 2); cache.miss(owner, 3);
  cache.hit(owner, 2);
  cache.miss(owner, 4); // 超限淘汰最旧
  cache.miss(owner, 5);
  const stats = cache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 5);
  assert.ok(stats.size <= 3, "缓存有上限，不会无限膨胀");
  cache.releaseOwner(owner);
  assert.equal(cache.size(), 0, "owner 销毁 → 整块释放");
});

/* ------------------------------------------------------------------
 * 5. Reactive Batch 2.0 + Effect Dependency Graph
 * ------------------------------------------------------------------ */

test("Reactive Batch 2.0：一批写入 = 一个事务，effect 去重", async () => {
  const { handle } = mount(counterSource, { policy: "open" });
  const base = handle.profile().counters;
  await handle.call("multi"); // 同一 action 里 3 次 count += 1
  handle.flush();
  const after = handle.profile().counters;
  assert.ok(after.transactions >= base.transactions + 1, "action 是有界事务");
  assert.ok(after.effectDeduped >= base.effectDeduped + 1, "连续状态变更被去重，不会一轮一变一渲染");
  handle.unmount();
});

test("Dependency Graph：只有依赖路径受影响才跑", async () => {
  const { handle } = mount(counterSource, { policy: "open" });
  const graph = handle.dependencyGraph();
  assert.ok(graph.signals.some((signal) => signal.name === "count"), "图里有 state.count");
  assert.ok(graph.signals.some((signal) => signal.name === "double"), "图里有 derive.double");
  assert.ok(graph.edges.length > 0, "订阅边被导出");

  const byCount = handle.dependents("count");
  assert.ok(byCount.length > 0, "count 有下游");
  const byCountNames = new Set(handle.dependencyGraph().effects.map((effect) => effect.id));
  assert.ok(byCount.every((entry) => byCountNames.has(entry.effect)), "牵动列表落在图内");

  // 改 name 不应牵动任何 count/double 的订阅者：先记录基线，再验证隔离。
  const touchedByCount = new Set(byCount.map((entry) => entry.effect));
  const byName = handle.dependents("name");
  for (const entry of byName) {
    assert.ok(!touchedByCount.has(entry.effect), "name 的下游不应与 count 的下游重叠");
  }
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 6. Profile 2.0 + Hot Path Cache
 * ------------------------------------------------------------------ */

test("Profile 2.0：分区齐全且旧字段兼容", async () => {
  const { handle } = mount(counterSource, { runtime: "full", policy: "open", profile: true });
  await handle.call("bump");
  handle.flush();
  const profile = handle.profile();
  // 0.6 旧表面一个不少
  assert.equal(typeof profile.counters.tasks, "number");
  assert.ok(Array.isArray(profile.hot));
  assert.ok(Array.isArray(profile.checkpoints));
  // 0.6.1 新分区
  const required = ["cpu", "dom", "scheduler", "yield", "memory", "effects", "each", "network", "resource", "faults", "hotCache", "leaks"];
  for (const section of required) assert.ok(section in profile.sections, `sections.${section} 缺失`);
  assert.equal(profile.sections.cpu.instructions, profile.instructions, "CPU 分区与总指令数一致");
  assert.equal(profile.sections.yield.vmYields, profile.counters.yields, "Yield 分区与计数器一致");
  handle.unmount();
});

test("Hot Path Cache：global / function 查找固化后命中", async () => {
  const { handle } = mount(counterSource, { policy: "open" });
  await handle.call("bump");
  await handle.call("bump");
  handle.flush();
  const cache = handle.profile().sections.hotCache;
  assert.ok(cache.globalHits > 0, "全局查找走缓存");
  assert.ok(cache.funcHits > 0, "函数元数据走缓存");
  assert.ok(cache.globalHitRate > 0.5, "热路径以命中为主");
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 7. Resource Kernel 2.0：soft / hard
 * ------------------------------------------------------------------ */

test("Resource 2.0：soft 只警告，hard 才拒绝", async () => {
  const warnings = [];
  const { handle } = mount(listSource, {
    policy: "open",
    resources: { dom: { soft: 4, hard: 400 } },
    onWarn: (info) => warnings.push(info),
    onError: () => {},
  });
  await handle.call("grow", 4);
  handle.flush();
  const dom = handle.resources().dom;
  assert.equal(dom.soft, 4);
  assert.equal(dom.limit, 400);
  assert.equal(dom.state, "warn", "越过 soft → warn 态");
  assert.ok(warnings.some((warning) => warning.resource === "dom"), "soft 警告送达宿主");
  handle.unmount();
});

test("Resource 2.0：越过 hard 抛 JLCQuotaError，数字限额兼容 0.6", () => {
  // dom: 1 连首屏的 main + ul 都放不下 → 挂载期硬失败（0.6 语义不变）
  assert.throws(
    () => mount(listSource, { policy: "open", resources: { dom: 1 }, onError: () => {} }),
    (error) => error.name === "JLCQuotaError" && /maxDomNodes|超过配额/u.test(error.message),
    "硬限额行为与 0.6 一致",
  );
});

/* ------------------------------------------------------------------
 * 8. Memory Accountant + Delta Checkpoint
 * ------------------------------------------------------------------ */

test("Memory Accountant：分户账随状态/检查点记账", async () => {
  const { handle } = mount(counterSource, { runtime: "full", policy: "open" });
  handle.checkpoint("m0");
  const memory = handle.memory();
  assert.ok(memory.accounts.state > 0, "state 户有账");
  assert.ok(memory.accounts.checkpoints > 0, "checkpoint 户有账");
  assert.ok(memory.totalKB >= 0);
  const accountant = new MemoryAccountant();
  accountant.charge("state", estimateBytes({ a: "hello", list: [1, 2, 3] }));
  assert.ok(accountant.total() > 0);
  handle.unmount();
});

test("Checkpoint 2.0：delta 快照 + 链式回滚 + 淘汰升级", async () => {
  const { handle } = mount(counterSource, { policy: "open", checkpointDelta: true, checkpointLimit: 8 });
  handle.checkpoint("a");                 // 全量
  handle.set("count", 10);
  handle.flush();
  handle.checkpoint("b");                 // delta（只记 count）
  handle.set("count", 20);
  handle.flush();
  const list = handle.profile().checkpoints;
  const entryB = list.find((entry) => entry.label === "b");
  assert.equal(entryB.delta, true, "第二份是 delta 快照");
  assert.equal(entryB.base, "a", "delta 指向 base");
  assert.equal(handle.get("count"), 20);
  handle.rollback("b");
  handle.flush();
  assert.equal(handle.get("count"), 10, "delta 条目沿链物化回滚");
  handle.rollback("a");
  handle.flush();
  assert.equal(handle.get("count"), 0, "回滚到最初的全量快照");
  handle.unmount();
});

test("Checkpoint 2.0：base 被淘汰时依赖者自动升级为完整快照", async () => {
  const { handle } = mount(counterSource, { policy: "open", checkpointDelta: true, checkpointLimit: 2 });
  handle.checkpoint("a");
  handle.set("count", 1); handle.flush();
  handle.checkpoint("b"); // delta base=a
  handle.set("count", 2); handle.flush();
  handle.checkpoint("c"); // 淘汰 a → b 必须升级
  handle.set("count", 3); handle.flush();
  const list = handle.profile().checkpoints;
  assert.equal(list.length, 2);
  const entryB = list.find((entry) => entry.label === "b");
  assert.ok(entryB, "b 仍在");
  handle.rollback("b");
  handle.flush();
  assert.equal(handle.get("count"), 1, "base 淘汰后 delta 链仍然可解");
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 9. Fault Recovery 2.0：自动升级 restart → rollback → degrade
 * ------------------------------------------------------------------ */

test("Fault 2.0：restart 反复失败自动升级到 rollback", async () => {
  const events = [];
  const { handle } = mount(String.raw`
app Flaky {
  state count = 0;
  action trigger() { count = 4; }
  view {
    main {
      when (count > 3) { text mirror(); }
      strong { text "count=" + count }
    }
  }
}`, {
    policy: "open",
    fault: "restart",
    capabilities: { mirror: () => { throw new Error("always boom"); } },
    capabilityPaths: { mirror: "browser.navigation" },
    grants: { "browser.navigation": { mode: "session" } },
    onFault: (_error, info) => events.push(info.mode),
    onError: () => {},
  });
  handle.checkpoint("safe");
  handle.flush();
  await handle.call("trigger");
  handle.flush();
  const counters = handle.profile().counters;
  assert.ok(counters.restarts >= 1, "先尝试组件级重启");
  assert.ok(counters.escalations >= 1, "重启耗尽后自动升级");
  assert.ok(counters.rollbacks >= 1, "升级到检查点回滚");
  assert.ok(events.includes("rollback") || events.includes("restart"), "onFault 收到决策");
  assert.deepEqual(FAULT_ESCALATION, { restart: "rollback", rollback: "degrade" }, "升级链是内核契约");
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 10. Leak Detector
 * ------------------------------------------------------------------ */

test("Leak Detector：无活动的单调增长被标记，回落被洗清", () => {
  const seen = [];
  const detector = new LeakDetector({ threshold: 10, windowSize: 3, onWarn: (info) => seen.push(info) });
  detector.sample({ scopes: 100, effects: 2, listeners: 1, timers: 0, requests: 0, tasks: 0, nodes: 50, activity: 0 });
  detector.sample({ scopes: 200, effects: 2, listeners: 1, timers: 0, requests: 0, tasks: 0, nodes: 60, activity: 0 });
  detector.sample({ scopes: 300, effects: 2, listeners: 1, timers: 0, requests: 0, tasks: 0, nodes: 70, activity: 0 });
  const report = detector.report();
  assert.ok(report.suspected.includes("scopes"), "scopes 单调增长 → POSSIBLE_LEAK");
  assert.ok(seen.some((warning) => warning.code === "POSSIBLE_LEAK" && warning.kind === "scopes"), "警告送达宿主");
  // 用户开始创建组件（activity 增加）→ 增长不再可疑
  detector.sample({ scopes: 400, effects: 2, listeners: 1, timers: 0, requests: 0, tasks: 0, nodes: 80, activity: 5 });
  detector.sample({ scopes: 500, effects: 2, listeners: 1, timers: 0, requests: 0, tasks: 0, nodes: 90, activity: 9 });
  detector.sample({ scopes: 600, effects: 2, listeners: 1, timers: 0, requests: 0, tasks: 0, nodes: 100, activity: 12 });
  assert.ok(!detector.report().suspected.includes("scopes"), "有用户活动的增长不算泄漏");
});

test("Leak Detector：runtime 集成（挂载即启用，可手动采样）", () => {
  const { handle } = mount(counterSource, { runtime: "full", policy: "open", leakDetector: { intervalMs: 0 } });
  const leaks = handle.leaks();
  assert.equal(leaks.enabled, true);
  const sample = handle.sampleLeaks();
  assert.ok(Array.isArray(sample.samples));
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 11. Cancellation Kernel
 * ------------------------------------------------------------------ */

test("Cancellation：组件销毁级联取消，宿主可按谓词取消", () => {
  const registry = new CancellationRegistry();
  const scope = { label: "component" };
  const tokenA = registry.register({ label: "worker", scope });
  const tokenB = registry.register({ label: "fetch", scope });
  const tokenC = registry.register({ label: "global-task" });
  let cleaned = 0;
  tokenA.onCancel(() => { cleaned += 1; });
  assert.equal(registry.cancelScope(scope), 2, "scope 销毁 → 名下任务全取消");
  assert.ok(tokenA.canceled && tokenB.canceled);
  assert.equal(cleaned, 1, "取消回调被触发");
  assert.equal(registry.cancel((token) => token.label === "global-task"), 1);
  assert.ok(tokenC.canceled);
  assert.equal(registry.stats().canceled, 3);
});

test("Cancellation：排队中的网络任务可以被宿主取消", async () => {
  const calls = [];
  const fetchStub = (url) => {
    calls.push(url);
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => "application/json" }, json: () => Promise.resolve({}) });
  };
  const { handle } = mount(String.raw`
app NetCancel {
  resource feed = http("/api/feed", { as: "json" });
  view { main { text "net" } }
}`, { policy: "open", networkScheduling: true, fetch: fetchStub });
  // 挂载同步阶段：请求已作为 P5 任务排队，但还没发出
  const pending = handle.tasks();
  assert.ok(pending.some((task) => task.label === "net:feed"), "网络请求以任务形态排队");
  const canceled = handle.cancel("net:feed");
  assert.equal(canceled, 1, "宿主按 label 取消排队任务");
  handle.flush();
  assert.equal(calls.length, 0, "被取消的请求永远不会出网");
  assert.ok(handle.profile().counters.cancels >= 1, "取消被记账");
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 12. Network Scheduler：P5 车道 + 统一管线
 * ------------------------------------------------------------------ */

test("Network Scheduler：resource 请求经 P5 车道发起", async () => {
  const calls = [];
  const fetchStub = (url) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ hello: "world" }),
      text: () => Promise.resolve("{}"),
    });
  };
  const { handle, target } = mount(String.raw`
app Net {
  resource feed = http("/api/feed", { as: "json" });
  view { main { text "net" } }
}`, { policy: "open", networkScheduling: true, fetch: fetchStub });
  assert.equal(calls.length, 0, "挂载同步阶段不直接出网");
  handle.flush();
  assert.equal(calls.length, 1, "flush 后由 P5 任务发起请求");
  assert.ok(handle.profile().counters.networkScheduled >= 1, "网络任务被记账");
  assert.match(target.textContent, /net/u);
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 13. runtime: "full" + VM Execution Context
 * ------------------------------------------------------------------ */

test('runtime: "full"：所有接管子系统一次启用', async () => {
  const { handle, target } = mount(counterSource, {
    runtime: "full",
    policy: "open",
    profile: true,
  });
  assert.match(target.textContent, /count=0/u);
  assert.equal(handle.policy().isolation, "strict", "full 档默认严格隔离");
  assert.equal(handle.policy().faultLevel, "restart", "full 档默认 fault: restart");
  await handle.call("bump");
  handle.flush();
  assert.match(target.textContent, /count=1/u);
  const profile = handle.profile();
  assert.equal(profile.runtime, "full");
  assert.ok(profile.sections.dom.commits >= 1, "DOM 事务启用");
  assert.ok(handle.memory().accounts.state > 0, "Memory Accountant 启用");
  assert.equal(handle.leaks().enabled, true, "Leak Detector 启用");
  assert.ok(handle.lanes().frameBudget.enabled, "Frame Budget 启用");
  handle.unmount();
});

test("VM Execution Context：任何执行都能回答自己是谁", async () => {
  const { handle } = mount(counterSource, { runtime: "full", policy: "open" });
  const context = handle.context();
  assert.equal(context.module.app, "Counter");
  assert.equal(context.module.abi, "jlc-abi/3");
  assert.ok(Array.isArray(context.state) && context.state.includes("count"), "状态清单可读");
  assert.ok(context.resources.dom, "资源账本在上下文里");
  assert.equal(context.fault.mode, "restart");
  assert.ok(context.domTransaction, "DOM 事务在上下文里");
  assert.ok(context.cancellation, "取消内核在上下文里");
  assert.ok(context.scheduler.lanes, "调度车道视图在上下文里");
  assert.ok(context.checkpoint.delta === true, "full 档检查点默认 delta");
  handle.unmount();
});
