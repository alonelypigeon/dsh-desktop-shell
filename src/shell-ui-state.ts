// shell 页面 UI 状态的统一推送 —— main.ts 与 UI 冒烟测试共用。
//
// 为什么需要它：connectTo 对本机服务几毫秒即可完成，attachContentView 推送的
// login:visible / connection-changed / maximize-changed 可能在渲染器加载
// shell.js（注册监听器）之前发出，Electron 对无监听者的消息是静默丢弃 → 标题栏
// 连接状态永远不显示（本机连接必现的竞态）。
// 解法：页面每次 did-finish-load 后重发全部 UI 状态，使其自愈（也覆盖 reload）。
import type { WebContents } from 'electron';

export interface ShellUiState {
  /** 当前连接的服务器地址；null = 未连接（显示 login）。 */
  connectedUrl: string | null;
  /** 当前连接是否为本应用启动的本地服务。 */
  owned: boolean;
  /** 窗口是否最大化（标题栏还原图标状态）。 */
  maximized: boolean;
  /** 窗口是否置顶（标题栏置顶按钮激活态）。 */
  alwaysOnTop: boolean;
  /** 页面内查找栏是否打开（未连接恒为 false）。 */
  findBarVisible?: boolean;
  /** 快捷键设置面板是否打开（打开期间 DSH 内容视图临时摘下）。 */
  settingsVisible?: boolean;
  /** 命令面板是否打开（打开期间 DSH 内容视图临时摘下）。 */
  paletteVisible?: boolean;
  /** 勿扰模式是否开启（标题栏指示 + 通知门控）。 */
  dnd?: boolean;
  /** 连接阶段（断线重连中状态点变黄）。 */
  phase?: 'connected' | 'reconnecting';
}

export function pushShellUiState(wc: WebContents, s: ShellUiState): void {
  if (wc.isDestroyed()) return;
  wc.send('login:visible', s.connectedUrl === null);
  wc.send('shell:maximize-changed', s.maximized);
  wc.send('shell:alwayson-changed', s.alwaysOnTop);
  wc.send('shell:connection-changed', {
    connected: s.connectedUrl !== null,
    url: s.connectedUrl,
    owned: s.owned,
  });
  wc.send('shell:find-visible', s.findBarVisible === true);
  wc.send('shell:settings-visible', s.settingsVisible === true);
  wc.send('shell:palette-visible', s.paletteVisible === true);
  wc.send('shell:dnd-changed', s.dnd === true);
  if (s.phase) wc.send('shell:phase-changed', s.phase);
}
