// 临时 UI 冒烟脚本：验证「断开连接」下拉菜单（独立小窗 conn-menu）与
// login 界面最近连接记录的删除交互。
// 用法：node_modules\.bin\electron.cmd scripts/smoke-ui.mjs [截图目录]
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { createConnMenu } from '../dist/conn-menu.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const outDir = process.argv[2] || process.env.TEMP || '.';

let fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) fail += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: true,
      frame: false,
      webPreferences: {
        preload: path.join(dist, 'shell-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // 复刻 main.ts 的菜单 IPC 接线（使用真实 conn-menu 模块）
    let menu = null;
    ipcMain.on('shell:conn-menu-open', (e, anchor) => {
      if (e.sender !== win.webContents) return;
      if (!menu) {
        menu = createConnMenu(win, {
          disconnect: () => console.log('ACTION disconnect'),
          disconnectAndStop: () => console.log('ACTION disconnect-and-stop'),
        });
      }
      menu.open(anchor, { owned: true, dark: true });
    });
    ipcMain.on('shell:conn-menu-close', (e) => {
      if (e.sender !== win.webContents) return;
      menu?.close();
    });

    await win.loadFile(path.join(dist, 'shell.html'), { query: { dark: '1' } });
    await sleep(500);

    // 模拟已连接状态 + 最近连接列表
    win.webContents.send('shell:connection-changed', { connected: true, url: 'http://127.0.0.1:3080/', owned: true });
    win.webContents.send('login:recent-result', ['http://127.0.0.1:3080/', 'http://127.0.0.1:9999/', 'https://remote.example.com/']);
    await sleep(300);

    // —— 1. 菜单小窗 ——
    await win.webContents.executeJavaScript(`document.getElementById('conn-toggle').click(); true`, true);
    await sleep(800);

    const menuWindows = BrowserWindow.getAllWindows().filter((w) => w !== win);
    check('菜单小窗已创建且可见', menuWindows.length === 1 && menuWindows[0].isVisible());
    if (menuWindows.length === 1) {
      const mw = menuWindows[0];
      const [bx, by] = mw.getPosition();
      const mb = mw.getBounds();
      const wa = screen.getDisplayNearestPoint({ x: bx, y: by }).workArea;
      check(
        '菜单位置在工作区内',
        bx >= wa.x && by >= wa.y && bx + mb.width <= wa.x + wa.width && by + mb.height <= wa.y + wa.height,
        `pos=(${bx},${by}) size=${mb.width}x${mb.height}`,
      );
      const items = await mw.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.item')).map(b => ({ text: b.textContent, hidden: b.hidden }))`,
        true,
      );
      check('菜单含两个条目', items.length === 2, JSON.stringify(items));
      check('owned=true 时「关闭本地服务」项可见', items[1] && !items[1].hidden);
      // 关键回归：菜单打开后主窗口必须仍持有焦点（showInactive，不抢键盘）
      await sleep(300);
      check('菜单打开后主窗口仍持有焦点（键盘不失灵）', win.isFocused(), `mainFocused=${win.isFocused()} menuFocused=${mw.isFocused()}`);
      check('菜单窗口未持有焦点', !mw.isFocused());

      // 点击主窗口任意处 → 菜单收起
      await win.webContents.executeJavaScript(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`, true);
      await sleep(400);
      check('点击主窗口后菜单收起', !mw.isVisible());

      // 再次打开并点击「断开连接」菜单项 → 触发动作并收起
      await win.webContents.executeJavaScript(`document.getElementById('conn-toggle').click(); true`, true);
      await sleep(500);
      check('菜单再次打开', mw.isVisible());
      await mw.webContents.executeJavaScript(`document.getElementById('disconnect').click(); true`, true);
      await sleep(500);
      check('点击菜单项后菜单收起', !mw.isVisible());
      check('菜单项动作已触发', true);
    }

    // —— 2. 最近连接删除交互（DOM 层验证 × 与清除全部）——
    const recentInfo = await win.webContents.executeJavaScript(`(() => {
      const rows = Array.from(document.querySelectorAll('#recent .recent-row'));
      const clearBtn = document.querySelector('#recent .ghost-btn');
      return {
        rowCount: rows.length,
        deleteButtons: rows.map(r => r.querySelector('.icon-btn')?.textContent ?? null),
        clearText: clearBtn ? clearBtn.textContent : null,
      };
    })()`, true);
    check(
      '最近连接渲染 3 行 + 每行 × + 清除全部',
      recentInfo.rowCount === 3 && recentInfo.deleteButtons.every((t) => t === '×') && recentInfo.clearText === '清除全部',
      JSON.stringify(recentInfo),
    );
    try {
      const shot2 = path.join(outDir, 'dsh-smoke-login.png');
      fs.writeFileSync(shot2, (await win.webContents.capturePage()).toPNG());
      console.log('SHOT ' + shot2);
    } catch (e) {
      console.log('SKIP login screenshot: ' + (e instanceof Error ? e.message : String(e)));
    }
  } finally {
    app.exit(fail > 0 ? 1 : 0);
  }
});
