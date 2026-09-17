# JLC OS 0.5（Browser Host · 纯前端超级宿主）

> **定义**：0.5 = 0.4 内核 + Browser Host。
> 不改虚拟机、不加后端、不碰 VPS。GitHub Pages 负责整个 0.5 的运行、存储、UI、
> 权限管理和本地能力桥接。后端数量：**0**。

```text
                     GitHub Pages（静态分发）
                              │
                 ┌────────────▼────────────┐
                 │      JLC OS 0.5         │
                 │  web/0.5/（本目录）      │
                 │  Shell · PWA · 权限中心  │
                 └────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
   Capability Hub          Local API            IndexedDB
   （同步宿主函数，        （jlc:// → 存储 /     （jlc-os-0.5 库）
    逐个过权限中心）        剪贴板 / 文件 / 元数据）
        │                     │                     │
        └──────────┬──────────┴─────────────────────┘
                   │
        ┌──────────▼──────────┐
        │   JLC 0.4 内核       │  jlc.js / jlc-vm.js / jlc-compiler.js
        │  VM · 验证器 · DOM   │  ← 一个字都没动
        └────────────────────┘
                   │
                 DOM
```

## 绝对不动区（CORE FREEZE）

```text
🔒 jlc-vm.js          不动
🔒 jlc-compiler.js    不动
🔒 jlc.js             不动
🔒 SPEC.md / JBC.md   不动
🔒 web/index.html     0.4 Bootloader 原样（./  →  0.4，./0.5/ → 0.5）
```

0.5 的全部新增物：`web/0.5/`（本目录）+ 仓库根 `sw.js`（Service Worker，见下文）。
`web/apps/` 的 0.4 应用照常运行，0.5 只是给它们换了一个更有能力的宿主。

## 运行链路

```text
浏览器访问  https://<pages>/web/0.5/#/home.jlc
   │  web/0.5/index.html（Shell Bootloader）
   │    1. 内联脚本先落 data-theme（暗色无闪烁）
   │    2. createHost().start()
   │         → IndexedDB 打开（不可用则降级内存）→ 权限表水合
   │         → 拉 apps.json 目录 → 逐个解析 .jlc 的 @jlc-page 元数据
   │         → 注册 sw.js（仓库根，作用域整站）
   │         → 路由到当前 hash（默认 home）
   │  每个应用：
   │    3. 系统应用（dir=system）：trusted 档，声明的能力域自动「始终允许」
   │       0.4 应用（dir=shared）：按各自 @jlc-page 声明档运行；
   │       未裁决的能力域先弹「应用请求能力」层（本次会话/始终/拒绝/稍后）
   │    4. @jlc-page 的 storage: 行 → 从 IndexedDB 读出同名 state，
   │       经 mount({ state }) 水合（刷新不丢）
   │    5. JLC.mount(source, "#app-viewport", {
   │          policy, isolation, fault: "degrade",
   │          capabilities: 过权限中心的同步宿主函数,
   │          fetch: jlc:// 本地路由 + 其余 URL 原样透传,
   │       })
   ▼
内核：编译 → 验证 → 链接 → VM 接管视口（与 0.4 完全同一套）
```

## 为什么不动 VM 也能做到

0.4 的 VM 已经留好了两个注入口，0.5 全部能力都从这两个口进：

| 注入口 | 0.4 语义 | 0.5 用法 |
| --- | --- | --- |
| `mount({ capabilities })` | 同步宿主函数，链接期进全局槽表，**不能返回 Promise** | 剪贴板写入、下载、通知、分享、全屏、主题、文件选择器 token、权限管理等「同步结果」类能力 |
| `mount({ fetch })` + `resource = http(url, options)` | resource 的异步请求通道 | **Local API**：`jlc://storage/…`、`jlc://files/…` 等异步数据全部走这里，宿主注入的 fetch 按 scheme 分流 |

外加一个 0.4 原生选项：`mount({ state })` —— 宿主在装载前从 IndexedDB 读出已存状态
直接覆盖初始 state，实现「应用代码不写一行持久化代码、刷新不丢」。

## Local API（jlc:// / local://）

应用侧就是普通的 `resource x = http("jlc://…")`；宿主为**每个应用**构建一个 fetch
闭包（请求天然绑定发起应用），本地域先过权限中心，非本地 URL 原样透传给真实
`fetch`（CORS 规则照常，**宿主不代打任何代理**）。

| 路由 | 方法 | 能力域 | 说明 |
| --- | --- | --- | --- |
| `jlc://storage/<app>/<key>` | GET | storage | 读本机 IndexedDB（JSON）；无则 404 |
| | PUT | storage | 写入（body = JSON） |
| | DELETE | storage | 删除 |
| `jlc://storage/<app>` | GET | storage | 列出 key |
| | DELETE | storage | 清空该应用命名空间 |
| `jlc://clipboard/read` | GET | clipboard | `{ text }` |
| `jlc://files/result/<token>` | GET | files | `fileOpen()` 选中文件的信封（见下） |
| `jlc://files/recents` | GET | files | 最近打开（只存元数据） |
| `jlc://meta/apps` | GET | — | 应用目录（宿主实时解析 @jlc-page） |
| `jlc://meta/browser` | GET | browser | 平台 / 设备 / 在线 / 主题 |
| `jlc://meta/version` | GET | — | 内核 / 宿主 / 应用版本 |
| `jlc://meta/permissions` | GET | 系统应用 | 权限中心全表 |
| `jlc://meta/storage` | GET | 系统应用 | 各应用数据量 |
| `jlc://permissions/set/<app>/<cap>` | PUT | 系统应用 | body `{ mode }`：always/session/once/deny/none |
| `jlc://permissions/reset/<app>` | PUT | 系统应用 | 重置单个应用 |
| `jlc://permissions/reset-all` | PUT | 系统应用 | 重置全部 |
| `jlc://data/clear-app/<app>` | PUT | 系统应用 | 清某个应用的 IndexedDB |
| `jlc://data/clear-all` | PUT | 系统应用 | 清全部 |

规则：

- **命名空间隔离**：`<app>` 只能访问自己；系统应用（trusted 第一方）可跨应用管理。
- **未授权** → 403 + 记入「运行期请求列表」（权限中心可见）+ 宿主提示条
  （允许一次 / 始终允许 / 保持拒绝）。
- **Abort**：VM resource 的重跑/销毁会 abort，宿主以 `AbortError` 落败（VM 忽略）。

文件信封（`files/result/<token>`）：

```text
单文件文本   { kind: "text" | "json", name, size, type, text }
单文件二进制 { kind: "binary", name, size, type, url: "data:…" }   ← 直接当 img src
多文件      { kind: "multi", items: [ … ] }
取消选择    { kind: "cancelled" }
```

## Capability Hub（同步能力）

每个能力域对应一组注入函数（`@jlc-page` 的 `capabilities:` 声明域，宿主注入函数）：

| 域 | 注入函数 | 行为 |
| --- | --- | --- |
| `storage` | `storagePut(key, value)`、`storageClear()` | fire-and-forget 写 IndexedDB（刷新不丢） |
| `clipboard` | `clipboardWrite(text)` | 写剪贴板（读走 `jlc://clipboard/read`） |
| `files` | `fileOpen(accept, multiple)` → token、`download(name, content, mime)`、`downloadJson(name, value)` | 文件选择器在**用户手势内**弹出，立即返回 token；应用把 token 写进 state，`resource` 重新请求 `jlc://files/result/<token>` 读到文件。下载 = Blob + `<a download>`，零服务器 |
| `share` | `share(text, title, url)` | Web Share API；不支持时降级为复制 + 提示 |
| `notification` | `notify(message, tag)`、`notifyStatus()` | Notification API；default 权限时在手势内 requestPermission |
| `fullscreen` | `fullscreen(on?)` → 目标状态、`fullscreenActive()` | Fullscreen API |
| `browser` | `platform()`、`isMobile()` | 只读平台信息 |
| `pwa` | `pwaInstall()`、`pwaStatus()` | beforeinstallprompt / 添加到主屏幕 |
| `theme` | `theme("auto"\|"light"\|"dark")`、`themeCurrent()` | 双写 localStorage（首屏读）+ IndexedDB（可清） |
| `system` | `setPermission(app, cap, mode)`、`resetPermissions(app)`、`resetAllPermissions()`、`clearAppStorage(app)`、`clearAllData()` | 仅系统应用注入 |

> 注意：capability 名字是应用全局命名空间的一部分（与 0.4 内建、action/state 同名
> 会在链接期报错）。给应用起 action/state 名时避开上表函数名。

## 权限中心（Permission Hub）

四档授予，`always` / `deny` 持久化到 IndexedDB，`session` / `once` 只活在当前页：

```text
always   始终允许（持久）
session  本次会话（刷新即失效）
once     允许一次（放行一次调用后自动回收）
deny     拒绝（持久）
——       未裁决：运行中被拦截 → 提示条（允许一次/始终/拒绝），权限中心「请求列表」可见
```

- **首次授权**：0.4 应用首次装载时，对从未裁决过的能力域弹「应用请求能力」层
  （逐项勾选 + 本次会话允许 / 始终允许 / 全部拒绝 / 稍后）。
- **运行期拦截**：同步返回安全值（`false` / `-1` / `null`），应用降级运行不崩溃。
- **系统应用**：trusted 第一方，声明的能力域自动「始终允许」。
- **权限中心页面**（`#/permissions.jlc`）：全表查看 / 改档 / 重置。

## PWA 与离线

`sw.js` 放在**仓库根**（作用域必须覆盖内核文件，内核在根目录），但**只由 0.5 页面注册**——
0.4 Bootloader 不注册它，0.4 代码一字未动。一旦注册，整站（含 0.4）离线可用：

```text
precache（版本化 jlc-os-0.5-pre-v1，缓存优先）
  内核三件套 + 0.4 全部 .jlc + 0.5 宿主 + 应用 + manifest + 图标
runtime（jlc-os-0.5-run-v1，网络优先、成功即缓存、失败落缓存）
  此后访问过的任意同源 GET
```

外部请求（跨域 / POST / 非 GET）一律不碰。换版本时 bump `PRE_CACHE` 常量。

`manifest.webmanifest` + `icons/`（由 `tools/make-icons.mjs` 确定性生成，零依赖）：
安装到主屏幕后 JLC OS 有独立图标、standalone 启动。

## 目录

```text
web/0.5/
├─ index.html            Shell Bootloader（顶栏 / 视口 / 底栏 / 弹层宿主 DOM）
├─ shell.css             设计系统（0.4 应用引用的全部 CSS 变量在这里补齐）+ 外壳样式
├─ apps.json             应用目录（新增 .jlc 在这里登记一行）
├─ manifest.webmanifest  PWA
├─ host/
│  ├─ index.js           createHost：装配 / 路由 / 应用生命周期
│  ├─ meta.js            @jlc-page 解析（与 build-web.mjs 同约定，额外识别 storage:）
│  ├─ storage.js         IndexedDB（kv / grants / keyvalue；不可用降级内存）
│  ├─ permissions.js     权限中心（同步裁决 + 请求记账）
│  ├─ localapi.js        jlc:// 路由（每应用一个 fetch 闭包）
│  ├─ capabilities.js    Capability Hub（域 → 同步函数，过权限中心）
│  ├─ files.js           文件选择器 token / 下载 / 最近打开
│  ├─ clipboard.js  share.js  notify.js  fullscreen.js  browser.js  pwa.js
│  └─ ui.js              授权弹层 / 提示条 / 致命错误页 / 顶栏底栏
├─ apps/                 0.5 系统应用（trusted 档，同名覆盖 0.4）
│  ├─ home.jlc            首页 · 应用管理器
│  ├─ apps.jlc            应用目录（策略档 / 能力 / 体积 / 0.4 直达）
│  ├─ files.jlc           文件（打开 / 读取 / 复制 / 下载 / 分享 / 导出 JSON）
│  ├─ permissions.jlc     权限中心
│  ├─ settings.jlc        设置（主题 / PWA / 数据 / 关于）
│  ├─ todo.jlc            待办（IndexedDB 持久化，strict 档 + 显式 capability）
│  └─ notes.jlc           本地笔记（持久化 + 复制 + 导出 .txt）
├─ icons/                icon-192 / icon-512 / maskable-512
└─ tools/
   ├─ check.mjs          0.5 应用预检（编译 + .jbc 往返 + 声明档）
   ├─ integration.mjs    宿主集成测试（真 VM + fake DOM 挂载全部应用）
   └─ make-icons.mjs     图标生成（手写 PNG 编码，零依赖）
```

## 给应用加持久化（3 行）

```jlc
/** @jlc-page
 * capabilities: storage
 * storage: items        ← 宿主从 IndexedDB 水合这个 state
 */
app MyApp {
  state items = [];
  action persist() {
    storagePut("items", items);     ← 落盘（fire-and-forget）
    return null;
  }
  …
}
```

读其他数据用 resource：`resource data = http("jlc://storage/myapp/other", { as: "json" });`

## 验证

```bash
node web/0.5/tools/check.mjs          # 0.5 应用预检（编译 + 往返 + 策略）
node web/0.5/tools/integration.mjs    # 宿主集成测试（真 VM 挂载全部应用 + 安全边界）
npm test                               # 0.4 套件 63 例（不动区回归）
npm run check:web                      # 0.4 应用预检
```

## 部署

GitHub Pages 直接托管仓库（站点根 = 仓库根）：

```text
https://<user>.github.io/<repo>/web/        → JLC OS 0.4（原样）
https://<user>.github.io/<repo>/web/0.5/    → JLC OS 0.5
```

本地：`npm run serve` → `http://localhost:8080/web/0.5/`。
sw.js 的路径全部相对脚本自身解析，带站点前缀（`/<repo>/`）同样成立。

## 已知问题（0.4 内核，未动）

1. **`parseUnary` 把裸 `"+"` / `"-"` 字符串当一元运算符**（jlc-compiler.js）：
   `["!","-","+"].includes(this.current().value)` 只看了 token 的值、没看类型，
   所以 `text "+";` 这类**恰好是 `+` 或 `-` 的字符串字面量**会在解析期被吞掉。
   绕法（已用于 landscape.jlc）：用全角 `＋` 或别的字符。
   建议 0.4.x 补丁：先判 `this.current().type === "punctuation"` 再比 value。
2. **`entries()` 返回 `[key, value]` 元组**：旧代码若按 `row.key` / `row.value`
   取会拿到 null（json-browser.jlc 已按 `at(row, 0)` / `at(row, 1)` 修正）。

## 路线图（0.5-B / 0.5-C）

```text
0.5-B Power Host   File System Access API · 拖放 · 应用沙箱细分 · 能力持久化策略
0.5-C Super App    文本编辑器 / JLC Playground / 日志查看器 / 命令面板 / 主题市场
```
