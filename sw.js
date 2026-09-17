/* ============================================================
   JLC OS 0.5 · Service Worker（仓库根，作用域 = 整站）
   ------------------------------------------------------------
   - 只由 JLC OS 0.5 页面（web/0.5/index.html）注册；
     0.4 Bootloader（web/index.html）不注册它，0.4 代码一字未动。
   - 一旦注册，整站（含 0.4 内核与应用）获得「首次联网后离线可用」：
       precache（版本化、缓存优先）：内核 + 0.4 应用 + 0.5 宿主 + 图标
       runtime（网络优先、缓存兜底）：此后访问过的任意同源 GET
   - 外部请求（跨域、POST、jlc:// 等）一律不碰，原样放行。
   ============================================================ */

const PRE_CACHE = "jlc-os-0.5-pre-v1";
const RUN_CACHE = "jlc-os-0.5-run-v1";

/* 相对本脚本（仓库根）解析 —— GitHub Pages 站点前缀（如 /Tyu/）下同样成立。 */
const PRECACHE = [
  "sw.js",
  "jlc.js",
  "jlc-vm.js",
  "jlc-compiler.js",
  // 0.6.1 Performance Kernel：jlc-vm.js 以原生 ESM 相对导入引用这些模块
  "kernel/index.js",
  "kernel/frame-budget.js",
  "kernel/scheduler-lanes.js",
  "kernel/dom-transaction.js",
  "kernel/node-cache.js",
  "kernel/memory.js",
  "kernel/leak-detector.js",
  "kernel/cancellation.js",
  "kernel/hot-cache.js",
  "kernel/dependency-graph.js",
  "kernel/checkpoint-delta.js",
  "web/0.6/index.html",
  "web/index.html",
  "web/apps/todo.jlc",
  "web/apps/palette.jlc",
  "web/apps/json-browser.jlc",
  "web/apps/html-preview.jlc",
  "web/apps/tracer.jlc",
  "web/apps/landscape.jlc",
  "web/0.5/index.html",
  "web/0.5/shell.css",
  "web/0.5/apps.json",
  "web/0.5/manifest.webmanifest",
  "web/0.5/host/index.js",
  "web/0.5/host/meta.js",
  "web/0.5/host/storage.js",
  "web/0.5/host/permissions.js",
  "web/0.5/host/files.js",
  "web/0.5/host/clipboard.js",
  "web/0.5/host/share.js",
  "web/0.5/host/notify.js",
  "web/0.5/host/fullscreen.js",
  "web/0.5/host/browser.js",
  "web/0.5/host/pwa.js",
  "web/0.5/host/localapi.js",
  "web/0.5/host/capabilities.js",
  "web/0.5/host/ui.js",
  "web/0.5/apps/home.jlc",
  "web/0.5/apps/apps.jlc",
  "web/0.5/apps/files.jlc",
  "web/0.5/apps/permissions.jlc",
  "web/0.5/apps/settings.jlc",
  "web/0.5/apps/todo.jlc",
  "web/0.5/apps/notes.jlc",
  "web/0.5/icons/icon-192.png",
  "web/0.5/icons/icon-512.png",
  "web/0.5/icons/maskable-512.png",
].map((path) => new URL(path, self.location).toString());

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PRE_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("jlc-os-0.5-") && key !== PRE_CACHE && key !== RUN_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 跨域一律不碰（含 CORS 目标）

  // 1) 版本化 precache：缓存优先（确定性静态文件）。
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (request.mode === "navigate") {
        // 离线导航：网络失败后落到 0.5 壳。
        return fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(RUN_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() =>
            caches.match(new URL("web/0.5/index.html", self.location))
              .then((shell) => shell ?? Response.error()),
          );
      }
      // 2) runtime：网络优先，成功即缓存；失败落缓存兜底。
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(RUN_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const fallback = await caches.match(request, { ignoreSearch: true });
          if (fallback) return fallback;
          if (request.destination === "document") {
            const shell = await caches.match(new URL("web/0.5/index.html", self.location));
            if (shell) return shell;
          }
          return Response.error();
        });
    }),
  );
});
