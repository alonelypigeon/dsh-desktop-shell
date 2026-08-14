// 外壳自身的本地状态（与 DSH/cordis 共享配置分离，互不干扰）：
//   - 窗口 bounds / 置顶：记忆上次窗口位置与置顶状态
//   - recentServers：最近连接过的服务器地址（login 界面展示，快速重连）
// 纯函数化设计：不 import electron，路径由调用方传入，便于 node:test 直接测试。
import * as fs from 'node:fs';
import * as path from 'node:path';

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
}

export interface DisplayRect {
  x: number;
  y: number;
  width: number;
  height: number;
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
    if (Array.isArray(raw.recentServers)) {
      out.recentServers = raw.recentServers.filter((u): u is string => typeof u === 'string');
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
}
