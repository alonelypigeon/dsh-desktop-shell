// 端到端验证 dist/server-stop.js：
//   1) 子进程起真实 HTTP 服务器（模拟外部 DSH 实例——独立进程，与真实场景一致）
//   2) stopExternalLocalServer(url) → 应按端口定位子进程并结束
//   3) 验证端口停止响应、子进程退出
//   另验证远程地址被拒绝（不会真的杀任何进程）。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { stopExternalLocalServer } = require('../dist/server-stop.js');
const here = dirname(fileURLToPath(import.meta.url));

// 子进程 dummy 服务器：打印实际端口
const childScript = `
  const http = require('node:http');
  const s = http.createServer((q, r) => { r.end('dummy'); });
  s.listen(0, '127.0.0.1', () => { console.log('PORT=' + s.address().port); });
`;
const child = spawn(process.execPath, ['-e', childScript], { stdio: ['ignore', 'pipe', 'inherit'] });

const port = await new Promise((resolve) => {
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c.toString();
    const m = buf.match(/PORT=(\d+)/);
    if (m) resolve(Number(m[1]));
  });
});
const url = `http://127.0.0.1:${port}/`;
console.log(`dummy server on ${url} (child pid ${child.pid})`);

const probe = async () => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.status < 500;
  } catch {
    return false;
  }
};

console.log('before stop, responding:', await probe());

// 预期失败分支：远程地址必须被拒绝
const remote = await stopExternalLocalServer('https://example.com/');
console.log('remote rejected:', !remote.ok, '|', remote.detail);

// 真实停止分支
const t0 = Date.now();
const result = await stopExternalLocalServer(url);
console.log('stop result:', JSON.stringify(result));
console.log(`took ${Date.now() - t0}ms`);

const after = await probe();
console.log('after stop, responding:', after);

// 子进程退出（被 taskkill /T 结束）
await new Promise((r) => setTimeout(r, 300));
console.log('child exited:', child.exitCode !== null || child.killed);

const ok = !remote.ok && result.ok && !after;
console.log(ok ? 'E2E OK' : 'E2E FAIL');
try {
  child.kill();
} catch {
  /* ignore */
}
process.exit(ok ? 0 : 1);
