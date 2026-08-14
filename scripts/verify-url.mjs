// 基于 Node 内置 test runner 的验证脚本：直接测试编译产物 dist/url.js。
// 不依赖 vite/vitest，可在无 GUI、无子进程 spawn 的受限环境（CI、沙箱）运行。
// 与 src/url.test.ts（vitest）覆盖同一组纯函数，作为无 vite 时的等价检查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { validateUrl, parseCliUrl, pickUrl } = require('../dist/url.js');
const { looksLikeDshIndex, looksLikeDshFavicon } = require('../dist/sniffer.js');
const { parseDshShellUrl } = require('../dist/protocol.js');
const { mergeRecentServers, sanitizeBounds } = require('../dist/shell-state.js');

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
