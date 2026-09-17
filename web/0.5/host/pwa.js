/*
 * JLC OS 0.5 · PWA / Service Worker / 主题
 *
 * sw.js 放在仓库根（site root），注册出来的作用域是整个站点：
 * 它只由 0.5 页面注册，0.4 Bootloader 不会注册它——但一旦注册，
 * 0.4 页面同样获得「首次联网后离线可用」的能力（策略是网络优先 + 缓存兜底）。
 *
 * 主题：light / dark / auto。写双份——localStorage（0.5 内联脚本首屏读取，避免闪烁）
 * 与 IndexedDB 单例（设置页可见 / 可清）。
 */

import { browserInfo, platformLabel } from "./browser.js";

const THEME_KEY = "jlc05-theme";

export function currentTheme() {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === "light" || raw === "dark" || raw === "auto") return raw;
  } catch { /* 忽略 */ }
  return "auto";
}

export function effectiveTheme() {
  const theme = currentTheme();
  if (theme === "auto") {
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  }
  return theme;
}

export async function setTheme(store, mode) {
  const theme = mode === "light" || mode === "dark" || mode === "auto" ? mode : "auto";
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch { /* 忽略 */ }
  applyTheme();
  await store.singletonSet("theme", theme).catch(() => {});
  return theme;
}

export function applyTheme() {
  const effective = effectiveTheme();
  document.documentElement.dataset.theme = effective;
  const meta = document.querySelector?.('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", effective === "dark" ? "#12141a" : "#f6f5f0");
}

export function watchSystemTheme(onChange) {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!media) return;
  const handler = () => {
    if (currentTheme() === "auto") {
      applyTheme();
      onChange?.();
    }
  };
  media.addEventListener?.("change", handler);
}

/* ---------------- Service Worker ---------------- */

let registration = null;
let installPromptEvent = null;

export function swSupported() {
  return "serviceWorker" in navigator;
}

export async function registerServiceWorker(swUrl, ui) {
  if (!swSupported()) return "unavailable";
  try {
    registration = await navigator.serviceWorker.register(swUrl);
    registration.addEventListener("updatefound", () => {
      const worker = registration.active;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          ui?.toast?.("JLC OS 已更新，重新加载页面生效");
        }
      });
    });
    return "ready";
  } catch (error) {
    console.warn("[0.5 host] Service Worker 注册失败：", error?.message ?? error);
    return "failed";
  }
}

export function swStatus() {
  if (!swSupported()) return "unavailable";
  if (!registration) return "pending";
  return registration.active || registration.waiting ? "ready" : "pending";
}

export async function updateServiceWorker(ui) {
  if (!registration?.update) return false;
  try {
    const outcome = await registration.update();
    if (outcome?.waiting) await outcome.waiting.postMessage?.("SKIP_WAITING").catch(() => {});
    ui?.toast?.("已检查更新");
    return true;
  } catch {
    ui?.toast?.("检查更新失败");
    return false;
  }
}

export function onInstallPrompt(handler) {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPromptEvent = event;
    handler?.(true);
  });
  window.addEventListener("appinstalled", () => {
    installPromptEvent = null;
    handler?.(false);
    window.dispatchEvent(new CustomEvent("jlc05:installed"));
  });
  return {
    available: () => installPromptEvent !== null,
    installed: () => window.matchMedia?.("(display-mode: standalone)")?.matches === true,
    async promptInstall() {
      if (!installPromptEvent) return false;
      installPromptEvent.prompt();
      const choice = await installPromptEvent.userChoice?.catch(() => null);
      if (choice?.outcome === "accepted") installPromptEvent = null;
      return choice?.outcome === "accepted";
    },
  };
}

export function pwaStatus(installer) {
  if (installer?.installed?.()) return "installed";
  if (!swSupported()) return "unavailable";
  if (installer?.available?.()) return "available";
  return "manual"; // 需要用户走浏览器菜单「添加到主屏幕」
}

export function statusText(installer) {
  const status = pwaStatus(installer);
  if (status === "installed") return "已安装（独立窗口运行）";
  if (status === "available") return "可一键安装";
  if (status === "manual") return "请走浏览器菜单：添加到主屏幕";
  return "当前环境不支持 PWA";
}

export { browserInfo, platformLabel };
