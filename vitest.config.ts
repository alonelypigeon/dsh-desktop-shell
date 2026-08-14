import { defineConfig } from 'vitest/config';

// 本仓库只包含桌面外壳：vitest 跑 src 下的纯函数套件
//（url / sniffer / protocol / shell-state）。
export default defineConfig({
  test: {
    exclude: ['node_modules/**', 'dist/**', 'release/**'],
  },
});
