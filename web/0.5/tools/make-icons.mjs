/*
 * JLC OS 0.5 · 图标生成器（零依赖：手写 PNG 编码 + zlib deflate）
 *
 *   node web/0.5/tools/make-icons.mjs
 *
 * 设计：深色底 + 3×3「应用网格」，左上格为内核强调色（teal），
 * 与 0.4 的 data: SVG 横条同源配色。maskable 版全出血（安全区内收图形）。
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(new URL(import.meta.url))), "..", "icons");

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- 绘制 ---------------- */

function inRounded(x, y, size, radius) {
  const r = radius;
  if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r;
  if (x >= size - r && y < r) return (x - (size - 1 - r)) ** 2 + (y - r) ** 2 <= r * r;
  if (x < r && y >= size - r) return (x - r) ** 2 + (y - (size - 1 - r)) ** 2 <= r * r;
  if (x >= size - r && y >= size - r) return (x - (size - 1 - r)) ** 2 + (y - (size - 1 - r)) ** 2 <= r * r;
  return true;
}

/** 简单 SDF 圆形徽章（中心 cx,cy 半径 r，1px 抗锯齿）。 */
function circleAlpha(x, y, cx, cy, r) {
  const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) - r;
  return Math.max(0, Math.min(1, 0.5 - d));
}

function render(size, { maskable }) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [18, 20, 26]; // #12141a
  const teal = [23, 184, 166]; // #17b8a6
  const paper = [230, 228, 216];
  const inkDim = [122, 128, 140];

  const corner = maskable ? 0 : size * 0.225;
  // 网格参数
  const inset = size * (maskable ? 0.24 : 0.18);
  const gap = size * 0.075;
  const cell = (size - inset * 2 - gap * 2) / 3;
  const cellRadius = cell * 0.28;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      if (!maskable && !inRounded(x, y, size, corner)) {
        rgba[i + 3] = 0;
        continue;
      }
      rgba[i] = bg[0];
      rgba[i + 1] = bg[1];
      rgba[i + 2] = bg[2];
      rgba[i + 3] = 255;

      // 3×3 网格
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 3; col += 1) {
          const x0 = inset + col * (cell + gap);
          const y0 = inset + row * (cell + gap);
          const lx = x - x0;
          const ly = y - y0;
          if (lx < 0 || ly < 0 || lx >= cell || ly >= cell) continue;
          const inside = inRounded(lx, ly, Math.ceil(cell), cellRadius);
          if (!inside) continue;
          // 抗锯齿边缘
          let alpha = 1;
          const edge = Math.min(lx, cell - lx, ly, cell - ly);
          if (edge < 1) alpha = edge;
          // 左上格 = 内核（teal）；右下格 = 强调圆点；其余 = 纸张
          let color = paper;
          if (row === 0 && col === 0) color = teal;
          else if (row === 2 && col === 2) color = inkDim;
          rgba[i] = Math.round(bg[0] * (1 - alpha) + color[0] * alpha);
          rgba[i + 1] = Math.round(bg[1] * (1 - alpha) + color[1] * alpha);
          rgba[i + 2] = Math.round(bg[2] * (1 - alpha) + color[2] * alpha);
        }
      }

      // 中央格内的圆点（内核心跳）
      const cx = inset + cell + gap + cell * 0.5; // 中央格中心
      const cy = inset + cell + gap + cell * 0.5;
      const a = circleAlpha(x, y, cx, cy, cell * 0.22);
      if (a > 0) {
        rgba[i] = Math.round(rgba[i] * (1 - a) + teal[0] * a);
        rgba[i + 1] = Math.round(rgba[i + 1] * (1 - a) + teal[1] * a);
        rgba[i + 2] = Math.round(rgba[i + 2] * (1 - a) + teal[2] * a);
      }
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "icon-192.png"), render(192, { maskable: false }));
writeFileSync(join(OUT, "icon-512.png"), render(512, { maskable: false }));
writeFileSync(join(OUT, "maskable-512.png"), render(512, { maskable: true }));
console.log("icons →", OUT);
