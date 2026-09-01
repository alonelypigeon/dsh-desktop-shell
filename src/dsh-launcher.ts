import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 就绪行示例：`dsh web: http://127.0.0.1:<port>`（参考生态内多款外壳的解析方式）。
const READY_PATTERN = /dsh web:\s+(https?:\/\/127\.0\.0\.1:\d+)/i;

// npx 安装的 dsh 位于 _npx 缓存目录（PATH 通常只在启动 npx 的 shell 里可见，
// 双击启动的 GUI 应用继承不到）。扫描常见 npx 缓存根目录作为 fallback。
function findDshInNpxCaches(): string | null {
  const roots = [
    path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx'),
    path.join(os.homedir(), 'scoop', 'persist', 'nodejs', 'cache', '_npx'),
  ];
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.ps1', 'dsh'] : ['dsh'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let subs: string[] = [];
    try {
      subs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const sub of subs) {
      const binDir = path.join(root, sub, 'node_modules', '.bin');
      if (!fs.existsSync(binDir)) continue;
      for (const n of names) {
        const p = path.join(binDir, n);
        try {
          if (fs.existsSync(p)) return p;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null;
}

// 定位宿主机上的 dsh 可执行文件，优先级：
//   DSH_BIN > PATH 上的 dsh > npx 缓存扫描 > $DSH_HOME 内的 CLI。
function resolveDshBin(): string | null {
  const explicit = process.env.DSH_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;

  // 探测 PATH 上的 dsh（win32 上可能是 dsh.cmd / dsh.ps1 / dsh.exe）
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.ps1', 'dsh'] : ['dsh'];
  for (const dir of pathDirs) {
    for (const c of candidates) {
      const p = path.join(dir, c);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  }

  // npx 缓存（GUI 应用双击启动时 PATH 没有 npx bin，这里兜底）
  const fromNpx = findDshInNpxCaches();
  if (fromNpx) return fromNpx;

  // $DSH_HOME 里的 checkout（apps/cli/lib/bin.js）
  const dshHome = process.env.DSH_HOME;
  if (dshHome) {
    const binJs = path.join(dshHome, 'apps', 'cli', 'lib', 'bin.js');
    if (fs.existsSync(binJs)) return binJs;
  }
  return null;
}

// 找 node 运行时：dev 模式下 process.execPath 就是 electron（可执行 JS）；
// 打包后它是应用本体，必须从 PATH 找真实的 node（.js 形式的 dsh CLI 需要）。
function resolveNodeBin(): string | null {
  if (process.defaultApp) return process.execPath;
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node'];
  for (const dir of pathDirs) {
    for (const c of names) {
      const p = path.join(dir, c);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export interface DshService {
  url: string;
  stop: () => void;
}

export type DshLaunchPhase = 'starting' | 'found' | 'ready' | 'failed';

export interface DshLaunchOptions {
  onProgress?: (phase: DshLaunchPhase, detail?: string) => void;
  timeoutMs?: number;
  /** 指定监听端口；缺省/0 表示随机端口。 */
  port?: number;
  /** 诊断日志回调（stdout/stderr 原始分片，供外壳记录到环形缓冲）。 */
  onLog?: (line: string) => void;
}

// 校验 GUI 传入的端口输入。返回：
//   0       未指定或显式 0（自动选择随机端口）
//   1-65535 合法端口
//   null    非法输入（调用方应提示用户）
export function normalizeRequestedPort(raw: unknown): number | null {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).trim();
  if (s === '') return 0;
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  if (n === 0) return 0;
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}


// dsh web now opens the default browser unless --no-open is passed.
// The desktop shell has its own content view, so suppress that here.
export function buildDshWebArgs(port: number): string[] {
  return ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'];
}

// 自动启动一个本地 dsh web 实例并嗅探其就绪 URL。
// 默认随机回环端口；指定 port 时尝试监听该端口（被占用会启动失败并带上 stderr 提示）。
// 返回 null 表示无法启动（找不到 dsh、启动失败或超时）。
export async function launchLocalDsh(options: DshLaunchOptions = {}): Promise<DshService | null> {
  const { onProgress, timeoutMs = 30000, port = 0, onLog } = options;

  const dshBin = resolveDshBin();
  if (!dshBin) {
    onProgress?.('failed', '未找到 dsh 命令（PATH / DSH_HOME 里都没有）');
    return null;
  }

  onProgress?.('starting', '正在启动 dsh web …');

  return new Promise<DshService | null>((resolve) => {
    const isBinJs = dshBin.endsWith('.js');
    // dsh.cmd 需要 shell 才能运行（不能用 spawn 直接执行 .cmd）
    const isCmd = process.platform === 'win32' && dshBin.toLowerCase().endsWith('.cmd');
    const isPs1 = process.platform === 'win32' && dshBin.toLowerCase().endsWith('.ps1');

    let child: ChildProcess;
    const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    const args = buildDshWebArgs(port);

    try {
      if (isCmd) {
        child = spawn('cmd.exe', ['/c', dshBin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      } else if (isPs1) {
        child = spawn('powershell.exe', ['-NoProfile', '-File', dshBin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      } else if (isBinJs) {
        // .js 形式的 CLI 需要 node 解释器：dev 用 electron 自身，打包后用 PATH 上的 node。
        const nodeBin = resolveNodeBin();
        if (!nodeBin) {
          onProgress?.('failed', 'dsh 是 JS 脚本，但打包版应用未在 PATH 找到 node');
          resolve(null);
          return;
        }
        child = spawn(nodeBin, [dshBin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      } else {
        child = spawn(dshBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      }
    } catch {
      onProgress?.('failed', '无法执行 dsh 命令');
      resolve(null);
      return;
    }

    let settled = false;
    let buffer = '';
    let url: string | null = null;
    // 收集 stderr 尾部，启动失败（如指定端口被占用）时带给用户可读的原因。
    let stderrTail = '';
    // 兜底超时 timer（cleanup 时清理）。
    let timeoutTimer: NodeJS.Timeout | null = null;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
    };

    const withStderr = (base: string): string => {
      const tail = stderrTail.trim();
      if (!tail) return base;
      const lines = tail.split(/\r?\n/).filter(Boolean);
      return `${base}\n${lines.slice(-2).join('\n')}`;
    };

    const finish = (result: DshService | null, failDetail?: string): void => {
      cleanup();
      if (result) {
        onProgress?.('ready', result.url);
        resolve({ url: result.url, stop: result.stop });
      } else {
        onProgress?.('failed', withStderr(failDetail ?? 'dsh 启动失败或超时'));
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve(null);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString();
      onLog?.(chunk.toString());
      const m = buffer.match(READY_PATTERN);
      if (m && m[1]) {
        url = m[1];
        onProgress?.('found', m[1]);
        // 就绪行到跑通 HTTP 之间还有间隙，轮询探测确认。
        probeUntilReady(m[1], timeoutMs).then((ok) => {
          if (ok && url) finish({ url, stop: () => killTree(child) });
          else finish(null, 'dsh 已监听但未通过 HTTP 探测');
        });
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
      onLog?.(chunk.toString());
    });

    child.on('error', () => finish(null, 'dsh 子进程启动出错'));
    child.on('exit', (code) => {
      if (!settled) {
        // 尚未就绪就退出 → 失败
        finish(null, `dsh 提前退出（code ${code ?? '?'}）`);
      }
    });

    // 兜底超时（settle 后由 cleanup 清理，unref 避免拖住进程退出）
    timeoutTimer = setTimeout(() => {
      if (!settled) finish(null, 'dsh 启动超时');
    }, timeoutMs + 5000);
    timeoutTimer.unref?.();
  });
}

async function probeUntilReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status < 500) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// 尽力杀整棵进程树（Windows 用 taskkill，POSIX 发 SIGTERM）。
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // taskkill 走参数列表（无 shell）；pid 为子进程句柄的整数，唯一参数来源。
    const pid = Math.trunc(Number(child.pid));
    if (!Number.isInteger(pid) || pid <= 0) return;
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', shell: false });
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}
