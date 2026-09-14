# JLC Kernel

https://yiranrumengqaq.github.io/Tyu/

JLC（**Just-in-time Lifecycle Components**）是一门面向浏览器界面的自研语言。本仓库是它的
**编译器 + 字节码虚拟机**内核：源码被编译成紧凑的 JLC 字节码（`.jbc`），由一个类 JVM 的
栈式虚拟机验证、链接并执行为响应式 DOM。它不是 React/Vue/Svelte 的封装，也不依赖编译服务、
`eval` 或 `new Function`。

```text
JLC 源码 → Tokenizer → Parser → 优化器 → Code Generator ──→ .jbc 字节码
                                                              │
            jlc-vm.js：Verifier → Linker → 栈式 VM 调度循环 → DOM / Effects
```

> 当前版本：`0.2.0`，零运行时依赖，ES Module，可直接在现代浏览器运行。

## 两段式架构：编译一次，任意 VM 运行

编译（前端）与运行（后端）彻底解耦：

| 文件 | 角色 | 源码 | min+gzip* |
| --- | --- | --- | --- |
| `jlc.js` | 全量门面：编译器前端 + VM（开发用） | 5 KB | ~2 KB |
| `jlc-vm.js` | **仅运行时**：字节码验证器、链接器、调度循环、响应式核心 | 106 KB | ~24 KB |
| `jlc-compiler.js` | 仅编译器：Tokenizer + Parser + 优化器 + 代码生成 | 60 KB | ~13 KB |

\* 由粗粒度压缩脚本测得（去注释空白 + gzip -9），量级供参考。

生产部署可以只携带 `jlc-vm.js` 与 `.jbc` 文件——运行时**不包含 Tokenizer 与 Parser**，
接触不到 JLC 源码文本；源码 → 字节码的转化发生在构建期，产物是确定性二进制
（同一源码编译两次逐字节相同）。相比 0.1 的单体内核（19 KB min+gzip，编译器与运行时
不可拆分），VM 运行核在吸收验证器、序列化器与反汇编器之后约 24 KB min+gzip，
而 13 KB 的编译器前端从此只属于构建期——用户浏览器永远不必下载它。页面字节码产物
（`.jbc`）本身比等价源码小 20–30%（示例应用 10.2 KB → 8.0 KB，见下文实测）。

```js
// 构建期：编译 + 序列化
const program = JLC.compile(source, { sourceName: "counter.jlc" });
const bytes = program.serialize();          // .jbc 二进制（Uint8Array）
const b64 = btoa(String.fromCharCode(...bytes)); // 可内联进 <script type="text/jbc">

// 运行期（可以只在 jlc-vm.js 环境中）：
import { JLCVM, loadModule } from "./jlc-vm.js";
const app = JLCVM.mount(loadModule(bytes), "#app", { state: { count: 10 } });
app.call("add", 5); app.flush();
app.unmount();
```

页面还能直接引导字节码，完全不需要源码：

```html
<script type="text/jbc" data-target="#app">
SkxDQgABAAA…（base64 of .jbc）
</script>
```

## 30 秒上手

```html
<div id="app"></div>

<script type="text/jlc" data-target="#app">
app Counter {
  state count = 0;
  derive doubled = count * 2;

  action add(step = 1) {
    count += step;
  }

  style `
    .counter { display: flex; gap: 12px; align-items: center; }
    .hot { color: #e11d48; }
  `;

  view {
    main(class = "counter", class:hot = count >= 10) {
      button(on:click.prevent = { add(); }) { text "+1"; }
      strong { text "count = " + count; }
      small { text "double = " + doubled; }
    }
  }
}
</script>

<script type="module">
  import { JLC } from "./jlc.js";
  await JLC.boot();
</script>
```

`JLC.compile()` 之后可以随时反汇编检查编译产物：

```js
const program = JLC.compile(source);
console.log(program.disassemble());
// .function action:add #2 kind=body slots=1 maxStack=2
//   0x0000  GET_GLOBAL   global[0] count
//   0x0003  GET_LOCAL    0, slot 0
//   0x0007  ADD
//   0x0008  SET_GLOBAL   global[0] count
//   0x000b  RETURN_NULL
```

## 字节码虚拟机带来了什么

| 维度 | 0.1 AST 解释执行 | 0.2 JLC-VM 字节码 |
| --- | --- | --- |
| 运行时构成 | Lexer + Parser + 求值器不可拆分 | 仅 VM 执行核部署即可；编译器前端（13 KB gzip）完全可剥离 |
| 执行模型 | 递归遍历 AST 节点对象 | `Uint8Array` 连续指令流 + 单循环派发，对 CPU 缓存友好 |
| 代码保护 | 明文源码或明文 AST | 紧凑二进制 `.jbc`，源码文本可以完全不存在 |
| 沙箱隔离 | 运行期 safeKey / 防原型逃逸 | **字节码验证器**在载入期静态排除非法指令、越界跳转、栈失衡 |
| 离线优化 | 无 | 编译期常量折叠、死代码消除、常量属性折叠（零 effect） |
| 分发 | 源码随页面传输 | `.jbc` 比源码小 ~20–30%，可 base64 内联或独立文件缓存 |

### 字节码验证器（载入期沙箱检查）

每个 `.jbc` 在挂载前必须通过 `verifyModule`：操作码合法性、操作数边界、跳转必须落在
指令边界、所有路径的操作数栈深度一致、`ELEM`/`ELEM_END` 配平、view 函数禁止计算指令、
expr 函数禁止赋值指令……手写或篡改的字节码在**载入期**即被 `JLCVerifyError` 拒绝。
完整指令集与二进制格式见 [JBC.md](./JBC.md)。

## 语言能力

语言本身与 0.1 完全兼容（状态、derive、action、资源、路由、双向绑定、keyed 列表、
生命周期定时器全部不变），此处只列要点，完整语法见 [SPEC.md](./SPEC.md)。

### 状态与动作

```jlc
state user = { name: "JLC", online: true };
derive welcome = "Hello, " + user.name;

action rename(next) {
  user.name = trim(next);   // 嵌套赋值编译为 SET_GLOBAL_PATH，不可变更新
}
```

### 安全 DOM 翻译

```jlc
view {
  input(bind:value = user.name);
  button(class:active = user.online, on:click.stop.prevent = { rename("Kernel"); }) {
    text welcome;
  }
}
```

- `text expression;` 始终写入 `textContent`，没有隐式 HTML 注入。
- `attr:*`、`data:*`、`aria:*`、`prop:*`、`class:name`、`style:name`、`bind:*`、`on:event.mods` 全部支持。
- 常量属性在编译期折叠为 `ATTR_STATIC`，不创建 effect。
- 禁止 `script`/`iframe` 等标签与 `on*` 内联事件——现在在**编译期**直接报错。

### 条件和带 key 列表

```jlc
when (users.loading) { text "加载中…"; } else { … }
each (user, index in users.data key user.id) { … } else { text "暂无数据"; }
```

`when`/`each` 编译为 `WHEN`/`EACH` 指令：真假切换时确定性销毁旧分支作用域；
`each ... key ...` 增量复用 DOM、事件与局部响应式作用域。

### 可取消资源、内建路由、显式能力

`resource users = http(...)` 的请求竞态取消、`$route`/`navigate`、以及 mount 时注入的
同步 `capabilities` 语义不变——capability 在链接期进入全局槽表，同一份字节码可以在
不同 mount 中获得不同的宿主能力集。

## 生来避免内存泄漏

不变量与 0.1 相同：所有资源必须属于 `Scope`；作用域销毁递归清理 effect、订阅、事件、
timer、请求与样式；事件绑定 `AbortController`；resource 重跑先 abort；外部 DOM 删除由
单一 `MutationObserver` 感知并销毁对应子树；`unmount()` 后 `inspect()` 全部归零。

## API

```ts
JLC.tokenize(source, { sourceName? })            // 词法分析
JLC.parse(source, { sourceName? })               // 语法分析（冻结 AST）
JLC.compile(source, { sourceName?, optimize? })  // 编译 → 已验证字节码程序
program.serialize()                              // → .jbc (Uint8Array)
program.disassemble()                            // → 汇编文本
JLC.load(bytes) / loadModule(bytes)              // .jbc → 模块（验证）
JLC.mount(source | program | module | bytes, target, options?)
JLC.boot(root?, options?)                        // 引导 text/jlc 与 text/jbc 脚本
createKernel(options?)                           // 全量内核
createVMKernel(options?)                         // 仅运行时内核（jlc-vm.js）
```

`mount` 选项包括：

| 选项 | 用途 |
| --- | --- |
| `state` | 覆盖同名初始状态 |
| `capabilities` | 注入同步、显式的宿主函数（链接期进入全局槽表） |
| `fetch` | 注入 fetch 实现，便于测试或代理 |
| `replace` | 是否清空挂载目标，默认 `true` |
| `autoDispose` | 是否观察外部 DOM 删除，默认 `true` |
| `maxSteps` | 单次执行指令预算，默认 `100000` |
| `maxLoop` | 单次列表/循环上限，默认 `10000` |
| `onError` | 运行期错误处理器 |

## 开发

```bash
npm test
npm run check
```

测试覆盖原有全部行为（解析错误、响应式派生、事件、双向绑定、条件分支、keyed 列表复用、
不可变嵌套赋值、URL/原型链防护、timer 销毁、请求取消、路由、capability 边界），以及新的
VM 套件：字节码结构与反汇编、`.jbc` 往返序列化、验证器对篡改字节码的拒绝、纯 VM 内核
挂载、base64 `text/jbc` 引导、常量折叠与死代码消除、编译期安全检查、步数/循环限制。

## License

MIT
