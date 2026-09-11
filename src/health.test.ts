import { describe, expect, it } from 'vitest';
import {
  HEALTH_SLOW_MS,
  classifyHealth,
  formatHealthReport,
  formatLatency,
  parseDshVersionFromHtml,
  parseVersionFromPackageJson,
  type HealthReport,
} from './health';

describe('classifyHealth', () => {
  it('不可达 → down（即使带了时延）', () => {
    expect(classifyHealth({ reachable: false, latencyMs: null })).toBe('down');
    expect(classifyHealth({ reachable: false, latencyMs: 20 })).toBe('down');
  });

  it('可达且时延未知 → ok', () => {
    expect(classifyHealth({ reachable: true, latencyMs: null })).toBe('ok');
  });

  it('阈值边界：>= HEALTH_SLOW_MS 判慢', () => {
    expect(classifyHealth({ reachable: true, latencyMs: HEALTH_SLOW_MS - 1 })).toBe('ok');
    expect(classifyHealth({ reachable: true, latencyMs: HEALTH_SLOW_MS })).toBe('slow');
  });

  it('负数/NaN 时延不抛异常，按 ok 处理', () => {
    expect(classifyHealth({ reachable: true, latencyMs: -5 })).toBe('ok');
    expect(classifyHealth({ reachable: true, latencyMs: Number.NaN })).toBe('ok');
  });
});

describe('parseDshVersionFromHtml', () => {
  it('meta 标记（两种属性顺序）', () => {
    expect(parseDshVersionFromHtml('<meta name="dsh-version" content="1.2.3">')).toBe('1.2.3');
    expect(parseDshVersionFromHtml('<meta content="1.2.3" name="dsh-version">')).toBe('1.2.3');
  });

  it('内联变量 / JSON 字段 / data 属性', () => {
    expect(parseDshVersionFromHtml('<script>window.__DSH_VERSION__ = "0.9.0";</script>')).toBe('0.9.0');
    expect(parseDshVersionFromHtml('<script>{"dshVersion":"0.8.1"}</script>')).toBe('0.8.1');
    expect(parseDshVersionFromHtml('<div data-dsh-version="2.0.0-rc.1"></div>')).toBe('2.0.0-rc.1');
  });

  it('title 里的 semver 兜底', () => {
    expect(parseDshVersionFromHtml('<title>DeepSeek Harness 0.8.1</title>')).toBe('0.8.1');
  });

  it('优先级：meta 胜过 title', () => {
    expect(
      parseDshVersionFromHtml('<title>Harness 9.9.9</title><meta name="dsh-version" content="1.0.0">'),
    ).toBe('1.0.0');
  });

  it('无版本信息 / 空串 / 垃圾输入 → null（不抛异常）', () => {
    expect(parseDshVersionFromHtml('<html><body>hi</body></html>')).toBeNull();
    expect(parseDshVersionFromHtml('')).toBeNull();
    expect(parseDshVersionFromHtml(undefined as unknown as string)).toBeNull();
    expect(parseDshVersionFromHtml('<title>no version here</title>')).toBeNull();
  });

  it('大输入不炸（只看前 200KB）', () => {
    const huge = 'x'.repeat(300_000) + '<meta name="dsh-version" content="1.0.0">';
    expect(parseDshVersionFromHtml(huge)).toBeNull();
    const early = '<meta name="dsh-version" content="1.0.0">' + 'x'.repeat(300_000);
    expect(parseDshVersionFromHtml(early)).toBe('1.0.0');
  });
});

describe('parseVersionFromPackageJson', () => {
  it('取 version 字段', () => {
    expect(parseVersionFromPackageJson('{"name":"dsh","version":"1.4.0"}')).toBe('1.4.0');
  });

  it('缺失/类型不对/非 JSON → null', () => {
    expect(parseVersionFromPackageJson('{"name":"dsh"}')).toBeNull();
    expect(parseVersionFromPackageJson('{"version":1}')).toBeNull();
    expect(parseVersionFromPackageJson('{"version":""}')).toBeNull();
    expect(parseVersionFromPackageJson('not json')).toBeNull();
    expect(parseVersionFromPackageJson('[]')).toBeNull();
    expect(parseVersionFromPackageJson('')).toBeNull();
  });
});

describe('formatLatency', () => {
  it('null → 破折号；毫秒/秒分档', () => {
    expect(formatLatency(null)).toBe('—');
    expect(formatLatency(-1)).toBe('—');
    expect(formatLatency(Number.NaN)).toBe('—');
    expect(formatLatency(0)).toBe('0 ms');
    expect(formatLatency(128.4)).toBe('128 ms');
    expect(formatLatency(999)).toBe('999 ms');
    expect(formatLatency(1000)).toBe('1.0 s');
    expect(formatLatency(2450)).toBe('2.5 s');
  });
});

describe('formatHealthReport', () => {
  const base: HealthReport = {
    url: 'http://127.0.0.1:3080/',
    reachable: true,
    latencyMs: 128,
    httpStatus: 200,
    dshVersion: '0.8.1',
    ownService: true,
    listeningPids: [4212],
    checkedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  };

  it('正常连接：字段齐全', () => {
    const text = formatHealthReport(base);
    expect(text).toContain('地址: http://127.0.0.1:3080/');
    expect(text).toContain('状态: 正常');
    expect(text).toContain('延迟: 128 ms');
    expect(text).toContain('HTTP: 200');
    expect(text).toContain('DSH 版本: 0.8.1');
    expect(text).toContain('本地服务: 本应用启动');
    expect(text).toContain('监听 PID: 4212');
  });

  it('偏慢时给出建议', () => {
    const text = formatHealthReport({ ...base, latencyMs: 3000 });
    expect(text).toContain('状态: 偏慢');
    expect(text).toContain('建议:');
  });

  it('无响应 + 未知字段降级展示', () => {
    const text = formatHealthReport({
      ...base,
      reachable: false,
      latencyMs: null,
      httpStatus: null,
      dshVersion: null,
      ownService: false,
      listeningPids: [],
    });
    expect(text).toContain('状态: 无响应');
    expect(text).toContain('延迟: —');
    expect(text).toContain('HTTP: —');
    expect(text).toContain('DSH 版本: 未知');
    expect(text).toContain('本地服务: 外部实例');
    expect(text).toContain('监听 PID: 未定位到');
    expect(text).toContain('建议:');
  });

  it('空字段输入不抛异常', () => {
    expect(() =>
      formatHealthReport({
        url: '',
        reachable: false,
        latencyMs: null,
        httpStatus: null,
        dshVersion: null,
        ownService: false,
        listeningPids: [],
        checkedAt: 0,
      }),
    ).not.toThrow();
  });
});
