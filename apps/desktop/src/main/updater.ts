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
  for (; ;) {
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
  body?: string | null;
  assets: GhReleaseAsset[];
  html_url: string;
}

/** 检查结果：仅探测，不下载。 */
interface UpdateProbe {
  hasUpdate: boolean;
  version?: string;
  current?: string;
  releaseNotes?: string;
  detail?: string;
  /** 用于后续 downloadAndInstall 的目标资产（前端不感知）。 */
  target?: GhReleaseAsset;
  owner?: string;
  repo?: string;
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

/** 仅探测是否有新版本，返回版本说明与目标资产，不发起下载。 */
async function probeUpdate(cfg: UpdateFeedConfig): Promise<UpdateProbe> {
  const owner = cfg.owner || GH_OWNER;
  const repo = cfg.repo || GH_REPO;
  const token = cfg.token;

  let release: GhRelease;
  try {
    release = await ghJson<GhRelease>(`/repos/${owner}/${repo}/releases/latest`, token);
  } catch (err) {
    return {
      hasUpdate: false,
      detail: `无法获取版本：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const channelFile = process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
  const ymlAsset = release.assets.find((a) => a.name === channelFile);
  if (!ymlAsset) {
    return { hasUpdate: false, detail: `发布资产缺少 ${channelFile}` };
  }

  let ymlText: string;
  try {
    ymlText = (await ghAsset(ymlAsset.id, token)).toString('utf8');
  } catch (err) {
    return {
      hasUpdate: false,
      detail: `读取更新清单失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const info = parseLatestYml(ymlText);
  if (!info) return { hasUpdate: false, detail: '更新清单格式无法解析' };

  const current = app.getVersion();
  const isNewer = (() => {
    const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    return cmp(info.version, current) > 0;
  })();

  if (!isNewer) {
    return { hasUpdate: false, current, detail: `已是最新版本（${current}）` };
  }

  const pkgAsset = release.assets.find((a) => a.name === info.url);
  if (!pkgAsset) {
    return { hasUpdate: false, detail: `未找到安装包资产 ${info.url}` };
  }

  return {
    hasUpdate: true,
    version: info.version,
    current,
    releaseNotes: release.body || '',
    target: pkgAsset,
    owner,
    repo,
  };
}

/** 下载并安装：先保存到本地，再打开安装包，然后彻底退出当前应用。 */
async function downloadAndInstall(cfg: UpdateFeedConfig): Promise<{ ok: boolean; detail: string }> {
  const owner = cfg.owner || GH_OWNER;
  const repo = cfg.repo || GH_REPO;
  const token = cfg.token;

  const probe = await probeUpdate(cfg);
  if (!probe.hasUpdate || !probe.target) {
    return { ok: false, detail: probe.detail || '未发现新版本' };
  }

  const pkgAsset = probe.target;
  logger.info(
    `[updater] 开始下载 ${pkgAsset.name} (${(pkgAsset.size / 1024 / 1024).toFixed(1)}MB)`,
  );

  // 下载并上报进度
  const buf = await ghAsset(pkgAsset.id, token, (loaded, total) =>
    emitProgress(loaded, total, 'download'),
  );
  emitProgress(1, 1, 'done');

  // 校验 sha512（electron-builder 的 sha512 是 base64）
  const sha512 = await readSha512FromLatestYml(owner, repo, token);
  if (sha512) {
    const actual = sha512base64(buf);
    if (actual !== sha512) {
      logger.error('[updater] sha512 校验失败');
      return { ok: false, detail: '安装包校验失败（sha512 不匹配）' };
    }
  }

  // 保存到用户数据目录
  const downloads = path.join(app.getPath('userData'), 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const dest = path.join(downloads, pkgAsset.name);
  fs.writeFileSync(dest, buf);

  // 打开安装包（macOS 挂载 DMG / Windows 启动 Setup.exe）。
  // 安装包进程独立于本应用，之后彻底退出当前应用，避免"应用正在运行"导致安装失败。
  const { shell } = await import('electron');
  try {
    await shell.openPath(dest);
  } catch {
    /* ignore */
  }

  // 稍等片刻让安装进程启动，再退出应用
  setTimeout(() => {
    try {
      app.exit(0);
    } catch {
      /* ignore */
    }
  }, 800);

  return { ok: true, detail: `新版本 ${probe.version} 已下载，正在打开安装程序并退出当前应用。` };
}

/** 读取远端 latest-*.yml 里的 sha512（用于下载后校验）。 */
async function readSha512FromLatestYml(
  owner: string,
  repo: string,
  token?: string,
): Promise<string> {
  try {
    const channelFile = process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
    const release = await ghJson<GhRelease>(`/repos/${owner}/${repo}/releases/latest`, token);
    const ymlAsset = release.assets.find((a) => a.name === channelFile);
    if (!ymlAsset) return '';
    const text = (await ghAsset(ymlAsset.id, token)).toString('utf8');
    return text.match(/sha512:\s*(\S+)/)?.[1] || '';
  } catch {
    return '';
  }
}

export function initUpdater(getUpdateFeed: () => UpdateFeedConfig | null): void {
  configureUpdater(getUpdateFeed());

  // 1) 仅探测：返回是否有新版本 + 版本说明（不下载）
  ipcMain.handle('updater:check', async () => {
    const cfg = getUpdateFeed();
    if (!cfg) return { ok: false, detail: '未配置更新源' };
    feed = cfg;

    try {
      if (cfg.provider === 'github') {
        const result = await probeUpdate(cfg);
        checked = result.hasUpdate;
        return {
          ok: true,
          hasUpdate: result.hasUpdate,
          version: result.version,
          current: result.current,
          releaseNotes: result.releaseNotes || '',
          detail: result.detail || '',
        };
      }
      if (cfg.genericUrl) {
        // generic 走 electron-updater 检查（会把下载也一并开始），这里仅尽可能返回可用性
        autoUpdater.setFeedURL({ provider: 'generic', url: cfg.genericUrl });
        const info = await autoUpdater.checkForUpdates();
        checked = true;
        return { ok: true, hasUpdate: !!info, detail: '' };
      }
      return { ok: false, detail: '未知更新源' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error('[updater] check failed', detail);
      return { ok: false, detail };
    }
  });

  // 2) 确认后再下载并安装：下载 → 打开安装包 → 退出当前应用
  ipcMain.handle('updater:download', async () => {
    const cfg = getUpdateFeed();
    if (!cfg) return { ok: false, detail: '未配置更新源' };
    feed = cfg;

    try {
      if (cfg.provider === 'github') {
        return await downloadAndInstall(cfg);
      }
      if (cfg.genericUrl) {
        autoUpdater.setFeedURL({ provider: 'generic', url: cfg.genericUrl });
        await autoUpdater.checkForUpdates();
        autoUpdater.quitAndInstall();
        return { ok: true, detail: '开始下载并安装。' };
      }
      return { ok: false, detail: '未知更新源' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error('[updater] download failed', detail);
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
