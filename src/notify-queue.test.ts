import { describe, it, expect } from 'vitest';
import { takeNotifyRequest, clearNotifyPatch, makeNotifyId, type NotifyRequest } from './notify-queue';

const req = (over: Partial<NotifyRequest> = {}): NotifyRequest => ({
  id: 'n-1',
  title: 'DSH 通知',
  body: '你好',
  ...over,
});

describe('takeNotifyRequest', () => {
  it('有效请求返回规范化对象', () => {
    const out = takeNotifyRequest({ notifyRequest: req() }, null);
    expect(out).toEqual({ id: 'n-1', title: 'DSH 通知', body: '你好', silent: false });
  });

  it('与上次已处理 id 相同 → 不再处理（去重）', () => {
    expect(takeNotifyRequest({ notifyRequest: req() }, 'n-1')).toBeNull();
  });

  it('缺字段/类型非法 → null', () => {
    expect(takeNotifyRequest({}, null)).toBeNull();
    expect(takeNotifyRequest({ notifyRequest: undefined }, null)).toBeNull();
    expect(takeNotifyRequest({ notifyRequest: req({ id: '' }) }, null)).toBeNull();
    expect(takeNotifyRequest({ notifyRequest: req({ title: '' }) }, null)).toBeNull();
    expect(takeNotifyRequest({ notifyRequest: req({ body: '' }) }, null)).toBeNull();
    expect(takeNotifyRequest({ notifyRequest: { id: 1, title: 2, body: 3 } } as never, null)).toBeNull();
  });

  it('silent 仅接受 true（其他值归一化为 false）', () => {
    expect(takeNotifyRequest({ notifyRequest: req({ silent: true }) }, null)?.silent).toBe(true);
    expect(takeNotifyRequest({ notifyRequest: req({ silent: false }) }, null)?.silent).toBe(false);
    expect(takeNotifyRequest({ notifyRequest: req({ silent: 'yes' as never }) }, null)?.silent).toBe(false);
  });
});

describe('clearNotifyPatch / makeNotifyId', () => {
  it('清除 patch 只含 notifyRequest: undefined（save 合并后字段删除）', () => {
    expect(clearNotifyPatch()).toEqual({ notifyRequest: undefined });
  });

  it('id 包含时间戳与随机段且前后不同', () => {
    const a = makeNotifyId();
    const b = makeNotifyId();
    expect(a).toMatch(/^\d+-[a-z0-9]{6}$/);
    expect(a).not.toBe(b);
  });
});
