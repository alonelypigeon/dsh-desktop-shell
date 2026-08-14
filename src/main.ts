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
import { validateUrl } from './url';
import { launchLocalDsh, normalizeRequestedPort, type DshService } from './dsh-launcher';
import { probeUrl } from './probe';
import { attachSecurity } from './security';
import { loadSharedConfig, saveSharedConfig, watchSharedConfig, migrateLegacyConfig } from './shared-config';
import { sniffLocalDsh } from './sniffer';
import { readDshThemePreference, resolveIsDark, onSystemThemeChange, watchDshTheme } from './theme';
import { setupAutoUpdater, checkForUpdatesNow } from './updater';
import { loadShellState, saveShellState, mergeRecentServers, removeRecentServer, clearRecentServers, sanitizeBounds } from './shell-state';
import { createConnMenu, type ConnMenu } from './conn-menu';
import { parseDshShellUrl, PROTOCOL_SCHEME } from './protocol';

const TITLEBAR_HEIGHT = 42;
// 全局快捷键默认值（可用 DSH_HOTKEY 环境变量覆盖；留空禁用）。
const DEFAULT_HOTKEY = 'CommandOrControl+Shift+D';

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
// 断开连接下拉菜单（独立小窗，见 conn-menu.ts）
let connMenu: ConnMenu | null = null;

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

  win.on('maximize', () => win.webContents.send('shell:maximize-changed', true));
  win.on('unmaximize', () => win.webContents.send('shell:maximize-changed', false));
}

// —— 窗口 / 内容视图 / login 状态 ——

function updateContentViewBounds(): void {
  if (!shellWindow || !contentView) return;
  const [w, h] = shellWindow.getContentSize();
  contentView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width: w, height: Math.max(0, h - TITLEBAR_HEIGHT) });
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
  if (!shellWindow || shellWindow.isMinimized() || shellWindow.isMaximized()) return;
  saveShellState(shellStateFile(), { bounds: shellWindow.getBounds() });
}

function applyAlwaysOnTop(on: boolean): void {
  alwaysOnTop = on;
  shellWindow?.setAlwaysOnTop(on);
  saveShellState(shellStateFile(), { alwaysOnTop: on });
  updateTrayMenu();
}

function createShellWindow(): void {
  const initialDark = resolveIsDark(readDshThemePreference());
  currentThemeDark = initialDark;

  // 恢复上次的窗口位置/尺寸（校验可见性，屏幕布局变化时回退默认值）。
  const state = loadShellState(shellStateFile());
  recentServers = state.recentServers ?? [];
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

  win.once('ready-to-show', () => {
    // 开机自启（--hidden）时不打扰：窗口留在托盘，用户从托盘/快捷键唤出。
    if (!startHidden) win.show();
  });

  win.on('close', (e) => {
    if (isQuitting) return; // 真正退出流程：放行
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
    if (quitDialogOpen) return;
    quitDialogOpen = true;
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: '关闭 DeepSeek Harness Shell',
      message: '是否同时关闭由本应用启动的本地 DSH 服务？',
      detail: `本地服务地址：${ownedDsh.url}`,
      buttons: ['同时关闭服务并退出', '最小化到托盘', '取消'],
      defaultId: 1,
      cancelId: 2,
      noLink: true,
    };
    void dialog.showMessageBox(win, options).then((r) => {
      quitDialogOpen = false;
      if (r.response === 2) return; // 取消：窗口保持打开
      if (r.response === 0) {
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
  win.on('show', updateTrayMenu);
  win.on('hide', updateTrayMenu);
  // 窗口真正销毁时连带销毁断开连接菜单（move/resize/hide 时菜单在
  // conn-menu.ts 内自行收起）
  win.on('closed', () => {
    connMenu?.destroy();
    connMenu = null;
  });

  setupWindowControlIpc(win);
  setupLoginIpc(win);

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
    shellWindow.contentView.addChildView(view);
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
    owned: !!ownedDsh && ownedDsh.url === connectedUrl,
  });
}

// 移除 DSH 内容视图，重新显示 login 界面（切换服务器）。
function detachContentView(): void {
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

  // 打开/关闭断开连接下拉菜单（conn-menu.html 独立小窗）
  ipcMain.on('shell:conn-menu-open', (e, anchor: unknown) => {
    if (!guard(e)) return;
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
    openConnMenu({ x: r.x, y: r.y, width: r.width, height: r.height });
  });
  ipcMain.on('shell:conn-menu-close', (e) => {
    if (!guard(e)) return;
    connMenu?.close();
  });
}

// 打开断开连接下拉菜单：懒创建子窗口，锚定在标题栏按钮正下方。
function openConnMenu(anchor: Electron.Rectangle): void {
  if (!shellWindow) return;
  if (!connMenu) {
    connMenu = createConnMenu(shellWindow, {
      disconnect: () => disconnectConnection(),
      disconnectAndStop: () => disconnectAndStop(),
    });
  }
  connMenu.open(anchor, {
    owned: !!ownedDsh && ownedDsh.url === connectedUrl,
    dark: currentThemeDark ?? resolveIsDark(readDshThemePreference()),
  });
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

  // 非回环地址 → 弹确认
  const host = new URL(url).hostname;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLoopback) {
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
  const knownOwn = ownedDsh && ownedDsh.url === url;
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
  connMenu?.close();
  detachContentView();
  saveSharedConfig({ url: undefined });
  showWindow();
}

// 断开连接并关闭：若当前连接的是本应用启动的本地服务，一并停止它。
function disconnectAndStop(): void {
  connMenu?.close();
  const url = connectedUrl;
  detachContentView();
  if (ownedDsh && ownedDsh.url === url) {
    ownedDsh.stop();
    ownedDsh = null;
  }
  saveSharedConfig({ url: undefined });
  showWindow();
}

// —— 托盘 ——

function createTrayMenu(): Electron.Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: shellWindow?.isVisible() ? '隐藏窗口' : '打开窗口',
      click: () => toggleWindow(),
    },
    {
      label: '管理服务器',
      submenu: [
        {
          label: '启动本地 DSH 服务',
          click: () => {
            showWindow();
            void startLocalService(shellWindow);
          },
        },
        { label: '停止本地 DSH 服务', click: () => stopLocalService() },
        { type: 'separator' },
        { label: '切换服务器…', click: () => switchServer() },
      ],
    },
    { type: 'separator' },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: alwaysOnTop,
      click: (item) => applyAlwaysOnTop(item.checked),
    },
  ];

  // 已连接时：在浏览器里打开当前服务器 / 断开连接
  if (connectedUrl) {
    template.push({
      label: '在浏览器中打开当前服务器',
      click: () => void shell.openExternal(connectedUrl!),
    });
    template.push({ label: '断开连接', click: () => disconnectConnection() });
    if (ownedDsh && ownedDsh.url === connectedUrl) {
      template.push({ label: '断开连接并关闭本地服务', click: () => disconnectAndStop() });
    }
  }

  template.push(
    { label: '检查更新…', click: () => checkForUpdatesNow() },
    {
      label: '关于 DeepSeek Harness Shell',
      click: () => {
        const parent = shellWindow && shellWindow.isVisible() ? shellWindow : undefined;
        const options: Electron.MessageBoxOptions = {
          type: 'info',
          title: '关于 DeepSeek Harness Shell',
          message: `DeepSeek Harness Shell v${app.getVersion()}`,
          detail: '社区实验项目，非 DeepSeek 官方产品。\nMIT License · dsh-desktop-shell contributors',
          buttons: ['确定'],
          noLink: true,
        };
        void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  );

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

function setupGlobalShortcut(): void {
  const hotkey = process.env.DSH_HOTKEY?.trim() || DEFAULT_HOTKEY;
  if (hotkey === '' || hotkey === 'off') {
    console.log('[shell] global shortcut disabled');
    return;
  }
  try {
    const ok = globalShortcut.register(hotkey, () => toggleWindow());
    console.log(`[shell] global shortcut ${ok ? 'registered' : 'FAILED'}: ${hotkey}`);
  } catch (e) {
    console.warn('[shell] global shortcut unavailable:', e);
  }
}

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
    setupGlobalShortcut();

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
    if (quitDialogOpen) return;
    quitDialogOpen = true;
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: '退出 DeepSeek Harness Shell',
      message: '是否同时关闭由本应用启动的本地 DSH 服务？',
      detail: `本地服务地址：${ownedDsh.url}\n选择「保持服务运行」后，服务继续在后台运行，下次启动可直接嗅探连接。`,
      buttons: ['同时关闭服务', '保持服务运行', '取消退出'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    };
    const parent = shellWindow && shellWindow.isVisible() ? shellWindow : null;
    void (parent
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options)
    ).then((r) => {
      quitDialogOpen = false;
      if (r.response === 2) {
        // 取消退出：恢复常驻状态，窗口继续可用
        quitDecision = null;
        isQuitting = false;
        return;
      }
      quitDecision = r.response === 0 ? 'stop' : 'keep';
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
