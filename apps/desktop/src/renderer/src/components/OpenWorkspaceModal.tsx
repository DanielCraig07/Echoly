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

        <div className="ide-modal-body" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* 四个卡片式入口网格 */}
          <div className="open-ws-grid" role="list">
            <button
              type="button"
              className="open-ws-card"
              onClick={() => {
                onClose();
                onPickLocal();
              }}
            >
              <div className="open-ws-card-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                </svg>
              </div>
              <div className="open-ws-card-text">
                <div className="open-ws-card-title">本地文件夹</div>
                <div className="open-ws-card-desc">打开本机已有工程目录</div>
              </div>
            </button>

            <button
              type="button"
              className="open-ws-card"
              onClick={() => {
                onClose();
                onPickSsh();
              }}
            >
              <div className="open-ws-card-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
                </svg>
              </div>
              <div className="open-ws-card-text">
                <div className="open-ws-card-title">SSH 远程主机</div>
                <div className="open-ws-card-desc">直连远程服务器目录开发</div>
              </div>
            </button>

            <button
              type="button"
              className="open-ws-card"
              onClick={() => {
                onClose();
                onPickClone();
              }}
            >
              <div className="open-ws-card-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M12 3v12" />
                  <path d="m8 11 4 4 4-4" />
                  <path d="M5 19h14" />
                </svg>
              </div>
              <div className="open-ws-card-text">
                <div className="open-ws-card-title">从 Git 克隆</div>
                <div className="open-ws-card-desc">支持 GitHub / Gitee / GitLab</div>
              </div>
            </button>

            <button
              type="button"
              className="open-ws-card"
              onClick={() => {
                onClose();
                onOpenNewProjectWizard?.();
              }}
            >
              <div className="open-ws-card-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
                  <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
                </svg>
              </div>
              <div className="open-ws-card-text">
                <div className="open-ws-card-title">模板向导新建</div>
                <div className="open-ws-card-desc">C++ / Java / Python / Go 标准模版</div>
              </div>
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
                        {/* 1 & 2. 连接方式徽标与技术栈徽标（固定宽度容器以实现项目名称严格对齐） */}
                        <div className="open-ws-recent-badges">
                          <span className={`open-ws-kind-pill ${isSsh ? 'ssh' : 'local'}`}>
                            {isSsh ? 'SSH' : '本地'}
                          </span>
                          <span
                            className="open-ws-tech-pill"
                            style={{ color: tech.color, background: tech.bg }}
                            title={`智能识别技术栈: ${tech.label}`}
                          >
                            {tech.label}
                          </span>
                        </div>

                        <span className="open-ws-recent-text">
                          <span className="open-ws-recent-name-wrap">
                            <span className="open-ws-recent-name">{item.name}</span>
                            {isCurrent && (
                              <span className="open-ws-current-badge" title="当前正在使用的工作区">
                                <span className="open-ws-current-dot" />
                                正在使用
                              </span>
                            )}
                            {relativeTime && (
                              <span className="open-ws-time-pill">{relativeTime}</span>
                            )}
                          </span>
                          <span className="open-ws-recent-path" title={pathLabel}>
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
                            ✕
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
