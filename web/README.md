# JLC 0.3 隔离游乐场

`web/` 是 0.3 策略层的**可运行文档**：五个演示应用，每个都是一个独立页面，被控制台用
`sandbox="allow-scripts"` 的 iframe 装进来。三层防线各自可见、可拨动：

| 层 | 谁在执行 | 页面上看什么 |
| --- | --- | --- |
| 浏览器沙箱 | iframe `sandbox="allow-scripts"`（无 `allow-same-origin`） | 卡片里的「沙箱自检」：`parent.document` / `localStorage` / `cookie` / `top.location` 全部 blocked |
| 内核策略 | `resolvePolicy` + 静态接口清单 + `fault` 档 | 状态条的 `策略 open/degrade · 指纹 … · 收回 N 项`，以及「被策略收回的接口」列表 |
| 编译期硬限制 | `jlc-compiler.js` | 「编译台」里 `innerHTML` / `attr:onclick` / `javascript:` URL 在编译期就失败，换任何档都一样 |

## 文件

```text
web/
├─ index.html            控制台：全局开关 + 每个应用一张卡片 + 编译台
├─ console.js            控制台的逻辑（只通过 postMessage 与沙箱页说话）
├─ app-page.js           沙箱页宿主胶水（装载 .jbc、注册 capability、上报 ledger、跑隔离自检）
├─ playground.css        共享样式
├─ jlc-runtime.js  ─┐ 生成物：把 jlc-vm.js / jlc.js 剥掉 ESM 语法拼成经典脚本，
├─ jlc-full.js     ─┘ 这样 file:// 与 opaque origin 下都不会被 module CORS 拦住
├─ registry.js          生成物：应用元数据 + 接口清单 + 各档位收回预告
└─ apps/
   ├─ todo.jlc            strict 档：纯 state/derive/each，无宿主接口
   ├─ palette.jlc         open 档：style 前缀作用域 + 字面量 data: URL（strict 下被中和）
   ├─ html-preview.jlc    open 档 + 隔离域：iframe/srcdoc 富文本预览，防抖 + capability
   ├─ json-browser.jlc    open 档：resource + data: 端点（离线可跑）+ loading/error 分支
   ├─ tracer.jlc          open 档：every 定时器 / emit / on:x.window / storage capability
   └─ *.html              生成物：内联 base64 .jbc 的自包含页面
```

## 用法

```bash
npm run build:web   # 改了 *.jlc 或运行时源码后重新生成
npm run serve       # → http://localhost:8080/
npm run check:web   # 只比对产物，漂移就退出码 1（npm run check 会带上它）
```

GitHub Pages 直接服务 `web/` 也能跑（页面零网络请求），只是没有 COOP/COEP，
`crossOriginIsolated` 会是 ✗——iframe 沙箱不依赖它，隔离自检的结果也一样。

## 手动打开单个页面

每个 `apps/<名>.html` 都能独立打开（含 `file://`），并用查询串控制策略：

```text
./web/apps/html-preview.html?policy=strict&fault=stop&isolation=soft
./web/apps/tracer.html?policy=open&fault=degrade&maxSteps=200000
./web/apps/palette.html?policy={"profile":"open","allowDataUrls":false}
```

`policy` 可以是档名，也可以是一段 JSON 覆盖项（URL 编码后传入）。`fault` 是
`stop | degrade | report`，`isolation` 是 `soft | strict`，`maxSteps` 是实例累计指令预算。

## 页面之间只有一条通道

控制台 → 沙箱页：`jlc:relaunch`（换档重载）、`jlc:load`（注入新 `.jbc`）、`jlc:probe`、`jlc:ping`。
沙箱页 → 控制台：`jlc:hello`、`jlc:mounted`、`jlc:stats`（每 400ms 的 `ledger()`）、
`jlc:fault`、`jlc:denied`、`jlc:capability`、`jlc:isolation`、`jlc:error`。

沙箱页只接受 `event.source === window.parent` 的指令；控制台从不试图读 `contentDocument`。
「编译台」是这套关系的镜像演示：编译发生在**有编译器的同源页面**，跨过那条通道递过去的
只有字节码——部署到生产时，用户手上永远只有 `jlc-vm.js` 和 `.jbc`。
