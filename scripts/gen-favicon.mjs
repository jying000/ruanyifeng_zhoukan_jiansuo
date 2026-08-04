import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// 与 .brand-mark 样式一致
// background: linear-gradient(135deg, #4F46E5, #8B5CF6)
// 白字 "阮", font-weight 700, border-radius 12px (42px 容器)
const SIZES = [16, 32, 48];

function makePNG(size) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');

  // 透明背景（不绘制背景方块）

  // 文字：紫色阮字，撑满四周
  const fs = Math.round(size * (40 / 42));
  ctx.fillStyle = '#4F46E5';
  ctx.font = `700 ${fs}px "SimHei", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('阮', size / 2, size / 2 + size * 0.02);

  return c.toBuffer('image/png');
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 封装为 ICO（含多个 PNG）
function buildICO(pngs) {
  // 解析每个 PNG 尺寸
  const entries = pngs.map((buf) => {
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return { buf, w, h };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(entries.length, 4);

  const dirEntries = [];
  let offset = 6 + entries.length * 16;
  const imageData = [];

  entries.forEach(({ buf, w, h }) => {
    const de = Buffer.alloc(16);
    de.writeUInt8(w >= 256 ? 0 : w, 0);     // width
    de.writeUInt8(h >= 256 ? 0 : h, 1);     // height
    de.writeUInt8(0, 2);                     // color palette
    de.writeUInt8(0, 3);                     // reserved
    de.writeUInt16LE(1, 4);                  // color planes
    de.writeUInt16LE(32, 6);                 // bit count
    de.writeUInt32LE(buf.length, 8);         // size
    de.writeUInt32LE(offset, 12);            // offset
    dirEntries.push(de);
    imageData.push(buf);
    offset += buf.length;
  });

  return Buffer.concat([header, ...dirEntries, ...imageData]);
}

const pngs = SIZES.map(makePNG);
const ico = buildICO(pngs);
const out = join(root, 'favicon.ico');
writeFileSync(out, ico);
console.log('wrote', out, ico.length, 'bytes; sizes:', SIZES.join(','));
