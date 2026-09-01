// 标题栏 + login 界面（shell.html）的极窄 preload：仅暴露窗口控制与连接动作，
// 不暴露任何 Node / ipcRenderer 原语。DSH 内容的 WebContentsView 不加载此 preload。
import { contextBridge, ipcRenderer } from 'electron';
import type { TitlebarMenuName } from './titlebar-menus';
import type { ShortcutAction, ShortcutBindings, ShortcutConflict, ShortcutMeta } from './shortcuts';
import type { PaletteEntry } from './palette';
import type { SavedConnection, DndSchedule } from './shell-state';

/** 主进程推送的快捷键面板状态（结构见 shortcuts.ts）。 */
export interface ShortcutsStatePayload {
  bindings: ShortcutBindings;
  actions: readonly ShortcutAction[];
  meta: Record<ShortcutAction, ShortcutMeta>;
  conflicts: ShortcutConflict[];
  envOverride: boolean;
  isMac: boolean;
}

contextBridge.exposeInMainWorld('shellWindow', {
  minimize: (): void => ipcRenderer.send('shell:minimize'),
  toggleMaximize: (): void => ipcRenderer.send('shell:toggle-maximize'),
  close: (): void => ipcRenderer.send('shell:close'),
  toggleAlwaysOnTop: (): void => ipcRenderer.send('shell:toggle-always-on-top'),
  onMaximizeChange: (cb: (isMaximized: boolean) => void): void => {
    ipcRenderer.on('shell:maximize-changed', (_e, v: boolean) => cb(v));
  },
  onAlwaysOnTopChange: (cb: (on: boolean) => void): void => {
    ipcRenderer.on('shell:alwayson-changed', (_e, v: boolean) => cb(v));
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
  // 连接阶段变化（'connected' 正常 / 'reconnecting' 断线重连中）
  onPhaseChange: (cb: (phase: 'connected' | 'reconnecting') => void): void => {
    ipcRenderer.on('shell:phase-changed', (_e, v: 'connected' | 'reconnecting') => cb(v));
  },
  // 断开连接（本地服务保持运行）
  disconnect: (): void => ipcRenderer.send('shell:disconnect'),
  // 断开连接并关闭（若为本应用启动的本地服务则一并停止）
  disconnectAndClose: (): void => ipcRenderer.send('shell:disconnect-stop'),
  // 页面内查找（内容视图快捷键唤出；查找栏渲染在标题栏下方）
  find: {
    // 输入变化 → 实时查找（空串 = 清除高亮）
    query: (text: string): void => ipcRenderer.send('shell:find', text),
    // 上一个/下一个匹配（dir=1 向下，-1 向上）
    next: (dir: 1 | -1): void => ipcRenderer.send('shell:find-next', dir),
    close: (): void => ipcRenderer.send('shell:find-close'),
    onVisible: (cb: (visible: boolean) => void): void => {
      ipcRenderer.on('shell:find-visible', (_e, v: boolean) => cb(v));
    },
    // 主进程格式化好的计数文案（'3/17' / '无结果' / ''）
    onResult: (cb: (text: string) => void): void => {
      ipcRenderer.on('shell:find-result', (_e, v: string) => cb(v));
    },
  },
  // 快捷键设置面板（「更多 → 快捷键设置…」打开；期间 DSH 内容视图临时让位）
  settings: {
    close: (): void => ipcRenderer.send('shell:settings-close'),
    onVisible: (cb: (visible: boolean) => void): void => {
      ipcRenderer.on('shell:settings-visible', (_e, v: boolean) => cb(v));
    },
    getDndSchedule: (): Promise<DndSchedule | null> => ipcRenderer.invoke('shell:dnd-schedule-get'),
    setDndSchedule: (schedule: DndSchedule): void => ipcRenderer.send('shell:dnd-schedule-set', schedule),
  },
  // 勿扰模式（静默系统通知，徽章保留）
  onDndChange: (cb: (on: boolean) => void): void => {
    ipcRenderer.on('shell:dnd-changed', (_e, v: boolean) => cb(v));
  },
  // 命令面板（Ctrl+K；动作清单由主进程按当前状态推送，执行只回传清单里的 id）
  palette: {
    run: (id: string): void => ipcRenderer.send('shell:palette-run', id),
    close: (): void => ipcRenderer.send('shell:palette-close'),
    onVisible: (cb: (visible: boolean) => void): void => {
      ipcRenderer.on('shell:palette-visible', (_e, v: boolean) => cb(v));
    },
    onModel: (cb: (entries: PaletteEntry[]) => void): void => {
      ipcRenderer.on('shell:palette-model', (_e, v: PaletteEntry[]) => cb(v));
    },
  },
  // 快捷键绑定（录制判定与冲突检查在主进程，渲染层只发原始按键事件）
  shortcuts: {
    // 请求推送一次 shell:shortcuts-state
    get: (): Promise<true | null> => ipcRenderer.invoke('shell:shortcuts-get'),
    // 录制：发送 keydown 原始修饰键/键位，返回判定结果
    record: (
      action: string,
      ev: { key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean },
    ): Promise<{ ok: boolean; error?: string; pending?: boolean; cancelled?: boolean; cleared?: boolean }> =>
      ipcRenderer.invoke('shell:shortcuts-record', action, ev),
    // 重置：动作名回该动作默认，'all' 恢复全部默认
    reset: (scope: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('shell:shortcuts-reset', scope),
    onState: (cb: (s: ShortcutsStatePayload) => void): void => {
      ipcRenderer.on('shell:shortcuts-state', (_e, v: ShortcutsStatePayload) => cb(v));
    },
  },
  // 标题栏下拉菜单（原生 Menu.popup；anchor 为按钮的页面坐标）
  menus: {
    open: (name: TitlebarMenuName, anchor: { x: number; y: number; width: number; height: number }): void =>
      ipcRenderer.send('shell:open-titlebar-menu', name, anchor),
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
    // 命名连接配置库（A1）：请求 / 删除 / 重命名
    connections: {
      request: (): void => ipcRenderer.send('login:connections'),
      remove: (id: string): void => ipcRenderer.send('login:remove-connection', id),
      rename: (id: string, name: string): void => ipcRenderer.send('login:rename-connection', id, name),
      pin: (id: string): void => ipcRenderer.send('login:pin-connection', id),
      onResult: (cb: (list: SavedConnection[]) => void): void => {
        ipcRenderer.on('login:connections-result', (_e, v: SavedConnection[]) => cb(v));
      },
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
