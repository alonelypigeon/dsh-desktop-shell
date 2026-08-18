// 标题栏下拉菜单 —— 模板构建（纯函数，可单测）。
//
// 四组菜单（均为原生 Menu.popup 呈现：绘制在所有 Web 内容之上，不被 DSH
// 内容视图遮挡；Esc / 点击外部自动收起；Windows/Linux 跟随系统深浅色）：
//   disconnect —— 断开连接 / 断开连接并关闭本地服务（仅 owned 连接）
//   server     —— 启动/停止本地服务、切换服务器、重新加载、在浏览器打开
//   more       —— 检查更新、关于、快捷键设置、缩放、退出
// 菜单里的加速器文案取自当前快捷键绑定（shortcuts.ts，可自定义），只作展示；
// 实际触发在主进程的 before-input-event / globalShortcut（popup 菜单不注册热键）。
import type { MenuItemConstructorOptions } from 'electron';
import { zoomPercent, ZOOM_DEFAULT } from './view-controls';
import type { ShortcutBindings } from './shortcuts';

export type TitlebarMenuName = 'disconnect' | 'server' | 'more';

export const TITLEBAR_MENU_NAMES: readonly TitlebarMenuName[] = ['disconnect', 'server', 'more'];

export function isTitlebarMenuName(v: unknown): v is TitlebarMenuName {
  return typeof v === 'string' && (TITLEBAR_MENU_NAMES as readonly string[]).includes(v);
}

/** 菜单展示用的加速器（当前快捷键绑定；未绑定/null 不显示）。 */
export type MenuAccelerators = Partial<ShortcutBindings>;

// 展示用加速器：null（解绑）/缺省 → undefined（菜单不显示组合键）。
function acc(a: string | null | undefined): string | undefined {
  return a ?? undefined;
}

// —— disconnect ——

export interface DisconnectMenuState {
  /** 当前连接是否为本应用启动的本地服务（显示「关闭本地服务」项）。 */
  owned: boolean;
  /** 当前连接是否为非本应用启动的本机实例（嗅探连接；显示「关闭服务器」项）。 */
  externalLocal: boolean;
}

export interface DisconnectMenuHandlers {
  disconnect: () => void;
  disconnectAndStop: () => void;
  /** 断开并结束外部本机服务器的进程（按端口定位，见 server-stop.ts）。 */
  disconnectAndStopServer: () => void;
}

// owned = 本应用启动的本地服务 → 「关闭本地服务」（精确停自己的子进程）。
// externalLocal = 嗅探连接的外部本机实例 → 「关闭服务器」（按端口找进程结束）。
// 远程服务器无法从本机关闭 → 两项都不显示。
export function buildDisconnectMenuItems(
  state: DisconnectMenuState,
  handlers: DisconnectMenuHandlers,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    {
      label: '断开连接（返回登录界面，服务保持运行）',
      click: handlers.disconnect,
    },
  ];
  if (state.owned) {
    items.push({
      label: '断开连接并关闭本地服务',
      click: handlers.disconnectAndStop,
    });
  }
  if (state.externalLocal) {
    items.push({
      label: '断开连接并关闭服务器',
      click: handlers.disconnectAndStopServer,
    });
  }
  return items;
}

// —— server ——

export interface ServerMenuState {
  /** 本应用是否启动了本地 DSH 服务（决定「停止」项是否可用）。 */
  ownedRunning: boolean;
  /** 当前连接地址（非空时「重新加载」「在浏览器中打开」可用/显示）。 */
  connectedUrl: string | null;
  /** 当前快捷键绑定（重载项右侧展示组合键；未传不展示）。 */
  accelerators?: MenuAccelerators;
}

export interface ServerMenuHandlers {
  startLocal: () => void;
  stopLocal: () => void;
  switchServer: () => void;
  /** 重新加载当前页面（普通 / 忽略缓存）；未连接时菜单项禁用。 */
  reload: () => void;
  reloadHard: () => void;
  /** 未连接时传 null（隐藏「在浏览器中打开」项）。 */
  openInBrowser: (() => void) | null;
}

export function buildServerMenuItems(
  state: ServerMenuState,
  handlers: ServerMenuHandlers,
): MenuItemConstructorOptions[] {
  const connected = state.connectedUrl !== null;
  const items: MenuItemConstructorOptions[] = [
    { label: '启动本地 DSH 服务…', click: handlers.startLocal },
    {
      label: '停止本地 DSH 服务',
      click: handlers.stopLocal,
      enabled: state.ownedRunning,
    },
    { type: 'separator' },
    { label: '切换服务器…', click: handlers.switchServer },
    {
      label: '重新加载页面',
      accelerator: acc(state.accelerators?.reload),
      click: handlers.reload,
      enabled: connected,
    },
    {
      label: '强制重新加载（忽略缓存）',
      accelerator: acc(state.accelerators?.['reload-hard']),
      click: handlers.reloadHard,
      enabled: connected,
    },
  ];
  if (state.connectedUrl && handlers.openInBrowser) {
    items.push({ label: '在浏览器中打开当前服务器', click: handlers.openInBrowser });
  }
  return items;
}

// —— more ——

export interface MoreMenuState {
  /** 当前内容视图缩放（缩放子菜单标题显示百分比）。 */
  zoomFactor?: number;
  /** 当前快捷键绑定（缩放子菜单右侧展示组合键；未传不展示）。 */
  accelerators?: MenuAccelerators;
}

export interface MoreMenuHandlers {
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  /** 打开快捷键设置面板。 */
  shortcuts: () => void;
  checkUpdates: () => void;
  about: () => void;
  quit: () => void;
}

export function buildMoreMenuItems(
  state: MoreMenuState,
  handlers: MoreMenuHandlers,
): MenuItemConstructorOptions[] {
  return [
    { label: '检查更新…', click: handlers.checkUpdates },
    { label: '关于 DeepSeek Harness Shell…', click: handlers.about },
    { label: '快捷键设置…', click: handlers.shortcuts },
    { type: 'separator' },
    {
      label: `缩放 ${zoomPercent(state.zoomFactor ?? ZOOM_DEFAULT)}%`,
      submenu: [
        { label: '放大', accelerator: acc(state.accelerators?.['zoom-in']), click: handlers.zoomIn },
        { label: '缩小', accelerator: acc(state.accelerators?.['zoom-out']), click: handlers.zoomOut },
        {
          label: '重置为 100%',
          accelerator: acc(state.accelerators?.['zoom-reset']),
          click: handlers.zoomReset,
        },
      ],
    },
    { type: 'separator' },
    { label: '退出', click: handlers.quit },
  ];
}
