import test from "node:test";
import assert from "node:assert/strict";
import JLC, {
  ABI_VERSION,
  BYTECODE_VERSION,
  JLCPolicyError,
  JLCQuotaError,
  JLCVerifyError,
  OP,
  SECURITY_PROFILES,
  SYSCALLS,
  auditModule,
  checkPermissions,
  encodeModule,
  loadModule,
  policyViolation,
  POLICY_KEYS,
  resolvePolicy,
  scopeStylesheet,
  verifyModule,
} from "../jlc.js";
import { createVMKernel } from "../jlc-vm.js";
import { FakeEvent, createDOM } from "../support/fake-dom.js";

const QUOTE = "`";

function captureThrow(function_) {
  try {
    function_();
  } catch (error) {
    return error;
  }
  throw new Error("预期抛出异常，但没有");
}

/** 复制一份可写的模块（原模块逐层冻结，伪造测试需要能改）。 */
function cloneModule(module, patch = {}) {
  return {
    ...module,
    ...patch,
    pool: [...module.pool],
    globalRefs: [...module.globalRefs],
    functions: module.functions.map((func) => ({ ...func })),
    actions: module.actions.map((action) => ({ ...action, params: action.params.map((item) => ({ ...item })) })),
    declarations: module.declarations.map((declaration) => ({ ...declaration })),
    requirements: module.requirements ? [...module.requirements] : undefined,
    verified: false,
  };
}

/* ------------------------------------------------------------------
 * 1. 策略：数据、指纹、覆盖
 * ------------------------------------------------------------------ */

test("unknown policy fields are rejected and the fingerprint covers every field", () => {
  // 打错的字段名会静默失效，这是策略层最坏的失败模式：直接拒绝。
  assert.throws(() => resolvePolicy({ profile: "open", allowDataUrl: true }), /未知策略字段“allowDataUrl”/u);
  assert.throws(() => resolvePolicy({ maxDomnode: 10 }), /未知策略字段/u);
  assert.throws(() => resolvePolicy(42), /策略必须是档名或对象/u);
  // POLICY_KEYS 必须是解析结果字段的全集（除 version / fingerprint），否则覆盖项无法书写
  const resolved = resolvePolicy("strict");
  const fields = Object.keys(resolved).filter((key) => key !== "version" && key !== "fingerprint");
  assert.deepEqual(fields.sort(), [...POLICY_KEYS, "profile"].sort());

  // 指纹覆盖全部字段：只改 maxStyleBytes 这种“小”字段也必须换指纹
  const base = resolvePolicy("open");
  const tweaked = resolvePolicy({ profile: "open", maxStyleBytes: base.maxStyleBytes + 1 });
  assert.notEqual(base.fingerprint, tweaked.fingerprint);
  assert.notEqual(resolvePolicy({ profile: "open", label: base.label }).fingerprint, undefined);
  // label 只用于显示，不参与指纹
  assert.equal(
    resolvePolicy({ profile: "open", label: "改个名字" }).fingerprint,
    base.fingerprint,
  );
});

test("policy profiles are data, fingerprinted and overridable", () => {
  const strict = resolvePolicy("strict");
  const open = resolvePolicy("open");
  assert.equal(strict.profile, "strict");
  assert.equal(strict.allowSandboxedFrames, false);
  assert.equal(open.allowSandboxedFrames, true);
  assert.equal(strict.strictUrls, false);
  assert.notEqual(strict.fingerprint, open.fingerprint);
  assert.equal(strict.fingerprint, resolvePolicy("strict").fingerprint, "同一份策略指纹稳定，可以进构建产物");
  assert.ok(Object.isFrozen(strict));

  const tweaked = resolvePolicy({ profile: "open", allowHtmlInjection: false });
  assert.equal(tweaked.allowHtmlInjection, false);
  assert.equal(tweaked.allowSandboxedFrames, true, "覆盖项只改一个字段，其余继承档位");
  assert.notEqual(tweaked.fingerprint, open.fingerprint);

  const custom = resolvePolicy({ profile: "custom", urlSchemes: ["https:"], allowNetwork: false });
  assert.deepEqual(custom.urlSchemes, ["https:"]);
  assert.equal(custom.allowNetwork, false);
  assert.equal(custom.profile, "custom");

  assert.equal(policyViolation(open, "frame", "iframe"), null);
  assert.match(policyViolation(strict, "frame", "iframe"), /allowSandboxedFrames/);
  assert.match(policyViolation(open, "tag", "script"), /硬限制/);
  assert.match(policyViolation(open, "property", "innerHTML"), /硬限制/);
  assert.equal(Object.keys(SECURITY_PROFILES).length, 3);
  assert.ok(SYSCALLS.every((row) => row.permission && row.note), "接口表每行都要有说明");
  assert.equal(strict.blockedTags.has("meta"), true);
  assert.equal(open.blockedTags.has("meta"), false, "开放档允许写 <meta name=viewport>");
});

test("url policy is a WHATWG decision and defaults to neutralise, not crash", () => {
  const { document, target } = createDOM();
  const source = String.raw`app Links {
  view {
    a(href = "data:image/png;base64,AA") { text "d"; }
    a(href = "data:text/html,<svg>") { text "h"; }
    a(href = "/relative?page=1") { text "r"; }
    a(href = "#anchor") { text "a"; }
  }
}`;
  const handle = JLC.mount(source, target, { document, policy: "strict" });
  const links = [...target.querySelectorAll("a")].map((node) => node.getAttribute("href"));
  assert.deepEqual(links, ["about:blank", "about:blank", "/relative?page=1", "#anchor"]);
  assert.equal(handle.inspect().neutralized, 2, "被净化的次数进账本，管理台看得见");
  handle.unmount();

  const opened = JLC.mount(source, target, { document, policy: "open" });
  assert.equal(target.querySelectorAll("a")[0].getAttribute("href"), "data:image/png;base64,AA", "开放档允许 data 图片");
  assert.equal(target.querySelectorAll("a")[1].getAttribute("href"), "about:blank", "data:text/html 任何档位都进不来");
  opened.unmount();

  const audit = JLC.compile(source).module.requirements;
  assert.match(captureThrow(() => JLC.mount(source, target, {
    document,
    policy: { profile: "strict", strictUrls: true },
  })).message, /url:data:/);
  assert.equal(checkPermissions(audit, resolvePolicy("strict")).length, 0, "默认不因为 URL 拒绝挂载");
});

test("javascript: in a literal never survives, even for a trusted profile", () => {
  const { document, target } = createDOM();
  const program = JLC.compile('app Evil { view { a(href = "java\\nscript:alert(1)") { text "x"; } iframe(src = "javascript:1"); } }');
  const handle = program.mount(target, { document, policy: "trusted", fault: "degrade" });
  assert.equal(target.querySelector("a").getAttribute("href"), "about:blank");
  assert.equal(target.querySelector("iframe").getAttribute("src"), "about:blank");
  handle.unmount();
});

/* ------------------------------------------------------------------
 * 2. 接口清单：静态推导、序列化、防伪造
 * ------------------------------------------------------------------ */

test("the capability manifest is derived from instructions and survives the round trip", () => {
  const program = JLC.compile(String.raw`app Manifest {
  state show = true;
  resource feed = http("/api/feed");
  action go() { navigate("/next"); }
  action beat() { every (250) { show = !show; } }
  view {
    section {
      iframe(srcdoc = "<p>hi</p>");
      my-widget();
      when (show) { button(on:click = { go(); }) { text "go"; } }
    }
  }
}`);
  const keys = program.module.requirements.map((item) => item.key);
  for (const expected of ["frame:iframe", "frame:srcdoc", "host:http", "host:navigate", "host:timer", "tag:my-widget"]) {
    assert.ok(keys.includes(expected), `清单缺少 ${expected}：${keys.join(", ")}`);
  }

  const bytes = program.serialize();
  const loaded = loadModule(bytes, { sourceName: "manifest.jbc" });
  assert.equal(loaded.version, BYTECODE_VERSION);
  assert.deepEqual(loaded.requirements.map((item) => item.key), keys, "清单跟着字节码走");
  assert.deepEqual([...encodeModule(loaded)], [...bytes], "清单序列化是确定性的");
  assert.ok(Object.isFrozen(loaded.requirements));
});

test("a lying manifest is rejected at load time", () => {
  const program = JLC.compile('app Tiny { view { iframe(srcdoc = "x"); } }');
  const forged = cloneModule(program.module, { declaredRequirements: ["tag:div"] });
  assert.throws(() => verifyModule(forged, "forged"), /漏报接口/);

  const silent = cloneModule(program.module, { declaredRequirements: [] });
  assert.throws(() => verifyModule(silent, "silent"), /frame:iframe/);

  const honest = cloneModule(program.module, { declaredRequirements: program.module.requirements.map((item) => item.key) });
  assert.equal(verifyModule(honest, "honest").requirements.length, program.module.requirements.length);
  assert.ok(auditModule(program.module).some((item) => item.key === "frame:iframe"));
});

test("hand-written bytecode cannot smuggle a hard-banned tag past the policy", () => {
  const program = JLC.compile('app Tiny { view { div { text "x"; } } }');
  const module = cloneModule(program.module);
  const view = module.functions[module.view];
  const tagIndex = (view.code[1] << 8) | view.code[2];
  assert.equal(module.pool[tagIndex], "div");
  // 只改常量池里的标签名：手写/被篡改的 .jbc 没有可信的申报段可看
  module.pool[tagIndex] = "script";
  verifyModule(module, "hand-written");
  assert.ok(module.requirements.some((item) => item.key === "tag:script"));
  assert.ok(module.functions[module.view].code.includes(OP.ELEM));

  const { document, target } = createDOM();
  assert.throws(
    () => createVMKernel({ policy: "trusted" }).mount(module, target, { document }),
    (error) => error.name === "JLCPolicyError" && /硬限制/.test(error.message),
  );
  assert.equal(target.textContent, "", "硬限制在渲染之前就拦住");

  // 连降级档也不能放行硬限制
  assert.throws(
    () => createVMKernel({ policy: "open", fault: "degrade" }).mount(module, target, { document }),
    (error) => error.name === "JLCPolicyError" && /硬限制/.test(error.message),
  );
});

/* ------------------------------------------------------------------
 * 3. 装载期裁决 vs 降级
 * ------------------------------------------------------------------ */

test("denied surfaces fail the mount atomically, or degrade visibly", () => {
  const source = String.raw`app Frame {
  state html = "<b>hi</b>";
  view {
    main {
      iframe(srcdoc = html);
      span { text "always"; }
    }
  }
}`;
  const program = JLC.compile(source);
  const { document, target } = createDOM();

  assert.deepEqual(program.module.requirements.map((item) => item.key), ["frame:iframe", "frame:srcdoc", "tag:main", "tag:span"]);
  const denial = captureThrow(() => program.mount(target, { document, policy: "strict" }));
  assert.ok(denial instanceof JLCPolicyError);
  assert.match(denial.message, /frame:iframe/);
  assert.equal(target.textContent, "", "拒绝挂载不能留下半截界面");

  const degraded = program.mount(target, { document, policy: "strict", fault: "degrade" });
  assert.equal(target.querySelector("iframe"), null);
  assert.equal(target.querySelector("span").textContent, "always", "其余界面照常工作");
  const placeholder = target.querySelector("jlc-denied");
  assert.equal(placeholder.getAttribute("data-jlc-denied"), "iframe");
  assert.match(placeholder.textContent, /策略 strict 拒绝/);
  const report = degraded.describe();
  assert.equal(report.denied.length, 2, "iframe 与 srcdoc 两项被拒");
  assert.ok(report.denied.every((item) => /allow/.test(item.reason)));
  assert.equal(report.policy.fingerprint, resolvePolicy("strict").fingerprint);
  assert.deepEqual(report.granted.map((item) => item.key), ["tag:main", "tag:span"]);
  assert.equal(report.abi, ABI_VERSION);
  degraded.unmount();
});

test("build-time preflight uses the very same decision function", () => {
  const source = 'app Frame { view { iframe(srcdoc = "x"); } }';
  const gate = captureThrow(() => JLC.compile(source, { policy: "strict", sourceName: "gate.jlc" }));
  assert.equal(gate.name, "JLCCompileError");
  assert.equal(gate.line, 1);
  assert.match(gate.message, /未授予 <iframe>/);

  const summary = captureThrow(() => JLC.compile(source, { policy: "strict", policyMode: "manifest" }));
  assert.match(summary.message, /预检失败/);
  assert.match(summary.message, /frame:iframe/);
  assert.match(summary.message, /frame:srcdoc/);

  assert.ok(JLC.compile(source, { policy: "strict", policyMode: "defer" }).serialize().length > 0, "defer 让构建一定成功");
  assert.equal(JLC.checkPolicy(source, "open").length, 0);
  assert.ok(JLC.checkPolicy(source, "strict").length > 0);
});

test("report mode keeps everything and only logs what the app asked for", () => {
  const { document, target } = createDOM();
  const events = [];
  const handle = JLC.mount('app Report { view { iframe(srcdoc = "x"); } }', target, {
    document,
    policy: { profile: "strict", audit: (entry) => events.push(entry) },
    fault: "report",
  });
  assert.ok(target.querySelector("iframe"), "report 档只记录不拦截");
  assert.equal(target.querySelector("iframe").getAttribute("sandbox"), "", "但加固项照样由内核写");
  assert.ok(events.some((entry) => entry.action === "deny" && entry.kind === "frame"));
  assert.ok(handle.inspect().denials > 0);
  handle.unmount();
});

test("the kernel hardens sandboxed frames and the app cannot undo it", () => {
  const { document, target } = createDOM();
  const handle = JLC.mount(
    String.raw`app Hardened {
  view {
    iframe(srcdoc = "<i>x</i>", sandbox = "allow-top-navigation allow-same-origin", src = "javascript:alert(1)");
  }
}`,
    target,
    { document, policy: "open" },
  );
  const frame = target.querySelector("iframe");
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-forms allow-popups", "sandbox 只能由策略写");
  assert.equal(frame.getAttribute("src"), "about:blank", "frame 的 src 走白名单");
  assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(frame.getAttribute("loading"), "lazy");
  assert.equal(frame.getAttribute("srcdoc"), "<i>x</i>");
  assert.ok(handle.permissions().some((item) => item.kind === "frame" && item.granted));
  handle.unmount();
});

test("srcdoc honours the html quota and the injection grant", () => {
  const { document, target } = createDOM();
  const program = JLC.compile(String.raw`app Big {
  state html = "xxxx";
  view { iframe(srcdoc = html); }
}`);
  const squeezed = program.mount(target, { document, policy: { profile: "open", htmlMaxChars: 2 }, fault: "degrade" });
  assert.equal(target.querySelector("iframe").getAttribute("srcdoc"), null, "超配额就不注入");
  assert.ok(squeezed.inspect().faults > 0);
  squeezed.unmount();
  const hard = captureThrow(() => program.mount(target, { document, policy: { profile: "open", htmlMaxChars: 2 } }));
  assert.match(hard.message, /htmlMaxChars/, "配额档默认是硬失败");

  const deniedHandle = program.mount(target, { document, policy: { profile: "open", allowHtmlInjection: false }, fault: "degrade" });
  assert.equal(target.querySelector("iframe").getAttribute("srcdoc"), null, "未授权就不注入");
  assert.ok(deniedHandle.describe().denied.some((item) => item.detail === "srcdoc"));
  deniedHandle.unmount();
});

/* ------------------------------------------------------------------
 * 4. 隔离域：每个实例只管自己那块 DOM
 * ------------------------------------------------------------------ */

test("style declarations are scoped to the instance subtree under open profiles", () => {
  const { document, target } = createDOM();
  const css = `${QUOTE}.box { color: red; }
.box, :root { padding: 1px; }
@media (min-width: 2px) { .box { color: blue; } }${QUOTE}`;
  const source = `app Styled {
  state color = "red";
  style ${css};
  view { div(class = "box") { text color; } }
}`;
  const scoped = JLC.compile(source).mount(target, { document, policy: "open" });
  const style = document.head.querySelector("style");
  const selector = `[data-jlc-app="${scoped.scopeId}"]`;
  assert.equal(target.getAttribute("data-jlc-app"), scoped.scopeId, "挂载根带实例标记");
  assert.ok(style.textContent.includes(`${selector} .box`), style.textContent);
  assert.ok(style.textContent.includes(`@media (min-width: 2px){${selector} .box`), "嵌套块也要作用域化");
  assert.ok(style.textContent.includes(`padding: 1px`));
  assert.equal(scoped.inspect().styles, 1);
  assert.ok(style.getAttribute("id").startsWith(scoped.scopeId));
  scoped.unmount();
  assert.equal(document.head.querySelector("style"), null);
  assert.equal(target.getAttribute("data-jlc-app"), null);

  const globalHandle = JLC.compile(source).mount(target, { document, policy: "strict" });
  assert.ok(document.head.querySelector("style").textContent.includes(".box { color: red; }"), "严格档保持 0.2 行为");
  assert.equal(document.head.querySelector("style").getAttribute("data-jlc-owner"), globalHandle.scopeId);
  globalHandle.unmount();

  assert.ok(scopeStylesheet("body { a: 1 }", "#x").startsWith("#x{"), "body 映射到作用域根");
  assert.equal(scopeStylesheet("", "#x"), "");
});

test("two instances on one page cannot touch each other under strict isolation", () => {
  const { document, target } = createDOM();
  let observer;
  document.defaultView.MutationObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {}
    disconnect() {}
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const slotA = document.createElement("div");
  const slotB = document.createElement("div");
  host.appendChild(slotA);
  host.appendChild(slotB);

  const kernel = createVMKernel({ policy: "open", isolation: "strict" });
  const a = kernel.mount(JLC.compile('app A { state s = "a"; view { p { text s; } } }'), slotA, { document });
  const b = kernel.mount(JLC.compile('app B { state s = "b"; view { p { text s; } } }'), slotB, { document });
  assert.equal(slotA.querySelector("p").textContent, "a");
  assert.equal(slotB.querySelector("p").textContent, "b");
  assert.equal(kernel.list().length, 2, "内核有在册实例清单");
  assert.deepEqual(kernel.list().map((item) => item.app), ["A", "B"]);
  assert.equal(slotA.getAttribute("data-jlc-realm"), a.scopeId);

  // 外部把 A 的节点搬出 A 的子树：strict 档视作放弃所有权
  const victim = slotA.querySelector("p");
  slotB.appendChild(victim);
  observer.callback([{ removedNodes: [victim], addedNodes: [] }]);
  assert.ok(a.describe().usage.nodes < a.inspect().nodes + 1);
  assert.equal(slotB.querySelector("p").textContent, "b", "B 的界面不受影响");

  assert.equal(kernel.demountAll(), 2, "一次清点掉所有实例");
  assert.equal(kernel.list().length, 0);
  assert.equal(a.inspect().active, false);
  assert.equal(b.inspect().active, false);
});

test("strict isolation refuses insertions outside the instance realm", () => {
  const { document, target } = createDOM();
  const outside = document.createElement("section");
  document.body.appendChild(outside);
  const program = JLC.compile('app Reach { state on = true; view { when (on) { p { text "x"; } } } }');
  // realmRoot 划定的边界之外：连挂载本身都会被拒绝，而不是悄悄写到别人家里
  const error = captureThrow(() => program.mount(outside, {
    document,
    policy: "open",
    isolation: "strict",
    realmRoot: target,
  }));
  assert.equal(error.name, "JLCIsolationError");
  assert.match(error.message, /应用子树之外/);
  assert.equal(outside.textContent, "", "越权写入没有留下任何节点");

  const inside = program.mount(outside, { document, policy: "open", isolation: "strict", realmRoot: outside });
  assert.equal(outside.querySelector("p").textContent, "x");
  inside.unmount();
});

/* ------------------------------------------------------------------
 * 5. 配额与记账
 * ------------------------------------------------------------------ */

test("dom quota stops a runaway instance before it paints", () => {
  const { document, target } = createDOM();
  const program = JLC.compile(String.raw`app Swarm {
  state items = [1, 2, 3, 4, 5, 6];
  view {
    ul {
      each (item in items key item) {
        li { text item; }
      }
    }
  }
}`);
  const denial = captureThrow(() => program.mount(target, { document, policy: { profile: "open", maxDomNodes: 4 } }));
  assert.ok(denial instanceof JLCQuotaError, `${denial.name}: ${denial.message}`);
  assert.match(denial.message, /maxDomNodes/);
  assert.equal(target.textContent, "", "超配额同样整体失败，不留下半棵树");

  const small = program.mount(target, { document, policy: "open" });
  assert.ok(small.inspect().nodes > 6);
  small.unmount();
});

test("step budgets: per action and per instance lifetime", () => {
  const { document, target } = createDOM();
  const program = JLC.compile(String.raw`app Spin {
  state n = 0;
  action burn() { for (i in range(0, 400)) { n += 1; } }
  view { text n; }
}`);
  const perAction = program.mount(target, { document, maxSteps: 100 });
  assert.throws(() => perAction.call("burn"), /单次动作运算步数超限/);
  perAction.unmount();

  const perInstance = program.mount(target, { document, policy: "open", maxSteps: 1_000_000, maxTotalSteps: 500 });
  assert.ok(perInstance.inspect().cycles >= 0);
  assert.throws(() => perInstance.call("burn"), JLCQuotaError);
  assert.match(captureThrow(() => perInstance.call("burn")).message, /maxTotalSteps/);
  perInstance.unmount();
});

test("accounting exposes cycles, peak stack and peak frame depth", () => {
  const { document, target } = createDOM();
  const handle = JLC.mount(String.raw`app Counted {
  state n = 0;
  action bump() { n += 1; }
  action deep() { bump(); }
  view { button(on:click = { deep(); }) { text n; } }
}`, target, { document, policy: "open" });
  const before = handle.inspect().cycles;
  handle.call("deep");
  handle.flush();
  const after = handle.inspect();
  assert.ok(after.cycles > before, `cycles 增长：${before} → ${after.cycles}`);
  assert.ok(after.peakStack >= 1);
  assert.ok(after.peakFrames >= 1);
  assert.equal(after.nodes, 2, "button 与 text 两个受管节点");
  handle.unmount();
  assert.equal(handle.inspect().nodes, 0, "卸载后节点账目归零");
});

test("every-timer cadence is clamped by the policy floor", () => {
  const { document, target } = createDOM();
  const entries = [];
  const handle = JLC.mount(String.raw`app Tick {
  state n = 0;
  action start() { every (1) { n += 1; } }
  view { text n; }
}`, target, {
    document,
    policy: { profile: "open", frameMinIntervalMs: 50, audit: (entry) => entries.push(entry) },
  });
  handle.call("start");
  assert.equal(handle.inspect().timers, 1);
  assert.ok(entries.some((entry) => entry.action === "clamp" && /50ms/.test(entry.message ?? "")), JSON.stringify(entries));
  handle.unmount();
});

test("host interfaces can be revoked per instance", () => {
  const { document, target } = createDOM();
  const source = String.raw`app Host {
  resource feed = http("/api/feed");
  action go() { navigate("/next"); }
  action shout() { emit("ping", { a: 1 }); }
  action name() { title("T"); }
  view { p { text bool(feed.loading); } }
}`;
  const program = JLC.compile(source);
  const keys = program.module.requirements.map((item) => item.key);
  assert.ok(keys.includes("host:http") && keys.includes("host:navigate") && keys.includes("host:title"));

  const fetch_ = async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({}) });
  const denial = captureThrow(() => program.mount(target, {
    document,
    fetch: fetch_,
    policy: { profile: "open", allowNetwork: false, allowNavigation: false, allowDocumentTitle: false },
  }));
  assert.match(denial.message, /allowNavigation = false/);
  assert.match(denial.message, /allowNetwork = false/);

  const partial = program.mount(target, {
    document,
    fetch: fetch_,
    policy: { profile: "open", allowNetwork: false, allowNavigation: true, allowDocumentTitle: false },
    fault: "degrade",
  });
  assert.equal(target.querySelector("p").textContent, "false", "resource 直接判为不可用而不是卡死");
  partial.call("go");
  partial.flush();
  assert.equal(target.ownerDocument.defaultView.location.pathname, "/next", "没被收回的路由照常工作");
  partial.call("name");
  assert.equal(document.title, "", "title 被收回");
  assert.ok(partial.describe().denied.some((item) => item.detail === "http"));
  assert.ok(partial.describe().denied.some((item) => item.detail === "title"));
  partial.unmount();
});

test("capability allowlist turns host functions off without touching the app", () => {
  const { document, target } = createDOM();
  const calls = [];
  const capabilities = {
    audit: (message) => { calls.push(message); return message; },
    sideeffect: (message) => { calls.push(`side:${message}`); return null; },
  };
  const source = String.raw`app Cap {
  action run() { audit("hello"); sideeffect("boom"); }
  view { text string(audit("x")); }
}`;
  const program = JLC.compile(source);
  const granted = program.mount(target, { document, capabilities, policy: "open" });
  granted.call("run");
  assert.deepEqual(calls, ["x", "hello", "side:boom"], "视图先求值，再点按钮");
  granted.unmount();

  calls.length = 0;
  const limited = program.mount(target, {
    document,
    capabilities,
    policy: { profile: "open", capabilityAllowlist: ["audit"] },
    fault: "degrade",
  });
  limited.call("run");
  assert.deepEqual(calls, ["x", "hello"], "未列入白名单的 capability 不会被调用");
  assert.ok(limited.describe().denied.some((item) => item.kind === "capability" && item.detail === "sideeffect"));
  limited.unmount();
});

/* ------------------------------------------------------------------
 * 6. ABI、回归与数据模型修复
 * ------------------------------------------------------------------ */

test("bytecode ABI is versioned and refuses unknown containers", () => {
  assert.equal(ABI_VERSION, "jlc-abi/2");
  assert.equal(BYTECODE_VERSION, 2);
  const bytes = JLC.serialize('app V { state a = 1; view { text string(a); } }');
  assert.equal(loadModule(bytes).version, 2);

  const tooNew = Uint8Array.from(bytes);
  tooNew[5] = 3;
  assert.throws(() => loadModule(tooNew), (error) => error instanceof JLCVerifyError && /jlc-abi\/2/.test(error.message));

  // v1 容器（没有清单段）照样被静态审计
  const legacy = cloneModule(JLC.compile('app L { view { iframe(srcdoc = "x"); } }').module, { version: 1, declaredRequirements: undefined });
  verifyModule(legacy, "legacy");
  assert.ok(legacy.requirements.some((item) => item.key === "frame:iframe"));
});

test("the disassembler reports the manifest so tooling can diff permissions", () => {
  const program = JLC.compile('app D { view { iframe(srcdoc = "x"); my-el(); } }');
  const text = program.disassemble();
  assert.match(text, /abi jlc-abi\/2/);
  assert.match(text, /\.requires/);
  assert.match(text, /frame:iframe/);
  assert.match(text, /tag:my-el/);
});

test("?? compiles to a real jump instead of NOP garbage (0.2 regression)", () => {
  const program = JLC.compile(String.raw`app Coalesce {
  state a = null;
  state b = 7;
  state list = ["x"];
  derive shown = a ?? b;
  action pick(index) { a = at(list, index) ?? "none"; }
  view { p { text string(shown); } }
}`);
  assert.match(program.disassemble(), /JUMP_IF_NONNULL/);

  const { document, target } = createDOM();
  const handle = program.mount(target, { document });
  assert.equal(target.querySelector("p").textContent, "7");
  handle.call("pick", 0);
  handle.flush();
  assert.equal(target.querySelector("p").textContent, "x");
  handle.call("pick", 9);
  handle.flush();
  assert.equal(target.querySelector("p").textContent, "none");
  handle.unmount();
});

test("data model fixes: sparse write, Map/Set, parseJson and non-signal reads", () => {
  const { document, target } = createDOM();
  const handle = JLC.mount(String.raw`app Data {
  state rows = [1];
  action grow() { rows[3] = 9; }
  view { text string(len(rows)); }
}`, target, { document });
  handle.call("grow");
  handle.flush();
  assert.deepEqual(handle.get("rows"), [1, null, null, 9], "越界下标补 null，不留空洞");
  assert.equal(target.textContent, "4");
  assert.deepEqual(handle.get("grow"), { kind: "action", name: "grow" }, "读取 action 得到描述符而不是抛错");
  handle.unmount();

  const parseHandle = JLC.compile(String.raw`app Json {
  action bad() { let x = parseJson("{oops"); }
  view { text "x"; }
}`).mount(target, { document });
  assert.match(captureThrow(() => parseHandle.call("bad")).message, /parseJson 解析失败/);
  parseHandle.unmount();

  const shaped = JLC.compile(String.raw`app Shape {
  state box = { };
  action fill(value) { box = value; }
  view { text json(box); }
}`).mount(target, { document });
  shaped.call("fill", new Map([["a", 1], ["b", new Set([1, 2])]]));
  shaped.flush();
  assert.equal(target.textContent, '{"a":1,"b":[1,2]}', "Map/Set 显式转换成数据而不是静默变空对象");
  shaped.unmount();
});

test("a throwing effect no longer strands the rest of its batch", () => {
  const { document, target } = createDOM();
  const errors = [];
  const handle = JLC.mount(String.raw`app Stranded {
  state boom = 0;
  state safe = 0;
  derive risky = number(boom) + 1;
  action trip() { boom += 1; safe += 1; }
  view {
    p { text string(safe); }
    em { text string(risky); }
  }
}`, target, { document, onError: (error) => errors.push(error.message) });
  assert.equal(target.querySelector("p").textContent, "0");
  handle.call("trip");
  handle.flush();
  assert.equal(target.querySelector("p").textContent, "1", "同批次里其它 effect 仍然更新");
  handle.unmount();
});

test("window-event delegation is a grantable interface, not a syntax error", () => {
  const { document, target } = createDOM();
  const source = String.raw`app Win {
  state width = 0;
  view { p(on:resize.window = { width += 1; }) { text string(width); } }
}`;
  const program = JLC.compile(source);
  assert.ok(program.module.requirements.some((item) => item.key === "window:event"));
  const handle = program.mount(target, { document, policy: "open" });
  target.ownerDocument.defaultView.dispatchEvent(new FakeEvent("resize"));
  handle.flush();
  assert.equal(target.querySelector("p").textContent, "1");
  assert.ok(handle.inspect().listeners >= 2, "window 监听与 popstate 都在账上");
  handle.unmount();
  assert.equal(handle.inspect().listeners, 0);

  assert.throws(
    () => program.mount(target, { document, policy: "strict" }),
    /allowWindowEvents = false/,
  );
});

test("mount options and kernel defaults merge into one policy report", () => {
  const kernel = createVMKernel({ policy: "open", maxTotalSteps: 10, isolation: "strict" });
  const { document, target } = createDOM();
  const handle = kernel.mount(JLC.compile('app K { state a = 1; view { text string(a); } }'), target, { document });
  const report = handle.policy();
  assert.equal(report.profile, "open");
  assert.equal(report.isolation, "strict");
  assert.equal(report.quotas.maxTotalSteps, 10);
  assert.equal(report.abi, ABI_VERSION);
  assert.equal(report.styleScoping, "prefix");
  handle.unmount();
  assert.equal(handle.policy().profile, "open", "卸载后仍要能出示当时的策略（事后审计）");
  assert.equal(JLC.policies().length, 3);
});
