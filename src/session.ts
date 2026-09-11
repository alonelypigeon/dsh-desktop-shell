// 会话（Session）：一个 DSH 连接 = 一个原生窗口 + 一个内容视图。
//
// 重构背景（v1.0）：v0.8 之前所有窗口状态都摊在 main.ts 的模块级变量里
// （shellWindow / contentView / connectedUrl / unreadCount / zoomFactor ...），
// 只有一个窗口时能跑，第二个窗口就会互相踩。这里把「每个窗口各自的东西」
// 收进 Session，main.ts 只保留应用级的东西（托盘、全局热键、连接配置库、
// 勿扰、更新、本地服务注册表）。
//
// 边界：
//   - Session 自己持有：窗口、内容视图、连接地址、未读计数、缩放、查找栏、
//     设置/命令面板开合、重连轮询、窗口状态持久化。
//   - 应用级能力通过 SessionHost 回调（通知、托盘刷新、配置库、服务注册表）。
//   - 零注入红线不变：内容视图 sandbox + 无 preload，页面状态只来自 Electron 事件。
import { BrowserWindow, Menu, WebContentsView, dialog, ipcMain, nativeImage } from 'electron';
import * as path from 'node:path';
import { attachSecurity, openExternalSafe } from './security';
import { pushShellUiState } from './shell-ui-state';
import { probeUrl } from './probe';
import { parseTitleCount } from './title-watcher';
import { normalizeRequestedPort } from './dsh-launcher';
import { ZOOM_DEFAULT, formatFindCount, normalizeZoom, stepZoom } from './view-controls';
import { buildPaletteEntries, type PaletteEntry } from './palette';
import {
  buildDisconnectMenuItems,
  buildMoreMenuItems,
  buildServerMenuItems,
  isTitlebarMenuName,
  type TitlebarMenuName,
} from './titlebar-menus';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_META,
  conflictsFor,
  findShortcutConflicts,
  isShortcutAction,
  matchContentShortcut,
  recordingOutcome,
  serializeShortcutBindings,
  type RawKeyEvent,
  type ShortcutAction,
  type ShortcutBindings,
} from './shortcuts';
import { partitionForConnection, sessionKeyForUrl } from './session-policy';
import { describeProxyConfig } from './proxy';
import { collectHealth } from './health-runtime';
import { formatHealthReport } from './health';
import { isLoopbackHost, validateUrl } from './url';
import type { CloseBehavior, ConnectionKind, DndSchedule, SavedConnection } from './shell-state';
import type { DshService } from './dsh-launcher';
import type { ProxyConfig } from './proxy';

export const TITLEBAR_HEIGHT = 42;
// 页面内查找栏高度（打开时内容视图下移让出这一条）
export const FINDBAR_HEIGHT = 40;
// 重连探测间隔与单次探测超时：超时必须小于间隔，否则探测会在挂掉的主机上叠加。
const RECONNECT_INTERVAL_MS = 3000;
const RECONNECT_PROBE_TIMEOUT_MS = 2500;

/** 会话向应用层（main.ts）索要的应用级能力。 */
export interface SessionHost {
  /** 当前是否深色主题（标题栏初始背景色）。 */
  isDark(): boolean;
  /** 应用级菜单/托盘刷新（连接状态、置顶、服务、勿扰变化时调用）。 */
  updateTray(): void;
  /** 系统通知（勿扰门控在应用层统一处理）。 */
  notify(title: string, body: string, onClick?: () => void): void;
  /** 连接配置库快照。 */
  connections(): SavedConnection[];
  /** 记住一条连接（最近列表 + 配置库 + 共享配置 url）。 */
  rememberConnection(url: string, kind: ConnectionKind): void;
  /** 最近连接地址（命令面板用）。 */
  recentUrls(): string[];
  /** 删除一条最近连接。 */
  forgetRecent(url: string): void;
  /** 清空最近连接。 */
  clearRecent(): void;
  /** 删除 / 重命名 / 置顶一条连接配置。 */
  removeConnection(id: string): void;
  renameConnection(id: string, name: string): void;
  pinConnection(id: string): void;
  /** 写入某条连接的代理配置（A5）。 */
  setConnectionProxy(id: string, raw: unknown): void;
  /** 本应用启动的本地服务（按地址查）。 */
  ownedServiceFor(url: string | null): DshService | null;
  /** 是否还有任一由本应用启动的本地服务。 */
  hasOwnedServices(): boolean;
  /** 启动本地服务并连接（GUI 按钮 / 命令面板）。 */
  startLocalService(session: Session, port: number): Promise<void>;
  /** 停止本地服务（url=null 表示全部）。 */
  stopLocalService(url: string | null): void;
  /** 快捷键绑定快照 + 环境变量覆盖标志。 */
  shortcuts(): { bindings: ShortcutBindings; envOverride: boolean };
  /** 写入一条绑定并持久化（全局热键由应用层重注册）。 */
  setShortcut(action: ShortcutAction, acc: string | null): void;
  /** 重置绑定（'all' 或单个动作）。 */
  resetShortcut(scope: ShortcutAction | 'all'): void;
  /** 未读变化 → 应用层重新聚合徽章与通知。 */
  onUnreadChanged(session: Session): void;
  /** 持久化该会话的窗口状态（bounds / zoom / alwaysOnTop）。 */
  persistState(session: Session): void;
  /** 用户点了 ✕（按「关闭行为」设置决定关闭会话还是收进托盘）。 */
  requestClose(session: Session): void;
  /** 打开一个新的 login 窗口（「新建连接…」）。 */
  openLoginSession(): void;
  /** 会话窗口已销毁，请从注册表移除并刷新托盘。 */
  onSessionGone(session: Session): void;
  /** 按 event.sender 找属主会话（窗口级 IPC 只注册一次、按来源路由）。 */
  sessionForSender(sender: Electron.WebContents): Session | null;
  /** 应用是否正在退出（退出流程中放行窗口关闭）。 */
  isQuitting(): boolean;
  /** 标题栏 ✕ 的行为设置。 */
  closeBehavior(): CloseBehavior;
  /** 切换标题栏 ✕ 的行为（「更多」菜单项）。 */
  toggleCloseBehavior(): void;
  /** 勿扰开关状态（「更多」菜单 checkbox）。 */
  dndEnabled(): boolean;
  /** 定时勿扰时段（设置面板）。 */
  dndSchedule(): DndSchedule | null;
  /** 写入定时勿扰时段。 */
  setDndSchedule(raw: unknown): void;
  /** 切换勿扰。 */
  toggleDnd(): void;
  /** 检查更新。 */
  checkUpdates(): void;
  /** 诊断日志面板。 */
  showDiagnostics(): void;
  /** 导出 / 导入连接配置。 */
  exportConnections(): void;
  importConnections(): void;
  /** 关于对话框。 */
  showAbout(): void;
  /** 退出应用。 */
  quit(): void;
  /** 诊断日志。 */
  log(line: string): void;
}

export interface SessionInit {
  /** 恢复的窗口位置/尺寸（已通过 sanitizeBounds 校验）。 */
  bounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
  zoomFactor?: number;
  alwaysOnTop?: boolean;
  /** 该连接保存的代理配置（A5）。 */
  proxy?: ProxyConfig;
  /** 启动到托盘不弹窗（--hidden）。 */
  startHidden?: boolean;
  /** 纯 login 窗口（尚无连接地址）。 */
  loginWindow?: boolean;
}

let loginWindowSeq = 0;

/**
 * 一个会话窗口。生命周期：create() → connectTo() → close()/destroy()。
 * 未连接的会话窗口显示 login 界面。
 */
export class Session {
  /** 窗口级 IPC 是否已注册（应用生命周期内仅一批监听器，见 registerIpcOnce）。 */
  private static sessionIpcRegistered = false;
  /** 会话键：连接的规范化 URL；login 窗口在连上之前用临时键。 */
  private idValue: string;
  get id(): string {
    return this.idValue;
  }
  readonly window: BrowserWindow;
  /** 连接地址（null = 仍是 login 窗口）。 */
  connectedUrl: string | null = null;
  /** 内容视图当前实际地址（重定向后可能与 connectedUrl 不同）。 */
  currentPageUrl: string | null = null;
  contentView: WebContentsView | null = null;
  phase: 'connected' | 'reconnecting' = 'connected';
  unreadCount: number | null = null;
  zoomFactor = ZOOM_DEFAULT;
  alwaysOnTop = false;
  findBarOpen = false;
  settingsOpen = false;
  paletteOpen = false;
  /** 最近一次被聚焦/交互的时间（全局热键「唤起最近活跃窗口」用）。 */
  lastActiveAt = Date.now();
  /** 该连接保存的代理配置（A5）；null = 直连（不设代理）。 */
  proxy: ProxyConfig | null = null;
  /** 窗口是否已销毁（异步回调里要用）。 */
  destroyed = false;

  private lastFindText = '';
  private paletteModel: PaletteEntry[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private boundsSaveTimer: NodeJS.Timeout | null = null;
  private currentThemeDark: boolean;
  private startHidden: boolean;
  /** 内容视图是否已加入窗口（设置/命令面板打开期间摘下）。 */
  private viewAttached = false;

  constructor(
    private readonly host: SessionHost,
    init: SessionInit = {},
  ) {
    this.idValue = init.loginWindow ? `login-${++loginWindowSeq}` : `session-${++loginWindowSeq}`;
    this.startHidden = init.startHidden === true;
    this.zoomFactor = normalizeZoom(init.zoomFactor ?? ZOOM_DEFAULT);
    this.alwaysOnTop = init.alwaysOnTop === true;
    this.proxy = init.proxy ?? null;
    this.currentThemeDark = host.isDark();

    this.window = new BrowserWindow({
      width: init.bounds?.width ?? 1440,
      height: init.bounds?.height ?? 920,
      x: init.bounds?.x,
      y: init.bounds?.y,
      minWidth: 960,
      minHeight: 640,
      show: false,
      frame: false, // 无边框，标题栏由 shell.html 自绘
      icon: path.join(__dirname, 'icon.png'),
      backgroundColor: this.currentThemeDark ? '#151517' : '#ffffff',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'shell-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        // D2 托盘资源策略：隐藏时保持网络（DSH 长任务轮询不被节流），
        // 渲染开销由不可见窗口自然下降（Chromium 不再合成不可见页面）。
        backgroundThrottling: false,
      },
    });
    this.wireWindow(init);
    Session.registerIpcOnce(this.host);
    void this.window.loadFile(path.join(__dirname, 'shell.html'), {
      query: { dark: this.currentThemeDark ? '1' : '0' },
    });
  }

  // —— 基础访问器 ——

  /** login 窗口连上后改用连接键（会话注册表据此去重）。 */
  rekey(url: string): string {
    this.idValue = sessionKeyForUrl(url);
    return this.idValue;
  }

  /** 是否仍是未连接的 login 窗口。 */
  get isLoginWindow(): boolean {
    return this.connectedUrl === null;
  }

  get destroyedWindow(): boolean {
    return this.destroyed || this.window.isDestroyed();
  }

  /** 对外展示的连接地址：重定向后的实际地址优先。 */
  displayUrl(): string | null {
    return this.currentPageUrl ?? this.connectedUrl;
  }

  /** 该连接是否由本应用启动的本地服务。 */
  isOwnedConnection(): boolean {
    return this.connectedUrl !== null && this.host.ownedServiceFor(this.connectedUrl) !== null;
  }

  /** 当前连接是否为「非本应用启动」的本机实例（嗅探连接的外部 DSH）。 */
  isExternalLocalConnection(): boolean {
    if (this.connectedUrl === null || this.isOwnedConnection()) return false;
    try {
      return isLoopbackHost(new URL(this.connectedUrl).hostname);
    } catch {
      return false;
    }
  }

  /** 窗口是否不在用户眼前（隐藏或最小化）。 */
  isWindowAway(): boolean {
    if (this.destroyedWindow) return false;
    return !this.window.isVisible() || this.window.isMinimized();
  }

  /** 托盘/菜单里的会话摘要。 */
  summary(): { id: string; url: string; name: string; connected: boolean; unread: number | null; active: boolean } {
    const url = this.displayUrl() ?? '';
    const saved = this.host.connections().find((c) => c.url === this.connectedUrl);
    return {
      id: this.id,
      url,
      name: saved?.name ?? url,
      connected: this.connectedUrl !== null,
      unread: this.unreadCount,
      active: this.window.isFocused(),
    };
  }

  show(): void {
    if (this.destroyedWindow) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    this.lastActiveAt = Date.now();
  }

  hide(): void {
    if (!this.destroyedWindow) this.window.hide();
  }

  toggle(): void {
    if (this.destroyedWindow) return;
    if (this.window.isVisible() && !this.window.isMinimized()) this.hide();
    else this.show();
  }

  applyTheme(dark: boolean): void {
    if (dark === this.currentThemeDark || this.destroyedWindow) return;
    this.currentThemeDark = dark;
    this.window.webContents.send('shell:theme-changed', dark);
  }

  // —— 窗口事件 ——

  private wireWindow(init: SessionInit): void {
    const win = this.window;

    // shell 页面自身不需要弹窗与外部导航（纵深防御）。
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('file:')) {
        e.preventDefault();
        console.warn(`[shell] blocked shell window navigation: ${url}`);
      }
    });

    if (this.alwaysOnTop) win.setAlwaysOnTop(true);

    // 竞态修复：连接本机服务几毫秒即完成，attachContentView 推送的状态可能
    // 早于渲染器注册监听器 → 标题栏连接状态永远不显示。页面每次加载完成后
    // 重发全部 UI 状态使其自愈（shell-ui-state.ts）。
    win.webContents.on('did-finish-load', () => {
      if (this.destroyedWindow) return;
      this.pushUiState();
      if (this.settingsOpen) this.pushShortcutsState();
    });

    if (init.maximized) win.maximize();

    win.once('ready-to-show', () => {
      // 开机自启（--hidden）时不打扰：窗口留在托盘。
      if (!this.startHidden) win.show();
    });

    // 窗口聚焦即视为已读：清空未读计数（聚合徽章由应用层重算）。
    win.on('focus', () => {
      this.lastActiveAt = Date.now();
      if (this.unreadCount !== null) {
        this.unreadCount = null;
        this.host.onUnreadChanged(this);
      }
      this.host.updateTray();
    });

    win.on('close', (e) => {
      // 应用正在退出 → 放行；否则交给应用层的关闭策略决定。
      if (this.destroyed || this.host.isQuitting()) return;
      e.preventDefault();
      this.host.requestClose(this);
    });

    win.on('resize', () => {
      this.updateContentViewBounds();
      this.scheduleBoundsSave();
    });
    win.on('move', () => this.scheduleBoundsSave());
    win.on('maximize', () => this.scheduleBoundsSave());
    win.on('unmaximize', () => this.scheduleBoundsSave());
    win.on('show', () => this.host.updateTray());
    win.on('hide', () => this.host.updateTray());
    win.on('closed', () => {
      this.destroyed = true;
      this.stopReconnect();
      this.host.onSessionGone(this);
    });

    win.on('maximize', () => win.webContents.send('shell:maximize-changed', true));
    win.on('unmaximize', () => win.webContents.send('shell:maximize-changed', false));
  }

  // —— 窗口状态持久化（每连接一条记录，由应用层写入配置库） ——

  private scheduleBoundsSave(): void {
    if (this.boundsSaveTimer) clearTimeout(this.boundsSaveTimer);
    this.boundsSaveTimer = setTimeout(() => this.saveBoundsNow(), 500);
  }

  private saveBoundsNow(): void {
    if (this.boundsSaveTimer) {
      clearTimeout(this.boundsSaveTimer);
      this.boundsSaveTimer = null;
    }
    if (this.destroyedWindow) return;
    this.host.persistState(this);
  }

  /** 立即落盘（退出前调用）。 */
  flushState(): void {
    if (this.boundsSaveTimer) {
      clearTimeout(this.boundsSaveTimer);
      this.boundsSaveTimer = null;
    }
    if (!this.destroyedWindow) this.host.persistState(this);
  }

  /** 该会话当前的窗口状态快照（应用层写进配置库）。 */
  stateSnapshot(): {
    bounds?: { x: number; y: number; width: number; height: number };
    maximized: boolean;
    zoomFactor: number;
    alwaysOnTop: boolean;
  } {
    const maximized = !this.destroyedWindow && this.window.isMaximized();
    const minimized = !this.destroyedWindow && this.window.isMinimized();
    // bounds 只存普通态尺寸（最大化/最小化时保留文件里的旧值）。
    const bounds = !this.destroyedWindow && !maximized && !minimized ? this.window.getBounds() : undefined;
    return { bounds, maximized, zoomFactor: this.zoomFactor, alwaysOnTop: this.alwaysOnTop };
  }

  setAlwaysOnTop(on: boolean): void {
    this.alwaysOnTop = on;
    if (!this.destroyedWindow) {
      this.window.setAlwaysOnTop(on);
      this.window.webContents.send('shell:alwayson-changed', on);
    }
    this.host.persistState(this);
    this.host.updateTray();
  }

  // —— 内容视图 ——

  updateContentViewBounds(): void {
    if (this.destroyedWindow || !this.contentView) return;
    const [w, h] = this.window.getContentSize();
    const top = TITLEBAR_HEIGHT + (this.findBarOpen ? FINDBAR_HEIGHT : 0);
    this.contentView.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
  }

  /** 挂载 DSH 内容视图并隐藏 login 界面。 */
  async attachContentView(url: string): Promise<void> {
    if (this.destroyedWindow) return;
    if (!this.contentView) {
      const connectionId = sessionKeyForUrl(url);
      const view = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
          // 每连接独立分区（v1.0 + A5）：代理、cookie、storage 互不干扰，
          // 也让 security.ts 的 session 级权限 handler 不再被其他窗口覆盖。
          partition: partitionForConnection(connectionId),
          // 刻意不加 preload：DSH 页面保持零注入。
        },
      });
      this.contentView = view;
      view.webContents.setZoomFactor(this.zoomFactor);

      view.webContents.on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown') return;
        if (input.key === 'Escape' && this.findBarOpen) {
          e.preventDefault();
          this.closeFindBar();
          return;
        }
        const action = matchContentShortcut(this.host.shortcuts().bindings, input);
        if (action === null) return; // 与外壳无关，放行给 DSH 页面
        e.preventDefault();
        this.runContentAction(action);
      });

      view.webContents.on('found-in-page', (_e, result) => {
        if (!result.finalUpdate) return;
        this.send('shell:find-result', formatFindCount(result.activeMatchOrdinal, result.matches));
      });

      // 服务端 3xx 重定向不触发 will-navigate，跟踪实际地址让标题栏/托盘如实显示。
      view.webContents.on('did-navigate', (_e, url2) => {
        if (typeof url2 === 'string' && /^https?:/i.test(url2)) this.updateCurrentPageUrl(url2);
      });
      view.webContents.on('did-navigate-in-page', (_e, url2) => {
        if (typeof url2 === 'string' && /^https?:/i.test(url2)) this.updateCurrentPageUrl(url2);
      });

      // 页面标题的 "(n)" 前缀 = 未读信号（零注入下最可靠的「代理需要你」提示）。
      view.webContents.on('page-title-updated', (_e, title) => {
        this.handlePageTitle(typeof title === 'string' ? title : '');
      });

      view.webContents.on('did-fail-load', (_e, code, desc, validatedUrl) => {
        if (code === -3) return;
        this.host.log(`[shell] failed to load ${validatedUrl}: ${desc} (${code})`);
        if (validatedUrl.startsWith('http')) {
          this.enterReconnecting(validatedUrl);
          this.scheduleReloadOnReconnect(validatedUrl);
        }
      });
    }

    // 代理（A5）：每连接独立 partition → 可以按连接设置，互不影响。
    await this.applyProxy();
    attachSecurity(this.contentView.webContents, new URL(url).origin);
    void this.contentView.webContents.loadURL(url);
    this.updateContentViewBounds();
    this.connectedUrl = url;
    this.currentPageUrl = url;
    this.unreadCount = null;
    this.host.onUnreadChanged(this);
    this.setPhase('connected');
    this.attachViewIfNeeded();
    this.send('login:visible', false);
    this.sendConnectionState();
    this.host.updateTray();
  }

  /** 按该连接的代理配置设置 session 代理（A5）。 */
  private async applyProxy(): Promise<void> {
    if (!this.contentView) return;
    const ses = this.contentView.webContents.session;
    try {
      if (!this.proxy || this.proxy.mode === 'direct') {
        await ses.setProxy({ mode: 'direct' });
        return;
      }
      await ses.setProxy({
        proxyRules: this.proxy.url,
        proxyBypassRules: this.proxy.bypass.length > 0 ? this.proxy.bypass.join(';') : undefined,
      });
    } catch (e) {
      this.host.log(`[shell] setProxy failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 内容视图未挂载时补挂（设置/命令面板关闭后）。 */
  private attachViewIfNeeded(): void {
    if (!this.contentView || this.destroyedWindow) return;
    if (this.viewAttached) return;
    this.window.contentView.addChildView(this.contentView);
    this.viewAttached = true;
  }

  private detachViewIfNeeded(): void {
    if (!this.contentView || this.destroyedWindow) return;
    if (!this.viewAttached) return;
    this.window.contentView.removeChildView(this.contentView);
    this.viewAttached = false;
  }

  private updateCurrentPageUrl(url: string): void {
    if (this.currentPageUrl === url) return;
    const prevOrigin = this.currentPageUrl === null ? null : safeOrigin(this.currentPageUrl);
    const nextOrigin = safeOrigin(url);
    if (prevOrigin !== null && nextOrigin !== null && prevOrigin !== nextOrigin) {
      console.warn(`[shell] page origin changed by redirect: ${prevOrigin} -> ${nextOrigin}`);
    }
    this.currentPageUrl = url;
    this.sendConnectionState();
    this.host.updateTray();
  }

  /** 卸载内容视图，回到 login 界面（切换服务器/断开连接）。 */
  detachContentView(): void {
    if (this.findBarOpen) {
      this.findBarOpen = false;
      this.lastFindText = '';
      this.send('shell:find-visible', false);
    }
    this.detachViewIfNeeded();
    if (this.contentView) {
      this.contentView.webContents.close();
      this.contentView = null;
    }
    this.connectedUrl = null;
    this.currentPageUrl = null;
    this.unreadCount = null;
    this.host.onUnreadChanged(this);
    this.setPhase('connected');
    this.stopReconnect();
    this.send('login:visible', true);
    this.send('login:recent-result', this.host.recentUrls());
    this.sendConnectionsResult();
    this.sendConnectionState();
    this.host.updateTray();
  }

  /** 连接一条 URL（探测 → 记住 → 挂载视图）。返回是否成功。 */
  async connectTo(rawUrl: string): Promise<boolean> {
    let url: string;
    try {
      url = validateUrl(rawUrl);
    } catch (err) {
      this.showLoginError(err instanceof Error ? err.message : String(err));
      return false;
    }
    const owned = this.host.ownedServiceFor(url) !== null;
    if (!owned && !(await probeUrl(url))) {
      this.showLoginError(`无法连接到 ${url}`);
      this.detachContentView();
      return false;
    }
    let kind: ConnectionKind = 'remote';
    try {
      if (owned) kind = 'local-start';
      else if (isLoopbackHost(new URL(url).hostname)) kind = 'sniffed';
    } catch {
      /* 保留 remote */
    }
    this.host.rememberConnection(url, kind);
    // 连接时应用该连接保存的代理（A5）
    const saved = this.host.connections().find((c) => c.url === url);
    this.proxy = saved?.proxy ?? null;
    await this.attachContentView(url);
    // 连接成功也要复位 login 表单 busy 态（login 只是隐藏不是卸载）。
    this.send('login:result', { ok: true });
    return true;
  }

  /** 校验 + 确认（非回环地址）+ 连接；login 手动连接与深链共用。 */
  async joinRemoteUrl(rawUrl: string): Promise<void> {
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      this.showLoginError('请输入服务器地址');
      return;
    }
    let url: string;
    try {
      url = validateUrl(rawUrl.trim());
    } catch (err) {
      this.showLoginError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!(await this.confirmRemoteConnect(url))) {
      this.showLoginError('已取消');
      return;
    }
    const ok = await this.connectTo(url);
    if (!ok) this.showLoginError(`无法连接到 ${url}`);
  }

  /** 非回环地址连接前的确认弹窗。 */
  async confirmRemoteConnect(url: string): Promise<boolean> {
    if (isLoopbackHost(new URL(url).hostname)) return true;
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      title: '连接远程服务器',
      message: `将连接到远程服务器：${url}`,
      detail: '远程页面将在隔离的沙箱视图中加载，仅允许 http/https 外链。是否继续？',
      buttons: ['连接', '取消'],
      defaultId: 0,
      cancelId: 1,
    };
    const parent = this.parentWindow();
    const r = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    return r.response === 0;
  }

  /** 弹窗时用作 modal parent 的窗口（不可见时退回无 parent）。 */
  parentWindow(): BrowserWindow | undefined {
    return !this.destroyedWindow && this.window.isVisible() ? this.window : undefined;
  }

  // —— 断开 ——

  /** 断开连接：回到 login；本应用启动的本地服务保持运行。 */
  disconnect(): void {
    this.detachContentView();
    this.show();
  }

  /** 断开连接并停止该连接自己的本地服务。 */
  disconnectAndStop(): void {
    const url = this.connectedUrl;
    this.detachContentView();
    if (url !== null && this.host.ownedServiceFor(url) !== null) {
      this.host.stopLocalService(url);
    }
    this.show();
  }

  /** 关闭一个「非本应用启动」的本机实例：定位进程 → 指纹复核 → 用户确认 → 结束。 */
  async disconnectAndStopServer(): Promise<void> {
    const url = this.connectedUrl;
    if (!url) return;
    const { resolveExternalServerTarget, terminateExternalServer } = await import('./server-stop');
    const resolved = await resolveExternalServerTarget(url);
    if ('error' in resolved) {
      this.detachContentView();
      this.host.log(`[shell] external server not found: ${resolved.error}`);
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
    const { isDshInstance } = await import('./sniffer');
    const verified = await isDshInstance(url);
    const pidText = target.pids.join(', ');
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
    const parent = this.parentWindow();
    const r = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    if (r.response !== 0) return;

    this.detachContentView();
    const result = await terminateExternalServer(target);
    void dialog.showMessageBox({
      type: result.ok ? 'info' : 'warning',
      title: '关闭服务器',
      message: result.ok ? '本机 DSH 服务器已停止' : '无法停止本机服务器',
      detail: result.detail,
      buttons: ['确定'],
      noLink: true,
    });
  }

  // —— 内容视图操作（快捷键 / 菜单 / 命令面板共用） ——

  runContentAction(action: ShortcutAction): void {
    switch (action) {
      case 'palette':
        this.togglePalette();
        break;
      case 'find':
        this.openFindBar();
        break;
      case 'reload':
        this.reloadContent(false);
        break;
      case 'reload-hard':
        this.reloadContent(true);
        break;
      case 'zoom-in':
        this.applyZoom(stepZoom(this.zoomFactor, 'in'));
        break;
      case 'zoom-out':
        this.applyZoom(stepZoom(this.zoomFactor, 'out'));
        break;
      case 'zoom-reset':
        this.applyZoom(ZOOM_DEFAULT);
        break;
      default:
        break;
    }
  }

  applyZoom(z: number): void {
    if (z === this.zoomFactor) return;
    this.zoomFactor = z;
    this.contentView?.webContents.setZoomFactor(z);
    this.host.persistState(this);
  }

  reloadContent(ignoreCache: boolean): void {
    if (!this.contentView) return;
    if (ignoreCache) this.contentView.webContents.reloadIgnoringCache();
    else this.contentView.webContents.reload();
  }

  // —— 页面内查找栏 ——

  openFindBar(): void {
    if (this.destroyedWindow || !this.contentView || this.findBarOpen) return;
    this.findBarOpen = true;
    this.updateContentViewBounds();
    // 键盘焦点此前在内容视图上：先转回 shell 页面，渲染层才能收到输入。
    this.window.webContents.focus();
    this.send('shell:find-visible', true);
  }

  closeFindBar(): void {
    if (!this.findBarOpen) return;
    this.findBarOpen = false;
    this.lastFindText = '';
    this.contentView?.webContents.stopFindInPage('clearSelection');
    this.send('shell:find-visible', false);
    this.updateContentViewBounds();
    this.contentView?.webContents.focus();
  }

  // —— 设置面板 / 命令面板（两者互斥，打开期间摘下内容视图） ——

  openSettings(): void {
    if (this.destroyedWindow || this.settingsOpen) return;
    if (this.paletteOpen) this.closePalette();
    this.settingsOpen = true;
    this.show();
    this.detachViewIfNeeded();
    this.window.webContents.focus();
    this.send('shell:settings-visible', true);
    this.pushShortcutsState();
  }

  closeSettings(): void {
    if (!this.settingsOpen) return;
    this.settingsOpen = false;
    if (this.destroyedWindow) return;
    this.send('shell:settings-visible', false);
    if (this.contentView) {
      this.attachViewIfNeeded();
      this.updateContentViewBounds();
      this.contentView.webContents.focus();
    }
  }

  openPalette(): void {
    if (this.destroyedWindow || this.paletteOpen) return;
    if (this.settingsOpen) this.closeSettings();
    this.paletteOpen = true;
    this.show();
    this.detachViewIfNeeded();
    this.window.webContents.focus();
    this.send('shell:palette-visible', true);
    this.pushPaletteModel();
  }

  closePalette(): void {
    if (!this.paletteOpen) return;
    this.paletteOpen = false;
    if (this.destroyedWindow) return;
    this.send('shell:palette-visible', false);
    if (this.contentView) {
      this.attachViewIfNeeded();
      this.updateContentViewBounds();
      this.contentView.webContents.focus();
    }
  }

  togglePalette(): void {
    if (this.paletteOpen) this.closePalette();
    else this.openPalette();
  }

  private pushPaletteModel(): void {
    if (this.destroyedWindow) return;
    this.paletteModel = buildPaletteEntries({
      connectedUrl: this.connectedUrl,
      ownedRunning: this.host.ownedServiceFor(this.connectedUrl) !== null,
      recentServers: this.host.recentUrls(),
      dnd: this.host.dndEnabled(),
      alwaysOnTop: this.alwaysOnTop,
      zoomFactor: this.zoomFactor,
    });
    this.send('shell:palette-model', this.paletteModel);
  }

  private runPaletteAction(id: string): void {
    if (id.startsWith('connect:')) {
      const url = this.host.recentUrls()[Number(id.slice('connect:'.length))];
      if (typeof url === 'string' && url !== '') void this.joinRemoteUrl(url);
      return;
    }
    switch (id) {
      case 'disconnect':
        this.disconnect();
        break;
      case 'switch-server':
        this.switchServer();
        break;
      case 'start-local':
        this.show();
        void this.host.startLocalService(this, 0);
        break;
      case 'stop-local':
        this.host.stopLocalService(this.connectedUrl);
        break;
      case 'new-window':
        this.host.openLoginSession();
        break;
      case 'reload':
        this.reloadContent(false);
        break;
      case 'reload-hard':
        this.reloadContent(true);
        break;
      case 'find':
        this.openFindBar();
        break;
      case 'zoom-in':
        this.applyZoom(stepZoom(this.zoomFactor, 'in'));
        break;
      case 'zoom-out':
        this.applyZoom(stepZoom(this.zoomFactor, 'out'));
        break;
      case 'zoom-reset':
        this.applyZoom(ZOOM_DEFAULT);
        break;
      case 'toggle-ontop':
        this.setAlwaysOnTop(!this.alwaysOnTop);
        break;
      case 'check-updates':
        this.host.checkUpdates();
        break;
      case 'shortcuts':
        this.openSettings();
        break;
      case 'health':
        void this.showHealth();
        break;
      case 'dnd':
        this.host.toggleDnd();
        break;
      case 'quit':
        this.host.quit();
        break;
      default:
        break; // 未知 id（快照已换代）忽略
    }
  }

  // —— 未读（标题前缀） ——

  private handlePageTitle(title: string): void {
    const n = parseTitleCount(title);
    if (n === this.unreadCount) return;
    this.unreadCount = n;
    // 应用层按「跨窗口求和」重算徽章，并决定是否弹聚合通知。
    this.host.onUnreadChanged(this);
  }

  // —— 断线重连（每会话独立轮询；探测不重叠） ——

  private setPhase(phase: 'connected' | 'reconnecting'): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.send('shell:phase-changed', phase);
    this.host.updateTray();
  }

  private enterReconnecting(url: string): void {
    if (this.phase === 'reconnecting') return;
    this.setPhase('reconnecting');
    this.host.notify('连接已断开', `${url}\n正在自动重连…`);
  }

  private exitReconnecting(url: string): void {
    if (this.phase !== 'reconnecting') return;
    this.setPhase('connected');
    this.host.notify('已恢复连接', `${url}\n页面已自动重新加载。`);
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReloadOnReconnect(url: string): void {
    if (this.reconnectTimer) return;
    let inFlight = false;
    this.reconnectTimer = setInterval(() => {
      void (async () => {
        if (!this.contentView || this.destroyedWindow) {
          this.stopReconnect();
          return;
        }
        if (inFlight) return; // 上一次探测还没回来，跳过本轮（避免在挂掉的主机上叠加）
        inFlight = true;
        let ok = false;
        try {
          ok = await probeUrl(url, RECONNECT_PROBE_TIMEOUT_MS);
        } finally {
          inFlight = false;
        }
        if (ok) {
          this.stopReconnect();
          this.host.log(`[shell] service back at ${url}, reloading`);
          this.exitReconnecting(url);
          void this.contentView?.webContents.reload();
        }
      })();
    }, RECONNECT_INTERVAL_MS);
    this.reconnectTimer.unref?.();
  }

  // —— 健康面板（A3） ——

  async showHealth(): Promise<void> {
    const url = this.displayUrl();
    if (!url) return;
    const report = await collectHealth(url, { ownService: this.isOwnedConnection() });
    void dialog.showMessageBox({
      type: report.reachable ? 'info' : 'warning',
      title: '连接健康',
      message: 'DeepSeek Harness 连接健康',
      detail: formatHealthReport(report),
      buttons: ['确定'],
      noLink: true,
    });
  }

  // —— 标题栏菜单 ——

  openTitlebarMenu(name: TitlebarMenuName, anchor: Electron.Rectangle): void {
    if (this.destroyedWindow) return;
    const shortcuts = this.host.shortcuts().bindings;
    let items: Electron.MenuItemConstructorOptions[];
    if (name === 'disconnect') {
      items = buildDisconnectMenuItems(
        { owned: this.isOwnedConnection(), externalLocal: this.isExternalLocalConnection() },
        {
          disconnect: () => this.disconnect(),
          disconnectAndStop: () => this.disconnectAndStop(),
          disconnectAndStopServer: () => void this.disconnectAndStopServer(),
        },
      );
    } else if (name === 'server') {
      items = buildServerMenuItems(
        { ownedRunning: this.host.ownedServiceFor(this.connectedUrl) !== null, connectedUrl: this.connectedUrl, accelerators: shortcuts },
        {
          startLocal: () => {
            this.show();
            void this.host.startLocalService(this, 0);
          },
          stopLocal: () => this.host.stopLocalService(this.connectedUrl),
          switchServer: () => this.switchServer(),
          reload: () => this.reloadContent(false),
          reloadHard: () => this.reloadContent(true),
          openInBrowser: this.connectedUrl ? () => openExternalSafe(this.connectedUrl!) : null,
          health: () => void this.showHealth(),
        },
      );
    } else {
      items = buildMoreMenuItems(
        { zoomFactor: this.zoomFactor, accelerators: shortcuts, dnd: this.host.dndEnabled(), closeBehavior: this.host.closeBehavior() },
        {
          palette: () => this.togglePalette(),
          newWindow: () => this.host.openLoginSession(),
          zoomIn: () => this.applyZoom(stepZoom(this.zoomFactor, 'in')),
          zoomOut: () => this.applyZoom(stepZoom(this.zoomFactor, 'out')),
          zoomReset: () => this.applyZoom(ZOOM_DEFAULT),
          shortcuts: () => this.openSettings(),
          toggleDnd: () => this.host.toggleDnd(),
          toggleCloseBehavior: () => this.host.toggleCloseBehavior(),
          exportConnections: () => this.host.exportConnections(),
          importConnections: () => this.host.importConnections(),
          showDiagnostics: () => this.host.showDiagnostics(),
          checkUpdates: () => this.host.checkUpdates(),
          about: () => this.host.showAbout(),
          quit: () => this.host.quit(),
        },
      );
    }
    const menu = Menu.buildFromTemplate(items);
    const cb = this.window.getContentBounds();
    const x = Math.round(cb.x + anchor.x);
    const y = Math.round(cb.y + anchor.y + anchor.height + 4);
    menu.popup({ window: this.window, x, y });
  }

  /** 切换服务器：回到 login 界面并立即嗅探一次。 */
  switchServer(): void {
    this.detachContentView();
    this.show();
    void (async () => {
      const { sniffLocalDsh } = await import('./sniffer');
      const { loadSharedConfig } = await import('./shared-config');
      const list = await sniffLocalDsh(loadSharedConfig().url);
      this.send('login:sniff-result', list);
    })();
  }

  // —— 推送 / 工具 ——

  send(channel: string, payload?: unknown): void {
    if (this.destroyedWindow) return;
    this.window.webContents.send(channel, payload);
  }

  sendConnectionState(): void {
    this.send('shell:connection-changed', {
      connected: this.connectedUrl !== null,
      url: this.displayUrl(),
      owned: this.isOwnedConnection(),
    });
  }

  sendConnectionsResult(): void {
    // 附上代理展示文案：渲染层不做格式化（与主进程同一套纯函数）。
    const list = this.host.connections().map((c) => ({
      ...c,
      proxyLabel: c.proxy ? describeProxyConfig(c.proxy) : '',
    }));
    this.send('login:connections-result', list);
  }

  showLoginError(msg: string): void {
    this.send('login:result', { ok: false, error: msg });
  }

  private pushUiState(): void {
    if (this.destroyedWindow) return;
    pushShellUiState(this.window.webContents, {
      connectedUrl: this.displayUrl(),
      owned: this.isOwnedConnection(),
      maximized: this.window.isMaximized(),
      alwaysOnTop: this.alwaysOnTop,
      findBarVisible: this.findBarOpen,
      settingsVisible: this.settingsOpen,
      paletteVisible: this.paletteOpen,
      dnd: this.host.dndEnabled(),
      phase: this.phase,
    });
  }

  private pushShortcutsState(): void {
    if (this.destroyedWindow) return;
    const s = this.host.shortcuts();
    this.send('shell:shortcuts-state', {
      bindings: s.bindings,
      actions: SHORTCUT_ACTIONS,
      meta: SHORTCUT_META,
      conflicts: findShortcutConflicts(s.bindings),
      envOverride: s.envOverride,
      isMac: process.platform === 'darwin',
    });
  }

  private normalizeRawKeyEvent(raw: unknown): RawKeyEvent | null {
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

  /** 主动销毁（应用退出时调用；之后 closed 事件里会做清理）。 */
  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.boundsSaveTimer) {
      clearTimeout(this.boundsSaveTimer);
      this.boundsSaveTimer = null;
    }
    if (!this.window.isDestroyed()) this.window.destroy();
  }

  // —— 窗口级 IPC ——
  //
  // 应用生命周期内只注册一批监听器（不是每会话注册）：ipcMain.handle 对同一
  // 通道注册两次会直接 throw（v1.0.0 事故——注册放在每会话路径后，启动恢复
  // ≥2 个窗口必崩），ipcMain.on 的重复监听器还会随窗口开关不断累积。
  // 路由按 event.sender 找属主会话，sender 校验语义与旧的 guard 等价。
  private static registerIpcOnce(host: SessionHost): void {
    if (Session.sessionIpcRegistered) return;
    Session.sessionIpcRegistered = true;
    const owner = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): Session | null =>
      host.sessionForSender(event.sender);

    // 窗口控制
    ipcMainOn('shell:minimize', (e) => {
      owner(e)?.window.minimize();
    });
    ipcMainOn('shell:toggle-maximize', (e) => {
      const s = owner(e);
      if (!s) return;
      if (s.window.isMaximized()) s.window.unmaximize();
      else s.window.maximize();
    });
    ipcMainOn('shell:close', (e) => {
      owner(e)?.window.close();
    });
    ipcMainOn('shell:toggle-always-on-top', (e) => {
      const s = owner(e);
      if (s) s.setAlwaysOnTop(!s.alwaysOnTop);
    });

    // login：嗅探 / 启动本地服务 / 连接 / 最近连接 / 配置库
    ipcMainOn('login:sniff', (e) => {
      const s = owner(e);
      if (!s) return;
      void (async () => {
        const { sniffLocalDsh } = await import('./sniffer');
        const { loadSharedConfig } = await import('./shared-config');
        s.send('login:sniff-result', await sniffLocalDsh(loadSharedConfig().url));
      })();
    });
    ipcMainOn('login:start-local', (e, port: unknown) => {
      const s = owner(e);
      if (!s) return;
      const normalized = normalizeRequestedPort(port);
      if (normalized === null) {
        s.showLoginError('端口无效：请输入 1-65535 之间的整数');
        return;
      }
      void s.host.startLocalService(s, normalized);
    });
    ipcMainOn('login:join-remote', (e, rawUrl: unknown) => {
      const s = owner(e);
      if (!s) return;
      void s.joinRemoteUrl(typeof rawUrl === 'string' ? rawUrl : '');
    });
    ipcMainOn('login:recent', (e) => {
      const s = owner(e);
      if (s) s.send('login:recent-result', s.host.recentUrls());
    });
    ipcMainOn('login:connections', (e) => {
      const s = owner(e);
      if (s) s.sendConnectionsResult();
    });
    ipcMainOn('login:remove-recent', (e, rawUrl: unknown) => {
      const s = owner(e);
      if (!s) return;
      const url = typeof rawUrl === 'string' ? rawUrl : '';
      if (!url) return;
      s.host.forgetRecent(url);
      s.send('login:recent-result', s.host.recentUrls());
    });
    ipcMainOn('login:clear-recent', (e) => {
      const s = owner(e);
      if (!s) return;
      s.host.clearRecent();
      s.send('login:recent-result', s.host.recentUrls());
    });
    ipcMainOn('login:remove-connection', (e, id: unknown) => {
      const s = owner(e);
      if (!s || typeof id !== 'string') return;
      s.host.removeConnection(id);
      s.sendConnectionsResult();
      s.send('login:recent-result', s.host.recentUrls());
    });
    ipcMainOn('login:rename-connection', (e, id: unknown, name: unknown) => {
      const s = owner(e);
      if (!s || typeof id !== 'string' || typeof name !== 'string') return;
      s.host.renameConnection(id, name);
      s.sendConnectionsResult();
    });
    ipcMainOn('login:pin-connection', (e, id: unknown) => {
      const s = owner(e);
      if (!s || typeof id !== 'string') return;
      s.host.pinConnection(id);
      s.sendConnectionsResult();
    });
    ipcMainOn('login:set-proxy', (e, id: unknown, raw: unknown) => {
      const s = owner(e);
      if (!s || typeof id !== 'string') return;
      s.host.setConnectionProxy(id, raw);
      s.sendConnectionsResult();
    });

    // 断开
    ipcMainOn('shell:disconnect', (e) => {
      const s = owner(e);
      if (s) s.disconnect();
    });
    ipcMainOn('shell:disconnect-stop', (e) => {
      const s = owner(e);
      if (s) s.disconnectAndStop();
    });

    // 页面内查找
    ipcMainOn('shell:find', (e, text: unknown) => {
      const s = owner(e);
      if (!s || !s.contentView) return;
      s.lastFindText = typeof text === 'string' ? text : '';
      if (s.lastFindText === '') {
        s.contentView.webContents.stopFindInPage('clearSelection');
        s.send('shell:find-result', '');
        return;
      }
      s.contentView.webContents.findInPage(s.lastFindText, { forward: true });
    });
    ipcMainOn('shell:find-next', (e, dir: unknown) => {
      const s = owner(e);
      if (!s || !s.contentView || s.lastFindText === '') return;
      s.contentView.webContents.findInPage(s.lastFindText, { forward: dir !== -1, findNext: true });
    });
    ipcMainOn('shell:find-close', (e) => {
      const s = owner(e);
      if (s) s.closeFindBar();
    });

    // 标题栏下拉菜单
    ipcMainOn('shell:open-titlebar-menu', (e, name: unknown, anchor: unknown) => {
      const s = owner(e);
      if (!s || !isTitlebarMenuName(name)) return;
      if (!anchor || typeof anchor !== 'object') return;
      const r = anchor as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
      if (
        typeof r.x !== 'number' ||
        typeof r.y !== 'number' ||
        typeof r.width !== 'number' ||
        typeof r.height !== 'number' ||
        ![r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n))
      ) {
        return;
      }
      s.openTitlebarMenu(name, { x: r.x, y: r.y, width: r.width, height: r.height });
    });

    // 快捷键设置面板
    ipcMainHandle('shell:shortcuts-get', (e) => {
      const s = owner(e);
      if (!s) return null;
      s.pushShortcutsState();
      return true;
    });
    ipcMainHandle('shell:shortcuts-record', (e, action: unknown, raw: unknown) => {
      const s = owner(e);
      if (!s || !isShortcutAction(action)) return { ok: false, error: '无效动作' };
      const ev = s.normalizeRawKeyEvent(raw);
      if (ev === null) return { ok: false, error: '无效按键事件' };
      const outcome = recordingOutcome(ev);
      if (outcome.kind === 'pending') return { ok: true, pending: true };
      if (outcome.kind === 'cancel') return { ok: true, cancelled: true };
      if (outcome.kind === 'clear') {
        s.host.setShortcut(action, null);
        s.pushShortcutsState();
        return { ok: true, cleared: true };
      }
      if (outcome.kind === 'invalid') return { ok: false, error: outcome.reason };
      const others = conflictsFor(action, outcome.accelerator, s.host.shortcuts().bindings);
      if (others.length > 0) {
        const names = others.map((a) => SHORTCUT_META[a].label).join('、');
        return { ok: false, error: `与「${names}」的快捷键冲突` };
      }
      s.host.setShortcut(action, outcome.accelerator);
      s.pushShortcutsState();
      return { ok: true };
    });
    ipcMainHandle('shell:shortcuts-reset', (e, scope: unknown) => {
      const s = owner(e);
      if (!s) return { ok: false, error: '无效请求' };
      if (scope === 'all') {
        s.host.resetShortcut('all');
        s.pushShortcutsState();
        return { ok: true };
      }
      if (!isShortcutAction(scope)) return { ok: false, error: '无效动作' };
      s.host.resetShortcut(scope);
      s.pushShortcutsState();
      return { ok: true };
    });
    ipcMainOn('shell:settings-close', (e) => {
      const s = owner(e);
      if (s) s.closeSettings();
    });
    ipcMainHandle('shell:dnd-schedule-get', (e) => {
      const s = owner(e);
      if (!s) return null;
      return s.host.dndSchedule();
    });
    ipcMainOn('shell:dnd-schedule-set', (e, raw: unknown) => {
      const s = owner(e);
      if (!s) return;
      s.host.setDndSchedule(raw);
    });

    // 命令面板
    ipcMainOn('shell:palette-run', (e, id: unknown) => {
      const s = owner(e);
      if (!s || typeof id !== 'string') return;
      if (!s.paletteModel.some((en) => en.id === id)) return;
      s.closePalette();
      s.runPaletteAction(id);
    });
    ipcMainOn('shell:palette-close', (e) => {
      const s = owner(e);
      if (s) s.closePalette();
    });
  }

  /** 窗口级 IPC 路由用：该 sender 是否本会话窗口。 */
  ownsSender(sender: Electron.WebContents): boolean {
    return !this.destroyedWindow && this.window.webContents === sender;
  }
}

// ipcMain 的薄封装：集中在这里，便于将来收口频道表（本轮不做频道名重构）。
function ipcMainOn(channel: string, listener: (e: Electron.IpcMainEvent, ...args: unknown[]) => void): void {
  ipcMain.on(channel, listener);
}
function ipcMainHandle(
  channel: string,
  listener: (e: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
): void {
  ipcMain.handle(channel, listener);
}

function safeOrigin(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

// 供 main.ts 复用的默认快捷键表（重置逻辑在应用层）。
export { DEFAULT_SHORTCUTS, serializeShortcutBindings };
