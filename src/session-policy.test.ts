import { describe, expect, it } from 'vitest';
import {
  MAX_RESTORE_WINDOWS,
  MAX_SESSION_WINDOWS,
  aggregateUnread,
  canOpenSessionWindow,
  cycleSession,
  formatSessionMenuLabel,
  partitionForConnection,
  pickMostRecent,
  planRestoreSessions,
  sessionKeyForUrl,
} from './session-policy';

describe('sessionKeyForUrl', () => {
  it('把尾斜杠归一，同一地址得到同一键', () => {
    expect(sessionKeyForUrl('http://127.0.0.1:3080')).toBe(sessionKeyForUrl('http://127.0.0.1:3080/'));
  });

  it('不同端口/路径是不同的会话', () => {
    expect(sessionKeyForUrl('http://127.0.0.1:3080')).not.toBe(sessionKeyForUrl('http://127.0.0.1:3081'));
    expect(sessionKeyForUrl('http://h/a')).not.toBe(sessionKeyForUrl('http://h/b'));
  });

  it('剥离 URL 内嵌凭据（与 validateUrl 同一策略）', () => {
    expect(sessionKeyForUrl('http://u:p@127.0.0.1:3080/')).toBe('http://127.0.0.1:3080');
  });

  it('非法地址退化为 trim 后的原串，不抛异常', () => {
    expect(sessionKeyForUrl('  not-a-url  ')).toBe('not-a-url');
  });
});

describe('canOpenSessionWindow', () => {
  it('上限之内允许，达到上限拒绝', () => {
    expect(canOpenSessionWindow(0)).toBe(true);
    expect(canOpenSessionWindow(MAX_SESSION_WINDOWS - 1)).toBe(true);
    expect(canOpenSessionWindow(MAX_SESSION_WINDOWS)).toBe(false);
    expect(canOpenSessionWindow(MAX_SESSION_WINDOWS + 3)).toBe(false);
  });
});

describe('planRestoreSessions', () => {
  it('按顺序取前 cap 个', () => {
    const urls = Array.from({ length: 9 }, (_, i) => `http://127.0.0.1:${3000 + i}`);
    expect(planRestoreSessions(urls, 3)).toEqual([
      'http://127.0.0.1:3000/',
      'http://127.0.0.1:3001/',
      'http://127.0.0.1:3002/',
    ]);
  });

  it('默认上限为 MAX_RESTORE_WINDOWS', () => {
    const urls = Array.from({ length: 9 }, (_, i) => `http://127.0.0.1:${3000 + i}`);
    expect(planRestoreSessions(urls)).toHaveLength(MAX_RESTORE_WINDOWS);
  });

  it('去重（含尾斜杠变体），跳过非法地址', () => {
    expect(
      planRestoreSessions(['http://a/', 'http://a', 'nope', 'ftp://x', 'http://b']),
    ).toEqual(['http://a/', 'http://b/']);
  });

  it('空/未定义输入返回空数组', () => {
    expect(planRestoreSessions(undefined)).toEqual([]);
    expect(planRestoreSessions([])).toEqual([]);
  });
});

describe('aggregateUnread', () => {
  it('求和；全空返回 null', () => {
    expect(aggregateUnread([1, 2, null, 3])).toBe(6);
    expect(aggregateUnread([null, null])).toBeNull();
    expect(aggregateUnread([])).toBeNull();
  });

  it('忽略 0/负数/NaN，保证不产生假角标', () => {
    expect(aggregateUnread([0, null])).toBeNull();
    expect(aggregateUnread([-5, 2])).toBe(2);
    expect(aggregateUnread([Number.NaN, 4])).toBe(4);
  });
});

describe('pickMostRecent', () => {
  it('取时间戳最大者；空列表返回 null', () => {
    const list = [
      { id: 'a', lastActiveAt: 1 },
      { id: 'b', lastActiveAt: 9 },
      { id: 'c', lastActiveAt: 5 },
    ];
    expect(pickMostRecent(list)?.id).toBe('b');
    expect(pickMostRecent([])).toBeNull();
  });

  it('时间戳相同时取靠前者（稳定）', () => {
    expect(pickMostRecent([{ id: 'a', lastActiveAt: 7 }, { id: 'b', lastActiveAt: 7 }])?.id).toBe('a');
  });
});

describe('cycleSession', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('环形向后/向前', () => {
    expect(cycleSession(list, 'a', 1)?.id).toBe('b');
    expect(cycleSession(list, 'c', 1)?.id).toBe('a');
    expect(cycleSession(list, 'a', -1)?.id).toBe('c');
  });

  it('currentId 缺失时从两端开始', () => {
    expect(cycleSession(list, null, 1)?.id).toBe('a');
    expect(cycleSession(list, null, -1)?.id).toBe('c');
    expect(cycleSession(list, 'gone', 1)?.id).toBe('a');
  });

  it('空列表返回 null', () => {
    expect(cycleSession([], 'a', 1)).toBeNull();
  });
});

describe('partitionForConnection', () => {
  it('每连接一个独立持久分区', () => {
    expect(partitionForConnection('conn-abc')).toBe('persist:dsh-conn-abc');
    expect(partitionForConnection('conn-abc')).not.toBe(partitionForConnection('conn-def'));
  });

  it('过滤非法字符，空 id 退化为 default', () => {
    expect(partitionForConnection('a/b:c')).toBe('persist:dsh-a_b_c');
    expect(partitionForConnection('')).toBe('persist:dsh-default');
  });
});

describe('formatSessionMenuLabel', () => {
  it('未读前缀 + 名称', () => {
    expect(
      formatSessionMenuLabel({ id: 'i', url: 'http://h/', name: '本机', connected: true, unread: 3, active: false }),
    ).toBe('(3) 本机');
    expect(
      formatSessionMenuLabel({ id: 'i', url: 'http://h/', name: '本机', connected: true, unread: null, active: false }),
    ).toBe('本机');
  });

  it('名称为空或等于地址时回退地址', () => {
    expect(
      formatSessionMenuLabel({ id: 'i', url: 'http://h/', name: '', connected: false, unread: null, active: false }),
    ).toBe('http://h/');
    expect(
      formatSessionMenuLabel({
        id: 'i',
        url: 'http://h/',
        name: 'http://h/',
        connected: false,
        unread: null,
        active: false,
      }),
    ).toBe('http://h/');
  });

  it('未读为 0 时不显示前缀', () => {
    expect(
      formatSessionMenuLabel({ id: 'i', url: 'http://h/', name: '本机', connected: true, unread: 0, active: false }),
    ).toBe('本机');
  });
});
