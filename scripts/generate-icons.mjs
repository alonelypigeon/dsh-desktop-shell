// 用官方鲸鱼 favicon 生成应用/托盘图标。
// 依赖 sharp（DSH 安装自带；本仓库未安装）——通过 argv 传入 sharp 入口与源 svg。
// 用法：node scripts/generate-icons.mjs <sharpPath> <whaleSvgPath> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const [, , sharpPath, svgPath, outDir] = process.argv;

if (!sharpPath || !svgPath || !outDir) {
  console.error('usage: node generate-icons.mjs <sharpPath> <whaleSvgPath> <outDir>');
  process.exit(1);
}

const sharp = require(sharpPath);
const svg = fs.readFileSync(svgPath, 'utf8');

// 存档原始鲸鱼 SVG 到输出目录
fs.writeFileSync(path.join(outDir, 'whale.svg'), svg);

// 去掉依赖 CSS 的 fill（sharp 不执行 media query），把 path 已有的 fill="#000" 换成目标色
function recolor(fill) {
  return svg.replace(/<style>[\s\S]*?<\/style>/, '').replace('fill="#000"', `fill="${fill}"`);
}

const targets = [
  ['icon.png', 512, '#4D6BFE'],
  ['tray.png', 32, '#4D6BFE'],
  ['trayTemplate.png', 32, '#000000'],
];

for (const [name, size, fill] of targets) {
  const s = recolor(fill);
  const density = Math.round((size / 50) * 72);
  await sharp(Buffer.from(s), { density })
    .resize(size, size, { fit: 'contain' })
    .png()
    .toFile(path.join(outDir, name));
  console.log(`generated ${name} (${size}px, fill=${fill})`);
}
