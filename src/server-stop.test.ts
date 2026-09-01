import { describe, it, expect } from 'vitest';
import { parseNetstatPids, parseLsofPids } from './server-stop';

describe('parseNetstatPids', () => {
  const sample = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       4212',
    '  TCP    127.0.0.1:3080         127.0.0.1:55555        ESTABLISHED     4212',
    '  TCP    [::1]:3080             [::]:0                 LISTENING       4212',
    '  TCP    0.0.0.0:3080           0.0.0.0:0              LISTENING       9080',
    '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       512',
    '  UDP    127.0.0.1:3080         *:*                                    4212',
  ].join('\r\n');

  it('匹配 LISTENING 行（IPv4/IPv6/0.0.0.0），去重', () => {
    expect(parseNetstatPids(sample, 3080)).toEqual([4212, 9080]);
  });

  it('端口不匹配的行被忽略', () => {
    expect(parseNetstatPids(sample, 5173)).toEqual([512]);
    expect(parseNetstatPids(sample, 9999)).toEqual([]);
  });

  it('非 LISTENING 状态（ESTABLISHED）与 UDP 行被忽略', () => {
    // 3080 只剩 LISTENING 的两行；ESTABLISHED 的 4212 不重复计入
    const pids = parseNetstatPids(sample, 3080);
    expect(pids).toContain(4212);
    expect(pids.filter((p) => p === 4212)).toHaveLength(1);
  });

  it('系统进程 PID（≤4）与畸形行被排除', () => {
    const out = [
      '  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    4',
      '  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    0',
      '  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    abc',
      'garbage line',
    ].join('\r\n');
    expect(parseNetstatPids(out, 3080)).toEqual([]);
  });

  it('IPv6 带方括号地址按最后一个冒号切端口', () => {
    const out = '  TCP    [::1]:8080    [::]:0    LISTENING    777';
    expect(parseNetstatPids(out, 8080)).toEqual([777]);
    expect(parseNetstatPids(out, 1)).toEqual([]); // 不能把 :1 当端口
  });
});

describe('parseLsofPids', () => {
  it('每行一个 PID，忽略非数字与畸形', () => {
    expect(parseLsofPids('4212\n9080\n\nnotapid\n0\n1\n-1\n')).toEqual([4212, 9080]);
  });

  it('去重', () => {
    expect(parseLsofPids('4212\n4212\n')).toEqual([4212]);
  });

  it('空输出', () => {
    expect(parseLsofPids('')).toEqual([]);
  });
});
