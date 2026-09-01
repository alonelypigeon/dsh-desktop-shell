import { describe, expect, it } from 'vitest';
import { buildPaletteEntries } from './palette';

describe('buildPaletteEntries', () => {
  const base = {
    connectedUrl: 'http://127.0.0.1:3080/' as string | null,
    ownedRunning: true,
    recentServers: ['http://127.0.0.1:3080/', 'https://cloud.example/'],
    dnd: false,
    alwaysOnTop: false,
    zoomFactor: 1.25,
  };

  it('已连接：包含最近连接（connect:n）、视图动作与应用动作', () => {
    const entries = buildPaletteEntries(base);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('connect:0');
    expect(ids).toContain('connect:1');
    expect(ids).toContain('disconnect');
    expect(ids).toContain('reload');
    expect(ids).toContain('find');
    expect(ids).toContain('quit');
    // 最近连接第一条带「最近」提示
    expect(entries.find((e) => e.id === 'connect:0')?.hint).toBe('最近');
  });

  it('缩放提示显示当前百分比；置顶文案随状态翻转', () => {
    const on = buildPaletteEntries(base);
    expect(on.find((e) => e.id === 'zoom-in')?.hint).toBe('当前 125%');
    expect(on.find((e) => e.id === 'toggle-ontop')?.label).toBe('窗口置顶');

    const off = buildPaletteEntries({ ...base, alwaysOnTop: true });
    expect(off.find((e) => e.id === 'toggle-ontop')?.label).toBe('取消窗口置顶');
  });

  it('未连接：无视图页面动作与断开项，仍可启动服务与切换服务器', () => {
    const entries = buildPaletteEntries({ ...base, connectedUrl: null, ownedRunning: false });
    const ids = entries.map((e) => e.id);
    expect(ids).not.toContain('disconnect');
    expect(ids).not.toContain('reload');
    expect(ids).toContain('start-local');
    expect(ids).not.toContain('stop-local');
    expect(ids).toContain('switch-server');
    // 缩放/置顶等窗口级动作与连接无关，保留
    expect(ids).toContain('zoom-in');
  });

  it('勿扰文案随开关翻转；本地服务启停二选一', () => {
    const off = buildPaletteEntries(base);
    expect(off.find((e) => e.id === 'dnd')?.label).toContain('开启勿扰模式');
    const on = buildPaletteEntries({ ...base, dnd: true });
    expect(on.find((e) => e.id === 'dnd')?.label).toBe('关闭勿扰模式');
    expect(on.find((e) => e.id === 'stop-local')?.label).toContain('停止');
  });

  it('id 全局唯一（最近连接下标不与他人冲突）', () => {
    const entries = buildPaletteEntries({ ...base, recentServers: ['a', 'b', 'c', 'd', 'e'] });
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
