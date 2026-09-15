# JLC 0.3 Language and Kernel Specification

本文件描述 `jlc.js` 当前实现的可执行语义。关键字区分大小写，源文件使用 Unicode；标识符可以使用中文等 Unicode 字母。

## 1. 翻译阶段

JLC 采用“编译器前端 + 字节码虚拟机”的两段式架构（详见 [JBC.md](./JBC.md)）：

```text
JLC source → Tokenizer → Parser → 优化器 → Code Generator → 字节码模块（.jbc）
                                                                  │
        jlc-vm.js：Verifier → Linker → 栈式调度循环 → 响应式 DOM ←┘
```

1. **Tokenize**：去除空白、`//` 行注释和 `/* … */` 块注释，保留 token 的行、列和 offset。
2. **Parse**：Pratt 表达式解析器和递归下降声明/视图解析器生成 AST，公开前递归冻结。
3. **Optimize**：编译期常量折叠（纯字面量运算、字面量条件的分支裁剪）与死代码消除（无副作用的纯表达式语句、不可达语句、恒真 `when`）。
4. **Generate**：AST 扁平化为字节码——表达式/语句/视图片段成为函数表条目，字符串与常量进入常量池，名字进入全局引用表；随后立即通过字节码验证器。
5. **Verify**：载入/挂载期静态检查（指令白名单、操作数边界、跳转目标、栈深度一致性、元素游标配平）；失败抛 `JLCVerifyError`。
6. **Link**：mount 期建立全局槽表（内建 → `$route` → capabilities → 声明），把模块全局引用解析为槽号。
7. **Execute**：栈式调度循环执行字节码；DOM 指令创建元素/文本/when/each 结构并注册细粒度 effect。没有 `eval`、`new Function` 或 JavaScript 源码生成。

语法/验证错误是带 `sourceName:line:column` 的 `JLCCompileError` 或 `JLCVerifyError`；执行错误是 `JLCRuntimeError`。`jlc.js` 是全量门面（编译器 + VM）；仅部署运行时使用 `jlc-vm.js` + `.jbc` 文件，它不包含 Tokenizer 与 Parser。

## 2. 词法

```ebnf
identifier = unicode-letter | "_" | "$",
             { unicode-letter | unicode-number | "_" | "$" } ;
number     = decimal, [ fraction ], [ exponent ] ;
string     = '"' … '"' | "'" … "'" | "`" … "`" ;
comment    = "//", …, newline | "/*", …, "*/" ;
```

反引号字符串支持换行且不执行 `${…}` 插值；除转义反引号外，它会保留 CSS 反斜线。单双引号字符串支持常用、十六进制和 Unicode 转义。

## 3. 程序结构

```ebnf
program     = "app", identifier, "{", { declaration }, view, "}" ;
declaration = state | derive | resource | action | style ;
state       = "state", identifier, "=", expression, ";" ;
derive      = "derive", identifier, "=", expression, ";" ;
resource    = "resource", identifier, "=", expression, ";" ;
style       = "style", expression, ";" ;
action      = "action", identifier, "(", [ parameters ], ")", statement-block ;
parameters  = parameter, { ",", parameter } ;
parameter   = identifier, [ "=", expression ] ;
view        = "view", view-block ;
```

一个程序必须且只能有一个 `view`。声明名不能重复或覆盖内建名称。

- `state`：可写 signal；`mount({ state })` 可覆盖初值。
- `derive`：只读 signal；effect 自动记录本轮真正读取的依赖。
- `action`：同步、受步数限制的 JLC 函数。
- `resource`：表达式必须返回 `http()` 描述符。
- `style`：在 document head 创建带 `data-jlc-style` 的 style，卸载时删除；表达式可以响应 state。

## 4. 视图

```ebnf
view-block = "{", { view-node }, "}" ;
view-node  = element | text | when | each ;
text       = "text", expression, ";" ;
element    = tag, [ "(", attributes, ")" ], ( view-block | ";" ) ;
tag        = identifier, { "-", identifier } ;
attributes = attribute, { ",", attribute } ;
attribute  = attribute-name, "=", ( expression | event-block ) ;
when       = "when", "(", expression, ")", view-block,
             [ "else", view-block ] ;
each       = "each", "(", identifier, [ ",", identifier ],
             "in", expression, [ "key", expression ], ")", view-block,
             [ "else", view-block ] ;
```

### 4.1 属性翻译

| 写法 | 语义 |
| --- | --- |
| `class = value` | 字符串、数组或 `{ className: enabled }` |
| `class:name = test` | `classList.toggle` |
| `style = value` | CSS 字符串或 property 对象 |
| `style:name = value` | `style.setProperty` |
| `prop:name = value` | DOM property |
| `attr:name = value` | 原样属性名（冒号转 `-`） |
| `data:name = value` | `data-name` |
| `aria:name = value` | `aria-name` |
| `bind:value = state` | `input` 双向绑定 |
| `bind:checked = state` | checkbox 双向绑定 |
| `on:click = { … }` | 生命周期事件动作 |

属性名前缀（`attr:` / `data:` / `aria:` / `prop:` / `style:` / `class:`）的后缀只接受标识符
字符，翻译时冒号变成连字符：`data:picked` 写进 `data-picked`。带连字符的名字
（`data-picked = …`）不是合法语法；`class:` 与 `style:` 的后缀同理，用 `-` 命名的类请改走
`class = "…" ` 或 `class:name` 的下划线/驼峰别名。

事件修饰符：`prevent`、`stop`、`self`、`once`、`capture`、`passive`、`window`（位掩码 1/2/4/8/16/32/64）。
`on:resize.window` 与语法糖 `on:window:resize` 等价：监听器挂在 `window` 上，
生命周期仍归该元素的 Scope，卸载时自动移除；需要 `allowWindowEvents`。事件动作中存在只读 `$event`：

```text
{ type, value, checked, key, code, button, x, y,
  alt, ctrl, shift, meta, detail }
```

它是安全快照，不是原始 Event 或 Element 引用。

### 4.2 条件

`when` effect 会追踪 test 的依赖。依赖改变但布尔值不变时不重建分支；真假切换时先销毁旧分支作用域，再移除旧 DOM 并创建新分支。

### 4.3 列表

`each` 接受数组、字符串或对象 values。指定 `key` 时：

1. 新 key 创建独立 item scope；
2. 已有 key 更新局部 item/index signal 并复用 DOM；
3. 消失的 key 确定性销毁；
4. 顺序变化移动该项的完整 DOM range；
5. 重复 key 抛出运行时错误。

不指定 key 时默认用索引。需要持久身份的动态列表应始终显式指定 key。`each` 的 `else`
分支是独立的 empty 函数（`EACH` 的第 4 个操作数），与 `key` 无关：无 key 时同样工作。

## 5. 表达式

### 5.1 值

JLC 可持久数据类型是：`null`、boolean、有限 number、string、array 和无原型 object。内核私有 callable/request 只能作为即时表达式结果，不能存入 state、let 或导出给宿主。宿主输入会被复制和净化：

- 循环数据拒绝；
- 函数、symbol 等非数据值拒绝；
- `__proto__`、`prototype`、`constructor` 丢弃或拒绝访问；
- 非有限数字规范为 `null`；
- object 最深 100 层，单数组最多 100000 项。

### 5.2 运算

从低到高：

```text
??
||
&&
== != === !==
< <= > >= in
+ -
* / %
**
! not + -
```

另有 `test ? yes : no`、数组/对象字面量、字段和索引读取、JLC callable 调用。`==` 和 `===` 在 JLC 中都采用 `Object.is`，不做 JavaScript 隐式类型转换。

只允许调用：

1. `action`；
2. 内建函数；
3. mount 时显式注入的 capability。

对象原型方法不可调用，因此 `value.constructor.constructor(...)`、任意 DOM API 和隐式宿主逃逸均不可达。

## 6. 动作语句

```ebnf
statement-block = "{", { statement }, "}" ;
statement       = let | assignment | expression-statement | if | for |
                  return | timer ;
let             = "let", identifier, [ "=", expression ], ";" ;
assignment      = lvalue, ( "=" | "+=" | "-=" | "*=" | "/=" |
                  "%=" | "??=" ), expression, ";" ;
if              = "if", "(", expression, ")", statement-block,
                  [ "else", ( if | statement-block ) ] ;
for             = "for", "(", identifier, [ ",", identifier ], "in",
                  expression, ")", statement-block ;
return          = "return", [ expression ], ";" ;
timer           = ( "after" | "every" ), "(", expression, ")",
                  statement-block ;
```

嵌套字段赋值执行 structural copy。例如 `user.profile.name = "B"` 不修改原 object，而是沿路径复制并写回根 signal。

动作调用深度上限 100，默认单次执行步数上限 100000；`for`、`each` 和 `range` 默认最多 10000 项。限制可由 kernel/mount options 调整。

`after` 和 `every` 归属于启动它们的事件元素作用域；通过 handle 调用时归属于 app 根作用域。`after` 执行前先注销自己，`every` 在所属作用域销毁时清除。

## 7. 内建函数

### 数据

```text
len(value)                  string(value)       number(value)
bool(value)                 upper(value)        lower(value)
trim(value)                 join(array, sep)    slice(value, start, end)
at(value, index)            get(object, key, fallback)
has(object, key)            keys(object)        values(object)
entries(object)             range(start, end, step)
append(array, ...items)     prepend(array, ...items)
removeAt(array, index)      replaceAt(array, index, item)
merge(...objects)           json(value)         parseJson(text)
```

### 数值

```text
min(...values)  max(...values)  round(value)  floor(value)
ceil(value)     abs(value)       clamp(value, min, max)  now()
```

### 平台

```text
http(url, options)          reload(resource)
navigate(url, state)        replace(url, state)
emit(name, detail)          title(value)
```

`http` options 支持 `method`、`headers`、`body`、`credentials`、`as`（`auto | json | text | blob`）。blob 不进入 JLC 数据树，当前快照中的 data 为 `null`；如需处理二进制应由宿主 capability 提供同步映射后的数据。

## 8. Resource 状态机

每个 resource 持有独立 reload signal 和只读 snapshot signal。

```text
start   → { loading: true,  data: previous|null, error: null, status }
success → { loading: false, data: safeData,      error: null, status }
httpErr → { loading: false, data: safeData,      error,       status }
network → { loading: false, data: previous|null, error,       status: null }
```

每轮请求注册 effect cleanup：先 `AbortController.abort()`，再使旧结果失效。请求完成或取消时 active request 计数严格减一。

## 9. 生命周期不变量

作用域构成一棵严格所有权树：

```text
app scope
├─ style/effect/resource/router
├─ element scope
│  ├─ attributes/effects/listeners
│  ├─ text scope
│  └─ child element scope
├─ when control scope → current branch scope
└─ each control scope → key item scopes / empty scope
```

必须保持以下不变量：

- 资源只能由未销毁 Scope 创建。
- 子 Scope 销毁时从父集合删除。
- Effect 销毁时从所有 Signal subscriber 集合删除，并清除 callback 引用。
- Effect 每次运行前删除上一轮动态依赖和 run cleanup。
- 事件移除、timer clear、request abort、style remove 均注册成 scope disposable。
- 外部删除 owned DOM node 时，对应 scope 被销毁；DOM 移动（节点仍 connected）不触发销毁。
- `unmount()` 幂等；返回后 `inspect()` 的所有资源计数必须为 0。
- 卸载后的 handle 只保留静态名称和最终计数，不保留 DOM/runtime/environment。

## 10. 安全边界：策略、隔离域与 fault 档

安全模型分两层：托管方（沙箱框架、CSP、同源策略）决定页面能碰什么，JLC 策略层决定
**应用能碰宿主的哪些接口**。后者不是 lint 建议，而是编译期预检 + 装载期裁决 + 写入期
逐条把关的强制机制，三层共用同一份解析结果。

### 10.1 策略档与覆盖

策略是一组冻结字段，由 `resolvePolicy(input)` 解析；`input` 是档名字符串，或
`{ profile: "open", …覆盖项 }`。内置三档：

| 字段 | `strict`（0.2 行为） | `open` | `trusted` |
| --- | --- | --- | --- |
| `urlSchemes` | `about: http: https: mailto: tel: sms: ftp: geo:` | 再含 `blob: data: srcdoc: magnet:` | 同 `open` |
| `allowDataUrls` / `allowBlobUrls` | 否 | 是 | 是 |
| `allowCustomElements` | 否 | 是 | 是 |
| `allowSandboxedFrames`（iframe / srcdoc） | 否 | 是 | 是 |
| `allowHtmlInjection`（富文本注入面） | 否 | 是 | 是 |
| `allowWindowEvents`（`on:x.window`） | 否 | 是 | 是 |
| `allowEventAttributes`（`on*` 字符串入口） | 否 | 否 | 否 |
| `allowNetwork`（resource / `http()`） | 是 | 是 | 是 |
| `allowNavigation` / `allowTimer` / `allowCustomEvents` / `allowDocumentTitle` | 是 | 是 | 是 |
| `frameSandbox` | `""`（内核托管） | `allow-scripts allow-forms allow-popups` | 再加 `allow-modals allow-same-origin` |
| `frameMinIntervalMs` | 16 | 4 | 0 |
| `htmlMaxChars` | 0 | 262144 | 2097152 |
| `maxDomNodes` | 4000 | 20000 | 60000 |
| `maxStyleBytes` | 65536 | 131072 | 524288 |
| `styleScoping` / `allowStyleScopingRelax` | `off` / 否 | `prefix` / 是 | `off` / 是 |
| `blockedTags` | `script object embed base meta` | `script object embed base` | `script object embed base` |
| `blockedProperties` | `innerHTML outerHTML srcdoc contentWindow contentDocument location document defaultView parentNode host` | 同左 | 同左 |
| `blockedAttributes` | `formaction` | 同左 | 同左 |
| `gateMode` | `audit` | `audit` | `audit` |

字段全集见 `jlc-vm.js` 的 `SECURITY_PROFILES`；`label` 是给管理台直接显示的中文名，
`fingerprint` 覆盖除 `label` 外的全部字段（fnv1a 短哈希）（open 是 `0xdc8f9df4`，一眼就能认出来）。
`allowEventAttributes` 三档全否是有意的：`on*` 字符串属性等价于 `new Function`，
JLC 里事件的唯一入口是编译成函数的 `on:name = { … }` 块，`attr:onclick = "…"` 在编译期就失败。

两个附加开关：`strictUrls: true` 把 `url:<scheme>` 类接口从「写入时中和」升级为
「装载期拒绝」；`capabilityAllowlist: ["name", …]` 只放行列出的宿主 capability
（`null` = 宿主注册了什么就能用什么）。解析结果被 `Object.freeze`，覆盖项只认这张表里的
字段名——写错名字直接报错，不会静默失效。

### 10.2 接口清单（manifest）

编译器与 `auditModule()` 从**指令流**静态重算应用声明的接口，条目形如
`{ kind, detail, key, sites }`，`kind` 只可能是：

```text
tag         创建的元素标签            frame        iframe / srcdoc
url         常量属性里的 URL 协议      property       prop:name 写入
attribute   on* 与 attr: 属性         host           http / navigate / timer / emit / title
window      窗口事件委托              style          全局样式注入
capability  调用的宿主函数
```

`sites` 是 `函数名@字节码偏移` 列表，用于把拒绝指回源码位置。`SYSCALLS` 表把每个
`kind:detail` 映射到裁决它的策略字段（例如 `frame:iframe → allowSandboxedFrames`、
`host:http → allowNetwork`、`window:event → allowWindowEvents`）。`.jbc` 的 MANIFEST 段
只是这份清单的镜像：验证器重算后要求申报**不得少报**（`申报清单与指令流不一致，漏报接口：…`），
伪造多报无效——权威版本永远来自指令流。

### 10.3 硬限制与策略拒绝的分界

有些接口任何档位、任何 fault 档都不放行，它们在编译期就报错：

```text
HARD_BLOCKED_TAGS        script style iframe（作为 attr: 名出现时）等 HTML 解析入口
HARD_BLOCKED_PROPERTIES  innerHTML outerHTML srcdoc
危险 URL                  javascript: vbscript: data:text/html
BLOCKED_KEYS              原型链与宿主句柄字段（__proto__ constructor contentWindow …）
```

`isHardViolation(kind, detail)` 只对 `tag` / `property` / `url` 三类返回真。除此之外的一切
拒绝都属于**策略**范畴，交由 fault 档处理。

URL 分两条路径，这是 0.2 行为的延续：**HTML sink**（`src`、`href`、`xlink:href`、`formaction`…）
走协议白名单 `urlSchemes`，不合规就换成 `about:blank` 并记 `neutralized` 计数 + 一条审计；
**请求目标**（`http()` / resource）只受硬限制约束，`data:application/json` 之类的取数端点在
`strict` 下照样能用。两条路径都不会让整页挂不掉——除非策略打开 `strictUrls: true`，
此时静态可判定的 `url:<scheme>` 升级为装载期拒绝。

### 10.4 fault 档

`fault` 决定策略拒绝发生时的行为，可设在 kernel 或 mount 上：

| fault | 装载期（静态清单被拒） | 运行期（写入时命中） |
| --- | --- | --- |
| `stop` | 渲染任何节点之前抛 `JLCPolicyError`，列出全部 `kind:detail（原因）` | 同上，异常解包后向上传播 |
| `degrade` | 被拒接口替换成 `<jlc-denied role="note">接口 X 被策略 P 拒绝</jlc-denied>`；被拒的副作用（title / emit / http / timer / navigate / capability / srcdoc / 超配额写入）跳过并记账 | 副作用跳过 + `faults` 计数 |
| `report` | 照常渲染，只通过 `onFault` 汇报 | 照常执行，只记录 |

`onFault(info)` 收到 `{ action: "deny" | "skip" | "ignore" | "neutralize" | "quota", kind, detail, message }`。
配额类失败（`maxDomNodes`、`maxStyleBytes`、`htmlMaxChars`、`maxTotalSteps`）抛
`JLCQuotaError`：`degrade` 档下 `htmlMaxChars` 溢出降级为截断，其余仍向上抛。

### 10.5 隔离域

`isolation: "strict"` 时，实例只能操作自己的隔离域：`realmElement`（默认挂载点的父元素，
可用 `realmRoot` 指定）之外的节点一律 `JLCIsolationError`。已经渲染出去的节点若被外部
移出该域，实例自动 dispose（`setupAutoDispose`）。挂载点之外的一次 `appendChild`
不能把 JLC 节点「偷」进宿主 DOM 再改。

### 10.6 观测面

`handle.inspect()` / `runtime.ledger()` 返回同一组计数：

```text
scopes effects listeners timers requests nodes styles      活动资源
cycles faults denials neutralized                            累计与拒绝
peakStack peakFrames                                         压力峰值
```

`unmount()` 后活动资源归零，`cycles` / `peak*` / `neutralized` 作为生命周期计数保留。
管理台另有 `handle.permissions()`（逐条 `granted` / `reason`）、`handle.describe()`
（策略 + 清单 + 用量）、`handle.policy()`，以及内核级 `kernel.list()` / `kernel.demountAll()` /
`kernel.policy(name)`。

Capability 仍是明确的信任边界：内核净化其输入输出、按 `capabilityAllowlist` 与
`capability:<name>` 记账，但 capability 在宿主世界内部产生的全局副作用不受 JLC 生命周期控制。

## 11. 调度

Signal 写入把订阅 effect 加入去重队列并安排 microtask。优先级：

1. derive effect；
2. resource、style、DOM 和结构 effect。

flush 持续执行到队列为空；超过 1000 轮判定为响应循环。事件、`handle.set` 和 `handle.call` 自动 batch；测试或必须立即读取 DOM 时可调用 `handle.flush()`。

## 12. 字节码执行语义补充

以下语义由字节码层精确规定（完整指令集见 [JBC.md](./JBC.md)）：

- **局部变量**：action 的参数与 `let`、`for` 变量存放在帧槽中。重复 `let`、给
  `for/each` 变量或只读状态赋值在编译期即报错；槽位寻址支持沿帧链引用外层
  片段变量（嵌套 `each`）。
- **定时器捕获**：`after`/`every` 在执行到 `TIMER` 指令的瞬间对整条帧链做槽位
  快照；定时器体读取到的是创建时刻的局部变量值。全局 state 始终共享读写。
- **步数预算**：除跳转、`NOP`/`POP`/`DUP`、`RETURN_NULL` 外每条指令计 1 步，
  单次执行默认上限 100000（`maxSteps` 可调）；实例生命周期内的累计上限是
  `maxTotalSteps`（0 = 不限），越界抛 `JLCQuotaError` 并计入 `faults`；
  `for`/`each` 项目数仍受 `maxLoop` 约束。
- **action 调用**：`CALL` 对模块内 action 压入新帧（深度上限 100），对内建与
  capability 直接调用。参数默认值是独立表达式函数，可见此前参数与全局。
- **视图结构 pass**：view 函数在 mount 时线性执行一次；响应式部分（text、
  属性、bind、when、each）以函数索引注册为 effect，依赖变化时由 VM 重放
  对应函数，而不是重建结构。
- **常量属性**：字面量属性在编译期折叠为 `ATTR_STATIC`，不产生 effect。
