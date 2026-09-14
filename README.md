# JLC Kernel
https://yiranrumengqaq.github.io/Tyu/
JLC（**Just-in-time Lifecycle Components**）是一门面向浏览器界面的自研语言；本仓库是它的纯前端翻译内核。它不是 React/Vue/Svelte 的封装，也不依赖编译服务：一个 `jlc.js` 就同时完成词法分析、语法分析、AST 校验、响应式执行和 DOM 翻译。

> 当前版本：`0.1.0`，零运行时依赖，ES Module，可直接在现代浏览器运行。

## 为什么是“内核”

JLC 源码不会经 `eval`、`new Function` 或动态脚本变成 JavaScript，而是走受控翻译链：

```text
JLC source → Tokenizer → Parser → frozen AST → safe evaluator → reactive DOM
```

因此它同时是语言前端、受控执行器、细粒度响应式图和 DOM 生命周期管理器。默认执行环境不能碰浏览器原型链或任意 JavaScript；确实需要宿主功能时，再通过显式 `capabilities` 注入。

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

也可以完全由 JavaScript 挂载：

```js
import { JLC } from "./jlc.js";

const program = JLC.compile(jlcSource, { sourceName: "counter.jlc" });
const app = program.mount("#app", {
  state: { count: 10 },
  onError: console.error,
});

app.call("add", 5);
app.flush();
console.log(app.get("count")); // 15
app.unmount();                 // 所有内核资源归零
```

## 语言能力

### 状态与动作

```jlc
state user = { name: "JLC", online: true };
derive welcome = "Hello, " + user.name;

action rename(next) {
  // 嵌套赋值由内核翻译成不可变更新，视图会精确收到通知
  user.name = trim(next);
}
```

`state` 可写，`derive` 只读并自动追踪依赖。一个事件或宿主 `call` 中的修改会自动批处理。动作支持 `let`、`if / else if / else`、`for`、`return`、嵌套动作调用以及生命周期定时器：

```jlc
action begin() {
  after (500) { ready = true; }
  every (1000) { seconds += 1; }
}
```

### 安全 DOM 翻译

```jlc
view {
  input(bind:value = user.name);
  input(type = "checkbox", bind:checked = user.online);

  button(
    class:active = user.online,
    style:opacity = user.online ? 1 : 0.5,
    attr:aria-label = welcome,
    on:click.stop.prevent = { rename("Kernel"); }
  ) {
    text welcome;
  }
}
```

- `text expression;` 始终写入 `textContent`，没有隐式 HTML 注入。
- 普通属性响应式更新；`attr:*`、`data:*`、`aria:*` 会翻译成标准属性。
- `class:name` 切换类，`style:name` 设置样式，`prop:name` 显式设置 DOM property。
- `bind:value` / `bind:checked` 是双向绑定。
- `on:event.modifier` 支持 `prevent`、`stop`、`self`、`once`、`capture`、`passive`。
- 支持 SVG 和带连字符的 Custom Element。

### 条件和带 key 列表

```jlc
when (users.loading) {
  text "加载中…";
} else {
  ul {
    each (user, index in users.data key user.id) {
      li { text index + ". " + user.name; }
    } else {
      text "暂无数据";
    }
  }
}
```

`each ... key ...` 使用增量 keyed reconciliation：已有 DOM、事件和局部响应式作用域会移动和复用，而不是整表重建。

### 可取消资源

```jlc
state page = 1;
resource users = http("/api/users?page=" + page, {
  method: "GET",
  as: "json"
});

view {
  when (users.loading) { text "loading"; }
  else { text "共 " + len(users.data) + " 项"; }
}
```

资源快照固定为：

```text
{ loading, data, error, status }
```

请求表达式依赖改变时，上一个请求自动 `abort`；节点或应用卸载时也会 `abort`。动作中调用 `reload(users)` 可刷新。

### 内建路由

只读响应式状态 `$route` 提供 `path`、`query`、`hash`、`state`。`navigate(url, state)` 和 `replace(url, state)` 更新 History API，`popstate` 监听器由应用作用域自动管理。

### 显式宿主能力

```js
const app = JLC.mount(source, "#app", {
  capabilities: {
    currency: (amount) => new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: "CNY",
    }).format(amount),
  },
});
```

JLC 中直接调用 `currency(total)`。能力函数的返回值会被复制成无原型、无循环的 JLC 数据树；同步表达式禁止返回 Promise，异步数据统一走 `resource + http`。

## 生来避免内存泄漏

这里不是靠开发者记住一串清理规则，而是内核所有资源都必须属于 `Scope`：

1. **结构化所有权**：应用、元素、文本、条件分支和每个 key 项都有父子作用域。
2. **确定性销毁**：作用域销毁会递归清掉 effect、订阅、事件、timer、请求和样式。
3. **事件统一取消**：监听器绑定 `AbortController`，并保留兼容性移除路径。
4. **请求竞态取消**：资源 effect 每次重跑先中止旧请求，过期结果不能写回。
5. **响应式断链**：effect 重跑先取消旧依赖，销毁后从所有 signal 反向集合移除。
6. **外部 DOM 删除感知**：单一 `MutationObserver` 发现宿主删除 JLC 节点后，立即销毁对应子树；整棵应用被移除则自动 `unmount`。
7. **弱资源标记**：resource 元信息存于 `WeakMap`，不会反向保活快照。
8. **卸载后断引用**：handle 可以继续存在，但不再持有 Document、Element、作用域、effect 或能力闭包。

`app.inspect()` 可直接查看内核当前拥有的资源数：

```js
app.inspect();
// { scopes, effects, listeners, timers, requests, active }

app.unmount();
app.inspect();
// { scopes: 0, effects: 0, listeners: 0, timers: 0, requests: 0, active: false }
```

上述保证覆盖 **JLC 内核创建的资源**。显式注入的 capability 属于宿主代码；如果 capability 自己在内核之外保存全局对象，其生命周期也应由宿主管理。

## 性能设计

- 解析结果冻结，可通过 `JLC.compile()` 一次编译、多次挂载。
- signal → effect 直接依赖边，不做全树 diff。
- 同一 tick 自动批处理，派生值优先于 DOM effect 刷新。
- 条件分支只在真假切换时重建。
- `each` 以 key 复用和移动最小 DOM 范围。
- 每轮 effect 都清理陈旧依赖，动态依赖不会持续膨胀。
- 无框架依赖、无虚拟 DOM、无代码生成、CSP 友好。

## API

```ts
JLC.tokenize(source, { sourceName? })
JLC.parse(source, { sourceName? })
JLC.compile(source, { sourceName? })
JLC.mount(sourceOrProgram, target, options?)
JLC.boot(root?, options?)
createKernel(defaultOptions?)
```

`mount` 选项包括：

| 选项 | 用途 |
| --- | --- |
| `state` | 覆盖同名初始状态 |
| `capabilities` | 注入同步、显式的宿主函数 |
| `fetch` | 注入 fetch 实现，便于测试或代理 |
| `replace` | 是否清空挂载目标，默认 `true` |
| `autoDispose` | 是否观察外部 DOM 删除，默认 `true` |
| `maxSteps` | 单次动作最大运算步数，默认 `100000` |
| `maxLoop` | 单次列表/循环上限，默认 `10000` |
| `onError` | 运行期错误处理器 |

完整语法和运行时约束见 [SPEC.md](./SPEC.md)。

## 开发

```bash
npm test
npm run check
```

测试覆盖解析错误、响应式派生、事件、双向绑定、条件分支、keyed 列表复用、不可变嵌套赋值、URL/原型链防护、timer 销毁、请求取消、路由和 capability 边界。

## License

MIT
