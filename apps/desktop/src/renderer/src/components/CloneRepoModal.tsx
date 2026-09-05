import { useEffect, useState } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  onCloned: (path: string) => void;
}

export function CloneRepoModal({ open, onClose, onCloned }: Props) {
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setLog('');
    setError('');
    return window.ide.onGitCloneLog((line) => setLog((prev) => prev + line));
  }, [open]);

  if (!open) return null;

  async function pickDir(): Promise<void> {
    const dir = await window.ide.pickDirectory();
    if (dir) setParentDir(dir);
  }

  async function clone(): Promise<void> {
    setBusy(true);
    setError('');
    setLog('');
    const result = await window.ide.cloneRepo({
      url,
      branch: branch || undefined,
      parentDir,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.detail);
      return;
    }
    if (result.path) onCloned(result.path);
    onClose();
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="ide-modal" onClick={(e) => e.stopPropagation()}>
        <header className="ide-modal-header">
          <div>
            <h2>Clone 仓库</h2>
            <p className="ide-modal-desc">从 Git URL 克隆到本地目录并打开为工作区</p>
          </div>
          <button type="button" className="settings-close-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="ide-modal-body">
          <div className="ide-form">
            <div className="ide-field">
              <label htmlFor="clone-url">仓库 URL</label>
              <input
                id="clone-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/org/repo.git"
                autoFocus
              />
            </div>
            <div className="ide-field">
              <label htmlFor="clone-branch">分支（可选）</label>
              <input
                id="clone-branch"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
              />
            </div>
            <div className="ide-field">
              <label htmlFor="clone-dir">目标父目录</label>
              <div className="ide-field-split">
                <input
                  id="clone-dir"
                  value={parentDir}
                  onChange={(e) => setParentDir(e.target.value)}
                  placeholder="选择克隆到的本地目录"
                />
                <button type="button" className="btn" onClick={() => void pickDir()} disabled={busy}>
                  选择…
                </button>
              </div>
            </div>
          </div>

          {log && <pre className="clone-log">{log}</pre>}
          {error && <div className="probe-fail">{error}</div>}
        </div>

        <footer className="ide-modal-footer">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !url.trim() || !parentDir.trim()}
            onClick={() => void clone()}
          >
            {busy ? '克隆中…' : 'Clone'}
          </button>
        </footer>
      </div>
    </div>
  );
}
