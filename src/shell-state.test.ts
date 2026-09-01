import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  mergeRecentServers,
  removeRecentServer,
  clearRecentServers,
  sanitizeBounds,
  loadShellState,
  saveShellState,
  makeConnectionId,
  normalizeSavedConnection,
  migrateConnections,
  mergeSavedConnection,
  removeSavedConnection,
  renameSavedConnection,
  exportConnections,
  parseConnectionsImport,
  normalizeDndSchedule,
  isInDndSchedule,
  isDndActive,
  type WindowBounds,
} from './shell-state';

const DISPLAYS = [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 1920, y: 0, width: 1280, height: 1024 },
];

describe('mergeRecentServers', () => {
  it('新地址排最前', () => {
    expect(mergeRecentServers(['http://a/', 'http://b/'], 'http://c/')).toEqual([
      'http://c/',
      'http://a/',
      'http://b/',
    ]);
  });

  it('重复地址去重并提前', () => {
    expect(mergeRecentServers(['http://a/', 'http://b/'], 'http://a/')).toEqual([
      'http://a/',
      'http://b/',
    ]);
  });

  it('空历史也能追加', () => {
    expect(mergeRecentServers(undefined, 'http://a/')).toEqual(['http://a/']);
  });

  it('超过上限时裁剪最旧', () => {
    const prev = ['http://1/', 'http://2/', 'http://3/', 'http://4/'];
    expect(mergeRecentServers(prev, 'http://5/', 5)).toEqual([
      'http://5/',
      'http://1/',
      'http://2/',
      'http://3/',
      'http://4/',
    ]);
  });
});

describe('removeRecentServer / clearRecentServers', () => {
  const list = ['http://a/', 'http://b/', 'http://c/'];

  it('删除单条记录', () => {
    expect(removeRecentServer(list, 'http://b/')).toEqual(['http://a/', 'http://c/']);
  });

  it('删除不存在的记录时列表不变', () => {
    expect(removeRecentServer(list, 'http://nope/')).toEqual(list);
  });

  it('删除最后一条后为空列表', () => {
    expect(removeRecentServer(['http://a/'], 'http://a/')).toEqual([]);
  });

  it('空历史删除为幂等空列表', () => {
    expect(removeRecentServer(undefined, 'http://a/')).toEqual([]);
    expect(removeRecentServer([], 'http://a/')).toEqual([]);
  });

  it('清空全部记录', () => {
    expect(clearRecentServers()).toEqual([]);
  });
});

describe('sanitizeBounds', () => {
  const inBounds: WindowBounds = { x: 100, y: 100, width: 1200, height: 800 };

  it('在主显示器工作区内的 bounds 保留', () => {
    expect(sanitizeBounds(inBounds, DISPLAYS)).toEqual(inBounds);
  });

  it('位于副显示器工作区内的 bounds 保留', () => {
    expect(sanitizeBounds({ x: 2000, y: 50, width: 1000, height: 700 }, DISPLAYS)).toEqual({
      x: 2000,
      y: 50,
      width: 1000,
      height: 700,
    });
  });

  it('完全落在屏幕外的 bounds 丢弃', () => {
    expect(sanitizeBounds({ x: 99999, y: 99999, width: 800, height: 600 }, DISPLAYS)).toBeNull();
  });

  it('过小窗口丢弃（防坏数据）', () => {
    expect(sanitizeBounds({ x: 0, y: 0, width: 50, height: 50 }, DISPLAYS)).toBeNull();
  });

  it('非有限数值丢弃', () => {
    expect(sanitizeBounds({ x: NaN, y: 0, width: 800, height: 600 }, DISPLAYS)).toBeNull();
    expect(sanitizeBounds(undefined, DISPLAYS)).toBeNull();
  });

  it('无显示器信息时丢弃（无法验证可见性）', () => {
    expect(sanitizeBounds(inBounds, [])).toBeNull();
  });
});

describe('loadShellState / saveShellState', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-state-')), 'state.json');

  it('zoomFactor 往返保留；越界值在加载时收拢', () => {
    const file = tmp();
    saveShellState(file, { zoomFactor: 1.25 });
    expect(loadShellState(file).zoomFactor).toBe(1.25);
    saveShellState(file, { zoomFactor: 9 });
    expect(loadShellState(file).zoomFactor).toBe(2);
  });

  it('zoomFactor 非法值忽略', () => {
    const file = tmp();
    fs.writeFileSync(file, JSON.stringify({ zoomFactor: 'big' }), 'utf-8');
    expect(loadShellState(file).zoomFactor).toBeUndefined();
  });

  it('shortcuts 往返保留（含空串解绑）；非字符串值丢弃', () => {
    const file = tmp();
    saveShellState(file, { shortcuts: { find: 'Ctrl+G', 'zoom-out': '' } });
    expect(loadShellState(file).shortcuts).toEqual({ find: 'Ctrl+G', 'zoom-out': '' });

    fs.writeFileSync(file, JSON.stringify({ shortcuts: { find: 123, reload: 'Ctrl+R' } }), 'utf-8');
    expect(loadShellState(file).shortcuts).toEqual({ reload: 'Ctrl+R' });
  });

  it('损坏的 JSON 文件回空状态（不抛异常）', () => {
    const file = tmp();
    fs.writeFileSync(file, '{not json', 'utf-8');
    expect(loadShellState(file)).toEqual({});
  });

  it('dnd 往返保留；非布尔值忽略', () => {
    const file = tmp();
    saveShellState(file, { dnd: true });
    expect(loadShellState(file).dnd).toBe(true);
    saveShellState(file, { dnd: false });
    expect(loadShellState(file).dnd).toBe(false);

    fs.writeFileSync(file, JSON.stringify({ dnd: 'yes' }), 'utf-8');
    expect(loadShellState(file).dnd).toBeUndefined();
  });
});

describe('连接配置库（v0.7 命名连接）', () => {
  it('normalizeSavedConnection 补齐 id/name/kind，非法输入返回 null', () => {
    const c = normalizeSavedConnection({ url: 'http://127.0.0.1:3080/' });
    expect(c).not.toBeNull();
    expect(c?.id).toBe(makeConnectionId('http://127.0.0.1:3080/'));
    expect(c?.name).toBe('http://127.0.0.1:3080/');
    expect(c?.kind).toBe('remote');
    expect(normalizeSavedConnection({ url: '' })).toBeNull();
    expect(normalizeSavedConnection(null)).toBeNull();
    expect(normalizeSavedConnection('http://x')).toBeNull();
  });

  it('migrateConnections 从旧 recentServers 生成命名连接，并保留已有 connections', () => {
    const migrated = migrateConnections({
      recentServers: ['http://a/', 'http://b/', 'http://a/'],
      connections: [{ id: 'keep', name: 'Keep', url: 'http://keep/', kind: 'remote' }],
    });
    expect(migrated.map((c) => c.url)).toEqual(['http://keep/', 'http://a/', 'http://b/']);
    expect(migrated.find((c) => c.url === 'http://a/')?.kind).toBe('remote');
  });

  it('merge/remove/rename 基本操作', () => {
    const base = migrateConnections({ recentServers: ['http://a/', 'http://b/'] });
    const merged = mergeSavedConnection(base, {
      id: makeConnectionId('http://c/'),
      name: 'C 服务器',
      url: 'http://c/',
      kind: 'remote',
    });
    expect(merged.map((c) => c.url)).toEqual(['http://c/', 'http://a/', 'http://b/']);
    expect(removeSavedConnection(merged, 'http://a/').map((c) => c.url)).toEqual(['http://c/', 'http://b/']);
    expect(renameSavedConnection(merged, makeConnectionId('http://c/'), ' 新名字 ')[0].name).toBe('新名字');
  });

  it('导出/导入 JSON 往返', () => {
    const conns = migrateConnections({ recentServers: ['http://a/', 'http://b/'] });
    const json = exportConnections(conns);
    const parsed = parseConnectionsImport(json);
    expect(parsed.map((c) => c.url)).toEqual(['http://a/', 'http://b/']);
    // 兼容直接数组
    expect(parseConnectionsImport(JSON.stringify(conns)).map((c) => c.url)).toEqual(['http://a/', 'http://b/']);
    expect(parseConnectionsImport('not json')).toEqual([]);
  });

  it('loadShellState 自动迁移旧 recentServers 到 connections', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shell-conn-')), 'state.json');
    saveShellState(file, { recentServers: ['http://old/'] });
    const state = loadShellState(file);
    expect(state.recentServers).toEqual(['http://old/']);
    expect(state.connections?.map((c) => c.url)).toEqual(['http://old/']);
  });
});
describe('勿扰时段（B3）', () => {
  it('normalizeDndSchedule 校验 HH:MM', () => {
    expect(normalizeDndSchedule({ enabled: true, start: '22:00', end: '07:00' })).toEqual({
      enabled: true,
      start: '22:00',
      end: '07:00',
    });
    expect(normalizeDndSchedule({ enabled: true, start: '25:00', end: '08:00' })).toBeNull();
    expect(normalizeDndSchedule(null)).toBeNull();
  });

  it('isInDndSchedule 支持跨天时段', () => {
    const s = { enabled: true, start: '22:00', end: '07:00' };
    expect(isInDndSchedule(new Date('2026-08-24T23:30:00'), s)).toBe(true);
    expect(isInDndSchedule(new Date('2026-08-24T06:30:00'), s)).toBe(true);
    expect(isInDndSchedule(new Date('2026-08-24T12:00:00'), s)).toBe(false);
  });

  it('isDndActive 结合手动开关与定时时段', () => {
    const s = { enabled: true, start: '22:00', end: '07:00' };
    const day = new Date('2026-08-24T12:00:00');
    const night = new Date('2026-08-24T23:00:00');
    expect(isDndActive(true, s, day)).toBe(true);
    expect(isDndActive(false, s, day)).toBe(false);
    expect(isDndActive(false, s, night)).toBe(true);
  });
});