import { describe, it, expect } from 'vitest';
import { normalizeRequestedPort, buildDshWebArgs } from './dsh-launcher';

describe('normalizeRequestedPort', () => {
  it('未提供端口 → 0（随机端口）', () => {
    expect(normalizeRequestedPort(undefined)).toBe(0);
    expect(normalizeRequestedPort(null)).toBe(0);
  });

  it('空字符串 / 空白 → 0（随机端口）', () => {
    expect(normalizeRequestedPort('')).toBe(0);
    expect(normalizeRequestedPort('   ')).toBe(0);
  });

  it('显式 0 → 0（随机端口，与 --port 0 语义一致）', () => {
    expect(normalizeRequestedPort('0')).toBe(0);
    expect(normalizeRequestedPort(0)).toBe(0);
  });

  it('接受合法端口（字符串与数字）', () => {
    expect(normalizeRequestedPort('8080')).toBe(8080);
    expect(normalizeRequestedPort(8080)).toBe(8080);
    expect(normalizeRequestedPort('1')).toBe(1);
    expect(normalizeRequestedPort('65535')).toBe(65535);
    expect(normalizeRequestedPort(' 3000 ')).toBe(3000);
  });

  it('拒绝越界端口', () => {
    expect(normalizeRequestedPort('65536')).toBeNull();
    expect(normalizeRequestedPort('70000')).toBeNull();
  });

  it('拒绝非法输入', () => {
    expect(normalizeRequestedPort('abc')).toBeNull();
    expect(normalizeRequestedPort('80a')).toBeNull();
    expect(normalizeRequestedPort('-1')).toBeNull();
    expect(normalizeRequestedPort('3.14')).toBeNull();
    expect(normalizeRequestedPort('1e3')).toBeNull();
    expect(normalizeRequestedPort('  ')).toBe(0);
    expect(normalizeRequestedPort(true)).toBeNull();
    expect(normalizeRequestedPort({})).toBeNull();
    expect(normalizeRequestedPort([])).toBeNull();
  });
});

describe('buildDshWebArgs', () => {
  it('包含 --no-open，避免 dsh web 默认打开系统浏览器', () => {
    expect(buildDshWebArgs(0)).toEqual(['web', '--host', '127.0.0.1', '--port', '0', '--no-open']);
    expect(buildDshWebArgs(8080)).toContain('--no-open');
    expect(buildDshWebArgs(8080)).toContain('--port');
  });
});
