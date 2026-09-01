// 命令面板（Ctrl+K）的动作清单构建 —— 纯函数，可单测。
//
// 主进程按当前状态生成快照下发给渲染层（shell:palette-model），渲染层本地
// 过滤/键盘导航；执行时渲染层只回传快照里的 id（shell:palette-run），主进程
// 校验 id 存在于当前快照后才分发——渲染层无法注入任意命令。
import { zoomPercent, ZOOM_DEFAULT } from './view-controls';

export type PaletteGroupId = '连接' | '视图' | '应用';

export interface PaletteEntry {
  /** 稳定动作 id（connect:<n> 为最近连接下标）。 */
  id: string;
  /** 显示名（过滤与匹配的文本）。 */
  label: string;
  /** 右侧补充说明（当前缩放 / 「最近」标记等）。 */
  hint?: string;
  group: PaletteGroupId;
}

export interface PaletteState {
  connectedUrl: string | null;
  ownedRunning: boolean;
  recentServers: string[];
  dnd: boolean;
  alwaysOnTop: boolean;
  zoomFactor: number;
}

export function buildPaletteEntries(state: PaletteState): PaletteEntry[] {
  const entries: PaletteEntry[] = [];

  state.recentServers.slice(0, 5).forEach((url, i) => {
    entries.push({ id: `connect:${i}`, label: `连接 ${url}`, group: '连接', hint: i === 0 ? '最近' : undefined });
  });
  entries.push({ id: 'switch-server', label: '切换服务器…', group: '连接' });
  entries.push(
    state.ownedRunning
      ? { id: 'stop-local', label: '停止本地 DSH 服务', group: '连接' }
      : { id: 'start-local', label: '启动本地 DSH 服务…', group: '连接' },
  );
  if (state.connectedUrl !== null) {
    entries.push({ id: 'disconnect', label: '断开连接', group: '连接' });
  }

  if (state.connectedUrl !== null) {
    entries.push({ id: 'reload', label: '重新加载页面', group: '视图' });
    entries.push({ id: 'reload-hard', label: '强制重新加载（忽略缓存）', group: '视图' });
    entries.push({ id: 'find', label: '页面内查找', group: '视图' });
  }
  const pct = zoomPercent(state.zoomFactor ?? ZOOM_DEFAULT);
  entries.push({ id: 'zoom-in', label: '放大页面', hint: `当前 ${pct}%`, group: '视图' });
  entries.push({ id: 'zoom-out', label: '缩小页面', hint: `当前 ${pct}%`, group: '视图' });
  entries.push({ id: 'zoom-reset', label: '重置缩放为 100%', group: '视图' });
  entries.push({
    id: 'toggle-ontop',
    label: state.alwaysOnTop ? '取消窗口置顶' : '窗口置顶',
    group: '视图',
  });

  entries.push({ id: 'check-updates', label: '检查更新…', group: '应用' });
  entries.push({ id: 'shortcuts', label: '快捷键设置…', group: '应用' });
  entries.push({
    id: 'dnd',
    label: state.dnd ? '关闭勿扰模式' : '开启勿扰模式（静默通知）',
    group: '应用',
  });
  entries.push({ id: 'quit', label: '退出', group: '应用' });
  return entries;
}
