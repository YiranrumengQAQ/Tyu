import test from "node:test";
import assert from "node:assert/strict";
import JLC, { JLCCompileError, JLCRuntimeError, createKernel } from "../jlc.js";
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

  handle.unmount();
  assert.equal(target.textContent, "");
  assert.equal(document.head.querySelector("style"), null);
  assert.deepEqual(handle.inspect(), {
    scopes: 0,
    effects: 0,
    listeners: 0,
    timers: 0,
    requests: 0,
    active: false,
  });
  assert.throws(() => handle.get("count"), JLCRuntimeError);
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

test("unsafe executable tags and URL schemes are stopped without innerHTML", () => {
  const { document, target } = createDOM();
  assert.throws(
    () => JLC.mount('app Unsafe { view { script { text "alert(1)"; } } }', target, { document }),
    /安全模式禁止创建/,
  );

  const handle = JLC.mount('app Link { view { a(href = "javascript:alert(1)") { text "x"; } } }', target, { document });
  assert.equal(target.querySelector("a").getAttribute("href"), "about:blank");
  handle.unmount();

  assert.throws(
    () => JLC.mount('app Attr { view { div(attr:onclick = "alert(1)"); } }', target, { document }),
    /禁止直接设置事件属性/,
  );
  assert.throws(
    () => JLC.mount('app Prop { view { div(prop:innerHTML = "<img>"); } }', target, { document }),
    /安全模式禁止设置 DOM property/,
  );
});

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
