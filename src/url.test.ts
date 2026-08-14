import { describe, it, expect } from 'vitest';
import { parseCliUrl, validateUrl, pickUrl } from './url';

describe('validateUrl', () => {
  it('接受 http URL', () => {
    expect(validateUrl('http://127.0.0.1:3080')).toBe('http://127.0.0.1:3080/');
  });

  it('接受 https URL', () => {
    expect(validateUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('规范化：自动补末尾斜杠', () => {
    expect(validateUrl('http://localhost:3080')).toBe('http://localhost:3080/');
  });

  it('拒绝 file:// 协议', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(/不支持的协议/);
  });

  it('拒绝 javascript: 协议', () => {
    expect(() => validateUrl('javascript:alert(1)')).toThrow(/不支持的协议/);
  });

  it('拒绝 smb:// 协议', () => {
    expect(() => validateUrl('smb://server/share')).toThrow(/不支持的协议/);
  });

  it('拒绝无法解析的字符串', () => {
    expect(() => validateUrl('not a url')).toThrow(/无效的地址/);
  });

  it('拒绝空字符串', () => {
    expect(() => validateUrl('')).toThrow(/无效的地址/);
  });
});

describe('parseCliUrl', () => {
  it('解析 --url 空格分隔的形式', () => {
    expect(parseCliUrl(['node', 'main.js', '--url', 'http://127.0.0.1:3080'])).toBe(
      'http://127.0.0.1:3080',
    );
  });

  it('解析 --url= 等号形式', () => {
    expect(parseCliUrl(['--url=http://127.0.0.1:8080'])).toBe('http://127.0.0.1:8080');
  });

  it('忽略 electron 自身参数，仍能找到 --url', () => {
    expect(
      parseCliUrl(['electron', '.', '--no-sandbox', '--url', 'http://127.0.0.1:3080']),
    ).toBe('http://127.0.0.1:3080');
  });

  it('无 --url 时返回 null', () => {
    expect(parseCliUrl(['electron', '.'])).toBeNull();
  });

  it('--url 后面是另一个参数时返回 null', () => {
    expect(parseCliUrl(['electron', '.', '--url', '--foo'])).toBeNull();
  });
});

describe('pickUrl', () => {
  it('cli 优先于 env 与 file', () => {
    expect(pickUrl('http://cli', 'http://env', 'http://file')).toBe('http://cli');
  });

  it('env 优先于 file', () => {
    expect(pickUrl(null, 'http://env', 'http://file')).toBe('http://env');
  });

  it('仅 file 有值时返回 file', () => {
    expect(pickUrl(null, null, 'http://file')).toBe('http://file');
  });

  it('全部为空返回 null', () => {
    expect(pickUrl(null, null, null)).toBeNull();
  });
});
