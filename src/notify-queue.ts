// 桌面通知请求队列的状态机（纯函数，无 Electron/fs 依赖）。
//
// DSH 侧的 cordis 插件不直接调用 Electron API：它们把通知请求写进共享配置
// （$DSH_HOME/desktop-shell.json 的 notifyRequest 字段），外壳轮询/watch 到后
// 在这里取走并弹系统通知，最后清除请求 —— 一条请求只弹一次，外壳进程重启
// 不会重复弹启动前积累的通知（启动时初始化为「已处理」）。

export interface NotifyRequest {
  /** 请求唯一 id：外壳只处理与上次已处理 id 不同的请求。 */
  id: string;
  /** 通知标题（插件固定文案，如「DSH 通知」「每日花费告警」）。 */
  title: string;
  /** 通知正文（直接展示，不含 HTML 语义）。 */
  body: string;
  /** 静默通知（不响铃）：如定时勿扰场景下插件仍想推送的提醒。 */
  silent?: boolean;
}

/** 从共享配置快照提取待处理通知：字段非法或与已处理 id 相同 → null。 */
export function takeNotifyRequest(cfg: { notifyRequest?: NotifyRequest }, lastHandledId: string | null): NotifyRequest | null {
  const req = cfg.notifyRequest;
  if (!req || typeof req !== 'object') return null;
  if (typeof req.id !== 'string' || req.id.length === 0) return null;
  if (typeof req.title !== 'string' || req.title.length === 0) return null;
  if (typeof req.body !== 'string' || req.body.length === 0) return null;
  if (req.id === lastHandledId) return null;
  return { id: req.id, title: req.title, body: req.body, silent: req.silent === true };
}

/** 处理完成后的清除 patch：saveSharedConfig 合并回写，notifyRequest 字段随之删除。 */
export function clearNotifyPatch(): { notifyRequest: undefined } {
  return { notifyRequest: undefined };
}

/** 生成唯一请求 id（时间戳 + 随机段；同毫秒多命令不冲突）。 */
export function makeNotifyId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
