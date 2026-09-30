import React, { useEffect, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceInfo } from '@deepseek-ide/shared';
import { useModalResize, ModalResizeHandle, createSafeOverlayHandlers } from '../hooks/useModalResize';

const isMac =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

function checkIsCurrentWorkspace(
  item: RecentWorkspaceItem,
  currentWorkspace?: string | null,
  currentWorkspaceInfo?: WorkspaceInfo | null,
): boolean {
  if (!currentWorkspace && !currentWorkspaceInfo?.root) return false;
  const curRoot = (currentWorkspace || currentWorkspaceInfo?.root || '')
    .trim()
    .replace(/[/\\]+$/, '');
  const itemPath = (item.path || '').trim().replace(/[/\\]+$/, '');
  if (!curRoot || !itemPath) return false;

  const curKind = currentWorkspaceInfo?.kind || 'local';
  const itemIsSsh = item.kind === 'ssh' || !!item.sshServer || item.path.startsWith('ssh ');

  if (curKind === 'ssh') {
    if (!itemIsSsh) return false;
    if (curRoot !== itemPath) return false;
    if (item.sshServer && currentWorkspaceInfo?.label) {
      const match = currentWorkspaceInfo.label.match(/^ssh\s+([^:/]+)/);
      const curServer = match ? match[1] : '';
      if (
        curServer &&
        item.sshServer &&
        curServer !== item.sshServer &&
        !curServer.includes(item.sshServer) &&
        !item.sshServer.includes(curServer)
      ) {
        return false;
      }
    }
    return true;
  } else {
    if (itemIsSsh) return false;
    return isMac || navigator.userAgent.includes('Windows')
      ? curRoot.toLowerCase() === itemPath.toLowerCase()
      : curRoot === itemPath;
  }
}

import { detectTechBadge } from '../utils/techStack';

function formatRelativeTime(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}天前`;
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export interface RecentWorkspaceItem {
  path: string;
  name: string;
  kind?: 'local' | 'ssh';
  sshServer?: string;
  label?: string;
  lastOpenedAt: number;
  techStack?: string;
  gitBranch?: string;
  uncommittedCount?: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onPickLocal: () => void;
  onPickSsh: () => void;
  onPickClone: () => void;
  onOpenNewProjectWizard?: () => void;
  recentWorkspaces?: RecentWorkspaceItem[];
  currentWorkspace?: string | null;
  currentWorkspaceInfo?: WorkspaceInfo | null;
  onSelectRecent?: (item: RecentWorkspaceItem) => void;
  onRemoveRecent?: (path: string) => void;
  onClearRecent?: () => void;
}

export function OpenWorkspaceModal({
  open,
  onClose,
  onPickLocal,
  onPickSsh,
  onPickClone,
  onOpenNewProjectWizard,
  recentWorkspaces = [],
  currentWorkspace,
  currentWorkspaceInfo,
  onSelectRecent,
  onRemoveRecent,
  onClearRecent,
}: Props) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_open_workspace_modal_size',
    defaultWidth: 620,
    defaultHeight: 560,
    minWidth: 480,
    minHeight: 400,
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setCopiedPath(null);
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onClose]);

  const filteredRecents = useMemo(() => {
    if (!searchQuery.trim()) return recentWorkspaces;
    const q = searchQuery.toLowerCase();
    return recentWorkspaces.filter(
      (item) => item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q),
    );
  }, [recentWorkspaces, searchQuery]);

  const handleCopy = (path: string, e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(path);
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 1500);
  };

  if (!open || typeof document === 'undefined') return null;

  const safeOverlay = createSafeOverlayHandlers(onClose);

  return createPortal(
    <div className="settings-overlay" {...safeOverlay}>
      <div
        className="ide-modal ide-modal-md modern-open-ws-modal"
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ide-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text)',
                flexShrink: 0,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div>
              <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: 'var(--text-bright)' }}>
                打开工作区 (Open Workspace)
              </h2>
              <p className="ide-modal-desc" style={{ marginTop: 2 }}>
                选择工作区接入方式，或从历史记录秒级恢复上下文
              </p>
            </div>
          </div>
          <button
            type="button"
            className="panel-action-btn"
            onClick={onClose}
            title="关闭 (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div className="ide-modal-body" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {/* 四个卡片式入口网格（完全对齐欢迎页规范与文案） */}
          <div className="welcome-view-choices" role="list">
            <button
              type="button"
              className="welcome-choice-row local"
              onClick={() => {
                onClose();
                onPickLocal();
              }}
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
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                </svg>
              </span>
              <span className="welcome-choice-body">
                <span className="welcome-choice-title">本地文件夹</span>
                <span className="welcome-choice-desc">打开本机已有目录作为工作区</span>
              </span>
              <span className="welcome-choice-hint">Open</span>
            </button>

            <button
              type="button"
              className="welcome-choice-row ssh"
              onClick={() => {
                onClose();
                onPickSsh();
              }}
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

            <button
              type="button"
              className="welcome-choice-row clone"
              onClick={() => {
                onClose();
                onPickClone();
              }}
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
              onClick={() => {
                onClose();
                onOpenNewProjectWizard?.();
              }}
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

          {/* 最近打开历史区域 */}
          <section className="open-ws-recent" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="open-ws-recent-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>最近历史工程</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 500 }}>
                  ({recentWorkspaces.length})
                </span>
              </div>

              {recentWorkspaces.length > 3 && (
                <div className="open-ws-filter-wrap">
                  <input
                    type="text"
                    placeholder="过滤工程名称或路径…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="open-ws-filter-input"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="open-ws-filter-clear"
                      onClick={() => setSearchQuery('')}
                    >
                      ✕
                    </button>
                  )}
                </div>
              )}

              {recentWorkspaces.length > 0 && onClearRecent && (
                <button
                  type="button"
                  className="ghost open-ws-recent-clear"
                  onClick={onClearRecent}
                >
                  清空记录
                </button>
              )}
            </div>

            {filteredRecents.length === 0 ? (
              <div className="open-ws-recent-empty">
                {searchQuery ? '没有匹配的历史工作区' : '暂无最近打开历史记录'}
              </div>
            ) : (
              <ul className="open-ws-recent-list" style={{ flex: 1, overflowY: 'auto' }}>
                {filteredRecents.map((item) => {
                  const isSsh =
                    item.kind === 'ssh' || !!item.sshServer || item.path.startsWith('ssh ');
                  const pathLabel =
                    item.sshServer && !item.path.includes('@')
                      ? `${item.sshServer}:${item.path}`
                      : item.path;
                  const isCurrent = checkIsCurrentWorkspace(
                    item,
                    currentWorkspace,
                    currentWorkspaceInfo,
                  );
                  const tech = detectTechBadge(item.name, item.path, item.techStack);
                  const relativeTime = formatRelativeTime(item.lastOpenedAt);

                  return (
                    <li key={item.path} className={`open-ws-item-wrap ${isCurrent ? 'is-current' : ''}`}>
                      <button
                        type="button"
                        className="open-ws-recent-row"
                        onClick={() => {
                          onClose();
                          onSelectRecent?.(item);
                        }}
                      >
                        {/* 1 & 2. 连接方式徽标与技术栈徽标（对齐欢迎页固定 106px 宽度容器） */}
                        <div className="welcome-recent-badges">
                          <span className={`welcome-recent-kind ${isSsh ? 'ssh' : 'local'}`}>
                            {isSsh ? 'SSH' : '本地'}
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
                            title={`智能识别技术栈: ${tech.label}`}
                          >
                            {tech.label}
                          </span>
                        </div>

                        <span className="welcome-recent-text">
                          <span className="open-ws-recent-name-wrap">
                            <span className="welcome-recent-name">{item.name}</span>
                            {isCurrent && (
                              <span className="open-ws-current-badge" title="当前正在使用的工作区">
                                <span className="open-ws-current-dot" />
                                正在使用
                              </span>
                            )}
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
                                title={`当前分支: ${item.gitBranch}${item.uncommittedCount ? ` (${item.uncommittedCount} 个未提交修改)` : ''}`}
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

                      {/* 悬停快捷动作群 */}
                      <div className="open-ws-row-actions">
                        <button
                          type="button"
                          className="open-ws-action-icon-btn"
                          title={copiedPath === item.path ? '已复制路径！' : '复制工作区路径'}
                          onClick={(e) => handleCopy(item.path, e)}
                        >
                          {copiedPath === item.path ? (
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="#10b981"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                        {onRemoveRecent && (
                          <button
                            type="button"
                            className="open-ws-action-icon-btn remove-btn"
                            title="从历史记录中移除"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRemoveRecent(item.path);
                            }}
                          >
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 16 16"
                              fill="none"
                              xmlns="http://www.w3.org/2000/svg"
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
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <footer className="ide-modal-footer">
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            提示：点击任意条目立即无缝接入工作区
          </span>
          <button type="button" className="panel-standard-btn" onClick={onClose} style={{ fontSize: 12, padding: '5px 14px' }}>
            关闭
          </button>
        </footer>
        {/* 右下角全向拖拽调整大小手柄 */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}
