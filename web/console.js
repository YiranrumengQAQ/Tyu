/*
 * JLC 0.3 游乐场 · 控制台。
 * 与沙箱页之间只有两条通道：src 查询串（装载时）与 postMessage（运行时）。
 * 这里刻意不做任何 DOM 注入：控制台永远只发指令，代码进沙箱的唯一形态是 .jbc 字节码。
 * Copyright (c) 2026 JLC contributors. MIT licensed.
 */

(function (global) {
  "use strict";

  const registry = global.JLC_REGISTRY;
  const FULL = global.JLCFull;
  const doc = global.document;
  const cards = new Map();
  const state = {
    policy: "follow",
    fault: "stop",
    isolation: "soft",
    steps: 0,
    override: "",
    sameOrigin: false,
    filter: "all",
    preset: "safe",
    compiled: null,
  };

  if (!registry) {
    doc.getElementById("apps").innerHTML = "<p class='badge badge--stop'>缺少 web/registry.js：请先跑 npm run build:web</p>";
    return;
  }

  /* ---------------- 小工具 ---------------- */

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function toBase64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return global.btoa(binary);
  }

  function timeOfDay(at) {
    const date = new Date(at ?? Date.now());
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
  }

  const logBox = () => doc.getElementById("log");

  function log(app, type, summary, kind) {
    const box = logBox();
    if (!box) return;
    if (state.filter !== "all" && type !== state.filter) return;
    const line = element("div", "log-line");
    line.dataset.kind = kind ?? type.replace("jlc:", "");
    line.dataset.filter = type;
    line.appendChild(element("time", null, timeOfDay()));
    line.appendChild(element("b", null, `${app} ${type.replace("jlc:", "·")}`));
    line.appendChild(element("span", null, summary));
    box.prepend(line);
    while (box.children.length > 220) box.lastChild.remove();
  }

  function currentPolicyValue(app) {
    const raw = state.override.trim();
    if (raw.startsWith("{")) return raw;
    if (raw) return JSON.stringify({ profile: raw });
    return state.policy === "follow" ? app.policy : state.policy;
  }

  function policyLabel(app) {
    const raw = state.override.trim();
    if (raw && !raw.startsWith("{")) return `override:${raw}`;
    if (raw) return "override:json";
    return state.policy === "follow" ? `${app.policy}（应用声明）` : state.policy;
  }

  function frameSrc(app) {
    const params = new URLSearchParams({
      policy: currentPolicyValue(app),
      fault: state.fault,
      isolation: state.isolation,
      maxSteps: String(state.steps),
    });
    return `${app.href}?${params.toString()}`;
  }

  function sandboxValue() {
    return state.sameOrigin ? "allow-scripts allow-same-origin" : "allow-scripts";
  }

  /* ---------------- 卡片 ---------------- */

  function chip(key, tone, title) {
    const node = element("span", tone ? `chip chip--${tone}` : "chip", key);
    if (title) node.title = title;
    return node;
  }

  function buildCard(app) {
    const card = element("article", "app-card");
    const header = element("header");
    header.appendChild(element("h3", null, app.title));
    header.appendChild(element("span", "app-tag", `web/apps/${app.name}.jlc · ${app.bytes} B · sha ${app.hash}`));
    header.appendChild(element("span", "grow"));
    const status = element("span", "badge", "等待装载");
    header.appendChild(status);
    const link = element("a", "badge", "单独打开");
    link.href = frameSrc(app);
    link.target = "_blank";
    link.rel = "noreferrer";
    header.appendChild(link);
    card.appendChild(header);

    const body = element("div", "app-card-body");
    const frame = doc.createElement("iframe");
    frame.className = "app-frame";
    frame.setAttribute("title", `${app.title}（沙箱 iframe）`);
    frame.setAttribute("sandbox", sandboxValue());
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.src = frameSrc(app);
    body.appendChild(frame);

    const side = element("div", "app-side");

    const summaryBlock = element("p", "muted", app.summary);
    side.appendChild(summaryBlock);
    if (app.demo) side.appendChild(element("p", "hint", app.demo));

    const chips = element("div", "chips");
    for (const requirement of app.requirements) {
      chips.appendChild(chip(requirement.key, null, (requirement.sites ?? []).join(" ") || "无站点记录"));
    }
    side.appendChild(element("h4", "side-h", "接口清单（MANIFEST）"));
    side.appendChild(chips);

    const denials = element("div", "chips");
    side.appendChild(element("h4", "side-h", "当前档位下的收回"));
    side.appendChild(denials);
    side.appendChild(element("p", "hint", "清单只登记静态可判定的接口：动态拼出来的 URL 在写入时被中和（neutralized），不会出现在这里。"));

    const metrics = doc.createElement("table");
    metrics.className = "metrics";
    metrics.innerHTML = "<thead><tr><th>ledger</th><th>值</th></tr></thead><tbody></tbody>";
    side.appendChild(element("h4", "side-h", "运行时用量"));
    side.appendChild(metrics);

    const probes = element("ul", "denied-list");
    probes.style.margin = "0";
    probes.style.paddingLeft = "16px";
    side.appendChild(element("h4", "side-h", "沙箱自检（在 iframe 内部跑）"));
    side.appendChild(probes);

    const controls = element("div", "segmented");
    for (const [label, action] of [["重载", "relaunch"], ["自检", "probe"], ["清空", "clear"]]) {
      const button = element("button", null, label);
      button.type = "button";
      button.dataset.action = action;
      button.addEventListener("click", () => cardAction(entry, action));
      controls.appendChild(button);
    }
    side.appendChild(controls);

    body.appendChild(side);
    card.appendChild(body);

    const sites = new Map(app.requirements.map((item) => [item.key, (item.sites ?? []).join(" ")]));
  const entry = { app, sites, card, frame, link, status, chips, denials, probes, metrics: metrics.tBodies[0], usage: null, mounted: false, lastAt: Date.now() };
    cards.set(app.name, entry);
    return entry;
  }

  function renderDenials(entry) {
    const profile = state.override.trim().startsWith("{") ? entry.app.policy : (state.policy === "follow" ? entry.app.policy : state.policy);
    const list = entry.app.denialsByProfile[profile] ?? [];
    const node = entry.denials;
    node.textContent = "";
    if (!list.length) {
      node.appendChild(chip(`${profile}：全部授予`, "go", "该档位下没有接口被收回"));
      return;
    }
    for (const denial of list) node.appendChild(chip(denial.key, "deny", `${denial.reason}（${(denial.sites ?? []).join(" ")}）`));
  }

  const METRIC_ROWS = [
    ["cycles", "累计指令"],
    ["scopes", "作用域"],
    ["effects", "effect"],
    ["listeners", "监听器"],
    ["timers", "定时器"],
    ["requests", "请求"],
    ["nodes", "受管节点"],
    ["styles", "style 标签"],
    ["faults", "fault 计数"],
    ["denials", "收回接口"],
    ["neutralized", "被中和写入"],
    ["peakStack", "峰值栈"],
    ["peakFrames", "峰值帧"],
  ];

  function renderMetrics(entry, usage) {
    if (!usage) return;
    entry.usage = usage;
    const body = entry.metrics;
    body.textContent = "";
    for (const [key, label] of METRIC_ROWS) {
      const row = doc.createElement("tr");
      row.appendChild(element("th", null, label));
      row.appendChild(element("td", null, usage[key] == null ? "—" : String(usage[key])));
      body.appendChild(row);
    }
  }

  function renderProbes(entry, result) {
    entry.probes.textContent = "";
    if (!result) return;
    const framed = element("li");
    framed.appendChild(chip(result.framed ? "在框架内" : "独立打开", result.framed ? null : "warn"));
    framed.appendChild(chip(`origin ${result.origin}`, null));
    if (result.crossOriginIsolated) framed.appendChild(chip("crossOriginIsolated", "go"));
    entry.probes.appendChild(framed);
    for (const probe of result.probes) {
      const li = doc.createElement("li");
      li.appendChild(chip(probe.leaked ? "leaked" : "blocked", probe.leaked ? "hard" : "go"));
      li.appendChild(doc.createTextNode(` ${probe.label} · ${probe.detail}`));
      entry.probes.appendChild(li);
    }
  }

  function setStatus(entry, text, tone) {
    entry.status.textContent = text;
    entry.status.className = `badge${tone ? ` badge--${tone}` : ""}`;
  }

  function cardAction(entry, action) {
    if (action === "relaunch") entry.frame.contentWindow.postMessage({ type: "jlc:relaunch", policy: currentPolicyValue(entry.app), fault: state.fault, isolation: state.isolation, maxSteps: state.steps }, "*");
    else if (action === "probe") entry.frame.contentWindow.postMessage({ type: "jlc:probe" }, "*");
    else if (action === "clear") entry.probes.textContent = "";
  }

  /* ---------------- 全局控制 ---------------- */

  function segmented(id, apply) {
    const box = doc.getElementById(id);
    box.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-" + (id === "policy" ? "policy" : id === "fault" ? "fault" : id === "isolation" ? "iso" : "preset") + "]");
      if (!button) return;
      for (const sibling of box.querySelectorAll("button")) sibling.dataset.active = sibling === button ? "1" : "";
      apply(button);
    });
    return box;
  }

  segmented("policy", (button) => {
    state.policy = button.dataset.policy;
    refreshAll();
  });
  segmented("fault", (button) => {
    state.fault = button.dataset.fault;
    refreshAll();
  });
  segmented("isolation", (button) => {
    state.isolation = button.dataset.iso;
    refreshAll();
  });

  doc.getElementById("steps").addEventListener("change", (event) => {
    state.steps = Number.parseInt(event.target.value, 10) || 0;
    refreshAll();
  });
  doc.getElementById("override").addEventListener("change", (event) => {
    state.override = event.target.value.trim();
    refreshAll();
  });
  doc.getElementById("sso").addEventListener("change", (event) => {
    state.sameOrigin = event.target.checked;
    for (const entry of cards.values()) {
      entry.frame.setAttribute("sandbox", sandboxValue());
      entry.frame.src = frameSrc(entry.app); // 沙箱属性改变必须重建框架
      entry.link.href = frameSrc(entry.app);
    }
    log("console", "jlc:sandbox", `sandbox="${sandboxValue()}"（重建全部 iframe）`, "sandbox");
  });
  doc.getElementById("apply").addEventListener("click", () => refreshAll());
  doc.getElementById("reload").addEventListener("click", () => {
    for (const entry of cards.values()) entry.frame.src = frameSrc(entry.app);
    log("console", "jlc:reload", "重建全部 iframe", "reload");
  });
  doc.getElementById("probe").addEventListener("click", () => {
    for (const entry of cards.values()) cardAction(entry, "probe");
  });
  doc.getElementById("clear-log").addEventListener("click", () => {
    logBox().textContent = "";
  });
  doc.getElementById("log-filters").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-filter]");
    if (!button) return;
    state.filter = button.dataset.filter;
    for (const line of logBox().children) {
      line.style.display = state.filter === "all" || line.dataset.filter === state.filter ? "" : "none";
    }
  });
  function refreshAll() {
    for (const entry of cards.values()) {
      cardAction(entry, "relaunch");
      entry.link.href = frameSrc(entry.app); // 单独打开时参数与当前开关一致
      renderDenials(entry);
    }
    renderBadges();
  }

  /* ---------------- 消息路由 ---------------- */

  global.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object" || typeof message.type !== "string" || !message.type.startsWith("jlc:")) return;
    let entry = null;
    for (const candidate of cards.values()) {
      if (candidate.frame.contentWindow === event.source) {
        entry = candidate;
        break;
      }
    }
    if (!entry) {
      log("?", message.type, "没有对应的框架，忽略", "error");
      return;
    }
    const app = entry.app;
    if (message.type === "jlc:hello") {
      log(app.name, message.type, `${message.title} · ${message.byteLength} B 字节码 · runtime v${message.version} abi ${message.abi}`, "hello");
    } else if (message.type === "jlc:mounted") {
      entry.mounted = true;
      const denied = message.description?.denied ?? [];
      setStatus(entry, denied.length ? `已装载 · 收回 ${denied.length}` : "已装载", denied.length ? "warn" : "go");
      renderMetrics(entry, message.usage);
      const description = message.description;
      if (description?.policy) {
        entry.chips.textContent = "";
        for (const item of description.granted ?? []) entry.chips.appendChild(chip(item.key, "go", entry.sites.get(item.key) ?? ""));
        for (const item of denied) entry.chips.appendChild(chip(`${item.kind}:${item.detail}`, "deny", `${item.reason}｜${entry.sites.get(`${item.kind}:${item.detail}`) ?? ""}`));
      }
      log(app.name, message.type, `${policyLabel(app)} / fault ${message.fault} / 隔离 ${message.isolation} · 授予 ${(description?.granted ?? []).length} 收回 ${denied.length}${message.storageBacking ? ` · storage ${message.storageBacking}` : ""}`, "mounted");
    } else if (message.type === "jlc:denied") {
      entry.mounted = false;
      setStatus(entry, "拒绝装载", "stop");
      entry.chips.textContent = "";
      log(app.name, message.type, message.error?.message ?? "", "denied");
    } else if (message.type === "jlc:fault") {
      setStatus(entry, `degrade · ${message.kind}:${message.detail}`, "warn");
      log(app.name, message.type, `${message.action ?? ""} ${message.kind}:${message.detail} — ${message.message}`, "fault");
    } else if (message.type === "jlc:error") {
      setStatus(entry, "运行期错误", "stop");
      log(app.name, message.type, message.message, "error");
    } else if (message.type === "jlc:capability") {
      log(app.name, message.type, `${message.capability} ${message.action} · ${message.bytes} 字节 · ok=${message.ok}`, "capability");
    } else if (message.type === "jlc:isolation") {
      renderProbes(entry, message);
      const leaked = message.probes.filter((item) => item.leaked).length;
      log(app.name, message.type, `framed=${message.framed} origin=${message.origin} 泄漏 ${leaked}/${message.probes.length}`, leaked ? "error" : "isolation");
    } else if (message.type === "jlc:stats") {
      if (!entry.mounted) return;
      entry.lastAt = Date.now();
      renderMetrics(entry, message.usage);
      if (message.denials) setStatus(entry, `已装载 · 收回 ${message.denials}`, "warn");
    } else if (message.type === "jlc:pong") {
      log(app.name, message.type, JSON.stringify(message.resolved ?? {}), "pong");
    }
  });

  /* ---------------- 编译台 ---------------- */

  const PRESETS = {
    safe: String.raw`app Safe {
  state count = 0;
  derive label = "点击 " + count + " 次";
  action bump() { count += 1; return null; }
  style ` + "`" + String.raw`.safe { display: grid; gap: 8px; }` + "`" + String.raw`;
  view {
    div(class = "safe") {
      h3 { text label; }
      button(on:click = { bump(); }) { text "加一"; }
      p(class = "muted") { text "只用 state / derive / action：strict 档也全部授予。"; }
    }
  }
}`,
    open: String.raw`app NeedsOpen {
  state text = "<em>iframe 里的世界</em>";
  derive doc = "<!doctype html><p>" + text + "</p>";
  action grow() { text = text + "!"; return null; }
  view {
    main {
      h3 { text "需要 open / trusted 的三个接口"; }
      p(class = "muted") { text "frame:iframe、frame:srcdoc、url:data —— strict 档会把前两个收回。"; }
      button(on:click = { grow(); }) { text "追一个感叹号"; }
      iframe(srcdoc = doc, title = "沙箱预览");
      img(src = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3C/svg%3E", alt = "data 图");
    }
  }
}`,
    hard: String.raw`app HardLimit {
  view {
    main {
      div(attr:onclick = "alert(1)");
      div(prop:innerHTML = "<b>粗体</b>");
      a(href = "javascript:alert(1)") { text "危险的链接"; }
    }
  }
}`,
    quota: String.raw`app Quota {
  state rows = range(1, 400);
  view {
    ul {
      each (row, index in rows key row) {
        li { text index + " · " + row; }
      } else {
        li { text "空"; }
      }
    }
  }
}`,
  };

  function resolveEditorPolicy() {
    const raw = state.override.trim();
    if (raw.startsWith("{")) {
      try {
        return global.JSON.parse(raw);
      } catch {
        return state.policy === "follow" ? "open" : state.policy;
      }
    }
    if (raw) return raw;
    return state.policy === "follow" ? "open" : state.policy;
  }

  const sourceBox = doc.getElementById("source");
  const outBox = doc.getElementById("compile-out");
  const noteBox = doc.getElementById("compile-note");
  const injectButton = doc.getElementById("inject");
  const injectTarget = doc.getElementById("inject-target");

  sourceBox.value = PRESETS.safe;
  for (const app of registry.apps) injectTarget.appendChild(element("option", null, app.title)).value = app.name;

  segmented("presets", (button) => {
    state.preset = button.dataset.preset;
    sourceBox.value = PRESETS[state.preset];
    state.compiled = null;
    injectButton.disabled = true;
    outBox.textContent = "已切换源码，点「编译 + 预检」。";
  });

  function compileNow() {
    if (!FULL) {
      outBox.textContent = "缺少 web/jlc-full.js：请先跑 npm run build:web。";
      return null;
    }
    const source = sourceBox.value;
    const profile = state.policy === "follow" ? "open" : state.policy;
    try {
      const program = FULL.JLC.compile(source, { sourceName: "console.jlc", policyMode: "defer" });
      return program;
    } catch (error) {
      outBox.textContent = `${error.name}: ${error.message}`;
      noteBox.textContent = "编译期就失败了：硬限制（HTML 解析属性、危险 URL、被禁标签）与语法错误在任何 fault 档都会拒绝。";
      injectButton.disabled = true;
      state.compiled = null;
      return null;
    }
  }

  doc.getElementById("compile").addEventListener("click", () => {
    const program = compileNow();
    if (!program) return;
    const module = program.module;
    const bytes = program.serialize();
    const lines = [];
    lines.push(`; app ${module.app} · 函数 ${module.functions.length} · 常量池 ${module.pool.length} · .jbc ${bytes.length} B`);
    lines.push(`; 接口清单（${(module.requirements ?? []).length}）`);
    for (const requirement of module.requirements ?? []) {
      const sites = (requirement.sites ?? []).map((site) => `${site.line}:${site.column}`).join(", ");
      lines.push(`;   ${requirement.kind}:${requirement.detail}${sites ? `  @ ${sites}` : ""}`);
    }
    for (const profile of ["strict", "open", "trusted"]) {
      const denials = FULL.JLC.checkPolicy(program, profile);
      lines.push(`; ${profile} → ${denials.length ? "拒绝 " + denials.map((item) => item.key).join(" ") : "全部授予"}`);
    }
    const profile = resolveEditorPolicy();
    const denials = FULL.JLC.checkPolicy(program, profile);
    lines.push("");
    lines.push(`; 以 ${profile} 档 + fault=${state.fault} 注入到「${injectTarget.options[injectTarget.selectedIndex]?.text ?? "—"}」；${denials.length} 个接口会被策略处理。`);
    outBox.textContent = lines.join("\n");
    noteBox.textContent = (denials?.length ?? 0)
      ? "预检列出了会被收回的接口。注入后沙箱页会按当前 fault 档处理：stop 直接拒装载，degrade 换成占位节点，report 照常渲染。"
      : "当前档位下全部授予：注入后应用原样运行。";
    state.compiled = { jbc: toBase64(bytes), bytes: bytes.length, requirements: (module.requirements ?? []).length, denials: denials.length };
    injectButton.disabled = cards.size === 0;
    log("console", "jlc:compile", `${module.app} · ${bytes.length} B · ${(module.requirements ?? []).length} 个接口 · ${profile} 下收回 ${denials.length}`, "compile");
  });

  injectButton.addEventListener("click", () => {
    if (!state.compiled) return;
    const entry = cards.get(injectTarget.value);
    if (!entry) return;
    entry.frame.contentWindow.postMessage({ type: "jlc:load", jbc: state.compiled.jbc }, "*");
    setStatus(entry, "注入中…", "warn");
    log("console", "jlc:inject", `向 ${entry.app.name} 注入 ${state.compiled.bytes} B 字节码（${state.compiled.requirements} 个接口）`, "inject");
  });

  /* ---------------- 顶栏徽标 ---------------- */

  function renderBadges() {
    const box = doc.getElementById("badges");
    box.textContent = "";
    const add = (text, tone, title) => {
      const node = chip(text, tone, title);
      node.style.fontFamily = "var(--mono)";
      box.appendChild(node);
    };
    add(`v${registry.version}`, null, "运行时与编译器版本");
    add(`abi ${registry.abi}`, null, "指令集版本");
    add(`bytecode ${registry.bytecode}`, null, ".jbc 容器版本");
    add(`${registry.apps.length} 个应用页`, null);
    add(global.crossOriginIsolated ? "crossOriginIsolated ✓" : "crossOriginIsolated ✗", global.crossOriginIsolated ? "go" : "warn", "需要服务器发 COOP/COEP（npm run serve）；iframe 沙箱不依赖它");
    add(sandboxValue(), state.sameOrigin ? "hard" : "go", "嵌入用 sandbox 属性");
    add(`policy ${state.policy === "follow" ? "跟随应用" : state.policy}`, null);
    add(`fault ${state.fault}`, state.fault === "stop" ? "stop" : state.fault === "degrade" ? "warn" : null);
    add(`isolation ${state.isolation}`, null);
    add(state.steps ? `maxTotalSteps ${state.steps}` : "maxTotalSteps ∞", null);
    if (state.override.trim()) add("策略覆盖", "hard");
  }

  /* ---------------- 启动 ---------------- */

  const appsBox = doc.getElementById("apps");
  for (const app of registry.apps) {
    const entry = buildCard(app);
    renderDenials(entry);
    renderProbes(entry, null);
    appsBox.appendChild(entry.card);
  }
  renderBadges();

  // 无响应检测：iframe 挂了要能看出来
  setInterval(() => {
    const now = Date.now();
    for (const entry of cards.values()) {
      if (!entry.mounted && now - entry.lastAt > 4000 && entry.status.textContent === "等待装载") {
        setStatus(entry, "无响应（检查 ../jlc-runtime.js）", "stop");
      }
    }
  }, 1500);
})(typeof window !== "undefined" ? window : globalThis);
