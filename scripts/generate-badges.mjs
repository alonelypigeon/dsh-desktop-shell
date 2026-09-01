// 生成 Windows 任务栏未读角标图（build/badges/badge-1.png … badge-99.png、badge-99plus.png）。
// 纯 Node 实现（zlib + 手写 PNG 编码），无需 canvas 依赖；主进程按未读数
// createFromPath 加载对应图片交给 setOverlayIcon（macOS/Linux 走 setBadgeCount，
// 不用这些图）。改动配色/尺寸后重新运行本脚本即可。
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'build', 'badges');

const SIZE = 48; // 角标源图尺寸（setOverlayIcon 自行缩放到任务栏角标位）
const RADIUS = 22;
const BG = [229, 72, 77]; // red-600：与连接状态点同族的醒目「未读」色
const FG = [255, 255, 255];

// 5x7 点阵字模（数字与 +）
const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
};

// —— PNG 编码（RGBA 8bit，无压缩依赖外的第三方库） ——

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
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h); // 每行前置 filter 字节 0
  for (let y = 0; y < h; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// —— 角标绘制：实心圆（1px 软边）+ 居中点阵数字 ——

function renderBadge(text) {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const c = (SIZE - 1) / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - c, y - c);
      const cov = Math.max(0, Math.min(1, RADIUS + 0.5 - d));
      if (cov <= 0) continue;
      const i = (y * SIZE + x) * 4;
      rgba[i] = BG[0];
      rgba[i + 1] = BG[1];
      rgba[i + 2] = BG[2];
      rgba[i + 3] = Math.round(cov * 255);
    }
  }
  const chars = [...text];
  // 位数多时缩小字模，保证数字完整落在圆内
  const scale = chars.length === 1 ? 5 : chars.length === 2 ? 3 : 2;
  const cellW = chars.length * 5 + (chars.length - 1); // 字符 5 列 + 1 列间距
  const w = cellW * scale;
  const h = 7 * scale;
  const ox = Math.round((SIZE - w) / 2);
  const oy = Math.round((SIZE - h) / 2);
  chars.forEach((ch, ci) => {
    const glyph = FONT[ch];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const i = ((oy + gy * scale + sy) * SIZE + (ox + (ci * 6 + gx) * scale + sx)) * 4;
            rgba[i] = FG[0];
            rgba[i + 1] = FG[1];
            rgba[i + 2] = FG[2];
            rgba[i + 3] = 255;
          }
        }
      }
    }
  });
  return encodePng(SIZE, SIZE, rgba);
}

mkdirSync(outDir, { recursive: true });
let count = 0;
for (let n = 1; n <= 99; n++) {
  writeFileSync(join(outDir, `badge-${n}.png`), renderBadge(String(n)));
  count++;
}
writeFileSync(join(outDir, 'badge-99plus.png'), renderBadge('99+'));
count++;
console.log(`[generate-badges] ${count} 个角标图 -> build/badges/`);
