/**
 * 自动更新模块（主进程）
 *
 * 支持两种更新源：
 * - github（私有/公开仓库）：走 GitHub REST API（api.github.com + token）。
 *   electron-updater 的 GitHub provider 使用 github.com 网页端接口
 *   （releases.atom / releases/download），私有仓库下这些地址恒返回 404，
 *   因此这里自研 API 方案，保证私有仓库也能检查与下载。
 * - generic（自建服务器）：使用 electron-updater。
 *
 * 更新源在 settings.json 的 `updateFeed` 字段配置；未配置时不启用自动检查，
 * 仅暴露手动检查接口。
 */
import { app, ipcMain, BrowserWindow } from 'electron';
import logger from 'electron-log';
import { autoUpdater } from 'electron-updater';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface UpdateFeedConfig {
  provider: 'github' | 'generic';
  /** github 仓库 owner（默认 DanielCraig07） */
  owner?: string;
  /** github 仓库名（默认 Echoly） */
  repo?: string;
  /** generic 静态服务器地址 */
  genericUrl?: string;
  /** 私有仓库访问令牌（GitHub PAT，仅存本机，safeStorage 加密）。 */
  token?: string;
}

const GH_OWNER = 'DanielCraig07';
const GH_REPO = 'Echoly';
const API_BASE = 'https://api.github.com';

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
}

/** GitHub REST 请求。返回解析后的 JSON；非 2xx 抛错。 */
async function ghJson<T>(urlPath: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Echoly-Updater',
  };
  if (token) headers.Authorization = `bearer ${token}`;
  const res = await fetch(`${API_BASE}${urlPath}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.error(`[updater] ghJson ${urlPath} -> ${res.status}: ${body.slice(0, 200)}`);
    throw new Error(`GitHub API ${res.status}`);
  }
  return (await res.json()) as T;
}

/** 下载资产（带 token）。支持流式读取并回传下载进度。 */
async function ghAsset(
  assetId: number,
  token: string | undefined,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Buffer> {
  const headers: Record<string, string> = {
    Accept: 'application/octet-stream',
    'User-Agent': 'Echoly-Updater',
  };
  if (token) headers.Authorization = `bearer ${token}`;
  const res = await fetch(
    `${API_BASE}/repos/${feed?.owner || GH_OWNER}/${feed?.repo || GH_REPO}/releases/assets/${assetId}`,
    {
      headers,
    },
  );
  if (!res.ok) throw new Error(`GitHub asset download ${res.status}`);

  // 无 content-length 或未传回调时，直接整体读取
  const contentLength = Number(res.headers.get('content-length') || 0);
  if (!contentLength || !onProgress || !res.body) {
    return Buffer.from(await res.arrayBuffer());
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, contentLength);
    }
  }
  return Buffer.concat(chunks);
}

/** 广播更新进度到所有窗口。 */
function emitProgress(loaded: number, total: number, phase: 'download' | 'done'): void {
  const payload = {
    phase,
    loaded,
    total,
    percent: total > 0 ? Math.round((loaded / total) * 100) : 0,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:progress', payload);
  }
}

interface GhReleaseAsset {
  id: number;
  name: string;
  size: number;
}
interface GhRelease {
  tag_name: string;
  name: string | null;
  assets: GhReleaseAsset[];
  html_url: string;
}

/** 解析 electron-builder 的 latest-mac.yml（仅取所需字段）。 */
function parseLatestYml(text: string): {
  version: string;
  url: string;
  sha512: string;
  size: number;
} | null {
  const m = text.match(/version:\s*(\S+)/);
  if (!m) return null;
  const url = text.match(/^\s*-\s*url:\s*(\S+)/m)?.[1] || '';
  const sha512 = text.match(/sha512:\s*(\S+)/)?.[1] || '';
  const size = Number(text.match(/size:\s*(\d+)/)?.[1] || 0);
  return { version: m[1], url, sha512, size };
}

function sha512base64(buf: Buffer): string {
  return createHash('sha512').update(buf).digest('base64');
}

async function checkGitHub(
  cfg: UpdateFeedConfig,
): Promise<{ ok: boolean; detail: string; version?: string }> {
  const owner = cfg.owner || GH_OWNER;
  const repo = cfg.repo || GH_REPO;
  const token = cfg.token;

  // 1) 最新 release
  let release: GhRelease;
  try {
    release = await ghJson<GhRelease>(`/repos/${owner}/${repo}/releases/latest`, token);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `无法获取版本：${detail}` };
  }

  const channelFile = process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
  const ymlAsset = release.assets.find((a) => a.name === channelFile);
  if (!ymlAsset) {
    return { ok: false, detail: `发布资产缺少 ${channelFile}` };
  }

  // 2) 下载并解析 latest-*.yml
  let ymlText: string;
  try {
    ymlText = (await ghAsset(ymlAsset.id, token)).toString('utf8');
  } catch (err) {
    return {
      ok: false,
      detail: `读取更新清单失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const info = parseLatestYml(ymlText);
  if (!info) return { ok: false, detail: '更新清单格式无法解析' };

  const current = app.getVersion();
  const isNewer = (() => {
    const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    return cmp(info.version, current) > 0;
  })();

  if (!isNewer) {
    return { ok: true, detail: `已是最新版本（${current}）`, version: current };
  }

  // 3) 下载 DMG / 安装包资产
  const pkgAsset = release.assets.find((a) => a.name === info.url);
  if (!pkgAsset) {
    return { ok: false, detail: `未找到安装包资产 ${info.url}` };
  }

  logger.info(
    `[updater] 发现新版本 ${info.version}，开始下载 ${pkgAsset.name} (${(pkgAsset.size / 1024 / 1024).toFixed(1)}MB)`,
  );
  // 下载时上报进度，供渲染层显示进度条
  const buf = await ghAsset(pkgAsset.id, token, (loaded, total) =>
    emitProgress(loaded, total, 'download'),
  );
  emitProgress(1, 1, 'done');

  // 4) 校验 sha512（electron-builder 的 sha512 是 base64）
  if (info.sha512) {
    const actual = sha512base64(buf);
    if (actual !== info.sha512) {
      logger.error('[updater] sha512 校验失败');
      return { ok: false, detail: '安装包校验失败（sha512 不匹配）' };
    }
  }

  // 5) 保存到临时目录并打开安装包
  const downloads = path.join(app.getPath('userData'), 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const dest = path.join(downloads, pkgAsset.name);
  fs.writeFileSync(dest, buf);

  const { shell } = await import('electron');
  try {
    await shell.openPath(dest);
  } catch {
    /* ignore */
  }

  return {
    ok: true,
    detail: `检测到新版本 ${info.version}，安装包已下载并打开。`,
    version: info.version,
  };
}

export function initUpdater(getUpdateFeed: () => UpdateFeedConfig | null): void {
  configureUpdater(getUpdateFeed());

  ipcMain.handle('updater:check', async () => {
    const cfg = getUpdateFeed();
    if (!cfg) return { ok: false, detail: '未配置更新源' };
    feed = cfg;

    try {
      if (cfg.provider === 'github') {
        const result = await checkGitHub(cfg);
        checked = result.ok;
        return result;
      }
      if (cfg.genericUrl) {
        autoUpdater.setFeedURL({ provider: 'generic', url: cfg.genericUrl });
        await autoUpdater.checkForUpdates();
        checked = true;
        return { ok: true, detail: '' };
      }
      return { ok: false, detail: '未知更新源' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error('[updater] check failed', detail);
      return { ok: false, detail };
    }
  });

  ipcMain.handle('updater:getState', () => ({ checked, feed: feed ?? null }));
}

export function quitAndInstallUpdate(): void {
  if (feed?.provider === 'generic') {
    autoUpdater.quitAndInstall();
  }
  // github 方案通过打开安装包让用户手动完成，无静默安装。
}
