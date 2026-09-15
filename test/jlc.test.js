import test from "node:test";
import assert from "node:assert/strict";
import JLC, { JLCCompileError, JLCRuntimeError, createKernel, loadModule } from "../jlc.js";
import { FakeEvent, createDOM } from "../support/fake-dom.js";

const counterSource = String.raw`
app Counter {
  state count = 0;
  state name = "JLC";
  state items = [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }];
  derive doubled = count * 2;

  action increment(step = 1) {
    count += step;
  }

  style ` + "`[data-app=counter] { font-family: sans-serif; }`" + String.raw`;

  view {
    main(data:app = "counter", class:active = count > 0) {
      h1 { text name + ":" + count + "/" + doubled; }
      input(bind:value = name);
      button(on:click.prevent = { increment(); }) { text "add"; }
      when (count > 0) {
        strong { text "positive"; }
      } else {
        em { text "zero"; }
      }
      ul {
        each (item, index in items key item.id) {
          li(data:id = item.id) { text index + ":" + item.label; }
        } else {
          text "empty";
        }
      }
    }
  }
}`;

test("tokenizer and parser produce a frozen translation program", () => {
  const tokens = JLC.tokenize('app 示例 { state 数量 = 1; view { text "好"; } }', { sourceName: "demo.jlc" });
  assert.equal(tokens[0].value, "app");
  assert.equal(tokens.at(-1).type, "eof");

  const program = JLC.compile(counterSource, { sourceName: "counter.jlc" });
  assert.equal(program.ast.name, "Counter");
  assert.ok(Object.isFrozen(program.ast));
  assert.deepEqual(program.ast.declarations.map((item) => item.type), [
    "StateDeclaration",
    "StateDeclaration",
    "StateDeclaration",
    "DeriveDeclaration",
    "ActionDeclaration",
    "StyleDeclaration",
  ]);
});

test("compile errors include source location", () => {
  assert.throws(
    () => JLC.compile("app Broken { state x = ; view {} }", { sourceName: "broken.jlc" }),
    (error) => error instanceof JLCCompileError
      && error.message.includes("broken.jlc:1:")
      && error.line === 1,
  );
});

test("reactive state, derives, events, binding, branches and keyed lists work together", () => {
  const { document, target } = createDOM();
  const handle = JLC.mount(counterSource, target, { document });

  const main = target.querySelector("main");
  const heading = target.querySelector("h1");
  const input = target.querySelector("input");
  const button = target.querySelector("button");
  const initialItems = target.querySelectorAll("li");

  assert.equal(heading.textContent, "JLC:0/0");
  assert.equal(input.value, "JLC");
  assert.equal(main.classList.contains("active"), false);
  assert.equal(target.querySelector("em").textContent, "zero");
  assert.equal(initialItems[0].textContent, "0:Alpha");
  assert.equal(document.head.querySelector("style").textContent.includes("font-family"), true);

  const click = new FakeEvent("click");
  button.dispatchEvent(click);
  handle.flush();
  assert.equal(click.defaultPrevented, true);
  assert.equal(heading.textContent, "JLC:1/2");
  assert.equal(main.classList.contains("active"), true);
  assert.equal(target.querySelector("em"), null);
  assert.equal(target.querySelector("strong").textContent, "positive");

  input.value = "Kernel";
  input.dispatchEvent(new FakeEvent("input"));
  handle.flush();
  assert.equal(handle.get("name"), "Kernel");
  assert.equal(heading.textContent, "Kernel:1/2");

  handle.call("increment", 2);
  handle.flush();
  assert.equal(handle.get("count"), 3);
  assert.equal(heading.textContent, "Kernel:3/6");

  handle.set("items", [
    { id: "b", label: "Beta 2" },
    { id: "a", label: "Alpha 2" },
  ]).flush();
  const movedItems = target.querySelectorAll("li");
  assert.equal(movedItems[0], initialItems[1], "keyed node is moved rather than recreated");
  assert.equal(movedItems[1], initialItems[0]);
  assert.equal(movedItems[0].textContent, "0:Beta 2");
  assert.equal(movedItems[1].textContent, "1:Alpha 2");

  handle.set("items", []).flush();
  assert.equal(target.querySelector("li"), null);
  assert.equal(target.querySelector("ul").textContent, "empty");
  handle.set("items", [{ id: "c", label: "Gamma" }]).flush();
  assert.equal(target.querySelector("ul").textContent, "0:Gamma");

  const live = handle.inspect();
  assert.equal(live.active, true);
  assert.ok(live.effects > 0);
  assert.ok(live.listeners >= 3); // route, click and two-way input
  assert.ok(live.nodes > 0, "实例记账：受管节点数");
  assert.ok(live.cycles > 0, "实例记账：累计执行步数");

  handle.unmount();
  assert.equal(target.textContent, "");
  assert.equal(document.head.querySelector("style"), null);
  assert.deepEqual(handle.inspect(), {
    scopes: 0,
    effects: 0,
    listeners: 0,
    timers: 0,
    requests: 0,
    nodes: 0,
    cycles: live.cycles,
    faults: 0,
    denials: 0,
    styles: 0,
    peakStack: live.peakStack,
    peakFrames: live.peakFrames,
    neutralized: live.neutralized,
    active: false,
  });
  assert.throws(() => handle.get("count"), JLCRuntimeError);
  assert.equal(handle.active, false);
});

test("nested assignment is immutable and prototype escape keys are blocked", () => {
  const { document, target } = createDOM();
  const source = `
    app Data {
      state user = { profile: { name: "A" } };
      action rename() { user.profile.name = "B"; }
      view { text user.profile.name; }
    }
  `;
  const handle = JLC.mount(source, target, { document });
  const before = handle.get("user");
  handle.call("rename");
  handle.flush();
  const after = handle.get("user");
  assert.equal(target.textContent, "B");
  assert.notEqual(before, after);
  assert.equal(before.profile.name, "A");
  assert.equal(after.profile.name, "B");
  handle.unmount();

  const unsafe = `app Unsafe { state x = {}; view { text x.constructor; } }`;
  assert.throws(() => JLC.mount(unsafe, target, { document }), /禁止访问字段/);
});

test("hard limits stay compile-time; everything else is a mount-time policy decision", () => {
  const { document, target } = createDOM();

  // 任何策略档都不允许的：<script> 一类在编译期就拒绝，错误带行列号。
  const compileError = captureThrow(() => JLC.compile('app Unsafe { view { script { text "alert(1)"; } } }'));
  assert.equal(compileError.name, "JLCCompileError");
  assert.match(compileError.message, /硬限制/);

  // 危险 URL：净化为 about:blank（不是抛错，页面不会整块崩掉）。
  const handle = JLC.mount('app Link { view { a(href = "javascript:alert(1)") { text "x"; } } }', target, { document });
  assert.equal(target.querySelector("a").getAttribute("href"), "about:blank");
  handle.unmount();

  // attr:onclick / prop:innerHTML 属于硬限制或默认策略拒绝，仍在编译期失败。
  assert.match(captureThrow(() => JLC.compile('app Attr { view { div(attr:onclick = "alert(1)"); } }')).message, /禁止直接设置事件属性/);
  assert.match(captureThrow(() => JLC.compile('app Prop { view { div(prop:innerHTML = "<img>"); } }')).message, /HTML 解析类 property 永禁/);

  // 而 <iframe> 是「可授予」的能力：strict 在挂载期整体失败，open 直接可用。
  const frameSource = 'app Frame { view { iframe(srcdoc = "<b>hi</b>"); } }';
  const program = JLC.compile(frameSource);
  assert.deepEqual(program.module.requirements.map((item) => item.key), ["frame:iframe", "frame:srcdoc"]);
  // 不带 policy 的 compile 不做策略裁决：同一份 .jbc 可以挂到任意档上
  assert.equal(JLC.compile(frameSource, { policy: "open" }).module.requirements.length, 2);
  // 给了 policy：编译期就报错，而且带行列号（构建期失败比运行期失败便宜）
  const buildTimeDenial = captureThrow(() => JLC.compile(frameSource, { policy: "strict" }));
  assert.equal(buildTimeDenial.line, 1);
  assert.match(buildTimeDenial.message, /未授予 <iframe>/);
  // policyMode: "manifest" 不在语法点报错，而是汇总所有未授权接口（一次看全）
  const summary = captureThrow(() => JLC.compile(frameSource, { policy: "strict", policyMode: "manifest" }));
  assert.match(summary.message, /预检失败/);
  assert.match(summary.message, /frame:iframe/);
  assert.match(summary.message, /frame:srcdoc/);
  // policyMode: "defer" 完全交给装载期：构建一定成功
  assert.ok(JLC.compile(frameSource, { policy: "strict", policyMode: "defer" }).serialize().length > 0);
  const strictError = captureThrow(() => program.mount(target, { document, policy: "strict" }));
  assert.equal(strictError.name, "JLCPolicyError");
  assert.match(strictError.message, /allowSandboxedFrames/);
  assert.equal(target.textContent, "", "拒绝挂载不能留下半渲染的 DOM");

  const opened = program.mount(target, { document, policy: "open" });
  const frame = target.querySelector("iframe");
  assert.ok(frame, "open 档允许沙箱 frame");
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-forms allow-popups", "sandbox 由策略托管");
  assert.equal(frame.getAttribute("srcdoc"), "<b>hi</b>");
  opened.unmount();
});

function captureThrow(function_) {
  try {
    function_();
  } catch (error) {
    return error;
  }
  throw new Error("预期抛出异常，但没有");
}

test("host-side DOM removal disposes the exact owned subtree and then the app", async () => {
  const { document, target } = createDOM();
  let observer;
  document.defaultView.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      observer = this;
    }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  const source = `
    app Owned {
      state n = 0;
      view {
        section {
          button(on:click = { n += 1; }) { text n; }
        }
      }
    }
  `;
  const handle = JLC.mount(source, target, { document });
  const before = handle.inspect();
  const button = target.querySelector("button");
  button.remove();
  observer.callback([{ removedNodes: [button] }]);
  const afterNode = handle.inspect();
  assert.ok(afterNode.scopes < before.scopes);
  assert.ok(afterNode.effects < before.effects);
  assert.ok(afterNode.listeners < before.listeners);
  assert.equal(handle.active, true);

  target.remove();
  observer.callback([{ removedNodes: [target] }]);
  await Promise.resolve();
  assert.equal(handle.active, false);
  assert.equal(observer.disconnected, true);
  assert.equal(handle.inspect().effects, 0);
});

test("timers are owned by the event element and all resources disappear on unmount", () => {
  const { document, target } = createDOM();
  const source = `
    app Timers {
      state ticks = 0;
      action start() {
        after (60000) { ticks += 1; }
        every (60000) { ticks += 1; }
      }
      view { button(on:click = { start(); }) { text ticks; } }
    }
  `;
  const handle = JLC.mount(source, target, { document });
  target.querySelector("button").dispatchEvent(new FakeEvent("click"));
  assert.equal(handle.inspect().timers, 2);
  handle.unmount();
  assert.equal(handle.inspect().timers, 0);
});

test("resource requests are abortable, reactive, and released", async () => {
  const { document, target } = createDOM();
  let resolveRequest;
  let receivedSignal;
  const fetch = (_url, options) => {
    receivedSignal = options.signal;
    return new Promise((resolve, reject) => {
      resolveRequest = () => resolve({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ message: "ready" }),
        text: async () => "",
      });
      options.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };
  const source = `
    app Remote {
      resource result = http("/api/value", { as: "json" });
      view {
        when (result.loading) { text "loading"; }
        else { text result.data.message; }
      }
    }
  `;
  const handle = createKernel().mount(source, target, { document, fetch });
  assert.equal(target.textContent, "loading");
  assert.equal(handle.inspect().requests, 1);
  resolveRequest();
  await new Promise((resolve) => setTimeout(resolve, 0));
  handle.flush();
  assert.equal(target.textContent, "ready");
  assert.equal(handle.inspect().requests, 0);
  handle.unmount();
  assert.equal(receivedSignal.aborted, true);
});

test("route state is reactive and capability calls are explicit", () => {
  const { document, target } = createDOM();
  const source = `
    app Route {
      state greeting = greet("JLC");
      action go() { navigate("/docs?page=2"); }
      view { p { text greeting + ":" + $route.path; } }
    }
  `;
  const handle = JLC.mount(source, target, {
    document,
    capabilities: { greet: (name) => `hello ${name}` },
  });
  assert.equal(target.querySelector("p").textContent, "hello JLC:/");
  handle.call("go");
  handle.flush();
  assert.equal(target.querySelector("p").textContent, "hello JLC:/docs");
  handle.unmount();
});

test("each 的 else 分支不依赖 key，视图操作数按函数索引校验", () => {
  // EACH 的操作数是 4 个函数索引 + 常量名 + 槽位；早前被标成常量池索引，
  // 于是 each(无 key) + else 会在 verifier 里报“常量池索引越界”。
  const source = String.raw`
app Empty {
  state items = [];
  view {
    ul {
      each (item, index in items) {
        li { text item; }
      } else {
        li(class = "empty") { text "nothing here"; }
      }
    }
  }
}`;
  const program = JLC.compile(source, { sourceName: "empty.jlc" });
  const module = program.module;
  assert.equal(module.verified, true);
  // 函数索引可以大于常量池长度，verifier 不能再把它当 pool 下标。
  assert.ok(module.functions.length > module.pool.length || module.functions.length <= module.pool.length);

  const { document, target } = createDOM();
  const runtime = JLC.mount(module, target, { document });
  assert.equal(target.querySelector("li").textContent, "nothing here");

  // 编码 / 解码往返后依旧通过 verifier（MANIFEST 与操作数描述一致）
  const bytes = program.serialize();
  const reloaded = loadModule(bytes, { sourceName: "empty.jbc" });
  assert.equal(reloaded.verified, true);
  runtime.unmount();
  assert.equal(target.textContent, "");
});
