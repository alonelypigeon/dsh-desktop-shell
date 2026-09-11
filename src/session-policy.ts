// 多窗口（v1.0）的纯策略函数：窗口上限、去重键、恢复计划、未读聚合、分区名、
// 最近活跃选择、轮换。与 Electron 无关，便于单测；调用方（session.ts / main.ts）
// 只负责把真实状态喂进来。
//
// 决策来源（见 README「多窗口」与 docs/roadmap.md v1.0）：
//   - 一 URL 一窗口：重复连接同一地址只聚焦已有窗口；
//   - 最多 8 个会话窗口；启动恢复最近 5 个；
//   - 未读跨窗口求和，通知文案带连接名；
//   - 每连接独立 partition（A5 代理的前提）。
import { validateUrl } from './url';

export const MAX_SESSION_WINDOWS = 8;
export const MAX_RESTORE_WINDOWS = 5;

// 会话键：同一 DSH 地址只对应一个窗口。用规范化后的 URL 去掉尾部斜杠，
// 让 `http://127.0.0.1:3080` 与 `http://127.0.0.1:3080/` 视为同一连接。
export function sessionKeyForUrl(rawUrl: string): string {
  let normalized: string;
  try {
    normalized = validateUrl(rawUrl);
  } catch {
    // 非法地址不应进入会话表；退化为 trim 后的原串，保证键稳定可比较。
    return rawUrl.trim();
  }
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

// 会话表（不含 login 窗口）是否还能再开一个会话窗口。
export function canOpenSessionWindow(existingCount: number): boolean {
  return existingCount < MAX_SESSION_WINDOWS;
}

// 启动恢复计划：按最近使用顺序取前 cap 个合法地址，去重（同 URL 只恢复一次）。
// 非法地址直接跳过——恢复路径不能因为一条坏记录就整个失败。
export function planRestoreSessions(urls: readonly string[] | undefined, cap = MAX_RESTORE_WINDOWS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls ?? []) {
    if (typeof raw !== 'string') continue;
    let url: string;
    try {
      url = validateUrl(raw);
    } catch {
      continue;
    }
    const key = sessionKeyForUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= cap) break;
  }
  return out;
}

// 跨窗口未读求和：全部为 null（无未读）时返回 null，保持「无角标」语义。
export function aggregateUnread(counts: readonly (number | null)[]): number | null {
  let total = 0;
  let any = false;
  for (const n of counts) {
    if (n === null || !Number.isFinite(n) || n <= 0) continue;
    total += Math.trunc(n);
    any = true;
  }
  return any ? total : null;
}

// 最近活跃的会话：全局热键「唤起最近活跃窗口」用（时间戳相同则取靠前者，稳定）。
export function pickMostRecent<T extends { lastActiveAt: number }>(items: readonly T[]): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (best === null || item.lastActiveAt > best.lastActiveAt) best = item;
  }
  return best;
}

// 轮换到下一个会话（C4「切换到下一个会话」）：dir=1 向后、-1 向前，环形。
// currentId 不在列表里（窗口已关）时从列表头/尾开始。
export function cycleSession<T extends { id: string }>(
  items: readonly T[],
  currentId: string | null,
  dir: 1 | -1 = 1,
): T | null {
  if (items.length === 0) return null;
  const idx = currentId === null ? -1 : items.findIndex((s) => s.id === currentId);
  if (idx < 0) return dir === 1 ? items[0]! : items[items.length - 1]!;
  const next = (idx + dir + items.length) % items.length;
  return items[next]!;
}

// 每连接独立 session 分区名：Electron 的 partition 字符串只接受字母/数字/._-，
// 连接 id 形如 `conn-1a2b3c`，再做一次白名单过滤兜底（非法字符 → 下划线）。
export function partitionForConnection(connectionId: string): string {
  const safe = connectionId.replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
  return `persist:dsh-${safe}`;
}

// 托盘/菜单里的一条会话摘要（标题用连接名，副标题用地址）。
export interface SessionSummary {
  id: string;
  url: string;
  name: string;
  connected: boolean;
  unread: number | null;
  active: boolean;
}

// 托盘菜单文案：未读前缀 + 连接名 + 地址尾段，尽量短且可区分。
export function formatSessionMenuLabel(s: SessionSummary): string {
  const badge = s.unread !== null && s.unread > 0 ? `(${s.unread}) ` : '';
  const name = s.name && s.name !== s.url ? s.name : s.url;
  return `${badge}${name}`;
}
