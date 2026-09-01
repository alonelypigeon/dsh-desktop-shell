import { describe, it, expect } from 'vitest';
import { parseCliUrl, validateUrl, pickUrl, isLoopbackHost } from './url';

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

  it('剥离 URL 内嵌凭据（user:pass@host 不应明文落盘）', () => {
    expect(validateUrl('http://user:pass@127.0.0.1:3080/')).toBe('http://127.0.0.1:3080/');
    expect(validateUrl('https://admin@example.com/')).toBe('https://example.com/');
    expect(validateUrl('http://:secret@localhost:3080')).toBe('http://localhost:3080/');
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

describe('isLoopbackHost', () => {
  it('识别 127.0.0.1 与整个 127.0.0.0/8 段', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.99')).toBe(true);
    expect(isLoopbackHost('127.255.255.254')).toBe(true);
  });

  it('识别 localhost（大小写不敏感）', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
  });

  it('识别 IPv6 回环（WHATWG URL 的 hostname 带方括号）', () => {
    // new URL('http://[::1]:3080/').hostname === '[::1]' —— 必须剥括号后比较
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::ffff:127.0.0.1]')).toBe(true);
  });

  it('拒绝非回环地址', () => {
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('[::2]')).toBe(false);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
  });
});
