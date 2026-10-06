/**
 * 生成应用图标 build/icon.png(蓝色圆角方块 + 白色对勾,256x256)
 * 纯 Node 实现,无需任何图像库。用法: node scripts/gen-icon.js
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../build');
fs.mkdirSync(outDir, { recursive: true });

// ---------- 最小 PNG 编码器 ----------
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 绘制 ----------
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const R = size * 0.22;
  const M = size * 0.03;
  const x0 = M, y0 = M, x1 = size - M, y1 = size - M;
  const top = [0x5b, 0x7c, 0xfa], bottom = [0x3f, 0x5e, 0xf0];
  const p1 = [size * 0.25, size * 0.52];
  const p2 = [size * 0.44, size * 0.71];
  const p3 = [size * 0.77, size * 0.32];
  const wHalf = size * 0.052;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const cx = x < x0 + R ? x0 + R : x > x1 - R ? x1 - R : x;
      const cy = y < y0 + R ? y0 + R : y > y1 - R ? y1 - R : y;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > R * R) continue;
      const t = (y - y0) / (y1 - y0);
      const onCheck =
        distToSeg(x, y, p1[0], p1[1], p2[0], p2[1]) <= wHalf ||
        distToSeg(x, y, p2[0], p2[1], p3[0], p3[1]) <= wHalf;
      const i = (y * size + x) * 4;
      buf[i] = onCheck ? 255 : Math.round(top[0] + (bottom[0] - top[0]) * t);
      buf[i + 1] = onCheck ? 255 : Math.round(top[1] + (bottom[1] - top[1]) * t);
      buf[i + 2] = onCheck ? 255 : Math.round(top[2] + (bottom[2] - top[2]) * t);
      buf[i + 3] = 255;
    }
  }
  return encodePng(size, size, buf);
}

fs.writeFileSync(path.join(outDir, 'icon.png'), drawIcon(256));
console.log('已生成 build/icon.png (256x256)');
