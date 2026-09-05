/**
 * 自动更新模块（主进程）
 *
 * 基于 electron-updater，支持 DMG（macOS）自动更新。提供两种 provider：
 * - github：GitHub Releases（需仓库公开/配置 token）
 * - generic：自建静态服务器（内网场景推荐）
 *
 * 更新源可在 settings.json 的 `updateFeed` 字段配置；未配置时不启用自动检查，
 * 仅暴露手动检查接口。更新特性通过 IPC 通知渲染进程。
 */
import { app, ipcMain } from 'electron';
import logger from 'electron-log';
import { autoUpdater } from 'electron-updater';

export interface UpdateFeedConfig {
  provider: 'github' | 'generic';
  /** github 仓库 owner（默认取 package.json publish 的 owner） */
  owner?: string;
  /** github 仓库名（默认取 package.json publish 的 repo） */
  repo?: string;
  /** generic: 例如 https://updates.example.com/echoly/ */
  genericUrl?: string;
  /**
   * 私有仓库下载令牌（GitHub Personal Access Token）。
   * electron-updater 会将其作为 Authorization: token <token> 头加到所有更新请求，
   * 从而允许从私有 Release 拉取 latest-mac.yml 与 DMG。
   * 仅保存在本机 settings.json；分发给特定用户时由该用户自行配置。
   */
  token?: string;
}

const GH_OWNER = 'DanielCraig07';
const GH_REPO = 'Echoly';

let feed: UpdateFeedConfig | null = null;
let checked = false;

function configureUpdater(updateFeed: UpdateFeedConfig | null): void {
  feed = updateFeed;
  if (!feed) {
    logger.info('[updater] No update feed configured; auto-update disabled');
    return;
  }
  autoUpdater.logger = logger;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (err) => logger.error('[updater]', err));
  autoUpdater.on('update-available', (info) => {
    logger.info('[updater] update available', info.version);
  });
}

export function initUpdater(getUpdateFeed: () => UpdateFeedConfig | null): void {
  configureUpdater(getUpdateFeed());

  ipcMain.handle('updater:check', async () => {
    const cfg = getUpdateFeed();
    if (!cfg) {
      return { ok: false, detail: '未配置更新源' };
    }
    configureUpdater(cfg);

    if (cfg.provider === 'github') {
      // GitHub Releases。electron-updater 读取 latest-mac.yml（electron-builder publish
      // 时生成并随 Release 上传）。owner/repo 优先取 settings，回退默认。
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: cfg.owner || GH_OWNER,
        repo: cfg.repo || GH_REPO,
      });
      // 私有仓库：注入 token 作为请求头，使匿名不可访问的 Release 也能被拉取。
      if (cfg.token) {
        autoUpdater.addAuthHeader(cfg.token);
      }
    } else if (cfg.genericUrl) {
      autoUpdater.setFeedURL({ provider: 'generic', url: cfg.genericUrl });
    }

    try {
      // 强制检查（即使 autoUpdater 认为是 dev 模式）
      await autoUpdater.checkForUpdates();
      checked = true;
      return { ok: true, detail: '' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[updater] check failed', message);
      return { ok: false, detail: message };
    }
  });

  ipcMain.handle('updater:getState', () => ({ checked, feed: feed ?? null }));
}

export function quitAndInstallUpdate(): void {
  if (feed) {
    autoUpdater.quitAndInstall();
  }
}
