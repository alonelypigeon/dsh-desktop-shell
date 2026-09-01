import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import { openExternalSafe } from './security';
import { stripHtmlToText, truncateText } from './release-notes';

const RELEASES_PAGE = 'https://github.com/alonelypigeon/dsh-desktop-shell/releases';

// electron-builder 的 portable 目标无法 in-place 自动更新（已知限制）：
// 检测到 portable 运行时改走「打开 Releases 页手动下载」。
function isPortableBuild(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
}

// releaseNotes 可能是 string / {note} / {url}（GitHub provider 下通常是 release
// body 字符串）。统一剥成纯文本，弹窗里可读。
function releaseNotesText(raw: unknown): string {
  if (typeof raw === 'string') return truncateText(stripHtmlToText(raw));
  if (raw && typeof raw === 'object') {
    const r = raw as { note?: unknown; notes?: unknown; url?: unknown };
    if (typeof r.note === 'string') return truncateText(stripHtmlToText(r.note));
    if (typeof r.notes === 'string') return truncateText(stripHtmlToText(r.notes));
    if (typeof r.url === 'string') return `完整说明：${r.url}`;
  }
  return '';
}

// 由共享配置轮询（cordis 插件写入 updateRequest）触发的一次显式检查。
export function checkForUpdatesNow(): void {
  if (!app.isPackaged) {
    console.log('[updater] check skipped (not packaged)');
    return;
  }
  if (isPortableBuild()) {
    void (async () => {
      const r = await dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: 'Portable 版不支持应用内自动更新',
        detail: '是否打开 GitHub Releases 页面手动下载最新版本？',
        buttons: ['打开下载页', '取消'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r.response === 0) openExternalSafe(RELEASES_PAGE);
    })();
    return;
  }
  void autoUpdater.checkForUpdates().catch((e) => console.error('[updater] check failed:', e.message));
}

// 自动更新：仅在打包后生效。dev 环境跳过，避免影响开发。
// portable 版跳过整套 updater（无法 in-place 安装，入口见 checkForUpdatesNow）。
// 可通过 DSH_UPDATE_URL 环境变量覆盖更新源（generic provider，仅限 https：
// 安装包未做代码签名，经 http 分发可被中间人替换后诱导安装）。
export function setupAutoUpdater(): void {
  if (!app.isPackaged) {
    console.log('[updater] skipped (not packaged)');
    return;
  }
  if (isPortableBuild()) {
    console.log('[updater] skipped (portable build; manual download only)');
    return;
  }

  try {
    const feed = process.env.DSH_UPDATE_URL?.trim();
    if (feed) {
      try {
        const u = new URL(feed);
        if (u.protocol !== 'https:') {
          console.warn(`[updater] DSH_UPDATE_URL 必须是 https 地址，已忽略: ${feed}`);
        } else {
          autoUpdater.setFeedURL({ provider: 'generic', url: u.toString() });
        }
      } catch {
        console.warn(`[updater] DSH_UPDATE_URL 无法解析，已忽略: ${feed}`);
      }
    }

    // 手动模式：先询问，用户同意再下载、再安装。
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('update-available', (info) => {
      void (async () => {
        const notes = releaseNotesText((info as { releaseNotes?: unknown }).releaseNotes);
        const r = await dialog.showMessageBox({
          type: 'info',
          title: '发现新版本',
          message: `新版本 ${info.version} 可用`,
          detail: (notes ? notes + '\n\n' : '') + '是否立即下载？',
          buttons: ['下载', '稍后'],
          defaultId: 0,
          cancelId: 1,
          checkboxLabel: '下载完成后，退出应用时自动安装',
          checkboxChecked: false,
        });
        if (r.response === 0) {
          if (r.checkboxChecked) autoUpdater.autoInstallOnAppQuit = true;
          void autoUpdater.downloadUpdate().catch((e) => console.error('[updater] download failed:', e));
        }
      })();
    });

    autoUpdater.on('update-downloaded', (info) => {
      void (async () => {
        // 已勾选「退出时安装」→ 不再打扰，退出时自动生效
        if (autoUpdater.autoInstallOnAppQuit) return;
        const r = await dialog.showMessageBox({
          type: 'info',
          title: '更新已就绪',
          message: `版本 ${info.version} 已下载完成`,
          detail: '是否立即重启并安装？',
          buttons: ['立即重启', '稍后'],
          defaultId: 0,
          cancelId: 1,
        });
        if (r.response === 0) {
          autoUpdater.quitAndInstall();
        }
      })();
    });

    autoUpdater.on('error', (e) => console.error('[updater] error:', e.message));

    // 默认源已固定为 electron-builder.yml 的 GitHub Releases（打包进 app-update.yml）。
    void autoUpdater.checkForUpdates().catch(() => {
      // 首次无更新或检查失败忽略，不打扰用户。
    });
  } catch (e) {
    console.warn('[updater] disabled:', e instanceof Error ? e.message : e);
  }
}
