import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

// 由共享配置轮询（cordis 插件写入 updateRequest）触发的一次显式检查。
export function checkForUpdatesNow(): void {
  if (!app.isPackaged) {
    console.log('[updater] check skipped (not packaged)');
    return;
  }
  void autoUpdater.checkForUpdates().catch((e) => console.error('[updater] check failed:', e.message));
}

// 自动更新：仅在打包后生效。dev 环境跳过，避免影响开发。
// 可通过 DSH_UPDATE_URL 环境变量覆盖更新源（generic provider）。
export function setupAutoUpdater(): void {
  if (!app.isPackaged) {
    console.log('[updater] skipped (not packaged)');
    return;
  }

  try {
    const feed = process.env.DSH_UPDATE_URL;
    if (feed) {
      autoUpdater.setFeedURL({ provider: 'generic', url: feed });
    }

    // 手动模式：先询问，用户同意再下载、再安装。
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('update-available', (info) => {
      void (async () => {
        const r = await dialog.showMessageBox({
          type: 'info',
          title: '发现新版本',
          message: `新版本 ${info.version} 可用`,
          detail: '是否立即下载？',
          buttons: ['下载', '稍后'],
          defaultId: 0,
          cancelId: 1,
        });
        if (r.response === 0) {
          void autoUpdater.downloadUpdate().catch((e) => console.error('[updater] download failed:', e));
        }
      })();
    });

    autoUpdater.on('update-downloaded', (info) => {
      void (async () => {
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

    // electron-builder.yml 里的 publish.url 是 example.com 占位符：
    // 打包进 app-update.yml 后每次启动都会白打一次无效请求，这里跳过初始检查，
    // 直到发布方改成真实地址（或运行时用 DSH_UPDATE_URL 覆盖）。
    const configuredFeed = (autoUpdater.getFeedURL?.() ?? '').toString();
    if (configuredFeed.includes('example.com')) {
      console.log('[updater] placeholder feed detected, initial check skipped (set DSH_UPDATE_URL to enable)');
      return;
    }

    void autoUpdater.checkForUpdates().catch(() => {
      // 首次无更新或检查失败忽略，不打扰用户。
    });
  } catch (e) {
    console.warn('[updater] disabled:', e instanceof Error ? e.message : e);
  }
}
