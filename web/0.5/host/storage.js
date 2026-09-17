/*
 * JLC OS 0.5 · 本地持久化（IndexedDB）
 *
 * 数据库 jlc-os-0.5：
 *   kv       应用数据      id = "<app>/<key>"      value = 任意 JSON
 *   grants   权限授予      id = "<app>/<domain>"   value = { app, domain, mode }
 *   keyvalue 宿主单例      id = "recents" | "settings" …
 *
 * IndexedDB 不可用（隐私模式等）时自动降级为内存 Map：功能不丢，只是刷新不持久。
 * 所有方法返回 Promise；写入是「写穿」：先改内存镜像，再落盘。
 */

const DB_NAME = "jlc-os-0.5";
const DB_VERSION = 1;
const STORES = ["kv", "grants", "keyvalue"];

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 操作失败"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务中止"));
  });
}

/** 内存镜像（IndexedDB 降级时也是唯一存储）。 */
class MemoryDB {
  constructor() {
    this.kv = new Map();
    this.grants = new Map();
    this.keyvalue = new Map();
  }
}

export class LocalStore {
  constructor() {
    this.db = null;
    this.mem = new MemoryDB();
    this.fallback = false;
    this.ready = null;
  }

  async open() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      try {
        if (typeof indexedDB === "undefined" || !indexedDB) throw new Error("no indexedDB");
        this.db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(DB_NAME, DB_VERSION);
          req.onupgradeneeded = () => {
            const d = req.result;
            for (const name of STORES) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: "id" });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error("indexedDB blocked"));
        });
        await this.hydrateFromDisk();
      } catch (error) {
        console.warn("[0.5 host] IndexedDB 不可用，降级为内存存储：", error?.message ?? error);
        this.db = null;
        this.fallback = true;
      }
      return this;
    })();
    return this.ready;
  }

  store(name, mode) {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async hydrateFromDisk() {
    const [kv, grants, keyvalue] = await Promise.all([
      requestToPromise(this.store("kv", "readonly").getAll()),
      requestToPromise(this.store("grants", "readonly").getAll()),
      requestToPromise(this.store("keyvalue", "readonly").getAll()),
    ]);
    for (const row of kv) this.mem.kv.set(row.id, row);
    for (const row of grants) this.mem.grants.set(row.id, row);
    for (const row of keyvalue) this.mem.keyvalue.set(row.id, row);
  }

  /* ---------------- 应用数据（jlc://storage/<app>/<key>） ---------------- */

  kvId(app, key) {
    return `${app}/${String(key)}`;
  }

  async kvGet(app, key) {
    await this.open();
    const row = this.mem.kv.get(this.kvId(app, key));
    return row ? row.value : null;
  }

  async kvSet(app, key, value) {
    await this.open();
    const id = this.kvId(app, key);
    this.mem.kv.set(id, { id, value });
    if (this.db) await txDone(this.store("kv", "readwrite").put({ id, value }).transaction);
    return true;
  }

  async kvDelete(app, key) {
    await this.open();
    const id = this.kvId(app, key);
    this.mem.kv.delete(id);
    if (this.db) await txDone(this.store("kv", "readwrite").delete(id).transaction);
    return true;
  }

  async kvKeys(app) {
    await this.open();
    const prefix = `${app}/`;
    const keys = [];
    for (const id of this.mem.kv.keys()) if (id.startsWith(prefix)) keys.push(id.slice(prefix.length));
    return keys.sort();
  }

  async kvClearApp(app) {
    await this.open();
    const prefix = `${app}/`;
    const ids = [...this.mem.kv.keys()].filter((id) => id.startsWith(prefix));
    for (const id of ids) this.mem.kv.delete(id);
    if (this.db) {
      const store = this.store("kv", "readwrite");
      for (const id of ids) store.delete(id);
      await txDone(store.transaction);
    }
    return ids.length;
  }

  /** 全部应用数据摘要：[{ app, keys, bytes }]（权限中心 / 设置页用）。 */
  async kvDigest() {
    await this.open();
    const byApp = new Map();
    for (const [id, row] of this.mem.kv) {
      const slash = id.indexOf("/");
      const app = id.slice(0, slash);
      const key = id.slice(slash + 1);
      const entry = byApp.get(app) ?? { app, keys: [], bytes: 0 };
      entry.keys.push(key);
      entry.bytes += safeJsonSize(row.value);
      byApp.set(app, entry);
    }
    return [...byApp.values()].sort((a, b) => (a.app < b.app ? -1 : 1));
  }

  async kvClearAll() {
    await this.open();
    const count = this.mem.kv.size;
    this.mem.kv.clear();
    if (this.db) {
      const store = this.store("kv", "readwrite");
      for (const id of [...this.mem.kv.keys()]) store.delete(id);
      store.clear();
      await txDone(store.transaction);
    }
    return count;
  }

  /* ---------------- 权限授予（只持久 always / deny） ---------------- */

  grantId(app, domain) {
    return `${app}/${domain}`;
  }

  async grantsAll() {
    await this.open();
    const out = [];
    for (const [id, row] of this.mem.grants) out.push({ id, ...row });
    return out;
  }

  async grantPut(app, domain, mode) {
    await this.open();
    const id = this.grantId(app, domain);
    if (mode === null || mode === undefined) {
      this.mem.grants.delete(id);
      if (this.db) await txDone(this.store("grants", "readwrite").delete(id).transaction);
    } else {
      this.mem.grants.set(id, { id, app, domain, mode });
      if (this.db) await txDone(this.store("grants", "readwrite").put({ id, app, domain, mode }).transaction);
    }
    return true;
  }

  async grantClearAll() {
    await this.open();
    const ids = [...this.mem.grants.keys()];
    this.mem.grants.clear();
    if (this.db) {
      const store = this.store("grants", "readwrite");
      for (const id of ids) store.delete(id);
      await txDone(store.transaction);
    }
    return ids.length;
  }

  /* ---------------- 宿主单例 ---------------- */

  async singletonGet(id, fallback = null) {
    await this.open();
    const row = this.mem.keyvalue.get(id);
    return row ? row.value : fallback;
  }

  async singletonSet(id, value) {
    await this.open();
    this.mem.keyvalue.set(id, { id, value });
    if (this.db) await txDone(this.store("keyvalue", "readwrite").put({ id, value }).transaction);
    return true;
  }
}

function safeJsonSize(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function createStore() {
  return new LocalStore();
}
