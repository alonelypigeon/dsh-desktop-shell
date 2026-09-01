import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  dialog,
  ipcMain,
  globalShortcut,
  screen,
  Notification,
  WebContentsView,
  type MenuItemConstructorOptions,
} from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveConfiguredUrl } from './config';
import { validateUrl, isLoopbackHost } from './url';
import { launchLocalDsh, normalizeRequestedPort, type DshService } from './dsh-launcher';
import { probeUrl } from './probe';
import { attachSecurity, openExternalSafe } from './security';
import { loadSharedConfig, saveSharedConfig, watchSharedConfig, migrateLegacyConfig } from './shared-config';
import { takeNotifyRequest, clearNotifyPatch } from './notify-queue';
import { sniffLocalDsh, isDshInstance } from './sniffer';
import { readDshThemePreference, resolveIsDark, onSystemThemeChange, watchDshTheme } from './theme';
import { setupAutoUpdater, checkForUpdatesNow } from './updater';
import {
  loadShellState,
  saveShellState,
  mergeRecentServers,
  removeRecentServer,
  clearRecentServers,
  sanitizeBounds,
  makeConnectionId,
  migrateConnections,
  mergeSavedConnection,
  removeSavedConnection,
  renameSavedConnection,
  exportConnections,
  parseConnectionsImport,
  connectionsToRecentUrls,
  normalizeDndSchedule,
  isDndActive,
  type DndSchedule,
  type SavedConnection,
} from './shell-state';
import { parseDshShellUrl, PROTOCOL_SCHEME } from './protocol';
import {
  buildDisconnectMenuItems,
  buildServerMenuItems,
  buildMoreMenuItems,
  isTitlebarMenuName,
  type TitlebarMenuName,
} from './titlebar-menus';
import { pushShellUiState } from './shell-ui-state';
import { resolveExternalServerTarget, terminateExternalServer } from './server-stop';
import { createLogBuffer, pushLogLine, logSnapshot, type LogBuffer } from './log-buffer';
import { parseTitleCount } from './title-watcher';
import { buildPaletteEntries, type PaletteEntry } from './palette';
import { ZOOM_DEFAULT, stepZoom, normalizeZoom, formatFindCount } from './view-controls';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_META,
  conflictsFor,
  findShortcutConflicts,
  isShortcutAction,
  matchContentShortcut,
  normalizeAccelerator,
  normalizeShortcutBindings,
  recordingOutcome,
  serializeShortcutBindings,
  type RawKeyEvent,
  type ShortcutAction,
  type ShortcutBindings,
} from './shortcuts';

const TITLEBAR_HEIGHT = 42;
// 页面内查找栏高度（打开时内容视图下移让出这一条）
const FINDBAR_HEIGHT = 40;

let shellWindow: BrowserWindow | null = null;
let contentView: WebContentsView | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let ownedDsh: DshService | null = null;
let lastHandledUpdateRequest = 0;
let lastHandledServiceStop = 0;
let lastHandledNotifyId: string | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let currentThemeDark: boolean | null = null;
let connectedUrl: string | null = null;
// 内容视图当前实际地址（服务端 3xx 重定向会绕过 will-navigate 守卫，
// 标题栏/托盘显示这个值而非连接时的地址，防止「标签写着 A、页面实为 B」）。
let currentPageUrl: string | null = null;
// 连接阶段：'connected'=正常 / 'reconnecting'=断线探测中（标题栏状态点 + 通知）
let connectionPhase: 'connected' | 'reconnecting' = 'connected';
let reconnectTimer: NodeJS.Timeout | null = null;
// 退出时对「本应用启动的本地服务」的处理决定：null=未询问，'stop'=同时关闭，'keep'=保持运行
let quitDecision: 'stop' | 'keep' | null = null;
let quitDialogOpen = false;
// 窗口状态（bounds / 置顶 / 最近连接）持久化在 userData/shell-state.json
let startHidden = false; // 开机自启（--hidden）时启动到托盘，不弹窗口
let alwaysOnTop = false;
let boundsSaveTimer: NodeJS.Timeout | null = null;
let recentServers: string[] = [];
// 命名连接配置库（v0.7，兼容 old recentServers；见 shell-state.ts）。
let savedConnections: SavedConnection[] = [];
// 诊断日志环形缓冲（D3，最近 500 行）。
const diagLogs = createLogBuffer(500);
let pendingProtocolUrl: string | null = null; // macOS 冷启动时 open-url 可能先于 ready 到达
// 内容视图缩放（档位与规整见 view-controls.ts），持久化在 shell-state.json
let zoomFactor = ZOOM_DEFAULT;
// 快捷键绑定（shortcuts.ts）：全局热键 + 内容视图快捷键，可在设置面板自定义
let shortcutBindings: ShortcutBindings = { ...DEFAULT_SHORTCUTS };
// DSH_HOTKEY 环境变量正在生效（仅当用户从未自定义过全局热键；重绑/重置后固定）
let globalHotkeyEnvActive = false;
let registeredGlobalAcc: string | null = null; // 当前已注册的全局热键（换绑时精确注销）
// 页面内查找栏（内容视图 Ctrl+F 唤出；打开时内容视图下移让位）
let findBarOpen = false;
let lastFindText = '';
// 快捷键设置面板：打开期间 DSH 内容视图临时摘下（否则会盖住 shell 页面）
let settingsOpen = false;
// 命令面板（Ctrl+K）：与设置面板同一套「临时摘下内容视图」机制，两者互斥
let paletteOpen = false;
// 面板打开时下发给渲染层的动作快照（shell:palette-run 只接受其中的 id）
let currentPaletteModel: PaletteEntry[] = [];
// 勿扰模式：静默系统通知（未读徽章保留），持久化在 shell-state.json
let dndEnabled = false;
// 定时勿扰时段（B3）。
let dndSchedule: DndSchedule | undefined;
// 页面标题 "(n)" 前缀解析出的未读计数（null = 无）；窗口聚焦时视为已读清零
let unreadCount: number | null = null;
// B4：未读通知聚合（防轰炸）。
let agentNotifyTimer: NodeJS.Timeout | null = null;
let agentNotifyCount: number | null = null;

// —— 小工具 ——

// 目标地址是否为本应用启动的本地服务。
function isOwnedUrl(url: string | null): boolean {
  return ownedDsh !== null && url !== null && ownedDsh.url === url;
}

// 当前连接是否为本应用启动的本地服务（标题栏菜单 / 托盘菜单 / 连接状态共用）。
function isOwnedConnection(): boolean {
  return isOwnedUrl(connectedUrl);
}

// 当前连接是否为「非本应用启动」的本机实例（嗅探连接的外部 DSH）。
// 断开菜单据此显示「断开连接并关闭服务器」（按端口结束进程）。
function isExternalLocalConnection(): boolean {
  if (connectedUrl === null || isOwnedConnection()) return false;
  try {
    return isLoopbackHost(new URL(connectedUrl).hostname);
  } catch {
    return false;
  }
}

// 对外展示的连接地址：重定向后的实际地址优先（见 currentPageUrl 注释）。
function displayUrl(): string | null {
  return currentPageUrl ?? connectedUrl;
}

function safeOrigin(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

// 内容视图导航后同步标题栏/托盘的实际地址；主源被重定向改变时告警。
function updateCurrentPageUrl(url: string): void {
  if (currentPageUrl === url) return;
  const prevOrigin = currentPageUrl === null ? null : safeOrigin(currentPageUrl);
  const nextOrigin = safeOrigin(url);
  if (prevOrigin !== null && nextOrigin !== null && prevOrigin !== nextOrigin) {
    console.warn(`[security] page origin changed by redirect: ${prevOrigin} -> ${nextOrigin}`);
  }
  currentPageUrl = url;
  sendConnectionState();
  updateTrayMenu();
}

function shellStateFile(): string {
  return path.join(app.getPath('userData'), 'shell-state.json');
}

function showWindow(): void {
  if (!shellWindow) return;
  if (shellWindow.isMinimized()) shellWindow.restore();
  shellWindow.show();
  shellWindow.focus();
}

function toggleWindow(): void {
  if (!shellWindow) return;
  if (shellWindow.isVisible() && !shellWindow.isMinimized()) {
    shellWindow.hide();
  } else {
    showWindow();
  }
}

// —— 托盘图标 ——

function createTrayIcon(): Electron.NativeImage {
  const isMac = process.platform === 'darwin';
  const file = isMac ? 'trayTemplate.png' : 'tray.png';
  const img = nativeImage.createFromPath(path.join(__dirname, file));
  if (isMac) img.setTemplateImage(true);
  return img;
}

// —— 开机自启 ——

function applyAutoLaunch(enabled: boolean): void {
  try {
    const settings: Electron.Settings = { openAtLogin: enabled };
    // 开机自启时启动到托盘：macOS 用 openAsHidden，Windows 传 --hidden 参数。
    if (process.platform === 'darwin') settings.openAsHidden = true;
    if (process.platform === 'win32') settings.args = ['--hidden'];
    app.setLoginItemSettings(settings);
  } catch (e) {
    console.error('[shell] failed to set auto-launch:', e);
  }
}

// —— 标题栏窗口控制 IPC（仅接受 shell 窗口） ——

function setupWindowControlIpc(win: BrowserWindow): void {
  const guard = (event: Electron.IpcMainEvent): boolean => event.sender === win.webContents;

  ipcMain.on('shell:minimize', (e) => {
    if (guard(e)) win.minimize();
  });
  ipcMain.on('shell:toggle-maximize', (e) => {
    if (!guard(e)) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('shell:close', (e) => {
    if (guard(e)) win.close(); // close 事件里会转入托盘
  });
  ipcMain.on('shell:toggle-always-on-top', (e) => {
    if (guard(e)) applyAlwaysOnTop(!alwaysOnTop);
  });

  win.on('maximize', () => win.webContents.send('shell:maximize-changed', true));
  win.on('unmaximize', () => win.webContents.send('shell:maximize-changed', false));
}

// —— 窗口 / 内容视图 / login 状态 ——

function updateContentViewBounds(): void {
  if (!shellWindow || !contentView) return;
  const [w, h] = shellWindow.getContentSize();
  // 查找栏打开时内容视图下移让位（shell 页面在标题栏下渲染这一条）
  const top = TITLEBAR_HEIGHT + (findBarOpen ? FINDBAR_HEIGHT : 0);
  contentView.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
}

// —— 窗口状态记忆（bounds / 置顶） ——

function scheduleBoundsSave(): void {
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(saveBoundsNow, 500);
}

function saveBoundsNow(): void {
  if (boundsSaveTimer) {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = null;
  }
  if (!shellWindow || shellWindow.isDestroyed()) return;
  const maximized = shellWindow.isMaximized();
  // bounds 只存普通态尺寸（最大化时保留文件里的旧值，不清空不覆盖）；
  // maximized 标志始终同步，重启时按它恢复。
  const patch: Partial<{ bounds: Electron.Rectangle; maximized: boolean }> = { maximized };
  if (!maximized && !shellWindow.isMinimized()) patch.bounds = shellWindow.getBounds();
  saveShellState(shellStateFile(), patch);
}

function applyAlwaysOnTop(on: boolean): void {
  alwaysOnTop = on;
  shellWindow?.setAlwaysOnTop(on);
  saveShellState(shellStateFile(), { alwaysOnTop: on });
  // 同步标题栏置顶按钮激活态
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send('shell:alwayson-changed', on);
  }
  updateTrayMenu();
}

// 退出决策弹窗（窗口 ✕ 与托盘「退出」共用，kind 决定按钮文案）。
// 返回 'stop'（同时关服务）/'keep'（保持服务）/'cancel'；对话框已打开时重入返回 null。
async function promptQuitDecision(kind: 'close-window' | 'quit'): Promise<'stop' | 'keep' | 'cancel' | null> {
  if (quitDialogOpen || !ownedDsh) return null;
  quitDialogOpen = true;
  const isWindowClose = kind === 'close-window';
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: isWindowClose ? '关闭 DeepSeek Harness Shell' : '退出 DeepSeek Harness Shell',
    message: '是否同时关闭由本应用启动的本地 DSH 服务？',
    detail: isWindowClose
      ? `本地服务地址：${ownedDsh.url}`
      : `本地服务地址：${ownedDsh.url}\n选择「保持服务运行」后，服务继续在后台运行，下次启动可直接嗅探连接。`,
    buttons: isWindowClose
      ? ['同时关闭服务并退出', '最小化到托盘', '取消']
      : ['同时关闭服务', '保持服务运行', '取消退出'],
    defaultId: isWindowClose ? 1 : 0,
    cancelId: 2,
    noLink: true,
  };
  const parent = shellWindow && !shellWindow.isDestroyed() && shellWindow.isVisible() ? shellWindow : null;
  try {
    const r = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return r.response === 0 ? 'stop' : r.response === 1 ? 'keep' : 'cancel';
  } finally {
    quitDialogOpen = false;
  }
}

function createShellWindow(): void {
  const initialDark = resolveIsDark(readDshThemePreference());
  currentThemeDark = initialDark;

  // 恢复上次的窗口位置/尺寸（校验可见性，屏幕布局变化时回退默认值）。
  const state = loadShellState(shellStateFile());
  recentServers = state.recentServers ?? [];
  savedConnections = state.connections ?? migrateConnections({
    recentServers,
    connections: state.connections,
  });
  zoomFactor = normalizeZoom(state.zoomFactor);
  loadShortcutBindings(state.shortcuts);
  const restored = sanitizeBounds(state.bounds, screen.getAllDisplays().map((d) => d.workArea));

  const win = new BrowserWindow({
    width: restored?.width ?? 1440,
    height: restored?.height ?? 920,
    x: restored?.x,
    y: restored?.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false, // 无边框，标题栏由 shell.html 自绘
    icon: path.join(__dirname, 'icon.png'), // 窗口/任务栏图标：DeepSeek 鲸鱼
    backgroundColor: initialDark ? '#151517' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'shell-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  shellWindow = win;

  // shell 页面自身不需要弹窗与外部导航（纵深防御：即使未来出现渲染层
  // 缺陷，也无法借此打开任意弹窗或把窗口导航到远程内容）。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      console.warn(`[security] blocked shell window navigation: ${url}`);
    }
  });

  if (state.alwaysOnTop) {
    alwaysOnTop = true;
    win.setAlwaysOnTop(true);
  }
  dndEnabled = state.dnd === true;
  dndSchedule = state.dndSchedule;

  // 竞态修复：connectTo 对本机服务几毫秒即完成，attachContentView 推送的
  // 状态可能在渲染器加载 shell.js 之前发出而被丢弃 → 标题栏连接状态
  // 永远不显示。页面每次加载完成后重发全部 UI 状态使其自愈（shell-ui-state.ts）。
  win.webContents.on('did-finish-load', () => {
    const w = shellWindow;
    if (!w || w.isDestroyed()) return;
    pushShellUiState(w.webContents, {
      connectedUrl: displayUrl(),
      owned: isOwnedConnection(),
      maximized: w.isMaximized(),
      alwaysOnTop,
      findBarVisible: findBarOpen,
      settingsVisible: settingsOpen,
      paletteVisible: paletteOpen,
      dnd: dndEnabled,
      phase: connectionPhase,
    });
    // 设置面板开着时页面重载 → 重发面板所需数据（自愈，同上）
    if (settingsOpen) pushShortcutsState();
  });

  // 上次退出时最大化 → 恢复最大化（Windows 对「关闭时最大化」的窗口有
  // 重开自动最大化的启发式，但应用侧的图标/状态需要自己对齐）。
  if (state.maximized) win.maximize();

  win.once('ready-to-show', () => {
    // 开机自启（--hidden）时不打扰：窗口留在托盘，用户从托盘/快捷键唤出。
    if (!startHidden) win.show();
  });

  // 窗口聚焦即视为已读：清空未读计数与任务栏/托盘角标。
  win.on('focus', () => {
    if (unreadCount !== null) {
      unreadCount = null;
      applyUnreadBadge();
    }
  });

  win.on('close', (e) => {
    // 真正退出流程放行——但退出弹窗还在等待用户决定时不放行：
    // 否则窗口先被销毁，用户随后选「取消退出」就再也没有窗口可唤了。
    if (isQuitting && !quitDialogOpen) return;
    e.preventDefault();

    // 用户此前已做过决定（例如选了「最小化到托盘」）→ 不再重复询问
    if (quitDecision !== null) {
      win.hide();
      return;
    }
    // 本应用没有启动本地服务（嗅探连接的外部实例）→ 关闭 = 直接收进托盘
    if (!ownedDsh) {
      win.hide();
      return;
    }
    // 退出询问弹窗已打开（托盘「退出」触发）→ 等它决出结果，保持窗口现状
    if (quitDialogOpen) return;
    void promptQuitDecision('close-window').then((decision) => {
      if (decision === null || decision === 'cancel') return; // 取消：窗口保持打开
      if (decision === 'stop') {
        // 同时关闭服务并退出
        quitDecision = 'stop';
        isQuitting = true;
        app.quit();
      } else {
        // 最小化到托盘：服务继续在后台运行
        quitDecision = 'keep';
        win.hide();
      }
    });
  });
  win.on('resize', () => {
    updateContentViewBounds();
    scheduleBoundsSave();
  });
  win.on('move', scheduleBoundsSave);
  // 最大化状态变化 → 持久化 maximized 标志（bounds 只存普通态尺寸）
  win.on('maximize', scheduleBoundsSave);
  win.on('unmaximize', scheduleBoundsSave);
  win.on('show', updateTrayMenu);
  win.on('hide', updateTrayMenu);

  setupWindowControlIpc(win);
  setupLoginIpc(win);
  setupShortcutsIpc(win);
  setupPaletteIpc(win);

  // 加载标题栏 + login 界面（把当前主题作为初始值传入）
  void win.loadFile(path.join(__dirname, 'shell.html'), {
    query: { dark: initialDark ? '1' : '0' },
  });
}

// 挂载 DSH 内容视图，并隐藏 login 界面。
function attachContentView(url: string): void {
  if (!shellWindow) return;
  if (!contentView) {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        partition: 'persist:dsh',
        // 刻意不加 preload：DSH 页面保持零注入。
      },
    });
    contentView = view;
    // 恢复持久化的缩放（视图销毁重建后重新应用）
    view.webContents.setZoomFactor(zoomFactor);
    // 快捷键绑定是自定义的（shortcuts.ts），这里统一在视图层捕获分派
    view.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      // Esc 关闭查找栏（焦点回到页面但查找栏还开着的情况）
      if (input.key === 'Escape' && findBarOpen) {
        e.preventDefault();
        closeFindBar();
        return;
      }
      const action = matchContentShortcut(shortcutBindings, input);
      if (action === null) return; // 与外壳无关，放行给 DSH 页面
      e.preventDefault();
      runContentAction(action);
    });
    // 页面内查找结果 → 查找栏计数
    view.webContents.on('found-in-page', (_e, result) => {
      // finalUpdate=false 是中间计数，等最终结果再推送，避免计数闪烁
      if (!result.finalUpdate) return;
      shellWindow?.webContents.send(
        'shell:find-result',
        formatFindCount(result.activeMatchOrdinal, result.matches),
      );
    });
    // 服务端 3xx 重定向不触发 will-navigate（无法拦截），跟踪实际地址让
    // 标题栏/托盘如实显示，并在主源变化时告警（钓鱼标签防护）。
    view.webContents.on('did-navigate', (_e, url) => {
      if (typeof url === 'string' && /^https?:/i.test(url)) updateCurrentPageUrl(url);
    });
    view.webContents.on('did-navigate-in-page', (_e, url) => {
      if (typeof url === 'string' && /^https?:/i.test(url)) updateCurrentPageUrl(url);
    });
    // 页面标题的 "(n)" 前缀 = 未读信号（零注入下最可靠的「代理需要你」提示）。
    view.webContents.on('page-title-updated', (_e, title) => {
      handlePageTitle(typeof title === 'string' ? title : '');
    });
    // 设置面板打开期间不挂载（否则会盖住 shell 页面的面板），关闭时补挂
    if (!settingsOpen) shellWindow.contentView.addChildView(view);
    view.webContents.on('did-fail-load', (_e, code, desc, validatedUrl) => {
      if (code === -3) return;
      console.error(`[shell] failed to load ${validatedUrl}: ${desc} (${code})`);
      // DSH 重启/断连期间会触发：探测到服务恢复后自动重载页面。
      if (validatedUrl.startsWith('http')) {
        enterReconnecting(validatedUrl);
        scheduleReloadOnReconnect(validatedUrl);
      }
    });
  }
  const origin = new URL(url).origin;
  attachSecurity(contentView.webContents, origin);
  void contentView.webContents.loadURL(url);
  updateContentViewBounds();
  connectedUrl = url;
  currentPageUrl = url;
  unreadCount = null; // 新连接旧计数无意义
  applyUnreadBadge();
  setConnectionPhase('connected');
  shellWindow.webContents.send('login:visible', false);
  sendConnectionState();
}

// 向标题栏同步连接状态（连接地址 + 是否为本应用启动的本地服务）。
function sendConnectionState(): void {
  shellWindow?.webContents.send('shell:connection-changed', {
    connected: connectedUrl !== null,
    url: displayUrl(),
    owned: isOwnedConnection(),
  });
}


function sendConnectionsResult(): void {
  shellWindow?.webContents.send('login:connections-result', savedConnections);
}
// —— 内容视图操作（快捷键与「服务器 / 更多」菜单共用） ——

function runContentAction(action: ShortcutAction): void {
  switch (action) {
    case 'palette':
      togglePalette();
      break;
    case 'find':
      openFindBar();
      break;
    case 'reload':
      reloadContent(false);
      break;
    case 'reload-hard':
      reloadContent(true);
      break;
    case 'zoom-in':
      applyZoom(stepZoom(zoomFactor, 'in'));
      break;
    case 'zoom-out':
      applyZoom(stepZoom(zoomFactor, 'out'));
      break;
    case 'zoom-reset':
      applyZoom(ZOOM_DEFAULT);
      break;
    default:
      break; // 全局动作不经这里（globalShortcut 已注册）
  }
}

function applyZoom(z: number): void {
  if (z === zoomFactor) return;
  zoomFactor = z;
  contentView?.webContents.setZoomFactor(z);
  saveShellState(shellStateFile(), { zoomFactor: z });
}

function reloadContent(ignoreCache: boolean): void {
  if (!contentView) return;
  if (ignoreCache) contentView.webContents.reloadIgnoringCache();
  else contentView.webContents.reload();
}

// —— 页面内查找栏（内容视图 Ctrl+F 唤出；打开时内容视图下移让位） ——

function openFindBar(): void {
  const w = shellWindow;
  if (!w || w.isDestroyed() || !contentView || findBarOpen) return;
  findBarOpen = true;
  updateContentViewBounds();
  // 键盘焦点此前在 DSH 内容视图上：先把焦点转回 shell 页面，
  // 渲染层随可见消息执行 input.focus() 才能真正接收输入。
  w.webContents.focus();
  w.webContents.send('shell:find-visible', true);
}

function closeFindBar(): void {
  if (!findBarOpen) return;
  findBarOpen = false;
  lastFindText = '';
  contentView?.webContents.stopFindInPage('clearSelection');
  shellWindow?.webContents.send('shell:find-visible', false);
  updateContentViewBounds();
  contentView?.webContents.focus();
}

// —— 快捷键绑定（shortcuts.ts；设置面板可自定义） ——

// 从持久化恢复绑定。DSH_HOTKEY 环境变量只在用户从未自定义过全局热键时
// 生效（'off'/空 = 解绑）；一旦在面板里重绑或重置，持久化值固定优先。
function loadShortcutBindings(raw: Record<string, string> | undefined): void {
  shortcutBindings = normalizeShortcutBindings(raw);
  const envHotkey = process.env.DSH_HOTKEY?.trim();
  if (envHotkey !== undefined && raw?.['global-toggle-window'] === undefined) {
    if (envHotkey === '' || envHotkey.toLowerCase() === 'off') {
      shortcutBindings['global-toggle-window'] = null;
      globalHotkeyEnvActive = true;
    } else {
      const norm = normalizeAccelerator(envHotkey);
      if (norm !== null) {
        shortcutBindings['global-toggle-window'] = norm;
        globalHotkeyEnvActive = true;
      } else {
        console.warn(`[shell] invalid DSH_HOTKEY ignored: ${envHotkey}`);
      }
    }
  }
  applyGlobalHotkey();
}

// 精确换绑全局热键：先注销旧加速器再注册新的（注册失败保留解绑态并告警）。
function applyGlobalHotkey(): void {
  if (registeredGlobalAcc !== null) {
    try {
      globalShortcut.unregister(registeredGlobalAcc);
    } catch {
      /* ignore */
    }
    registeredGlobalAcc = null;
  }
  const acc = shortcutBindings['global-toggle-window'];
  if (!acc) {
    console.log('[shell] global shortcut disabled');
    return;
  }
  try {
    const ok = globalShortcut.register(acc, () => toggleWindow());
    if (ok) {
      registeredGlobalAcc = acc;
      console.log(`[shell] global shortcut registered: ${acc}`);
    } else {
      console.warn(`[shell] global shortcut register FAILED (taken by another app?): ${acc}`);
    }
  } catch (e) {
    console.warn('[shell] global shortcut unavailable:', e);
  }
}

// 写入一条绑定并持久化；全局热键即时重注册。
function applyShortcutBinding(action: ShortcutAction, acc: string | null): void {
  shortcutBindings[action] = acc;
  saveShellState(shellStateFile(), { shortcuts: serializeShortcutBindings(shortcutBindings) });
  if (action === 'global-toggle-window') {
    globalHotkeyEnvActive = false; // 用户显式选择后，环境变量不再参与
    applyGlobalHotkey();
  }
}

// 向设置面板推送完整状态（绑定 + 元信息 + 冲突 + 环境变量覆盖标志）
function pushShortcutsState(): void {
  const w = shellWindow;
  if (!w || w.isDestroyed()) return;
  w.webContents.send('shell:shortcuts-state', {
    bindings: shortcutBindings,
    actions: SHORTCUT_ACTIONS,
    meta: SHORTCUT_META,
    conflicts: findShortcutConflicts(shortcutBindings),
    envOverride: globalHotkeyEnvActive,
    isMac: process.platform === 'darwin',
  });
}

// —— 快捷键设置面板（「更多」菜单打开） ——

// DSH 内容视图始终合成在 shell 页面之上，面板打开期间临时摘下视图，
// 关闭时原样挂回（连接状态不变，页面不重载）。与命令面板互斥（同时只开一个）。
function openShortcutsSettings(): void {
  const w = shellWindow;
  if (!w || w.isDestroyed() || settingsOpen) return;
  if (paletteOpen) closePalette();
  settingsOpen = true;
  showWindow();
  if (contentView) w.contentView.removeChildView(contentView);
  // 焦点交给 shell 页面：面板按钮与录制捕获需要键盘输入
  w.webContents.focus();
  w.webContents.send('shell:settings-visible', true);
  pushShortcutsState();
}

function closeShortcutsSettings(): void {
  if (!settingsOpen) return;
  settingsOpen = false;
  const w = shellWindow;
  if (!w || w.isDestroyed()) return;
  if (contentView) {
    w.contentView.addChildView(contentView);
    updateContentViewBounds();
    contentView.webContents.focus();
  }
  w.webContents.send('shell:settings-visible', false);
}

// 设置面板 IPC（invoke 式：渲染层录制/重置后立即拿结果； sender 仅限 shell 窗口）
function setupShortcutsIpc(win: BrowserWindow): void {
  const guard = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    event.sender === win.webContents;

  ipcMain.handle('shell:shortcuts-get', (e) => {
    if (!guard(e)) return null;
    pushShortcutsState();
    return true;
  });

  // 录制：渲染层把 keydown 的原始修饰键/键位发来，判定与冲突检查都在主进程
  ipcMain.handle('shell:shortcuts-record', (e, action: unknown, raw: unknown) => {
    if (!guard(e) || !isShortcutAction(action)) return { ok: false, error: '无效动作' };
    const ev = normalizeRawKeyEvent(raw);
    if (ev === null) return { ok: false, error: '无效按键事件' };
    const outcome = recordingOutcome(ev);
    if (outcome.kind === 'pending') return { ok: true, pending: true };
    if (outcome.kind === 'cancel') return { ok: true, cancelled: true };
    if (outcome.kind === 'clear') {
      applyShortcutBinding(action, null);
      pushShortcutsState();
      return { ok: true, cleared: true };
    }
    if (outcome.kind === 'invalid') return { ok: false, error: outcome.reason };
    const others = conflictsFor(action, outcome.accelerator, shortcutBindings);
    if (others.length > 0) {
      const names = others.map((a) => SHORTCUT_META[a].label).join('、');
      return { ok: false, error: `与「${names}」的快捷键冲突` };
    }
    applyShortcutBinding(action, outcome.accelerator);
    pushShortcutsState();
    return { ok: true };
  });

  // 重置：单个动作回默认，或 'all' 恢复全部默认
  ipcMain.handle('shell:shortcuts-reset', (e, scope: unknown) => {
    if (!guard(e)) return { ok: false, error: '无效请求' };
    if (scope === 'all') {
      shortcutBindings = { ...DEFAULT_SHORTCUTS };
      globalHotkeyEnvActive = false;
      saveShellState(shellStateFile(), { shortcuts: serializeShortcutBindings(shortcutBindings) });
      applyGlobalHotkey();
      pushShortcutsState();
      return { ok: true };
    }
    if (!isShortcutAction(scope)) return { ok: false, error: '无效动作' };
    applyShortcutBinding(scope, DEFAULT_SHORTCUTS[scope]);
    pushShortcutsState();
    return { ok: true };
  });

  ipcMain.on('shell:settings-close', (e) => {
    if (guard(e)) closeShortcutsSettings();
  });
  // B3: dnd schedule IPC
  ipcMain.handle('shell:dnd-schedule-get', (e) => {
    if (!guard(e)) return null;
    return dndSchedule ?? null;
  });
  ipcMain.on('shell:dnd-schedule-set', (e, raw: unknown) => {
    if (!guard(e)) return;
    const normalized = normalizeDndSchedule(raw);
    setDndSchedule(normalized ?? undefined);
  });

}

function normalizeRawKeyEvent(raw: unknown): RawKeyEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string') return null;
  return {
    key: r.key,
    control: r.control === true,
    shift: r.shift === true,
    alt: r.alt === true,
    meta: r.meta === true,
  };
}

// —— 命令面板（Ctrl+K，可重绑；清单构建见 palette.ts 纯函数） ——

// 打开面板：临时摘下内容视图（同设置面板），推送最新动作快照。
function openPalette(): void {
  const w = shellWindow;
  if (!w || w.isDestroyed() || paletteOpen) return;
  if (settingsOpen) closeShortcutsSettings(); // 与设置面板互斥
  paletteOpen = true;
  showWindow();
  if (contentView) w.contentView.removeChildView(contentView);
  // 焦点交给 shell 页面：过滤输入需要键盘
  w.webContents.focus();
  w.webContents.send('shell:palette-visible', true);
  pushPaletteModel();
}

function closePalette(): void {
  if (!paletteOpen) return;
  paletteOpen = false;
  const w = shellWindow;
  if (!w || w.isDestroyed()) return;
  w.webContents.send('shell:palette-visible', false);
  if (contentView) {
    w.contentView.addChildView(contentView);
    updateContentViewBounds();
    contentView.webContents.focus();
  }
}

function togglePalette(): void {
  if (paletteOpen) closePalette();
  else openPalette();
}

// 按当前状态重建动作快照并下发（每次打开时重建，数据不会过期）。
function pushPaletteModel(): void {
  const w = shellWindow;
  if (!w || w.isDestroyed()) return;
  currentPaletteModel = buildPaletteEntries({
    connectedUrl,
    ownedRunning: ownedDsh !== null,
    recentServers,
    dnd: dndEnabled,
    alwaysOnTop,
    zoomFactor,
  });
  w.webContents.send('shell:palette-model', currentPaletteModel);
}

// 面板动作分发：id 只接受当前快照里出现过的（渲染层无法注入任意命令）。
function runPaletteAction(id: string): void {
  if (id.startsWith('connect:')) {
    const url = recentServers[Number(id.slice('connect:'.length))];
    if (typeof url === 'string' && url !== '') void joinRemoteUrl(url);
    return;
  }
  switch (id) {
    case 'disconnect':
      disconnectConnection();
      break;
    case 'switch-server':
      switchServer();
      break;
    case 'start-local':
      showWindow();
      void startLocalService(shellWindow);
      break;
    case 'stop-local':
      stopLocalService();
      break;
    case 'reload':
      reloadContent(false);
      break;
    case 'reload-hard':
      reloadContent(true);
      break;
    case 'find':
      openFindBar();
      break;
    case 'zoom-in':
      applyZoom(stepZoom(zoomFactor, 'in'));
      break;
    case 'zoom-out':
      applyZoom(stepZoom(zoomFactor, 'out'));
      break;
    case 'zoom-reset':
      applyZoom(ZOOM_DEFAULT);
      break;
    case 'toggle-ontop':
      applyAlwaysOnTop(!alwaysOnTop);
      break;
    case 'check-updates':
      checkForUpdatesNow();
      break;
    case 'shortcuts':
      openShortcutsSettings();
      break;
    case 'dnd':
      setDnd(!dndEnabled);
      break;
    case 'quit':
      isQuitting = true;
      app.quit();
      break;
    default:
      break; // 未知 id（快照已换代）忽略
  }
}

// 面板 IPC（sender 仅限 shell 窗口）
function setupPaletteIpc(win: BrowserWindow): void {
  const guard = (event: Electron.IpcMainEvent): boolean => event.sender === win.webContents;

  ipcMain.on('shell:palette-run', (e, id: unknown) => {
    if (!guard(e) || typeof id !== 'string') return;
    // 只接受当前快照里的 id，且执行前先收起面板（挂回内容视图）
    if (!currentPaletteModel.some((en) => en.id === id)) return;
    closePalette();
    runPaletteAction(id);
  });

  ipcMain.on('shell:palette-close', (e) => {
    if (guard(e)) closePalette();
  });
}

// —— 未读计数：标题前缀 → 角标 + 系统通知（零注入，见 title-watcher.ts） ——

function handlePageTitle(title: string): void {
  const n = parseTitleCount(title);
  if (n === unreadCount) return;
  const increased = n !== null && (unreadCount === null || n > unreadCount);
  unreadCount = n;
  applyUnreadBadge();
  // 窗口藏在托盘/最小化且计数增加 → 聚合后通知（聚焦窗口即视为已读）
  if (increased && isWindowAway()) scheduleAgentNotification(n);
}

function isWindowAway(): boolean {
  const w = shellWindow;
  if (!w || w.isDestroyed()) return false;
  return !w.isVisible() || w.isMinimized();
}


// B4：短暂窗口内合并多次未读增长，只弹一次通知，避免“1、2、3…”连续轰炸。
function scheduleAgentNotification(n: number): void {
  agentNotifyCount = n;
  if (agentNotifyTimer) clearTimeout(agentNotifyTimer);
  const timer = setTimeout(() => {
    agentNotifyTimer = null;
    const count = agentNotifyCount;
    agentNotifyCount = null;
    if (count !== null && isWindowAway()) notifyAgentAttention(count);
  }, 1200);
  agentNotifyTimer = timer;
  timer.unref?.();
}

function isNotificationMuted(): boolean {
  return isDndActive(dndEnabled, dndSchedule, new Date());
}

function notifyAgentAttention(n: number): void {
  if (isNotificationMuted() || !Notification.isSupported()) return;
  try {
    const noti = new Notification({
      title: 'DSH 需要你的注意',
      body: `检测到 ${n} 条未读消息，点击聚焦窗口查看。`,
    });
    noti.on('click', () => showWindow());
    noti.show();
  } catch (e) {
    console.warn('[shell] notification failed:', e);
  }
}


// 未读角标图（scripts/generate-badges.mjs 预渲染，按计数选用）。
function createBadgeImage(n: number): Electron.NativeImage {
  const file = n > 99 ? 'badge-99plus.png' : `badge-${n}.png`;
  return nativeImage.createFromPath(path.join(__dirname, 'badges', file));
}

// 三平台角标：Windows 任务栏覆盖图标 / macOS Dock+托盘文本 / Linux 桌面角标。
function applyUnreadBadge(): void {
  const w = shellWindow;
  if (process.platform === 'win32') {
    if (!w || w.isDestroyed()) return;
    try {
      w.setOverlayIcon(unreadCount !== null ? createBadgeImage(unreadCount) : null, unreadCount !== null ? `${unreadCount} 条未读消息` : '');
    } catch (e) {
      console.warn('[shell] setOverlayIcon failed:', e);
    }
    return;
  }
  try {
    app.setBadgeCount(unreadCount ?? 0);
  } catch {
    /* 无 Dock/Unity 环境静默失败 */
  }
  if (process.platform === 'darwin' && tray) {
    try {
      tray.setTitle(unreadCount !== null ? String(unreadCount) : '');
    } catch {
      /* ignore */
    }
  }
}

// —— 勿扰模式：静默系统通知（未读徽章保留），持久化在 shell-state.json ——

function setDnd(on: boolean): void {
  dndEnabled = on;
  saveShellState(shellStateFile(), { dnd: on });
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send('shell:dnd-changed', on);
  }
  updateTrayMenu();
}

function setDndSchedule(schedule: DndSchedule | undefined): void {
  dndSchedule = schedule;
  saveShellState(shellStateFile(), schedule ? { dndSchedule: schedule } : { dndSchedule: undefined });
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send('shell:dnd-schedule-changed', dndSchedule ?? null);
  }
  updateTrayMenu();
}


// —— 连接状态可视化 + 断线/恢复系统通知 ——
// 断线自动重连原本是静默的：DSH 重启期间用户只看到页面转圈。现在断线
// 时标题栏状态点变黄并弹系统通知，恢复后回绿并通知。

function notifyConnection(title: string, body: string): void {
  if (isNotificationMuted()) return; // 勿扰/定时勿扰：连接状态变化只保留标题栏状态点，不弹通知
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body, silent: true }).show();
  } catch (e) {
    console.warn('[shell] notification failed:', e);
  }
}

function setConnectionPhase(phase: 'connected' | 'reconnecting'): void {
  if (connectionPhase === phase) return;
  connectionPhase = phase;
  shellWindow?.webContents.send('shell:phase-changed', phase);
  updateTrayMenu();
}

// 断线进入重连探测：状态点变黄 + 系统通知（仅已连接过的场景，避免启动噪音）
function enterReconnecting(url: string): void {
  if (connectionPhase === 'reconnecting') return;
  setConnectionPhase('reconnecting');
  notifyConnection('连接已断开', `${url}\n正在自动重连…`);
}

// 服务恢复：状态点回绿 + 通知
function exitReconnecting(url: string): void {
  if (connectionPhase !== 'reconnecting') return;
  setConnectionPhase('connected');
  notifyConnection('已恢复连接', `${url}\n页面已自动重新加载。`);
}

// 移除 DSH 内容视图，重新显示 login 界面（切换服务器）。
function detachContentView(): void {
  // 内容视图即将销毁：收起查找栏（不必 stopFindInPage，视图马上关闭）
  if (findBarOpen) {
    findBarOpen = false;
    lastFindText = '';
    shellWindow?.webContents.send('shell:find-visible', false);
  }
  if (shellWindow && contentView) {
    shellWindow.contentView.removeChildView(contentView);
    contentView.webContents.close();
    contentView = null;
  }
  connectedUrl = null;
  currentPageUrl = null;
  unreadCount = null;
  applyUnreadBadge();
  setConnectionPhase('connected'); // 复位（login 态不显示状态点）
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
  shellWindow?.webContents.send('login:visible', true);
  shellWindow?.webContents.send('login:recent-result', recentServers);
  sendConnectionState();
  updateTrayMenu();
}

// DSH 重启/断连后的自动恢复：每 3 秒探测一次，服务恢复即重载页面。
function scheduleReloadOnReconnect(url: string): void {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(() => {
    void (async () => {
      if (!contentView) {
        if (reconnectTimer) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }
        return;
      }
      if (await probeUrl(url)) {
        if (reconnectTimer) {
          clearInterval(reconnectTimer);
          reconnectTimer = null;
        }
        console.log(`[shell] service back at ${url}, reloading`);
        exitReconnecting(url);
        void contentView.webContents.reload();
      }
    })();
  }, 3000);
}

function showLoginError(msg: string): void {
  shellWindow?.webContents.send('login:result', { ok: false, error: msg });
}

// —— login IPC ——

function setupLoginIpc(win: BrowserWindow): void {
  const guard = (event: Electron.IpcMainEvent): boolean => event.sender === win.webContents;

  // 本地嗅探
  ipcMain.on('login:sniff', (e) => {
    if (!guard(e)) return;
    void (async () => {
      const prev = loadSharedConfig().url;
      const list = await sniffLocalDsh(prev);
      win.webContents.send('login:sniff-result', list);
    })();
  });

  // GUI 启动本地服务器（login 界面按钮与托盘「管理服务器」共用）
  // 第二个参数是可选端口（字符串/数字，空表示随机端口）。
  ipcMain.on('login:start-local', (e, port: unknown) => {
    if (!guard(e)) return;
    const normalized = normalizeRequestedPort(port);
    if (normalized === null) {
      showLoginError('端口无效：请输入 1-65535 之间的整数');
      return;
    }
    void startLocalService(win, normalized);
  });

  // 连接指定 URL（云端输入 / 嗅探结果点击 / 深链协议共用）
  ipcMain.on('login:join-remote', (e, rawUrl: unknown) => {
    if (!guard(e)) return;
    void joinRemoteUrl(typeof rawUrl === 'string' ? rawUrl : '');
  });

  // 断开连接（返回 login 界面；本应用启动的本地服务保持运行）
  ipcMain.on('shell:disconnect', (e) => {
    if (!guard(e)) return;
    disconnectConnection();
  });

  // 断开连接并关闭：若连着的是本应用启动的本地服务，一并停止
  ipcMain.on('shell:disconnect-stop', (e) => {
    if (!guard(e)) return;
    disconnectAndStop();
  });

  // —— 页面内查找（查找栏在标题栏下方，内容视图快捷键唤出） ——
  ipcMain.on('shell:find', (e, text: unknown) => {
    if (!guard(e)) return;
    if (!contentView) return;
    lastFindText = typeof text === 'string' ? text : '';
    if (lastFindText === '') {
      contentView.webContents.stopFindInPage('clearSelection');
      win.webContents.send('shell:find-result', '');
      return;
    }
    contentView.webContents.findInPage(lastFindText, { forward: true });
  });

  // 上一个/下一个匹配（dir=1 向下，-1 向上）
  ipcMain.on('shell:find-next', (e, dir: unknown) => {
    if (!guard(e)) return;
    if (!contentView || lastFindText === '') return;
    contentView.webContents.findInPage(lastFindText, { forward: dir !== -1, findNext: true });
  });

  ipcMain.on('shell:find-close', (e) => {
    if (!guard(e)) return;
    closeFindBar();
  });

  // 最近连接列表（login 界面展示）
  ipcMain.on('login:recent', (e) => {
    if (!guard(e)) return;
    win.webContents.send('login:recent-result', recentServers);
  });

  // 删除一条最近连接记录（login 界面 × 按钮）
  ipcMain.on('login:remove-recent', (e, rawUrl: unknown) => {
    if (!guard(e)) return;
    const url = typeof rawUrl === 'string' ? rawUrl : '';
    if (!url) return;
    recentServers = removeRecentServer(recentServers, url);
    saveShellState(shellStateFile(), { recentServers });
    win.webContents.send('login:recent-result', recentServers);
  });

  // 清空最近连接记录（login 界面「清除全部」）
  ipcMain.on('login:clear-recent', (e) => {
    if (!guard(e)) return;
    recentServers = clearRecentServers();
    saveShellState(shellStateFile(), { recentServers });
    win.webContents.send('login:recent-result', recentServers);
  });


  // 命名连接配置库（A1）：请求 / 删除 / 重命名
  ipcMain.on('login:connections', (e) => {
    if (!guard(e)) return;
    win.webContents.send('login:connections-result', savedConnections);
  });
  ipcMain.on('login:remove-connection', (e, id: unknown) => {
    if (!guard(e) || typeof id !== 'string') return;
    savedConnections = removeSavedConnection(savedConnections, id);
    recentServers = connectionsToRecentUrls(savedConnections).slice(0, 5);
    saveShellState(shellStateFile(), { connections: savedConnections, recentServers });
    win.webContents.send('login:connections-result', savedConnections);
    win.webContents.send('login:recent-result', recentServers);
  });
  ipcMain.on('login:rename-connection', (e, id: unknown, name: unknown) => {
  ipcMain.on('login:pin-connection', (e, id: unknown) => {
    if (!guard(e) || typeof id !== 'string') return;
    const target = savedConnections.find((c) => c.id === id);
    if (!target) return;
    savedConnections = mergeSavedConnection(
      savedConnections.filter((c) => c.id !== id),
      { ...target, lastUsed: Date.now() },
    );
    saveShellState(shellStateFile(), { connections: savedConnections });
    win.webContents.send('login:connections-result', savedConnections);
  });
    if (!guard(e) || typeof id !== 'string' || typeof name !== 'string') return;
    savedConnections = renameSavedConnection(savedConnections, id, name);
    saveShellState(shellStateFile(), { connections: savedConnections });
    win.webContents.send('login:connections-result', savedConnections);
  });
  // 打开标题栏下拉菜单（disconnect / server / more，原生 Menu.popup）
  ipcMain.on('shell:open-titlebar-menu', (e, name: unknown, anchor: unknown) => {
    if (!guard(e)) return;
    if (!isTitlebarMenuName(name)) return;
    if (!anchor || typeof anchor !== 'object') return;
    const r = anchor as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    // 有限数校验：NaN/Infinity 会导致菜单弹到垃圾坐标（typeof 检查放行它们）
    if (
      typeof r.x !== 'number' ||
      typeof r.y !== 'number' ||
      typeof r.width !== 'number' ||
      typeof r.height !== 'number' ||
      !Number.isFinite(r.x) ||
      !Number.isFinite(r.y) ||
      !Number.isFinite(r.width) ||
      !Number.isFinite(r.height)
    ) {
      return;
    }
    openTitlebarMenu(name, { x: r.x, y: r.y, width: r.width, height: r.height });
  });
}

// 打开标题栏下拉菜单：原生菜单绘制在所有 Web 内容之上（不被 DSH 内容
// 视图遮挡），Esc / 点击外部 / 窗口失焦自动收起，无需任何子窗口状态管理。
function openTitlebarMenu(name: TitlebarMenuName, anchor: Electron.Rectangle): void {
  if (!shellWindow || shellWindow.isDestroyed()) return;
  let items: Electron.MenuItemConstructorOptions[];
  if (name === 'disconnect') {
    items = buildDisconnectMenuItems(
      { owned: isOwnedConnection(), externalLocal: isExternalLocalConnection() },
      {
        disconnect: () => disconnectConnection(),
        disconnectAndStop: () => disconnectAndStop(),
        disconnectAndStopServer: () => void disconnectAndStopServer(),
      },
    );
  } else if (name === 'server') {
    items = buildServerMenuItems(
      { ownedRunning: ownedDsh !== null, connectedUrl, accelerators: shortcutBindings },
      {
        startLocal: () => {
          showWindow();
          void startLocalService(shellWindow);
        },
        stopLocal: () => stopLocalService(),
        switchServer: () => switchServer(),
        reload: () => reloadContent(false),
        reloadHard: () => reloadContent(true),
        openInBrowser: connectedUrl
          ? () => {
              // 与内容视图同一条外链策略（仅 http/https 交系统浏览器）
              openExternalSafe(connectedUrl!);
            }
          : null,
      },
    );
  } else {
    items = buildMoreMenuItems(
      { zoomFactor, accelerators: shortcutBindings, dnd: dndEnabled },
      {
        palette: () => togglePalette(),
        zoomIn: () => applyZoom(stepZoom(zoomFactor, 'in')),
        zoomOut: () => applyZoom(stepZoom(zoomFactor, 'out')),
        zoomReset: () => applyZoom(ZOOM_DEFAULT),
        shortcuts: () => openShortcutsSettings(),
        toggleDnd: () => setDnd(!dndEnabled),
        exportConnections: () => exportConnectionsToFile(),
        importConnections: () => importConnectionsFromFile(),
        showDiagnostics: () => showDiagnostics(),
        checkUpdates: () => checkForUpdatesNow(),
        about: () => showAboutDialog(),
        quit: () => {
          isQuitting = true;
          app.quit();
        },
      },
    );
  }
  const menu = Menu.buildFromTemplate(items);
  // 渲染层坐标（CSS px = DIP）→ 屏幕坐标：frameless 窗口内容区即整个窗口。
  const cb = shellWindow.getContentBounds();
  const x = Math.round(cb.x + anchor.x);
  const y = Math.round(cb.y + anchor.y + anchor.height + 4);
  menu.popup({ window: shellWindow, x, y });
}

// 非回环地址连接前的确认弹窗（login 手动连接 / 深链 / 启动自动连接共用）。
// 回环地址豁免；其余一律显式征得同意后才加载远程页面。
async function confirmRemoteConnect(url: string): Promise<boolean> {
  if (isLoopbackHost(new URL(url).hostname)) return true;
  const parent = shellWindow && !shellWindow.isDestroyed() && shellWindow.isVisible() ? shellWindow : undefined;
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: '连接远程服务器',
    message: `将连接到远程服务器：${url}`,
    detail: '远程页面将在隔离的沙箱视图中加载，仅允许 http/https 外链。是否继续？',
    buttons: ['连接', '取消'],
    defaultId: 0,
    cancelId: 1,
  };
  const r = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return r.response === 0;
}

// 校验 + 确认 + 连接一条 URL；非回环地址弹确认（深链触发的远程地址同样受保护）。
async function joinRemoteUrl(rawUrl: string): Promise<void> {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    showLoginError('请输入服务器地址');
    return;
  }
  let url: string;
  try {
    url = validateUrl(rawUrl.trim());
  } catch (err) {
    showLoginError(err instanceof Error ? err.message : String(err));
    return;
  }

  // 非回环地址 → 弹确认（isLoopbackHost 处理 127.0.0.0/8 / localhost / [::1]）
  if (!(await confirmRemoteConnect(url))) {
    showLoginError('已取消');
    return;
  }

  const ok = await connectTo(url);
  if (!ok) showLoginError(`无法连接到 ${url}`);
}

// —— 连接：探测连通后挂载视图；失败回 login 并报错 ——

async function connectTo(url: string): Promise<boolean> {
  const knownOwn = isOwnedUrl(url);
  if (!knownOwn && !(await probeUrl(url))) {
    showLoginError(`无法连接到 ${url}`);
    detachContentView();
    return false;
  }
  saveSharedConfig({ url });
  // 记入最近连接（login 界面展示，快速重连），同时更新命名连接配置库。
  recentServers = mergeRecentServers(recentServers, url);
  let connKind: SavedConnection['kind'] = 'remote';
  try {
    if (isOwnedUrl(url)) connKind = 'local-start';
    else if (isLoopbackHost(new URL(url).hostname)) connKind = 'sniffed';
  } catch {
    /* 保留 remote */
  }
  savedConnections = mergeSavedConnection(savedConnections, {
    id: makeConnectionId(url),
    name: url,
    url,
    kind: connKind,
    lastUsed: Date.now(),
  });
  saveShellState(shellStateFile(), { recentServers, connections: savedConnections });
  sendConnectionsResult();
  attachContentView(url);
  updateTrayMenu();
  // 连接成功也要通知 login 表单复位 busy 态：login 只是隐藏不是卸载，
  // 不发这条「连接中…」会一直残留到「切换服务器」回来（按钮禁用 + 文案停旧）。
  shellWindow?.webContents.send('login:result', { ok: true });
  return true;
}

// —— 本地服务管理（login IPC 与托盘「管理服务器」共用） ——

// 启动本地 DSH 服务并连接；progress 消息发送给 login 界面（窗口隐藏时无害）。
// port: 0 表示随机端口（GUI 未指定时）。
async function startLocalService(win: BrowserWindow | null, port = 0): Promise<void> {
  // 已经在运行（本应用启动的）→ 直接复用
  if (ownedDsh) {
    win?.webContents.send('login:progress', `本地实例已在运行：${ownedDsh.url}`);
    const ok = await connectTo(ownedDsh.url);
    if (!ok) showLoginError('本地实例无法访问');
    return;
  }
  const service = await launchLocalDsh({
    port,
    onLog: (line) => pushLogLine(diagLogs, line),
    onProgress: (phase, detail) => {
      const msg =
        phase === 'found'
          ? `已监听 ${detail}，正在确认…`
          : phase === 'ready'
            ? `就绪：${detail}`
            : detail ?? phase;
      win?.webContents.send('login:progress', msg);
    },
  });
  if (!service) {
    showLoginError('本地服务器启动失败（找不到 dsh 或启动超时）');
    return;
  }
  ownedDsh = service;
  const ok = await connectTo(service.url);
  if (!ok) showLoginError(`已启动但无法访问 ${service.url}`);
}

// 停止由本应用启动的本地服务；若当前正连着它则断开回 login 界面。
function stopLocalService(): void {
  if (!ownedDsh) {
    void dialog.showMessageBox({
      type: 'info',
      title: '本地服务',
      message: '当前没有由本应用启动的本地 DSH 服务。',
    });
    return;
  }
  const url = ownedDsh.url;
  ownedDsh.stop();
  ownedDsh = null;
  if (connectedUrl === url) detachContentView();
  void dialog.showMessageBox({
    type: 'info',
    title: '本地服务',
    message: `本地 DSH 服务已停止：${url}`,
  });
}

// —— 断开连接（login IPC 与托盘菜单共用） ——

// 断开连接：回到 login 界面；本应用启动的本地服务保持后台运行（可再嗅探连接）。
// 显式断开会清掉共享配置里的 url，避免下次启动自动重连到同一服务器。
function disconnectConnection(): void {
  detachContentView();
  saveSharedConfig({ url: undefined });
  showWindow();
}

// 断开连接并关闭：若当前连接的是本应用启动的本地服务，一并停止它。
function disconnectAndStop(): void {
  const url = connectedUrl;
  detachContentView();
  if (isOwnedUrl(url)) {
    ownedDsh?.stop();
    ownedDsh = null;
  }
  saveSharedConfig({ url: undefined });
  showWindow();
}

// 断开连接并关闭服务器：针对非本应用启动的本机实例（嗅探连接）。
// 安全约束（防止误杀恰好监听同一端口的无关本机服务，如开发服务器/数据库）：
//   1) 先按端口定位进程，把 PID 摆到用户面前，显式确认后才结束；
//   2) 尽力做一次 DSH 指纹校验（index + 官方 favicon，与嗅探同标准）；
//      未通过（可能需要登录）时改用强警告文案，默认按钮为「取消」。
async function disconnectAndStopServer(): Promise<void> {
  const url = connectedUrl;
  if (!url) return;

  const resolved = await resolveExternalServerTarget(url);
  if ('error' in resolved) {
    // 定位失败（多半是进程已自行退出）：按原行为断开连接即可，不动任何进程。
    detachContentView();
    saveSharedConfig({ url: undefined });
    showWindow();
    void dialog.showMessageBox({
      type: 'info',
      title: '关闭服务器',
      message: '未找到服务器进程，已断开连接',
      detail: resolved.error,
      buttons: ['确定'],
      noLink: true,
    });
    return;
  }
  const target = resolved.target;

  const verified = await isDshInstance(url);
  const pidText = target.pids.join(', ');
  const parent = shellWindow && !shellWindow.isDestroyed() && shellWindow.isVisible() ? shellWindow : undefined;
  const options: Electron.MessageBoxOptions = verified
    ? {
        type: 'question',
        title: '关闭本机服务器',
        message: `将结束监听 ${target.origin} 的服务器进程`,
        detail: `进程 PID：${pidText}\n断开连接后将结束上述进程树。`,
        buttons: ['结束进程并断开', '取消'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }
    : {
        type: 'warning',
        title: '关闭本机服务器（未通过校验）',
        message: `无法确认 ${target.origin} 是 DSH 服务`,
        detail: `该地址未通过 DSH 指纹校验（页面可能需要登录）。\n监听该端口的进程 PID：${pidText}\n结束错误的进程可能影响其他本机服务，请自行确认。`,
        buttons: ['仍要结束进程并断开', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
  const r = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
  if (r.response !== 0) return; // 取消：保持连接现状，不动进程

  detachContentView();
  saveSharedConfig({ url: undefined });
  showWindow();

  const result = await terminateExternalServer(target);
  const resultOptions: Electron.MessageBoxOptions = {
    type: result.ok ? 'info' : 'warning',
    title: '关闭服务器',
    message: result.ok ? '本机 DSH 服务器已停止' : '无法停止本机服务器',
    detail: result.detail,
    buttons: ['确定'],
    noLink: true,
  };
  const resultParent =
    shellWindow && !shellWindow.isDestroyed() && shellWindow.isVisible() ? shellWindow : undefined;
  void (resultParent
    ? dialog.showMessageBox(resultParent, resultOptions)
    : dialog.showMessageBox(resultOptions));
}

// —— 关于对话框（标题栏「更多」菜单用） ——

function showAboutDialog(): void {
  const parent = shellWindow && !shellWindow.isDestroyed() && shellWindow.isVisible() ? shellWindow : undefined;
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: '关于 DeepSeek Harness Shell',
    message: `DeepSeek Harness Shell v${app.getVersion()}`,
    detail: '社区实验项目，非 DeepSeek 官方产品。\nMIT License · dsh-desktop-shell contributors',
    buttons: ['确定'],
    noLink: true,
  };
  void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
}

// —— 连接配置库导入/导出（「更多」菜单；A4，调研见 docs/competitive-research-2026-08.md） ——

function exportConnectionsToFile(): void {
  const parent = shellWindow && !shellWindow.isDestroyed() && shellWindow.isVisible() ? shellWindow : undefined;
  const options: Electron.SaveDialogOptions = {
    title: '导出连接配置',
    defaultPath: 'dsh-connections.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  void (async () => {
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return;
    try {
      fs.writeFileSync(result.filePath, exportConnections(savedConnections), 'utf-8');
    } catch (err) {
      void dialog.showMessageBox({
        type: 'error',
        title: '导出失败',
        message: `无法写入连接配置文件：${err instanceof Error ? err.message : String(err)}`,
        buttons: ['确定'],
        noLink: true,
      });
    }
  })();
}

function importConnectionsFromFile(): void {
  const parent = shellWindow && !shellWindow.isDestroyed() && shellWindow.isVisible() ? shellWindow : undefined;
  const options: Electron.OpenDialogOptions = {
    title: '导入连接配置',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  void (async () => {
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return;
    const file = result.filePaths[0];
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      void dialog.showMessageBox({
        type: 'error',
        title: '导入失败',
        message: `无法读取连接配置文件：${err instanceof Error ? err.message : String(err)}`,
        buttons: ['确定'],
        noLink: true,
      });
      return;
    }
    const imported = parseConnectionsImport(raw);
    if (imported.length === 0) {
      void dialog.showMessageBox({
        type: 'warning',
        title: '导入失败',
        message: '文件中没有可用的连接配置（需要包含合法的 http/https 地址）。',
        buttons: ['确定'],
        noLink: true,
      });
      return;
    }
    for (const conn of imported) {
      savedConnections = mergeSavedConnection(savedConnections, conn);
    }
    recentServers = connectionsToRecentUrls(savedConnections).slice(0, 5);
    saveShellState(shellStateFile(), { connections: savedConnections, recentServers });
    shellWindow?.webContents.send('login:recent-result', recentServers);
    sendConnectionsResult();
    void dialog.showMessageBox({
      type: 'info',
      title: '导入完成',
      message: `已导入 ${imported.length} 条连接配置。`,
      buttons: ['确定'],
      noLink: true,
    });
  })();
}

// —— 诊断与日志面板（D3，调研见 docs/competitive-research-2026-08.md） ——

function diagnosticsText(): string {
  const url = displayUrl();
  const lines = [
    `版本：${app.getVersion()}`,
    `连接：${url ?? '未连接'}`,
    `本地服务：${ownedDsh ? `运行中 ${ownedDsh.url}` : '未启动'}`,
    `连接阶段：${connectionPhase}`,
    `已保存连接：${savedConnections.length}`,
    '',
    '--- 运行日志 ---',
    logSnapshot(diagLogs) || '（暂无日志）',
  ];
  return lines.join('\n');
}

function showDiagnostics(): void {
  const content = diagnosticsText();
  const parent = shellWindow && !shellWindow.isDestroyed() && shellWindow.isVisible() ? shellWindow : undefined;
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: '诊断信息',
    message: 'DeepSeek Harness Shell 诊断信息',
    detail: content,
    buttons: ['导出日志', '关闭'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  void (async () => {
    const r = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    if (r.response !== 0) return;
    const saveOptions: Electron.SaveDialogOptions = {
      title: '导出诊断日志',
      defaultPath: 'dsh-diagnostics.log',
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
    };
    const saved = parent ? await dialog.showSaveDialog(parent, saveOptions) : await dialog.showSaveDialog(saveOptions);
    if (saved.canceled || !saved.filePath) return;
    try {
      fs.writeFileSync(saved.filePath, content, 'utf-8');
    } catch (e) {
      void dialog.showMessageBox({
        type: 'error',
        title: '导出失败',
        message: e instanceof Error ? e.message : String(e),
        buttons: ['确定'],
        noLink: true,
      });
    }
  })();
}
// —— 托盘 ——
// 服务器管理 / 置顶 / 断开连接 / 更新 / 关于已上移到标题栏菜单（可见性更好）；
// 托盘只保留窗口控制与退出作为窗口不可用时的兜底入口。

function createTrayMenu(): Electron.Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: shellWindow?.isVisible() ? '隐藏窗口' : '打开窗口',
      click: () => toggleWindow(),
    },
    { type: 'separator' },
    {
      label: '勿扰模式（静默通知）',
      type: 'checkbox',
      checked: dndEnabled,
      click: () => setDnd(!dndEnabled),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ];

  return Menu.buildFromTemplate(template);
}

function updateTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(createTrayMenu());
  const shown = displayUrl();
  tray.setToolTip(`DeepSeek Harness${shown ? ` · ${shown}` : ''}`);
}

function createTray(): void {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  updateTrayMenu();
  // 单击托盘图标：显示/隐藏窗口（macOS 上默认弹菜单，行为保持不变）。
  tray.on('click', () => toggleWindow());
}

// —— 切换服务器：回到 login 界面 ——

function switchServer(): void {
  detachContentView();
  showWindow();
  // 触发一次嗅探，让界面立即给出可选项
  void (async () => {
    const prev = loadSharedConfig().url;
    const list = await sniffLocalDsh(prev);
    shellWindow?.webContents.send('login:sniff-result', list);
  })();
}

// —— 深链协议 dsh-shell://（浏览器/系统拉起） ——
//   dsh-shell://show                       显示/聚焦窗口
//   dsh-shell://open?url=<encodeURIComponent>  连接指定服务器（远程地址仍弹确认）

function handleDshShellUrl(raw: string): void {
  const parsed = parseDshShellUrl(raw);
  if (parsed.action === 'show') {
    showWindow();
    return;
  }
  if (parsed.action === 'open') {
    void joinRemoteUrl(parsed.url);
    return;
  }
  console.warn(`[shell] ignored unknown dsh-shell url: ${raw}`);
}

// 注册协议：Windows 用运行时注册（打包版直接注册，dev 需显式 exe+参数）；
// macOS 在 electron-builder.yml 的 mac.protocols 里声明（+ 运行时 open-url 事件兜底）。
function registerProtocolClient(): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
        path.resolve(process.argv[1] ?? '.'),
      ]);
    }
  } catch (e) {
    console.warn('[shell] failed to register protocol client:', e);
  }
}

// —— 全局快捷键：任意地方唤起/收起窗口 ——
// 注册在 loadShortcutBindings / applyShortcutBinding 里随绑定走
//（默认 CommandOrControl+Shift+D，「更多 → 快捷键设置」可重绑；
//  DSH_HOTKEY 环境变量在用户未自定义时生效，'off'/空 = 解绑）。

// —— 主题：跟随 DSH appearance（settings.yaml 的 ui-theme.preference） ——

function applyShellTheme(): void {
  if (!shellWindow) return;
  const dark = resolveIsDark(readDshThemePreference());
  if (dark !== currentThemeDark) {
    currentThemeDark = dark;
    shellWindow.webContents.send('shell:theme-changed', dark);
  }
}

// —— 共享配置：响应 cordis 插件写入的 autoLaunch / updateRequest ——

function handleConfigChange(): void {
  const cfg = loadSharedConfig();
  if (typeof cfg.autoLaunch === 'boolean') {
    const cur = app.getLoginItemSettings().openAtLogin;
    if (cur !== cfg.autoLaunch) {
      applyAutoLaunch(cfg.autoLaunch);
    }
  }
  const req = cfg.updateRequest ?? 0;
  if (req > lastHandledUpdateRequest) {
    lastHandledUpdateRequest = req;
    checkForUpdatesNow();
  }
  // /desktop stop 远程请求：停止本应用启动的本地服务
  const stopReq = cfg.serviceStopRequest ?? 0;
  if (stopReq > lastHandledServiceStop) {
    lastHandledServiceStop = stopReq;
    stopLocalService();
  }
  // /desktop notify 远程请求：弹一次系统通知后清空请求（勿扰时静默丢弃；id 去重见 notify-queue）
  const notify = takeNotifyRequest(cfg, lastHandledNotifyId);
  if (notify) {
    lastHandledNotifyId = notify.id;
    if (!isNotificationMuted() && Notification.isSupported()) {
      try {
        const noti = new Notification({ title: notify.title, body: notify.body, silent: notify.silent });
        noti.on('click', () => showWindow());
        noti.show();
      } catch (e) {
        console.warn('[shell] notification failed:', e);
      }
    }
    saveSharedConfig(clearNotifyPatch());
  }
}

function startConfigPolling(): void {
  if (pollTimer) return;
  const initial = loadSharedConfig();
  if (typeof initial.autoLaunch === 'boolean') applyAutoLaunch(initial.autoLaunch);
  lastHandledUpdateRequest = initial.updateRequest ?? 0;
  lastHandledServiceStop = initial.serviceStopRequest ?? 0;
  // 启动时清掉插件在壳启动前写下的通知请求（瞬态事件不补弹，只记住已处理）。
  if (initial.notifyRequest) {
    lastHandledNotifyId = initial.notifyRequest.id;
    saveSharedConfig(clearNotifyPatch());
  }

  watchSharedConfig(() => handleConfigChange());
  pollTimer = setInterval(() => handleConfigChange(), 5000);

  watchDshTheme(() => applyShellTheme());
  onSystemThemeChange(() => applyShellTheme());
}

// —— 启动 ——

async function bootstrap(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // 开机自启（--hidden）时启动到托盘。
  startHidden = process.argv.includes('--hidden');

  // macOS：open-url 必须在 ready 前注册；冷启动时 URL 先缓存、ready 后处理。
  app.on('open-url', (e, url) => {
    e.preventDefault();
    if (app.isReady()) handleDshShellUrl(url);
    else pendingProtocolUrl = url;
  });

  // 二次启动（Windows 上协议拉起也会走这里）：聚焦窗口 + 处理协议 URL。
  app.on('second-instance', (_e, argv) => {
    const proto = argv.find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOL_SCHEME}://`));
    if (proto) handleDshShellUrl(proto);
    showWindow();
  });

  await app.whenReady();

  try {
    // Windows 任务栏/通知图标与 appId 绑定（否则可能回落到 Electron 默认图标）
    if (process.platform === 'win32') {
      app.setAppUserModelId('io.github.dsh.desktop-shell');
    }
    app.setAboutPanelOptions({
      applicationName: 'DeepSeek Harness Shell',
      applicationVersion: app.getVersion(),
      copyright: 'MIT License · dsh-desktop-shell contributors',
    });

    // 迁移早期版本写在 userData 的旧配置到 ~/.dsh 共享配置
    migrateLegacyConfig();

    registerProtocolClient();

    createShellWindow();
    createTray();

    // 记录自身可执行路径，供 cordis 插件 /desktop open 时 spawn 使用。
    // 仅接受绝对路径的 PORTABLE_EXECUTABLE_FILE（相对路径会随 cwd 漂移）；否则用自身 execPath。
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    const exePath = portable && path.isAbsolute(portable) ? portable : process.execPath;
    saveSharedConfig({ desktopExe: exePath });

    setupAutoUpdater();
    startConfigPolling();

    // 深链冷启动（Windows 协议拉起时 URL 在 argv 里；macOS 走 open-url 缓存）
    if (pendingProtocolUrl) {
      handleDshShellUrl(pendingProtocolUrl);
      pendingProtocolUrl = null;
    }
    const protoArg = process.argv.find((a) => a.startsWith(`${PROTOCOL_SCHEME}://`));
    if (protoArg) handleDshShellUrl(protoArg);

    // 已有配置（--url / DSH_URL / 共享配置）→ 自动连接；否则停留在 login。
    // 配置存在但无效（例如共享配置文件被手改坏）→ 回退 login，而不是报错退出。
    let configured: string | null = null;
    try {
      configured = await resolveConfiguredUrl();
    } catch (err) {
      console.warn('[shell] configured URL invalid, showing login:', err);
    }
    if (configured) {
      // 配置文件是本机任意进程可写的（cordis 插件通道）：非回环地址必须
      // 走与手动连接相同的确认弹窗，防止被篡改后在启动时静默加载钓鱼页。
      if (await confirmRemoteConnect(configured)) {
        await connectTo(configured);
      } else {
        console.warn('[shell] auto-connect to remote URL declined, showing login');
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void dialog.showErrorBox('DeepSeek Harness Shell', msg);
    app.quit();
  }
}

app.on('before-quit', (e) => {
  // 由本应用启动了本地 DSH 服务且尚未决定 → 弹窗询问是否同时关闭
  if (ownedDsh && quitDecision === null) {
    e.preventDefault();
    // 窗口 ✕ 触发的询问已在进行 → 等它决出结果（stop 会再次触发 quit）
    if (quitDialogOpen) return;
    void promptQuitDecision('quit').then((decision) => {
      if (decision === null || decision === 'cancel') {
        // 取消退出：恢复常驻状态，窗口继续可用
        quitDecision = null;
        isQuitting = false;
        return;
      }
      quitDecision = decision;
      app.quit();
    });
    return;
  }
  // 真正退出：清理（用户选择保持服务运行时不动子进程）
  if (pollTimer) clearInterval(pollTimer);
  saveBoundsNow();
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
  if (ownedDsh) {
    if (quitDecision !== 'keep') {
      ownedDsh.stop();
    }
    ownedDsh = null;
  }
});

app.on('window-all-closed', () => {
  // 常驻托盘，不主动退出。
});

void bootstrap();
