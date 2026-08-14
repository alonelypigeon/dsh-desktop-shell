import { loadSharedConfig, saveSharedConfig } from './shared-config';
import { parseCliUrl, pickUrl, validateUrl } from './url';

export { validateUrl } from './url';

export function saveUrl(url: string): void {
  saveSharedConfig({ url });
}

// 配置来源优先级：--url > DSH_URL > 共享配置 url。
// 没有配置时返回 null（由 main 显示 login 界面）。
export async function resolveConfiguredUrl(): Promise<string | null> {
  const cliUrl = parseCliUrl(process.argv);
  const envUrl = process.env.DSH_URL ?? null;
  const fileUrl = (() => {
    const cfg = loadSharedConfig();
    return typeof cfg.url === 'string' && cfg.url.length > 0 ? cfg.url : null;
  })();

  const raw = pickUrl(cliUrl, envUrl, fileUrl);
  return raw ? validateUrl(raw) : null;
}
