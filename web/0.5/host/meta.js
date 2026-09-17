/*
 * JLC OS 0.5 · @jlc-page 元数据解析
 * 与 scripts/build-web.mjs 的解析规则兼容（同一注释块约定），
 * 但 0.5 宿主额外识别 `storage:` 声明（要由宿主从 IndexedDB 水合的 state 名）。
 */

export const DEFAULT_META = Object.freeze({
  name: "",
  title: "",
  summary: "",
  policy: "open",
  isolation: "soft",
  fault: "degrade",
  capabilities: [],
  storage: [],
  demo: "",
});

export function parsePageMeta(source, name) {
  const block = /^\/\*{1,2}\s*@jlc-page([\s\S]*?)\*\//.exec(String(source));
  const meta = { ...DEFAULT_META, name, title: name, capabilities: [], storage: [] };
  if (!block) return meta;
  for (const line of block[1].split("\n")) {
    const match = /^\s*\*\s*([A-Za-z-]+)\s*:([^*]*)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (key === "capabilities") meta.capabilities = value ? value.split(/[,，\s]+/).filter(Boolean) : [];
    else if (key === "storage") meta.storage = value ? value.split(/[,，\s]+/).filter(Boolean) : [];
    else if (key in meta) meta[key] = value;
  }
  meta.title = meta.title || meta.name;
  return meta;
}

/** 能力域 → 中文说明（权限面板与首次授权弹层用）。 */
export const CAPABILITY_META = Object.freeze({
  storage: { icon: "💾", label: "本地存储", desc: "把数据存进本机 IndexedDB（jlc://storage/<app>/<key>），刷新不丢" },
  clipboard: { icon: "📋", label: "剪贴板", desc: "写入本机剪贴板；读取走 jlc://clipboard/read" },
  files: { icon: "🗂", label: "文件", desc: "打开文件选择器、导出 / 下载文件（JSON / TXT / JLC / CSV / PNG…）" },
  share: { icon: "📤", label: "系统分享", desc: "调用 Android / iOS 原生分享面板" },
  notification: { icon: "🔔", label: "通知", desc: "在系统通知栏显示消息" },
  fullscreen: { icon: "⛶", label: "全屏", desc: "进入 / 退出浏览器全屏" },
  browser: { icon: "🌐", label: "浏览器信息", desc: "只读的平台 / 设备 / 在线状态" },
  pwa: { icon: "📲", label: "应用安装", desc: "安装为 PWA（添加到主屏幕）" },
  theme: { icon: "🌓", label: "主题", desc: "切换 JLC OS 明暗主题" },
  system: { icon: "🛡", label: "系统管理", desc: "系统应用专用：权限中心与数据管理" },
});

export function capabilityLabel(domain) {
  return CAPABILITY_META[domain]?.label ?? domain;
}
