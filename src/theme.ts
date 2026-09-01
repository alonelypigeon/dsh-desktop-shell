import { nativeTheme } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseThemePreferenceJson, parseThemePreferenceYaml, type ThemePreference } from './theme-prefs';

export type { ThemePreference } from './theme-prefs';

// DSH 的 home：$DSH_HOME 或标准 ~/.dsh（DSH_HOME 环境变量对 GUI 进程可能不可见）。
// 仅接受绝对路径：相对 DSH_HOME 会随进程 cwd 变化，读取没有稳定语义。
function dshHomePath(): string | null {
  const explicit = process.env.DSH_HOME;
  if (explicit && path.isAbsolute(explicit)) return explicit;
  const defaultHome = path.join(os.homedir(), '.dsh');
  return fs.existsSync(defaultHome) ? defaultHome : null;
}

// DSH 配置文件名是受控枚举字面量（无 ../、无路径分隔符、无绝对路径）。
const THEME_SETTING_FILES = ['settings.yaml', 'settings.yml', 'settings.json'] as const;

// 从 DSH 的 settings.yaml 读取 ui-theme.preference（default: system）。
// 解析逻辑在 theme-prefs.ts（纯函数，带单测）。
export function readDshThemePreference(): ThemePreference {
  const dshHome = dshHomePath();
  if (!dshHome) return 'system';

  for (const name of THEME_SETTING_FILES) {
    // 文件名来自受控枚举（不可能越界）；仍显式校验解析结果落在 home 边界内。
    const p = path.resolve(dshHome, name);
    if (!p.startsWith(dshHome + path.sep)) continue;
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const pref = name.endsWith('.json')
        ? parseThemePreferenceJson(raw)
        : parseThemePreferenceYaml(raw);
      if (pref) return pref;
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
