/*
 * JLC OS 0.5 · 权限中心（Capability Gateway）
 *
 * 四种授予档位：
 *   always  始终允许（持久化到 IndexedDB）
 *   session 本次会话允许（仅内存，刷新即失效）
 *   once    允许一次（放行当前调用后立即回收）
 *   deny    拒绝（持久化）
 *   ——未授权（无记录）：调用被拦截并进入「请求列表」，权限中心可处理。
 *
 * check() 必须是同步的——capability 是 VM 里的同步函数，不能返回 Promise。
 * 宿主在启动时把磁盘里的 always/deny 读进内存镜像，之后只读镜像。
 */

export class PermissionCenter {
  constructor(store) {
    this.store = store;
    this.grants = new Map(); // "app|domain" -> mode
    this.requested = new Set(); // 运行期被拦截过的 app|domain（未持久）
    this.ready = null;
  }

  key(app, domain) {
    return `${app}|${domain}`;
  }

  async hydrate() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const rows = await this.store.grantsAll();
      for (const row of rows) {
        if (row.mode === "always" || row.mode === "deny") this.grants.set(this.key(row.app, row.domain), row.mode);
      }
      return this;
    })();
    return this.ready;
  }

  /** 同步裁决。once 档放行一次后自动回收。 */
  check(app, domain) {
    const mode = this.grants.get(this.key(app, domain));
    if (mode === "always" || mode === "session") return true;
    if (mode === "once") {
      this.grants.delete(this.key(app, domain));
      return true;
    }
    return false;
  }

  modeOf(app, domain) {
    return this.grants.get(this.key(app, domain)) ?? null;
  }

  async set(app, domain, mode) {
    const k = this.key(app, domain);
    if (mode === null || mode === undefined) {
      this.grants.delete(k);
      this.requested.delete(k);
      await this.store.grantPut(app, domain, null);
    } else {
      // once 也进内存：check() 放行一次后自动回收。
      this.grants.set(k, mode);
      this.requested.delete(k);
      // 只有 always / deny 落盘；session / once 只活在这一页。
      await this.store.grantPut(app, domain, mode === "always" || mode === "deny" ? mode : null);
    }
    return this.grantedTable();
  }

  /** 记录一次运行期拦截（供权限中心的「请求列表」）。 */
  noteRequest(app, domain) {
    this.requested.add(this.key(app, domain));
  }

  requestedList() {
    return [...this.requested].map((k) => {
      const [app, domain] = k.split("|");
      return { app, domain };
    });
  }

  clearRequest(app, domain) {
    this.requested.delete(this.key(app, domain));
  }

  /** 全量授予表：[{ app, domain, mode }]。 */
  grantedTable() {
    return [...this.grants.entries()]
      .map(([k, mode]) => {
        const [app, domain] = k.split("|");
        return { app, domain, mode };
      })
      .sort((a, b) => (a.app + a.domain < b.app + b.domain ? -1 : 1));
  }

  async resetApp(app) {
    for (const [k, ] of [...this.grants.entries()]) {
      if (k.startsWith(`${app}|`)) this.grants.delete(k);
    }
    for (const k of [...this.requested]) if (k.startsWith(`${app}|`)) this.requested.delete(k);
    // 磁盘上属于该应用的记录
    const rows = await this.store.grantsAll();
    for (const row of rows) {
      if (row.app === app) await this.store.grantPut(row.app, row.domain, null);
    }
    return this.grantedTable();
  }

  async resetAll() {
    this.grants.clear();
    this.requested.clear();
    await this.store.grantClearAll();
    return this.grantedTable();
  }
}

export function createPermissions(store) {
  return new PermissionCenter(store);
}
