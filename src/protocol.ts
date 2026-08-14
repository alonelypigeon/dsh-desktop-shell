// dsh-shell:// 深链协议解析（纯函数，可测）。
//
// 支持的动作：
//   dsh-shell://show                                 显示/聚焦主窗口
//   dsh-shell://open?url=<encodeURIComponent(http(s)://…)>  连接指定服务器
//
// 安全：内嵌 url 必须通过 validateUrl（仅 http/https），
// 非回环地址仍会走主进程的连接确认弹窗（与 login 输入一致）。
import { validateUrl } from './url';

export type DshShellAction =
  | { action: 'show' }
  | { action: 'open'; url: string }
  | { action: 'unknown' };

export const PROTOCOL_SCHEME = 'dsh-shell';

// 从任意输入解析深链动作；无法解析或 url 非法 → { action: 'unknown' }（不抛）。
export function parseDshShellUrl(raw: string): DshShellAction {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { action: 'unknown' };
  }
  if (u.protocol !== `${PROTOCOL_SCHEME}:`) return { action: 'unknown' };

  const host = u.hostname.toLowerCase();
  if (host === 'show') return { action: 'show' };
  if (host === 'open') {
    const target = u.searchParams.get('url');
    if (!target) return { action: 'unknown' };
    try {
      return { action: 'open', url: validateUrl(target) };
    } catch {
      return { action: 'unknown' };
    }
  }
  return { action: 'unknown' };
}
