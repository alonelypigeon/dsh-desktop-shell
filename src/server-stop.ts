// 停止「非本应用启动」的本机 DSH 服务器（嗅探连接的外部实例）。
//
// 为什么按端口找进程：DSH web 没有停机 HTTP 端点；配套 cordis 插件的
// serviceStopRequest 是单向握手（插件 → 桌面应用），外部实例不监听共享
// 配置的变化。因此只能通过 TCP 监听表定位该端口的进程并结束其进程树。
// 仅允许回环地址（远程服务器无法也不应从本机关闭）。
import { spawn } from 'node:child_process';
import { isLoopbackHost } from './url';
import { probeUrl } from './probe';

export interface ExternalStopResult {
  ok: boolean;
  detail: string;
}

// —— 纯函数：监听表输出解析（可单测） ——

// Windows `netstat -ano` 行样例：
//   TCP    127.0.0.1:3080      0.0.0.0:0          LISTENING       4212
//   TCP    [::1]:3080          [::]:0             LISTENING       4212
//   TCP    0.0.0.0:3080        0.0.0.0:0          LISTENING       4212
// 注意 IPv6 本地地址带方括号，`(\S+):(\d+)` 贪婪回退后按最后一个冒号切出端口。
export function parseNetstatPids(output: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!m) continue;
    if (Number(m[2]) !== port) continue;
    const pid = Number(m[3]);
    if (Number.isInteger(pid) && pid > 4) pids.add(pid); // 0/4 是 Windows 系统进程
  }
  return [...pids];
}

// POSIX `lsof -ti tcp:<port> -sTCP:LISTEN`：每行一个 PID。
export function parseLsofPids(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const n = Number(line.trim());
    if (Number.isInteger(n) && n > 1) pids.add(n);
  }
  return [...pids];
}

// —— 平台命令执行 ——

function runCommand(cmd: string, args: string[], timeoutMs = 6000): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(out);
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve('');
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done();
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.stderr?.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.on('error', done);
    child.on('close', done);
  });
}

async function findListeningPids(port: number): Promise<number[]> {
  const exclude = new Set([process.pid, process.ppid].filter((p) => typeof p === 'number'));
  let pids: number[] = [];
  if (process.platform === 'win32') {
    pids = parseNetstatPids(await runCommand('netstat', ['-ano']), port);
  } else {
    pids = parseLsofPids(await runCommand('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']));
  }
  return pids.filter((p) => !exclude.has(p));
}

function killPid(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 进程可能已退出 */
    }
  }
}

// 等待端口停止响应（服务真的停了才算成功）。
async function waitUntilDown(url: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  await new Promise((r) => setTimeout(r, 400)); // 给 kill 一点生效时间
  while (Date.now() < deadline) {
    if (!(await probeUrl(url, 1500))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// 停止一个非本应用启动的本机 DSH 服务器。
export async function stopExternalLocalServer(rawUrl: string): Promise<ExternalStopResult> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, detail: `无效的地址：${rawUrl}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, detail: '仅支持 http/https 地址' };
  }
  if (!isLoopbackHost(u.hostname)) {
    return { ok: false, detail: '仅支持停止本机（回环地址）的服务器；远程服务器无法从本机关闭' };
  }
  if (!u.port) {
    return { ok: false, detail: '该地址未指定端口，无法定位进程' };
  }
  const port = Number(u.port);

  const pids = await findListeningPids(port);
  if (pids.length === 0) {
    return { ok: false, detail: `未找到监听 ${u.host} 的服务器进程（可能已停止）` };
  }

  for (const pid of pids) killPid(pid);

  if (await waitUntilDown(u.origin)) {
    return { ok: true, detail: `本机 DSH 服务器已停止：${u.origin}（PID ${pids.join(', ')}）` };
  }
  return {
    ok: false,
    detail: `已请求结束进程（PID ${pids.join(', ')}），但 ${u.host} 仍在响应——请手动确认`,
  };
}
