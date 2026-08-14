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
  login: {
    // 本地嗅探
    sniff: (): void => ipcRenderer.send('login:sniff'),
    // GUI 启动本地服务器
    startLocal: (): void => ipcRenderer.send('login:start-local'),
    // 连接指定 URL（云端/嗅探结果点击）
    joinRemote: (url: string): void => ipcRenderer.send('login:join-remote', url),
    // 最近连接列表（请求 / 订阅）
    requestRecent: (): void => ipcRenderer.send('login:recent'),
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
