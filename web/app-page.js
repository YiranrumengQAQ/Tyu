/*
 * 沙箱页宿主胶水（运行在 iframe 内部，opaque origin）。
 * 职责：读内联 .jbc → 按查询串/元素属性解析策略 → 装载 → 把观测数据用 postMessage 发给控制台。
 *
 * 它刻意只做「装载 + 汇报」：不带编译器、不带任何宿主特权；
 * capability 是应用能拿到的全部外部能力，且每一项都在页面上可见。
 * Copyright (c) 2026 JLC contributors. MIT licensed.
 */

(function (global) {
  "use strict";

  const RT = global.JLCRuntime;
  const doc = global.document;
  const script = doc.getElementById("jlc-module") || doc.querySelector('script[type="text/jbc"]');
  const target = doc.querySelector((script && script.dataset.target) || "#mount");
  const params = new URLSearchParams(global.location.search);
  const data = (script && script.dataset) || {};
  const appName = data.app || "app";

  function role(name) {
    return doc.querySelector(`[data-role="${name}"]`);
  }

  const meta = role("meta");
  const auditBox = role("audit");
  const deniedList = role("denied-list");
  const state = { kernel: null, handle: null, resolved: null, description: null, error: null, probes: null, sequence: 0 };

  if (!RT || !script || !target) {
    if (meta) meta.textContent = "运行时缺失：请先构建 web/jlc-runtime.js（npm run build:web）";
    return;
  }

  function decodeInlineBase64(text) {
    const binary = global.atob(String(text || "").replace(/\s+/gu, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  let moduleBytes = decodeInlineBase64(script.textContent); // jlc:load 会整块替换它

  function pick(key, fallback) {
    const fromQuery = params.get(key);
    if (fromQuery != null && fromQuery !== "") return fromQuery;
    const camel = key.replace(/-([a-z])/gu, (all, char) => char.toUpperCase());
    const fromDataset = data[camel] ?? data[key.toLowerCase()];
    return fromDataset == null || fromDataset === "" ? fallback : fromDataset;
  }

  function policyOption(raw) {
    const value = String(raw ?? "open").trim();
    if (value.startsWith("{")) {
      try {
        return global.JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  function intOption(raw, fallback) {
    const value = Number.parseInt(String(raw ?? ""), 10);
    return Number.isFinite(value) ? value : fallback;
  }

  function post(type, payload) {
    const message = Object.assign({ type, app: appName, at: Date.now(), seq: (state.sequence += 1) }, payload ?? {});
    try {
      global.parent.postMessage(message, "*");
    } catch {
      /* parent 不可达（理论上不会发生）：忽略 */
    }
    if (type === "jlc:fault" || type === "jlc:error" || type === "jlc:denied") {
      global.console?.warn?.("[jlc:" + appName + "]", message);
    }
  }

  /* ---------------- capability：应用可见的全部外部能力 ---------------- */

  function storageBacking() {
    try {
      global.localStorage.setItem("jlc:probe", "1");
      global.localStorage.removeItem("jlc:probe");
      return "localStorage";
    } catch {
      return "memory";
    }
  }

  function buildCapabilities() {
    const wanted = String(data.capabilities ?? "").split(/\s+/gu).filter(Boolean);
    const table = Object.create(null);
    if (!wanted.length) return { table, backing: null };
    const backing = wanted.includes("storage") ? storageBacking() : "none";
    const memory = new Map();
    for (const name of wanted) {
      if (name === "storage") {
        table.storage = function storage(action, key, value) {
          const read = () => (backing === "localStorage"
            ? Number(global.localStorage.getItem(`jlc:${key}`) ?? 0)
            : Number(memory.get(key) ?? 0));
          const write = (next) => {
            if (backing === "localStorage") global.localStorage.setItem(`jlc:${key}`, String(next));
            else memory.set(key, next);
            return next;
          };
          switch (String(action)) {
            case "get": return read();
            case "set": return write(Number(value) || 0);
            case "increment": return write(read() + (Number(value) || 1));
            case "clear": return write(0);
            default: throw new Error(`storage: 未知动作 ${action}`);
          }
        };
      } else if (name === "clipboard") {
        table.clipboard = function clipboard(action, text) {
          if (String(action) !== "copy") throw new Error("clipboard: 只实现了 copy");
          const area = doc.createElement("textarea");
          area.value = String(text ?? "");
          area.setAttribute("readonly", "readonly");
          area.style.position = "fixed";
          area.style.opacity = "0";
          doc.body.appendChild(area);
          area.select();
          let ok = false;
          try {
            ok = doc.execCommand("copy");
          } catch {
            ok = false;
          }
          area.remove();
          post("jlc:capability", { capability: "clipboard", action: "copy", bytes: String(text ?? "").length, ok });
          return ok;
        };
      } else {
        table[name] = function unimplemented() {
          throw new Error(`capability ${name} 未在本页实现`);
        };
      }
    }
    return { table, backing };
  }

  /* ---------------- 快照 / 状态条 ---------------- */

  function snapshot() {
    if (!state.handle) return null;
    const description = state.handle.describe ? state.handle.describe() : null;
    const usage = state.handle.inspect();
    return { description, usage };
  }

  function renderStatus() {
    if (!meta) return;
    if (state.error) {
      meta.textContent = `未装载：${state.error.name} — ${state.error.message}`;
      meta.dataset.tone = "stop";
      if (auditBox) auditBox.hidden = true;
      return;
    }
    const pair = snapshot();
    const policy = pair?.description?.policy ?? {};
    const denied = pair?.description?.denied ?? [];
    const usage = pair?.usage ?? {};
    meta.textContent = [
      `策略 ${policy.profile ?? "—"}/${policy.faultMode ?? "—"}`,
      `隔离 ${policy.isolation ?? "—"}`,
      `指纹 ${policy.fingerprint ?? "—"}`,
      `样式域 ${policy.scopeId ?? "—"}`,
      `收回 ${denied.length} 项`,
      `cycles ${usage.cycles ?? 0}`,
      `scopes ${usage.scopes ?? 0}`,
      `effects ${usage.effects ?? 0}`,
      `nodes ${usage.nodes ?? 0}`,
      `neutralized ${usage.neutralized ?? 0}`,
    ].join(" · ");
    meta.dataset.tone = denied.length ? "warn" : "go";
    if (auditBox && deniedList) {
      auditBox.hidden = denied.length === 0;
      deniedList.textContent = "";
      for (const item of denied) {
        const li = doc.createElement("li");
        li.textContent = `${item.kind}:${item.detail} — ${item.reason}`;
        deniedList.appendChild(li);
      }
    }
  }

  /* ---------------- 装载 / 重载 ---------------- */

  function relaunch() {
    if (state.handle) {
      try {
        state.handle.unmount();
      } catch {
        /* 已经卸掉了 */
      }
      state.handle = null;
    }
    if (state.kernel) state.kernel.demountAll();
    state.error = null;
    state.description = null;

    const capabilityPack = buildCapabilities();
    const isolation = pick("isolation", "soft");
    const resolved = {
      policy: policyOption(pick("policy", "open")),
      fault: pick("fault", "degrade"),
      isolation,
      realmRoot: isolation === "strict" ? target : undefined,
      maxTotalSteps: intOption(pick("maxSteps", null), 0),
      capabilities: capabilityPack.table,
      onFault: (info) => {
        post("jlc:fault", {
          action: info?.action ?? null,
          kind: info?.kind ?? null,
          detail: info?.detail ?? null,
          message: String(info?.message ?? info ?? "").slice(0, 240),
        });
        renderStatus();
      },
      onError: (error) => {
        post("jlc:error", { message: String(error?.message ?? error).slice(0, 300) });
      },
    };
    state.resolved = resolved;
    try {
      const module = RT.loadModule(moduleBytes, { sourceName: `${appName}.jbc` });
      state.kernel = RT.createVMKernel({
        fault: resolved.fault,
        isolation: resolved.isolation,
        maxTotalSteps: resolved.maxTotalSteps,
        onFault: resolved.onFault,
        onError: resolved.onError,
      });
      state.handle = state.kernel.mount(module, target, resolved);
      const pair = snapshot();
      state.description = pair?.description ?? null;
      post("jlc:mounted", {
        fault: resolved.fault,
        isolation: resolved.isolation,
        maxTotalSteps: resolved.maxTotalSteps,
        capabilities: Object.keys(resolved.capabilities),
        storageBacking: capabilityPack.backing,
        description: state.description,
        usage: pair?.usage ?? null,
      });
    } catch (error) {
      state.error = { name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 400) };
      target.textContent = "";
      const box = doc.createElement("p");
      box.className = "badge badge--stop";
      box.textContent = state.error.name === "JLCPolicyError"
        ? `预检失败，应用未被装载（stop 档）：${state.error.message}`
        : `装载失败：${state.error.name} — ${state.error.message}`;
      target.appendChild(box);
      post("jlc:denied", { error: state.error });
    }
    renderStatus();
  }

  /* ---------------- 隔离自检：从沙箱内部试探宿主 ---------------- */

  function probe(label, attempt) {
    try {
      const detail = attempt();
      return { label, leaked: true, detail: String(detail ?? "").slice(0, 140) };
    } catch (error) {
      return { label, leaked: false, detail: `${error?.name ?? "Error"}: ${String(error?.message ?? "").slice(0, 140)}` };
    }
  }

  function isolationProbe() {
    const probes = [
      probe("parent.document", () => global.parent.document.title),
      probe("parent DOM 查询", () => global.parent.document.querySelector("body").className),
      probe("localStorage", () => `读到 ${global.localStorage.jlcProbe}`),
      probe("cookie", () => {
        doc.cookie = "jlc=1";
        return doc.cookie || "空";
      }),
      probe("改写 top.location", () => {
        global.top.location.hash = "#jlc-escape";
        return "已改写";
      }),
      probe("宿主 JLCRuntime", () => `typeof ${typeof global.parent.JLCRuntime}`),
    ];
    state.probes = {
      framed: global.self !== global.top,
      origin: global.location.origin,
      crossOriginIsolated: Boolean(global.crossOriginIsolated),
      probes,
    };
    post("jlc:isolation", state.probes);
    return state.probes;
  }

  /* ---------------- 控制台指令 ---------------- */

  global.addEventListener("message", (event) => {
    if (event.source !== global.parent) return; // 只接受本框架宿主的指令
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "jlc:ping") {
      post("jlc:pong", { resolved: { policy: state.resolved?.policy, fault: state.resolved?.fault, isolation: state.resolved?.isolation }, description: state.description, error: state.error, probes: state.probes });
    } else if (message.type === "jlc:relaunch") {
      for (const key of ["policy", "fault", "isolation", "maxSteps"]) {
        if (message[key] != null) params.set(key, String(message[key]));
      }
      relaunch();
    } else if (message.type === "jlc:load") {
      // 宿主（控制台）可以塞进一份新的 .jbc —— 正好演示「宿主有特权、沙箱页没有」。
      try {
        moduleBytes = decodeInlineBase64(String(message.jbc ?? ""));
        relaunch();
      } catch (error) {
        post("jlc:error", { message: `注入的 .jbc 无法解码：${error?.message ?? error}` });
      }
    } else if (message.type === "jlc:probe") {
      isolationProbe();
    } else if (message.type === "jlc:stats") {
      renderStatus();
    }
  });

  role("reload")?.addEventListener("click", () => relaunch());
  role("probe")?.addEventListener("click", () => isolationProbe());

  setInterval(() => {
    if (!state.handle) return;
    const pair = snapshot();
    post("jlc:stats", { usage: pair?.usage ?? null, denials: pair?.description?.denied?.length ?? 0 });
    renderStatus();
  }, intOption(pick("interval", null), 400));

  relaunch();
  isolationProbe();
  post("jlc:hello", {
    href: global.location.href,
    title: doc.title,
    byteLength: moduleBytes.length,
    version: RT.VERSION ?? "?",
    abi: RT.ABI_VERSION ?? 0,
    bytecode: RT.BYTECODE_VERSION ?? 0,
  });
})(typeof window !== "undefined" ? window : globalThis);
