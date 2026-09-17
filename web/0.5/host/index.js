/*
 * JLC OS 0.5 · 宿主入口（Browser Host）
 *
 * 分层：
 *   GitHub Pages（静态分发）
 *     └── 本文件：Shell（路由 / 生命周期 / 顶栏底栏）
 *           ├── Capability Hub（capabilities.js：同步宿主函数，过权限中心）
 *           ├── Local API（localapi.js：jlc:// → IndexedDB / 剪贴板 / 文件 / 元数据）
 *           ├── 权限中心（permissions.js：always / session / once / deny）
 *           └── PWA（sw.js 在仓库根，只由 0.5 注册）
 *   JLC 0.4 内核（jlc.js，一字未动）
 *
 * 绝对不动区：jlc-vm.js / jlc-compiler.js / jlc.js / SPEC.md / JBC.md / web/index.html / web/apps/*
 */

import { parsePageMeta } from "./meta.js";
import { createStore } from "./storage.js";
import { createPermissions } from "./permissions.js";
import { createFileHost } from "./files.js";
import { createLocalApi } from "./localapi.js";
import { createCapabilities, capabilityDomainsFor } from "./capabilities.js";
import { createUi } from "./ui.js";
import * as pwa from "./pwa.js";
import { toggle as fullscreenToggle } from "./fullscreen.js";

export const HOST_VERSION = "0.5.0";
const DEFAULT_APP = "home";

/* ---------------- 应用目录 ---------------- */

export class Catalog {
  constructor() {
    this.entries = [];
    this.metaCache = new Map(); // name|origin -> { source, meta, bytes }
    this.ready = null;
  }

  async load(catalogUrl) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const response = await fetch(catalogUrl, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`无法拉取应用目录 ${catalogUrl}（HTTP ${response.status}）`);
      const raw = await response.json();
      this.entries = (raw.apps ?? []).map((entry) => ({
        name: String(entry.name),
        origin: entry.origin ?? (entry.dir === "system" ? "system" : "shared"),
        icon: entry.icon ?? "▫",
        src: entry.dir === "system" || entry.origin === "system" ? `./apps/${entry.name}.jlc` : `../apps/${entry.name}.jlc`,
      }));
      return this;
    })();
    return this.ready;
  }

  /** 系统目录优先：同名时 0.5 应用覆盖 0.4 应用。 */
  resolve(name) {
    return this.entries.find((entry) => entry.name === name && entry.origin === "system")
      ?? this.entries.find((entry) => entry.name === name)
      ?? null;
  }

  async source(entry) {
    const cacheKey = entry.name + "|" + entry.origin;
    const hit = this.metaCache.get(cacheKey);
    if (hit) return hit;
    const response = await fetch(entry.src);
    if (!response.ok) throw new Error(`无法拉取应用 ${entry.name}（HTTP ${response.status}）`);
    const source = await response.text();
    const info = { source, meta: parsePageMeta(source, entry.name), bytes: new Blob([source]).size };
    this.metaCache.set(cacheKey, info);
    return info;
  }

  /** 首页 / 应用列表用：同名只出一次（系统目录优先），shadowed 标记被覆盖的 0.4 版。 */
  async snapshot() {
    const apps = [];
    for (const entry of this.entries) {
      if (apps.some((app) => app.name === entry.name)) continue;
      const info = await this.source(entry);
      apps.push({
        name: entry.name,
        title: info.meta.title,
        summary: info.meta.summary,
        icon: entry.icon,
        origin: entry.origin,
        policy: entry.origin === "system" ? "trusted" : info.meta.policy,
        isolation: info.meta.isolation,
        fault: info.meta.fault,
        capabilities: info.meta.capabilities,
        bytes: info.bytes,
        shadowed: this.entries.some((other) => other.name === entry.name && other !== entry),
      });
    }
    return { apps };
  }

  /** 权限中心用：每个应用 × 能力域 → 当前档位。 */
  async permissionRows(grantTable) {
    const { apps } = await this.snapshot();
    const grants = new Map();
    for (const row of grantTable) grants.set(`${row.app}|${row.domain}`, row.mode);
    return apps.map((app) => ({
      ...app,
      grants: Object.fromEntries(
        app.capabilities.map((domain) => [domain, grants.get(`${app.name}|${domain}`) ?? null]),
      ),
    }));
  }
}

/* ---------------- 宿主 ---------------- */

export function createHost({ kernel, viewport, kernelVersion, catalogUrl = "./apps.json", swUrl = "../../sw.js" }) {
  const store = createStore();
  const permissions = createPermissions(store);
  const ui = createUi({ permissions });
  const files = createFileHost(store);
  const catalog = new Catalog();

  const topbar = document.getElementById("os-topbar");
  const installBtn = document.getElementById("os-install");
  const fullscreenBtn = document.getElementById("os-fullscreen");

  let installer = null;
  let handle = null;
  let currentApp = null;
  let busy = false;

  const themeState = {
    current: () => pwa.currentTheme(),
    effective: () => pwa.effectiveTheme(),
    set: (mode) => pwa.setTheme(store, mode),
  };

  const router = {
    go(name) {
      const target = `#/${name}.jlc`;
      if (location.hash === target) return;
      location.hash = target;
    },
  };

  const capabilityHub = createCapabilities({ permissions, files, ui, pwa, installer, themeState, router, store });
  const localApi = createLocalApi({
    store, permissions, files, catalog, ui,
    hostVersion: HOST_VERSION,
    kernelVersion: kernelVersion ?? kernel.VERSION ?? "0.4.x",
    themeState,
  });

  /* ---------------- 路由 ---------------- */

  function parseAppName() {
    const raw = location.hash.replace(/^#\/?/, "").replace(/\.jlc$/u, "").split("/")[0];
    return raw || DEFAULT_APP;
  }

  async function onRoute() {
    if (busy) {
      // 授权弹层打开时不允许切走，装完后再补一次。
      if (parseAppName() !== currentApp) setTimeout(onRoute, 80);
      return;
    }
    const name = parseAppName();
    if (name === currentApp) return;
    busy = true;
    try {
      await launch(name);
    } catch (error) {
      console.error(error);
      ui.fatal("应用装载失败", error?.stack || error?.message || error, [
        { label: "返回首页", onClick: () => router.go(DEFAULT_APP) },
      ]);
    } finally {
      busy = false;
    }
    // 装载期间用户又点了别处。
    if (parseAppName() !== currentApp) onRoute();
  }

  /** VM 的 navigate() 走 history.pushState，不触发 hashchange —— 宿主代补一路由钩子。 */
  function installRouter() {
    let timer = null;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onRoute, 30);
    };
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method]?.bind(history);
      if (!original) continue;
      history[method] = (...args) => {
        const result = original(...args);
        queueMicrotask(fire);
        return result;
      };
    }
    window.addEventListener("hashchange", fire);
    window.addEventListener("popstate", fire);
  }

  /* ---------------- 应用生命周期 ---------------- */

  /** 从 IndexedDB 水合应用声明过的 state（@jlc-page 的 storage: 行）。 */
  async function hydrateState(appName, meta) {
    const keys = meta?.storage ?? [];
    if (!keys.length) return undefined;
    const state = Object.create(null);
    for (const key of keys) {
      const value = await store.kvGet(appName, key);
      if (value != null) state[key] = value;
    }
    return Object.keys(state).length ? state : undefined;
  }

  async function launch(name) {
    const entry = catalog.resolve(name);
    if (!entry) {
      ui.fatal("未知应用", `目录里没有「${name}」应用（#/${name}.jlc）`, [
        { label: "返回首页", onClick: () => router.go(DEFAULT_APP) },
      ]);
      return;
    }
    if (handle?.active) handle.unmount();
    currentApp = name;
    ui.clearFatal();
    ui.showLoading(entry.icon, "正在装载…");
    ui.setNavActive(name);

    const { source, meta, bytes } = await catalog.source(entry);

    // 系统应用 = 受信第一方：声明的能力域自动「始终允许」。
    if (entry.origin === "system") {
      for (const domain of capabilityDomainsFor(entry, meta)) {
        if (permissions.modeOf(name, domain) == null) await permissions.set(name, domain, "always");
      }
    }

    // 从未裁决过的能力域 → 首次授权弹层（系统应用在上面已放行，不弹层）。
    if (entry.origin !== "system") {
      const toAsk = capabilityDomainsFor(entry, meta).filter((domain) => permissions.modeOf(name, domain) == null);
      if (toAsk.length) {
        const decision = await ui.permissionSheet(name, meta, toAsk);
        if (decision.choice === "session" || decision.choice === "always") {
          for (const domain of decision.domains) await permissions.set(name, domain, decision.choice);
          for (const domain of toAsk) {
            if (!decision.domains.includes(domain)) await permissions.set(name, domain, "deny");
          }
        } else if (decision.choice === "deny") {
          for (const domain of toAsk) await permissions.set(name, domain, "deny");
        }
        // choice === "later"：保持未裁决，运行中被拦时再弹可操作提示条。
      }
    }

    const state = await hydrateState(name, meta);
    const capabilities = capabilityHub.build(name, meta, entry);
    const fetchImpl = localApi.fetchFor(name, meta, entry);

    handle = kernel.mount(source, viewport, {
      state,
      policy: entry.origin === "system" ? "trusted" : (meta.policy || "open"),
      isolation: meta.isolation || "strict",
      fault: "degrade",
      autoDispose: true,
      capabilities,
      fetch: fetchImpl,
      id: `app-${name}`,
      onFault: (info) => console.warn("[0.5 host] 策略裁决", info),
      onError: (error) => {
        console.error("[0.5 host] 应用运行期异常", error);
        ui.toast(`应用异常：${error?.message ?? error}`, { tone: "error", sticky: true });
      },
    });

    const originNote = entry.origin === "system" ? "系统应用" : "0.4 应用";
    ui.setAppTitle(meta.title, `${originNote} · ${meta.policy} 档 · ${bytes} B`);
  }

  /* ---------------- 启动 ---------------- */

  async function start() {
    installRouter();
    window.addEventListener("online", () => ui.setOnline(true));
    window.addEventListener("offline", () => ui.setOnline(false));
    ui.setOnline(navigator.onLine !== false);

    await store.open();
    await permissions.hydrate();
    pwa.applyTheme();
    pwa.watchSystemTheme();

    try {
      await catalog.load(catalogUrl);
    } catch (error) {
      console.error(error);
      ui.fatal("应用目录加载失败", error?.message ?? error, [
        { label: "重试", onClick: () => window.location.reload() },
      ]);
      return;
    }

    installer = pwa.onInstallPrompt((available) => {
      ui.setInstallAvailable(available);
      if (available) {
        ui.toast("JLC OS 可以安装到主屏幕", {
          actions: [{ label: "安装", onClick: () => void installer.promptInstall() }],
        });
      }
    });
    installBtn?.addEventListener("click", () => {
      void installer.promptInstall().then((accepted) => {
        ui.toast(accepted ? "已安装 JLC OS 🎉" : "安装取消");
      });
    });
    fullscreenBtn?.addEventListener("click", () => {
      const next = fullscreenToggle();
      ui.toast(next ? "已进入全屏" : "已退出全屏");
    });
    topbar?.addEventListener("click", (event) => {
      const brand = event.target.closest?.(".os-brand");
      if (brand) router.go(DEFAULT_APP);
    });

    const swOutcome = await pwa.registerServiceWorker(swUrl, ui);
    ui.setSwReady(swOutcome === "ready");

    onRoute();
  }

  return { start };
}
