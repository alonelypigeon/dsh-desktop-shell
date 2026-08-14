// 把非 TS 的静态资源（shell.html、鲸鱼 logo、托盘图标）复制到编译产物目录，
// 保证 dev 与 packaged 环境路径一致。
import { mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const assets = [
  ['src/shell.html', 'dist/shell.html'],
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
