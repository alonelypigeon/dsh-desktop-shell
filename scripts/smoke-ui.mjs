// 临时 UI 冒烟脚本：验证 shell 页面在外置 shell.css / shell.js + 收紧后的
// CSP（script-src 'self'，无 unsafe-inline）下正常工作、连接状态竞态自愈、
// 标题栏新按钮（置顶 / 服务器▾ / ⋯）的绑定、login 界面最近连接记录的
// 删除交互，以及快捷键设置面板 / 页面内查找栏的桥接；
// 下拉菜单本身为原生 Menu.popup（无子窗口页面），模板构建由
// titlebar-menus.test.ts / verify-url.mjs 覆盖。
// 用法：node_modules\.bin\electron.cmd scripts/smoke-ui.mjs [截图目录]
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import { buildDisconnectMenuItems, buildServerMenuItems, buildMoreMenuItems } from '../dist/titlebar-menus.js';
import { pushShellUiState } from '../dist/shell-ui-state.js';
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, SHORTCUT_META, recordingOutcome, matchContentShortcut, normalizeAccelerator } from '../dist/shortcuts.js';
import { stepZoom, normalizeZoom, formatFindCount } from '../dist/view-controls.js';

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

    // 标题栏菜单 IPC：记录 (name, anchor)
    const menuCalls = [];
    ipcMain.on('shell:open-titlebar-menu', (e, name, anchor) => {
      if (e.sender !== win.webContents) return;
      menuCalls.push({ name, anchor });
    });
    let pinToggles = 0;
    ipcMain.on('shell:toggle-always-on-top', (e) => {
      if (e.sender !== win.webContents) return;
      pinToggles += 1;
    });

    // —— 快捷键设置面板 / 页面内查找的桥接桩（模拟 main.ts 行为） ——
    let shortcutsState = {
      bindings: { ...DEFAULT_SHORTCUTS },
      actions: SHORTCUT_ACTIONS,
      meta: SHORTCUT_META,
      conflicts: [],
      envOverride: false,
      isMac: false,
    };
    const recordCalls = [];
    const findCalls = [];
    const findNextCalls = [];
    const settingsCloseCalls = [];
    ipcMain.handle('shell:shortcuts-get', (e) => {
      if (e.sender !== win.webContents) return null;
      win.webContents.send('shell:shortcuts-state', shortcutsState);
      return true;
    });
    ipcMain.handle('shell:shortcuts-record', (e, action, ev) => {
      if (e.sender !== win.webContents) return { ok: false };
      recordCalls.push({ action, ev });
      const outcome = recordingOutcome(ev);
      if (outcome.kind === 'cancel') return { ok: true, cancelled: true };
      if (outcome.kind === 'ok') {
        shortcutsState = { ...shortcutsState, bindings: { ...shortcutsState.bindings, [action]: outcome.accelerator } };
        win.webContents.send('shell:shortcuts-state', shortcutsState);
      }
      return { ok: true };
    });
    ipcMain.handle('shell:shortcuts-reset', (e) => {
      if (e.sender !== win.webContents) return { ok: false };
      return { ok: true };
    });
    ipcMain.on('shell:settings-close', (e) => {
      if (e.sender !== win.webContents) return;
      settingsCloseCalls.push(1);
      // 与 main.ts closeShortcutsSettings 一致：回发隐藏
      win.webContents.send('shell:settings-visible', false);
    });
    ipcMain.on('shell:find', (e, text) => {
      if (e.sender !== win.webContents) return;
      findCalls.push(text);
    });
    ipcMain.on('shell:find-next', (e, dir) => {
      if (e.sender !== win.webContents) return;
      findNextCalls.push(dir);
    });

    // —— 0. 竞态回归（真实场景复现）：connectTo 对本机服务几毫秒完成，
    //    attachContentView 的状态消息在渲染器就绪前发出会被静默丢弃。
    //    这里在 loadFile 完成前抢发（与真实时序一致），并用与 main.ts
    //    did-finish-load 完全相同的 pushShellUiState 自愈路径重发。
    //    若竞态修复缺失（无重发），下面的断言必失败。
    const loadPromise = win.loadFile(path.join(dist, 'shell.html'), { query: { dark: '1' } });
    // 抢发（此刻 shell.js 必然尚未注册监听器 → 丢弃）
    win.webContents.send('login:visible', false);
    win.webContents.send('shell:connection-changed', { connected: true, url: 'http://127.0.0.1:3080/', owned: true });
    win.webContents.send('shell:maximize-changed', true);
    // 与 main.ts createShellWindow 相同的自愈接线
    win.webContents.on('did-finish-load', () => {
      pushShellUiState(win.webContents, {
        connectedUrl: 'http://127.0.0.1:3080/',
        owned: true,
        maximized: true,
        alwaysOnTop: true,
      });
    });
    await loadPromise;
    await sleep(600);
    const raceCheck = await win.webContents.executeJavaScript(`(() => ({
      loginVisible: document.getElementById('login').style.display !== 'none',
      connVisible: !document.getElementById('conn').hidden,
      connUrl: document.getElementById('conn-url').textContent,
      restoreIconShown: getComputedStyle(document.querySelector('.ico-restore')).display !== 'none',
      maxIconHidden: getComputedStyle(document.querySelector('.ico-max')).display === 'none',
      pinActive: document.getElementById('pin').classList.contains('active'),
      restoreIconRects: document.querySelectorAll('.ico-restore rect').length,
    }))()`, true);
    check('竞态自愈：加载前推送的状态在就绪后正确渲染（连接区可见）', raceCheck.connVisible, JSON.stringify(raceCheck));
    check('竞态自愈：login 界面已隐藏', !raceCheck.loginVisible);
    check('竞态自愈：连接地址正确', raceCheck.connUrl === 'http://127.0.0.1:3080/', raceCheck.connUrl);
    check('竞态自愈：最大化图标状态同步（还原图标显示）', raceCheck.restoreIconShown && raceCheck.maxIconHidden);
    check('竞态自愈：置顶按钮激活态同步', raceCheck.pinActive);
    check('还原图标为双矩形标准造型', raceCheck.restoreIconRects === 2, 'rects=' + raceCheck.restoreIconRects);

    // —— 0.5 连接状态可视化：断线重连中状态点变黄，恢复后回绿 ——
    win.webContents.send('shell:phase-changed', 'reconnecting');
    await sleep(120);
    const reconnColor = await win.webContents.executeJavaScript(
      `getComputedStyle(document.querySelector('.conn-url'), '::before').backgroundColor`,
      true,
    );
    check('断线重连中：状态点变黄', reconnColor === 'rgb(245, 158, 11)', reconnColor);
    win.webContents.send('shell:phase-changed', 'connected');
    await sleep(120);
    const connColor = await win.webContents.executeJavaScript(
      `getComputedStyle(document.querySelector('.conn-url'), '::before').backgroundColor`,
      true,
    );
    check('恢复连接：状态点回绿', connColor === 'rgb(52, 211, 153)', connColor);

    // —— 1. 标题栏菜单按钮（断开 / 服务器 / 更多）——
    await win.webContents.executeJavaScript(`document.getElementById('conn-toggle').click(); true`, true);
    await win.webContents.executeJavaScript(`document.getElementById('server-menu').click(); true`, true);
    await win.webContents.executeJavaScript(`document.getElementById('more-menu').click(); true`, true);
    await sleep(200);
    check(
      '三个菜单按钮都通过 IPC 发送了正确的名称与锚点',
      menuCalls.length === 3 &&
        menuCalls[0].name === 'disconnect' &&
        menuCalls[1].name === 'server' &&
        menuCalls[2].name === 'more' &&
        menuCalls.every((c) => typeof c.anchor?.x === 'number' && typeof c.anchor?.height === 'number'),
      JSON.stringify(menuCalls.map((c) => c.name)),
    );

    // —— 2. 置顶按钮：点击触发 toggle IPC ——
    await win.webContents.executeJavaScript(`document.getElementById('pin').click(); true`, true);
    await sleep(150);
    check('置顶按钮点击触发 toggle IPC', pinToggles === 1, 'toggles=' + pinToggles);

    // —— 3. 菜单模板（三组，覆盖 owned/外部本机/远程连接形态）——
    const noop = () => {};
    check(
      'disconnect 模板：owned/外部本机各两项、远程一项',
      buildDisconnectMenuItems(
        { owned: true, externalLocal: false },
        { disconnect: noop, disconnectAndStop: noop, disconnectAndStopServer: noop },
      ).length === 2 &&
        buildDisconnectMenuItems(
          { owned: false, externalLocal: true },
          { disconnect: noop, disconnectAndStop: noop, disconnectAndStopServer: noop },
        ).length === 2 &&
        buildDisconnectMenuItems(
          { owned: false, externalLocal: false },
          { disconnect: noop, disconnectAndStop: noop, disconnectAndStopServer: noop },
        ).length === 1,
    );
    const serverItems = buildServerMenuItems(
      { ownedRunning: false, connectedUrl: 'http://127.0.0.1:3080/', accelerators: DEFAULT_SHORTCUTS },
      {
        startLocal: noop,
        stopLocal: noop,
        switchServer: noop,
        reload: noop,
        reloadHard: noop,
        openInBrowser: noop,
      },
    );
    check(
      'server 模板：含启动/停止(禁用)/切换/重载×2(可用+加速器)/浏览器打开',
      serverItems.length === 7 &&
        serverItems.find((i) => i.label?.includes('停止'))?.enabled === false &&
        serverItems.find((i) => i.label === '重新加载页面')?.enabled === true &&
        serverItems.find((i) => i.label === '重新加载页面')?.accelerator === 'CommandOrControl+R',
      JSON.stringify(serverItems.map((i) => i.label)),
    );
    const moreItems = buildMoreMenuItems(
      { zoomFactor: 1.25, accelerators: DEFAULT_SHORTCUTS, dnd: false },
      {
        palette: noop,
        zoomIn: noop,
        zoomOut: noop,
        zoomReset: noop,
        shortcuts: noop,
        toggleDnd: noop,
        exportConnections: noop,
        importConnections: noop,
        showDiagnostics: noop,
        checkUpdates: noop,
        about: noop,
        quit: noop,
      },
    );
    const zoomSub = moreItems.find((i) => typeof i.label === 'string' && i.label.startsWith('缩放'));
    check(
      'more 模板：命令面板/检查更新/关于/快捷键设置/勿扰/缩放子菜单(125% + 3 项)/退出',
      moreItems.length === 12 &&
        moreItems.some((i) => i.label === '命令面板…' && i.accelerator === 'CommandOrControl+K') &&
        moreItems.some((i) => i.label === '快捷键设置…') &&
        moreItems.find((i) => i.label === '勿扰模式（静默通知）')?.checked === false &&
        zoomSub?.label === '缩放 125%' &&
        zoomSub?.submenu?.length === 3,
      JSON.stringify(moreItems.map((i) => i.label)),
    );

    // —— 3.5 快捷键 / 缩放纯函数（dist 产物） ——
    check(
      'shortcuts 纯函数：录制归一 + 默认绑定命中',
      recordingOutcome({ key: 'k', control: true, shift: true }).kind === 'ok' &&
        recordingOutcome({ key: 'k', control: true, shift: true }).accelerator === 'CommandOrControl+Shift+K' &&
        recordingOutcome({ key: 'Escape' }).kind === 'cancel' &&
        recordingOutcome({ key: 'Backspace' }).kind === 'clear' &&
        matchContentShortcut(DEFAULT_SHORTCUTS, { key: 'f', control: true }) === 'find' &&
        normalizeAccelerator('Ctrl+Shift+D') === 'CommandOrControl+Shift+D',
    );
    check(
      'view-controls 纯函数：缩放步进 + 查找计数',
      stepZoom(1, 'in') === 1.1 && normalizeZoom(9) === 2 && formatFindCount(3, 17) === '3/17' && formatFindCount(0, 0) === '无结果',
    );

    // —— 4. 外置脚本在收紧后的 CSP 下正常执行（最近连接渲染）——
    win.webContents.send('login:recent-result', ['http://127.0.0.1:3080/', 'http://127.0.0.1:9999/', 'https://remote.example.com/']);
    await sleep(300);
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

    // —— 5. 外置样式表生效（CSP style-src 'self' 下 <link> 可加载）——
    const styleOk = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.conn-url');
      if (!el) return 'missing';
      return getComputedStyle(el, '::before').width;
    })()`, true);
    check('外置 shell.css 生效（conn-url::before 有尺寸）', styleOk === '7px', 'computed width=' + JSON.stringify(styleOk));

    // —— 6. 快捷键设置面板：打开 → 渲染 7 行 → 录制（合成 keydown）→ 取消 ——
    win.webContents.send('shell:settings-visible', true);
    await sleep(400); // 面板收到可见后 invoke get → 服务端推送 state → 渲染
    const settingsInfo = await win.webContents.executeJavaScript(`(() => ({
      visible: !document.getElementById('settings').hidden,
      rowCount: document.querySelectorAll('#settings-groups .sc-row').length,
      firstBind: document.querySelector('#settings-groups .sc-row .sc-bind')?.textContent ?? null,
      envHintHidden: document.getElementById('settings-env-hint').hidden,
    }))()`, true);
    check(
      '快捷键面板：打开后渲染 8 个动作（含命令面板） + 全局热键显示 Ctrl+Shift+D',
      settingsInfo.visible && settingsInfo.rowCount === 8 && settingsInfo.firstBind === 'Ctrl+Shift+D' && settingsInfo.envHintHidden,
      JSON.stringify(settingsInfo),
    );

    // 点击第一行绑定按钮进入录制态 → 合成 Ctrl+Shift+K → 主进程收到原始按键
    await win.webContents.executeJavaScript(`document.querySelector('#settings-groups .sc-row .sc-bind').click(); true`, true);
    await sleep(100);
    const recStart = await win.webContents.executeJavaScript(`(() => ({
      recording: document.querySelector('#settings-groups .sc-row .sc-bind').classList.contains('recording'),
    }))()`, true);
    check('录制态：点击绑定按钮进入录制（recording 高亮）', recStart.recording === true, JSON.stringify(recStart));

    await win.webContents.executeJavaScript(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true, bubbles: true })); true`,
      true,
    );
    await sleep(250);
    check(
      '录制：合成 Ctrl+Shift+K → IPC 收到原始按键并判定为 ok',
      recordCalls.length === 1 &&
        recordCalls[0].action === 'global-toggle-window' &&
        recordCalls[0].ev.key === 'K' &&
        recordCalls[0].ev.control === true,
      JSON.stringify(recordCalls),
    );
    const afterRecord = await win.webContents.executeJavaScript(`(() => ({
      bind: document.querySelector('#settings-groups .sc-row .sc-bind')?.textContent ?? null,
      recording: document.querySelector('#settings-groups .sc-row .sc-bind').classList.contains('recording'),
    }))()`, true);
    check(
      '录制成功：onState 重渲染为新绑定 Ctrl+Shift+K 并退出录制态',
      afterRecord.bind === 'Ctrl+Shift+K' && afterRecord.recording === false,
      JSON.stringify(afterRecord),
    );

    await win.webContents.executeJavaScript(`document.getElementById('settings-close').click(); true`, true);
    await sleep(150);
    const settingsClosed = await win.webContents.executeJavaScript(`document.getElementById('settings').hidden`, true);
    check('完成按钮：发送关闭 IPC 且面板隐藏', settingsClosed === true && settingsCloseCalls.length === 1);

    // —— 7. 页面内查找栏：可见性 + 计数展示 + Enter/Esc 键处理 ——
    win.webContents.send('shell:find-visible', true);
    await sleep(200);
    const findInfo = await win.webContents.executeJavaScript(`(() => ({
      visible: !document.getElementById('findbar').hidden,
      focused: document.activeElement === document.getElementById('find-input'),
    }))()`, true);
    check('查找栏：打开后可见且输入框聚焦', findInfo.visible && findInfo.focused, JSON.stringify(findInfo));

    await win.webContents.executeJavaScript(`document.getElementById('find-input').value = 'dsh'; document.getElementById('find-input').dispatchEvent(new Event('input')); true`, true);
    await sleep(150);
    check('查找栏：输入触发 shell:find IPC（实时查询）', findCalls.length === 1 && findCalls[0] === 'dsh', JSON.stringify(findCalls));

    win.webContents.send('shell:find-result', '2/17');
    await sleep(150);
    const findCountText = await win.webContents.executeJavaScript(`document.getElementById('find-count').textContent`, true);
    check('查找栏：主进程计数文案直显（2/17）', findCountText === '2/17', findCountText);

    await win.webContents.executeJavaScript(
      `document.getElementById('find-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); true`,
      true,
    );
    await sleep(150);
    check('查找栏：Enter → shell:find-next(1)', findNextCalls.length === 1 && findNextCalls[0] === 1, JSON.stringify(findNextCalls));

    // —— 7.5 连接按钮文案随所选方式变化 ——
    const labelOf = async (idx) => {
      await win.webContents.executeJavaScript(
        `document.querySelector('.cards .card:nth-child(${idx}) input').click(); true`,
        true,
      );
      await sleep(80);
      return win.webContents.executeJavaScript(`document.getElementById('connect').textContent`, true);
    };
    const l1 = await labelOf(1); // 嗅探
    const l2 = await labelOf(2); // 本地
    const l3 = await labelOf(3); // 云端
    check(
      '按钮文案随方式：嗅探=重新嗅探 / 本地=启动并连接 / 云端=连接',
      l1 === '重新嗅探' && l2 === '启动并连接' && l3 === '连接',
      JSON.stringify({ l1, l2, l3 }),
    );

    // —— 8. 切换服务器回来 login 表单复位（回归：连接成功后没人发复位消息，
    //        按钮 busy 态「连接中…」一直残留到页面重新可见） ——
    // 复现：云端方式点连接进入 busy（桩不回 result ≈ 成功消息在页面隐藏期间被丢弃）
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('.cards .card:nth-child(3) input').click();
      document.getElementById('remote-url').value = 'http://127.0.0.1:3080/';
      document.getElementById('connect').click();
      return true;
    })()`, true);
    await sleep(200);
    const busyState = await win.webContents.executeJavaScript(`(() => ({
      text: document.getElementById('connect').textContent,
      disabled: document.getElementById('connect').disabled,
    }))()`, true);
    check('复现 busy：点击连接后按钮「连接中…」且禁用', busyState.text === '连接中…' && busyState.disabled === true, JSON.stringify(busyState));

    // 主进程在切换服务器/断开连接时发 login:visible true → 表单复位
    win.webContents.send('login:visible', true);
    await sleep(200);
    const resetState = await win.webContents.executeJavaScript(`(() => ({
      text: document.getElementById('connect').textContent,
      disabled: document.getElementById('connect').disabled,
      status: document.getElementById('status').textContent,
      loginShown: document.getElementById('login').style.display !== 'none',
    }))()`, true);
    check(
      '切换服务器回来：按钮复位「连接」可用，非嗅探方式清空旧状态',
      resetState.text === '连接' && resetState.disabled === false && resetState.status === '' && resetState.loginShown,
      JSON.stringify(resetState),
    );

    // 连接成功消息路径（main.ts connectTo 现在会发 ok:true）
    win.webContents.send('login:result', { ok: true });
    await sleep(150);
    const afterOk = await win.webContents.executeJavaScript(`(() => ({
      text: document.getElementById('connect').textContent,
      status: document.getElementById('status').textContent,
    }))()`, true);
    check('连接成功消息：onResult 复位按钮并提示成功', afterOk.text === '连接' && afterOk.status === '连接成功', JSON.stringify(afterOk));

    try {
      const shot = path.join(outDir, 'dsh-smoke-login.png');
      fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
      console.log('SHOT ' + shot);
    } catch (e) {
      console.log('SKIP login screenshot: ' + (e instanceof Error ? e.message : String(e)));
    }
  } finally {
    app.exit(fail > 0 ? 1 : 0);
  }
});
