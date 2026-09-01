// 基于 Node 内置 test runner 的验证脚本：直接测试编译产物 dist/url.js。
// 不依赖 vite/vitest，可在无 GUI、无子进程 spawn 的受限环境（CI、沙箱）运行。
// 与 src/url.test.ts（vitest）覆盖同一组纯函数，作为无 vite 时的等价检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { validateUrl, parseCliUrl, pickUrl, isLoopbackHost } = require('../dist/url.js');
const { looksLikeDshIndex, looksLikeDshFavicon } = require('../dist/sniffer.js');
const { parseDshShellUrl } = require('../dist/protocol.js');
const { mergeRecentServers, sanitizeBounds, migrateConnections, exportConnections, parseConnectionsImport } = require('../dist/shell-state.js');
const { createLogBuffer, pushLogLine, logSnapshot } = require('../dist/log-buffer.js');
const { normalizeDndSchedule, isInDndSchedule } = require('../dist/shell-state.js');
const { parseThemePreferenceYaml, parseThemePreferenceJson } = require('../dist/theme-prefs.js');
const { buildDisconnectMenuItems, buildServerMenuItems, buildMoreMenuItems } = require('../dist/titlebar-menus.js');
const { parseNetstatPids, parseLsofPids } = require('../dist/server-stop.js');
const {
  DEFAULT_SHORTCUTS,
  normalizeAccelerator,
  recordingOutcome,
  matchContentShortcut,
  normalizeShortcutBindings,
  serializeShortcutBindings,
} = require('../dist/shortcuts.js');
const { stepZoom, normalizeZoom, formatFindCount } = require('../dist/view-controls.js');

test('validateUrl 接受 http URL', () => {
  assert.equal(validateUrl('http://127.0.0.1:3080'), 'http://127.0.0.1:3080/');
});

test('validateUrl 接受 https URL', () => {
  assert.equal(validateUrl('https://example.com/'), 'https://example.com/');
});

test('validateUrl 规范化补末尾斜杠', () => {
  assert.equal(validateUrl('http://localhost:3080'), 'http://localhost:3080/');
});

test('validateUrl 拒绝 file://', () => {
  assert.throws(() => validateUrl('file:///etc/passwd'), /不支持的协议/);
});

test('validateUrl 拒绝 javascript:', () => {
  assert.throws(() => validateUrl('javascript:alert(1)'), /不支持的协议/);
});

test('validateUrl 拒绝 smb://', () => {
  assert.throws(() => validateUrl('smb://server/share'), /不支持的协议/);
});

test('validateUrl 拒绝无法解析的字符串', () => {
  assert.throws(() => validateUrl('not a url'), /无效的地址/);
});

test('validateUrl 拒绝空字符串', () => {
  assert.throws(() => validateUrl(''), /无效的地址/);
});

test('parseCliUrl 空格形式', () => {
  assert.equal(
    parseCliUrl(['node', 'main.js', '--url', 'http://127.0.0.1:3080']),
    'http://127.0.0.1:3080',
  );
});

test('parseCliUrl 等号形式', () => {
  assert.equal(parseCliUrl(['--url=http://127.0.0.1:8080']), 'http://127.0.0.1:8080');
});

test('parseCliUrl 忽略 electron 自身参数', () => {
  assert.equal(
    parseCliUrl(['electron', '.', '--no-sandbox', '--url', 'http://127.0.0.1:3080']),
    'http://127.0.0.1:3080',
  );
});

test('parseCliUrl 无 --url 返回 null', () => {
  assert.equal(parseCliUrl(['electron', '.']), null);
});

test('parseCliUrl --url 后跟参数返回 null', () => {
  assert.equal(parseCliUrl(['electron', '.', '--url', '--foo']), null);
});

test('pickUrl cli 最高优先', () => {
  assert.equal(pickUrl('http://cli', 'http://env', 'http://file'), 'http://cli');
});

test('pickUrl env 次之', () => {
  assert.equal(pickUrl(null, 'http://env', 'http://file'), 'http://env');
});

test('pickUrl 仅 file 有值', () => {
  assert.equal(pickUrl(null, null, 'http://file'), 'http://file');
});

test('pickUrl 全空返回 null', () => {
  assert.equal(pickUrl(null, null, null), null);
});

// —— isLoopbackHost（dist/url.js） ——

test('isLoopbackHost 识别 127.0.0.0/8 与 localhost', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.0.0.99'), true);
  assert.equal(isLoopbackHost('localhost'), true);
});

test('isLoopbackHost 识别带方括号的 IPv6 回环', () => {
  // new URL('http://[::1]:3080/').hostname === '[::1]'
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('[::ffff:127.0.0.1]'), true);
});

test('isLoopbackHost 拒绝非回环地址', () => {
  assert.equal(isLoopbackHost('192.168.1.1'), false);
  assert.equal(isLoopbackHost('example.com'), false);
  assert.equal(isLoopbackHost('128.0.0.1'), false);
  assert.equal(isLoopbackHost('[::2]'), false);
});

// —— sniffer 纯函数（dist/sniffer.js） ——

test('looksLikeDshIndex 识别 manifest.webmanifest', () => {
  assert.equal(
    looksLikeDshIndex('<html><head><link rel="manifest" href="manifest.webmanifest"></head></html>'),
    true,
  );
});

test('looksLikeDshIndex 识别 DeepSeek Harness 标题', () => {
  assert.equal(looksLikeDshIndex('<html><title>DeepSeek Harness</title></html>'), true);
});

test('looksLikeDshIndex 拒绝无关页面', () => {
  assert.equal(looksLikeDshIndex('<html><title>Hello</title></html>'), false);
});

test('looksLikeDshFavicon 识别官方鲸鱼坐标', () => {
  assert.equal(
    looksLikeDshFavicon('<svg viewBox="0 0 50 50"><path d="M48.8354 10.0479C48.3232 9.79199"></svg>'),
    true,
  );
});

test('looksLikeDshFavicon 拒绝其他 svg', () => {
  assert.equal(looksLikeDshFavicon('<svg><path d="M0 0 L10 10"></svg>'), false);
});

// —— 深链协议（dist/protocol.js） ——

test('parseDshShellUrl show 动作', () => {
  assert.deepEqual(parseDshShellUrl('dsh-shell://show'), { action: 'show' });
});

test('parseDshShellUrl open 动作（http）', () => {
  const u = encodeURIComponent('http://127.0.0.1:3080/');
  assert.deepEqual(parseDshShellUrl(`dsh-shell://open?url=${u}`), {
    action: 'open',
    url: 'http://127.0.0.1:3080/',
  });
});

test('parseDshShellUrl 拒绝 file:// 与乱输入', () => {
  const u = encodeURIComponent('file:///etc/passwd');
  assert.deepEqual(parseDshShellUrl(`dsh-shell://open?url=${u}`), { action: 'unknown' });
  assert.deepEqual(parseDshShellUrl('garbage'), { action: 'unknown' });
});

// —— 外壳状态（dist/shell-state.js） ——

test('mergeRecentServers 去重 + 最新在前 + 裁剪上限', () => {
  const prev = ['http://1/', 'http://2/', 'http://3/', 'http://4/'];
  assert.deepEqual(mergeRecentServers(prev, 'http://2/'), [
    'http://2/',
    'http://1/',
    'http://3/',
    'http://4/',
  ]);
  assert.deepEqual(mergeRecentServers(prev, 'http://5/', 3), ['http://5/', 'http://1/', 'http://2/']);
});

test('sanitizeBounds 可见窗口保留、屏幕外/坏数据丢弃', () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }];
  assert.deepEqual(sanitizeBounds({ x: 100, y: 100, width: 1200, height: 800 }, displays), {
    x: 100,
    y: 100,
    width: 1200,
    height: 800,
  });
  assert.equal(sanitizeBounds({ x: 99999, y: 99999, width: 800, height: 600 }, displays), null);
  assert.equal(sanitizeBounds({ x: NaN, y: 0, width: 800, height: 600 }, displays), null);
  assert.equal(sanitizeBounds(undefined, displays), null);
});

// —— 外观偏好解析（dist/theme-prefs.js） ——

test('parseThemePreferenceYaml 读取 ui-theme 段', () => {
  const yaml = ['model: deepseek', 'ui-theme:', '  preference: dark', 'other:', '  preference: light'].join('\n');
  assert.equal(parseThemePreferenceYaml(yaml), 'dark');
});

test('parseThemePreferenceYaml ui-theme 在文件末尾也能读到', () => {
  assert.equal(parseThemePreferenceYaml('model: x\nui-theme:\n  preference: system'), 'system');
});

test('parseThemePreferenceYaml 段内无值回退 / 无 preference 为 null', () => {
  assert.equal(parseThemePreferenceYaml('ui-theme:\n  accent: blue\na:\n  preference: light'), 'light');
  assert.equal(parseThemePreferenceYaml('model: x'), null);
});

test('parseThemePreferenceJson 读取与容错', () => {
  assert.equal(parseThemePreferenceJson('{"ui-theme":{"preference":"dark"}}'), 'dark');
  assert.equal(parseThemePreferenceJson('{}'), null);
  assert.equal(parseThemePreferenceJson('not json'), null);
});

// —— 标题栏菜单模板（dist/titlebar-menus.js） ——

test('buildDisconnectMenuItems 按连接形态显示对应项', () => {
  const noop = () => {};
  const owned = buildDisconnectMenuItems(
    { owned: true, externalLocal: false },
    { disconnect: noop, disconnectAndStop: noop, disconnectAndStopServer: noop },
  );
  const ext = buildDisconnectMenuItems(
    { owned: false, externalLocal: true },
    { disconnect: noop, disconnectAndStop: noop, disconnectAndStopServer: noop },
  );
  const remote = buildDisconnectMenuItems(
    { owned: false, externalLocal: false },
    { disconnect: noop, disconnectAndStop: noop, disconnectAndStopServer: noop },
  );
  assert.equal(owned.length, 2);
  assert.equal(owned[1].label, '断开连接并关闭本地服务');
  assert.equal(ext.length, 2);
  assert.equal(ext[1].label, '断开连接并关闭服务器');
  assert.equal(remote.length, 1);
});

test('parseNetstatPids / parseLsofPids 解析监听表', () => {
  const netstat = [
    '  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    4212',
    '  TCP    [::1]:3080        [::]:0       LISTENING    4212',
    '  TCP    127.0.0.1:5173    0.0.0.0:0    LISTENING    512',
  ].join('\r\n');
  assert.deepEqual(parseNetstatPids(netstat, 3080), [4212]);
  assert.deepEqual(parseLsofPids('4212\n9080\n'), [4212, 9080]);
});

test('buildServerMenuItems 停止项随 ownedRunning 启用/禁用；重载项随连接启用', () => {
  const noop = () => {};
  const handlers = {
    startLocal: noop,
    stopLocal: noop,
    switchServer: noop,
    reload: noop,
    reloadHard: noop,
    openInBrowser: noop,
  };
  const off = buildServerMenuItems({ ownedRunning: false, connectedUrl: null }, handlers);
  const on = buildServerMenuItems({ ownedRunning: true, connectedUrl: null }, handlers);
  assert.equal(off.find((i) => i.label?.includes('停止'))?.enabled, false);
  assert.equal(on.find((i) => i.label?.includes('停止'))?.enabled, true);
  assert.equal(off.find((i) => i.label === '重新加载页面')?.enabled, false);
  const connected = buildServerMenuItems(
    { ownedRunning: false, connectedUrl: 'http://127.0.0.1:3080/', accelerators: DEFAULT_SHORTCUTS },
    handlers,
  );
  assert.equal(connected.find((i) => i.label === '重新加载页面')?.enabled, true);
  assert.equal(connected.find((i) => i.label === '重新加载页面')?.accelerator, 'CommandOrControl+R');
});

test('buildMoreMenuItems 快捷键设置入口与缩放子菜单', () => {
  const noop = () => {};
  const items = buildMoreMenuItems(
    { zoomFactor: 1.25, accelerators: DEFAULT_SHORTCUTS, dnd: true },
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
  assert.equal(items.length, 12);
  assert.ok(items.some((i) => i.label === '快捷键设置…'));
  assert.ok(items.some((i) => i.label === '命令面板…' && i.accelerator === 'CommandOrControl+K'));
  assert.equal(items.find((i) => i.label === '勿扰模式（静默通知）')?.checked, true);
  const zoom = items.find((i) => typeof i.label === 'string' && i.label.startsWith('缩放'));
  assert.equal(zoom.label, '缩放 125%');
  assert.equal(zoom.submenu.length, 3);
});

// —— 快捷键绑定 / 内容视图工具（dist/shortcuts.js / dist/view-controls.js） ——

test('normalizeAccelerator 归一化与校验', () => {
  assert.equal(normalizeAccelerator('Ctrl+Shift+D'), 'CommandOrControl+Shift+D');
  assert.equal(normalizeAccelerator('Ctrl+d'), 'CommandOrControl+D');
  assert.equal(normalizeAccelerator('Ctrl+Plus'), 'CommandOrControl+Plus');
  assert.equal(normalizeAccelerator('F5'), 'F5');
  assert.equal(normalizeAccelerator('Ctrl+Escape'), null);
  assert.equal(normalizeAccelerator('D'), null);
});

test('recordingOutcome 录制判定', () => {
  assert.deepEqual(recordingOutcome({ key: 'k', control: true, shift: true }), {
    kind: 'ok',
    accelerator: 'CommandOrControl+Shift+K',
  });
  assert.equal(recordingOutcome({ key: 'Escape' }).kind, 'cancel');
  assert.equal(recordingOutcome({ key: 'Backspace' }).kind, 'clear');
  assert.equal(recordingOutcome({ key: 'd', shift: true }).kind, 'invalid');
  assert.equal(recordingOutcome({ key: 'Control' }).kind, 'pending');
});

test('matchContentShortcut 默认绑定命中内容动作', () => {
  assert.equal(matchContentShortcut(DEFAULT_SHORTCUTS, { key: 'f', control: true }), 'find');
  assert.equal(matchContentShortcut(DEFAULT_SHORTCUTS, { key: 'r', control: true, shift: true }), 'reload-hard');
  assert.equal(matchContentShortcut(DEFAULT_SHORTCUTS, { key: '=', control: true }), 'zoom-in');
  assert.equal(matchContentShortcut(DEFAULT_SHORTCUTS, { key: 'g', control: true }), null);
});

test('快捷键绑定序列化 round-trip（含解绑）', () => {
  const b = { ...DEFAULT_SHORTCUTS, find: null, 'zoom-in': 'Alt+Plus' };
  assert.deepEqual(normalizeShortcutBindings(serializeShortcutBindings(b)), b);
});

test('缩放档位与查找计数', () => {
  assert.equal(stepZoom(1, 'in'), 1.1);
  assert.equal(stepZoom(2, 'in'), 2);
  assert.equal(normalizeZoom(9), 2);
  assert.equal(formatFindCount(3, 17), '3/17');
  assert.equal(formatFindCount(0, 0), '无结果');
});

test('命名连接配置库：迁移 + 导入导出往返', () => {
  const conns = migrateConnections({ recentServers: ['http://127.0.0.1:3080/'] });
  assert.equal(conns.length, 1);
  assert.equal(conns[0].url, 'http://127.0.0.1:3080/');
  const parsed = parseConnectionsImport(exportConnections(conns));
  assert.deepEqual(parsed.map((c) => c.url), ['http://127.0.0.1:3080/']);
  assert.deepEqual(parseConnectionsImport('bad'), []);
});

test('诊断日志环形缓冲：裁剪与快照', () => {
  const b = createLogBuffer(2);
  pushLogLine(b, 'a');
  pushLogLine(b, 'b');
  pushLogLine(b, 'c');
  assert.equal(logSnapshot(b), 'b\nc');
});
test('勿扰时段：校验与跨天判断', () => {
  const s = normalizeDndSchedule({ enabled: true, start: '22:00', end: '07:00' });
  assert.deepEqual(s, { enabled: true, start: '22:00', end: '07:00' });
  assert.equal(isInDndSchedule(new Date('2026-08-24T23:30:00'), s), true);
  assert.equal(isInDndSchedule(new Date('2026-08-24T12:00:00'), s), false);
});