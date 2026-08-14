import { describe, expect, it } from 'vitest';
import { mergeRecentServers, sanitizeBounds, type WindowBounds } from './shell-state';

const DISPLAYS = [
  { x: 0, y: 0, width: 1920, height: 1080 },
  { x: 1920, y: 0, width: 1280, height: 1024 },
];

describe('mergeRecentServers', () => {
  it('新地址排最前', () => {
    expect(mergeRecentServers(['http://a/', 'http://b/'], 'http://c/')).toEqual([
      'http://c/',
      'http://a/',
      'http://b/',
    ]);
  });

  it('重复地址去重并提前', () => {
    expect(mergeRecentServers(['http://a/', 'http://b/'], 'http://a/')).toEqual([
      'http://a/',
      'http://b/',
    ]);
  });

  it('空历史也能追加', () => {
    expect(mergeRecentServers(undefined, 'http://a/')).toEqual(['http://a/']);
  });

  it('超过上限时裁剪最旧', () => {
    const prev = ['http://1/', 'http://2/', 'http://3/', 'http://4/'];
    expect(mergeRecentServers(prev, 'http://5/', 5)).toEqual([
      'http://5/',
      'http://1/',
      'http://2/',
      'http://3/',
      'http://4/',
    ]);
  });
});

describe('sanitizeBounds', () => {
  const inBounds: WindowBounds = { x: 100, y: 100, width: 1200, height: 800 };

  it('在主显示器工作区内的 bounds 保留', () => {
    expect(sanitizeBounds(inBounds, DISPLAYS)).toEqual(inBounds);
  });

  it('位于副显示器工作区内的 bounds 保留', () => {
    expect(sanitizeBounds({ x: 2000, y: 50, width: 1000, height: 700 }, DISPLAYS)).toEqual({
      x: 2000,
      y: 50,
      width: 1000,
      height: 700,
    });
  });

  it('完全落在屏幕外的 bounds 丢弃', () => {
    expect(sanitizeBounds({ x: 99999, y: 99999, width: 800, height: 600 }, DISPLAYS)).toBeNull();
  });

  it('过小窗口丢弃（防坏数据）', () => {
    expect(sanitizeBounds({ x: 0, y: 0, width: 50, height: 50 }, DISPLAYS)).toBeNull();
  });

  it('非有限数值丢弃', () => {
    expect(sanitizeBounds({ x: NaN, y: 0, width: 800, height: 600 }, DISPLAYS)).toBeNull();
    expect(sanitizeBounds(undefined, DISPLAYS)).toBeNull();
  });

  it('无显示器信息时丢弃（无法验证可见性）', () => {
    expect(sanitizeBounds(inBounds, [])).toBeNull();
  });
});
