/* ================================================================
 * JLC 0.6.1 — Cancellation Kernel（kernel/cancellation.js）
 *
 * app.cancel(taskId) / 组件销毁 → 级联取消：
 *   cancel 所有 task → abort requests → 释放 timers / listeners / scopes。
 * 杜绝「组件没了，后台任务还在跑、继续改 state」这类大型项目顽疾。
 * ================================================================ */

let NEXT_TOKEN_ID = 1;

export class CancellationRegistry {
  constructor() {
    this.tokens = new Map();
    this.cancelCount = 0;
  }

  /** 注册一个可取消单元；返回 token。 */
  register({ label = "task", scope = null } = {}) {
    const token = {
      id: NEXT_TOKEN_ID++,
      label,
      scope,
      canceled: false,
      reason: null,
      callbacks: new Set(),
      cancel(reason = "canceled") {
        if (this.canceled) return false;
        this.canceled = true;
        this.reason = reason;
        for (const callback of [...this.callbacks]) {
          try {
            callback(reason);
          } catch {
            // 取消回调异常不阻塞其余回调
          }
        }
        this.callbacks.clear();
        return true;
      },
      onCancel(callback) {
        if (this.canceled) callback(this.reason);
        else this.callbacks.add(callback);
      },
    };
    this.tokens.set(token.id, token);
    return token;
  }

  settle(token) {
    if (token) this.tokens.delete(token.id);
  }

  /** 按 id / label / 谓词取消。返回实际取消的数量。 */
  cancel(query, reason = "host cancel") {
    let count = 0;
    const match = typeof query === "number"
      ? (token) => token.id === query
      : typeof query === "string"
        ? (token) => token.label === query || String(token.id) === query
        : typeof query === "function"
          ? query
          : () => false;
    for (const token of [...this.tokens.values()]) {
      if (token.canceled) continue;
      if (match(token)) {
        token.cancel(reason);
        this.tokens.delete(token.id);
        count += 1;
      }
    }
    this.cancelCount += count;
    return count;
  }

  /** scope 销毁 → 取消它名下的全部任务（组件没了，后台不许再动）。 */
  cancelScope(scope, reason = "scope disposed") {
    if (!scope) return 0;
    return this.cancel((token) => token.scope === scope, reason);
  }

  alive() {
    return Object.freeze([...this.tokens.values()]
      .filter((token) => !token.canceled)
      .map((token) => Object.freeze({ id: token.id, label: token.label })));
  }

  stats() {
    return Object.freeze({ alive: this.tokens.size, canceled: this.cancelCount });
  }

  clear() {
    for (const token of [...this.tokens.values()]) token.cancel("runtime destroyed");
    this.tokens.clear();
  }
}
