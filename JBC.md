# JBC — JLC Bytecode Specification 2.0

JBC 是 JLC 语言的字节码格式与指令集，角色等同 Java 世界里的 class 文件 + JVM 指令集。
编译器（`jlc-compiler.js`）把 JLC 源码编译为 JBC 模块；虚拟机（`jlc-vm.js`）负责
**验证（Verify）→ 链接（Link）→ 执行（Execute）**。

```text
JLC source → Tokenizer → Parser → 优化器 → Code Generator ─┐
                                                            ├→ .jbc → Verifier → Linker → JLC-VM → DOM / Effects
                                    （离线、可分发、可缓存）┘
```

运行时只需要 `jlc-vm.js`：它不包含 Tokenizer 与 Parser，无法接触 JLC 源码文本。

---

## 1. 机器模型

| 部件 | 说明 |
| --- | --- |
| 操作数栈 | 每帧一个，指令从栈顶取数、向栈顶写数 |
| 局部变量槽 | 每帧 `nSlots` 个槽（u16 寻址）；`let`、参数、`for/each` 变量各占一槽 |
| 帧链 | 视图片段/定时器体通过 `parent` 指针引用外层帧，`GET_LOCAL <depth>` 沿链上溯 |
| 全局槽表 | mount 期由链接器建立：内建 → `$route` → capabilities → 声明；模块全局引用在链接期解析为槽号 |
| DOM 游标栈 | 视图函数专用；`ELEM` 压栈、`ELEM_END` 弹栈并插入文档 |
| 调用帧栈 | `CALL` 压入 action 帧；`RETURN` 弹出；深度上限 100 |

## 2. 指令集（Opcode）

操作数编码均为**大端**；`u16`=16 位无符号，`u8`=8 位，`i32`=32 位有符号。
`P`=常量池索引 u16，`F`=函数索引 u16，`R`=全局引用索引 u16，`S`=局部槽 u16，
`B`=u8 立即数，`T`=绝对跳转目标 u16，`I`=i32 立即数。

### 2.1 常量与栈操作

| 汇编 | 操作数 | 栈效应 | 语义 |
| --- | --- | --- | --- |
| `NOP` | — | 0 | 无操作 |
| `CONST` | P | +1 | 常量池值入栈（字符串/浮点/布尔/null；`CONST_STR` 语义由此指令承担） |
| `CONST_INT` | I | +1 | 32 位整数立即数入栈 |
| `CONST_NULL` | — | +1 | `null` 入栈 |
| `POP` | — | −1 | 丢弃栈顶 |
| `DUP` | — | +1 | 复制栈顶 |
| `BUILD_ARRAY` | B(n) | −n+1 | 弹出 n 个元素组成数组 |
| `BUILD_OBJECT` | B(n) | −2n+1 | 弹出 n 组（键, 值）组成无原型对象 |

### 2.2 变量与状态

| 汇编 | 操作数 | 栈效应 | 语义 |
| --- | --- | --- | --- |
| `GET_LOCAL` | B(depth), S | +1 | 读局部槽；槽值是 Signal 时触发依赖追踪读取 |
| `SET_LOCAL` | B(depth), S | −1 | 写局部槽（`let` 赋值；值被 `sanitize`） |
| `DEF_LOCAL` | S | −1 | `let` 定义 |
| `GET_GLOBAL`（=`LOAD_STATE`） | R | +1 | 读全局槽：state/derive/resource signal、内建、capability |
| `SET_GLOBAL`（=`STORE_STATE`） | R | −1 | 写 state signal（只读检查 + `sanitize`） |
| `SET_GLOBAL_PATH` | R, B(k) | −k−1 | 弹出 k 个键与值，沿路径做不可变更新写回 state（`a.b.c = v`） |
| `SET_LOCAL_PATH` | B(depth), S, B(k) | −k−1 | 同上，目标是 `let` 局部对象 |
| `GET_MEMBER` | — | −1 | 弹出 key、object，安全字段读取（禁原型链） |

### 2.3 运算

| 汇编 | 栈 | 语义 | 汇编 | 栈 | 语义 |
| --- | --- | --- | --- | --- | --- |
| `ADD` | −1 | 字符串拼接或数值加 | `SUB` `MUL` `DIV` `MOD` `POW` | −1 | 数值运算（有限数检查） |
| `EQ` | −1 | `Object.is` 相等（`==`/`===`） | `LT` `LE` `GT` `GE` | −1 | 比较 |
| `IN` | −1 | `k in obj`（安全自有字段） | `NOT` `NEG` `POS` | 0 | 一元运算 |
| `COALESCE` | −1 | `a ?? b`（用于 `??=`） | | | |

### 2.4 控制流与调用

| 汇编 | 操作数 | 栈 | 语义 |
| --- | --- | --- | --- |
| `JUMP` | T | 0 | 无条件跳转（绝对目标） |
| `JUMP_IF_FALSE` | T | −1 | 弹出条件，假值跳转 |
| `JUMP_IF_TRUE` | T | −1 | 弹出条件，真值跳转（`\|\|`） |
| `JUMP_IF_NULL` | T | 0 | 窥视栈顶，null 跳转（不弹） |
| `JUMP_IF_NONNULL` | T | −1 | 弹出，非 null 跳转（`??`） |
| `FOR_PREP` | — | 0 | 弹出可迭代对象，规范化并压入迭代器（受 `maxLoop` 限制） |
| `FOR_NEXT` | S,S,B,T | 0/−1 | 迭代：写 item/index 槽；耗尽时弹迭代器并跳转 |
| `CALL` | B(argc) | −argc | 弹出 argc 个实参与被调者：JLC action 压新帧，内建/capability 直接调用 |
| `RETURN` | — | −1 | 弹出返回值并返回当前帧 |
| `RETURN_NULL` | — | 0 | 返回 `null` |
| `TIMER` | B(mode), F | −1 | 弹出延迟；`after`(0)/`every`(1) 注册定时器执行函数 F（快照捕获当前帧链） |

### 2.5 DOM 与响应式（仅 view 函数可用）

| 汇编 | 操作数 | 语义 |
| --- | --- | --- |
| `ELEM` | P(tag) | 创建元素（安全标签检查、SVG 命名空间）压入 DOM 游标 |
| `ELEM_END`（=`POP_ELEMENT`） | — | 游标弹栈，元素插入文档 |
| `TEXT` | F | 文本节点 + 响应式 effect（F 求值 → `textContent`） |
| `ATTR_STATIC` | P,P | 常量属性（编译期折叠，零 effect） |
| `ATTR`（=`BIND_PROP`） | P,F | 响应式属性 |
| `CLASS_TOGGLE` | P,F | `class:name = test` |
| `STYLE_PROP` | P,F | `style:name = value` |
| `PROP_SET` | P,F | `prop:name`（编译期禁 innerHTML 等） |
| `STYLE_OBJECT` | F | `style = {…}` 对象/字符串 |
| `BIND_VALUE` / `BIND_CHECKED` | F,F | 双向绑定：get effect + 事件回写（set 函数以新值为槽 0） |
| `EVENT` | P(type), B(mods), F | `on:event.mods`，修饰符位掩码 prevent1 stop2 self4 once8 capture16 passive32；`$event` 快照在事件帧槽 0 |
| `WHEN` | F,F,F | 条件分支：test/yes/no 三个函数 + 注释标记 + 作用域化重建 |
| `EACH` | F,F,F,F,P,S,B,S | 列表：iter/key/body/empty 四个**函数索引**（缺 key 或缺 else 时用 `NO_FUNC` = `0xFFFF`），随后 item 名常量、item 槽、hasIndex 位与 index 槽 |

`ENTER_SCOPE` / `EXIT_SCOPE` 的职责被融合进 DOM 指令：每个元素、文本、when、
each 记录都会创建子 Scope 并注册 deterministic 销毁，等价且不可跳过。

### 2.6 函数种类（kind）

| kind | 内容 | 出口栈深 |
| --- | --- | --- |
| `expr` | 表达式（state 初值、derive、attr、事件 key……） | 1 |
| `body` | 语句序列（action、事件体、定时器体、bind 回写） | 0 |
| `view` | 视图结构（只能使用 DOM 指令，无跳转） | 0 |

编译器为每类函数自动追加 `RETURN` / `RETURN_NULL` 终止符。

## 3. .jbc 二进制格式

```text
offset  size  field
0       4     magic        0x4A 0x4C 0x43 0x42 ("JLCB"，即 u32 0x4A4C4342)
4       2     version      u16 = 3（解码接受 [1, 2, 3]：1 无 MANIFEST，2 无 v3 段）
6       2     flags        u16 保留
8       2     sectionCount u16
随后每个段：
        1     id           u8
        2     reserved     u16
        4     length       u32
        len   payload
```

| 段 id | 名称 | 载荷 |
| --- | --- | --- |
| 1 | POOL 常量池 | u16 count；每项：u8 tag（0 null / 1 true / 2 false / 3 f64 / 4 string）+ 数据 |
| 2 | GLOBALS 全局引用 | u16 count；每项 u16 指向池内字符串 |
| 3 | FUNCS 函数表 | u16 count；每项：name P、kind u8（0 expr/1 body/2 view）、nSlots u16、captures u8(保留=0)、codeLen u32、指令流 |
| 4 | ACTIONS | u16 count；每项：name P、func u16、params u8 n + (name P, defaultFunc u16 `0xFFFF`=无) |
| 5 | DECLS 声明表 | u16 count；每项：kind u8（0 state/1 derive/2 resource/3 style）、name P、func u16 |
| 6 | VIEW | view 函数索引 u16 |
| 7 | META | app 名 P、sourceName 字符串（u32 长度 + UTF-8）、u16 保留 |
| 8 | MANIFEST | u16 count；每项：u8 kind（0 tag / 1 frame / 2 url / 3 property / 4 attribute / 5 host / 6 window / 7 style / 8 capability）+ str detail |
| 9 | CAPABILITIES | u16 count；每项 str path（能力图路径，如 `network.http`）|
| 10 | RESOURCES | u16 count；每项 u8 kind（1 dom / 2 effects / 3 styles / 4 timers / 5 requests / 6 scopes / 7 listeners / 8 workers / 9 storage / 10 streams）+ u32 静态上界 |
| 11 | FLAGS | u32 位图：1 deterministic / 2 network / 4 timers / 8 frames / 16 windowEvents / 32 workers |

段 9–11 是 **ABI v3** 新增的。v1/v2 模块没有这些段，解码器按缺省处理；
解码器同时**跳过未知段**（前向兼容），因此更高版本的内核可以读更老的产物，
更低版本的内核读 v3 会显式报错而不是误解码。`CAPABILITIES` 与 `RESOURCES`
由验证器从指令流重算（`analyzeModule()` / `resourceManifestOf()`），
申报段同样遵循「只能少报不能多报」的铁律。

所有多字节整数大端（与 class 文件一致）。序列化是确定性的：同一份源码
编译两次得到逐字节相同的 .jbc，适合做构建产物校验与增量分发。

MANIFEST 是**申报**，不是权威：`verifyModule()` 用 `auditModule()` 从指令流重算清单并
覆盖它（`module.requirements` = 重算结果），只允许申报「多报」——漏报任何一项都会
`申报清单与指令流不一致，漏报接口：…` 载入失败。因此改写 MANIFEST 段既拿不到新权限，
也藏不住已用到的接口。重编码是逐字节往返的：`encodeModule(loadModule(bytes))` 与
原 `bytes` 相同。站点信息（`sites`）不进容器，只在解码期由 `auditModule` 现算，
所以 .jbc 里没有源码位置泄漏。

## 4. 验证器（Bytecode Verifier）

模块在载入/挂载时必须通过 `verifyModule`，任何失败抛出 `JLCVerifyError`：

1. **结构检查**：魔数、版本、段完整性、常量池类型、索引范围。
2. **线性扫描**：每个函数的每条指令操作码合法、操作数完整、指令边界对齐。
3. **类型/形态检查**：指令属于函数 kind 白名单（view 函数禁止计算指令，
   expr 函数禁止赋值指令，DOM 指令禁止出现在非 view 函数）。
4. **工作表栈分析**（同 JVM）：从偏移 0 出发追踪所有可达路径，任意汇合点
   操作数栈深度必须一致、不得下溢；跳转目标必须落在指令边界；
   `ELEM`/`ELEM_END` 必须在所有路径上配平。
5. **结构引用**：action 指向 body 函数、声明指向 expr 函数、view 指向 view 函数。
6. **操作数语义**：按 `OP_SPEC.operands` 逐位判定——`P` 必须落在常量池内、`R` 落在
   全局引用表内、`F` 落在函数表内（`NO_FUNC` = `0xFFFF` 是合法的「无函数」哨兵，
   `EACH` 的可选 key/empty 与参数默认值都用它）、`S` 在函数 `nSlots` 内。视图指令的
   函数索引**不是**池下标，这条区分是 0.3 修掉的一处 verifier 误报（`each` 无 key 带
   `else` 曾被判成「常量池索引越界」）。
7. **接口清单**：`auditModule()` 从指令流重算 `requirements`，并与 MANIFEST 申报交叉
   核对（见 §3）。这一步之后，装载期策略裁决只需查这张表。

因此：手写或篡改的字节码在**载入期**即被拒绝，运行期循环可以信任指令流（`maxStack`
也在这里算出，供 `ledger().peakStack` 报告峰值栈深），
不做多余的防御性检查——这正是沙箱隔离的静态半边；动态半边仍是
sanitize/safeKey/无原型数据与 Scope 所有权。

## 5. 链接与执行语义

- **链接**：mount 时按 内建 → `$route` → capabilities → 声明 顺序建立全局槽表，
  然后把模块的每个全局引用解析为槽号（未定义名称 → `JLCRuntimeError`）。
  同一份 .jbc 在不同 mount 中可获得不同的 capability 集。
- **初始化顺序**：state 初值（声明序，`mount({state})` 可覆盖）→ derive effect →
  resource effect → 路由监听 → 视图结构 pass（一次性执行 view 函数）。
- **定时器捕获**：`TIMER` 执行瞬间对整条帧链做槽位快照；定时器体在自己的
  新帧中运行，父链指向快照。全局 state 不受影响（共享读写）。
- **步数预算**：除 `NOP`/`POP`/`DUP`/跳转/`RETURN_NULL` 外每条指令计 1 步，
  超过 `maxSteps` 抛出 `JLCRuntimeError`（防死循环）。

## 6. 与 AST 解释器（0.1）的差异

| 行为 | 0.1 AST | 0.2 字节码 |
| --- | --- | --- |
| 语法错误 | 编译期 | 编译期（不变） |
| 未定义名称 / capability 缺失 | 首次求值时 | 链接期（mount 时立即） |
| 重复 `let`、赋值给只读、非法标签/属性/修饰符 | 运行期 | **编译期** `JLCCompileError` |
| 定时器对局部 `let` 的捕获 | 共享同一绑定 | 创建瞬间快照（共享 state 不变） |
| 步数计数 | 每 AST 节点 | 每条有效指令 |
| 源码文本 | 保留于 Program | 可完全不保留（.jbc 即全部） |
