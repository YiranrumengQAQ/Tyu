/* ================================================================
 * JLC 0.6.1 — Scheduler v2.1 车道治理（kernel/scheduler-lanes.js）
 *
 * 0.6 的 8 通道（P0..P7）是严格优先级：一个大型 EACH 占满 P3 时，
 * 只要它不让出，后台车道永远没机会；反过来低优先级车道也可能饿死。
 * 0.6.1 在不新增通道的前提下，把 8 通道做成真正的公平调度器：
 *
 *   1. Priority Aging     —— 等待越久有效优先级越高（有界提升），
 *                            后台任务不会被无限插队饿死。
 *   2. Lane Quota         —— 单车道连续运行 maxConsecutiveSlices 片后
 *                            强制让出，先检查其它车道再继续。
 *   3. Starvation Guard   —— 有待发任务的车道超过 starvationMs 没跑，
 *                            下一次选取直接营救（不让高车道无限插队）。
 * ================================================================ */

export const DEFAULT_LANE_QUOTAS = Object.freeze({
  // P6 BACKGROUND / P7 IDLE 连续 3 片强制让出；渲染车道 4 片；其余默认 8 片。
  3: 4,
  6: 3,
  7: 3,
});

export class LaneGovernor {
  /**
   * @param {object} options
   * @param {Record<number|string, number>} [options.quotas] 车道 → 连续片数上限
   * @param {number} [options.defaultQuota] 未配置车道的连续片数上限
   * @param {number} [options.agingMs] 每等待多久提升一级有效优先级
   * @param {number} [options.maxAgingSteps] 老化提升的级数上限
   * @param {number} [options.starvationMs] 车道饥饿认定阈值
   */
  constructor({ quotas = null, defaultQuota = 8, agingMs = 32, maxAgingSteps = 2, starvationMs = 96 } = {}) {
    this.quotas = { ...DEFAULT_LANE_QUOTAS, ...(quotas ?? null) };
    this.defaultQuota = Math.max(1, Math.floor(Number(defaultQuota) || 8));
    this.agingMs = Math.max(1, Number(agingMs) || 32);
    this.maxAgingSteps = Math.max(0, Math.floor(Number(maxAgingSteps) ?? 2));
    this.starvationMs = Math.max(1, Number(starvationMs) || 96);
    this.consecutive = new Map(); // lane → 连续运行片数
    this.lastRunAt = new Map();   // lane → 上次运行时间
    this.runs = new Map();        // lane → 累计运行任务数
    this.forcedYields = new Map();// lane → 配额强制让出次数
    this.agingBoosts = 0;         // 老化提升总次数
    this.rescues = 0;             // 饥饿营救次数
  }

  quotaOf(lane) {
    const configured = this.quotas[lane];
    return configured == null ? this.defaultQuota : Math.max(1, Math.floor(Number(configured) || this.defaultQuota));
  }

  /** 老化后的有效优先级：等待越久越靠前，但提升有界（不会越过 SYSTEM）。 */
  effectivePriority(task, now = Date.now()) {
    const base = task.priority;
    if (this.maxAgingSteps <= 0 || task.submitted == null) return base;
    const waited = Math.max(0, now - task.submitted);
    const boost = Math.min(this.maxAgingSteps, Math.floor(waited / this.agingMs));
    if (boost > 0) this.agingBoosts += 1;
    return Math.max(0, base - boost);
  }

  /** 车道配额：本车道是否还能立刻跑下一片。 */
  canRun(lane, pendingLanes) {
    const streak = this.consecutive.get(lane) ?? 0;
    if (streak < this.quotaOf(lane)) return true;
    // 只有当还有别的车道在等时才强制让出——否则白白空转一轮。
    for (const other of pendingLanes) {
      if (other !== lane) return false;
    }
    return true;
  }

  /** 饥饿营救：返回被饿得最久、且有待发任务的车道（没有则返回 null）。 */
  starvedLane(pendingLanes, now = Date.now()) {
    let victim = null;
    let oldest = Infinity;
    for (const lane of pendingLanes) {
      const last = this.lastRunAt.get(lane);
      if (last == null) continue; // 从未跑过的新车道由正常优先级裁决
      if (now - last >= this.starvationMs && last < oldest) {
        oldest = last;
        victim = lane;
      }
    }
    return victim;
  }

  noteRan(lane, now = Date.now()) {
    this.consecutive.set(lane, (this.consecutive.get(lane) ?? 0) + 1);
    this.lastRunAt.set(lane, now);
    this.runs.set(lane, (this.runs.get(lane) ?? 0) + 1);
  }

  /** 任务让出 / 完成且下一片换了车道时，重置原车道连击。 */
  noteSwitched(fromLane, toLane) {
    if (fromLane != null && fromLane !== toLane) this.consecutive.set(fromLane, 0);
  }

  noteForcedYield(lane) {
    this.forcedYields.set(lane, (this.forcedYields.get(lane) ?? 0) + 1);
    this.consecutive.set(lane, 0);
  }

  stats() {
    return Object.freeze({
      agingMs: this.agingMs,
      maxAgingSteps: this.maxAgingSteps,
      starvationMs: this.starvationMs,
      defaultQuota: this.defaultQuota,
      quotas: Object.freeze({ ...this.quotas }),
      agingBoosts: this.agingBoosts,
      rescues: this.rescues,
      runs: Object.freeze(Object.fromEntries(this.runs)),
      forcedYields: Object.freeze(Object.fromEntries(this.forcedYields)),
      consecutive: Object.freeze(Object.fromEntries(this.consecutive)),
    });
  }
}
