// 本地嗅探：探测回环地址上已运行的 DSH web 实例。
// 范围：上次连接过的地址 + 一组常见端口表（决策：不做全端口扫描）。

const CANDIDATE_PORTS = [3080, 3000, 8000, 8080, 5173, 4173, 3001];
const PROBE_TIMEOUT_MS = 3000;

export interface SniffedInstance {
  url: string;
}

// DSH web 的 index.html 特征（dsh-web-frontend 构建产物）。
// 注意：真实 index.html 开头是一大段 window.__DSH_BOOT__ JSON（boot graph），
// <link rel="manifest"> 在其之后，所以必须全文匹配、不能截取头部。
export function looksLikeDshIndex(html: string): boolean {
  return /manifest\.webmanifest/.test(html) || /DeepSeek Harness/i.test(html);
}

// DSH 官方鲸鱼 favicon 的特征：鲸鱼 path 的独特起始坐标。
export function looksLikeDshFavicon(svg: string): boolean {
  return svg.includes('M48.8354');
}

// 单次 fetch 的独立超时（此前用同一个 AbortController 罩两次请求：
// index 请求吃满 3s 后 favicon 探测只剩零头，会误判为超时）。
async function fetchWithTimeout(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

// 单实例指纹校验：index 特征 + 官方 favicon 双重确认。
// 嗅探与「断开并关闭服务器」共用同一标准（后者用于关闭前的安全复核）。
export async function isDshInstance(url: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(url);
    if (res.status >= 500) return false;
    const html = await res.text();
    if (!looksLikeDshIndex(html)) return false;
    // 二次确认：favicon 必须是官方鲸鱼，避免把无关 Web 服务误判为 DSH。
    const origin = new URL(url).origin;
    const fav = await fetchWithTimeout(`${origin}/favicon.svg`);
    if (fav.status !== 200) return false;
    const svg = await fav.text();
    return looksLikeDshFavicon(svg);
  } catch {
    return false;
  }
}

// 并行探测所有候选，返回匹配的实例（URL 已归一化）。
export async function sniffLocalDsh(previousUrl?: string): Promise<SniffedInstance[]> {
  const candidates = new Map<string, string>(); // origin -> url

  if (previousUrl) {
    try {
      const u = new URL(previousUrl);
      if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
        candidates.set(u.origin, u.toString());
      }
    } catch {
      /* 忽略无效的旧地址 */
    }
  }

  for (const port of CANDIDATE_PORTS) {
    const url = `http://127.0.0.1:${port}/`;
    candidates.set(new URL(url).origin, url);
  }

  const results = await Promise.all(
    [...candidates.values()].map(async (url) => ((await isDshInstance(url)) ? { url } : null)),
  );

  const found = results.filter((r): r is SniffedInstance => r !== null);
  return found;
}
