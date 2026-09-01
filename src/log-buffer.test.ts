import { describe, expect, it } from 'vitest';
import { createLogBuffer, pushLogLine, logSnapshot, clearLog } from './log-buffer';

describe('log-buffer', () => {
  it('保存日志并裁剪最旧行', () => {
    const b = createLogBuffer(3);
    pushLogLine(b, '1');
    pushLogLine(b, '2');
    pushLogLine(b, '3');
    pushLogLine(b, '4');
    expect(logSnapshot(b)).toBe('2\n3\n4');
  });

  it('空行忽略，清空后快照为空', () => {
    const b = createLogBuffer(2);
    pushLogLine(b, '');
    pushLogLine(b, 'a');
    expect(logSnapshot(b)).toBe('a');
    clearLog(b);
    expect(logSnapshot(b)).toBe('');
  });
});
