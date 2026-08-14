// 标题栏 + login 界面（shell.html）的极窄 preload：仅暴露窗口控制与连接动作，
// 不暴露任何 Node / ipcRenderer 原语。DSH 内容的 WebContentsView 不加载此 preload。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('shellWindow', {
  minimize: (): void => ipcRenderer.send('shell:minimize'),
  toggleMaximize: (): void => ipcRenderer.send('shell:toggle-maximize'),
  close: (): void => ipcRenderer.send('shell:close'),
  onMaximizeChange: (cb: (isMaximized: boolean) => void): void => {
    ipcRenderer.on('shell:maximize-changed', (_e, v: boolean) => cb(v));
  },
  onThemeChange: (cb: (isDark: boolean) => void): void => {
    ipcRenderer.on('shell:theme-changed', (_e, v: boolean) => cb(v));
  },
  // 连接状态（connected / url / owned）变化
  onConnectionChange: (cb: (s: { connected: boolean; url: string | null; owned: boolean }) => void): void => {
    ipcRenderer.on('shell:connection-changed', (_e, v: { connected: boolean; url: string | null; owned: boolean }) =>
      cb(v),
    );
  },
  // 断开连接（本地服务保持运行）
  disconnect: (): void => ipcRenderer.send('shell:disconnect'),
  // 断开连接并关闭（若为本应用启动的本地服务则一并停止）
  disconnectAndClose: (): void => ipcRenderer.send('shell:disconnect-stop'),
  // 断开连接菜单（conn-menu.html 独立小窗使用）
  menu: {
    close: (): void => ipcRenderer.send('menu:close'),
    disconnect: (): void => ipcRenderer.send('menu:disconnect'),
    disconnectAndClose: (): void => ipcRenderer.send('menu:disconnect-stop'),
    onState: (cb: (s: { owned: boolean; dark: boolean }) => void): void => {
      ipcRenderer.on('menu:state', (_e, v: { owned: boolean; dark: boolean }) => cb(v));
    },
  },
  // 标题栏页面（shell.html）打开/关闭菜单 + 菜单关闭通知
  connMenu: {
    open: (anchor: { x: number; y: number; width: number; height: number }): void =>
      ipcRenderer.send('shell:conn-menu-open', anchor),
    close: (): void => ipcRenderer.send('shell:conn-menu-close'),
    onClosed: (cb: () => void): void => {
      ipcRenderer.on('shell:conn-menu-closed', () => cb());
    },
  },
  login: {
    // 本地嗅探
    sniff: (): void => ipcRenderer.send('login:sniff'),
    // GUI 启动本地服务器（可指定端口，空/缺省为随机端口）
    startLocal: (port?: number | string): void => ipcRenderer.send('login:start-local', port),
    // 连接指定 URL（云端/嗅探结果点击）
    joinRemote: (url: string): void => ipcRenderer.send('login:join-remote', url),
    // 最近连接列表（请求 / 订阅 / 删除单条 / 清空）
    requestRecent: (): void => ipcRenderer.send('login:recent'),
    removeRecent: (url: string): void => ipcRenderer.send('login:remove-recent', url),
    clearRecent: (): void => ipcRenderer.send('login:clear-recent'),
    onRecentResult: (cb: (list: string[]) => void): void => {
      ipcRenderer.on('login:recent-result', (_e, v: string[]) => cb(v));
    },
    // 结果/进度订阅
    onSniffResult: (cb: (list: { url: string }[]) => void): void => {
      ipcRenderer.on('login:sniff-result', (_e, v: { url: string }[]) => cb(v));
    },
    onProgress: (cb: (msg: string) => void): void => {
      ipcRenderer.on('login:progress', (_e, v: string) => cb(v));
    },
    onResult: (cb: (r: { ok: boolean; error?: string }) => void): void => {
      ipcRenderer.on('login:result', (_e, v: { ok: boolean; error?: string }) => cb(v));
    },
    onVisible: (cb: (visible: boolean) => void): void => {
      ipcRenderer.on('login:visible', (_e, v: boolean) => cb(v));
    },
  },
});
