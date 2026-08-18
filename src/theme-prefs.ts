// DSH「外观」偏好解析 —— 纯函数模块，不依赖 electron / fs，便于单测。
// 来源文件：$DSH_HOME/settings.yaml（块状 YAML）或 settings.json，
// 由 theme.ts 负责读文件并调用这里的解析器。

export type ThemePreference = 'light' | 'dark' | 'system';

const THEME_VALUES: readonly string[] = ['light', 'dark', 'system'];

function normalizeValue(v: string): ThemePreference | null {
  const lower = v.trim().toLowerCase();
  return THEME_VALUES.includes(lower) ? (lower as ThemePreference) : null;
}

// 单行 `preference: dark` / `preference: "system"` 匹配（行首缩进形式）。
function matchPreferenceKey(line: string): ThemePreference | null {
  const m = line.match(/^\s*preference\s*:\s*["']?([^"'\s#]+)["']?/i);
  return m ? normalizeValue(m[1]) : null;
}

// 块状 YAML 解析：定位顶层 `ui-theme:` 段，读取其下缩进的 `preference` 键。
// 只认 ui-theme 段内的值，避免误读其他插件的同名键；段内没有时回退到
// 文件中任意位置的第一个 preference（兼容早期只有裸 preference 的写法）。
// 逐行解析替代了旧版正则切片（旧正则里的 \z 在 JS 中是非法转义，行为靠侥幸）。
export function parseThemePreferenceYaml(raw: string): ThemePreference | null {
  let inUiThemeSection = false;
  let fallback: ThemePreference | null = null;

  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;

    if (!/^\s/.test(line) && !line.startsWith('#')) {
      // 顶层键：进入/离开 ui-theme 段
      inUiThemeSection = /^ui-theme\s*:/.test(line);
    } else if (inUiThemeSection) {
      const hit = matchPreferenceKey(line);
      if (hit) return hit;
    }

    if (!fallback) {
      // 回退：任意位置的 preference（含行内/流式写法，与旧实现一致）
      const f = line.match(/preference\s*:\s*["']?(light|dark|system)["']?/i);
      if (f) fallback = f[1].toLowerCase() as ThemePreference;
    }
  }
  return fallback;
}

// settings.json 形式：{ "ui-theme": { "preference": "dark" } }。
export function parseThemePreferenceJson(raw: string): ThemePreference | null {
  try {
    const parsed = JSON.parse(raw) as { 'ui-theme'?: { preference?: unknown } };
    const v = parsed?.['ui-theme']?.preference;
    return typeof v === 'string' ? normalizeValue(v) : null;
  } catch {
    return null;
  }
}
