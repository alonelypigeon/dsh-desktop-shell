// 每连接代理（A5）的纯函数：解析 / 校验 / 展示 / 转 Electron 入参。
//
// 为什么是纯函数：代理配置会写进 shell-state.json（明文 JSON），所以校验
// 必须和 URL 校验同一套严苛标准——不接受内嵌凭据、必须显式端口、只认
// http/https/socks 四种 scheme。校验逻辑与进程/UI 无关，便于单测覆盖。
//
// Electron 的代理是 **按 session** 生效的（session.setProxy），配合
// session-policy.ts 的「每连接独立 partition」，同一个代理配置只影响
// 它自己那个连接窗口。

export interface ProxyConfig {
  /** 'direct' = 显式直连（覆盖任何环境变量代理）。 */
  mode: 'http' | 'socks' | 'direct';
  /** 规范化后的代理地址，如 'http://127.0.0.1:7890'；mode==='direct' 时为空串。 */
  url: string;
  /** 绕过代理的主机列表（小写、去重、保序）。 */
  bypass: string[];
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:']);
const DIRECT_WORDS = new Set(['direct', 'none', 'off', '']);

// 解析绕过列表文本：逗号/分号/换行/空白都可作分隔符（用户从各处粘贴）。
export function parseBypassList(raw: string): string[] {
  if (typeof raw !== 'string') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const host = part.trim().toLowerCase();
    if (host === '' || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

// 解析并校验一条代理配置。接受字符串简写（'socks5://127.0.0.1:7897'、'direct'）
// 或对象形态 { url|mode, bypass }。任何非法输入返回 null（调用方回退直连）。
export function normalizeProxyConfig(raw: unknown): ProxyConfig | null {
  // 字符串简写
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (DIRECT_WORDS.has(s.toLowerCase())) return { mode: 'direct', url: '', bypass: [] };
    return parseProxyUrl(s, []);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const bypass = Array.isArray(r.bypass)
    ? parseBypassList(r.bypass.filter((x): x is string => typeof x === 'string').join(','))
    : typeof r.bypass === 'string'
      ? parseBypassList(r.bypass)
      : [];

  if (r.mode === 'direct') return { mode: 'direct', url: '', bypass };
  const urlText = typeof r.url === 'string' ? r.url.trim() : '';
  if (urlText === '') {
    // 只有 mode 是合法值时也接受（'http'/'socks' 但没填地址 = 无效）
    return null;
  }
  return parseProxyUrl(urlText, bypass);
}

function parseProxyUrl(text: string, bypass: string[]): ProxyConfig | null {
  if (DIRECT_WORDS.has(text.toLowerCase())) return { mode: 'direct', url: '', bypass };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) return null;
  // 代理地址必须显式带端口：默认端口猜错会让用户以为「代理没生效」。
  if (u.port === '') return null;
  // 明文 JSON 不存凭据（与 url.ts 的 validateUrl 同一策略）。
  if (u.username !== '' || u.password !== '') return null;
  if (u.pathname !== '' && u.pathname !== '/') return null;
  if (u.search !== '' || u.hash !== '') return null;
  if (u.hostname === '') return null;

  const mode: ProxyConfig['mode'] = u.protocol.startsWith('socks') ? 'socks' : 'http';
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  const host = u.hostname.toLowerCase();
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { mode, url: `${scheme}://${host}:${port}`, bypass };
}

// 渲染层展示用文案。
export function describeProxyConfig(cfg: ProxyConfig): string {
  if (cfg.mode === 'direct') return '直连（不使用代理）';
  let u: URL;
  try {
    u = new URL(cfg.url);
  } catch {
    return cfg.url;
  }
  const kind = cfg.mode === 'socks' ? 'SOCKS' : 'HTTP';
  const suffix = cfg.bypass.length > 0 ? `（绕过 ${cfg.bypass.length} 条）` : '';
  return `${kind} ${u.hostname}:${u.port}${suffix}`;
}

// 转 Electron session.setProxy 入参。
export function proxyToElectronRules(cfg: ProxyConfig): {
  proxyRules: string;
  proxyBypassRules?: string;
  mode: 'fixed_servers' | 'direct';
} {
  if (cfg.mode === 'direct') return { proxyRules: 'direct://', mode: 'direct' };
  const bypass = cfg.bypass.join(';');
  return {
    proxyRules: cfg.url,
    ...(bypass !== '' ? { proxyBypassRules: bypass } : {}),
    mode: 'fixed_servers',
  };
}
