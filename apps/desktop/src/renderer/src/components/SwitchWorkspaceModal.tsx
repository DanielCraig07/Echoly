import { useEffect } from 'react';

interface Props {
  open: boolean;
  targetPath: string | null;
  onClose: () => void;
  onOpenCurrentWindow: (path: string) => void;
  onOpenNewWindow: (path: string) => void;
}

export function SwitchWorkspaceModal({
  open,
  targetPath,
  onClose,
  onOpenCurrentWindow,
  onOpenNewWindow,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open || !targetPath) return null;

  const folderName = targetPath.split('/').filter(Boolean).pop() || targetPath;

  return (
    <div className="settings-overlay switch-workspace-overlay" onClick={onClose}>
      <div
        className="settings-modal switch-workspace-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="switch-workspace-header">
          <div className="switch-workspace-header-title">
            <div className="switch-workspace-icon-badge">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div>
              <h3>打开工作区</h3>
              <p className="switch-workspace-subtitle">
                选择打开「<span className="switch-workspace-target-name">{folderName}</span>」的方式
              </p>
            </div>
          </div>
          <button
            type="button"
            className="switch-workspace-close-btn"
            onClick={onClose}
            title="关闭 (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Path tag container */}
        <div className="switch-workspace-path-card" title={targetPath}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.6 }}>
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
          <span className="switch-workspace-path-text">{targetPath}</span>
        </div>

        {/* Options Cards */}
        <div className="switch-workspace-options">
          <button
            type="button"
            className="switch-workspace-option-card primary"
            onClick={() => {
              onClose();
              onOpenCurrentWindow(targetPath);
            }}
          >
            <div className="switch-workspace-option-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </div>
            <div className="switch-workspace-option-content">
              <div className="switch-workspace-option-title">在当前窗口打开</div>
              <div className="switch-workspace-option-desc">切换并替换当前工作区</div>
            </div>
            <div className="switch-workspace-option-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </div>
          </button>

          <button
            type="button"
            className="switch-workspace-option-card"
            onClick={() => {
              onClose();
              onOpenNewWindow(targetPath);
            }}
          >
            <div className="switch-workspace-option-icon secondary">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="15" height="13" rx="2" />
                <path d="M20 8v11a2 2 0 0 1-2 2H8" />
              </svg>
            </div>
            <div className="switch-workspace-option-content">
              <div className="switch-workspace-option-title">在新窗口打开</div>
              <div className="switch-workspace-option-desc">保留当前工程，在新窗口独立打开</div>
            </div>
            <div className="switch-workspace-option-arrow">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </div>
          </button>
        </div>

        {/* Footer */}
        <div className="switch-workspace-footer">
          <button type="button" className="switch-workspace-cancel-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
