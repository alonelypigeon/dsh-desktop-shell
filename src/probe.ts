// URL 就绪探测：加载前用一次轻量 GET 确认 DSH web 已在响应，
// 避免「地址填错 → 直接白屏」的体验。主进程（Node）自带全局 fetch。
export async function probeUrl(url: string, timeoutMs = 5000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'dsh-desktop-shell' },
    });
    // 只要服务在响应（非 5xx），就认为「就绪」；401/403 也算在响应。
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
