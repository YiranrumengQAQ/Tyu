/*
 * JLC OS 0.5 应用预检：web/0.5/apps/*.jlc 逐个编译 + .jbc 往返 + 声明档预检。
 * 与 scripts/build-web.mjs（0.4 目录）同一套约定，互不干扰。
 *
 *   node web/0.5/tools/check.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION, ABI_VERSION, BYTECODE_VERSION, checkPermissions, encodeModule, loadModule, resolvePolicy } from "../../../jlc-vm.js";
import { compileAst } from "../../../jlc-compiler.js";
import { CAPABILITY_META } from "../host/meta.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const APPS = join(ROOT, "apps");
const PROFILES = ["strict", "open", "trusted"];
const KNOWN_DOMAINS = new Set([...Object.keys(CAPABILITY_META), "system"]);

function readMeta(source, name) {
  const block = /^\/\*{1,2}\s*@jlc-page([\s\S]*?)\*\//.exec(source);
  const meta = { name, title: name, summary: "", policy: "open", isolation: "soft", fault: "degrade", capabilities: [], storage: [], demo: "" };
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
  return meta;
}

const stray = readdirSync(APPS).filter((file) => file.endsWith(".html"));
if (stray.length) throw new Error(`web/0.5/apps/ 里出现 .html（${stray.join("、")}）：业务一律 .jlc`);

const apps = readdirSync(APPS).filter((file) => file.endsWith(".jlc")).sort().map((file) => file.slice(0, -4));
if (!apps.length) throw new Error("web/0.5/apps/ 里没有 .jlc 应用");

for (const name of apps) {
  const source = readFileSync(join(APPS, `${name}.jlc`), "utf8");
  const meta = readMeta(source, name);
  if (!PROFILES.includes(meta.policy)) throw new Error(`${name}: 未知策略档 ${meta.policy}`);
  for (const domain of meta.capabilities) {
    if (!KNOWN_DOMAINS.has(domain)) throw new Error(`${name}: 未注册的能力域「${domain}」`);
  }

  const { module } = compileAst(source, { sourceName: `web/0.5/apps/${name}.jlc`, policy: meta.policy, policyMode: "manifest" });
  const bytes = encodeModule(module);
  const reloaded = loadModule(bytes, { sourceName: `${name}.jbc` });
  const requirements = module.requirements ?? [];
  if ((reloaded.requirements ?? []).length !== requirements.length) {
    throw new Error(`${name}: .jbc 往返后接口清单不一致`);
  }
  const denials = checkPermissions(requirements, resolvePolicy(meta.policy));
  if (denials.length) {
    throw new Error(`${name}: 在 ${meta.policy} 档下有被收回的接口：${denials.map((item) => `${item.kind}:${item.detail}`).join("、")}`);
  }
  console.log(
    `  ${name.padEnd(14)} ${meta.policy.padEnd(8)} ${String(bytes.length).padStart(5)} B · ${module.functions.length} functions · caps=[${meta.capabilities.join(",")}]`,
  );
}
console.log(`0.5 预检通过：${apps.length} 个应用 · JLC v${VERSION} · abi ${ABI_VERSION} · bytecode ${BYTECODE_VERSION}`);
