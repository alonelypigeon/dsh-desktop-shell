// 断开连接下拉菜单 —— 独立小窗（frameless + transparent + 父窗口置顶）。
//
// 为什么不用 shell 页面内的绝对定位弹层：连接成功后 DSH 内容跑在
// WebContentsView 里，它始终合成在 shell 页面之上；弹层一旦延伸到标题栏
// 下方（下拉菜单必然如此）就会被 DSH 视图整个盖住——表现为「菜单打开但
// 看不到内容」。子 BrowserWindow 天然在父窗口之上，菜单因此始终可见。
import { BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'node:path';

const MENU_W = 264;
const MENU_H = 96; // 初始高度；打开时会按内容实际高度调整

export interface ConnMenuState {
  owned: boolean; // 当前连接是否为本应用启动的本地服务（决定「关闭服务」项显隐）
  dark: boolean; // 当前主题（菜单窗口独立 webContents，需单独同步）
}

export interface ConnMenu {
  open: (anchor: Electron.Rectangle, state: ConnMenuState) => void;
  close: () => void;
  destroy: () => void;
}

/**
 * 创建断开连接菜单窗口（懒创建：首次 open 时建立，复用直到 destroy）。
 * @param owner   宿主 shell 窗口（菜单始终在其之上，随其移动/隐藏而关闭）
 * @param handlers 菜单项动作（断开连接 / 断开连接并关闭本地服务）
 */
export function createConnMenu(
  owner: BrowserWindow,
  handlers: { disconnect: () => void; disconnectAndStop: () => void },
): ConnMenu {
  let win: BrowserWindow | null = null;

  const close = (): void => {
    if (win && win.isVisible()) win.hide();
    if (!owner.isDestroyed()) owner.webContents.send('shell:conn-menu-closed');
  };

  const destroy = (): void => {
    ipcMain.removeListener('menu:disconnect', onDisconnect);
    ipcMain.removeListener('menu:disconnect-stop', onDisconnectStop);
    ipcMain.removeListener('menu:close', onClose);
    if (win) {
      win.removeAllListeners();
      if (!win.isDestroyed()) win.destroy();
      win = null;
    }
  };

  const ensureWindow = (): BrowserWindow => {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      parent: owner, // 父窗口之上、随父窗口最小化
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      width: MENU_W,
      height: MENU_H,
      webPreferences: {
        preload: path.join(__dirname, 'shell-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    void win.loadFile(path.join(__dirname, 'conn-menu.html'));
    // 失焦即收起（点击窗口外任意处）
    win.on('blur', close);
    // 父窗口移动/缩放/隐藏/关闭 → 收起并随父窗口销毁
    owner.on('move', close);
    owner.on('resize', close);
    owner.on('hide', close);
    owner.on('closed', destroy);
    return win;
  };

  // 菜单窗口自身的 IPC（guard 只认菜单窗口）
  const onDisconnect = (e: Electron.IpcMainEvent): void => {
    if (!win || e.sender !== win.webContents) return;
    close();
    handlers.disconnect();
  };
  const onDisconnectStop = (e: Electron.IpcMainEvent): void => {
    if (!win || e.sender !== win.webContents) return;
    close();
    handlers.disconnectAndStop();
  };
  const onClose = (e: Electron.IpcMainEvent): void => {
    if (!win || e.sender !== win.webContents) return;
    close();
  };
  ipcMain.on('menu:disconnect', onDisconnect);
  ipcMain.on('menu:disconnect-stop', onDisconnectStop);
  ipcMain.on('menu:close', onClose);

  const open = (anchor: Electron.Rectangle, state: ConnMenuState): void => {
    if (owner.isDestroyed()) return;
    const menuWin = ensureWindow();
    if (menuWin.isVisible()) {
      // 已打开 → 再次点击视为收起
      close();
      return;
    }
    const b = owner.getBounds();
    // 锚点（标题栏按钮的屏幕坐标）+ 6px 间距
    let x = Math.round(b.x + anchor.x);
    let y = Math.round(b.y + anchor.y + (anchor.height ?? 0)) + 6;
    // 钳到工作区内，避免菜单跑出屏幕
    const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
    x = Math.min(Math.max(wa.x + 8, x), wa.x + wa.width - MENU_W - 8);
    y = Math.min(Math.max(wa.y + 8, y), wa.y + wa.height - MENU_H - 8);
    menuWin.setPosition(x, y);
    menuWin.webContents.send('menu:state', state);
    // 关键：showInactive() 显示但不抢焦点 —— 键盘输入始终留在主窗口，
    // 不会出现「菜单打开后所有按键失灵」。菜单窗口失焦/父窗口移动等
    // 场景仍会触发 close() 收起。
    menuWin.showInactive();
    // 按内容实际高度微调窗口（危险项隐藏时菜单更矮，透明区不挡点击）
    void menuWin.webContents
      .executeJavaScript('document.documentElement.scrollHeight', true)
      .then((h) => {
        if (!menuWin.isDestroyed() && typeof h === 'number' && h > 0) {
          menuWin.setContentSize(MENU_W, Math.min(Math.round(h), 240));
        }
      })
      .catch(() => {});
  };

  return { open, close, destroy };
}
