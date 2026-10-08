/**
 * 生成安卓 App 各密度图标(ic_launcher 与 ic_launcher_round)
 * 复用 gen-icon.js 的绘制逻辑(蓝色渐变圆角方块 + 白色对勾)
 * 用法: node scripts/gen-android-icons.js
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resDir = path.resolve(__dirname, '../android/app/src/main/res');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

/** 到圆角矩形的带符号距离(内部为负,外部为正) */
function distToRRect(px, py, l, t, r, b, rad) {
  const cx = Math.max(l + rad, Math.min(px, r - rad));
  const cy = Math.max(t + rad, Math.min(py, b - rad));
  return Math.hypot(px - cx, py - cy) - rad;
}

/** 苹果风格极简图标(方案B):纯 iOS 蓝(#007AFF)圆角方块 + 白色对勾 */
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const R = size * 0.225;
  const M = size * 0.02;
  const x0 = M, y0 = M, x1 = size - M, y1 = size - M;
  const p1 = [size * 0.36, size * 0.53];
  const p2 = [size * 0.47, size * 0.64];
  const p3 = [size * 0.66, size * 0.38];
  const wHalf = size * 0.07;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const cx = x < x0 + R ? x0 + R : x > x1 - R ? x1 - R : x;
      const cy = y < y0 + R ? y0 + R : y > y1 - R ? y1 - R : y;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > R * R) continue;
      const onCheck =
        distToSeg(x, y, p1[0], p1[1], p2[0], p2[1]) <= wHalf ||
        distToSeg(x, y, p2[0], p2[1], p3[0], p3[1]) <= wHalf;
      const i = (y * size + x) * 4;
      buf[i] = onCheck ? 255 : 0x00;
      buf[i + 1] = onCheck ? 255 : 0x7a;
      buf[i + 2] = onCheck ? 255 : 0xff;
      buf[i + 3] = 255;
    }
  }
  return encodePng(size, size, buf);
}

const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

// 删除自适应图标 XML(让它直接用 PNG)
const anydpi = path.join(resDir, 'mipmap-anydpi-v26');
if (fs.existsSync(anydpi)) fs.rmSync(anydpi, { recursive: true, force: true });

for (const [d, size] of Object.entries(DENSITIES)) {
  const dir = path.join(resDir, `mipmap-${d}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), drawIcon(size));
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), drawIcon(size));
  console.log(`已生成 mipmap-${d} (${size}x${size})`);
}
console.log('✅ 安卓图标全部生成');
