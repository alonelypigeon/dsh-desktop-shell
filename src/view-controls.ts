// 内容视图（DSH 页面）的缩放档位 / 查找计数 —— 纯函数，可单测。
// 快捷键的识别与自定义绑定见 shortcuts.ts（缩放/查找/重载均为可绑定动作）。
//
// 缩放档位沿用 Chromium 默认级别（截取 0.5–2 一段），持久化在 shell-state.json。

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_DEFAULT = 1;
export const ZOOM_STEPS: readonly number[] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const EPS = 1e-9;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// 相邻档位步进；current 落在档位之间时取 dir 方向的下一档，到头返回边界档。
export function stepZoom(current: number, dir: 'in' | 'out'): number {
  const cur = Number.isFinite(current) ? clamp(current, ZOOM_MIN, ZOOM_MAX) : ZOOM_DEFAULT;
  if (dir === 'in') {
    for (const s of ZOOM_STEPS) {
      if (s > cur + EPS) return s;
    }
    return ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const s = ZOOM_STEPS[i];
    if (s < cur - EPS) return s;
  }
  return ZOOM_STEPS[0];
}

// 从持久化恢复缩放：非有限数值回默认，越界收拢到边界。
export function normalizeZoom(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ZOOM_DEFAULT;
  return clamp(v, ZOOM_MIN, ZOOM_MAX);
}

export function zoomPercent(z: number): number {
  return Math.round(z * 100);
}

// 查找栏的计数文案：'3/17'；无结果时「无结果」。
export function formatFindCount(active: number, matches: number): string {
  if (typeof matches !== 'number' || !Number.isFinite(matches) || matches <= 0) return '无结果';
  const a = typeof active === 'number' && Number.isFinite(active) ? Math.round(active) : 0;
  return `${Math.max(1, a)}/${Math.round(matches)}`;
}
