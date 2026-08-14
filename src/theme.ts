import { nativeTheme } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type ThemePreference = 'light' | 'dark' | 'system';

// DSH 的 home：$DSH_HOME 或标准 ~/.dsh（DSH_HOME 环境变量对 GUI 进程可能不可见）。
function dshHomePath(): string | null {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const defaultHome = path.join(os.homedir(), '.dsh');
  return fs.existsSync(defaultHome) ? defaultHome : null;
}

// 从 DSH 的 settings.yaml 读取 ui-theme.preference（default: system）。
// 与 dsh-client-ui-theme 的 theme-settings 保持一致。
export function readDshThemePreference(): ThemePreference {
  const dshHome = dshHomePath();
  if (!dshHome) return 'system';

  for (const name of ['settings.yaml', 'settings.yml', 'settings.json']) {
    const p = path.join(dshHome, name);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      if (name.endsWith('.json')) {
        const parsed = JSON.parse(raw) as { 'ui-theme'?: { preference?: string } };
        const v = parsed['ui-theme']?.preference;
        if (v === 'light' || v === 'dark' || v === 'system') return v;
      } else {
        // YAML：优先匹配 ui-theme 段下的 preference（避免误读其他插件的同名键），
        // 找不到时回退到文件中首个 preference 匹配。
        const section = raw.match(/^ui-theme\s*:\s*([\s\S]*?)(?=^\S|\z)/m);
        const scoped = section ? section[1] : raw;
        const m = scoped.match(/^\s*preference\s*:\s*["']?(light|dark|system)["']?/m);
        if (m) return m[1].toLowerCase() as ThemePreference;
        const fallback = raw.match(/preference\s*:\s*["']?(light|dark|system)["']?/i);
        if (fallback) return fallback[1].toLowerCase() as ThemePreference;
      }
    } catch {
      /* 解析失败按 system 处理 */
    }
  }
  return 'system';
}

// 解析偏好为"是否深色"；system 时跟随系统。
export function resolveIsDark(pref: ThemePreference): boolean {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return nativeTheme.shouldUseDarkColors;
}

// 监听系统深浅色变化（system 偏好时需要）。
export function onSystemThemeChange(cb: (isDark: boolean) => void): () => void {
  const handler = (): void => cb(nativeTheme.shouldUseDarkColors);
  nativeTheme.on('updated', handler);
  return () => nativeTheme.off('updated', handler);
}

// 监听 DSH settings.yaml 的实时变化（用户在 DSH 设置里切换外观 → 立刻跟随）。
// dsh-settings-file 以原子 rename 写入，所以 watch 目录而非文件本身。
export function watchDshTheme(cb: (pref: ThemePreference) => void): () => void {
  const dshHome = dshHomePath();
  if (!dshHome || !fs.existsSync(dshHome)) return () => {};

  let timer: NodeJS.Timeout | null = null;
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => cb(readDshThemePreference()), 150);
  };

  try {
    const watcher = fs.watch(dshHome, (_event, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (/^settings\.(yaml|yml|json)$/.test(name)) fire();
    });
    return () => watcher.close();
  } catch {
    return () => {};
  }
}
