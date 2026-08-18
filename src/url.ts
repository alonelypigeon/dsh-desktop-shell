// 与 Electron 无关的纯函数，便于单元测试。

// 从命令行解析 --url（Electron 会把自身参数也放在 process.argv 里，需剥掉）。
export function parseCliUrl(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) return next;
      return null;
    }
    if (argv[i].startsWith('--url=')) {
      const v = argv[i].slice('--url='.length);
      return v === '' ? null : v;
    }
  }
  return null;
}

// 校验并规范化 URL：只接受 http/https，其余协议一律拒绝。
export function validateUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`无效的地址：${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`不支持的协议：${u.protocol}（仅支持 http / https）`);
  }
  return u.toString();
}

// 配置来源优先级：cli > env > file。返回第一个非空值。
export function pickUrl(
  cliUrl: string | null,
  envUrl: string | null,
  fileUrl: string | null,
): string | null {
  return cliUrl ?? envUrl ?? fileUrl;
}

// 判断主机名是否为回环地址（用于豁免「连接远程服务器」确认弹窗）。
// 注意：WHATWG URL 的 hostname 对 IPv6 保留方括号（如 '[::1]'），
// 必须剥掉后再比较；127.0.0.0/8 整段都是回环。
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1') return true;
  return /^127\./.test(host);
}
