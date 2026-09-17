/* ================================================================
 * JLC 0.6.1 — DOM Transaction Kernel（kernel/dom-transaction.js）
 *
 * 大型项目真正慢的地方：
 *   state change → effect → DOM write → layout → DOM write → layout → …
 * 0.6.1 把所有「属性面」DOM 写操作（text / attribute / class / style /
 * property）先收进 Mutation Buffer，批内做 Mutation Coalescing：
 *
 *   A.text = "1"; A.text = "2"; A.text = "3";   →  只执行 A.text = "3"
 *   class add → remove → add                    →  只执行一次 add
 *
 * 然后在统一提交点（perform / flush 结束）一次落盘。
 * 结构性操作（insert / move / remove）保持即时——它们互相依赖兄弟链，
 * 缓冲会破坏锚点语义；事务内核只给它们记账（create / remove / move）。
 * ================================================================ */

const NODE_IDS = new WeakMap();
let NEXT_NODE_ID = 1;

function nodeId(node) {
  let id = NODE_IDS.get(node);
  if (id == null) {
    id = NEXT_NODE_ID++;
    NODE_IDS.set(node, id);
  }
  return id;
}

export class DomTransaction {
  constructor({ enabled = true } = {}) {
    this.enabled = Boolean(enabled);
    this.pending = [];          // 有序的待提交写操作
    this.index = new Map();     // coalescing key → pending 下标
    this.styleKeys = new Map(); // node id → 该节点上挂起的 style 键集合
    this.stats = {
      queued: 0,
      coalesced: 0,   // 被合并消掉的写操作数
      applied: 0,     // 真正落到 DOM 的写操作数
      commits: 0,
      creates: 0,
      updates: 0,
      removes: 0,
      moves: 0,
    };
  }

  queue(key, apply) {
    const existing = this.index.get(key);
    if (existing != null) {
      // Mutation Coalescing：同键后写覆盖前写，只保留最后一次。
      this.pending[existing] = { key, apply };
      this.stats.coalesced += 1;
      return;
    }
    this.index.set(key, this.pending.length);
    this.pending.push({ key, apply });
    this.stats.queued += 1;
  }

  setText(node, value) {
    this.queue(`text:${nodeId(node)}`, () => { node.data = value; });
  }

  setAttribute(element, name, value) {
    this.queue(`attr:${nodeId(element)}:${name}`, () => {
      if (value === true) element.setAttribute(name, "");
      else element.setAttribute(name, String(value));
    });
  }

  removeAttribute(element, name) {
    this.queue(`attr:${nodeId(element)}:${name}`, () => element.removeAttribute(name));
  }

  setProperty(element, property, value) {
    this.queue(`prop:${nodeId(element)}:${property}`, () => { element[property] = value; });
  }

  /** class toggle(name, force)：force 是确定布尔值，最后一次即净结果。 */
  toggleClass(element, name, force) {
    this.queue(`class:${nodeId(element)}:${name}`, () => element.classList.toggle(name, Boolean(force)));
  }

  setStyleProperty(element, property, value) {
    const id = nodeId(element);
    let keys = this.styleKeys.get(id);
    if (!keys) this.styleKeys.set(id, keys = new Set());
    keys.add(property);
    this.queue(`style:${id}:${property}`, () => element.style.setProperty(property, String(value)));
  }

  removeStyleProperty(element, property) {
    const id = nodeId(element);
    let keys = this.styleKeys.get(id);
    if (!keys) this.styleKeys.set(id, keys = new Set());
    keys.add(property);
    this.queue(`style:${id}:${property}`, () => element.style.removeProperty(property));
  }

  /** cssText 覆盖全量样式：先把该节点挂起的逐属性 style 写清掉。 */
  setCssText(element, text) {
    const id = nodeId(element);
    const keys = this.styleKeys.get(id);
    if (keys?.size) {
      for (const property of keys) {
        const slot = this.index.get(`style:${id}:${property}`);
        if (slot != null) {
          this.pending[slot] = null;
          this.index.delete(`style:${id}:${property}`);
          this.stats.coalesced += 1;
        }
      }
      keys.clear();
    }
    this.queue(`style:${id}:__cssText__`, () => { element.style.cssText = text; });
  }

  /* ---- 结构面：即时落盘 + 记账（事务不缓冲兄弟链依赖的操作） ---- */

  noteCreate(count = 1) {
    this.stats.creates += count;
  }

  noteRemove(count = 1) {
    this.stats.removes += count;
  }

  noteMove(count = 1) {
    this.stats.moves += count;
  }

  get hasPending() {
    return this.pending.length > 0;
  }

  /** 统一提交：按入队顺序一次性落盘，然后清空缓冲。 */
  commit() {
    if (!this.pending.length) return 0;
    const batch = this.pending;
    this.pending = [];
    this.index.clear();
    let applied = 0;
    for (const op of batch) {
      if (!op) continue;
      op.apply();
      applied += 1;
    }
    this.stats.applied += applied;
    this.stats.updates += applied;
    this.stats.commits += 1;
    return applied;
  }

  /** 卸载：丢弃未提交写操作（DOM 马上随 scope 一起被拆掉）。 */
  discard() {
    this.pending.length = 0;
    this.index.clear();
    this.styleKeys.clear();
  }

  statsView() {
    return Object.freeze({ ...this.stats, pending: this.pending.length });
  }
}
