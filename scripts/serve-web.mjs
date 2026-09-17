/*
 * JLC OS 的零依赖静态服务器：从仓库根目录出发，服务 web/ 下的 Bootloader 与 .jlc 应用，
 * 顺带暴露根部的内核源码（Bootloader 用 `../jlc.js` 引入），并附带 COOP/COEP。
 * Copyright (c) 2026 JLC contributors. MIT licensed.
 *
 *   node scripts/serve-web.mjs [--port 8080] [--no-isolation] [--root <dir>]
 *
 * 0.4 起页面只有一个：web/index.html（Bootloader）。它把 .jlc 当纯文本 fetch 进来，
 * 全权交给内核编译并接管视口。GitHub Pages 直接托管仓库即可，不需要本服务器；
 * 本地起它只是为了拿到 COOP/COEP（crossOriginIsolated 变绿）与 no-store 缓存。
 */

import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DEFAULT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const PORT = Number(arg("port", process.env.PORT ?? 8080));
const HOST = String(arg("host", "0.0.0.0"));
const ROOT = resolve(String(arg("root", ROOT_DEFAULT)));
const ISOLATION = !process.argv.includes("--no-isolation");

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jlc", "text/plain; charset=utf-8"],
  [".jbc", "application/octet-stream"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
]);

function securityHeaders(pathname) {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (ISOLATION) {
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
    headers["Cross-Origin-Embedder-Policy"] = "require-corp";
  }
  if (pathname.endsWith(".html")) {
    // Bootloader 是内联 module 脚本 + 同源模块图 + fetch(.jlc)：
    // 放行 self 与内联脚本即可，其余来源一律不给。
    headers["Content-Security-Policy"] = [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      // 0.5 外壳用外链 shell.css + manifest.webmanifest（0.4 仍只靠内联样式，互不影响）
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' data:",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
  }
  return headers;
}

async function resolveTarget(pathname) {
  const decoded = decodeURIComponent(pathname.split("?")[0].split("#")[0]);
  if (/(?:^|\/)\.(?:git|env)\b/u.test(decoded)) return null;
  let target = join(ROOT, decoded.replace(/^\/+/u, ""));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  const stat = await fs.stat(target).catch(() => null);
  if (stat?.isDirectory()) {
    target = join(target, "index.html");
    return (await fs.stat(target).catch(() => null))?.isFile() ? target : null;
  }
  return stat?.isFile() ? target : null;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD", ...securityHeaders(url.pathname) });
    response.end("method not allowed");
    return;
  }
  // Bootloader 在 /web/ 下，用相对路径取 ./apps/*.jlc 与 ../jlc.js：
  // 根路径直接领去 /web/，保证哈希路由与相对引用都对得上。
  if (url.pathname === "/" || url.pathname === "/index.html") {
    response.writeHead(302, { Location: "/web/", ...securityHeaders(url.pathname) });
    response.end();
    return;
  }
  const target = await resolveTarget(url.pathname);
  if (!target) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders(url.pathname) });
    response.end(`404 ${url.pathname}\n\n根目录：${ROOT}\nBootloader：/web/#/todo.jlc`);
    return;
  }
  const stat = await fs.stat(target);
  response.writeHead(200, {
    "Content-Type": TYPES.get(extname(target)) ?? "application/octet-stream",
    "Content-Length": String(stat.size),
    ...securityHeaders(url.pathname),
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(target).pipe(response);
});

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`JLC OS → http://${shown}:${PORT}/web/#/todo.jlc`);
  console.log(`  根目录 ${ROOT}`);
  console.log(`  COOP/COEP ${ISOLATION ? "开（crossOriginIsolated 可用）" : "关（--no-isolation）"}`);
});
