/* ================================================================
 * JLC 0.6.1 — Performance Kernel 模块总出口（kernel/index.js）
 *
 * 0.6.1 的新增子系统按职责拆在本目录（调度公平 / 帧预算 / DOM 事务 /
 * 内存 / 泄漏 / 取消 / 热路径 / 依赖图 / 增量检查点）。
 * 它们只依赖彼此、不反向依赖 jlc-vm.js，因此 jlc-vm.js 可以单向引入，
 * 对外表面仍然只有一个：import JLC from "./jlc.js"。
 * ================================================================ */

export { FrameBudgetManager, DEFAULT_LANE_BUDGETS } from "./frame-budget.js";
export { LaneGovernor, DEFAULT_LANE_QUOTAS } from "./scheduler-lanes.js";
export { DomTransaction } from "./dom-transaction.js";
export { KeyedNodeCache } from "./node-cache.js";
export { MemoryAccountant, MEMORY_ACCOUNTS, estimateBytes } from "./memory.js";
export { LeakDetector, LEAK_KINDS } from "./leak-detector.js";
export { CancellationRegistry } from "./cancellation.js";
export { HotPathCache } from "./hot-cache.js";
export { describeDependencyGraph, dependentsOf } from "./dependency-graph.js";
export { diffSignals, materializeSignals, promoteDependents, estimateEntryBytes } from "./checkpoint-delta.js";
