import { describe, expect, it } from 'vitest';
import { stepZoom, normalizeZoom, zoomPercent, formatFindCount, ZOOM_STEPS } from './view-controls';

describe('stepZoom', () => {
  it('在档位上：向内/向外各进一档', () => {
    expect(stepZoom(1, 'in')).toBe(1.1);
    expect(stepZoom(1, 'out')).toBe(0.9);
    expect(stepZoom(0.5, 'in')).toBe(0.67);
    expect(stepZoom(2, 'out')).toBe(1.75);
  });

  it('到头后钳制在边界档（幂等）', () => {
    expect(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1], 'in')).toBe(2);
    expect(stepZoom(ZOOM_STEPS[0], 'out')).toBe(0.5);
  });

  it('落在档位之间时取方向的下一档', () => {
    expect(stepZoom(1.13, 'in')).toBe(1.25);
    expect(stepZoom(1.13, 'out')).toBe(1.1);
  });

  it('非法/越界输入先规整再步进', () => {
    expect(stepZoom(NaN, 'in')).toBe(1.1); // NaN → 默认 1 → 进一档
    expect(stepZoom(9, 'in')).toBe(2); // 超上限 → 钳到 2 → 已是最大档
    expect(stepZoom(0.1, 'out')).toBe(0.5);
  });
});

describe('normalizeZoom', () => {
  it('合法值原样返回', () => {
    expect(normalizeZoom(1)).toBe(1);
    expect(normalizeZoom(1.25)).toBe(1.25);
  });

  it('越界收拢到边界', () => {
    expect(normalizeZoom(0.1)).toBe(0.5);
    expect(normalizeZoom(5)).toBe(2);
  });

  it('非法值回默认 1', () => {
    expect(normalizeZoom(undefined)).toBe(1);
    expect(normalizeZoom('1.5')).toBe(1);
    expect(normalizeZoom(NaN)).toBe(1);
    expect(normalizeZoom(Infinity)).toBe(1);
  });
});

describe('zoomPercent', () => {
  it('换算百分比（四舍五入）', () => {
    expect(zoomPercent(1)).toBe(100);
    expect(zoomPercent(0.67)).toBe(67);
    expect(zoomPercent(1.75)).toBe(175);
  });
});

describe('formatFindCount', () => {
  it('有结果时显示 当前/总数', () => {
    expect(formatFindCount(3, 17)).toBe('3/17');
    expect(formatFindCount(1, 1)).toBe('1/1');
  });

  it('active 缺失时按 1 计', () => {
    expect(formatFindCount(0, 5)).toBe('1/5');
    expect(formatFindCount(NaN, 5)).toBe('1/5');
  });

  it('无结果显示「无结果」', () => {
    expect(formatFindCount(0, 0)).toBe('无结果');
    expect(formatFindCount(3, -1)).toBe('无结果');
    expect(formatFindCount(3, NaN)).toBe('无结果');
  });
});
