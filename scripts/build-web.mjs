/*
 * JLC OS 应用预检：web/ 是全权内核部署形态，没有任何需要生成的 .html 产物。
 * Copyright (c) 2026 JLC contributors. MIT licensed.
 *
 *   node scripts/build-web.mjs          校验所有 web/apps/*.jlc 可编译、可装载
 *   node scripts/build-web.mjs --check  同上（npm run check 用，语义一致）
 *
 * 0.4 起，部署链路是：
 *   web/index.html（Bootloader）── fetch ──> web/apps/*.jlc（纯文本，无执行权）
 *        └── JLC.mount()：语法自愈 → 字节码编译 → VM 接管整个视口
 *
 * 因此本脚本不再产出任何文件，只在构建/CI 阶段把每个应用按它声明的策略档
 * 完整编译一遍并做 .jbc 往返验证，把语法错误与策略越权挡在部署之前。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ABI_VERSION,
  BYTECODE_VERSION,
  VERSION,
  checkPermissions,
  encodeModule,
  loadModule,
  resolvePolicy,
} from "../jlc-vm.js";
import { compileAst } from "../jlc-compiler.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WEB = join(ROOT, "web");
const APPS = join(WEB, "apps");
const PROFILES = ["strict", "open", "trusted"];
const CHECK = process.argv.includes("--check");

/* ------------------------------------------------------------------ */
/* 应用页元数据（沿用 @jlc-page 注释块）                               */
/* ------------------------------------------------------------------ */

function readMeta(source, name) {
  const block = /^\/\*\*?\s*@jlc-page([\s\S]*?)\*\//.exec(source);
  const meta = { name, title: name, summary: "", policy: "open", isolation: "soft", fault: "degrade", capabilities: [], demo: "" };
  if (!block) return meta;
  for (const line of block[1].split("\n")) {
    const match = /^\s*\*\s*([A-Za-z-]+)\s*:([^*]*)$/.exec(line);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (key === "capabilities") meta.capabilities = value ? value.split(/[,\s]+/).filter(Boolean) : [];
    else if (key in meta) meta[key] = value;
  }
  return meta;
}

/** 编译期检查：声明档下必须挂得住（manifest 模式给出聚合预检清单）。 */
function buildApp(source, name, policy) {
  const { module } = compileAst(source, { sourceName: `web/apps/${name}.jlc`, policy, policyMode: "manifest" });
  const bytes = encodeModule(module);
  const reload = loadModule(bytes, { sourceName: `${name}.jbc` });
  const requirements = module.requirements ?? [];
  if ((reload.requirements ?? []).length !== requirements.length) throw new Error(`${name}: .jbc 往返后接口清单不一致`);
  const denials = checkPermissions(requirements, resolvePolicy(policy));
  if (denials.length) {
    throw new Error(`${name}: 在声明的 ${policy} 档下有被收回的接口：${denials.map((item) => `${item.kind}:${item.detail}`).join("、")}`);
  }
  return { module, requirements, bytes };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */

function main() {
  // 0.4 架构红线：web/ 内不允许残留任何 .html 业务页（Bootloader 除外）。
  const stray = readdirSync(APPS).filter((file) => file.endsWith(".html"));
  if (stray.length) {
    throw new Error(`web/apps/ 里出现 .html 业务页（${stray.join("、")}）：0.4 起业务一律以纯文本 .jlc 存放`);
  }

  const apps = readdirSync(APPS)
    .filter((file) => file.endsWith(".jlc"))
    .sort()
    .map((file) => file.slice(0, -4));
  if (!apps.length) throw new Error("web/apps/ 里没有任何 .jlc 应用");

  const summary = [];
  for (const name of apps) {
    const source = readFileSync(join(APPS, `${name}.jlc`), "utf8");
    const meta = readMeta(source, name);
    if (!PROFILES.includes(meta.policy)) throw new Error(`${name}: 未知策略档 ${meta.policy}`);
    let built;
    try {
      built = buildApp(source, name, meta.policy);
    } catch (error) {
      throw new Error(`${name}: 按 ${meta.policy} 档预检失败\n${error.message}`);
    }
    summary.push({
      name,
      policy: meta.policy,
      isolation: meta.isolation,
      functions: built.module.functions.length,
      pool: built.module.pool.length,
      bytes: built.bytes.length,
    });
  }

  console.log(
    `${CHECK ? "预检" : "预检"}通过：${apps.length} 个 .jlc 应用 · JLC v${VERSION} · abi ${ABI_VERSION} · bytecode ${BYTECODE_VERSION}`,
  );
  for (const item of summary) {
    console.log(`  ${item.name.padEnd(16)} ${item.policy.padEnd(8)} ${String(item.bytes).padStart(5)} B · ${item.functions} functions · ${item.pool} pool`);
  }
}

main();
