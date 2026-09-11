// 连接健康的 I/O 侧（A3）：探测时延 + 首页取版本 + 按端口定位监听 PID。
// 纯逻辑（分级 / 版本解析 / 文案）在 health.ts。
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isLoopbackHost } from './url';
import { resolveExternalServerTarget } from './server-stop';
import { parseDshVersionFromHtml, parseVersionFromPackageJson, type HealthReport } from './health';

export interface ProbeOutcome {
  reachable: boolean;
  latencyMs: number | null;
  httpStatus: number | null;
  body: string | null;
}

// 带时延的探测：拿状态码 + 可选正文（用于提取版本标记）。
// 正文只读前 200KB，避免大页面把内存和时间吃满。
export async function probeWithLatency(url: string, timeoutMs = 4000): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'dsh-desktop-shell' },
    });
    const latencyMs = Date.now() - started;
    let body: string | null = null;
    try {
      const text = await res.text();
      body = text.slice(0, 200_000);
    } catch {
      /* 正文拿不到不影响健康结论 */
    }
    return { reachable: res.status < 500, latencyMs, httpStatus: res.status, body };
  } catch {
    return { reachable: false, latencyMs: null, httpStatus: null, body: null };
  } finally {
    clearTimeout(timer);
  }
}

// 本机 dsh CLI 的版本（$DSH_HOME 内的 checkout 或标准 ~/.dsh）。
// 纯读取，不做任何写入；路径不存在/解析失败返回 null。
export function readLocalDshVersion(): string | null {
  const home = process.env.DSH_HOME;
  const roots = [
    ...(home && path.isAbsolute(home) ? [home] : []),
    path.join(os.homedir(), '.dsh'),
  ];
  for (const root of roots) {
    for (const rel of [
      ['apps', 'cli', 'package.json'],
      ['node_modules', 'dsh', 'package.json'],
      ['package.json'],
    ]) {
      const file = path.join(root, ...rel);
      try {
        if (!fs.existsSync(file)) continue;
        const v = parseVersionFromPackageJson(fs.readFileSync(file, 'utf-8'));
        if (v) return v;
      } catch {
        /* 读不到就继续找下一个候选 */
      }
    }
  }
  return null;
}

export interface CollectHealthOptions {
  /** 该连接是否由本应用启动（进程由本应用持有）。 */
  ownService: boolean;
}

// 汇总一次健康检查：探测 → 版本 → 监听 PID（仅回环地址可定位）。
export async function collectHealth(url: string, options: CollectHealthOptions): Promise<HealthReport> {
  const probe = await probeWithLatency(url);
  const version =
    (probe.body ? parseDshVersionFromHtml(probe.body) : null) ?? readLocalDshVersion();

  let pids: number[] = [];
  try {
    if (isLoopbackHost(new URL(url).hostname)) {
      const resolved = await resolveExternalServerTarget(url);
      if (!('error' in resolved)) pids = resolved.target.pids;
    }
  } catch {
    /* 地址异常/平台不支持时留空 */
  }

  return {
    url,
    reachable: probe.reachable,
    latencyMs: probe.latencyMs,
    httpStatus: probe.httpStatus,
    dshVersion: version,
    ownService: options.ownService,
    listeningPids: pids,
    checkedAt: Date.now(),
  };
}
