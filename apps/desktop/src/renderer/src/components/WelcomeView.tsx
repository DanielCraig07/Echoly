import type { RecentWorkspaceItem } from './OpenWorkspaceModal';

interface Props {
  onPickLocal: () => void;
  onPickSsh: () => void;
  onPickClone: () => void;
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
export function WelcomeView({
  onPickLocal,
  onPickSsh,
  onPickClone,
  recentWorkspaces = [],
  onSelectRecent,
  onRemoveRecent,
  onClearRecent,
  onMoreHistory,
}: Props) {
  const visibleRecent = recentWorkspaces.slice(0, MAX_VISIBLE_RECENT);

  return (
    <div className="welcome-view">
      <div className="welcome-view-inner">
        <header className="welcome-view-header">
          <h1 className="welcome-view-title">Echoly</h1>
          <p className="welcome-view-subtitle">选择一种方式打开代码，开始使用 AI Agent</p>
        </header>

        <div className="welcome-view-choices" role="list">
          <button type="button" className="welcome-choice-row" onClick={onPickLocal}>
            <span className="welcome-choice-mark" aria-hidden>
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
            <span className="welcome-choice-body">
              <span className="welcome-choice-title">本地文件夹</span>
              <span className="welcome-choice-desc">打开本机已有目录作为工作区</span>
            </span>
            <span className="welcome-choice-hint">Open</span>
          </button>

          <button type="button" className="welcome-choice-row" onClick={onPickSsh}>
            <span className="welcome-choice-mark" aria-hidden>
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
            <span className="welcome-choice-body">
              <span className="welcome-choice-title">SSH 远程主机</span>
              <span className="welcome-choice-desc">通过 SSH / SFTP 连接远程目录</span>
            </span>
            <span className="welcome-choice-hint">Remote</span>
          </button>

          <button type="button" className="welcome-choice-row" onClick={onPickClone}>
            <span className="welcome-choice-mark" aria-hidden>
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
            <span className="welcome-choice-body">
              <span className="welcome-choice-title">从 Git 克隆</span>
              <span className="welcome-choice-desc">克隆仓库到本地并打开</span>
            </span>
            <span className="welcome-choice-hint">Clone</span>
          </button>
        </div>

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
                        ×
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
