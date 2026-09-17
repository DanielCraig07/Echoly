import React, { useState } from 'react';
import type { RecentWorkspaceItem } from './OpenWorkspaceModal';
import { NewProjectWizardModal } from './NewProjectWizardModal';

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
 * Default content of the middle editor area when no workspace is open yet.
 * Full-width onboarding: open local / SSH / clone, plus recent history.
 */
function detectTechBadge(name: string, path: string): { label: string; color: string; bg: string } {
  const lower = `${name} ${path}`.toLowerCase();
  if (lower.includes('maven') || lower.includes('java') || lower.includes('spring') || lower.includes('jdk') || lower.endsWith('.java')) {
    return { label: 'Java', color: '#fb923c', bg: 'rgba(251, 146, 60, 0.15)' };
  }
  if (lower.includes('python') || lower.includes('py') || lower.includes('django') || lower.includes('flask') || lower.endsWith('.py')) {
    return { label: 'Python', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)' };
  }
  if (lower.includes('cpp') || lower.includes('cmake') || lower.includes('c++') || lower.includes('clang')) {
    return { label: 'C++', color: '#818cf8', bg: 'rgba(129, 140, 248, 0.15)' };
  }
  if (lower.includes('node') || lower.includes('react') || lower.includes('vue') || lower.includes('ts') || lower.includes('js')) {
    return { label: 'Node', color: '#4ade80', bg: 'rgba(74, 222, 128, 0.15)' };
  }
  if (lower.includes('go') || lower.includes('golang')) {
    return { label: 'Go', color: '#2dd4bf', bg: 'rgba(45, 212, 191, 0.15)' };
  }
  return { label: 'Git', color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.12)' };
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

  return (
    <div className="welcome-view">
      <div className="welcome-view-inner">
        <header className="welcome-view-header">
          <div className="welcome-brand-row">
            <h1 className="welcome-view-title">Echoly</h1>
            <span className="welcome-version-badge">AI Native IDE</span>
          </div>
          <p className="welcome-view-subtitle">选择一种方式打开项目，即刻开启全自动 Agent 辅助编程</p>
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
              <span className="welcome-choice-title">本地文件夹</span>
              <span className="welcome-choice-desc">打开本机已有目录作为工作区</span>
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
              <span className="welcome-choice-title">SSH 远程主机</span>
              <span className="welcome-choice-desc">通过 SSH / SFTP 安全连接远程服务</span>
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
              <span className="welcome-choice-title">从 Git 克隆</span>
              <span className="welcome-choice-desc">拉取远程代码仓库至本地并即刻就绪</span>
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
              <span className="welcome-choice-title">新建标准工程向导</span>
              <span className="welcome-choice-desc">
                生成 Java、Python、Go、Node 或 C++ 标准开发与调试工程
              </span>
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
            <span>最近打开</span>
            {visibleRecent.length > 0 && onClearRecent && (
              <button type="button" className="ghost welcome-recent-clear" onClick={onClearRecent}>
                清空
              </button>
            )}
          </div>

          {visibleRecent.length === 0 ? (
            <div className="welcome-view-recent-empty">暂无历史记录</div>
          ) : (
            <ul className="welcome-view-recent-list">
              {visibleRecent.map((item) => {
                const isSsh =
                  item.kind === 'ssh' || !!item.sshServer || item.path.startsWith('ssh ');
                const pathLabel =
                  item.sshServer && !item.path.includes('@')
                    ? `${item.sshServer}:${item.path}`
                    : item.path;
                const tech = detectTechBadge(item.name || '', item.path || '');
                return (
                  <li key={item.path}>
                    <button
                      type="button"
                      className="welcome-recent-row"
                      onClick={() => onSelectRecent?.(item)}
                    >
                      <span className={`welcome-recent-kind${isSsh ? ' ssh' : ''}`}>
                        {isSsh ? 'SSH' : '本地'}
                      </span>
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 600,
                          padding: '1px 6px',
                          borderRadius: 4,
                          color: tech.color,
                          background: tech.bg,
                          flexShrink: 0,
                          lineHeight: '16px',
                        }}
                      >
                        {tech.label}
                      </span>
                      <span className="welcome-recent-text">
                        <span className="welcome-recent-name">{item.name}</span>
                        <span className="welcome-recent-path" title={pathLabel}>
                          {pathLabel}
                        </span>
                      </span>
                    </button>
                    {onRemoveRecent && (
                      <button
                        type="button"
                        className="welcome-recent-remove"
                        title="从记录中移除"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveRecent(item.path);
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
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
              查看全部（{recentWorkspaces.length}）
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
