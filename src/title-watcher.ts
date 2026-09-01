// 从 DSH 页面标题解析未读计数 —— 纯函数，可单测。
//
// 零注入约束下，页面标题是壳层能拿到的最可靠「代理需要你」信号：会话型
// Web 应用（含 dsh web）普遍用 "(n)" 前缀标记未读，Electron 的
// page-title-updated 事件无需向页面注入任何脚本即可观察到它。
const COUNT_PREFIX = /^[（(]\s*(\d+)\s*[)）]/;

// "(2) 新消息" → 2；无前缀 / (0) / 非数字 → null。计数上限 999（角标图只到 99+）。
export function parseTitleCount(title: string): number | null {
  if (typeof title !== 'string') return null;
  const m = title.trim().match(COUNT_PREFIX);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  return Math.min(n, 999);
}
