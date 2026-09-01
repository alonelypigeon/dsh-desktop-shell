import { describe, it, expect } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import {
  buildDisconnectMenuItems,
  buildServerMenuItems,
  buildMoreMenuItems,
  isTitlebarMenuName,
} from './titlebar-menus';

type MenuItemLike = MenuItemConstructorOptions;

describe('buildDisconnectMenuItems', () => {
  const handlers = () => {
    const calls: string[] = [];
    return {
      calls,
      h: {
        disconnect: () => calls.push('disconnect'),
        disconnectAndStop: () => calls.push('stop'),
        disconnectAndStopServer: () => calls.push('stop-server'),
      },
    };
  };

  it('owned 连接：两项（断开连接 + 关闭本地服务，无关闭服务器）', () => {
    const { h } = handlers();
    const items = buildDisconnectMenuItems({ owned: true, externalLocal: false }, h);
    expect(items).toHaveLength(2);
    expect(items[1].label).toBe('断开连接并关闭本地服务');
  });

  it('外部本机实例：两项（断开连接 + 关闭服务器，无关闭本地服务）', () => {
    const { h } = handlers();
    const items = buildDisconnectMenuItems({ owned: false, externalLocal: true }, h);
    expect(items).toHaveLength(2);
    expect(items[1].label).toBe('断开连接并关闭服务器');
  });

  it('远程连接：仅一项（本机无法关闭远程服务器）', () => {
    const { h } = handlers();
    const items = buildDisconnectMenuItems({ owned: false, externalLocal: false }, h);
    expect(items).toHaveLength(1);
    expect(items[0].label).toMatch(/断开连接/);
    expect(items[0].label).not.toMatch(/关闭/);
  });

  it('click 回调正确绑定到对应动作（三种连接形态）', () => {
    const owned = handlers();
    buildDisconnectMenuItems({ owned: true, externalLocal: false }, owned.h).forEach((i) =>
      i.click?.({} as never, {} as never, {} as never),
    );
    expect(owned.calls).toEqual(['disconnect', 'stop']);

    const ext = handlers();
    buildDisconnectMenuItems({ owned: false, externalLocal: true }, ext.h).forEach((i) =>
      i.click?.({} as never, {} as never, {} as never),
    );
    expect(ext.calls).toEqual(['disconnect', 'stop-server']);
  });
});

describe('buildServerMenuItems', () => {
  const noop = () => {};
  const handlers = { startLocal: noop, stopLocal: noop, switchServer: noop, reload: noop, reloadHard: noop, openInBrowser: null };
  const labels = (items: { label?: string }[]) => items.map((i) => i.label);

  it('未启动服务时「停止」项禁用', () => {
    const items = buildServerMenuItems({ ownedRunning: false, connectedUrl: null }, handlers);
    const stop = items.find((i) => typeof i.label === 'string' && i.label.includes('停止'));
    expect(stop?.enabled).toBe(false);
  });

  it('启动了服务时「停止」项可用', () => {
    const items = buildServerMenuItems({ ownedRunning: true, connectedUrl: null }, handlers);
    const stop = items.find((i) => typeof i.label === 'string' && i.label.includes('停止'));
    expect(stop?.enabled).toBe(true);
  });

  it('未连接时「重新加载」两项禁用；连接后可用并显示绑定加速器', () => {
    const off = buildServerMenuItems({ ownedRunning: false, connectedUrl: null }, handlers);
    const reload = off.find((i) => i.label === '重新加载页面');
    const hard = off.find((i) => i.label === '强制重新加载（忽略缓存）');
    expect(reload?.enabled).toBe(false);
    expect(hard?.enabled).toBe(false);

    const on = buildServerMenuItems(
      {
        ownedRunning: false,
        connectedUrl: 'http://127.0.0.1:3080/',
        accelerators: { reload: 'CommandOrControl+R', 'reload-hard': null },
      },
      handlers,
    );
    expect(on.find((i) => i.label === '重新加载页面')?.accelerator).toBe('CommandOrControl+R');
    // 解绑（null）不显示加速器
    expect(on.find((i) => i.label === '强制重新加载（忽略缓存）')?.accelerator).toBeUndefined();
    expect(on.find((i) => i.label === '重新加载页面')?.enabled).toBe(true);
  });

  it('未连接时不显示「在浏览器中打开」；连接后显示', () => {
    const off = buildServerMenuItems({ ownedRunning: false, connectedUrl: null }, handlers);
    expect(off.some((i) => i.label === '在浏览器中打开当前服务器')).toBe(false);

    const on = buildServerMenuItems(
      { ownedRunning: false, connectedUrl: 'http://127.0.0.1:3080/' },
      { ...handlers, openInBrowser: noop },
    );
    expect(on.some((i) => i.label === '在浏览器中打开当前服务器')).toBe(true);
  });

  it('回调绑定：启动/停止/切换/重载/强刷/浏览器打开', () => {
    const calls: string[] = [];
    const items = buildServerMenuItems(
      { ownedRunning: true, connectedUrl: 'http://x/' },
      {
        startLocal: () => calls.push('start'),
        stopLocal: () => calls.push('stop'),
        switchServer: () => calls.push('switch'),
        reload: () => calls.push('reload'),
        reloadHard: () => calls.push('hard'),
        openInBrowser: () => calls.push('browser'),
      },
    );
    for (const item of items) item.click?.({} as never, {} as never, {} as never);
    expect(calls).toEqual(['start', 'stop', 'switch', 'reload', 'hard', 'browser']);
  });

  it('完整结构（含分隔）：六项 + 浏览器打开', () => {
    const items = buildServerMenuItems(
      { ownedRunning: true, connectedUrl: 'http://x/' },
      { ...handlers, openInBrowser: noop },
    );
    expect(labels(items)).toEqual([
      '启动本地 DSH 服务…',
      '停止本地 DSH 服务',
      undefined, // separator
      '切换服务器…',
      '重新加载页面',
      '强制重新加载（忽略缓存）',
      '在浏览器中打开当前服务器',
    ]);
  });
});

describe('buildMoreMenuItems', () => {
  const mkHandlers = () => {
    const calls: string[] = [];
    return {
      calls,
      h: {
        palette: () => calls.push('palette'),
        zoomIn: () => calls.push('in'),
        zoomOut: () => calls.push('out'),
        zoomReset: () => calls.push('reset'),
        shortcuts: () => calls.push('shortcuts'),
        toggleDnd: () => calls.push('dnd'),
        exportConnections: () => calls.push('export'),
        importConnections: () => calls.push('import'),
        showDiagnostics: () => calls.push('diagnostics'),
        checkUpdates: () => calls.push('update'),
        about: () => calls.push('about'),
        quit: () => calls.push('quit'),
      },
    };
  };

  it('命令面板 / 检查更新 / 关于 / 快捷键设置 / 勿扰 checkbox / 缩放子菜单 / 退出', () => {
    const { h } = mkHandlers();
    const items = buildMoreMenuItems({ zoomFactor: 1.25, dnd: false }, h);
    expect(items.map((i) => i.label)).toEqual([
      '命令面板…',
      '检查更新…',
      '关于 DeepSeek Harness Shell…',
      '快捷键设置…',
      '勿扰模式（静默通知）',
      '导出连接…',
      '导入连接…',
      '诊断日志…',
      undefined, // separator
      '缩放 125%',
      undefined, // separator
      '退出',
    ]);
    const zoom = items.find((i) => typeof i.label === 'string' && i.label.startsWith('缩放')) as {
      submenu?: MenuItemLike[];
    };
    expect(zoom.submenu?.map((s) => s.label)).toEqual(['放大', '缩小', '重置为 100%']);
    // 命令面板项显示当前绑定加速器
    expect(items[0].accelerator).toBeUndefined();
    const withAcc = buildMoreMenuItems({ accelerators: { palette: 'CommandOrControl+K' } }, h);
    expect(withAcc[0].accelerator).toBe('CommandOrControl+K');
  });

  it('勿扰 checkbox 勾选态随 state.dnd', () => {
    const { h } = mkHandlers();
    const off = buildMoreMenuItems({ dnd: false }, h);
    const on = buildMoreMenuItems({ dnd: true }, h);
    expect(off.find((i) => i.label === '勿扰模式（静默通知）')?.checked).toBe(false);
    expect(on.find((i) => i.label === '勿扰模式（静默通知）')?.checked).toBe(true);
  });

  it('缩放百分比默认 100%；加速器取自绑定，解绑不显示', () => {
    const items = buildMoreMenuItems(
      {
        accelerators: { 'zoom-in': 'Alt+Plus', 'zoom-out': null, 'zoom-reset': 'CommandOrControl+0' },
      },
      mkHandlers().h,
    );
    expect(items.some((i) => i.label === '缩放 100%')).toBe(true);
    const zoom = items.find((i) => typeof i.label === 'string' && i.label.startsWith('缩放')) as {
      submenu?: { label?: string; accelerator?: string }[];
    };
    const subs = zoom.submenu ?? [];
    expect(subs.find((s) => s.label === '放大')?.accelerator).toBe('Alt+Plus');
    expect(subs.find((s) => s.label === '缩小')?.accelerator).toBeUndefined();
    expect(subs.find((s) => s.label === '重置为 100%')?.accelerator).toBe('CommandOrControl+0');
  });

  it('回调绑定：命令面板/更新/关于/快捷键/勿扰/缩放三项/退出', () => {
    const { calls, h } = mkHandlers();
    const items = buildMoreMenuItems({ zoomFactor: 1 }, h);
    for (const item of items) {
      item.click?.({} as never, {} as never, {} as never);
      for (const sub of (item as { submenu?: MenuItemLike[] }).submenu ?? []) {
        sub.click?.({} as never, {} as never, {} as never);
      }
    }
    expect(calls).toEqual(['palette', 'update', 'about', 'shortcuts', 'dnd', 'export', 'import', 'diagnostics', 'in', 'out', 'reset', 'quit']);
  });
});

describe('isTitlebarMenuName', () => {
  it('接受三个已知名称，拒绝其他输入', () => {
    expect(isTitlebarMenuName('disconnect')).toBe(true);
    expect(isTitlebarMenuName('server')).toBe(true);
    expect(isTitlebarMenuName('more')).toBe(true);
    expect(isTitlebarMenuName('other')).toBe(false);
    expect(isTitlebarMenuName(123)).toBe(false);
    expect(isTitlebarMenuName(null)).toBe(false);
  });
});
