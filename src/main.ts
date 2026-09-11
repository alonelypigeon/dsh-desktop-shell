// 应用层：会话注册表、托盘、全局热键、连接配置库、勿扰、主题、共享配置、
// 更新、本地服务注册表、应用级对话框、深链协议、启动引导。
//
// 重构（v1.0）：每个窗口的「自己的东西」已移进 session.ts 的 Session；
// 这里只保留跨窗口共享的应用级状态。原先的全局单例假设（shellWindow /
// contentView / ownedDsh）现在分别对应：会话注册表、每会话一视图、
// 按地址归属的本地服务注册表。
import { app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut, nativeImage, screen } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launchLocalDsh, type DshService } from './dsh-launcher';
import { resolveConfiguredUrl } from './config';
import { loadSharedConfig, saveSharedConfig, watchSharedConfig, migrateLegacyConfig } from './shared-config';
import { takeNotifyRequest, clearNotifyPatch } from './notify-queue';
import { readDshThemePreference, resolveIsDark, onSystemThemeChange, watchDshTheme } from './theme';
import { setupAutoUpdater, checkForUpdatesNow } from './updater';
import {
  connectionsToRecentUrls,
  exportConnections,
  loadShellState,
  makeConnectionId,
  mergeRecentServers,
  mergeSavedConnection,
  parseConnectionsImport,
  pinConnection as pinConnectionInList,
  removeRecentServer,
  removeSavedConnection,
  renameSavedConnection,
  sanitizeBounds,
  updateSavedConnection,
  writeShellState,
  isDndActive,
  normalizeDndSchedule,
  type CloseBehavior,
  type ConnectionKind,
  type DndSchedule,
  type SavedConnection,
  type ShellState,
} from './shell-state';
import { parseDshShellUrl, PROTOCOL_SCHEME } from './protocol';
import { normalizeProxyConfig } from './proxy';
import { createLogBuffer, pushLogLine, logSnapshot, type LogBuffer } from './log-buffer';
import { Session, type SessionHost, type SessionInit } from './session';
import {
  MAX_SESSION_WINDOWS,
  aggregateUnread,
  canOpenSessionWindow,
  cycleSession,
  formatSessionMenuLabel,
  pickMostRecent,
  planRestoreSessions,
  sessionKeyForUrl,
  type SessionSummary,
} from './session-policy';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_META,
  isShortcutAction,
  normalizeAccelerator,
  normalizeShortcutBindings,
  serializeShortcutBindings,
  type ShortcutAction,
  type ShortcutBindings,
} from './shortcuts';

// —— 应用级状态 ——

const sessions = new Map<string, Session>();
let tray: Tray | null = null;
let trayMenuSignature = '';
let isQuitting = false;
/** 本应用启动的本地 DSH 服务，按连接地址归属（一个地址最多一个进程）。 */
const ownedServices = new Map<string, DshService>();
let quitDecision: 'stop' | 'keep' | null = null;
let quitDialogOpen = false;
let startHidden = false;
/** 内存态：shell-state.json 的唯一真相（避免每次保存都读-改-写）。 */
let shellStateCache: ShellState | null = null;
let savedConnections: SavedConnection[] = [];
let recentServers: string[] = [];
let shortcutBindings: ShortcutBindings = { ...DEFAULT_SHORTCUTS };
let globalHotkeyEnvActive = false;
/** 已注册的全局热键（换绑时按 action 精确注销）。 */
const registeredGlobalAccs = new Map<ShortcutAction, string>();
let dndEnabled = false;
let dndSchedule: DndSchedule | undefined;
let closeBehavior: CloseBehavior = 'close-session';
let currentThemeDark: boolean | null = null;
let configBackupTimer: NodeJS.Timeout | null = null;
let lastHandledUpdateRequest = 0;
let lastHandledServiceStop = 0;
let lastHandledNotifyId: string | null = null;
let pendingProtocolUrl: string | null = null;
let lastAggregateUnread = 0;
let agentNotifyTimer: NodeJS.Timeout | null = null;
let pendingNotifyLabel: string | null = null;
const diagLogs: LogBuffer = createLogBuffer(500);

// —— 状态文件（内存态 + 统一落盘） ——

function stateFile(): string {
  return path.join(app.getPath('userData'), 'shell-state.json');
}

function shellState(): ShellState {
  if (shellStateCache === null) shellStateCache = loadShellState(stateFile());
  return shellStateCache;
}

function persistState(patch: Partial<ShellState>): void {
  shellStateCache = { ...shellState(), ...patch };
  try {
    writeShellState(stateFile(), shellStateCache);
  } catch (e) {
    console.warn('[shell] failed to save shell state:', e);
  }
}

function persistConnections(): void {
  persistState({ connections: savedConnections, recentServers });
}

/** 上一次退出时打开的会话窗口地址（启动恢复依据）。 */
function persistSessionWindows(): void {
  const urls = [...sessions.values()]
    .filter((s) => s.connectedUrl !== null)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((s) => s.connectedUrl!)
    .slice(0, MAX_SESSION_WINDOWS);
  persistState({ sessionWindows: urls });
}

// —— 会话注册表 ——

function sessionList(): Session[] {
  return [...sessions.values()].filter((s) => !s.destroyedWindow);
}

function connectedSessions(): Session[] {
  return sessionList().filter((s) => s.connectedUrl !== null);
}

/** 最近活跃的会话（全局热键与托盘默认目标）。 */
function activeSession(): Session | null {
  return pickMostRecent(connectedSessions()) ?? pickMostRecent(sessionList());
}

function focusedSession(): Session | null {
  return sessionList().find((s) => s.window.isFocused()) ?? null;
}

function createSession(init: SessionInit = {}): Session {
  const session = new Session(host, init);
  sessions.set(session.id, session);
  return session;
}

function sessionSummaries(): SessionSummary[] {
  return sessionList().map((s) => s.summary());
}

/** 为新会话准备恢复参数（每连接一份窗口状态 + 代理配置）。 */
function initForUrl(url: string, extra: SessionInit = {}): SessionInit {
  const saved = savedConnections.find((c) => c.url === url || sessionKeyForUrl(c.url) === sessionKeyForUrl(url));
  const bounds = saved?.bounds
    ? sanitizeBounds(saved.bounds, screen.getAllDisplays().map((d) => d.workArea))
    : null;
  return {
    ...extra,
    bounds: bounds ?? undefined,
    maximized: saved?.maximized === true,
    zoomFactor: saved?.zoomFactor,
    alwaysOnTop: saved?.alwaysOnTop,
    proxy: saved?.proxy,
  };
}

/** 把一个 login 窗口（或新窗口）连到指定地址；已开的地址只聚焦。 */
async function openSessionForUrl(url: string, init: SessionInit = {}): Promise<Session | null> {
  const key = sessionKeyForUrl(url);
  const existing = sessions.get(key);
  if (existing && !existing.destroyedWindow) {
    existing.show();
    return existing;
  }
  let target = sessionList().find((s) => s.isLoginWindow && s.window.isVisible()) ?? sessionList().find((s) => s.isLoginWindow);
  if (!target) {
    if (!canOpenSessionWindow(connectedSessions().length)) {
      notifyMutedAware('会话窗口已达上限', `最多同时打开 ${MAX_SESSION_WINDOWS} 个会话窗口，请先关闭一个。`);
      return null;
    }
    target = createSession(initForUrl(url, init));
  }
  const oldKey = target.id;
  const ok = await target.connectTo(url);
  if (!ok) return null;
  const newKey = target.rekey(url);
  if (oldKey !== newKey) sessions.delete(oldKey);
  sessions.set(newKey, target);
  persistSessionWindows();
  updateTray();
  return target;
}

/** 打开一个空的 login 窗口（多窗口「新建连接…」/ 无窗口时兜底）。 */
function openLoginSession(init: SessionInit = {}): Session {
  const session = createSession({ ...init, loginWindow: true });
  session.show();
  updateTray();
  return session;
}

/** 关闭一个会话窗口（销毁；注册表在 onSessionGone 里清理）。 */
function closeSession(session: Session): void {
  session.flushState();
  session.destroy();
}

function requestCloseSession(session: Session): void {
  if (closeBehavior === 'hide-to-tray') {
    session.hide();
    return;
  }
  closeSession(session);
}

// —— 本地服务注册表（按地址归属） ——

function ownedServiceFor(url: string | null): DshService | null {
  if (url === null) return null;
  return ownedServices.get(sessionKeyForUrl(url)) ?? null;
}

async function startLocalService(session: Session, port: number): Promise<void> {
  // 已有由本应用启动的服务 → 直接复用（多窗口下最常见的意图是「再连一个」）。
  const running = [...ownedServices.values()][0];
  if (running) {
    session.send('login:progress', `本地实例已在运行：${running.url}`);
    const ok = await openSessionForUrl(running.url);
    if (!ok) session.showLoginError('本地实例无法访问');
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
            : (detail ?? phase);
      session.send('login:progress', msg);
    },
  });
  if (!service) {
    session.showLoginError('本地服务器启动失败（找不到 dsh 或启动超时）');
    return;
  }
  ownedServices.set(sessionKeyForUrl(service.url), service);
  const target = await openSessionForUrl(service.url);
  if (!target) session.showLoginError(`已启动但无法访问 ${service.url}`);
  updateTray();
}

/** 停止由本应用启动的本地服务（url=null 表示全部）。 */
function stopLocalService(url: string | null): void {
  const keys = url === null ? [...ownedServices.keys()] : [sessionKeyForUrl(url)];
  let stopped = 0;
  for (const key of keys) {
    const service = ownedServices.get(key);
    if (!service) continue;
    service.stop();
    ownedServices.delete(key);
    stopped++;
    // 连在它上面的会话回到 login 界面（其余窗口不受影响）
    for (const s of sessionList()) {
      if (s.connectedUrl !== null && sessionKeyForUrl(s.connectedUrl) === key) s.detachContentView();
    }
  }
  updateTray();
  if (stopped === 0) {
    void showMessage({
      type: 'info',
      title: '本地服务',
      message: '当前没有由本应用启动的本地 DSH 服务。',
    });
  }
}

// —— 未读聚合（跨窗口求和） + 徽章 + 通知 ——

function isNotificationMuted(): boolean {
  return isDndActive(dndEnabled, dndSchedule, new Date());
}

function notifyMutedAware(title: string, body: string, onClick?: () => void): void {
  if (isNotificationMuted() || !Notification.isSupported()) return;
  try {
    const noti = new Notification({ title, body, silent: true });
    if (onClick) noti.on('click', onClick);
    noti.show();
  } catch (e) {
    console.warn('[shell] notification failed:', e);
  }
}

function createBadgeImage(n: number): Electron.NativeImage {
  const file = n > 99 ? 'badge-99plus.png' : `badge-${n}.png`;
  return nativeImage.createFromPath(path.join(__dirname, 'badges', file));
}

/** 三平台角标：Windows 每个窗口的任务栏覆盖图标 / 其余平台应用级角标。 */
function applyAggregateBadge(total: number | null): void {
  if (process.platform === 'win32') {
    for (const s of sessionList()) {
      try {
        s.window.setOverlayIcon(total !== null ? createBadgeImage(total) : null, total !== null ? `${total} 条未读消息` : '');
      } catch (e) {
        console.warn('[shell] setOverlayIcon failed:', e);
      }
    }
    return;
  }
  try {
    app.setBadgeCount(total ?? 0);
  } catch {
    /* 无 Dock/Unity 环境静默失败 */
  }
  if (process.platform === 'darwin' && tray) {
    try {
      tray.setTitle(total !== null ? String(total) : '');
    } catch {
      /* ignore */
    }
  }
}

function anySessionAway(): boolean {
  const list = connectedSessions();
  return list.length > 0 && list.every((s) => s.isWindowAway());
}

function onUnreadChanged(session: Session): void {
  const total = aggregateUnread(sessionList().map((s) => s.unreadCount));
  applyAggregateBadge(total);
  const totalNum = total ?? 0;
  const increased = totalNum > lastAggregateUnread;
  lastAggregateUnread = totalNum;
  if (increased && anySessionAway()) scheduleAgentNotification(totalNum, session.summary().name);
  updateTray();
}

// B4：短暂窗口内合并多次未读增长，只弹一次通知；多窗口时文案带来源连接名。
function scheduleAgentNotification(count: number, label: string): void {
  pendingNotifyLabel = label;
  if (agentNotifyTimer) clearTimeout(agentNotifyTimer);
  const timer = setTimeout(() => {
    agentNotifyTimer = null;
    const n = lastAggregateUnread;
    const from = pendingNotifyLabel;
    pendingNotifyLabel = null;
    if (n > 0 && anySessionAway()) {
      notifyMutedAware(
        'DSH 需要你的注意',
        `检测到 ${n} 条未读消息${from ? `（来自 ${from}）` : ''}，点击聚焦窗口查看。`,
        () => activeSession()?.show(),
      );
    }
  }, 1200);
  agentNotifyTimer = timer;
  timer.unref?.();
}

// —— 托盘 ——

function createTrayIcon(): Electron.NativeImage {
  const isMac = process.platform === 'darwin';
  const file = isMac ? 'trayTemplate.png' : 'tray.png';
  const img = nativeImage.createFromPath(path.join(__dirname, file));
  if (isMac) img.setTemplateImage(true);
  return img;
}

function buildTrayTemplate(): Electron.MenuItemConstructorOptions[] {
  const current = focusedSession() ?? activeSession();
  const list = sessionSummaries();
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: current && current.window.isVisible() && !current.window.isMinimized() ? '隐藏窗口' : '打开窗口',
      click: () => {
        const s = focusedSession() ?? activeSession();
        if (s) s.toggle();
        else openLoginSession();
      },
    },
    { type: 'separator' },
  ];
  if (list.length > 0) {
    for (const summary of list) {
      template.push({
        label: formatSessionMenuLabel(summary),
        sublabel: summary.connected ? summary.url : '未连接',
        type: 'normal',
        click: () => sessions.get(summary.id)?.show(),
      });
    }
    template.push({ type: 'separator' });
  }
  template.push(
    { label: '新建连接窗口…', click: () => openLoginSession() },
    {
      label: '勿扰模式（静默通知）',
      type: 'checkbox',
      checked: dndEnabled,
      click: () => setDnd(!dndEnabled),
    },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() },
  );
  return template;
}

function updateTray(): void {
  if (!tray) return;
  const list = sessionSummaries();
  const signature = JSON.stringify([list, dndEnabled, ownedServices.size > 0]);
  if (signature !== trayMenuSignature) {
    trayMenuSignature = signature;
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate()));
  }
  const shown = list
    .map((s) => s.url)
    .filter((u) => u !== '')
    .join(' · ');
  tray.setToolTip(`DeepSeek Harness${shown ? ` · ${shown}` : ''}`);
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  updateTray();
  tray.on('click', () => {
    const s = focusedSession() ?? activeSession();
    if (s) s.toggle();
    else openLoginSession();
  });
}

// —— 开机自启 / 共享配置 ——

function applyAutoLaunch(enabled: boolean): void {
  try {
    const settings: Electron.Settings = { openAtLogin: enabled };
    if (process.platform === 'darwin') settings.openAsHidden = true;
    if (process.platform === 'win32') settings.args = ['--hidden'];
    app.setLoginItemSettings(settings);
  } catch (e) {
    console.error('[shell] failed to set auto-launch:', e);
  }
}

function handleConfigChange(): void {
  const cfg = loadSharedConfig();
  if (typeof cfg.autoLaunch === 'boolean') {
    const cur = app.getLoginItemSettings().openAtLogin;
    if (cur !== cfg.autoLaunch) applyAutoLaunch(cfg.autoLaunch);
  }
  const req = cfg.updateRequest ?? 0;
  if (req > lastHandledUpdateRequest) {
    lastHandledUpdateRequest = req;
    checkForUpdatesNow();
  }
  const stopReq = cfg.serviceStopRequest ?? 0;
  if (stopReq > lastHandledServiceStop) {
    lastHandledServiceStop = stopReq;
    stopLocalService(null);
  }
  const notify = takeNotifyRequest(cfg, lastHandledNotifyId);
  if (notify) {
    lastHandledNotifyId = notify.id;
    notifyMutedAware(notify.title, notify.body, () => activeSession()?.show());
    saveSharedConfig(clearNotifyPatch());
  }
}

function startConfigWatching(): void {
  const initial = loadSharedConfig();
  if (typeof initial.autoLaunch === 'boolean') applyAutoLaunch(initial.autoLaunch);
  lastHandledUpdateRequest = initial.updateRequest ?? 0;
  lastHandledServiceStop = initial.serviceStopRequest ?? 0;
  if (initial.notifyRequest) {
    lastHandledNotifyId = initial.notifyRequest.id;
    saveSharedConfig(clearNotifyPatch());
  }
  // fs.watch 已是即时通道；低频兜底轮询只为兜住 watch 漏事件（原 5s 轮询是
  // 主线程上每秒级同步读盘，属于纯浪费）。
  watchSharedConfig(() => handleConfigChange());
  configBackupTimer = setInterval(() => handleConfigChange(), 60_000);
  configBackupTimer.unref?.();
  watchDshTheme(() => applyShellTheme());
  onSystemThemeChange(() => applyShellTheme());
}

function applyShellTheme(): void {
  const dark = resolveIsDark(readDshThemePreference());
  if (dark === currentThemeDark) return;
  currentThemeDark = dark;
  for (const s of sessionList()) s.applyTheme(dark);
}

// —— 快捷键（全局热键由应用层注册；内容视图快捷键在 Session 内） ——

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
  applyGlobalHotkeys();
}

/** 全局热键动作的实现（C4：不止唤起窗口）。 */
function runGlobalAction(action: ShortcutAction): void {
  switch (action) {
    case 'global-toggle-window': {
      const s = focusedSession() ?? activeSession();
      if (s) s.toggle();
      else openLoginSession();
      break;
    }
    case 'global-next-session': {
      const list = connectedSessions().sort((a, b) => a.lastActiveAt - b.lastActiveAt);
      const next = cycleSession(list, activeSession()?.id ?? null, 1);
      next?.show();
      break;
    }
    case 'global-close-window': {
      const s = focusedSession();
      if (s) requestCloseSession(s);
      break;
    }
    case 'global-restart-local': {
      const running = [...ownedServices.values()][0];
      if (!running) {
        notifyMutedAware('本地服务', '当前没有由本应用启动的本地 DSH 服务。');
        return;
      }
      const url = running.url;
      stopLocalService(url);
      const target = sessionList()[0] ?? openLoginSession();
      void startLocalService(target, 0);
      break;
    }
    case 'global-stop-all-local': {
      if (ownedServices.size === 0) {
        notifyMutedAware('本地服务', '当前没有由本应用启动的本地 DSH 服务。');
        return;
      }
      void confirmMessage({
        type: 'question',
        title: '停止所有本地服务',
        message: `将停止 ${ownedServices.size} 个由本应用启动的本地 DSH 服务`,
        detail: [...ownedServices.values()].map((s) => s.url).join('\n'),
        buttons: ['全部停止', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      }).then((r) => {
        if (r.response === 0) stopLocalService(null);
      });
      break;
    }
    default:
      break;
  }
}

/** 重新注册全部全局热键（换绑/重置后调用）。 */
function applyGlobalHotkeys(): void {
  for (const [action, acc] of registeredGlobalAccs) {
    try {
      globalShortcut.unregister(acc);
    } catch {
      /* ignore */
    }
    registeredGlobalAccs.delete(action);
  }
  for (const [action, acc] of Object.entries(shortcutBindings) as [ShortcutAction, string | null][]) {
    if (!acc) continue;
    if (SHORTCUT_META[action]?.scope !== 'global') continue;
    try {
      const ok = globalShortcut.register(acc, () => runGlobalAction(action));
      if (ok) registeredGlobalAccs.set(action, acc);
      else console.warn(`[shell] global shortcut register FAILED (taken by another app?): ${action} = ${acc}`);
    } catch (e) {
      console.warn('[shell] global shortcut unavailable:', e);
    }
  }
}

function applyShortcutBinding(action: ShortcutAction, acc: string | null): void {
  shortcutBindings[action] = acc;
  persistState({ shortcuts: serializeShortcutBindings(shortcutBindings) });
  if (SHORTCUT_META[action]?.scope === 'global') {
    globalHotkeyEnvActive = false; // 用户显式选择后，环境变量不再参与
    applyGlobalHotkeys();
  }
}

// —— 应用级对话框 ——

function appModalParent(): BrowserWindow | undefined {
  return focusedSession()?.parentWindow() ?? activeSession()?.parentWindow();
}

/** 弹一条消息框：有前台窗口就作为 modal parent，没有就直接弹。 */
function showMessage(options: Electron.MessageBoxOptions): void {
  const parent = appModalParent();
  void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
}

/** 需要读取用户选择的消息框。 */
function confirmMessage(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  const parent = appModalParent();
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

async function promptQuitDecision(kind: 'quit'): Promise<'stop' | 'keep' | 'cancel' | null> {
  if (quitDialogOpen || ownedServices.size === 0) return null;
  quitDialogOpen = true;
  const urls = [...ownedServices.values()].map((s) => s.url);
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: '退出 DeepSeek Harness Shell',
    message: urls.length === 1 ? '是否同时关闭由本应用启动的本地 DSH 服务？' : `是否同时关闭由本应用启动的 ${urls.length} 个本地 DSH 服务？`,
    detail: `本地服务地址：\n${urls.join('\n')}\n选择「保持服务运行」后，服务继续在后台运行，下次启动可直接嗅探连接。`,
    buttons: ['同时关闭服务', '保持服务运行', '取消退出'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const parent = appModalParent();
  try {
    const r = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return r.response === 0 ? 'stop' : r.response === 1 ? 'keep' : 'cancel';
  } finally {
    quitDialogOpen = false;
  }
}

function quitApp(): void {
  if (ownedServices.size > 0 && quitDecision === null) {
    if (quitDialogOpen) return;
    void promptQuitDecision('quit').then((decision) => {
      if (decision === null || decision === 'cancel') {
        quitDecision = null;
        return;
      }
      quitDecision = decision;
      isQuitting = true;
      app.quit();
    });
    return;
  }
  isQuitting = true;
  app.quit();
}

function showAboutDialog(): void {
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: '关于 DeepSeek Harness Shell',
    message: `DeepSeek Harness Shell v${app.getVersion()}`,
    detail: '社区实验项目，非 DeepSeek 官方产品。\nMIT License · dsh-desktop-shell contributors',
    buttons: ['确定'],
    noLink: true,
  };
  const parent = appModalParent();
  void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
}

function diagnosticsText(): string {
  const list = sessionList();
  const lines = [
    `版本：${app.getVersion()}`,
    `会话窗口：${list.length} 个（上限 ${MAX_SESSION_WINDOWS}）`,
    ...list.map((s) => {
      const u = s.displayUrl() ?? '未连接';
      return `  - ${u}${s.phase === 'reconnecting' ? '（重连中）' : ''}${s.unreadCount !== null ? ` 未读 ${s.unreadCount}` : ''}`;
    }),
    `本地服务：${ownedServices.size > 0 ? [...ownedServices.values()].map((s) => s.url).join(', ') : '未启动'}`,
    `已保存连接：${savedConnections.length}`,
    `勿扰：${isNotificationMuted() ? '开启' : '关闭'}`,
    '',
    '--- 运行日志 ---',
    logSnapshot(diagLogs) || '（暂无日志）',
  ];
  return lines.join('\n');
}

function showDiagnostics(): void {
  const content = diagnosticsText();
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
  const parent = appModalParent();
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
      void showMessage({
        type: 'error',
        title: '导出失败',
        message: e instanceof Error ? e.message : String(e),
        buttons: ['确定'],
        noLink: true,
      });
    }
  })();
}

function exportConnectionsToFile(): void {
  const options: Electron.SaveDialogOptions = {
    title: '导出连接配置',
    defaultPath: 'dsh-connections.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const parent = appModalParent();
  void (async () => {
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return;
    try {
      fs.writeFileSync(result.filePath, exportConnections(savedConnections), 'utf-8');
    } catch (err) {
      void showMessage({
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
  const options: Electron.OpenDialogOptions = {
    title: '导入连接配置',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const parent = appModalParent();
  void (async () => {
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return;
    let raw: string;
    try {
      raw = fs.readFileSync(result.filePaths[0]!, 'utf-8');
    } catch (err) {
      void showMessage({
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
      void showMessage({
        type: 'warning',
        title: '导入失败',
        message: '文件中没有可用的连接配置（需要包含合法的 http/https 地址）。',
        buttons: ['确定'],
        noLink: true,
      });
      return;
    }
    for (const conn of imported) savedConnections = mergeSavedConnection(savedConnections, conn);
    recentServers = connectionsToRecentUrls(savedConnections).slice(0, 5);
    persistConnections();
    for (const s of sessionList()) {
      s.send('login:recent-result', recentServers);
      s.sendConnectionsResult();
    }
    void showMessage({
      type: 'info',
      title: '导入完成',
      message: `已导入 ${imported.length} 条连接配置。`,
      buttons: ['确定'],
      noLink: true,
    });
  })();
}

// —— DND ——

function setDnd(on: boolean): void {
  dndEnabled = on;
  persistState({ dnd: on });
  for (const s of sessionList()) s.send('shell:dnd-changed', on);
  updateTray();
}

function setDndSchedule(schedule: DndSchedule | undefined): void {
  dndSchedule = schedule;
  persistState({ dndSchedule: schedule });
  for (const s of sessionList()) s.send('shell:dnd-schedule-changed', schedule ?? null);
  updateTray();
}

function setCloseBehavior(behavior: CloseBehavior): void {
  closeBehavior = behavior;
  persistState({ closeBehavior: behavior });
}

// —— 深链协议 ——

function handleDshShellUrl(raw: string): void {
  const parsed = parseDshShellUrl(raw);
  if (parsed.action === 'show') {
    const s = activeSession();
    if (s) s.show();
    else openLoginSession();
    return;
  }
  if (parsed.action === 'open') {
    const s = activeSession() ?? openLoginSession();
    void s.joinRemoteUrl(parsed.url);
    return;
  }
  console.warn(`[shell] ignored unknown dsh-shell url: ${raw}`);
}

function registerProtocolClient(): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  try {
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1] ?? '.')]);
    }
  } catch (e) {
    console.warn('[shell] failed to register protocol client:', e);
  }
}

// —— SessionHost：会话向应用层索要的能力 ——

const host: SessionHost = {
  isDark: () => currentThemeDark ?? false,
  updateTray: () => updateTray(),
  notify: (title, body, onClick) => notifyMutedAware(title, body, onClick),
  connections: () => savedConnections,
  rememberConnection: (url, kind) => {
    recentServers = mergeRecentServers(recentServers, url);
    savedConnections = mergeSavedConnection(savedConnections, {
      id: makeConnectionId(url),
      name: url,
      url,
      kind,
      lastUsed: Date.now(),
    });
    persistConnections();
    // 共享配置里的 url 跟随最近活跃的连接（cordis 插件读它）。
    saveSharedConfig({ url });
    for (const s of sessionList()) {
      s.send('login:recent-result', recentServers);
      s.sendConnectionsResult();
    }
    updateTray();
  },
  recentUrls: () => recentServers,
  forgetRecent: (url) => {
    recentServers = removeRecentServer(recentServers, url);
    persistConnections();
  },
  clearRecent: () => {
    recentServers = [];
    persistConnections();
  },
  removeConnection: (id) => {
    savedConnections = removeSavedConnection(savedConnections, id);
    recentServers = connectionsToRecentUrls(savedConnections).slice(0, 5);
    persistConnections();
  },
  renameConnection: (id, name) => {
    savedConnections = renameSavedConnection(savedConnections, id, name);
    persistConnections();
  },
  pinConnection: (id) => {
    savedConnections = pinConnectionInList(savedConnections, id, Date.now());
    persistConnections();
  },
  setConnectionProxy: (id, raw) => {
    const proxy = raw === null ? undefined : (normalizeProxyConfig(raw) ?? undefined);
    savedConnections = updateSavedConnection(savedConnections, id, { proxy });
    persistConnections();
    const target = savedConnections.find((c) => c.id === id);
    // 已打开的该连接立即生效（下次导航即走新代理）。
    if (target) {
      const s = sessions.get(sessionKeyForUrl(target.url));
      if (s) {
        s.proxy = proxy ?? null;
        s.sendConnectionsResult();
      }
    }
  },
  ownedServiceFor: (url) => ownedServiceFor(url),
  hasOwnedServices: () => ownedServices.size > 0,
  startLocalService: (session, port) => startLocalService(session, port),
  stopLocalService: (url) => stopLocalService(url),
  shortcuts: () => ({ bindings: shortcutBindings, envOverride: globalHotkeyEnvActive }),
  setShortcut: (action, acc) => applyShortcutBinding(action, acc),
  resetShortcut: (scope) => {
    if (scope === 'all') {
      shortcutBindings = { ...DEFAULT_SHORTCUTS };
      globalHotkeyEnvActive = false;
      persistState({ shortcuts: serializeShortcutBindings(shortcutBindings) });
      applyGlobalHotkeys();
      return;
    }
    if (isShortcutAction(scope)) applyShortcutBinding(scope, DEFAULT_SHORTCUTS[scope]);
  },
  onUnreadChanged: (session) => onUnreadChanged(session),
  persistState: (session) => {
    if (session.connectedUrl === null) return;
    const snap = session.stateSnapshot();
    savedConnections = updateSavedConnection(savedConnections, makeConnectionId(session.connectedUrl), {
      bounds: snap.bounds,
      maximized: snap.maximized,
      zoomFactor: snap.zoomFactor,
      alwaysOnTop: snap.alwaysOnTop,
    });
    persistConnections();
  },
  requestClose: (session) => requestCloseSession(session),
  openLoginSession: () => {
    openLoginSession();
  },
  onSessionGone: (session) => {
    sessions.delete(session.id);
    persistSessionWindows();
    updateTray();
    // 所有窗口都关掉了仍常驻托盘：托盘菜单里的「打开窗口」会新建 login 窗口。
  },
  // 窗口级 IPC 只注册一次、按来源路由（session.ts registerIpcOnce）。
  sessionForSender: (sender) => {
    for (const s of sessions.values()) {
      if (s.ownsSender(sender)) return s;
    }
    return null;
  },
  isQuitting: () => isQuitting,
  closeBehavior: () => closeBehavior,
  toggleCloseBehavior: () => {
    setCloseBehavior(closeBehavior === 'close-session' ? 'hide-to-tray' : 'close-session');
  },
  dndEnabled: () => dndEnabled,
  dndSchedule: () => dndSchedule ?? null,
  setDndSchedule: (raw) => setDndSchedule(normalizeDndSchedule(raw) ?? undefined),
  toggleDnd: () => setDnd(!dndEnabled),
  checkUpdates: () => checkForUpdatesNow(),
  showDiagnostics: () => showDiagnostics(),
  exportConnections: () => exportConnectionsToFile(),
  importConnections: () => importConnectionsFromFile(),
  showAbout: () => showAboutDialog(),
  quit: () => quitApp(),
  log: (line) => pushLogLine(diagLogs, line),
};

// —— 启动 ——

/** 打开第一个窗口：优先恢复上次的会话窗口，否则按配置连接，再否则 login。
 *  注意：本函数在第一个 await 之前就已同步建出窗口——调用方据此把托盘等
 *  非窗口工作安排到首帧之后，别挡在 ready-to-show 前面。 */
async function openInitialWindows(): Promise<void> {
  const restore = planRestoreSessions(shellState().sessionWindows);
  for (const url of restore) {
    const ok = await openSessionForUrl(url, { startHidden });
    if (!ok) console.warn(`[shell] restore failed: ${url}`);
  }
  if (restore.length > 0) return;

  let configured: string | null = null;
  try {
    configured = await resolveConfiguredUrl();
  } catch (err) {
    console.warn('[shell] configured URL invalid, showing login:', err);
  }
  if (configured) {
    // 共享配置是本机任意进程可写的（cordis 插件通道）：非回环地址必须走
    // 与手动连接相同的确认弹窗，防止被篡改后在启动时静默加载钓鱼页。
    const session = await openSessionForUrl(configured, { startHidden });
    if (!session) {
      console.warn('[shell] auto-connect declined or failed, showing login');
      openLoginSession({ startHidden });
    }
    return;
  }
  openLoginSession({ startHidden });
}

async function bootstrap(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  startHidden = process.argv.includes('--hidden');

  app.on('open-url', (e, url) => {
    e.preventDefault();
    if (app.isReady()) handleDshShellUrl(url);
    else pendingProtocolUrl = url;
  });

  app.on('second-instance', (_e, argv) => {
    const proto = argv.find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOL_SCHEME}://`));
    if (proto) handleDshShellUrl(proto);
    const s = activeSession();
    if (s) s.show();
    else openLoginSession();
  });

  await app.whenReady();

  try {
    if (process.platform === 'win32') app.setAppUserModelId('io.github.dsh.desktop-shell');
    app.setAboutPanelOptions({
      applicationName: 'DeepSeek Harness Shell',
      applicationVersion: app.getVersion(),
      copyright: 'MIT License · dsh-desktop-shell contributors',
    });

    // 状态加载（内存态）：主题、窗口状态、连接配置库、快捷键、勿扰。
    const state = shellState();
    currentThemeDark = resolveIsDark(readDshThemePreference());
    savedConnections = state.connections ?? [];
    recentServers = state.recentServers ?? connectionsToRecentUrls(savedConnections).slice(0, 5);
    loadShortcutBindings(state.shortcuts);
    dndEnabled = state.dnd === true;
    dndSchedule = state.dndSchedule;
    closeBehavior = state.closeBehavior ?? 'close-session';

    registerProtocolClient();

    // 首帧关键路径：先起窗口，再把托盘/同步 I/O/自动连接排到后面。
    // 注意顺序来自实测——把 createTray() 放在窗口之前会让 ready-to-show 慢 ~16ms。
    const initialWindows = openInitialWindows();
    createTray();

    // 首帧之后再处理同步 I/O 与网络：原先 migrateLegacyConfig /
    // saveSharedConfig(desktopExe) / startConfigPolling 都在建窗口之前跑在主线程上。
    setImmediate(() => {
      migrateLegacyConfig();
      // 记录自身可执行路径，供 cordis 插件 /desktop open 时 spawn 使用。
      // 三重门槛（打包构建 + 绝对路径 + 文件存在）防环境变量污点注入 spawn 目标。
      const portable = app.isPackaged ? process.env.PORTABLE_EXECUTABLE_FILE : undefined;
      const exePath = portable && path.isAbsolute(portable) && fs.existsSync(portable) ? portable : process.execPath;
      if (loadSharedConfig().desktopExe !== exePath) saveSharedConfig({ desktopExe: exePath });
      startConfigWatching();
      setupAutoUpdater();
    });

    if (pendingProtocolUrl) {
      handleDshShellUrl(pendingProtocolUrl);
      pendingProtocolUrl = null;
    }
    const protoArg = process.argv.find((a) => a.startsWith(`${PROTOCOL_SCHEME}://`));
    if (protoArg) handleDshShellUrl(protoArg);

    await initialWindows;
    updateTray();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void dialog.showErrorBox('DeepSeek Harness Shell', msg);
    app.quit();
  }
}

app.on('before-quit', (e) => {
  if (ownedServices.size > 0 && quitDecision === null) {
    e.preventDefault();
    if (quitDialogOpen) return;
    void promptQuitDecision('quit').then((decision) => {
      if (decision === null || decision === 'cancel') {
        quitDecision = null;
        isQuitting = false;
        return;
      }
      quitDecision = decision;
      app.quit();
    });
    return;
  }
  if (configBackupTimer) clearInterval(configBackupTimer);
  for (const s of sessions.values()) {
    try {
      s.flushState();
    } catch {
      /* 退出清理尽力而为 */
    }
  }
  try {
    globalShortcut.unregisterAll();
  } catch {
    /* ignore */
  }
  if (quitDecision !== 'keep') {
    for (const service of ownedServices.values()) service.stop();
  }
  ownedServices.clear();
});

app.on('window-all-closed', () => {
  // 常驻托盘，不主动退出。
});

void bootstrap();
