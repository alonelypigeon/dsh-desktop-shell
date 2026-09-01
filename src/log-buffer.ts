// 诊断日志的环形缓冲（纯函数，便于单测）。
export interface LogBuffer {
  capacity: number;
  lines: string[];
}

export function createLogBuffer(capacity = 500): LogBuffer {
  return { capacity: Math.max(1, capacity), lines: [] };
}

export function pushLogLine(buffer: LogBuffer, line: string): LogBuffer {
  if (typeof line !== 'string' || line === '') return buffer;
  const lines = [...buffer.lines, line];
  const overflow = lines.length - buffer.capacity;
  buffer.lines = overflow > 0 ? lines.slice(overflow) : lines;
  return buffer;
}

export function logSnapshot(buffer: LogBuffer): string {
  return buffer.lines.join('\n');
}

export function clearLog(buffer: LogBuffer): LogBuffer {
  buffer.lines = [];
  return buffer;
}
