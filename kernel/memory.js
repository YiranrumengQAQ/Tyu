/* ================================================================
 * JLC 0.6.1 — Memory Accountant（kernel/memory.js）
 *
 * 0.6 里 memory 只是资源账本上的一个普通计数器。0.6.1 给它一本
 * 真正的分户账：state / checkpoint / task / cache / dom-metadata 各记各的，
 * 重点是 checkpoint 不能无限复制 state——delta 快照（结构共享）省下的
 * 字节数在这里可见。
 * ================================================================ */

/** 浅层估算一个 JLC 值的内存占用（字节），只走有限深度，开销有界。 */
export function estimateBytes(value, seen = new WeakSet(), depth = 0) {
  if (depth > 4) return 16;
  switch (typeof value) {
    case "string": return 16 + value.length * 2;
    case "number": return 8;
    case "boolean": return 4;
    case "undefined": return 0;
    case "object": {
      if (value === null) return 0;
      if (seen.has(value)) return 8;
      seen.add(value);
      if (Array.isArray(value)) {
        let total = 24;
        for (let index = 0; index < value.length && index < 256; index += 1) {
          total += estimateBytes(value[index], seen, depth + 1);
        }
        return total;
      }
      if (value instanceof Uint8Array) return value.byteLength + 16;
      let total = 32;
      let count = 0;
      for (const [key, child] of Object.entries(value)) {
        if (++count > 256) break;
        total += 16 + key.length * 2 + estimateBytes(child, seen, depth + 1);
      }
      return total;
    }
    default: return 8;
  }
}

export const MEMORY_ACCOUNTS = Object.freeze([
  "state", "checkpoints", "tasks", "cache", "dom", "streams", "workers",
]);

export class MemoryAccountant {
  /**
   * @param {object} options
   * @param {number} [options.limit] 字节上限（0 = 不限；超限只警告/记账，由资源内核裁决）
   */
  constructor({ limit = 0 } = {}) {
    this.limit = Math.max(0, Math.floor(Number(limit) || 0));
    this.accounts = new Map(MEMORY_ACCOUNTS.map((name) => [name, 0]));
    this.warnings = 0;
  }

  charge(account, bytes) {
    const name = this.accounts.has(account) ? account : "state";
    this.accounts.set(name, Math.max(0, (this.accounts.get(name) ?? 0) + Math.max(0, Math.round(bytes))));
    return this.total();
  }

  release(account, bytes) {
    return this.charge(account, -Math.abs(bytes));
  }

  setAccount(account, bytes) {
    const name = this.accounts.has(account) ? account : "state";
    this.accounts.set(name, Math.max(0, Math.round(bytes)));
    return this.total();
  }

  total() {
    let total = 0;
    for (const bytes of this.accounts.values()) total += bytes;
    return total;
  }

  /** 资源内核读的派生用量：KB 计。 */
  usageKB() {
    return Math.ceil(this.total() / 1024);
  }

  overLimit() {
    return this.limit > 0 && this.total() > this.limit;
  }

  usage() {
    return Object.freeze({
      totalBytes: this.total(),
      totalKB: Math.round((this.total() / 1024) * 10) / 10,
      limitBytes: this.limit,
      accounts: Object.freeze(Object.fromEntries(this.accounts)),
    });
  }
}
