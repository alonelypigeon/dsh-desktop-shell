import { describe, expect, it } from 'vitest';
import { parseTitleCount } from './title-watcher';

describe('parseTitleCount', () => {
  it('识别 "(n)" 前缀（半角/全角括号、内部空格）', () => {
    expect(parseTitleCount('(1) 新消息')).toBe(1);
    expect(parseTitleCount('(12) DeepSeek Harness')).toBe(12);
    expect(parseTitleCount('（3）会话')).toBe(3);
    expect(parseTitleCount('( 42 ) x')).toBe(42);
  });

  it('无前缀 / (0) / 非数字 / 前缀不在开头 → null', () => {
    expect(parseTitleCount('普通标题')).toBeNull();
    expect(parseTitleCount('(0) 已读')).toBeNull();
    expect(parseTitleCount('() x')).toBeNull();
    expect(parseTitleCount('回复 (2) 话题')).toBeNull();
    expect(parseTitleCount('1) x')).toBeNull();
  });

  it('超大计数收敛到 999（角标图上限 99+，通知里仍显示真实值由调用方持有）', () => {
    expect(parseTitleCount('(1234) 群消息')).toBe(999);
    expect(parseTitleCount('(99) x')).toBe(99);
    expect(parseTitleCount('(100) x')).toBe(100);
  });

  it('非字符串输入返回 null', () => {
    expect(parseTitleCount(null as unknown as string)).toBeNull();
    expect(parseTitleCount(undefined as unknown as string)).toBeNull();
  });
});
