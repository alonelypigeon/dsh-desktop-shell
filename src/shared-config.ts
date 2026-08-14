import { app } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 与 cordis 插件（DSH 进程内）共享的配置。两个独立进程通过读写同一个 JSON 文件通信：
//   - url                桌面外壳要加载的 DSH web 地址
//   - autoLaunch         期望的开机自启状态（Electron 轮询到变化后应用 setLoginItemSettings）
//   - updateRequest      触发一次更新的时间戳（Electron 轮询到更大值后触发 checkForUpdates）
//   - serviceStopRequest 停止本地服务的请求时间戳（/desktop stop 写入，Electron 轮询后停止）
//   - desktopExe         桌面应用可执行文件路径（cordis 插件 /desktop open 时 spawn 用）
export interface SharedConfig {
  url?: string;
  autoLaunch?: boolean;
  updateRequest?: number;
  serviceStopRequest?: number;
  desktopExe?: string;
}

// 路径解析：显式 DSH_DESKTOP_CONFIG > $DSH_HOME/desktop-shell.json >
// 标准 home ~/.dsh/desktop-shell.json（DSH 的默认 home，即使 DSH_HOME 环境变量
// 对 GUI 进程不可见也能对齐）> Electron userData。
// cordis 插件侧读写 $DSH_HOME/desktop-shell.json，两侧因此对齐。
export function sharedConfigPath(): string {
  if (process.env.DSH_DESKTOP_CONFIG) return process.env.DSH_DESKTOP_CONFIG;
  const dshHome = process.env.DSH_HOME;
  if (dshHome) return path.join(dshHome, 'desktop-shell.json');
  const defaultHome = path.join(os.homedir(), '.dsh');
  if (fs.existsSync(defaultHome)) return path.join(defaultHome, 'desktop-shell.json');
  return path.join(app.getPath('userData'), 'desktop-shell.json');
}

export function loadSharedConfig(): SharedConfig {
  try {
    const raw = fs.readFileSync(sharedConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SharedConfig>;
    const out: SharedConfig = {};
    if (typeof parsed.url === 'string') out.url = parsed.url;
    if (typeof parsed.autoLaunch === 'boolean') out.autoLaunch = parsed.autoLaunch;
    if (typeof parsed.updateRequest === 'number') out.updateRequest = parsed.updateRequest;
    if (typeof parsed.serviceStopRequest === 'number') out.serviceStopRequest = parsed.serviceStopRequest;
    if (typeof parsed.desktopExe === 'string') out.desktopExe = parsed.desktopExe;
    return out;
  } catch {
    return {};
  }
}

export function saveSharedConfig(patch: Partial<SharedConfig>): void {
  const current = loadSharedConfig();
  const next: SharedConfig = { ...current, ...patch };
  const dir = path.dirname(sharedConfigPath());
  fs.mkdirSync(dir, { recursive: true });
  // 原子写：先写临时文件再 rename，避免轮询读到半截 JSON。
  const tmp = sharedConfigPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, sharedConfigPath());
}

// 一次性迁移：早期版本把共享配置写进了 Electron userData（无 DSH_HOME 时），
// 现在新路径是 ~/.dsh。若新路径缺 url 而 userData 有旧数据，把它带过去。
export function migrateLegacyConfig(): void {
  const legacy = path.join(app.getPath('userData'), 'desktop-shell.json');
  if (!fs.existsSync(legacy)) return;
  const current = loadSharedConfig();
  if (current.url) return; // 新路径已有数据，不覆盖
  try {
    const old = JSON.parse(fs.readFileSync(legacy, 'utf-8')) as Partial<SharedConfig>;
    if (typeof old.url === 'string' && old.url.length > 0) {
      saveSharedConfig({ url: old.url });
    }
  } catch {
    /* 旧文件解析失败则忽略 */
  }
}

// 监听共享配置文件的实时变化（cordis 插件写入 autoLaunch / updateRequest → 立刻响应）。
// 写入是原子 rename，所以 watch 所在目录而非文件本身。
export function watchSharedConfig(cb: () => void): () => void {
  const p = sharedConfigPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) return () => {};

  let timer: NodeJS.Timeout | null = null;
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(cb, 100);
  };

  try {
    const watcher = fs.watch(dir, (_event, filename) => {
      if (!filename) return;
      if (filename.toString() === path.basename(p)) fire();
    });
    return () => watcher.close();
  } catch {
    return () => {};
  }
}
