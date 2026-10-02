/**
 * FrameLens 品牌图标生成器
 * 纯 Node 实现：手写 PNG 编码 + ICO 封装，不依赖任何第三方库或外部素材。
 *
 *   node scripts/make-icon.mjs
 *
 * 产物：
 *   build/icon.png  512x512  （Linux / 窗口图标）
 *   build/icon.ico  多尺寸   （Windows 安装包与任务栏）
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * 图形描述
 * ------------------------------------------------------------------ */

const BRAND = {
  // 主渐变：紫罗兰 -> 青蓝
  from: [0x6f, 0x5c, 0xf7],
  to: [0x21, 0xd4, 0xee],
  // 强调色（内部小三角）
  accent: [0x0b, 0x10, 0x22],
  plate: [0xff, 0xff, 0xff],
};

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** 圆角矩形：返回 0~1 的覆盖强度（已按 SDF 做 1px 抗锯齿） */
function roundedRect(x, y, w, h, r, px, py) {
  const cx = w / 2;
  const cy = h / 2;
  const dx = Math.abs(px - cx) - (w / 2 - r);
  const dy = Math.abs(py - cy) - (h / 2 - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  const outside = Math.hypot(ax, ay);
  const inside = Math.min(Math.max(dx, dy), 0);
  const dist = outside + inside - r;
  return clamp01(0.5 - dist);
}

/** 圆环（镜头）：返回 0~1 */
function ring(x, y, r, thickness, px, py) {
  const d = Math.abs(Math.hypot(px - x, py - y) - r) - thickness / 2;
  return clamp01(0.5 - d);
}

/**
 * 三角形（半平面法），顶点按「屏幕坐标顺时针」给出。
 * y 轴向下时，顺时针环绕的内部点对所有边都满足 cross > 0，
 * 取各边有向距离的最小值即可近似得到「内部为正」的距离场。
 */
function triangle(a, b, c, px, py) {
  const edges = [
    [a, b],
    [b, c],
    [c, a],
  ];
  let m = Infinity;
  for (const [p, q] of edges) {
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const len = Math.hypot(ex, ey) || 1;
    const cross = (ex * (py - p[1]) - ey * (px - p[0])) / len;
    m = Math.min(m, cross);
  }
  return clamp01(0.5 + m);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 播放三角的归一化顶点（顺时针） */
const TRI = [
  [0.430, 0.360],
  [0.665, 0.5],
  [0.430, 0.640],
];

/** 以 4x4 超采样渲染单个像素，返回三层的覆盖强度 */
function shade(px, py, s) {
  const SS = 4;
  const n = SS * SS;
  let bg = 0;
  let lens = 0;
  let tri = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = px + (sx + 0.5) / SS;
      const y = py + (sy + 0.5) / SS;
      if (roundedRect(x, y, s, s, s * 0.235, s / 2, s / 2) > 0.5) bg++;
      if (ring(s * 0.5, s * 0.5, s * 0.255, s * 0.062, x, y) > 0.5) lens++;
      if (triangle(
        [TRI[0][0] * s, TRI[0][1] * s],
        [TRI[1][0] * s, TRI[1][1] * s],
        [TRI[2][0] * s, TRI[2][1] * s],
        x,
        y,
      ) > 0.5) tri++;
    }
  }
  return { bg: bg / n, lens: lens / n, tri: tri / n };
}

/** 生成 size x size 的 RGBA 像素缓冲 */
function render(size) {
  const s = size;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const coverage = shade(x, y, s);
      // 背景渐变（对角线）
      const t = clamp01((x / s) * 0.6 + (y / s) * 0.4);
      const grad = mix(BRAND.from, BRAND.to, t);
      // 镜片环 + 播放三角叠加到渐变上
      const glow = clamp01(coverage.lens + coverage.tri);
      const rgb = mix(grad, BRAND.plate, glow * 0.96);
      const a = coverage.bg;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(rgb[0]);
      buf[i + 1] = Math.round(rgb[1]);
      buf[i + 2] = Math.round(rgb[2]);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

/* ------------------------------------------------------------------ *
 * PNG 编码
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前置 filter 字节（0 = None）
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * ICO 封装（内嵌 PNG）
 * ------------------------------------------------------------------ */

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((entry, i) => {
    const p = i * 16;
    dir[p] = entry.size >= 256 ? 0 : entry.size;
    dir[p + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[p + 2] = 0;
    dir[p + 3] = 0;
    dir.writeUInt16LE(1, p + 4);
    dir.writeUInt16LE(32, p + 6);
    dir.writeUInt32LE(entry.png.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

const sizes = [256, 128, 64, 48, 32, 16];
const rendered = new Map(sizes.map((s) => [s, encodePng(s, render(s))]));

mkdirSync(resolve(ROOT, 'build'), { recursive: true });
mkdirSync(resolve(ROOT, 'src/assets'), { recursive: true });

writeFileSync(resolve(ROOT, 'build/icon.png'), encodePng(512, render(512)));
writeFileSync(
  resolve(ROOT, 'build/icon.ico'),
  encodeIco(sizes.map((s) => ({ size: s, png: rendered.get(s) }))),
);

// 应用内使用的矢量图标（登录页 / 关于页）
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6F5CF7"/>
      <stop offset="1" stop-color="#21D4EE"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="256" height="256" rx="60" fill="url(#g)"/>
  <circle cx="128" cy="128" r="65" fill="none" stroke="#FFFFFF" stroke-width="16"/>
  <path d="M109 91 L109 165 L170 128 Z" fill="#FFFFFF"/>
</svg>
`;
writeFileSync(resolve(ROOT, 'src/assets/logo.svg'), svg);

console.log('[icons] build/icon.png / build/icon.ico / src/assets/logo.svg 已生成');
