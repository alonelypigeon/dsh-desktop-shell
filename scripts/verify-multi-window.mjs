// 多窗口启动回归（v1.0.1）：恢复 ≥2 个会话窗口时不允许崩溃。
//
// 事故：v1.0.0 把窗口级 IPC 注册放进了每会话路径，ipcMain.handle 对同一
// 通道注册两次会 throw（'Attempted to register a second handler for
// shell:shortcuts-get'）。单窗口冒烟测不出来；复现需要**第一个恢复的
// URL 真正连接成功**（否则第二个 URL 会复用同一个 login 窗口，不新建
// Session），所以本脚本先起一个本地假 DSH。
//
// 用法：node_modules\.bin\electron.cmd scripts/verify-multi-window.mjs [dist 目录]
// 退出码：0 = 恢复了 ≥2 个窗口且无错误对话框；42 = 启动期错误对话框；1 = 其他失败。
import { app, dialog, BrowserWindow } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', process.argv[2] || 'dist');
const ALIVE_PORT = 59901;
const DEAD_PORT = 59902;

// 崩溃→对话框 变 退出码（必须在 require dist/main.js 之前打补丁）。
dialog.showErrorBox = (title, message) => {
  console.log(`DIALOG ${title}: ${message}`);
  app.exit(42);
};

// 隔离状态：临时 userData + 临时共享配置；第一条恢复记录指向假 DSH（能连上），
// 第二条指向死端口（新建 Session —— 事故触发点）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-multi-window-'));
app.setPath('userData', tmp);
process.env.DSH_DESKTOP_CONFIG = path.join(tmp, 'desktop-shell.json');
delete process.env.DSH_URL;
fs.writeFileSync(
  path.join(tmp, 'shell-state.json'),
  JSON.stringify({
    sessionWindows: [`http://127.0.0.1:${ALIVE_PORT}/`, `http://127.0.0.1:${DEAD_PORT}/`],
  }),
);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>dsh-multi-window-fixture</title>ok');
});
await new Promise((resolve) => server.listen(ALIVE_PORT, '127.0.0.1', resolve));

// dist/main.js 是 CJS，Electron 主进程 require 无碍。
const { createRequire } = await import('node:module');
createRequire(path.join(dist, 'main.js'))(path.join(dist, 'main.js'));

// 恢复是顺序进行的：#1 连接成功（毫秒级）后 #2 才会新建 Session；轮询等
// 窗口数 ≥2 出结论，30s 超时视为失败。
const started = Date.now();
let settled = false;
const poll = setInterval(() => {
  const wins = BrowserWindow.getAllWindows().length;
  if (wins < 2 && Date.now() - started < 30_000) return;
  settled = true;
  clearInterval(poll);
  server.close();
  console.log(`WINDOWS ${wins}`);
  console.log(wins >= 2 ? 'PASS 多窗口恢复无崩溃' : 'FAIL 窗口数不足 2');
  app.exit(wins >= 2 ? 0 : 1);
}, 500);
setTimeout(() => {
  if (!settled) {
    server.close();
    console.log('FAIL 30s 内未恢复出 2 个窗口');
    app.exit(1);
  }
}, 31_000);
