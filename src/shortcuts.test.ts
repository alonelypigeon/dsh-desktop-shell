import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  conflictsFor,
  findShortcutConflicts,
  formatAcceleratorForDisplay,
  isShortcutAction,
  matchContentShortcut,
  matchesAccelerator,
  normalizeAccelerator,
  normalizeKeyToken,
  normalizeShortcutBindings,
  recordingOutcome,
  serializeShortcutBindings,
} from './shortcuts';

describe('normalizeKeyToken', () => {
  it('单字符大写、+ 记作 Plus、F 键原样', () => {
    expect(normalizeKeyToken('d')).toBe('D');
    expect(normalizeKeyToken('=')).toBe('=');
    expect(normalizeKeyToken('-')).toBe('-');
    expect(normalizeKeyToken('+')).toBe('Plus');
    expect(normalizeKeyToken('F5')).toBe('F5');
    expect(normalizeKeyToken('F24')).toBe('F24');
  });

  it('命名键与非法输入返回 null', () => {
    expect(normalizeKeyToken('Escape')).toBeNull();
    expect(normalizeKeyToken('Enter')).toBeNull();
    expect(normalizeKeyToken('')).toBeNull();
    expect(normalizeKeyToken('F25')).toBeNull();
    expect(normalizeKeyToken('F0')).toBeNull();
  });
});

describe('normalizeAccelerator', () => {
  it('修饰键归一为 CommandOrControl，顺序固定 Ctrl+Alt+Shift+键', () => {
    expect(normalizeAccelerator('Ctrl+Shift+D')).toBe('CommandOrControl+Shift+D');
    expect(normalizeAccelerator('CommandOrControl+=')).toBe('CommandOrControl+=');
    expect(normalizeAccelerator('Cmd+Alt+P')).toBe('CommandOrControl+Alt+P');
    expect(normalizeAccelerator('Shift+Ctrl+Alt+X')).toBe('CommandOrControl+Alt+Shift+X');
  });

  it('字母大小写不敏感，Plus/数字键支持', () => {
    expect(normalizeAccelerator('Ctrl+d')).toBe('CommandOrControl+D');
    expect(normalizeAccelerator('Ctrl+Plus')).toBe('CommandOrControl+Plus');
    expect(normalizeAccelerator('Ctrl+0')).toBe('CommandOrControl+0');
  });

  it('F 功能键可无修饰键', () => {
    expect(normalizeAccelerator('F5')).toBe('F5');
    expect(normalizeAccelerator('Ctrl+F5')).toBe('CommandOrControl+F5');
  });

  it('非法输入返回 null', () => {
    expect(normalizeAccelerator('')).toBeNull();
    expect(normalizeAccelerator('Ctrl+Escape')).toBeNull();
    expect(normalizeAccelerator('Ctrl+Shift')).toBeNull(); // 末位是修饰键，无键位
    expect(normalizeAccelerator('D')).toBeNull(); // 无修饰键的普通键
    expect(normalizeAccelerator('Ctrl+Win+D')).toBeNull(); // 未知修饰 token
  });
});

describe('recordingOutcome', () => {
  it('Escape 取消、Backspace/Delete 清除、纯修饰键等待', () => {
    expect(recordingOutcome({ key: 'Escape' })).toEqual({ kind: 'cancel' });
    expect(recordingOutcome({ key: 'Backspace' })).toEqual({ kind: 'clear' });
    expect(recordingOutcome({ key: 'Delete', control: true })).toEqual({ kind: 'clear' });
    expect(recordingOutcome({ key: 'Control' })).toEqual({ kind: 'pending' });
    expect(recordingOutcome({ key: 'Shift', control: true })).toEqual({ kind: 'pending' });
  });

  it('Ctrl/⌘ + 字母 → ok（归一化）', () => {
    expect(recordingOutcome({ key: 'k', control: true })).toEqual({ kind: 'ok', accelerator: 'CommandOrControl+K' });
    expect(recordingOutcome({ key: 'K', meta: true, shift: true })).toEqual({
      kind: 'ok',
      accelerator: 'CommandOrControl+Shift+K',
    });
    expect(recordingOutcome({ key: '=', control: true })).toEqual({ kind: 'ok', accelerator: 'CommandOrControl+=' });
    // US 键盘上 Shift+= 产生 '+'，归一为 Plus
    expect(recordingOutcome({ key: '+', control: true, shift: true })).toEqual({
      kind: 'ok',
      accelerator: 'CommandOrControl+Shift+Plus',
    });
  });

  it('Alt 组合与单独 F 键允许', () => {
    expect(recordingOutcome({ key: 'p', alt: true })).toEqual({ kind: 'ok', accelerator: 'Alt+P' });
    expect(recordingOutcome({ key: 'F6' })).toEqual({ kind: 'ok', accelerator: 'F6' });
  });

  it('Shift 单独修饰的普通键拒绝（会干扰页面输入）', () => {
    expect(recordingOutcome({ key: 'D', shift: true }).kind).toBe('invalid');
  });

  it('无修饰的字母/数字与命名键拒绝', () => {
    expect(recordingOutcome({ key: 'd' }).kind).toBe('invalid');
    expect(recordingOutcome({ key: '5' }).kind).toBe('invalid');
    expect(recordingOutcome({ key: 'Enter', control: true }).kind).toBe('invalid');
  });
});

describe('matchesAccelerator', () => {
  it('Ctrl 与 ⌘ 同义，Shift/Alt 精确匹配', () => {
    expect(matchesAccelerator({ key: 'd', control: true, shift: true }, 'CommandOrControl+Shift+D')).toBe(true);
    expect(matchesAccelerator({ key: 'D', meta: true, shift: true }, 'CommandOrControl+Shift+D')).toBe(true);
    expect(matchesAccelerator({ key: 'd', control: true }, 'CommandOrControl+Shift+D')).toBe(false);
    expect(matchesAccelerator({ key: 'd', control: true, alt: true }, 'CommandOrControl+D')).toBe(false);
    expect(matchesAccelerator({ key: 'd', control: true }, 'CommandOrControl+D')).toBe(true);
  });

  it('keyUp 不命中', () => {
    expect(matchesAccelerator({ type: 'keyUp', key: 'd', control: true }, 'CommandOrControl+D')).toBe(false);
  });

  it('Plus 与 = 各自精确匹配', () => {
    expect(matchesAccelerator({ key: '+', control: true, shift: true }, 'CommandOrControl+Shift+Plus')).toBe(true);
    expect(matchesAccelerator({ key: '=', control: true }, 'CommandOrControl+=')).toBe(true);
    // Shift+= 产生的 '+' 不应误命中无 Shift 的 '=' 绑定
    expect(matchesAccelerator({ key: '+', control: true, shift: true }, 'CommandOrControl+=')).toBe(false);
  });
});

describe('matchContentShortcut', () => {
  it('默认绑定下命中内容动作', () => {
    expect(matchContentShortcut(DEFAULT_SHORTCUTS, { key: 'f', control: true })).toBe('find');
    expect(matchContentShortcut(DEFAULT_SHORTCUTS, { key: 'r', control: true })).toBe('reload');
    expect(matchContentShortcut(DEFAULT_SHORTCUTS, { key: 'r', control: true, shift: true })).toBe('reload-hard');
    expect(matchContentShortcut(DEFAULT_SHORTCUTS, { key: '=', control: true })).toBe('zoom-in');
    expect(matchContentShortcut(DEFAULT_SHORTCUTS, { key: '0', control: true })).toBe('zoom-reset');
  });

  it('命令面板默认 Ctrl+K 命中（⌘ 同义）', () => {
    expect(matchContentShortcut(DEFAULT_SHORTCUTS, { key: 'k', control: true })).toBe('palette');
    expect(matchContentShortcut(DEFAULT_SHORTCUTS, { key: 'K', meta: true })).toBe('palette');
  });

  it('命令面板可重绑：解绑后 Ctrl+K 放行给页面', () => {
    const bindings = { ...DEFAULT_SHORTCUTS, palette: null } as const;
    expect(matchContentShortcut(bindings, { key: 'k', control: true })).toBeNull();
    const rebound = { ...DEFAULT_SHORTCUTS, palette: 'Alt+P' } as const;
    expect(matchContentShortcut(rebound, { key: 'p', alt: true })).toBe('palette');
  });

  it('全局动作不参与内容匹配；未命中返回 null', () => {
    expect(matchContentShortcut(DEFAULT_SHORTCUTS, { key: 'd', control: true, shift: true })).toBeNull();
    expect(matchContentShortcut(DEFAULT_SHORTCUTS, { key: 'g', control: true })).toBeNull();
  });

  it('解绑后不再命中；自定义绑定可命中', () => {
    const bindings = { ...DEFAULT_SHORTCUTS, find: null, reload: 'Alt+R' } as const;
    expect(matchContentShortcut(bindings, { key: 'f', control: true })).toBeNull();
    expect(matchContentShortcut(bindings, { key: 'r', alt: true })).toBe('reload');
  });
});

describe('normalizeShortcutBindings / serializeShortcutBindings', () => {
  it('缺省字段回默认；非法值丢弃回默认', () => {
    const b = normalizeShortcutBindings({ find: 'Ctrl+G', reload: 'not@@valid' });
    expect(b.find).toBe('CommandOrControl+G');
    expect(b.reload).toBe(DEFAULT_SHORTCUTS.reload);
    expect(b['zoom-in']).toBe(DEFAULT_SHORTCUTS['zoom-in']);
  });

  it('空字符串 = 显式解绑；整体非法输入回全默认', () => {
    expect(normalizeShortcutBindings({ 'zoom-out': '' })['zoom-out']).toBeNull();
    expect(normalizeShortcutBindings(null)['global-toggle-window']).toBe(DEFAULT_SHORTCUTS['global-toggle-window']);
    expect(normalizeShortcutBindings('x').find).toBe(DEFAULT_SHORTCUTS.find);
  });

  it('序列化后可无损还原（round-trip）', () => {
    const b = { ...DEFAULT_SHORTCUTS, find: null, 'zoom-in': 'Alt+Plus' };
    const restored = normalizeShortcutBindings(serializeShortcutBindings(b));
    expect(restored).toEqual(b);
  });
});

describe('findShortcutConflicts / conflictsFor', () => {
  it('同一加速器绑多个动作被检出（含跨作用域）', () => {
    const b = { ...DEFAULT_SHORTCUTS, reload: 'CommandOrControl+F' } satisfies typeof DEFAULT_SHORTCUTS;
    const conflicts = findShortcutConflicts(b);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].accelerator).toBe('CommandOrControl+F');
    expect(conflicts[0].actions.sort()).toEqual(['find', 'reload']);
  });

  it('解绑不参与冲突', () => {
    // find 解绑后，reload 占用原 find 的组合不再算冲突
    const b = { ...DEFAULT_SHORTCUTS, find: null, reload: 'CommandOrControl+F' };
    expect(findShortcutConflicts(b)).toHaveLength(0);
  });

  it('conflictsFor 返回冲突的对方动作', () => {
    expect(conflictsFor('reload', 'CommandOrControl+F', DEFAULT_SHORTCUTS)).toEqual(['find']);
    expect(conflictsFor('reload', 'CommandOrControl+G', DEFAULT_SHORTCUTS)).toEqual([]);
  });
});

describe('formatAcceleratorForDisplay', () => {
  it('Windows/Linux 显示 Ctrl、mac 显示 ⌘，Plus 还原为 +', () => {
    expect(formatAcceleratorForDisplay('CommandOrControl+Shift+D', false)).toBe('Ctrl+Shift+D');
    expect(formatAcceleratorForDisplay('CommandOrControl+Shift+D', true)).toBe('⌘+Shift+D');
    expect(formatAcceleratorForDisplay('Alt+Plus', false)).toBe('Alt++');
  });

  it('空值显示未绑定', () => {
    expect(formatAcceleratorForDisplay(null, false)).toBe('未绑定');
    expect(formatAcceleratorForDisplay('', false)).toBe('未绑定');
    expect(formatAcceleratorForDisplay(undefined, false)).toBe('未绑定');
  });
});

describe('isShortcutAction / SHORTCUT_ACTIONS', () => {
  it('动作名校验', () => {
    for (const a of SHORTCUT_ACTIONS) expect(isShortcutAction(a)).toBe(true);
    expect(isShortcutAction('nope')).toBe(false);
    expect(isShortcutAction(123)).toBe(false);
  });
});
