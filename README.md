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

> 当前版本：`0.6.1`（ABI `jlc-abi/3`，字节码 v3 —— 0.6.1 不升 ABI，0.4 / 0.5 / 0.6 的 .jbc 全部继续跑），
> 零运行时依赖，ES Module，可直接在现代浏览器运行。
>
> 0.3 把「安全」从散落的黑名单变成一个可管理的**策略层**：三档 profile、静态接口清单
> （`.jbc` v2 的 MANIFEST 段）、fault 档、实例隔离域与配额。
> 0.4 进一步**全权接管宿主**：宽容自愈解析（`=` 当 `:`、自动补分号）、`title()` /
> `favicon()`、只读 `$scroll` 信号、`isolation: "strict"` 的物理 Realm 断言；
> [JLC OS](./web/index.html) 是一个不到 40 行的 Bootloader，业务全部是纯文本 `.jlc`。
> **0.6 升级的是 VM 本身**：多趟验证器（CFG + 抽象栈类型）、能力图与权限内核、
> 资源内核、六级故障阶梯、检查点回滚，以及「预算耗尽就保存现场、让出、下一轮续跑」的
> 协作式调度。改造细节见 [docs/0.6-blueprint.md](./docs/0.6-blueprint.md)。
> **0.6.1 是性能内核版（Full Runtime Takeover / Performance Kernel）**：0.6 的接管能力
> 全部变成大型项目可承载的执行形态——Scheduler v2.1（老化 / 车道配额 / 饥饿营救）、
> VM Frame Budget、DOM Transaction + Mutation Coalescing、EACH Diff Engine 2 + Keyed
> Node Cache、Reactive Batch 2.0 + Dependency Graph、Profile 2.0、Hot Path Cache、
> 资源 soft/hard 双限额、Memory Accountant、Delta Checkpoint、故障自动升级、
> Leak Detector、Network Scheduler 与 Cancellation Kernel。
> 细节见 [docs/0.6.1-perf-kernel.md](./docs/0.6.1-perf-kernel.md)，
> [0.6.1 Runtime Console](./web/0.6/index.html) 以 `runtime: "full"` 演示全部表面。

## 0.6 内核：一句话一次

```js
import JLC, { PRIORITY, FAULT_LEVELS, CAPABILITY_PATHS } from "./jlc.js";

const app = JLC.mount(source, "#app", {
  policy: "open",
  fault: "restart",              // ignore | degrade | recover | restart | rollback | stop
  resources: { effects: 8, requests: 4 },
  capabilityPaths: { storagePut: "storage.indexeddb" },
  grants: { "storage.indexeddb": { mode: "session" } },
  maxSliceSteps: 50_000,         // 开协作式调度：预算耗尽 → 保存现场 → 让出 → 续跑
  profile: true,                 // 逐指令热点统计（默认零开销）
});

app.capabilities();              // 能力路径 / 状态 / 租约 / 调用与拒绝计数
app.revoke("storage.indexeddb"); // 运行中撤销：后续调用立刻失败
app.checkpoint("before-edit");   // state + 权限 + 资源一起拍照
app.rollback("before-edit");     // 回到那一刻（同步 flush，返回时视图已一致）
app.profile();                   // 热点函数 / 资源账本 / 任务 / 挂起状态
await app.call("crunch");        // 切片开启时宿主调用异步完成

JLC.verify(program);             // 11 趟验证报告（永不抛异常）
JLC.graph(program);              // 控制流图 dump
JLC.analyze(program);            // CFG 统计 / 能力路径 / 确定性判定
JLC.profileAll();                // 全内核诊断汇总（系统监视器直接渲染）
```

0.6.1 的性能内核一个 `runtime: "full"` 全开（预设只是默认值，显式项永远覆盖）：

```js
const app = JLC.mount(source, "#app", {
  runtime: "full",               // 调度公平 / 帧预算 / DOM 事务 / 依赖图 / 增量检查点 /
                                 // 内存分户 / 泄漏探测 / 网络调度 / 故障升级 / 取消内核
  policy: "open",
  profile: true,                 // 生产环境改 false（零开销路径）
  resources: { dom: { soft: 15_000, hard: 20_000 }, workers: 4 },
});

app.profile().sections;          // Profile 2.0：cpu/dom/scheduler/yield/memory/each/network…
app.dependencyGraph();           // Effect Dependency Graph（谁依赖谁）
app.dependents("count");         // 改 count 会牵动哪些 effect
app.memory();                    // Memory Accountant 分户账
app.leaks();                     // 泄漏探测报告（POSSIBLE_LEAK）
app.cancel("net:feed");          // 取消排队任务；组件销毁自动级联取消
app.context();                   // VM Execution Context：我是谁/在哪/有什么权限/用了多少
```

策略层新增两个字段，和旧字段并存：

```js
resolvePolicy({
  profile: "open",
  capabilities: { network: { http: true }, filesystem: { read: true, write: false } },
  resources: { effects: 8, streams: 2 },
  permissionStrict: true,        // 未授予即拒绝（默认是「未登记即放行」，兼容 0.4）
});
```

`.jbc` v3 多了三个段（能力清单 / 资源清单 / 标志位），解码器跳过未知段，
旧的 v1/v2 产物继续装载 —— 详见 [JBC.md](./JBC.md) 与 [SPEC.md §13](./SPEC.md)。

### 点着看：0.6 内核控制台

[`web/0.6/index.html`](./web/0.6/index.html) 不是说明书，而是一块**仪表盘**：
里面那台应用是真的 `.jlc → .jbc → VM → DOM`，右侧四块面板直接读内核的只读视图
（`capabilities()` / `resources()` / `profile()` / `tasks()`），按钮则直接调运行期接管 API：

| 按钮 | 你在看什么 |
| --- | --- |
| 撤销 / 重新授予 `storage.indexeddb` | 权限内核：撤销之后宿主函数一次都碰不到，`denials` 开始计数 |
| 打检查点 / 回滚 | 检查点：state + 权限表 + 资源账本一起拍照、一起恢复 |
| 追加 2000 行 | 分片渲染：`each` 每片让出一帧，`renderSlices` 计数，列表不重复建节点 |
| 让组件崩一次 | Error Boundary：只重启出事的那块，重放后自愈（`restarts` / `faults`） |
| 跑 11 趟验证 / 打印 CFG | 多趟验证器与控制流图：能力路径、确定性判定、块与回边 |

本地预览：`node scripts/serve-web.mjs` 然后打开 `http://localhost:8080/web/0.6/`。
GitHub Pages 上就是仓库里的同一页，没有任何后端参与。

## 策略层：一次声明，三处生效

策略对象（`resolvePolicy`）是编译期预检、装载期裁决与写入期把关的**同一份**数据：

```js
// 装载：档位 + 覆盖项 + fault 档 + 隔离域
const app = JLCVM.mount(module, "#app", {
  policy: { profile: "open", allowDataUrls: false, capabilityAllowlist: ["clipboard"] },
  fault: "degrade",        // stop | degrade | report
  isolation: "strict",     // 实例只能碰自己那块 DOM
  maxTotalSteps: 200_000,  // 实例累计指令预算
  onFault: (info) => console.warn("[policy]", info),
});

app.permissions();          // 逐条 granted / reason
app.describe();             // 策略 + 清单 + 用量（管理台直接渲染）
app.inspect();              // cycles / denials / neutralized / peakStack …
JLCVM.demountAll();         // 一次性卸掉在册实例
```

三档 profile 的差别只在「允不允许碰宿主接口」，语法与字节码完全相同：`strict` 与 0.2
行为等价（无 frame、无 `data:`、无窗口事件、无 HTML 注入）；`open` 全部放开但每一项都带
内核加固（frame 的 `sandbox` 由内核托管、`srcdoc` 走 `iframe.srcdoc` 而永不走
`innerHTML`、`style` 被前缀限定到本实例）；`trusted` 留给第一方字节码。

被拒的接口如何表现由 `fault` 决定：`stop` 在渲染第一个节点之前整体抛 `JLCPolicyError`；
`degrade` 把它换成 `<jlc-denied>` 占位、跳过对应副作用并记账；`report` 照常运行只记录。
`innerHTML`、`javascript:` URL、`<script>` 这类**硬限制**不属于策略：无论哪一档、
哪个 fault 档，编译期就失败。完整表格见 [SPEC.md §10](./SPEC.md#10-安全边界策略隔离域与-fault-档)。

构建期还能只要一份「这个应用会用到哪些宿主接口」的清单：

```js
const program = JLC.compile(source, { policy: "strict", policyMode: "manifest" });
program.module.requirements;             // [{ kind: "frame", detail: "iframe", key: "frame:iframe", sites: [...] }]
JLC.checkPolicy(program, "open");        // []（open 档授予 frame）
```

`policyMode: "gate"` 让编译期直接按策略拒绝（发布管道用），`"defer"` 把裁决整个交给运行期
（fault 档才有意义）。`.jbc` v2 的 MANIFEST 段镜像这份清单，但权威版本由验证器从指令流
重算——改写清单既拿不到权限，也藏不住接口。

## JLC OS（`web/`，0.4 部署形态）

```bash
npm run build:web   # 预检：逐个编译 web/apps/*.jlc + .jbc 往返，不产出任何文件
npm run serve       # 零依赖静态服务器（带 COOP/COEP）→ http://localhost:8080/web/#/todo.jlc
```

`web/index.html` 是一个不到 40 行的 **Bootloader**：读 `location.hash`，把
`./apps/<名>.jlc` 当纯文本 `fetch` 进来，全权交给 `JLC.mount(source, "#kernel-viewport",
{ policy: "open", isolation: "strict", autoDispose: true })`。语法自愈、字节码编译、
DOM/事件/样式接管、`document.title`、favicon、`$scroll` 与物理隔离域，全部由内核完成——
`web/apps/` 里没有任何 `.html`，`.jlc` 直接拉取时无执行权。GitHub Pages 直接托管仓库即可，
换哈希就是换应用（`#/todo.jlc`、`#/tracer.jlc`……）。

## 两段式架构：编译一次，任意 VM 运行

编译（前端）与运行（后端）彻底解耦：

| 文件 | 角色 | 源码 | gzip |
| --- | --- | --- | --- |
| `jlc.js` | 全量门面：编译器前端 + VM（开发用） | 6.4 KB | 2.3 KB |
| `jlc-vm.js` | **仅运行时**：验证器、链接器、调度循环、响应式核心、策略层 | 158 KB | 41 KB |
| `jlc-compiler.js` | 仅编译器：Tokenizer + Parser + 优化器 + 代码生成 | 62 KB | 14 KB |

\* `gzip -9` 实测（含注释）。仅运行时部署时策略层已经算在 `jlc-vm.js` 里，
不需要额外负担；编译期预检用的 `policy` 选项不产生任何运行期代码。

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
JLC.compile(source, { sourceName?, optimize?, policy?, policyMode? })  // 编译 → 已验证字节码 + 接口清单
JLC.checkPolicy(program, "strict")               // 构建期预检：返回被拒接口清单
JLC.policies()                                   // 三档 profile 的解析结果（管理台数据源）
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
| `policy` | 策略档（`"strict"` 默认）或 `{ profile, …覆盖项 }` |
| `fault` | 违反策略时：`stop`（默认）/ `degrade` / `report` |
| `isolation` / `realmRoot` | 实例隔离域（`strict` 时越界 DOM 抛 `JLCIsolationError`） |
| `maxTotalSteps` | 实例累计指令预算（0 = 不限） |
| `onFault` | 每次裁决回调：`deny` / `skip` / `ignore` / `neutralize` / `quota` |
| `id` | 实例标识（默认自增 `jlc-N`），也是样式作用域前缀 |

## 开发

```bash
npm test           # 60 个用例：语言、VM、策略层、JLC OS 部署形态
npm run check      # 语法检查 + .jlc 应用预检 + 全量测试
npm run build:web  # 预检全部 .jlc 应用（编译 + .jbc 往返），无产物
npm run serve      # 本地起 JLC OS（带 COOP/COEP）
```

测试覆盖原有全部行为（解析错误、响应式派生、事件、双向绑定、条件分支、keyed 列表复用、
不可变嵌套赋值、URL/原型链防护、timer 销毁、请求取消、路由、capability 边界），以及新的
VM 套件：字节码结构与反汇编、`.jbc` 往返序列化、验证器对篡改字节码的拒绝、纯 VM 内核
挂载、base64 `text/jbc` 引导、常量折叠与死代码消除、编译期安全检查、步数/循环限制。

0.3 的 `test/policy.test.js` 覆盖策略层：档位与指纹、覆盖项与未知字段拒绝、
`SYSCALLS` 映射、静态接口清单（含 MANIFEST 伪造与往返）、硬限制与策略拒绝的分界、
三档 fault 的行为差异、URL 中和、frame 托管 `sandbox`、样式作用域、DOM/样式/HTML 配额、
隔离域越界与自动 dispose、窗口事件授权、capability 白名单、`ledger()` 计数归零。
`test/web.test.js` 守 0.4 的部署形态：Bootloader 的结构与哈希路由、`web/apps/` 的去
`.html` 化、每个 `.jlc` 在声明策略档下的编译预检与全权挂载、自愈解析（`=` 当 `:`、
漏分号自动补齐）、`favicon()` 的 data: 编码与策略闸、只读 `$scroll` 信号，以及
`isolation: "strict"` 对越界插入的拒绝。

## License

MIT
