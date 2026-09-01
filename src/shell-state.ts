// 外壳自身的本地状态（与 DSH/cordis 共享配置分离，互不干扰）：
//   - 窗口 bounds / 置顶：记忆上次窗口位置与置顶状态
//   - recentServers：最近连接过的服务器地址（login 界面展示，快速重连）
//   - zoomFactor / shortcuts：内容视图缩放与快捷键绑定（见 view-controls.ts / shortcuts.ts）
// 纯函数化设计：不 import electron，路径由调用方传入，便于 node:test 直接测试。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeZoom } from './view-controls';
import { validateUrl } from './url';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShellState {
  bounds?: WindowBounds;
  alwaysOnTop?: boolean;
  recentServers?: string[];
  /** 命名连接配置库（v0.7；旧 recentServers 自动迁移到该字段）。 */
  connections?: SavedConnection[];
  /** 上次退出时窗口是否最大化（重启时恢复；bounds 始终存普通态尺寸）。 */
  maximized?: boolean;
  /** 内容视图缩放系数（加载时经 normalizeZoom 规整到 0.5–2）。 */
  zoomFactor?: number;
  /** 快捷键绑定（action → 加速器；'' = 显式解绑；格式校验见 shortcuts.ts）。 */
  shortcuts?: Record<string, string>;
  /** 勿扰模式（静默系统通知，徽章保留）。 */
  /** 定时勿扰时段（B3：start/end 为 HH:MM，支持跨天）。 */
  dndSchedule?: DndSchedule;
  dnd?: boolean;
}

export type ConnectionKind = 'local-start' | 'sniffed' | 'remote';

export interface SavedConnection {
  id: string;
  name: string;
  url: string;
  kind: ConnectionKind;
  lastUsed?: number;
  createdAt?: number;
}

export interface DndSchedule {
  enabled: boolean;
  start: string;
  end: string;
}

const DND_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function normalizeDndSchedule(raw: unknown): DndSchedule | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.start !== 'string' || !DND_TIME_RE.test(r.start)) return null;
  if (typeof r.end !== 'string' || !DND_TIME_RE.test(r.end)) return null;
  return { enabled: r.enabled === true, start: r.start, end: r.end };
}

export function isInDndSchedule(now: Date, schedule: DndSchedule): boolean {
  if (!schedule.enabled) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = schedule.start.split(':').map(Number);
  const [eh, em] = schedule.end.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function isDndActive(dndEnabled: boolean, schedule: DndSchedule | undefined, now: Date): boolean {
  return dndEnabled || (schedule ? isInDndSchedule(now, schedule) : false);
}

export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 为连接生成稳定的短 id（纯函数，无随机/时间依赖，便于导入导出与测试）。
export function makeConnectionId(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
  }
  return `conn-${Math.abs(hash).toString(36)}`;
}

// 校验并规范化一条连接档案；非法输入返回 null。
export function normalizeSavedConnection(raw: unknown): SavedConnection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== 'string' || r.url.trim() === '') return null;
  const url = r.url.trim();
  let normalizedUrl: string;
  try {
    normalizedUrl = validateUrl(url);
  } catch {
    return null;
  }
  const kind: ConnectionKind =
    r.kind === 'local-start' || r.kind === 'sniffed' || r.kind === 'remote' ? r.kind : 'remote';
  const id = typeof r.id === 'string' && r.id.trim() !== '' ? r.id.trim() : makeConnectionId(url);
  const name = typeof r.name === 'string' && r.name.trim() !== '' ? r.name.trim() : url;
  const out: SavedConnection = { id, name, url: normalizedUrl, kind };
  if (typeof r.lastUsed === 'number' && Number.isFinite(r.lastUsed)) out.lastUsed = r.lastUsed;
  if (typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)) out.createdAt = r.createdAt;
  return out;
}

// 把旧版扁平 recentServers 迁移为命名连接档案；已有的 connections 优先保留。
export function migrateConnections(raw: {
  recentServers?: string[];
  connections?: unknown[];
}): SavedConnection[] {
  const existing: SavedConnection[] = [];
  const seenUrls = new Set<string>();
  const seenIds = new Set<string>();
  if (Array.isArray(raw.connections)) {
    for (const item of raw.connections) {
      const c = normalizeSavedConnection(item);
      if (!c || seenUrls.has(c.url) || seenIds.has(c.id)) continue;
      existing.push(c);
      seenUrls.add(c.url);
      seenIds.add(c.id);
    }
  }
  const recent = Array.isArray(raw.recentServers) ? raw.recentServers.filter((u): u is string => typeof u === 'string') : [];
  for (const url of recent) {
    if (seenUrls.has(url)) continue;
    const c = normalizeSavedConnection({ id: makeConnectionId(url), name: url, url, kind: 'remote' });
    if (!c) continue;
    existing.push(c);
    seenUrls.add(url);
    seenIds.add(c.id);
  }
  return existing;
}

// 新增/更新连接：按 URL 去重并置顶，返回新列表（上限 cap 条）。
export function mergeSavedConnection(
  prev: SavedConnection[] | undefined,
  conn: SavedConnection,
  cap = 50,
): SavedConnection[] {
  const next = [conn, ...(prev ?? []).filter((c) => c.id !== conn.id && c.url !== conn.url)];
  return next.slice(0, cap);
}

// 删除连接（按 id 或按 url 均可）。
export function removeSavedConnection(prev: SavedConnection[] | undefined, idOrUrl: string): SavedConnection[] {
  return (prev ?? []).filter((c) => c.id !== idOrUrl && c.url !== idOrUrl);
}

// 重命名连接。
export function renameSavedConnection(
  prev: SavedConnection[] | undefined,
  id: string,
  name: string,
): SavedConnection[] {
  const trimmed = name.trim();
  if (!trimmed) return prev ?? [];
  return (prev ?? []).map((c) => (c.id === id ? { ...c, name: trimmed } : c));
}

// 导出为 JSON 字符串（含版本号，便于后续格式演进）。
export function exportConnections(conns: SavedConnection[] | undefined): string {
  return JSON.stringify({
    version: 1,
    connections: (conns ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      url: c.url,
      kind: c.kind,
      ...(c.lastUsed !== undefined ? { lastUsed: c.lastUsed } : {}),
      ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}),
    })),
  }, null, 2);
}

// 解析导入 JSON（兼容直接数组或 { version, connections } 两种形态）。
export function parseConnectionsImport(raw: string): SavedConnection[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list: unknown[] = Array.isArray(data)
    ? (data as unknown[])
    : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).connections)
      ? ((data as Record<string, unknown>).connections as unknown[])
      : [];
  const out: SavedConnection[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const c = normalizeSavedConnection(item);
    if (!c || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

// 连接档案列表 → 旧版地址列表（供仍使用 recentServers 的界面/调用方使用）。
export function connectionsToRecentUrls(conns: SavedConnection[] | undefined): string[] {
  return (conns ?? []).map((c) => c.url);
}

// 校验/规范化 bounds：窗口必须与某个显示器工作区有可见交集，否则丢弃
//（多显示器拔线、分辨率变化后避免窗口落到屏幕外）。
export function sanitizeBounds(bounds: WindowBounds | undefined, displays: DisplayRect[]): WindowBounds | null {
  if (!bounds) return null;
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null;
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
  if (bounds.width < 400 || bounds.height < 300) return null;
  if (displays.length === 0) return null;

  // 窗口矩形与任一工作区重叠至少 100x80（标题栏可见）才算有效。
  const w = bounds as WindowBounds;
  const visible = displays.some((d) => {
    const ox = Math.max(0, Math.min(w.x + w.width, d.x + d.width) - Math.max(w.x, d.x));
    const oy = Math.max(0, Math.min(w.y + w.height, d.y + d.height) - Math.max(w.y, d.y));
    return ox >= 100 && oy >= 80;
  });
  return visible ? w : null;
}

// 最近服务器列表：去重、最新在前、上限 cap 条。
export function mergeRecentServers(prev: string[] | undefined, url: string, cap = 5): string[] {
  const next = [url, ...(prev ?? []).filter((u) => u !== url)];
  return next.slice(0, cap);
}

// 删除一条最近连接记录（login 界面 × 按钮）。
export function removeRecentServer(prev: string[] | undefined, url: string): string[] {
  return (prev ?? []).filter((u) => u !== url);
}

// 清空最近连接记录。
export function clearRecentServers(): string[] {
  return [];
}

export function loadShellState(file: string): ShellState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ShellState>;
    const out: ShellState = {};
    if (raw.bounds && typeof raw.bounds === 'object') {
      const b = raw.bounds as Partial<WindowBounds>;
      if (
        typeof b.x === 'number' &&
        typeof b.y === 'number' &&
        typeof b.width === 'number' &&
        typeof b.height === 'number'
      ) {
        out.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      }
    }
    if (typeof raw.alwaysOnTop === 'boolean') out.alwaysOnTop = raw.alwaysOnTop;
    if (typeof raw.maximized === 'boolean') out.maximized = raw.maximized;
    if (typeof raw.zoomFactor === 'number') out.zoomFactor = normalizeZoom(raw.zoomFactor);
    if (Array.isArray(raw.recentServers)) {
      out.recentServers = raw.recentServers.filter((u): u is string => typeof u === 'string');
    }
    if (raw.connections !== undefined || Array.isArray(raw.recentServers)) {
      out.connections = migrateConnections({
        connections: Array.isArray(raw.connections) ? raw.connections : undefined,
        recentServers: Array.isArray(raw.recentServers) ? raw.recentServers : undefined,
      });
    }
    if (raw.shortcuts && typeof raw.shortcuts === 'object' && !Array.isArray(raw.shortcuts)) {
      const sc: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.shortcuts as Record<string, unknown>)) {
        if (typeof v === 'string') sc[k] = v;
      }
      out.shortcuts = sc;
    }
    if (typeof raw.dnd === 'boolean') out.dnd = raw.dnd;
    if (raw.dndSchedule !== undefined) {
      const s = normalizeDndSchedule(raw.dndSchedule);
      if (s) out.dndSchedule = s;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveShellState(file: string, patch: Partial<ShellState>): void {
  const current = loadShellState(file);
  const next: ShellState = { ...current, ...patch };
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  // 状态文件含最近连接地址等个人信息，POSIX 上收紧为属主可读写。
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* 权限收紧失败不阻断保存 */
    }
  }
}
