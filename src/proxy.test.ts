import { describe, expect, it } from 'vitest';
import {
  describeProxyConfig,
  normalizeProxyConfig,
  parseBypassList,
  proxyToElectronRules,
} from './proxy';

describe('normalizeProxyConfig — 合法输入', () => {
  it('接受 http / https / socks / socks4 / socks5（必须带端口）', () => {
    expect(normalizeProxyConfig('http://127.0.0.1:7890')).toEqual({
      mode: 'http',
      url: 'http://127.0.0.1:7890',
      bypass: [],
    });
    expect(normalizeProxyConfig('https://proxy.local:8443')?.mode).toBe('http');
    expect(normalizeProxyConfig('socks://127.0.0.1:1080')?.mode).toBe('socks');
    expect(normalizeProxyConfig('socks4://127.0.0.1:1080')?.mode).toBe('socks');
    expect(normalizeProxyConfig('socks5://127.0.0.1:7897')?.mode).toBe('socks');
  });

  it('归一化大小写与尾斜杠，去掉无意义路径', () => {
    expect(normalizeProxyConfig('HTTP://LOCALHOST:7890/')?.url).toBe('http://localhost:7890');
    expect(normalizeProxyConfig('socks5://127.0.0.1:7897')?.url).toBe('socks5://127.0.0.1:7897');
  });

  it('对象形态：url + bypass 字符串/数组都接受', () => {
    expect(normalizeProxyConfig({ url: 'socks5://127.0.0.1:7897', bypass: 'a.com, b.com' })?.bypass).toEqual([
      'a.com',
      'b.com',
    ]);
    expect(normalizeProxyConfig({ url: 'socks5://127.0.0.1:7897', bypass: ['A.com', 'a.com'] })?.bypass).toEqual([
      'a.com',
    ]);
  });

  it("'direct' / 'none' / 'off' / 空串 = 显式直连", () => {
    for (const word of ['direct', 'none', 'off', 'DIRECT', '']) {
      const cfg = normalizeProxyConfig(word);
      expect(cfg?.mode).toBe('direct');
      expect(cfg?.url).toBe('');
    }
    expect(normalizeProxyConfig({ mode: 'direct', bypass: 'x.com' })?.bypass).toEqual(['x.com']);
  });
});

describe('normalizeProxyConfig — 拒绝非法输入', () => {
  it('缺少端口 → null（绝不猜默认端口）', () => {
    expect(normalizeProxyConfig('http://127.0.0.1')).toBeNull();
    expect(normalizeProxyConfig('socks5://proxy.local')).toBeNull();
  });

  it('内嵌凭据 → null（配置以明文 JSON 落盘）', () => {
    expect(normalizeProxyConfig('http://user:pass@127.0.0.1:7890')).toBeNull();
    expect(normalizeProxyConfig('http://user@127.0.0.1:7890')).toBeNull();
  });

  it('非代理 scheme → null', () => {
    expect(normalizeProxyConfig('ftp://127.0.0.1:21')).toBeNull();
    expect(normalizeProxyConfig('file:///tmp/x')).toBeNull();
    expect(normalizeProxyConfig('javascript:alert(1)')).toBeNull();
  });

  it('带路径/查询/哈希 → null', () => {
    expect(normalizeProxyConfig('http://127.0.0.1:7890/pac')).toBeNull();
    expect(normalizeProxyConfig('http://127.0.0.1:7890/?x=1')).toBeNull();
    expect(normalizeProxyConfig('http://127.0.0.1:7890/#f')).toBeNull();
  });

  it('端口越界 → null', () => {
    expect(normalizeProxyConfig('http://127.0.0.1:0')).toBeNull();
    expect(normalizeProxyConfig('http://127.0.0.1:65536')).toBeNull();
  });

  it('非法类型/垃圾字符串 → null（不抛异常）', () => {
    expect(normalizeProxyConfig(null)).toBeNull();
    expect(normalizeProxyConfig(undefined)).toBeNull();
    expect(normalizeProxyConfig(42)).toBeNull();
    expect(normalizeProxyConfig([])).toBeNull();
    expect(normalizeProxyConfig({})).toBeNull();
    expect(normalizeProxyConfig({ url: '' })).toBeNull();
    expect(normalizeProxyConfig('not a url')).toBeNull();
  });
});

describe('parseBypassList', () => {
  it('按逗号/分号/换行/空白切分、trim、小写、去重、保序', () => {
    expect(parseBypassList('a.com, b.com;c.com\nd.com  a.com')).toEqual(['a.com', 'b.com', 'c.com', 'd.com']);
  });

  it('空输入/非字符串 → 空数组', () => {
    expect(parseBypassList('')).toEqual([]);
    expect(parseBypassList('   ,  ;  ')).toEqual([]);
    expect(parseBypassList(undefined as unknown as string)).toEqual([]);
  });
});

describe('describeProxyConfig', () => {
  it('三种模式各有可读文案', () => {
    expect(describeProxyConfig({ mode: 'direct', url: '', bypass: [] })).toBe('直连（不使用代理）');
    expect(describeProxyConfig({ mode: 'http', url: 'http://127.0.0.1:7890', bypass: [] })).toBe('HTTP 127.0.0.1:7890');
    expect(describeProxyConfig({ mode: 'socks', url: 'socks5://127.0.0.1:7897', bypass: [] })).toBe(
      'SOCKS 127.0.0.1:7897',
    );
  });

  it('有绕过列表时带条数', () => {
    expect(
      describeProxyConfig({ mode: 'socks', url: 'socks5://127.0.0.1:7897', bypass: ['a.com', 'b.com'] }),
    ).toBe('SOCKS 127.0.0.1:7897（绕过 2 条）');
  });
});

describe('proxyToElectronRules', () => {
  it('http/socks → fixed_servers + 绕过规则（空则不传字段）', () => {
    expect(proxyToElectronRules({ mode: 'socks', url: 'socks5://127.0.0.1:7897', bypass: [] })).toEqual({
      proxyRules: 'socks5://127.0.0.1:7897',
      mode: 'fixed_servers',
    });
    expect(proxyToElectronRules({ mode: 'http', url: 'http://127.0.0.1:7890', bypass: ['a.com', 'b.com'] })).toEqual({
      proxyRules: 'http://127.0.0.1:7890',
      proxyBypassRules: 'a.com;b.com',
      mode: 'fixed_servers',
    });
  });

  it('direct → direct 模式，不带绕过规则', () => {
    expect(proxyToElectronRules({ mode: 'direct', url: '', bypass: ['x.com'] })).toEqual({
      proxyRules: 'direct://',
      mode: 'direct',
    });
  });
});
