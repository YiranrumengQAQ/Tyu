/*
 * JLC OS 0.5 · Capability Hub（宿主能力工厂）
 *
 * VM 约定：mount({ capabilities }) 注入的是「同步函数」——不能返回 Promise。
 * 所以这里的能力分两类：
 *   同步结果类  download / platform / fullscreen / clipboardWrite（fire-and-forget 返回成功与否）
 *   异步数据类  不走 capability，走 jlc:// Local API（resource + http() 原生通道）。
 *
 * 每个函数先过权限中心（同步裁决）；被拦截时返回安全值并弹出「请求权限」提示条。
 * `system` 域只对系统应用注入。
 */

import { writeText } from "./clipboard.js";
import { share as shareImpl, shareSupported } from "./share.js";
import { notify as notifyImpl, notifySupported } from "./notify.js";
import { toggle as fsToggle, supported as fsSupported, active as fsActive } from "./fullscreen.js";
import { detectPlatformLabel } from "./browser.js";

export const SYSTEM_DOMAIN = "system";

export function capabilityDomainsFor(entry, meta) {
  const declared = [...(meta?.capabilities ?? [])];
  if (entry?.origin === "system") {
    if (!declared.includes(SYSTEM_DOMAIN)) declared.push(SYSTEM_DOMAIN);
  }
  return declared;
}

export function createCapabilities(ctx) {
  const { permissions, files, ui, pwa, installer, themeState, store } = ctx;

  /** 权限守卫：未授权 → 提示 + 记账，返回 false。 */
  function guard(appName, domain, label) {
    if (permissions.check(appName, domain)) return true;
    permissions.noteRequest(appName, domain);
    ui?.permissionToast?.(appName, domain);
    return false;
  }

  /** 只读查询用：只裁决，不弹提示、不记账（避免 derive 重跑时提示条刷屏）。 */
  function guardQuiet(appName, domain) {
    return permissions.check(appName, domain);
  }

  /**
   * @returns {Object<string, Function>} 注入给某个应用的 capability 表
   */
  function build(appName, meta, entry) {
    const declared = new Set(capabilityDomainsFor(entry, meta));
    const caps = Object.create(null);

    const add = (name, fn) => {
      caps[name] = fn;
    };

    if (declared.has("storage")) {
      add("storagePut", (key, value) => {
        if (!guard(appName, "storage", "本地存储")) return false;
        store.kvSet(appName, String(key ?? ""), value).catch((error) => {
          console.warn("[0.5 host] storagePut 失败：", error?.message ?? error);
        });
        return true;
      });
      add("storageClear", () => {
        if (!guard(appName, "storage", "本地存储")) return false;
        store.kvClearApp(appName).catch(() => {});
        return true;
      });
    }

    if (declared.has("clipboard")) {
      add("clipboardWrite", (text) => {
        if (!guard(appName, "clipboard", "剪贴板")) return false;
        return writeText(text);
      });
    }

    if (declared.has("files")) {
      add("fileOpen", (accept, multiple) => {
        if (!guard(appName, "files", "文件")) return -1;
        try {
          return files.open(accept, multiple);
        } catch (error) {
          console.warn("[0.5 host] 文件选择失败：", error?.message ?? error);
          return -1;
        }
      });
      add("download", (name, content, mime) => {
        if (!guard(appName, "files", "文件")) return false;
        return files.download(name, content, mime);
      });
      add("downloadJson", (name, value) => {
        if (!guard(appName, "files", "文件")) return false;
        try {
          return files.download(String(name ?? "jlc-export.json"), JSON.stringify(value ?? null, null, 2), "application/json;charset=utf-8");
        } catch (error) {
          console.warn("[0.5 host] downloadJson 失败：", error?.message ?? error);
          return false;
        }
      });
    }

    if (declared.has("share")) {
      add("share", (text, title, url) => {
        if (!guard(appName, "share", "系统分享")) return false;
        const outcome = shareImpl({ text, title, url }, ui);
        outcome.then((kind) => {
          if (kind === "shared") ui?.toast?.("已交给系统分享");
        }).catch(() => {});
        return true;
      });
      add("shareSupported", () => (guardQuiet(appName, "share") && shareSupported()) || false);
    }

    if (declared.has("notification")) {
      add("notify", (message, tag) => {
        if (!guard(appName, "notification", "通知")) return false;
        const outcome = notifyImpl(message, tag);
        outcome.then((ok) => {
          if (ok) ui?.toast?.("系统通知已发出");
          else ui?.toast?.("通知未发出（权限或环境不支持）");
        }).catch(() => {});
        return true;
      });
      add("notifyStatus", () => (guardQuiet(appName, "notification") ? (notifySupported() ? "ok" : "unavailable") : "denied"));
    }

    if (declared.has("fullscreen")) {
      add("fullscreen", (on) => {
        if (!guard(appName, "fullscreen", "全屏")) return fsActive();
        if (!fsSupported()) return false;
        return fsToggle(on);
      });
      add("fullscreenActive", () => (guardQuiet(appName, "fullscreen") ? fsActive() : false));
    }

    if (declared.has("browser")) {
      add("platform", () => (guardQuiet(appName, "browser") ? detectPlatformLabel() : "unknown"));
      add("isMobile", () => guardQuiet(appName, "browser") && ["android", "ios"].includes(detectPlatformLabel()));
    }

    if (declared.has("pwa")) {
      add("pwaInstall", () => {
        if (!guard(appName, "pwa", "应用安装")) return false;
        const outcome = installer?.promptInstall?.();
        if (outcome) {
          outcome.then((accepted) => {
            ui?.toast?.(accepted ? "已安装 JLC OS 🎉" : "安装取消");
          }).catch(() => ui?.toast?.("请走浏览器菜单：添加到主屏幕"));
        } else {
          ui?.toast?.("请走浏览器菜单：添加到主屏幕");
        }
        return true;
      });
      add("pwaStatus", () => (guardQuiet(appName, "pwa") ? (pwa?.statusText?.(installer) ?? "unavailable") : "unavailable"));
    }

    if (declared.has("theme")) {
      add("theme", (mode) => {
        if (!guard(appName, "theme", "主题")) return false;
        themeState?.set(mode).catch?.(() => {});
        return true;
      });
      add("themeCurrent", () => (guardQuiet(appName, "theme") ? (themeState?.current?.() ?? "auto") : "auto"));
    }

    if (entry?.origin === "system") {
      add("setPermission", (app, domain, mode) => {
        permissions.set(app, domain, mode === "none" ? null : mode).then(
          () => ui?.toast?.("权限已更新"),
          (error) => ui?.toast?.(`权限更新失败：${error?.message ?? error}`),
        );
        return true;
      });
      add("resetPermissions", (app) => {
        permissions.resetApp(app).then(
          () => ui?.toast?.("已重置该应用权限"),
          (error) => ui?.toast?.(`重置失败：${error?.message ?? error}`),
        );
        return true;
      });
      add("resetAllPermissions", () => {
        permissions.resetAll().then(
          () => ui?.toast?.("已重置全部权限"),
          (error) => ui?.toast?.(`重置失败：${error?.message ?? error}`),
        );
        return true;
      });
      add("clearAppStorage", (app) => {
        store.kvClearApp(app).then(
          () => ui?.toast?.(`已清空 ${app} 的本机数据`),
          (error) => ui?.toast?.(`清理失败：${error?.message ?? error}`),
        );
        return true;
      });
      add("clearAllData", () => {
        Promise.allSettled([store.kvClearAll(), store.grantClearAll(), permissions.resetAll()]).then(() => {
          ui?.toast?.("已清除全部本机数据与权限（刷新后生效）");
          setTimeout(() => window.location.reload(), 600);
        });
        return true;
      });
    }

    return caps;
  }

  return { build };
}
