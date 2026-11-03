/**
 * 扩展详情页 —— 在编辑器区打开的「扩展说明」标签。
 *
 * 形态参考稿：上半是图标 + 名字 + 发布者 + 下载量/评分 + 操作按钮，下半左主右辅
 * ——左边 README 正文，右边一列元信息（标识符 / 版本 / 体积 / 分类 / 资源）。
 *
 * 数据由这个组件自己去拉（详情接口 + README），不从面板传进来：
 * 详情页是个叶子视图，标签可以独立打开、独立关闭，让它依赖面板的状态会凭空多一层耦合。
 * 只有「装完之后面板要刷新」这一件事需要跨组件 —— 用一个 window 事件通知，见下。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '../i18n';
import type { MarketplaceDetailEntry } from '@deepseek-ide/shared';
import { stripRawHtml } from '../services/extensionReadme';
import { DbConfirmModal } from './DbConfirmModal';
import { CLAUDE_CODE_ID } from '../services/claudeCode';
import {
  formatDownloadCount,
  formatRating,
  friendlyExtensionName,
  iconInitial,
  publisherOf,
} from '../services/extensionDisplay';

/**
 * 扩展详情标签的虚拟路径前缀：`ext://detail/<publisher.name>`。
 *
 * 定义在这里而不是 App 里：打开方（面板/命令）与渲染方（编辑器）都要用它，
 * 各写一个字面量迟早会漂移成两个不同的字符串。
 */
export const EXTENSION_DETAIL_PREFIX = 'ext://detail/';

/** 面板订阅这个事件来刷新已安装列表。 */
export const EXTENSION_INSTALLED_EVENT = 'echoly:extension-installed';

export interface ExtensionDetailViewProps {
  /** `publisher.name` */
  extensionId: string;
  onShowToast?: (message: string, type?: 'info' | 'error' | 'success') => void;
}

/** 把 ISO 时间戳格式化成 `2026-10-13 11:37`；解析不了时原样返回，不显示 "Invalid Date"。 */
function formatTimestamp(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 体积：1.2MB / 840KB。 */
function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

/** 星级：四舍五入到半星，用实心/半/空三种字符表示。 */
function ratingStars(rating: number | undefined): string {
  if (rating === undefined || !Number.isFinite(rating) || rating <= 0) return '';
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return '★'.repeat(full) + (half ? '☆' : '') + '·'.repeat(0);
}

export function ExtensionDetailView({ extensionId, onShowToast }: ExtensionDetailViewProps) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<MarketplaceDetailEntry | null>(null);
  const [readme, setReadme] = useState<string>('');
  const [state, setState] = useState<'loading' | 'done' | 'failed'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [iconData, setIconData] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  /** 已安装时的完整信息（启用状态、贡献的视图）——决定「打开/禁用/卸载」谁能点。 */
  const [installedInfo, setInstalledInfo] = useState<{
    id: string;
    displayName: string;
    version?: string;
    enabled: boolean;
    active: boolean;
    commands: { command: string; title: string }[];
    views: string[];
  } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const title = detail?.displayName || friendlyExtensionName(extensionId);
  const publisher = publisherOf(extensionId);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const [res, listed] = await Promise.all([
        window.extensions.getExtensionDetail(extensionId),
        window.extensions.listInstalled?.() ?? Promise.resolve(undefined),
      ]);
      /**
       * 匹配用「相等 或 互相包含」：扩展自报的 id 与注册表里的 id 大小写、后缀
       * 偶有出入，严格相等会让一个明明装好的扩展显示成「未安装」。
       */
      const target = extensionId.toLowerCase();
      const matchId = (e: string) => {
        const id = e.toLowerCase();
        return id === target || id.includes(target) || target.includes(id);
      };
      const hit =
        listed?.success && listed.extensions
          ? listed.extensions.find((e) => matchId(e.id))
          : undefined;
      if (hit) {
        setInstalled(true);
        setInstalledInfo({
          id: hit.id,
          displayName: hit.displayName || friendlyExtensionName(hit.id),
          version: hit.version,
          enabled: hit.enabled,
          active: hit.active,
          commands: hit.commands ?? [],
          views: hit.views ?? [],
        });
      } else {
        setInstalled(false);
        setInstalledInfo(null);
      }
      if (!res?.ok || !res.detail) {
        setState('failed');
        setError(res?.error || t('extDetail.loadFailed'));
        return;
      }
      setDetail(res.detail);
      setReadme(res.readme ?? '');
      setState('done');
    } catch (err: any) {
      setState('failed');
      setError(err?.message || t('extDetail.loadFailed'));
    }
  }, [extensionId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 图标：拿到详情后才知道地址，再走主进程代理换 data URL
  useEffect(() => {
    const iconUrl = detail?.iconUrl;
    if (!iconUrl) return;
    let cancelled = false;
    void window.extensions
      .getIconDataUrl(iconUrl)
      .then((data) => {
        if (!cancelled) setIconData(data);
      })
      .catch(() => {
        if (!cancelled) setIconData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.iconUrl]);

  /**
   * Claude Code 走专用安装通道。
   *
   * 它在注册表上只有**平台专属构建**（`@darwin-arm64` / `@alpine-arm64` …），
   * 而注册表搜索接口不按当前机器过滤 —— 走通用的 installFromMarketplace 有可能
   * 在 macOS 上装到 alpine 的包。专用通道按本机去 VS Code 市场取对应构建。
   */
  const usesDedicatedChannel = extensionId.toLowerCase() === CLAUDE_CODE_ID.toLowerCase();

  /** 打开某个指定的扩展视图（编辑器区新开一个标签，由 App 接管）。 */
  const handleOpenView = (viewId?: string) => {
    const target = viewId ?? installedInfo?.views?.[0];
    if (!target) return;
    window.dispatchEvent(
      new CustomEvent('echoly:open-extension-view', {
        detail: { viewId: target, title: installedInfo?.displayName || title },
      }),
    );
  };

  /** 运行扩展贡献的命令。失败要说出来 —— 点了没反应最容易让人以为界面卡了。 */
  const handleRunCommand = async (command: string) => {
    try {
      const res = await window.extensions.executeCommand(command);
      if (res && res.success === false) {
        onShowToast?.(t('ext.commandRunFailed', { command }), 'error');
      }
    } catch (err: any) {
      // 提示面向用户，原因留给控制台：只说「执行失败」他还能去查日志，
      // 把一坨 stack 塞进 toast 反而看不清是哪条命令挂的
      onShowToast?.(t('ext.commandRunFailed', { command }), 'error');
      console.error('[ExtensionDetailView] 执行扩展命令失败：', command, err);
    }
  };

  /** 启用 / 禁用。做完重拉一次详情，按钮文案与状态跟着变。 */
  const handleToggleEnabled = async () => {
    if (!installedInfo || busy) return;
    const next = !installedInfo.enabled;
    setBusy(true);
    try {
      const res = await window.extensions.setEnabled(installedInfo.id, next);
      if (res?.ok) {
        onShowToast?.(
          next
            ? t('ext.enabledToast', { name: installedInfo.displayName })
            : t('ext.disabledToast', { name: installedInfo.displayName }),
          'success',
        );
        await load();
      } else {
        onShowToast?.(
          t('ext.toggleFailed', { msg: res?.error || t('extView.unknownError') }),
          'error',
        );
      }
    } catch (err: any) {
      onShowToast?.(t('ext.toggleFailed', { msg: err?.message || String(err) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** 卸载：确认后调主进程，成功就把本地状态也置回「未安装」。 */
  const handleUninstall = async () => {
    setConfirmUninstall(false);
    if (!installedInfo) return;
    setBusy(true);
    const name = installedInfo.displayName;
    try {
      const res = await window.extensions.uninstall(installedInfo.id);
      if (res?.ok) {
        onShowToast?.(t('ext.uninstalledToast', { name }), 'success');
        // 通知面板刷新：它那边还挂着这个扩展的一行
        window.dispatchEvent(new CustomEvent(EXTENSION_INSTALLED_EVENT, { detail: extensionId }));
        await load();
      } else {
        onShowToast?.(
          t('ext.uninstallFailed', { msg: res?.error || t('extView.unknownError') }),
          'error',
        );
      }
    } catch (err: any) {
      onShowToast?.(t('ext.uninstallFailed', { msg: err?.message || String(err) }), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleInstall = async () => {
    if (installing) return;
    setInstalling(true);
    try {
      if (usesDedicatedChannel) {
        const res = await window.extensions.installClaudeCode();
        if (res.success) {
          setInstalled(true);
          onShowToast?.(t('ext.claudeInstalled'), 'success');
          window.dispatchEvent(new CustomEvent(EXTENSION_INSTALLED_EVENT, { detail: extensionId }));
          // 重拉一次：安装动作本身不知道扩展贡献了哪些视图，得从登记表读回来
          await load();
        } else {
          onShowToast?.(res.error || t('ext.installFailed'), 'error');
        }
        return;
      }
      if (!detail) return;
      const res = await window.extensions.installFromMarketplace({
        id: detail.id,
        downloadUrl: detail.downloadUrl,
        version: detail.version,
      });
      if (res.success) {
        setInstalled(true);
        onShowToast?.(t('ext.marketInstalled', { name: title }), 'success');
        // 左侧面板是另一个组件，靠事件通知它刷新已安装列表 ——
        // 否则刚装完的扩展在面板里还是「安装」按钮，两边说的不是一回事。
        window.dispatchEvent(new CustomEvent(EXTENSION_INSTALLED_EVENT, { detail: detail.id }));
        await load();
      } else {
        onShowToast?.(res.error || t('ext.installFailed'), 'error');
      }
    } catch (err: any) {
      onShowToast?.(err?.message || t('ext.installError'), 'error');
    } finally {
      setInstalling(false);
    }
  };

  const resources = useMemo(
    () =>
      [
        detail?.homepage ? { label: t('extDetail.resHomepage'), href: detail.homepage } : null,
        detail?.repository
          ? { label: t('extDetail.resRepository'), href: detail.repository }
          : null,
        detail?.bugs ? { label: t('extDetail.resIssues'), href: detail.bugs } : null,
      ].filter(Boolean) as { label: string; href: string }[],
    [detail, t],
  );

  const showEmptyReadme = state === 'done' && !readme.trim();

  return (
    <div className="ext-detail">
      <div className="ext-detail-shell">
        <header className="ext-detail-head">
          <div className="ext-detail-icon">
            {iconData ? (
              <img src={iconData} alt="" draggable={false} />
            ) : (
              <span className="ext-row-icon-letter">{iconInitial(title)}</span>
            )}
          </div>
          <div className="ext-detail-headinfo">
            <h1 className="ext-detail-title">{title}</h1>
            <div className="ext-detail-meta">
              <span className="ext-publisher">
                <svg
                  className="ext-verified"
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 2.6 14.5 5l3.4-.3.9 3.3 3 1.7-1.4 3.1 1.4 3.1-3 1.7-.9 3.3-3.4-.3L12 22.6 9.5 20.2l-3.4.3-.9-3.3-3-1.7L3.6 12.4 2.2 9.3l3-1.7.9-3.3 3.4.3z" />
                </svg>
                <span className="ext-publisher-name">{publisher}</span>
              </span>
              {detail?.downloads !== undefined && (
                <span className="ext-detail-stat">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M12 3v11" />
                    <polyline points="7.5 9.5 12 14 16.5 9.5" />
                    <path d="M4.5 20h15" />
                  </svg>
                  {formatDownloadCount(detail.downloads)}
                </span>
              )}
              {detail?.rating !== undefined && (
                <span className="ext-detail-stat ext-row-rating" title={t('ext.ratingLabel')}>
                  {ratingStars(detail.rating)} {formatRating(detail.rating)}
                </span>
              )}
            </div>
            {detail?.description && <p className="ext-detail-desc">{detail.description}</p>}

            <div className="ext-detail-actions">
              {state === 'failed' && (
                <button type="button" className="ext-btn" onClick={() => void load()}>
                  {t('ext.retry')}
                </button>
              )}
              {state !== 'failed' &&
                (installed ? (
                  <>
                    {/*
                      「打开」只在扩展确实贡献了视图时出现 —— 没有视图的扩展（纯命令类）
                      摆一个点了没反应的按钮，跟以前那个假的暂停补全按钮是一回事。
                    */}
                    {(installedInfo?.views?.length ?? 0) > 0 && (
                      <button
                        type="button"
                        className="ext-btn ext-btn-primary"
                        disabled={busy || !installedInfo?.enabled}
                        title={t('ext.openViewTitle')}
                        onClick={() => handleOpenView()}
                      >
                        {t('ext.openView')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="ext-btn"
                      disabled={busy}
                      onClick={() => void handleToggleEnabled()}
                    >
                      {installedInfo?.enabled ? t('ext.disable') : t('ext.enable')}
                    </button>
                    <button
                      type="button"
                      className="ext-btn"
                      disabled={busy}
                      onClick={() => setConfirmUninstall(true)}
                    >
                      {t('ext.uninstall')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ext-btn ext-btn-primary"
                    disabled={
                      installing || state === 'loading' || (!detail && !usesDedicatedChannel)
                    }
                    onClick={() => void handleInstall()}
                  >
                    {installing
                      ? t('ext.installing')
                      : usesDedicatedChannel
                        ? t('ext.installOnline')
                        : t('ext.marketInstall')}
                  </button>
                ))}
            </div>
          </div>
        </header>

        <div className="ext-detail-body">
          <main className="ext-detail-main">
            {state === 'loading' && <div className="ext-detail-note">{t('extDetail.loading')}</div>}
            {state === 'failed' && <div className="ext-detail-note ext-note-error">{error}</div>}
            {showEmptyReadme && <div className="ext-detail-note">{t('extDetail.noReadme')}</div>}
            {readme.trim() && (
              <div className="md-body ext-detail-readme">
                {/* README 里的原始 HTML 先剥掉再渲染，理由见 services/extensionReadme */}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripRawHtml(readme)}</ReactMarkdown>
              </div>
            )}
          </main>

          <aside className="ext-detail-aside">
            {/* 放在 {detail && …} 之外：本地 VSIX 装的扩展在注册表里查不到详情，
                但它的视图与命令一样得能在这里点到 */}
            {/*
                  「这个扩展到底能干什么」—— 装完之后的入口都列在这里。
                  以前一个扩展只露一个「已安装」徽章，贡献的视图与命令一个都点不到；
                  现在每个视图一行（各自能打开）、每条命令一行（各自能运行）。
                */}
            {installedInfo &&
              (installedInfo.views.length > 0 || installedInfo.commands.length > 0) &&
              installedInfo.enabled && (
                <section className="ext-detail-block">
                  <h2>{t('extDetail.contributions')}</h2>
                  {installedInfo.views.length > 0 && (
                    <>
                      <h3 className="ext-detail-subhead">{t('extDetail.views')}</h3>
                      {/*
                            列出**全部**视图而不是只给第一个：一个扩展可以贡献好几个
                            （claude-manager 就有两个），只露一个等于另一个永远点不到。
                          */}
                      <div className="ext-detail-view-list">
                        {installedInfo.views.map((viewId) => (
                          <button
                            key={viewId}
                            type="button"
                            className="ext-btn ext-btn-primary"
                            onClick={() => handleOpenView(viewId)}
                            title={t('ext.openViewTitle')}
                          >
                            {t('ext.openView')} {viewId}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  {installedInfo.commands.length > 0 && (
                    <>
                      <h3 className="ext-detail-subhead">{t('extDetail.commands')}</h3>
                      {/* 不用 dl：`.ext-detail-block dl` 是两列网格，塞按钮进去会错位 */}
                      <div className="ext-detail-command-list">
                        {installedInfo.commands.map((c) => (
                          <div key={c.command} className="ext-detail-command-row">
                            <span title={c.command}>{c.title}</span>
                            <button
                              type="button"
                              className="ext-btn"
                              onClick={() => void handleRunCommand(c.command)}
                            >
                              {t('extDetail.run')}
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>
              )}

            {detail && (
              <>
                <section className="ext-detail-block">
                  <h2>{t('extDetail.installation')}</h2>
                  <dl>
                    <dt>{t('extDetail.identifier')}</dt>
                    <dd className="ext-detail-mono">{detail.id}</dd>
                    <dt>{t('extDetail.version')}</dt>
                    <dd>{detail.version}</dd>
                    {detail.timestamp && (
                      <>
                        <dt>{t('extDetail.lastUpdated')}</dt>
                        <dd>{formatTimestamp(detail.timestamp)}</dd>
                      </>
                    )}
                    {detail.size !== undefined && (
                      <>
                        <dt>{t('extDetail.size')}</dt>
                        <dd>{formatSize(detail.size)}</dd>
                      </>
                    )}
                  </dl>
                </section>

                <section className="ext-detail-block">
                  <h2>{t('extDetail.marketplace')}</h2>
                  <dl>
                    {detail.downloads !== undefined && (
                      <>
                        <dt>{t('extDetail.installs')}</dt>
                        <dd>{detail.downloads.toLocaleString()}</dd>
                      </>
                    )}
                    {detail.rating !== undefined && (
                      <>
                        <dt>{t('extDetail.rating')}</dt>
                        <dd>{formatRating(detail.rating)}</dd>
                      </>
                    )}
                    {detail.reviewCount !== undefined && (
                      <>
                        <dt>{t('extDetail.reviews')}</dt>
                        <dd>{detail.reviewCount.toLocaleString()}</dd>
                      </>
                    )}
                  </dl>
                </section>

                {detail.categories && detail.categories.length > 0 && (
                  <section className="ext-detail-block">
                    <h2>{t('extDetail.categories')}</h2>
                    <div className="ext-detail-chips">
                      {detail.categories.map((c) => (
                        <span key={c} className="ext-detail-chip">
                          {c}
                        </span>
                      ))}
                    </div>
                  </section>
                )}

                {(resources.length > 0 || detail.license) && (
                  <section className="ext-detail-block">
                    <h2>{t('extDetail.resources')}</h2>
                    <div className="ext-detail-links">
                      {resources.map((r) => (
                        <a key={r.href} href={r.href} target="_blank" rel="noreferrer">
                          {r.label}
                        </a>
                      ))}
                      {detail.license && (
                        <span className="ext-detail-license">{detail.license}</span>
                      )}
                    </div>
                  </section>
                )}
              </>
            )}
          </aside>
        </div>
      </div>
      <DbConfirmModal
        isOpen={confirmUninstall}
        title={t('ext.uninstallTitle')}
        content={t('ext.uninstallConfirm', { name: installedInfo?.displayName || title })}
        details={
          installedInfo
            ? [
                { label: t('extDetail.identifier'), value: installedInfo.id },
                ...(installedInfo.version
                  ? [{ label: t('extDetail.version'), value: installedInfo.version }]
                  : []),
              ]
            : undefined
        }
        tone="danger"
        confirmLabel={t('ext.uninstall')}
        onConfirm={() => void handleUninstall()}
        onCancel={() => setConfirmUninstall(false)}
      />
    </div>
  );
}
