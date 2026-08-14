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
