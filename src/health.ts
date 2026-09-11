// 连接健康（A3）的纯函数：分级、版本提取、展示格式化。
// I/O（fetch / netstat）在 health-runtime.ts，这里只做可单测的纯逻辑。

export type HealthLevel = 'ok' | 'slow' | 'down';

export interface HealthReport {
  url: string;
  reachable: boolean;
  /** 探测往返毫秒；不可达为 null。 */
  latencyMs: number | null;
  /** HTTP 状态码；未拿到响应为 null。 */
  httpStatus: number | null;
  /** DSH 版本号；未知为 null。 */
  dshVersion: string | null;
  /** 该服务是否由本应用启动（进程由本应用持有）。 */
  ownService: boolean;
  /** 监听该端口的 PID（不含本应用自身进程）；未知为空数组。 */
  listeningPids: number[];
  /** 探测时间戳（毫秒）。 */
  checkedAt: number;
}

/** 慢连接阈值（毫秒）；>= 该值判为 'slow'。 */
export const HEALTH_SLOW_MS = 1200;

export function classifyHealth(input: { reachable: boolean; latencyMs: number | null }): HealthLevel {
  if (!input.reachable) return 'down';
  const ms = input.latencyMs;
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'ok';
  return ms >= HEALTH_SLOW_MS ? 'slow' : 'ok';
}

const SEMVER = String.raw`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`;
const HTML_MARKERS: RegExp[] = [
  new RegExp(String.raw`<meta[^>]+name=["']dsh-version["'][^>]*content=["'](${SEMVER})["']`, 'i'),
  new RegExp(String.raw`<meta[^>]+content=["'](${SEMVER})["'][^>]*name=["']dsh-version["']`, 'i'),
  new RegExp(String.raw`__DSH_VERSION__\s*[:=]\s*["'](${SEMVER})["']`),
  new RegExp(String.raw`"dshVersion"\s*:\s*"(${SEMVER})"`),
  new RegExp(String.raw`data-dsh-version=["'](${SEMVER})["']`, 'i'),
  new RegExp(String.raw`<title>[^<]{0,60}?(${SEMVER})[^<]{0,60}?</title>`, 'i'),
];

// 从首页 HTML 尽力提取版本号。按标记优先级返回第一个命中；限定扫描窗口，
// 避免在大文档上做贪婪回溯（最坏情况正则代价可控）。
export function parseDshVersionFromHtml(html: string): string | null {
  if (typeof html !== 'string' || html === '') return null;
  const head = html.slice(0, 200_000);
  for (const re of HTML_MARKERS) {
    const m = re.exec(head);
    if (m?.[1]) return m[1];
  }
  // 兜底：`dsh` 附近 40 字符内的 semver（页面里常见 "dsh v0.8.1" 之类文案）
  const loose = new RegExp(String.raw`\bdsh\b[^\n]{0,40}?(${SEMVER})`, 'i').exec(head);
  return loose?.[1] ?? null;
}

export function parseVersionFromPackageJson(raw: string): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const v = (data as Record<string, unknown>).version;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const LEVEL_TEXT: Record<HealthLevel, string> = { ok: '正常', slow: '偏慢', down: '无响应' };

export function formatHealthReport(report: HealthReport): string {
  const level = classifyHealth({ reachable: report.reachable, latencyMs: report.latencyMs });
  const lines = [
    `地址: ${report.url}`,
    `状态: ${LEVEL_TEXT[level]}`,
    `延迟: ${formatLatency(report.latencyMs)}`,
    `HTTP: ${report.httpStatus === null ? '—' : String(report.httpStatus)}`,
    `DSH 版本: ${report.dshVersion ?? '未知'}`,
    `本地服务: ${report.ownService ? '本应用启动' : '外部实例'}`,
    `监听 PID: ${report.listeningPids.length > 0 ? report.listeningPids.join(', ') : '未定位到'}`,
    `探测时间: ${new Date(report.checkedAt).toLocaleString()}`,
  ];
  if (level === 'slow') {
    lines.push('', '建议: 服务响应偏慢，页面可能在加载大文件或本机负载较高。');
  } else if (level === 'down') {
    lines.push('', '建议: 服务无响应。若为本应用启动的本地服务，可在「服务器」菜单重启它。');
  }
  return lines.join('\n');
}
