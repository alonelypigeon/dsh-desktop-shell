import { shell, type WebContents } from 'electron';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// DSH 页面用不到的敏感权限一律拒绝；剪贴板/通知/全屏等常规能力放行，
// 避免远程页面借此调用本机摄像头、麦克风、定位或外设。
const DENIED_PERMISSIONS = new Set([
  'camera',
  'microphone',
  'media', // getUserMedia 的旧式聚合权限名
  'geolocation',
  'midi',
  'midiSysex',
  'hid',
  'serial',
  'usb',
  'bluetooth',
  'display-capture',
  'keyboardLock',
  'window-management',
  'openExternal',
]);

// 外链安全策略：只允许 http/https 交给系统浏览器，其余协议
//（file:、smb:、tel:、自定义 scheme 等）一律丢弃并记录，防止本地资源被系统侧打开。
function openExternalSafe(rawUrl: string): void {
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
  contents.on('will-navigate', (e, url) => {
    try {
      if (new URL(url).origin !== dshOrigin) {
        e.preventDefault();
        openExternalSafe(url);
      }
    } catch {
      e.preventDefault();
      console.warn(`[security] blocked unparseable navigation: ${url}`);
    }
  });

  // 权限策略：拒绝敏感设备权限（见 DENIED_PERMISSIONS）。
  const { session } = contents;
  session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(!DENIED_PERMISSIONS.has(permission));
  });
  session.setPermissionCheckHandler((_wc, permission) => !DENIED_PERMISSIONS.has(permission));
}
