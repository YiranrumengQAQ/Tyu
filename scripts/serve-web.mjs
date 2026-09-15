/*
 * 游乐场用的零依赖静态服务器：只服务 web/，附带 crossOriginIsolated 所需的 COOP/COEP。
 * Copyright (c) 2026 JLC contributors. MIT licensed.
 *
 *   node scripts/serve-web.mjs [--port 8080] [--no-isolation] [--root web]
 *
 * 为什么需要它：GitHub Pages 不能设响应头，所以线上部署只有「iframe 沙箱 + 内核策略」两层；
 * 本地起这个服务器可以再打开 Site Isolation，右上角的 crossOriginIsolated 会变绿。
 * 沙箱本身不依赖 COOP/COEP —— 少这一层，游乐场照样跑。
 */

import { createServer } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DEFAULT = resolve(fileURLToPath(new URL("../web", import.meta.url)));

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
  [".ico", "image/x-icon"],
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
    // 页面里全是内联脚本与内联字节码：不放行任何外部来源，也不给 eval 留口子。
    headers["Content-Security-Policy"] = [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' data:",
      "frame-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
  }
  return headers;
}

async function resolveTarget(pathname) {
  const decoded = decodeURIComponent(pathname.split("?")[0].split("#")[0]);
  let target = join(ROOT, decoded === "/" ? "index.html" : decoded.replace(/^\/+/u, ""));
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
  const target = await resolveTarget(url.pathname);
  if (!target) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders(url.pathname) });
    response.end(`404 ${url.pathname}\n\n根目录：${ROOT}\n先跑 npm run build:web，再刷新。`);
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
  console.log(`JLC 游乐场 → http://${shown}:${PORT}/`);
  console.log(`  根目录 ${ROOT}`);
  console.log(`  COOP/COEP ${ISOLATION ? "开（crossOriginIsolated 可用）" : "关（--no-isolation）"}`);
});
