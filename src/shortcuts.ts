// 快捷键绑定体系 —— 纯函数，可单测。
//
// 可绑定动作分两类作用域：
//   global  —— 全局热键（globalShortcut 注册，任意应用可用；默认唤起/收起窗口）
//   content —— 内容视图快捷键（主进程 before-input-event 在 DSH 页面上捕获）
// 绑定持久化在 shell-state.json 的 shortcuts 字段（'' = 显式解绑，缺省 = 默认值）。
//
// 加速器（accelerator）采用 Electron 记法：'CommandOrControl+Shift+D'。
// 键位 token 规则：单个可打印字符（字母统一大写；'+' 记作 'Plus'）或 F1–F24。

export type ShortcutAction =
  | 'global-toggle-window'
  | 'palette'
  | 'find'
  | 'reload'
  | 'reload-hard'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

export type ShortcutScope = 'global' | 'content';

export interface ShortcutMeta {
  label: string;
  description: string;
  scope: ShortcutScope;
}

// 展示顺序（设置面板分组：全局在前，内容视图按使用频率排列）
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  'global-toggle-window',
  'palette',
  'find',
  'reload',
  'reload-hard',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
];

export const SHORTCUT_META: Record<ShortcutAction, ShortcutMeta> = {
  'global-toggle-window': {
    label: '唤起 / 收起窗口',
    description: '全局热键，任何应用下可用',
    scope: 'global',
  },
  palette: {
    label: '命令面板',
    description: '呼出 / 收起命令面板（快速执行命令与切换连接）',
    scope: 'content',
  },
  find: {
    label: '页面内查找',
    description: '在当前 DSH 页面中查找文本',
    scope: 'content',
  },
  reload: {
    label: '重新加载页面',
    description: '普通刷新当前页面',
    scope: 'content',
  },
  'reload-hard': {
    label: '强制重新加载',
    description: '忽略缓存刷新当前页面',
    scope: 'content',
  },
  'zoom-in': {
    label: '放大页面',
    description: '按 Chromium 档位放大内容视图',
    scope: 'content',
  },
  'zoom-out': {
    label: '缩小页面',
    description: '按 Chromium 档位缩小内容视图',
    scope: 'content',
  },
  'zoom-reset': {
    label: '重置缩放',
    description: '恢复 100% 缩放',
    scope: 'content',
  },
};

/** 运行时绑定表；null = 显式解绑（该动作无快捷键，功能仍可从菜单触达）。 */
export type ShortcutBindings = Record<ShortcutAction, string | null>;

export const DEFAULT_SHORTCUTS: ShortcutBindings = {
  'global-toggle-window': 'CommandOrControl+Shift+D',
  palette: 'CommandOrControl+K',
  find: 'CommandOrControl+F',
  reload: 'CommandOrControl+R',
  'reload-hard': 'CommandOrControl+Shift+R',
  'zoom-in': 'CommandOrControl+=',
  'zoom-out': 'CommandOrControl+-',
  'zoom-reset': 'CommandOrControl+0',
};

export function isShortcutAction(v: unknown): v is ShortcutAction {
  return typeof v === 'string' && (SHORTCUT_ACTIONS as readonly string[]).includes(v);
}

// —— 加速器解析 / 校验 ——

const F_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;
const CTRL_TOKENS = new Set(['Ctrl', 'Control', 'CommandOrControl', 'Command', 'Cmd', 'Meta']);

// 键位 token 归一：'+' / 字面 'Plus' token → 'Plus'，单字符 → 大写，
// F1–F24 原样；其余（'Escape' 等命名键）不支持。
export function normalizeKeyToken(key: string): string | null {
  if (typeof key !== 'string' || key === '') return null;
  if (F_KEY.test(key)) return key;
  if (key === '+' || key === 'Plus') return 'Plus';
  if (key.length === 1) return key.toUpperCase();
  return null;
}

// 校验并归一化加速器字符串；非法返回 null。
// 修饰键归一为 CommandOrControl（Ctrl/⌘ 同义，绑定跨平台可用），顺序固定 Ctrl+Alt+Shift+键。
// 仅要求「有修饰键 或 F 功能键」（录制侧另有更严的规则，见 recordingOutcome）。
export function normalizeAccelerator(acc: string): string | null {
  if (typeof acc !== 'string' || acc.trim() === '') return null;
  const parts = acc.trim().split('+').filter((p) => p !== '');
  if (parts.length < 1) return null;
  const keyToken = normalizeKeyToken(parts[parts.length - 1]);
  if (keyToken === null) return null;
  let ctrl = false;
  let alt = false;
  let shift = false;
  for (const p of parts.slice(0, -1)) {
    if (CTRL_TOKENS.has(p)) ctrl = true;
    else if (p === 'Shift') shift = true;
    else if (p === 'Alt' || p === 'AltGr') alt = true;
    else return null;
  }
  if (!ctrl && !alt && !shift && !F_KEY.test(keyToken)) return null;
  const tokens: string[] = [];
  if (ctrl) tokens.push('CommandOrControl');
  if (alt) tokens.push('Alt');
  if (shift) tokens.push('Shift');
  tokens.push(keyToken);
  return tokens.join('+');
}

// —— 录制（设置面板里「按下新组合键」的判定） ——

export interface RawKeyEvent {
  key: string;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export type RecordingOutcome =
  | { kind: 'pending' } // 只按了修饰键，等待组合完成
  | { kind: 'cancel' } // Escape：取消录制
  | { kind: 'clear' } // Backspace/Delete：清除绑定
  | { kind: 'invalid'; reason: string }
  | { kind: 'ok'; accelerator: string };

// 录制规则比 normalizeAccelerator 更严：字母/数字/符号必须配合 Ctrl 或 Alt
// （Shift 单独修饰会干扰页面正常输入，不予绑定）；F 功能键可单独绑定。
export function recordingOutcome(ev: RawKeyEvent): RecordingOutcome {
  if (typeof ev.key !== 'string' || ev.key === '') return { kind: 'invalid', reason: '无效按键' };
  if (ev.key === 'Escape') return { kind: 'cancel' };
  if (ev.key === 'Backspace' || ev.key === 'Delete') return { kind: 'clear' };
  if (ev.key === 'Shift' || ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta') {
    return { kind: 'pending' };
  }
  const keyToken = normalizeKeyToken(ev.key);
  if (keyToken === null) return { kind: 'invalid', reason: `无法绑定按键：${ev.key}` };
  const ctrl = ev.control === true || ev.meta === true;
  const alt = ev.alt === true;
  if (!ctrl && !alt && !F_KEY.test(keyToken)) {
    return { kind: 'invalid', reason: '请配合 Ctrl 或 Alt（F 功能键可单独绑定）' };
  }
  const tokens: string[] = [];
  if (ctrl) tokens.push('CommandOrControl');
  if (alt) tokens.push('Alt');
  if (ev.shift === true) tokens.push('Shift');
  tokens.push(keyToken);
  const acc = tokens.join('+');
  const norm = normalizeAccelerator(acc);
  return norm === null ? { kind: 'invalid', reason: '无效的组合键' } : { kind: 'ok', accelerator: norm };
}

// —— 匹配（before-input-event / 菜单展示用） ——

export interface ShortcutKeyInput {
  /** before-input-event 的 input.type；只认 'keyDown'（缺省视为 keyDown）。 */
  type?: string;
  key: string;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

// input 是否命中加速器（Ctrl/⌘ 同义；Shift/Alt 精确匹配；键位大小写不敏感）。
export function matchesAccelerator(input: ShortcutKeyInput, acc: string): boolean {
  if (input.type && input.type !== 'keyDown') return false;
  const norm = normalizeAccelerator(acc);
  if (norm === null) return false;
  const parts = norm.split('+');
  const wantKey = parts[parts.length - 1];
  const wantCtrl = parts.includes('CommandOrControl');
  const wantAlt = parts.includes('Alt');
  const wantShift = parts.includes('Shift');
  const ctrl = input.control === true || input.meta === true;
  if (ctrl !== wantCtrl) return false;
  if ((input.alt === true) !== wantAlt) return false;
  if ((input.shift === true) !== wantShift) return false;
  return normalizeKeyToken(input.key) === wantKey;
}

// 在绑定表里找出 input 命中的内容视图动作；无命中返回 null（放行给 DSH 页面）。
export function matchContentShortcut(bindings: ShortcutBindings, input: ShortcutKeyInput): ShortcutAction | null {
  for (const action of SHORTCUT_ACTIONS) {
    if (SHORTCUT_META[action].scope !== 'content') continue;
    const acc = bindings[action];
    if (!acc) continue;
    if (matchesAccelerator(input, acc)) return action;
  }
  return null;
}

// —— 持久化 / 冲突 ——

// 从 shell-state.json 的原始值恢复绑定：缺省 → 默认；'' → 解绑；非法 → 默认。
export function normalizeShortcutBindings(raw: unknown): ShortcutBindings {
  const out: ShortcutBindings = { ...DEFAULT_SHORTCUTS };
  if (!raw || typeof raw !== 'object') return out;
  const rec = raw as Record<string, unknown>;
  for (const action of SHORTCUT_ACTIONS) {
    const v = rec[action];
    if (v === '') {
      out[action] = null;
      continue;
    }
    if (typeof v === 'string') {
      const norm = normalizeAccelerator(v);
      if (norm !== null) out[action] = norm;
    }
  }
  return out;
}

// 序列化回持久化格式（null → ''）。
export function serializeShortcutBindings(bindings: ShortcutBindings): Record<ShortcutAction, string> {
  const out = {} as Record<ShortcutAction, string>;
  for (const action of SHORTCUT_ACTIONS) {
    const acc = bindings[action];
    out[action] = acc ?? '';
  }
  return out;
}

export interface ShortcutConflict {
  accelerator: string;
  actions: ShortcutAction[];
}

// 同一加速器绑到多个动作 → 冲突（含跨作用域：全局热键会吞掉内容视图的同款组合）。
export function findShortcutConflicts(bindings: ShortcutBindings): ShortcutConflict[] {
  const map = new Map<string, ShortcutAction[]>();
  for (const action of SHORTCUT_ACTIONS) {
    const acc = bindings[action];
    if (!acc) continue;
    const list = map.get(acc) ?? [];
    list.push(action);
    map.set(acc, list);
  }
  return [...map.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([accelerator, actions]) => ({ accelerator, actions }));
}

// 绑定 action → acc 是否与其他动作冲突；冲突返回对方列表（用于设置面板提示与拒绝写入）。
export function conflictsFor(action: ShortcutAction, acc: string, bindings: ShortcutBindings): ShortcutAction[] {
  const others: ShortcutAction[] = [];
  for (const other of SHORTCUT_ACTIONS) {
    if (other === action) continue;
    if (bindings[other] === acc) others.push(other);
  }
  return others;
}

// —— 展示 ——

// 'CommandOrControl+Shift+D' → 'Ctrl+Shift+D'（mac 显示 '⌘'）；null/'' → '未绑定'。
export function formatAcceleratorForDisplay(acc: string | null | undefined, isMac: boolean): string {
  if (acc === null || acc === undefined || acc === '') return '未绑定';
  return acc
    .split('+')
    .map((t) => (t === 'CommandOrControl' ? (isMac ? '⌘' : 'Ctrl') : t === 'Plus' ? '+' : t))
    .join('+');
}
