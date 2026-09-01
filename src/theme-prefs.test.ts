import { describe, it, expect } from 'vitest';
import { parseThemePreferenceYaml, parseThemePreferenceJson } from './theme-prefs';

describe('parseThemePreferenceYaml', () => {
  it('读取 ui-theme 段下的 preference', () => {
    const yaml = [
      '# DSH settings',
      'model: deepseek',
      'ui-theme:',
      '  preference: dark',
      'other-plugin:',
      '  preference: light',
    ].join('\n');
    expect(parseThemePreferenceYaml(yaml)).toBe('dark');
  });

  it('ui-theme 段值带引号 / 大写也能识别', () => {
    expect(parseThemePreferenceYaml('ui-theme:\n  preference: "system"')).toBe('system');
    expect(parseThemePreferenceYaml('ui-theme:\n  preference: Light')).toBe('light');
  });

  it('ui-theme 段在前、其他插件同名键在后 → 不被后者覆盖', () => {
    const yaml = ['ui-theme:', '  preference: dark', 'balance:', '  preference: light'].join('\n');
    expect(parseThemePreferenceYaml(yaml)).toBe('dark');
  });

  it('段内无 preference 时回退到文件任意位置的首个 preference', () => {
    const yaml = ['ui-theme:', '  accent: blue', 'appearance:', '  preference: light'].join('\n');
    expect(parseThemePreferenceYaml(yaml)).toBe('light');
  });

  it('ui-theme 段直到下一个顶层键为止（后续段的 preference 不属于它）', () => {
    // 旧实现依赖正则切片；逐行解析必须正确识别段边界
    const yaml = [
      'ui-theme:',
      '  preference: system',
      'editor:',
      '  font-size: 14',
      'legacy-preference: dark',
    ].join('\n');
    expect(parseThemePreferenceYaml(yaml)).toBe('system');
  });

  it('ui-theme 是文件最后一个段时也能读到（无后续顶层键兜底）', () => {
    expect(parseThemePreferenceYaml('model: x\nui-theme:\n  preference: dark')).toBe('dark');
  });

  it('无任何 preference → null', () => {
    expect(parseThemePreferenceYaml('model: deepseek\neditor:\n  font: mono')).toBeNull();
    expect(parseThemePreferenceYaml('')).toBeNull();
  });

  it('非法值不匹配（不误判）', () => {
    expect(parseThemePreferenceYaml('ui-theme:\n  preference: solarized')).toBeNull();
  });

  it('CRLF 行尾兼容', () => {
    expect(parseThemePreferenceYaml('ui-theme:\r\n  preference: dark\r\n')).toBe('dark');
  });

  it('注释行不干扰段识别', () => {
    const yaml = ['# ui-theme: fake\nui-theme:\n  # preference: light\n  preference: dark'].join('\n');
    expect(parseThemePreferenceYaml(yaml)).toBe('dark');
  });
});

describe('parseThemePreferenceJson', () => {
  it('读取 ui-theme.preference', () => {
    expect(parseThemePreferenceJson('{"ui-theme":{"preference":"dark"}}')).toBe('dark');
    expect(parseThemePreferenceJson('{"ui-theme":{"preference":"light"}}')).toBe('light');
    expect(parseThemePreferenceJson('{"ui-theme":{"preference":"system"}}')).toBe('system');
  });

  it('缺字段 / 非法值 / 坏 JSON → null', () => {
    expect(parseThemePreferenceJson('{}')).toBeNull();
    expect(parseThemePreferenceJson('{"ui-theme":{}}')).toBeNull();
    expect(parseThemePreferenceJson('{"ui-theme":{"preference":"solarized"}}')).toBeNull();
    expect(parseThemePreferenceJson('{"ui-theme":{"preference":123}}')).toBeNull();
    expect(parseThemePreferenceJson('not json')).toBeNull();
  });
});
