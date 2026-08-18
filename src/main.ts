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
  shell,
  WebContentsView,
  type MenuItemConstructorOptions,
} from 'electron';
import * as path from 'node:path';
import { resolveConfiguredUrl } from './config';
import { validateUrl, isLoopbackHost } from './url';
import { launchLocalDsh, normalizeRequestedPort, type DshService } from './dsh-launcher';
import { probeUrl } from './probe';
import { attachSecurity } from './security';
import { loadSharedConfig, saveSharedConfig, watchSharedConfig, migrateLegacyConfig } from './shared-config';
import { sniffLocalDsh } from './sniffer';
import { readDshThemePreference, resolveIsDark, onSystemThemeChange, watchDshTheme } from './theme';
import { setupAutoUpdater, checkForUpdatesNow } from './updater';
import { loadShellState, saveShellState, mergeRecentServers, removeRecentServer, clearRecentServers, sanitizeBounds } from './shell-state';
import { parseDshShellUrl, PROTOCOL_SCHEME } from './protocol';
import {
  buildDisconnectMenuItems,
  buildServerMenuItems,
  buildMoreMenuItems,
  isTitlebarMenuName,
  type TitlebarMenuName,
} from './titlebar-menus';
import { pushShellUiState } from './shell-ui-state';
import { stopExternalLocalServer } from './server-stop';
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
let pollTimer: NodeJS.Timeout | null = null;
let currentThemeDark: boolean | null = null;
let connectedUrl: string | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
// 退出时对「本应用启动的本地服务」的处理决定：null=未询问，'stop'=同时关闭，'keep'=保持运行
let quitDecision: 'stop' | 'keep' | null = null;
let quitDialogOpen = false;
// 窗口状态（bounds / 置顶 / 最近连接）持久化在 userData/shell-state.json
let startHidden = false; // 开机自启（--hidden）时启动到托盘，不弹窗口
let alwaysOnTop = false;
let boundsSaveTimer: NodeJS.Timeout | null = null;
let recentServers: string[] = [];
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

  if (state.alwaysOnTop) {
    alwaysOnTop = true;
    win.setAlwaysOnTop(true);
  }

  // 竞态修复：connectTo 对本机服务几毫秒即完成，attachContentView 推送的
  // 状态可能在渲染器加载 shell.js 之前发出而被丢弃 → 标题栏连接状态
  // 永远不显示。页面每次加载完成后重发全部 UI 状态使其自愈（shell-ui-state.ts）。
  win.webContents.on('did-finish-load', () => {
    const w = shellWindow;
    if (!w || w.isDestroyed()) return;
    pushShellUiState(w.webContents, {
      connectedUrl,
      owned: isOwnedConnection(),
      maximized: w.isMaximized(),
      alwaysOnTop,
      findBarVisible: findBarOpen,
      settingsVisible: settingsOpen,
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
    // 设置面板打开期间不挂载（否则会盖住 shell 页面的面板），关闭时补挂
    if (!settingsOpen) shellWindow.contentView.addChildView(view);
    view.webContents.on('did-fail-load', (_e, code, desc, validatedUrl) => {
      if (code === -3) return;
      console.error(`[shell] failed to load ${validatedUrl}: ${desc} (${code})`);
      // DSH 重启/断连期间会触发：探测到服务恢复后自动重载页面。
      if (validatedUrl.startsWith('http')) scheduleReloadOnReconnect(validatedUrl);
    });
  }
  const origin = new URL(url).origin;
  attachSecurity(contentView.webContents, origin);
  void contentView.webContents.loadURL(url);
  updateContentViewBounds();
  connectedUrl = url;
  shellWindow.webContents.send('login:visible', false);
  sendConnectionState();
}

// 向标题栏同步连接状态（连接地址 + 是否为本应用启动的本地服务）。
function sendConnectionState(): void {
  shellWindow?.webContents.send('shell:connection-changed', {
    connected: connectedUrl !== null,
    url: connectedUrl,
    owned: isOwnedConnection(),
  });
}

// —— 内容视图操作（快捷键与「服务器 / 更多」菜单共用） ——

function runContentAction(action: ShortcutAction): void {
  switch (action) {
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
// 关闭时原样挂回（连接状态不变，页面不重载）。
function openShortcutsSettings(): void {
  const w = shellWindow;
  if (!w || w.isDestroyed() || settingsOpen) return;
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

  // 打开标题栏下拉菜单（disconnect / server / more，原生 Menu.popup）
  ipcMain.on('shell:open-titlebar-menu', (e, name: unknown, anchor: unknown) => {
    if (!guard(e)) return;
    if (!isTitlebarMenuName(name)) return;
    if (!anchor || typeof anchor !== 'object') return;
    const r = anchor as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    if (
      typeof r.x !== 'number' ||
      typeof r.y !== 'number' ||
      typeof r.width !== 'number' ||
      typeof r.height !== 'number'
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
              void shell.openExternal(connectedUrl!);
            }
          : null,
      },
    );
  } else {
    items = buildMoreMenuItems(
      { zoomFactor, accelerators: shortcutBindings },
      {
        zoomIn: () => applyZoom(stepZoom(zoomFactor, 'in')),
        zoomOut: () => applyZoom(stepZoom(zoomFactor, 'out')),
        zoomReset: () => applyZoom(ZOOM_DEFAULT),
        shortcuts: () => openShortcutsSettings(),
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
  if (!isLoopbackHost(new URL(url).hostname)) {
    const parent = shellWindow && shellWindow.isVisible() ? shellWindow : undefined;
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
    if (r.response !== 0) {
      showLoginError('已取消');
      return;
    }
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
  // 记入最近连接（login 界面展示，快速重连）。
  recentServers = mergeRecentServers(recentServers, url);
  saveShellState(shellStateFile(), { recentServers });
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
// 先断开回 login，再按端口定位并结束服务器进程，结果弹窗反馈。
async function disconnectAndStopServer(): Promise<void> {
  const url = connectedUrl;
  if (!url) return;
  detachContentView();
  saveSharedConfig({ url: undefined });
  showWindow();
  const result = await stopExternalLocalServer(url);
  const parent = shellWindow && !shellWindow.isDestroyed() && shellWindow.isVisible() ? shellWindow : undefined;
  const options: Electron.MessageBoxOptions = {
    type: result.ok ? 'info' : 'warning',
    title: '关闭服务器',
    message: result.ok ? '本机 DSH 服务器已停止' : '无法停止本机服务器',
    detail: result.detail,
    buttons: ['确定'],
    noLink: true,
  };
  void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
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
  tray.setToolTip(`DeepSeek Harness${connectedUrl ? ` · ${connectedUrl}` : ''}`);
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
}

function startConfigPolling(): void {
  if (pollTimer) return;
  const initial = loadSharedConfig();
  if (typeof initial.autoLaunch === 'boolean') applyAutoLaunch(initial.autoLaunch);
  lastHandledUpdateRequest = initial.updateRequest ?? 0;
  lastHandledServiceStop = initial.serviceStopRequest ?? 0;

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
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
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
      await connectTo(configured);
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
