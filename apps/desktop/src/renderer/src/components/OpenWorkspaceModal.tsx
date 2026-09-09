import { useEffect } from 'react';

export interface RecentWorkspaceItem {
  path: string;
  name: string;
  kind?: 'local' | 'ssh';
  sshServer?: string;
  label?: string;
  lastOpenedAt: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onPickLocal: () => void;
  onPickSsh: () => void;
  onPickClone: () => void;
  recentWorkspaces?: RecentWorkspaceItem[];
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
  recentWorkspaces = [],
  onSelectRecent,
  onRemoveRecent,
  onClearRecent,
}: Props) {
  useEffect(() => {
    if (!open) return;
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

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="ide-modal ide-modal-md" onClick={(e) => e.stopPropagation()}>
        <header className="ide-modal-header">
          <div>
            <h2>打开工作区</h2>
            <p className="ide-modal-desc">选择接入方式，或从最近记录快速打开</p>
          </div>
          <button type="button" className="settings-close-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="ide-modal-body">
          <div className="open-ws-choices" role="list">
            <button
              type="button"
              className="open-ws-choice"
              onClick={() => {
                onClose();
                onPickLocal();
              }}
            >
              <span className="open-ws-choice-mark" aria-hidden>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                </svg>
              </span>
              <span className="open-ws-choice-body">
                <span className="open-ws-choice-title">本地文件夹</span>
                <span className="open-ws-choice-desc">打开本机已有目录作为工作区</span>
              </span>
            </button>
            <button
              type="button"
              className="open-ws-choice"
              onClick={() => {
                onClose();
                onPickSsh();
              }}
            >
              <span className="open-ws-choice-mark" aria-hidden>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
                </svg>
              </span>
              <span className="open-ws-choice-body">
                <span className="open-ws-choice-title">SSH 远程主机</span>
                <span className="open-ws-choice-desc">通过 SSH / SFTP 连接远程目录</span>
              </span>
            </button>
            <button
              type="button"
              className="open-ws-choice"
              onClick={() => {
                onClose();
                onPickClone();
              }}
            >
              <span className="open-ws-choice-mark" aria-hidden>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M12 3v12" />
                  <path d="m8 11 4 4 4-4" />
                  <path d="M5 19h14" />
                </svg>
              </span>
              <span className="open-ws-choice-body">
                <span className="open-ws-choice-title">从 Git 克隆</span>
                <span className="open-ws-choice-desc">克隆仓库到本地并打开</span>
              </span>
            </button>
          </div>

          <section className="open-ws-recent">
            <div className="open-ws-recent-header">
              <span>
                最近打开{recentWorkspaces.length > 0 ? ` · ${recentWorkspaces.length}` : ''}
              </span>
              {recentWorkspaces.length > 0 && onClearRecent && (
                <button
                  type="button"
                  className="ghost open-ws-recent-clear"
                  onClick={onClearRecent}
                >
                  清空
                </button>
              )}
            </div>

            {recentWorkspaces.length === 0 ? (
              <div className="open-ws-recent-empty">暂无历史记录</div>
            ) : (
              <ul className="open-ws-recent-list">
                {recentWorkspaces.map((item) => {
                  const isSsh =
                    item.kind === 'ssh' || !!item.sshServer || item.path.startsWith('ssh ');
                  const pathLabel =
                    item.sshServer && !item.path.includes('@')
                      ? `${item.sshServer}:${item.path}`
                      : item.path;
                  return (
                    <li key={item.path}>
                      <button
                        type="button"
                        className="open-ws-recent-row"
                        onClick={() => {
                          onClose();
                          onSelectRecent?.(item);
                        }}
                      >
                        <span className={`open-ws-recent-kind${isSsh ? ' ssh' : ''}`}>
                          {isSsh ? 'SSH' : '本地'}
                        </span>
                        <span className="open-ws-recent-text">
                          <span className="open-ws-recent-name">{item.name}</span>
                          <span className="open-ws-recent-path" title={pathLabel}>
                            {pathLabel}
                          </span>
                        </span>
                      </button>
                      {onRemoveRecent && (
                        <button
                          type="button"
                          className="open-ws-recent-remove"
                          title="从记录中移除"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveRecent(item.path);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <footer className="ide-modal-footer">
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
