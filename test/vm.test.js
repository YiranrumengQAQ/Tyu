import test from "node:test";
import assert from "node:assert/strict";
import JLC, {
  JLCCompileError,
  JLCRuntimeError,
  JLCVerifyError,
  OP,
  OP_SPEC,
  loadModule,
  verifyModule,
  encodeModule,
  disassembleModule,
} from "../jlc.js";
import { JLCVM, createVMKernel } from "../jlc-vm.js";
import { FakeEvent, createDOM } from "../support/fake-dom.js";

const counterSource = String.raw`
app Counter {
  state count = 0;
  state items = [1, 2, 3];
  derive doubled = count * 2;
  action add(step = 1) {
    count += step;
  }
  action reset() {
    let total = 0;
    for (item, index in items) {
      total += item;
    }
    count = total;
  }
  view {
    main {
      button(on:click.prevent = { add(); }) { text "+1"; }
      strong { text "count=" + count + "/doubled=" + doubled; }
      when (count > 10) { text "big"; } else { text "small"; }
      ul {
        each (item, index in items key item) {
          li { text index + ":" + item; }
        }
      }
    }
  }
}`;

test("compiler emits a verifiable bytecode module with pool, globals and functions", () => {
  const program = JLC.compile(counterSource, { sourceName: "counter.jlc" });
  const module = program.module;

  assert.equal(module.format, "jlc-bytecode");
  assert.equal(module.app, "Counter");
  assert.ok(module.verified);
  assert.deepEqual(module.globalRefs, ["count", "items", "add", "doubled"]);
  const kinds = Object.fromEntries(module.functions.map((func) => [func.name, func.kind]));
  assert.equal(kinds["state:count"], "expr");
  assert.equal(kinds["derive:doubled"], "expr");
  assert.equal(kinds["action:add"], "body");
  assert.equal(kinds["action:reset"], "body");
  assert.equal(kinds["view"], "view");
  assert.ok(module.functions.every((func) => func.maxStack > 0 || func.kind === "view"));
  const text = disassembleModule(module);
  assert.match(text, /\.function action:add/);
  assert.match(text, /GET_GLOBAL +global\[\d+\] count/);
  assert.match(text, /ELEM +pool\[\d+\] "main"/);
  assert.match(text, /\.view fn#\d+/);
});

test("serialize → load round-trip is byte-exact and re-verifies", () => {
  const program = JLC.compile(counterSource, { sourceName: "counter.jlc" });
  const first = program.serialize();
  const loaded = loadModule(first, { sourceName: "loader-side.jbc" });
  const second = encodeModule(loaded);
  assert.deepEqual([...first], [...second]);
  assert.equal(loaded.app, "Counter");
  // 内嵌的编译期 sourceName 是权威来源
  assert.equal(loaded.sourceName, "counter.jlc");
  assert.ok(Object.isFrozen(loaded));
  assert.throws(() => loadModule(new Uint8Array([1, 2, 3]), {}), JLCVerifyError);
  assert.throws(() => loadModule(first.subarray(0, 20), {}), JLCVerifyError);
});

test("bytecode verifier rejects tampered modules", () => {
  const program = JLC.compile(counterSource);
  const bytes = program.serialize();

  // 1. 篡改魔数
  const badMagic = Uint8Array.from(bytes);
  badMagic[0] = 0x00;
  assert.throws(() => loadModule(badMagic, {}), /魔数不匹配/);

  // 2. 未知操作码
  const viewFunc = program.module.functions[program.module.view];
  const tampered = {
    ...program.module,
    verified: false,
    functions: program.module.functions.map((func, index) => index === program.module.view
      ? { ...func, code: Uint8Array.from([0xfe, ...func.code.slice(1), OP.RETURN_NULL]) }
      : func),
  };
  assert.throws(() => verifyModule(tampered, "tampered"), /未知操作码 0xfe/);
  assert.ok(bytes.length > 0);

  // 3. 视图函数出现计算指令（类型不符）
  const wrongKind = {
    ...program.module,
    verified: false,
    functions: program.module.functions.map((func, index) => index === program.module.view
      ? { ...func, code: Uint8Array.from([OP.CONST_INT, 0, 0, 0, 1, OP.RETURN_NULL]) }
      : func),
  };
  assert.throws(() => verifyModule(wrongKind, "wrong-kind"), /不允许出现在 view 函数中/);

  // 4. ELEM/ELEM_END 失配
  const unbalanced = {
    ...program.module,
    verified: false,
    functions: program.module.functions.map((func, index) => index === program.module.view
      ? { ...func, code: Uint8Array.from([OP.ELEM_END, OP.RETURN_NULL]) }
      : func),
  };
  assert.throws(() => verifyModule(unbalanced, "unbalanced"), /ELEM_END 没有匹配的 ELEM/);

  // 5. 表达式函数出口栈深度错误（空函数）
  const emptyExpr = {
    ...program.module,
    verified: false,
    functions: program.module.functions.map((func, index) => index === 0
      ? { ...func, kind: "expr", code: new Uint8Array(0) }
      : func),
  };
  assert.throws(() => verifyModule(emptyExpr, "empty-expr"), /函数出口栈深度为 0，应为 1/);

  // 6. 跳转目标落在指令中间
  const source = "app T { action a() { if (1 > 0) { let x = 1; } } view { text \"x\"; } }";
  const good = JLC.compile(source).module;
  const badJump = {
    ...good,
    verified: false,
    functions: good.functions.map((func) => {
      if (func.name !== "action:a") return func;
      const code = Uint8Array.from(func.code);
      // 把第一个 JUMP_IF_FALSE 的目标改成落进操作数中间
      const jumpIndex = [...code].indexOf(OP.JUMP_IF_FALSE);
      code[jumpIndex + 1] = 0;
      code[jumpIndex + 2] = 2; // 落在 JUMP_IF_FALSE 自身操作数字节上
      return { ...func, code };
    }),
  };
  assert.throws(() => verifyModule(badJump, "bad-jump"), /落在指令中间|操作数栈深度不一致/);

  // 7. 池索引越界
  const badPool = {
    ...program.module,
    verified: false,
    functions: program.module.functions.map((func, index) => index === 0
      ? { ...func, code: Uint8Array.from([OP.CONST, 0xff, 0xff, OP.RETURN]) }
      : func),
  };
  assert.throws(() => verifyModule(badPool, "bad-pool"), /常量池索引越界/);
});

test("slim VM kernel mounts .jbc without any compiler code", () => {
  const bytes = JLC.serialize(counterSource, { sourceName: "counter.jlc" });
  const { document, target } = createDOM();

  assert.throws(() => JLCVM.compile("app X { view {} }"), /VM 内核不包含编译器/);
  assert.throws(() => JLCVM.mount("app X { view {} }", target, { document }), /只能挂载字节码模块/);

  const handle = JLCVM.mount(bytes, target, { document });
  assert.equal(handle.name, "Counter");
  assert.equal(target.querySelector("strong").textContent, "count=0/doubled=0");
  assert.equal(target.querySelector("em, .x"), null);

  target.querySelector("button").dispatchEvent(new FakeEvent("click"));
  handle.flush();
  assert.equal(target.querySelector("strong").textContent, "count=1/doubled=2");

  handle.call("reset"); handle.flush();
  assert.equal(target.querySelector("strong").textContent, "count=6/doubled=12");
  assert.deepEqual([...target.querySelectorAll("li")].map((li) => li.textContent), ["0:1", "1:2", "2:3"]);

  handle.set("items", [4, 5]).flush();
  assert.deepEqual([...target.querySelectorAll("li")].map((li) => li.textContent), ["0:4", "1:5"]);
  handle.unmount();
  assert.equal(handle.inspect().active, false);

  // 同一份字节码可以在另一个独立 VM 实例上再次挂载
  const secondKernel = createVMKernel();
  const { document: doc2, target: target2 } = createDOM();
  const handle2 = secondKernel.mount(loadModule(bytes), target2, { document: doc2 });
  handle2.call("add", 100); handle2.flush();
  assert.equal(target2.querySelector("strong").textContent, "count=100/doubled=200");
  handle2.unmount();
});

test("inline base64 <script type=text/jbc> boots without compilation", async () => {
  const bytes = JLC.serialize("app Tiny { state n = 7; view { text \"n=\" + n; } }");
  const b64 = Buffer.from(bytes).toString("base64");
  const { document, target } = createDOM();
  const script = document.createElement("script");
  script.setAttribute("type", "text/jbc");
  script.setAttribute("data-target", "#boot-target");
  script.textContent = b64;
  const mountPoint = document.createElement("div");
  mountPoint.setAttribute("id", "boot-target");
  document.body.appendChild(script);
  document.body.appendChild(mountPoint);

  const [handle] = await JLC.boot(document);
  assert.equal(mountPoint.textContent, "n=7");
  handle.unmount();
});

test("optimizer folds constants and removes dead pure statements", () => {
  const program = JLC.compile(String.raw`
    app Opt {
      state x = 1 + 2 * 3;
      derive big = (4 + 4) * 2 > 15 ? "yes" : "no";
      action noop() {
        1 + 2;
        let keep = "kept";
        if (false) { keep = "never"; }
        x = keep;
      }
      view {
        when (true) { text "always"; } else { text "never"; }
        text x;
      }
    }
  `);
  const text = program.disassemble();
  // 1 + 2 * 3 折叠成 7
  assert.doesNotMatch(text, /MUL/);
  assert.match(text, /CONST_INT +7/);
  // 死代码：纯表达式语句被移除
  const noop = program.module.functions.find((func) => func.name === "action:noop");
  const noopText = disassembleModule({ ...program.module, functions: [noop] });
  assert.match(noopText, /CONST +pool\[\d+\] "kept"/);
  // when (true) 折叠：只剩 always 分支，无 WHEN 指令
  const view = program.module.functions[program.module.view];
  assert.ok(![...view.code].includes(OP.WHEN));
  assert.ok(text.includes('"always"'));
  assert.ok(!text.includes('"never"'));
});

test("safety checks: hard limits at compile time, policy at load time", () => {
  assert.throws(() => JLC.compile('app A { view { script { text "x"; } } }'), JLCCompileError);
  assert.throws(() => JLC.compile('app A { view { div(prop:innerHTML = "x"); } }'), /HTML 解析类 property 永禁/);
  assert.throws(() => JLC.compile('app A { view { div(attr:onclick = "x"); } }'), /禁止直接设置事件属性/);
  assert.throws(() => JLC.compile('app A { view { button(on:click.wat = { }); } }'), /未知的事件修饰符/);
  assert.throws(() => JLC.compile('app A { action a() { let x = 1; let x = 2; } view {} }'), /重复定义/);
  assert.throws(() => JLC.compile('app A { action a() { for (x in [1]) { x = 2; } } view {} }'), /不可赋值/);
  assert.throws(() => JLC.compile("app A { derive d = 1; action a() { d = 2; } view {} }"), /只读状态/);
  assert.throws(() => JLC.compile('app A { view { input(bind:enabled = 1); } }'), /bind 仅支持/);
  // 拒绝把受限名字当赋值目标
  assert.throws(() => JLC.compile("app A { action a() { $route = 1; } view {} }"), /只读状态/);
  assert.throws(() => JLC.compile("app A { action a() { len = 1; } view {} }"), /不可赋值/);
});

test("local variables, object mutation and timer captures work on the stack machine", async () => {
  const { document, target } = createDOM();
  const handle = JLC.mount(String.raw`
    app Locals {
      state log = "";
      action run() {
        let box = { count: 1 };
        box.count += 1;
        box.extra = "x";
        log = json(box);
        after (20) {
          let captured = box.count;
          count(captured);
        }
      }
      action count(value) { log = log + ":" + value; }
      view { text log; }
    }
  `, target, { document });
  handle.call("run");
  handle.flush();
  assert.equal(handle.get("log"), '{"count":2,"extra":"x"}');
  await new Promise((resolve) => setTimeout(resolve, 60));
  handle.flush();
  assert.equal(handle.get("log"), '{"count":2,"extra":"x"}:2');
  handle.unmount();
});

test("step and loop limits still guard the VM", () => {
  const { document, target } = createDOM();
  const handle = JLC.mount(`
    app Loop {
      state n = 0;
      action spin() {
        for (i in range(0, 5000)) { n += 1; }
      }
      view { text n; }
    }
  `, target, { document, maxSteps: 3000 });
  assert.throws(() => handle.call("spin"), /步数超限/);
  handle.unmount();

  const handle2 = JLC.mount(`
    app Loop2 {
      state n = 0;
      state big = [];
      action spin() { for (i in big) { n += 1; } }
      view { text n; }
    }
  `, target, { document, maxLoop: 50 });
  handle2.set("big", Array.from({ length: 100 }, (_, index) => index));
  assert.throws(() => handle2.call("spin"), /项目数超限/);
  handle2.unmount();
});

test("deep action recursion is bounded", () => {
  const { document, target } = createDOM();
  const handle = JLC.mount(`
    app Rec {
      action loop() { loop(); }
      view { text "x"; }
    }
  `, target, { document });
  assert.throws(() => handle.call("loop"), /调用深度超过 100/);
  handle.unmount();
});

test("opcode table is dense and documented", () => {
  assert.equal(OP.NOP, 0x00);
  assert.equal(OP.CONST, 0x01);
  assert.equal(OP.CONST_INT, 0x02);
  assert.ok(OP_SPEC[OP.CALL].operands === "B");
  assert.ok(OP_SPEC[OP.EACH].operands.length === 8);
});

test("JLCVM.disassemble and opcode-keyed OP_SPEC (inspector panel APIs)", async () => {
  const { JLCVM, loadModule } = await import("../jlc-vm.js");
  const facade = await import("../jlc.js");
  const source = `app Tiny { state n = 1 + 2; action bump() { n += 1; } view { text n; } }`;
  const program = facade.default.compile(source, { sourceName: "tiny.jlc" });
  const bytes = program.serialize();

  // VM 内核可以反汇编模块/程序/二进制
  const text = JLCVM.disassemble(loadModule(bytes));
  assert.ok(text.includes(".function"));
  assert.equal(JLCVM.disassemble(program), text);
  assert.equal(JLCVM.disassemble(bytes), text);

  // 门面导出按操作码数值索引的 OP_SPEC，可用于指令直方图
  const OP_SPEC = facade.OP_SPEC;
  const histogram = new Map();
  for (const func of program.module.functions) {
    for (const byte of func.code) {
      const spec = OP_SPEC?.[byte];
      assert.ok(spec && spec.name.length > 0);
      histogram.set(spec.name, (histogram.get(spec.name) ?? 0) + 1);
    }
  }
  assert.ok(histogram.size > 0);
  for (const count of histogram.values()) assert.ok(count > 0);
  // 常量折叠后 tiny.n 编译为 CONST_INT 3
  assert.equal(OP_SPEC[facade.OP.CONST_INT].name, "CONST_INT");
  assert.ok((histogram.get("CONST_INT") ?? 0) >= 1);
});

test("parser: 视图中空标签漏写分号或大括号自动闭合，无需抛出异常", () => {
  const source = `
    app SelfClose {
      state visible = true;
      view {
        div {
          span(class = "caret")
          when (visible) {
            span(class = "inner-caret")
          }
          hr
          button(class = "btn") { text "click"; }
        }
      }
    }
  `;
  const program = JLC.compile(source);
  const { document, target } = createDOM();
  const handle = program.mount(target, { document });
  assert.ok(target.querySelector(".caret"));
  assert.ok(target.querySelector(".inner-caret"));
  assert.ok(target.querySelector("hr"));
  assert.ok(target.querySelector(".btn"));
  handle.unmount();
});

test("builtins: indexOf, copy, scrollTo, storage 均开箱即用且无需外部注入", async () => {
  const { document, target, window } = createDOM();
  let clipboardText = "";
  window.navigator = {
    clipboard: {
      writeText: (t) => { clipboardText = t; return Promise.resolve(); }
    }
  };
  let scrolled = null;
  window.scrollTo = (opts) => { scrolled = opts; };
  const storageMap = new Map();
  window.localStorage = {
    getItem: (k) => storageMap.get(k) ?? null,
    setItem: (k, v) => storageMap.set(k, v),
  };

  const source = `
    app BuiltinsTest {
      state textIdx = indexOf("hello world", "world");
      state arrIdx = indexOf(["apple", "banana", "cherry"], "banana");
      state missingIdx = indexOf("abc", "z");
      state storedVal = null;
      state copied = false;

      action testOps() {
        copied = copy("copied message");
        scrollTo(0, 500);
        storage("user_theme", { mode: "dark", size: 14 });
        storedVal = storage("user_theme");
      }

      view {
        div {
          span(class = "t-idx") { text textIdx; }
          span(class = "a-idx") { text arrIdx; }
          span(class = "m-idx") { text missingIdx; }
          span(class = "stored") { text json(storedVal); }
        }
      }
    }
  `;

  const handle = JLC.mount(source, target, { document });
  assert.equal(target.querySelector(".t-idx").textContent, "6");
  assert.equal(target.querySelector(".a-idx").textContent, "1");
  assert.equal(target.querySelector(".m-idx").textContent, "-1");

  handle.call("testOps");
  handle.flush();

  assert.equal(clipboardText, "copied message");
  assert.deepEqual(scrolled, { left: 0, top: 500, behavior: "smooth" });
  assert.equal(handle.get("storedVal").mode, "dark");
  assert.equal(handle.get("storedVal").size, 14);
  assert.equal(target.querySelector(".stored").textContent, '{"mode":"dark","size":14}');
  handle.unmount();
});

test("timer tick wheel: 多个高频 every / after 统一批处理且无独立闭包泄漏", async () => {
  const { document, target } = createDOM();
  const source = `
    app TickWheelTest {
      state tickCount = 0;
      state timer1Done = false;
      state timer2Done = false;

      action start() {
        after (10) { timer1Done = true; }
        after (10) { timer2Done = true; }
        every (20) { tickCount = tickCount + 1; }
      }

      view {
        div {
          span(class = "count") { text tickCount; }
          span(class = "t1") { text bool(timer1Done); }
          span(class = "t2") { text bool(timer2Done); }
        }
      }
    }
  `;
  const handle = JLC.mount(source, target, { document });
  handle.call("start");
  assert.equal(handle.inspect().timers, 3);

  await new Promise((r) => setTimeout(r, 60));
  handle.flush();

  assert.equal(handle.get("timer1Done"), true);
  assert.equal(handle.get("timer2Done"), true);
  assert.ok(handle.get("tickCount") >= 1);
  assert.equal(handle.inspect().timers, 1); // 两个 after 已完成，仅剩 every

  handle.unmount();
  assert.equal(handle.inspect().timers, 0);
});
