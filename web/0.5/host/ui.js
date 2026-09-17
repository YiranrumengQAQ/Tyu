/*
 * JLC OS 0.5 · 宿主 UI（顶栏 / 底栏 / 授权弹层 / 提示条 / 致命错误页）
 * 全部用 createElement 手工构建 DOM（与内核一样不碰 innerHTML），
 * 且都位于应用隔离域之外。
 */

import { CAPABILITY_META, capabilityLabel } from "./meta.js";

export function createUi(ctx) {
  const { permissions } = ctx;
  const $ = (id) => document.getElementById(id);
  const appTitle = $("os-app-title");
  const netBadge = $("os-net");
  const swBadge = $("os-sw");
  const installBtn = $("os-install");
  const sheets = $("os-sheets");
  const toasts = $("os-toasts");

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on:") && typeof value === "function") node.addEventListener(key.slice(3), value);
      else if (key === "hidden") node.hidden = true;
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of [].concat(children)) {
      if (child == null) continue;
      node.append(child.nodeType ? child : document.createTextNode(child));
    }
    return node;
  }

  /* ---------------- 顶栏 / 底栏 ---------------- */

  function setAppTitle(title, subtitle) {
    appTitle.replaceChildren(
      el("span", { class: "os-app-name", text: title }),
      subtitle ? el("span", { class: "os-app-sub", text: subtitle }) : null,
    );
    document.title = title ? `JLC OS 0.5 · ${title}` : "JLC OS 0.5";
  }

  function setNavActive(name) {
    for (const link of document.querySelectorAll("#os-nav a")) {
      const current = link.dataset.app === name;
      link.classList.toggle("is-active", current);
      if (current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  function setOnline(online) {
    netBadge.textContent = online ? "在线" : "离线";
    netBadge.classList.toggle("is-offline", !online);
    netBadge.hidden = false;
  }

  function setSwReady(ready) {
    swBadge.textContent = ready ? "离线就绪" : "缓存中";
    swBadge.hidden = !ready;
  }

  function setInstallAvailable(available) {
    installBtn.hidden = !available;
  }

  /* ---------------- 加载 / 致命错误 ---------------- */

  function showLoading(text) {
    setAppTitle("JLC OS", text ?? "正在装载应用…");
  }

  function fatal(title, message, actions = []) {
    const panel = el("div", { class: "os-fatal" }, [
      el("div", { class: "os-fatal-card" }, [
        el("div", { class: "os-fatal-mark", text: "⚠" }),
        el("h2", { text: title }),
        el("pre", { class: "os-fatal-msg", text: String(message ?? "").slice(0, 2000) }),
        el("div", { class: "os-fatal-actions" }, actions.map((action) =>
          el("button", { class: "os-btn os-btn--filled", "on:click": action.onClick, text: action.label }),
        )),
      ]),
    ]);
    const host = $("os-fatal");
    host.replaceChildren(panel);
    host.hidden = false;
  }

  function clearFatal() {
    const host = $("os-fatal");
    host.replaceChildren();
    host.hidden = true;
  }

  /* ---------------- 提示条（可带操作按钮） ---------------- */

  function toast(message, { actions = [], sticky = false, tone = "info" } = {}) {
    const node = el("div", { class: `os-toast os-toast--${tone}` }, [
      el("span", { class: "os-toast-msg", text: message }),
      actions.length
        ? el("span", { class: "os-toast-actions" }, actions.map((action) =>
          el("button", {
            class: "os-btn os-btn--small",
            "on:click": () => {
              dismiss();
              action.onClick?.();
            },
            text: action.label,
          }),
        ))
        : null,
    ]);
    toasts.append(node);
    toasts.hidden = false;
    let timer = null;
    function dismiss() {
      if (timer) clearTimeout(timer);
      node.remove();
      if (!toasts.childElementCount) toasts.hidden = true;
    }
    if (!sticky && !actions.length) timer = setTimeout(dismiss, 3800);
    return dismiss;
  }

  /** 权限被拦截时的可操作提示条：允许一次 / 始终允许 / 拒绝。 */
  function permissionToast(appName, domain) {
    const label = capabilityLabel(domain);
    toast(`「${label}」权限被拒绝（${appName}）`, {
      sticky: true,
      tone: "warn",
      actions: [
        { label: "允许一次", onClick: () => void permissions.set(appName, domain, "once") },
        { label: "始终允许", onClick: () => void permissions.set(appName, domain, "always") },
        { label: "保持拒绝", onClick: () => void permissions.set(appName, domain, "deny") },
      ],
    });
  }

  /* ---------------- 首次授权弹层 ---------------- */

  /**
   * @returns {Promise<{ choice: "session"|"always"|"deny"|"later", domains: string[] }>}
   *   domains = 用户勾选（同意）的能力域；choice=later 时 domains 为空。
   */
  function permissionSheet(appName, meta, domains) {
    return new Promise((resolve) => {
      if (!domains.length) {
        resolve({ choice: "later", domains: [] });
        return;
      }
      const checked = new Set(domains);
      const rows = domains.map((domain) => {
        const info = CAPABILITY_META[domain] ?? { icon: "•", label: domain, desc: "" };
        const checkbox = el("input", { type: "checkbox", "aria-label": info.label });
        checkbox.checked = true;
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) checked.add(domain);
          else checked.delete(domain);
        });
        return el("label", { class: "os-sheet-row" }, [
          checkbox,
          el("span", { class: "os-sheet-icon", text: info.icon }),
          el("span", { class: "os-sheet-text" }, [
            el("b", { text: info.label }),
            el("small", { text: info.desc }),
          ]),
        ]);
      });

      let settled = false;
      function settle(choice) {
        if (settled) return;
        settled = true;
        overlay.remove();
        resolve({ choice, domains: choice === "later" ? [] : [...checked] });
      }

      const overlay = el("div", { class: "os-sheet-overlay" }, [
        el("div", { class: "os-sheet" }, [
          el("div", { class: "os-sheet-head" }, [
            el("div", { class: "os-sheet-title", text: "应用请求能力" }),
            el("p", { class: "os-sheet-sub", text: `「${meta?.title ?? appName}」声明了以下宿主能力，未勾选的项在运行中会被拦截，可随时在权限中心修改。` }),
          ]),
          el("div", { class: "os-sheet-rows" }, rows),
          el("div", { class: "os-sheet-actions" }, [
            el("button", { class: "os-btn", "on:click": () => settle("later"), text: "稍后" }),
            el("button", { class: "os-btn", "on:click": () => settle("deny"), text: "全部拒绝" }),
            el("button", { class: "os-btn os-btn--filled", "on:click": () => settle("session"), text: "本次会话允许" }),
            el("button", { class: "os-btn os-btn--accent", "on:click": () => settle("always"), text: "始终允许" }),
          ]),
        ]),
      ]);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) settle("later");
      });
      sheets.append(overlay);
      sheets.hidden = false;
    });
  }

  return {
    el,
    setAppTitle,
    setNavActive,
    setOnline,
    setSwReady,
    setInstallAvailable,
    showLoading,
    fatal,
    clearFatal,
    toast,
    permissionToast,
    permissionSheet,
  };
}
