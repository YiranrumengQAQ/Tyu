/*
 * JLC OS 0.5 · Local API（jlc:// / local://）
 *
 * 应用侧看到的统一接口（0.4 内建 http() + resource 原样工作）：
 *
 *   GET    jlc://storage/<app>/<key>          读本机 IndexedDB（JSON）
 *   PUT    jlc://storage/<app>/<key>          写（body = JSON）
 *   DELETE jlc://storage/<app>/<key>          删
 *   GET    jlc://storage/<app>                列出 key
 *   DELETE jlc://storage/<app>                清空该应用命名空间
 *   GET    jlc://clipboard/read               读剪贴板 → { text }
 *   GET    jlc://files/result/<token>         读取 fileOpen() 选中的文件（信封 JSON）
 *   GET    jlc://files/recents                最近打开的文件元数据
 *   GET    jlc://meta/apps                    应用目录（含 @jlc-page 元数据）
 *   GET    jlc://meta/browser                 平台 / 设备 / 在线状态（需 browser 授权）
 *   GET    jlc://meta/version                 内核 / 宿主版本
 *   GET    jlc://meta/permissions             权限中心数据（仅系统应用）
 *   GET    jlc://meta/storage                 各应用数据量（仅系统应用）
 *   PUT    jlc://permissions/set/<app>/<cap>  body { mode }（仅系统应用）
 *   PUT    jlc://permissions/reset/<app>      （仅系统应用）
 *   PUT    jlc://permissions/reset-all        （仅系统应用）
 *   PUT    jlc://data/clear-app/<app>         （仅系统应用）
 *   PUT    jlc://data/clear-all               （仅系统应用）
 *
 * 规则：
 *   - 每个请求绑定发起应用（宿主为每个 mount 单独构建 fetch 闭包）。
 *   - storage / clipboard / files 路由先过权限中心（同步裁决），未授权 → 403 + 记入请求列表。
 *   - <app> 命名空间只允许访问自己，系统应用可跨应用管理。
 *   - 其余 URL 原样透传给真实 fetch（CORS 规则照常，宿主不代打任何代理）。
 *   - 尊重 VM 传入的 AbortSignal：中断以 AbortError 抛出（VM 的 resource 会忽略）。
 */

import { browserInfo } from "./browser.js";
import { readText as readClipboard } from "./clipboard.js";

export const LOCAL_SCHEMES = ["jlc://", "local://"];

export function isLocalUrl(url) {
  return LOCAL_SCHEMES.some((scheme) => String(url).startsWith(scheme));
}

/** 与异步工作赛跑：abort 时以 AbortError 落败。 */
function abortable(signal) {
  return new Promise((resolve, reject) => {
    if (!signal) {
      resolve(null);
      return;
    }
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

function rawJson(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json;charset=utf-8" },
  });
}

function denied(message) {
  return json({ error: message ?? "permission denied" }, 403);
}

function notFound(message) {
  return json({ error: message ?? "not found" }, 404);
}

export function createLocalApi(ctx) {
  const { store, permissions, files, catalog, ui, hostVersion, kernelVersion, themeState } = ctx;

  /** 权限裁决 + 请求记账；返回 null 表示放行。 */
  function gate(appName, domain, label) {
    if (permissions.check(appName, domain)) return null;
    permissions.noteRequest(appName, domain);
    ui?.permissionToast?.(appName, domain);
    return denied(`需要「${label}」权限（见权限中心）`);
  }

  async function readBody(options) {
    const body = options?.body;
    if (body == null || body === "") return null;
    try {
      return JSON.parse(String(body));
    } catch {
      throw Object.assign(new Error("body 不是合法 JSON"), { status: 400 });
    }
  }

  /**
   * 为某个应用构建 fetch 闭包。
   * @param {string} appName  发起请求的应用（目录里的 name）
   * @param {object} meta     该应用的 @jlc-page 元数据
   * @param {object} entry    目录条目（origin: system | shared）
   */
  function fetchFor(appName, meta, entry) {
    const isSystem = entry?.origin === "system";
    return async function localFetch(url, options = {}) {
      const target = String(url ?? "");
      if (!isLocalUrl(target)) {
        // 非本地 URL：透传真实网络（CORS 由浏览器裁决，宿主不代打代理）。
        return await fetch(target, options);
      }
      const path = target.replace(/^(?:jlc|local):\/\//u, "");
      const seg = path.split("/").filter(Boolean);
      const method = String(options?.method ?? "GET").toUpperCase();
      const signal = options?.signal ?? null;

      try {
        if (!seg.length) return notFound("空的本地路径");

        switch (seg[0]) {
          case "storage": {
            const block = gate(appName, "storage", "本地存储");
            if (block) return block;
            const app = seg[1];
            if (!app) return notFound("缺少应用名");
            if (app !== appName && !isSystem) return denied("只能访问自己的存储命名空间");
            if (seg.length === 2) {
              if (method === "GET") return json({ keys: await store.kvKeys(app) });
              if (method === "DELETE") return json({ ok: true, cleared: await store.kvClearApp(app) });
              return json({ error: "method not allowed" }, 405);
            }
            const key = seg.slice(2).join("/");
            if (method === "GET") {
              const value = await store.kvGet(app, key);
              return value == null ? notFound(`没有 ${app}/${key}`) : rawJson(value);
            }
            if (method === "PUT" || method === "POST") {
              const value = await readBody(options);
              await store.kvSet(app, key, value);
              return json({ ok: true });
            }
            if (method === "DELETE") {
              await store.kvDelete(app, key);
              return json({ ok: true });
            }
            return json({ error: "method not allowed" }, 405);
          }

          case "clipboard": {
            if (seg[1] !== "read" || method !== "GET") return notFound("只支持 GET jlc://clipboard/read");
            const block = gate(appName, "clipboard", "剪贴板");
            if (block) return block;
            try {
              const text = await Promise.race([readClipboard(), abortable(signal)]);
              return json({ text });
            } catch (error) {
              if (signal?.aborted) throw abortError();
              return json({ error: error?.message ?? "剪贴板读取失败" }, 501);
            }
          }

          case "files": {
            const block = gate(appName, "files", "文件");
            if (block) return block;
            if (seg[1] === "recents" && method === "GET") {
              await files.loadRecents();
              return json({ items: files.recents });
            }
            if (seg[1] === "result" && seg[2] != null && method === "GET") {
              const token = Number(seg[2]);
              if (!Number.isInteger(token) || !files.hasResult(token)) return notFound("文件选择未完成或已过期，请重新打开");
              const envelope = await Promise.race([files.result(token), abortable(signal)]);
              if (envelope == null) return notFound("文件选择未完成");
              return json(envelope);
            }
            return notFound("未知 files 路由");
          }

          case "meta": {
            switch (seg[1]) {
              case "apps": {
                if (method !== "GET") return json({ error: "method not allowed" }, 405);
                return json(await catalog.snapshot());
              }
              case "browser": {
                const block = gate(appName, "browser", "浏览器信息");
                if (block) return block;
                return json(browserInfo({ theme: themeState?.current?.(), effectiveTheme: themeState?.effective?.() }));
              }
              case "version": {
                return json({
                  kernel: kernelVersion,
                  host: hostVersion,
                  app: appName,
                  origin: entry?.origin === "system" ? "system" : "shared",
                  policy: entry?.origin === "system" ? "trusted" : meta?.policy ?? "open",
                });
              }
              case "permissions": {
                if (!isSystem) return denied("仅系统应用可访问权限中心数据");
                const table = permissions.grantedTable();
                return json({
                  apps: await catalog.permissionRows(table),
                  requested: permissions.requestedList(),
                });
              }
              case "storage": {
                if (!isSystem) return denied("仅系统应用可访问数据管理");
                return json({ items: await store.kvDigest() });
              }
              default:
                return notFound("未知 meta 路由");
            }
          }

          case "permissions": {
            if (!isSystem) return denied("仅系统应用可修改权限");
            if (seg[1] === "set" && seg[2] && seg[3] && (method === "PUT" || method === "POST")) {
              const body = await readBody(options);
              const mode = body?.mode;
              if (!["always", "session", "once", "deny", "none"].includes(mode)) {
                return json({ error: "mode 必须是 always / session / once / deny / none" }, 400);
              }
              await permissions.set(seg[2], seg[3], mode === "none" ? null : mode);
              return json({ ok: true });
            }
            if (seg[1] === "reset" && seg[2] && (method === "PUT" || method === "POST")) {
              await permissions.resetApp(seg[2]);
              return json({ ok: true });
            }
            if (seg[1] === "reset-all" && (method === "PUT" || method === "POST")) {
              await permissions.resetAll();
              return json({ ok: true });
            }
            return notFound("未知 permissions 路由");
          }

          case "data": {
            if (!isSystem) return denied("仅系统应用可清理数据");
            if (seg[1] === "clear-app" && seg[2] && (method === "PUT" || method === "POST")) {
              const cleared = await store.kvClearApp(seg[2]);
              return json({ ok: true, cleared });
            }
            if (seg[1] === "clear-all" && (method === "PUT" || method === "POST")) {
              const cleared = await store.kvClearAll();
              return json({ ok: true, cleared });
            }
            return notFound("未知 data 路由");
          }

          default:
            return notFound(`未知本地域「${seg[0]}」`);
        }
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw abortError();
        if (error?.status === 400) return json({ error: error.message }, 400);
        console.error("[0.5 host] 本地 API 异常：", error);
        return json({ error: error?.message ?? String(error) }, 500);
      }
    };
  }

  return { fetchFor, isLocalUrl };
}
