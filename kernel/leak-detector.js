/* ================================================================
 * JLC 0.6.1 — Leak Detector（kernel/leak-detector.js）
 *
 * 每个 app 记录 scope / listener / timer / effect / request / task / node
 * 的时序样本。如果连续 N 个样本单调增长、而期间用户没有创建新组件
 * （activity 没动），就标记 POSSIBLE_LEAK，Profile 直接显示
 * 「⚠ scope leak suspected」。
 * ================================================================ */

export const LEAK_KINDS = Object.freeze(["scopes", "effects", "listeners", "timers", "requests", "tasks", "nodes"]);

export class LeakDetector {
  /**
   * @param {object} options
   * @param {number} [options.intervalMs]  自动采样周期（0 = 只手动采样）
   * @param {number} [options.windowSize]  判定窗口内的样本数
   * @param {number} [options.threshold]   窗口内增长多少算可疑
   * @param {Function} [options.onWarn]    发现可疑泄漏时的回调
   */
  constructor({ intervalMs = 10_000, windowSize = 4, threshold = 64, onWarn = null } = {}) {
    this.intervalMs = Math.max(0, Math.floor(Number(intervalMs) || 0));
    this.windowSize = Math.max(2, Math.floor(Number(windowSize) || 4));
    this.threshold = Math.max(1, Math.floor(Number(threshold) || 64));
    this.onWarn = typeof onWarn === "function" ? onWarn : null;
    this.samples = [];
    this.suspected = new Set();
    this.timerHandle = null;
    this.notified = new Set();
  }

  /** 采样一次。snapshot: { scopes, effects, ..., activity }（activity 单调递增）。 */
  sample(snapshot, now = Date.now()) {
    const entry = { at: now, activity: Number(snapshot?.activity ?? 0) };
    for (const kind of LEAK_KINDS) entry[kind] = Math.max(0, Math.floor(Number(snapshot?.[kind] ?? 0)));
    this.samples.push(entry);
    if (this.samples.length > this.windowSize * 2) this.samples.shift();
    this.evaluate();
    return entry;
  }

  evaluate() {
    const window = this.samples.slice(-this.windowSize);
    if (window.length < this.windowSize) return this.report();
    const first = window[0];
    const last = window[window.length - 1];
    const idle = last.activity === first.activity; // 窗口内没有用户侧创建动作
    const fresh = [];
    for (const kind of LEAK_KINDS) {
      let monotonic = true;
      for (let index = 1; index < window.length; index += 1) {
        if (window[index][kind] < window[index - 1][kind]) { monotonic = false; break; }
      }
      const growth = last[kind] - first[kind];
      if (monotonic && growth >= this.threshold) {
        if (idle) {
          // 无用户活动的单调增长 → 可疑泄漏
          if (!this.suspected.has(kind)) fresh.push(kind);
          this.suspected.add(kind);
        } else {
          // 用户正在创建组件：增长有出处，洗清嫌疑
          this.suspected.delete(kind);
          this.notified.delete(kind);
        }
      } else {
        this.suspected.delete(kind);
        this.notified.delete(kind);
      }
    }
    for (const kind of fresh) {
      if (this.notified.has(kind)) continue;
      this.notified.add(kind);
      try {
        this.onWarn?.({
          code: "POSSIBLE_LEAK",
          kind,
          growth: last[kind] - first[kind],
          from: first[kind],
          to: last[kind],
          windowMs: last.at - first.at,
        });
      } catch {
        // 诊断回调异常不影响内核
      }
    }
    return this.report();
  }

  /** 用宿主定时器自动采样；返回停止函数。 */
  start(readSnapshot, host = globalThis) {
    if (this.timerHandle != null || this.intervalMs <= 0) return () => {};
    const setIntervalFn = host?.setInterval ?? globalThis.setInterval;
    this.timerHandle = setIntervalFn(() => {
      try {
        this.sample(readSnapshot());
      } catch {
        // 采样失败不致命
      }
    }, this.intervalMs);
    this.timerHandle.unref?.();
    return () => this.stop();
  }

  stop() {
    if (this.timerHandle != null) {
      const clearIntervalFn = globalThis.clearInterval;
      clearIntervalFn?.(this.timerHandle);
      this.timerHandle = null;
    }
  }

  report() {
    const window = this.samples.slice(-this.windowSize);
    return Object.freeze({
      suspected: Object.freeze([...this.suspected]),
      samples: Object.freeze(window.map((entry) => Object.freeze({ ...entry }))),
      windowSize: this.windowSize,
      threshold: this.threshold,
    });
  }
}
