import React, { useState } from 'react';
import type { RecentWorkspaceItem } from './OpenWorkspaceModal';
import { NewProjectWizardModal } from './NewProjectWizardModal';
import { detectTechBadge } from '../utils/techStack';
import { useI18n } from '../i18n';
import type { Locale } from '../i18n';

interface Props {
  onPickLocal: () => void;
  onPickSsh: () => void;
  onPickClone: () => void;
  onCreateCppProject?: () => void;
  onCreateProject?: (templateId: string) => void;
  onOpenWorkspace?: (targetPath: string, openInNewWindow: boolean, entryFile?: string) => void;
  onShowToast?: (title: string, detail?: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
  recentWorkspaces?: RecentWorkspaceItem[];
  onSelectRecent?: (item: RecentWorkspaceItem) => void;
  onRemoveRecent?: (path: string) => void;
  onClearRecent?: () => void;
  onMoreHistory?: () => void;
}

const MAX_VISIBLE_RECENT = 8;

/**
 * 相对时间。
 *
 * 接 t / locale 而不是自己写中文：它是模块级函数、拿不到 hook，
 * 而「3分钟前」的英文是 "3 min ago" —— 数字和单位之间的空格、
 * 量词的有无都不一样，拼接没法两边都对。
 * 超过 30 天退回日期，此时 `toLocaleDateString` 的 locale 也必须跟着走，
 * 否则英文界面里会冒出一个「10月26日」。
 */
function formatRelativeTime(ts: number, t: (key: string, params?: Record<string, string | number>) => string, locale: Locale): string {
  if (!ts) return '';
  const now = Date.now();
  const diffSec = Math.floor((now - ts) / 1000);
  if (diffSec < 60) return t('welcome.justNow');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t('welcome.minutesAgo', { n: diffMin });
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return t('welcome.hoursAgo', { n: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return t('welcome.daysAgo', { n: diffDays });
  return new Date(ts).toLocaleDateString(locale === 'en' ? 'en-US' : 'zh-CN', {
    month: 'numeric',
    day: 'numeric',
  });
}

export function WelcomeView({
  onPickLocal,
  onPickSsh,
  onPickClone,
  onOpenWorkspace,
  onShowToast,
  recentWorkspaces = [],
  onSelectRecent,
  onRemoveRecent,
  onClearRecent,
  onMoreHistory,
}: Props) {
  const visibleRecent = recentWorkspaces.slice(0, MAX_VISIBLE_RECENT);
  const [showWizard, setShowWizard] = useState(false);
  const { t, locale } = useI18n();

  return (
    <div className="welcome-view">
      <div className="welcome-view-inner">
        <header className="welcome-view-header">
          <div className="welcome-brand-row">
            <h1 className="welcome-view-title">Echoly</h1>
            <span className="welcome-version-badge">AI Native IDE</span>
          </div>
          <p className="welcome-view-subtitle">{t('welcome.subtitle')}</p>
        </header>

        <div className="welcome-view-choices" role="list">
          <button type="button" className="welcome-choice-row local" onClick={onPickLocal}>
            <span className="welcome-choice-mark" aria-hidden>
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
              </svg>
            </span>
            <span className="welcome-choice-body">
              <span className="welcome-choice-title">{t('welcome.localTitle')}</span>
              <span className="welcome-choice-desc">{t('welcome.localDesc')}</span>
            </span>
            <span className="welcome-choice-hint">Open</span>
          </button>

          <button type="button" className="welcome-choice-row ssh" onClick={onPickSsh}>
            <span className="welcome-choice-mark" aria-hidden>
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
              </svg>
            </span>
            <span className="welcome-choice-body">
              <span className="welcome-choice-title">{t('welcome.sshTitle')}</span>
              <span className="welcome-choice-desc">{t('welcome.sshDesc')}</span>
            </span>
            <span className="welcome-choice-hint">Remote</span>
          </button>

          <button type="button" className="welcome-choice-row clone" onClick={onPickClone}>
            <span className="welcome-choice-mark" aria-hidden>
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="18" cy="18" r="3" />
                <circle cx="6" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
                <line x1="6" y1="9" x2="6" y2="15" />
              </svg>
            </span>
            <span className="welcome-choice-body">
              <span className="welcome-choice-title">{t('welcome.cloneTitle')}</span>
              <span className="welcome-choice-desc">{t('welcome.cloneDesc')}</span>
            </span>
            <span className="welcome-choice-hint">Clone</span>
          </button>

          <button
            type="button"
            className="welcome-choice-row wizard"
            onClick={() => setShowWizard(true)}
          >
            <span className="welcome-choice-mark" aria-hidden>
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
            </span>
            <span className="welcome-choice-body">
              <span className="welcome-choice-title">{t('welcome.wizardTitle')}</span>
              <span className="welcome-choice-desc">{t('welcome.wizardDesc')}</span>
            </span>
            <span className="welcome-choice-hint">Wizard</span>
          </button>
        </div>

        {/* ── 多语言项目新建向导模态弹窗 ── */}
        <NewProjectWizardModal
          isOpen={showWizard}
          onClose={() => setShowWizard(false)}
          onOpenWorkspace={(targetPath, openInNewWindow, entryFile) => {
            onOpenWorkspace?.(targetPath, openInNewWindow, entryFile);
          }}
          onShowToast={onShowToast}
        />

        <section className="welcome-view-recent">
          <div className="welcome-view-recent-header">
            <span>{t('welcome.recent')}</span>
            {visibleRecent.length > 0 && onClearRecent && (
              <button type="button" className="ghost welcome-recent-clear" onClick={onClearRecent}>
                {t('welcome.clear')}
              </button>
            )}
          </div>

          {visibleRecent.length === 0 ? (
            <div className="welcome-view-recent-empty">{t('welcome.noRecent')}</div>
          ) : (
            <ul className="welcome-view-recent-list">
              {visibleRecent.map((item) => {
                const isSsh =
                  item.kind === 'ssh' || !!item.sshServer || item.path.startsWith('ssh ');
                const pathLabel =
                  item.sshServer && !item.path.includes('@')
                    ? `${item.sshServer}:${item.path}`
                    : item.path;
                const tech = detectTechBadge(item.name || '', item.path || '', t, item.techStack);
                const relativeTime = formatRelativeTime(item.lastOpenedAt, t, locale);
                return (
                  <li key={item.path}>
                    <button
                      type="button"
                      className="welcome-recent-row"
                      onClick={() => onSelectRecent?.(item)}
                    >
                      <div className="welcome-recent-badges">
                        <span className={`welcome-recent-kind ${isSsh ? 'ssh' : 'local'}`}>
                          {isSsh ? 'SSH' : t('welcome.kindLocal')}
                        </span>
                        <span
                          className="open-ws-tech-pill"
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 4,
                            color: tech.color,
                            background: tech.bg,
                            flexShrink: 0,
                            letterSpacing: '0.02em',
                          }}
                          title={t('welcome.techTooltip', { label: tech.label })}
                        >
                          {tech.label}
                        </span>
                      </div>
                      <span className="welcome-recent-text">
                        <span className="open-ws-recent-name-wrap">
                          <span className="welcome-recent-name">{item.name}</span>
                          {item.gitBranch && (
                            <span
                              className="welcome-git-pill"
                              style={{
                                fontSize: 10,
                                padding: '1px 6px',
                                borderRadius: 4,
                                background: 'rgba(255, 255, 255, 0.06)',
                                color: 'var(--muted)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 3,
                              }}
                              title={
                                t('welcome.branchTooltip', { branch: item.gitBranch }) +
                                (item.uncommittedCount
                                  ? t('welcome.branchDirty', { n: item.uncommittedCount })
                                  : '')
                              }
                            >
                              <span>⎇ {item.gitBranch}</span>
                              {item.uncommittedCount && item.uncommittedCount > 0 ? (
                                <span style={{ color: '#e5a54b', fontWeight: 600 }}>
                                  ● {item.uncommittedCount}
                                </span>
                              ) : null}
                            </span>
                          )}
                          {relativeTime && (
                            <span className="open-ws-time-pill">{relativeTime}</span>
                          )}
                        </span>
                        <span className="welcome-recent-path" title={pathLabel}>
                          {pathLabel}
                        </span>
                      </span>
                    </button>
                    {onRemoveRecent && (
                      <button
                        type="button"
                        className="welcome-recent-remove"
                        title={t('welcome.removeRecent')}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveRecent(item.path);
                        }}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                          className="welcome-recent-remove-icon"
                          aria-hidden="true"
                        >
                          <path
                            d="M12 4L4 12M4 4l8 8"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {recentWorkspaces.length > MAX_VISIBLE_RECENT && onMoreHistory && (
            <button type="button" className="welcome-recent-more" onClick={onMoreHistory}>
              {t('welcome.viewAll', { n: recentWorkspaces.length })}
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
