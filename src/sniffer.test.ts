import { describe, it, expect } from 'vitest';
import { looksLikeDshIndex, looksLikeDshFavicon } from './sniffer';

describe('looksLikeDshIndex', () => {
  it('识别包含 manifest.webmanifest 的 DSH index.html', () => {
    expect(looksLikeDshIndex('<html><head><link rel="manifest" href="manifest.webmanifest"></head></html>')).toBe(true);
  });

  it('识别标题含 DeepSeek Harness 的页面', () => {
    expect(looksLikeDshIndex('<html><title>DeepSeek Harness</title></html>')).toBe(true);
  });

  it('拒绝无关页面', () => {
    expect(looksLikeDshIndex('<html><title>Hello World</title></html>')).toBe(false);
  });

  it('拒绝空字符串', () => {
    expect(looksLikeDshIndex('')).toBe(false);
  });
});

describe('looksLikeDshFavicon', () => {
  it('识别官方鲸鱼 favicon(独特 path 坐标)', () => {
    expect(looksLikeDshFavicon('<svg viewBox="0 0 50 50"><path d="M48.8354 10.0479C48.3232 9.79199"></svg>')).toBe(true);
  });

  it('拒绝其他 svg', () => {
    expect(looksLikeDshFavicon('<svg><path d="M0 0 L10 10"></svg>')).toBe(false);
  });

  it('拒绝空字符串', () => {
    expect(looksLikeDshFavicon('')).toBe(false);
  });
});
