# JLC OS（0.4 全权内核形态）

`web/` 是 0.4 的部署形态：**一个不含任何业务标签的 Bootloader + 一堆纯文本 `.jlc` 应用**。
没有构建产物、没有 `.html` 业务页、没有 iframe 游乐场——页面加载后，从 DOM 树构建、事件委托、
动态样式隔离，到 `document.title`、favicon、视口滚动信号与物理 Realm 隔离，整个页面完全由
仓库根部的内核（`jlc.js` = 编译器 + VM）统一治理。

## 运行链路

```text
浏览器访问  https://<pages>/web/#/todo.jlc
   │  web/index.html（Bootloader，< 40 行）
   │    1. 读 location.hash → ./apps/<名>.jlc（默认 todo.jlc）
   │    2. fetch 纯文本（.jlc 无任何执行权）
   │    3. JLC.mount(source, "#kernel-viewport", { policy: "open", isolation: "strict", autoDispose: true })
   ▼
内核：语法自愈 → 字节码编译 → 验证 → 链接 → VM 接管整个视口
```

## 文件

```text
web/
├─ index.html          Bootloader：唯一的物理挂载点 #kernel-viewport + 哈希路由
└─ apps/               业务全部是纯文本 .jlc，直接拉取零执行风险
   ├─ todo.jlc            strict 档：纯 state/derive/each，无宿主接口
   ├─ palette.jlc         open 档：style 前缀作用域 + 字面量 data: URL
   ├─ html-preview.jlc    open 档：iframe/srcdoc 富文本预览，防抖，纯内核展开文档
   ├─ json-browser.jlc    open 档：resource + data: 端点（离线可跑）
   └─ tracer.jlc          open 档：every 定时器 / emit / on:x.window，计数全在内核状态里
```

## 用法

```bash
npm run serve       # → http://localhost:8080/web/#/todo.jlc（带 COOP/COEP）
npm run build:web   # 预检：逐个编译 .jlc 并做 .jbc 往返，挡在部署之前
npm run check:web   # 同上（npm run check 会带上它）
```

GitHub Pages 直接托管仓库即可：`#/todo.jlc`、`#/tracer.jlc`……换哈希就是换应用。
`.jlc` 改完不需要任何构建步骤；`npm run build:web` 只是把语法/策略错误提前到 CI。

## 0.4 的内核接管面

| 面 | 入口 | 策略闸 |
| --- | --- | --- |
| 标题 | `title("…")` | `allowDocumentTitle` |
| Favicon | `favicon("<svg…/>")` 或 `favicon("…url")`（SVG 转 data: URL，其余走净化） | `allowDocumentTitle` |
| 滚动 | 只读信号 `$scroll = { x, y }`，内核代持 `window` scroll 监听 | 无（只读） |
| 路由 | 只读信号 `$route` | 无（只读） |
| 物理隔离 | `isolation: "strict"` 下，任何把节点插出应用子树的行为直接 `JLCIsolationError` | 挂载选项 |
| 语法自愈 | 对象键误写 `=` 自动按 `:` 解析；语句漏分号在关键字/`}`/EOF 前自动补齐 | 编译期 |
