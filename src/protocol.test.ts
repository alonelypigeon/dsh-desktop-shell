import { describe, expect, it } from 'vitest';
import { parseDshShellUrl } from './protocol';

describe('parseDshShellUrl', () => {
  it('show 动作', () => {
    expect(parseDshShellUrl('dsh-shell://show')).toEqual({ action: 'show' });
  });

  it('open 动作携带合法 http url', () => {
    const u = encodeURIComponent('http://127.0.0.1:3080/');
    expect(parseDshShellUrl(`dsh-shell://open?url=${u}`)).toEqual({
      action: 'open',
      url: 'http://127.0.0.1:3080/',
    });
  });

  it('open 动作携带 https url', () => {
    const u = encodeURIComponent('https://dsh.example.com/');
    expect(parseDshShellUrl(`dsh-shell://open?url=${u}`)).toEqual({
      action: 'open',
      url: 'https://dsh.example.com/',
    });
  });

  it('拒绝非 http(s) 协议（file: 等）', () => {
    const u = encodeURIComponent('file:///etc/passwd');
    expect(parseDshShellUrl(`dsh-shell://open?url=${u}`)).toEqual({ action: 'unknown' });
  });

  it('拒绝缺失 url 参数', () => {
    expect(parseDshShellUrl('dsh-shell://open')).toEqual({ action: 'unknown' });
  });

  it('拒绝无法解析的 url 参数', () => {
    const u = encodeURIComponent('not a url');
    expect(parseDshShellUrl(`dsh-shell://open?url=${u}`)).toEqual({ action: 'unknown' });
  });

  it('拒绝非 dsh-shell 协议', () => {
    expect(parseDshShellUrl('https://example.com/')).toEqual({ action: 'unknown' });
  });

  it('拒绝未知 host', () => {
    expect(parseDshShellUrl('dsh-shell://evil?url=x')).toEqual({ action: 'unknown' });
  });

  it('拒绝无法解析的整体输入（不抛）', () => {
    expect(parseDshShellUrl('garbage')).toEqual({ action: 'unknown' });
  });
});
