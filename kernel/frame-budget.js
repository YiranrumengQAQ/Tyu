/* ================================================================
 * JLC 0.6.1 — VM Frame Budget Manager（kernel/frame-budget.js）
 *
 * 0.6 只有「超过 deadline 就让出」的一刀切。0.6.1 把一帧的预算
 * 拆成动态车道份额：紧急车道（SYSTEM / INPUT / INTERACTION）先预留，
 * RENDER 用剩下的，EFFECT 再用剩下的，余量留给 NETWORK / BACKGROUND。
 * 份额是「上界」而不是硬切：前面的车道没活干，后面的车道自然可以用满。
 * ================================================================ */

/** 默认车道份额（ms）：对应 P0..P4；P5..P7 使用整帧余量。 */
export const DEFAULT_LANE_BUDGETS = Object.freeze({
  0: 0.5, // SYSTEM
  1: 1.0, // INPUT
  2: 1.0, // INTERACTION
  3: 3.0, // RENDER
  4: 1.0, // EFFECT
});

export class FrameBudgetManager {
  /**
   * @param {object} options
   * @param {number} [options.frameBudgetMs] 一帧总预算（0 = 关闭，与 0.6 行为一致）
   * @param {Record<number, number>} [options.laneBudgets] 各车道份额（可部分覆盖）
   */
  constructor({ frameBudgetMs = 0, laneBudgets = null } = {}) {
    this.frameBudgetMs = Math.max(0, Number(frameBudgetMs) || 0);
    this.laneBudgets = { ...DEFAULT_LANE_BUDGETS, ...(laneBudgets ?? null) };
    this.frames = 0;
    this.budgetedMs = 0;
  }

  get enabled() {
    return this.frameBudgetMs > 0;
  }

  /** 开启一帧：返回各车道的绝对截止时间（动态预算，不是硬切）。 */
  begin(now = Date.now()) {
    this.frames += 1;
    this.budgetedMs += this.frameBudgetMs;
    const deadlines = Object.create(null);
    let cumulative = 0;
    for (let lane = 0; lane <= 4; lane += 1) {
      cumulative += Math.max(0, Number(this.laneBudgets[lane] ?? 0));
      deadlines[lane] = now + Math.min(cumulative, this.frameBudgetMs);
    }
    // 低优先级车道不预留：整帧余量都是它们的上界。
    for (let lane = 5; lane <= 7; lane += 1) deadlines[lane] = now + this.frameBudgetMs;
    return Object.freeze({ serial: this.frames, start: now, budgetMs: this.frameBudgetMs, deadlines: Object.freeze(deadlines) });
  }

  /** 某车道在本帧内的截止时间（帧预算关闭时返回 0 = 无截止时间）。 */
  deadlineFor(frame, lane) {
    if (!this.enabled || !frame) return 0;
    return frame.deadlines[lane] ?? frame.start + this.frameBudgetMs;
  }

  stats() {
    return Object.freeze({
      enabled: this.enabled,
      frameBudgetMs: this.frameBudgetMs,
      frames: this.frames,
      budgetedMs: this.budgetedMs,
      laneBudgets: Object.freeze({ ...this.laneBudgets }),
    });
  }
}
