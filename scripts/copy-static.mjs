// 把非 TS 的静态资源（shell.html、鲸鱼 logo、托盘图标、未读角标）复制到编译产物目录，
// 保证 dev 与 packaged 环境路径一致。
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const assets = [
  ['src/shell.html', 'dist/shell.html'],
  ['src/shell.css', 'dist/shell.css'],
  ['src/shell.js', 'dist/shell.js'],
  ['build/icon.png', 'dist/icon.png'],
  ['build/whale.svg', 'dist/whale.svg'],
  ['build/whale-white.svg', 'dist/whale-white.svg'],
  ['build/tray.png', 'dist/tray.png'],
  ['build/trayTemplate.png', 'dist/trayTemplate.png'],
];

mkdirSync(join(root, 'dist'), { recursive: true });
for (const [from, to] of assets) {
  copyFileSync(join(root, from), join(root, to));
  console.log(`[copy-static] ${from} -> ${to}`);
}

// 未读角标图（scripts/generate-badges.mjs 生成，setOverlayIcon 按计数选用）
const badgesSrc = join(root, 'build', 'badges');
const badgesDst = join(root, 'dist', 'badges');
mkdirSync(badgesDst, { recursive: true });
for (const f of readdirSync(badgesSrc)) {
  if (!f.endsWith('.png')) continue;
  copyFileSync(join(badgesSrc, f), join(badgesDst, f));
}
console.log(`[copy-static] build/badges/*.png -> dist/badges/`);
