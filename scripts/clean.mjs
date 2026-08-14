// 清空编译产物目录，避免重命名/删除源文件后残留旧产物
//（例如历史上的 preload.js → shell-preload.js、prompt.js 删除）。
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(root, 'dist'), { recursive: true, force: true });
console.log('[clean] dist/ removed');
