/* ================================================================
 * JLC 0.6.1 — Keyed Node Cache（kernel/node-cache.js）
 *
 * runtime.nodeCache：EACH Diff Engine 2 的复用账本。
 * key 再次出现时直接复用（scope / DOM / binding / 组件状态都在），
 * 而不是重新 create scope → create DOM → create effect。
 *
 *   10000 items，修改 1 item → 只有 1 item 走写路径，其余 9999 命中复用。
 *
 * 这里记的是「复用决策」的账（hit / miss / live 条目索引）；
 * 记录的权威生命周期仍归 EACH 自己的 records 表，缓存只做观察与上限保护。
 * ================================================================ */

export class KeyedNodeCache {
  constructor({ maxSize = 4096 } = {}) {
    this.maxSize = Math.max(1, Math.floor(Number(maxSize) || 4096));
    this.entries = new Map(); // `${owner}\u0000${key}` → { owner, key, at }
    this.order = [];          // 插入序（LRU 淘汰用）
    this.hits = 0;
    this.misses = 0;
    this.reuses = 0;
  }

  entryKey(owner, key) {
    return `${owner}\u0000${String(key)}`;
  }

  /** key 再次出现且记录还活着 → 命中复用。 */
  hit(owner, key) {
    this.hits += 1;
    this.reuses += 1;
    return this.entries.get(this.entryKey(owner, key)) ?? null;
  }

  /** key 第一次出现（或记录已销毁）→ 需要新建，并登记进缓存。 */
  miss(owner, key) {
    this.misses += 1;
    const entryKey = this.entryKey(owner, key);
    const entry = { owner, key: String(key), at: Date.now() };
    if (!this.entries.has(entryKey)) this.order.push(entryKey);
    this.entries.set(entryKey, entry);
    if (this.entries.size > this.maxSize) {
      const oldest = this.order.shift();
      if (oldest != null) this.entries.delete(oldest);
    }
    return entry;
  }

  release(owner, key) {
    const entryKey = this.entryKey(owner, key);
    if (this.entries.delete(entryKey)) {
      const index = this.order.indexOf(entryKey);
      if (index >= 0) this.order.splice(index, 1);
    }
  }

  /** 组件销毁：整块释放该 owner 的缓存条目。 */
  releaseOwner(owner) {
    const prefix = `${owner}\u0000`;
    for (const entryKey of [...this.entries.keys()]) {
      if (entryKey.startsWith(prefix)) {
        this.entries.delete(entryKey);
        const index = this.order.indexOf(entryKey);
        if (index >= 0) this.order.splice(index, 1);
      }
    }
  }

  size() {
    return this.entries.size;
  }

  stats() {
    const total = this.hits + this.misses;
    return Object.freeze({
      size: this.entries.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    });
  }

  clear() {
    this.entries.clear();
    this.order.length = 0;
  }
}
