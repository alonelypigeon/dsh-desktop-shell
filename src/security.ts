import { shell, type WebContents } from 'electron';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// 已安装的 will-navigate 守卫（按 webContents 记录）。
// attachSecurity 会在切换服务器时对同一个内容视图重复调用：必须先摘掉
// 旧监听器再挂新的，否则旧 origin 的守卫会把新服务器的站内导航全部
// 误判为「偏离源」拦截并甩给系统浏览器。
const installedGuards = new WeakMap<WebContents, (e: Electron.Event, url: string) => void>();

// 权限白名单：仅放行常规无害能力，其余（含 Electron 未来新增的敏感权限）
// 一律默认拒绝——比黑名单更安全，不会随权限名演进而出现漏网。
const ALLOWED_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'notifications',
  'pointerLock',
]);

// 外链安全策略：只允许 http/https 交给系统浏览器，其余协议
//（file:、smb:、tel:、自定义 scheme 等）一律丢弃并记录，防止本地资源被系统侧打开。
export function openExternalSafe(rawUrl: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    console.warn(`[security] ignored invalid external url: ${rawUrl}`);
    return;
  }
  if (ALLOWED_PROTOCOLS.has(u.protocol)) {
    void shell.openExternal(u.toString());
  } else {
    console.warn(`[security] blocked external protocol: ${u.protocol} (${rawUrl})`);
  }
}

// 给加载 DSH 页面的 webContents 挂上导航/弹窗外链守卫 + 权限策略。
export function attachSecurity(contents: WebContents, dshOrigin: string): void {
  // 新窗口（window.open / target=_blank）→ 一律 deny，并把 URL 转交系统浏览器。
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  // 页面内导航偏离 DSH 源 → 拦截并外开（仅放行 http/https）。
  // 幂等：先移除上一次安装的守卫（见 installedGuards 注释）。
  const prevGuard = installedGuards.get(contents);
  if (prevGuard) contents.removeListener('will-navigate', prevGuard);
  const guard = (e: Electron.Event, url: string): void => {
    try {
      if (new URL(url).origin !== dshOrigin) {
        e.preventDefault();
        openExternalSafe(url);
      }
    } catch {
      e.preventDefault();
      console.warn(`[security] blocked unparseable navigation: ${url}`);
    }
  };
  installedGuards.set(contents, guard);
  contents.on('will-navigate', guard);

  // 权限策略：白名单之外全部拒绝（摄像头/麦克风/定位/外设等，见 ALLOWED_PERMISSIONS）。
  const { session } = contents;
  session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
}
