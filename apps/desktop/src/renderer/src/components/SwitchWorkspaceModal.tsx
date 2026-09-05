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
  if (!open || !targetPath) return null;

  const folderName = targetPath.split('/').filter(Boolean).pop() || targetPath;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div
        className="settings-modal switch-workspace-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 460 }}
      >
        <h2>打开工作区</h2>
        <p className="muted" style={{ marginTop: 6, fontSize: 13 }}>
          要如何在 IDE 中打开「<strong style={{ color: 'var(--fg)' }}>{folderName}</strong>」？
        </p>
        <p
          className="muted"
          style={{ fontSize: 12, opacity: 0.7, marginBottom: 20, wordBreak: 'break-all' }}
        >
          {targetPath}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            type="button"
            className="btn btn-primary"
            style={{ padding: '10px 16px', fontSize: 13, justifyContent: 'center' }}
            onClick={() => {
              onClose();
              onOpenCurrentWindow(targetPath);
            }}
          >
            在当前窗口打开
          </button>

          <button
            type="button"
            className="btn"
            style={{ padding: '10px 16px', fontSize: 13, justifyContent: 'center' }}
            onClick={() => {
              onClose();
              onOpenNewWindow(targetPath);
            }}
          >
            在新窗口打开
          </button>
        </div>

        <div className="settings-actions" style={{ marginTop: 16 }}>
          <button type="button" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
