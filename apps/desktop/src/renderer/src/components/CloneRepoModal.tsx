import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useModalResize, ModalResizeHandle, createSafeOverlayHandlers } from '../hooks/useModalResize';

interface Props {
  open: boolean;
  onClose: () => void;
  onCloned: (path: string) => void;
}

const STORAGE_LAST_PARENT_DIR = 'echoly:last-clone-parent-dir';

/**
 * 从 Git URL 中智能解析仓库名称
 */
export function extractRepoName(url: string): string {
  const clean = url.trim().replace(/\.git\/?$/i, '').replace(/\/+$/, '');
  const match = clean.match(/[:/]([^/:]+)$/);
  return match ? match[1] : '';
}

/**
 * 检测 Git URL 的协议类型
 */
export function detectGitProtocol(url: string): 'HTTPS' | 'SSH' | 'Git' | null {
  const trimmed = url.trim();
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) return 'HTTPS';
  if (trimmed.startsWith('git@') || trimmed.startsWith('ssh://')) return 'SSH';
  if (trimmed.startsWith('git://')) return 'Git';
  return null;
}

export function CloneRepoModal({ open, onClose, onCloned }: Props) {
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [parentDir, setParentDir] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_LAST_PARENT_DIR) || '';
    } catch {
      return '';
    }
  });
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const logContainerRef = useRef<HTMLDivElement>(null);

  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly:clone_repo_modal_size',
    defaultWidth: 620,
    defaultHeight: 580,
    minWidth: 460,
    minHeight: 340,
  });

  // 提取项目仓库名与目标路径预览
  const repoName = useMemo(() => extractRepoName(url), [url]);
  const protocol = useMemo(() => detectGitProtocol(url), [url]);
  const resolvedTargetPath = useMemo(() => {
    if (!parentDir.trim() || !repoName) return '';
    const normParent = parentDir.trim().replace(/[/\\]+$/, '');
    return `${normParent}/${repoName}`;
  }, [parentDir, repoName]);

  // 监听克隆日志流
  useEffect(() => {
    if (!open) return;
    setLog('');
    setError('');
    const unlisten = window.ide?.onGitCloneLog?.((line) => {
      setLog((prev) => prev + line);
      setTimeout(() => {
        if (logContainerRef.current) {
          logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
        }
      }, 20);
    });
    return () => {
      unlisten?.();
    };
  }, [open]);

  // ESC 键与 Enter 快捷键
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onClose();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || e.target instanceof HTMLInputElement)) {
        if (!busy && url.trim() && parentDir.trim()) {
          e.preventDefault();
          void clone();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onClose, busy, url, parentDir]);

  // 选择目标存储目录
  const pickDir = useCallback(async () => {
    try {
      const dir = await window.ide.pickDirectory();
      if (dir) {
        setParentDir(dir);
        try {
          localStorage.setItem(STORAGE_LAST_PARENT_DIR, dir);
        } catch {}
      }
    } catch (err: any) {
      setError(`选择目录失败: ${err?.message || String(err)}`);
    }
  }, []);

  // 粘贴剪贴板 URL 快捷助手
  const handlePasteClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && (text.includes('github.com') || text.includes('gitlab') || text.includes('gitee') || text.endsWith('.git') || text.startsWith('git@'))) {
        setUrl(text.trim());
      }
    } catch {}
  }, []);

  // 执行克隆
  const clone = useCallback(async () => {
    if (!url.trim() || !parentDir.trim() || busy) return;
    setBusy(true);
    setError('');
    setLog('');
    try {
      const result = await window.ide.cloneRepo({
        url: url.trim(),
        branch: branch.trim() || undefined,
        parentDir: parentDir.trim(),
      });
      setBusy(false);
      if (!result.ok) {
        setError(result.detail || 'Git 克隆发生错误，请检查仓库地址与访问权限');
        return;
      }
      if (result.path) {
        try {
          localStorage.setItem(STORAGE_LAST_PARENT_DIR, parentDir.trim());
        } catch {}
        onCloned(result.path);
      }
      onClose();
    } catch (err: any) {
      setBusy(false);
      setError(err?.message || '克隆操作遇到异常');
    }
  }, [url, branch, parentDir, busy, onCloned, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const safeOverlay = createSafeOverlayHandlers(busy ? undefined : onClose);

  return createPortal(
    <div className="clone-repo-overlay" {...safeOverlay}>
      <div
        className="clone-repo-modal"
        style={{
          width: `${modalSize.width}px`,
          height: `${modalSize.height}px`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 顶部 Header ── */}
        <div className="clone-repo-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: 'rgba(249, 115, 22, 0.12)',
                border: '1px solid rgba(249, 115, 22, 0.28)',
                color: '#f97316',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {/* Git Logo SVG */}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="18" r="3" />
                <circle cx="6" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
                <line x1="6" y1="9" x2="6" y2="15" />
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-bright, #fff)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>Clone 远程仓库</span>
                <span
                  style={{
                    fontSize: 10.5,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: 'rgba(56, 189, 248, 0.14)',
                    color: '#38bdf8',
                    border: '1px solid rgba(56, 189, 248, 0.25)',
                    fontWeight: 600,
                  }}
                >
                  Git Clone
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                从 GitHub、GitLab、Gitee 或私有 Git 仓库克隆至本地，并立即打开为项目工作区
              </div>
            </div>
          </div>
          <button
            type="button"
            className="panel-action-btn"
            onClick={onClose}
            disabled={busy}
            title="关闭 (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* ── 主体表单区域 ── */}
        <div className="clone-repo-body">
          {/* 仓库 URL 输入 */}
          <div className="clone-repo-field">
            <div className="clone-repo-field-label-row">
              <label className="clone-repo-field-label" htmlFor="clone-input-url">
                <span>仓库 URL (Repository URL)</span>
                {protocol && (
                  <span
                    style={{
                      fontSize: 10,
                      padding: '0 5px',
                      borderRadius: 3,
                      background: protocol === 'SSH' ? 'rgba(168, 85, 247, 0.16)' : 'rgba(56, 189, 248, 0.16)',
                      color: protocol === 'SSH' ? '#c084fc' : '#38bdf8',
                      border: protocol === 'SSH' ? '1px solid rgba(168, 85, 247, 0.3)' : '1px solid rgba(56, 189, 248, 0.3)',
                    }}
                  >
                    {protocol}
                  </span>
                )}
              </label>

              <button
                type="button"
                className="clone-repo-chip-btn"
                onClick={handlePasteClipboard}
                title="尝试从系统剪贴板快速填入 URL"
              >
                <span>📋</span> 从剪贴板粘贴
              </button>
            </div>

            <div className="clone-repo-input-wrapper">
              <span className="clone-repo-input-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              </span>
              <input
                id="clone-input-url"
                className="clone-repo-input"
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="例如: https://github.com/owner/repo.git 或 git@github.com:..."
                disabled={busy}
                autoFocus
              />
            </div>

            {/* 常用托管平台辅助快捷前缀 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>快捷填入:</span>
              <button
                type="button"
                className="clone-repo-chip-btn"
                onClick={() => setUrl('https://github.com/')}
                disabled={busy}
              >
                GitHub
              </button>
              <button
                type="button"
                className="clone-repo-chip-btn"
                onClick={() => setUrl('https://gitee.com/')}
                disabled={busy}
              >
                Gitee (码云)
              </button>
              <button
                type="button"
                className="clone-repo-chip-btn"
                onClick={() => setUrl('https://gitlab.com/')}
                disabled={busy}
              >
                GitLab
              </button>
              {repoName && (
                <span style={{ fontSize: 11, color: '#38bdf8', marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span>✓</span> 项目名: <strong>{repoName}</strong>
                </span>
              )}
            </div>
          </div>

          {/* 目标父目录与完整路径预览 */}
          <div className="clone-repo-field">
            <div className="clone-repo-field-label-row">
              <label className="clone-repo-field-label" htmlFor="clone-input-dir">
                <span>目标存储文件夹 (Parent Directory)</span>
              </label>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>将在该目录下自动创建项目文件夹</span>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div className="clone-repo-input-wrapper" style={{ flex: 1 }}>
                <span className="clone-repo-input-icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </span>
                <input
                  id="clone-input-dir"
                  className="clone-repo-input"
                  type="text"
                  value={parentDir}
                  onChange={(e) => setParentDir(e.target.value)}
                  placeholder="点击右侧按钮选择或手动输入父目录"
                  disabled={busy}
                />
              </div>

              <button
                type="button"
                onClick={() => void pickDir()}
                disabled={busy}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 38,
                  padding: '0 14px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-panel, rgba(255, 255, 255, 0.05))',
                  color: 'var(--text)',
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.15s ease',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                浏览…
              </button>
            </div>

            {/* 目标工作区路径实时预览卡片 */}
            {resolvedTargetPath && (
              <div className="clone-repo-preview-card" style={{ marginTop: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ color: '#38bdf8', fontWeight: 600 }}>📁 克隆后工作区路径预览:</span>
                  <span style={{ fontSize: 10.5, color: '#34d399' }}>✓ 自动生成新目录</span>
                </div>
                <div style={{ fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-bright, #fff)', wordBreak: 'break-all' }}>
                  {resolvedTargetPath}
                </div>
              </div>
            )}
          </div>

          {/* 分支（可选） */}
          <div className="clone-repo-field">
            <div className="clone-repo-field-label-row">
              <label className="clone-repo-field-label" htmlFor="clone-input-branch">
                <span>检出分支 / 标签 (Branch / Tag - 可选)</span>
              </label>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>留空默认拉取远程 HEAD 默认分支</span>
            </div>

            <div className="clone-repo-input-wrapper">
              <span className="clone-repo-input-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
              </span>
              <input
                id="clone-input-branch"
                className="clone-repo-input"
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="例如: main 或 master (留空自动拉取远程默认分支)"
                disabled={busy}
              />
            </div>

            {/* 常用分支快捷按钮 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>常用分支:</span>
              {['main', 'master', 'dev', 'release'].map((b) => (
                <button
                  key={b}
                  type="button"
                  className="clone-repo-chip-btn"
                  onClick={() => setBranch(b)}
                  disabled={busy}
                >
                  {b}
                </button>
              ))}
              {branch && (
                <button
                  type="button"
                  className="clone-repo-chip-btn"
                  style={{ color: 'var(--muted)' }}
                  onClick={() => setBranch('')}
                  disabled={busy}
                >
                  清除
                </button>
              )}
            </div>
          </div>

          {/* ── 错误提示区域 ── */}
          {error && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#f87171',
                fontSize: 12,
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                lineHeight: 1.5,
              }}
            >
              <span style={{ fontSize: 14, flexShrink: 0 }}>⚠️</span>
              <div style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>克隆失败</div>
                <div>{error}</div>
                <div style={{ fontSize: 11, opacity: 0.85, marginTop: 4 }}>
                  建议：请检查仓库 URL 是否正确、网络环境与代理配置，以及私有仓库的 SSH 密钥或访问权限。
                </div>
              </div>
            </div>
          )}

          {/* ── 拟真 macOS 终端实时日志流卡片 ── */}
          {(busy || log) && (
            <div className="runtime-terminal-card" style={{ marginTop: 2 }}>
              <div className="runtime-terminal-titlebar">
                <div className="runtime-terminal-dots">
                  <span className="runtime-terminal-dot red" />
                  <span className="runtime-terminal-dot yellow" />
                  <span className="runtime-terminal-dot green" />
                  <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>Terminal · Git Clone 进度与实时日志</span>
                    {busy && (
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: '#38bdf8',
                          boxShadow: '0 0 6px #38bdf8',
                          display: 'inline-block',
                        }}
                      />
                    )}
                  </span>
                </div>
                {busy && (
                  <span style={{ fontSize: 10.5, color: '#38bdf8', fontWeight: 500 }}>
                    正在克隆中…
                  </span>
                )}
              </div>
              <div
                ref={logContainerRef}
                style={{
                  flex: 1,
                  minHeight: 80,
                  maxHeight: 360,
                  overflowY: 'auto',
                  padding: '10px 14px',
                  fontFamily: 'var(--font-mono, "SF Mono", Consolas, monospace)',
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  color: '#e2e8f0',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {log || '$ git clone --progress ...\n正在连接远程主机并检索仓库元数据...'}
              </div>
            </div>
          )}
        </div>

        {/* ── 底部操作栏 ── */}
        <div className="clone-repo-footer">
          <div style={{ fontSize: 11, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>💡 快捷键:</span>
            <kbd style={{ padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,0.08)', border: '1px solid var(--border)', fontSize: 10 }}>
              Esc
            </kbd>
            <span>取消</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <kbd style={{ padding: '1px 5px', borderRadius: 4, background: 'rgba(255,255,255,0.08)', border: '1px solid var(--border)', fontSize: 10 }}>
              ↵ Enter
            </kbd>
            <span>克隆</span>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--text)',
                fontSize: 12.5,
                cursor: busy ? 'not-allowed' : 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              取消
            </button>

            <button
              type="button"
              disabled={busy || !url.trim() || !parentDir.trim()}
              onClick={() => void clone()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 18px',
                borderRadius: 6,
                border: 'none',
                background: busy || !url.trim() || !parentDir.trim()
                  ? 'rgba(255, 255, 255, 0.1)'
                  : 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
                color: '#fff',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: busy || !url.trim() || !parentDir.trim() ? 'not-allowed' : 'pointer',
                opacity: busy || !url.trim() || !parentDir.trim() ? 0.45 : 1,
                boxShadow: busy || !url.trim() || !parentDir.trim() ? 'none' : '0 2px 8px rgba(34, 197, 94, 0.4)',
                transition: 'all 0.15s ease',
              }}
            >
              {busy ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="spin-icon">
                    <line x1="12" y1="2" x2="12" y2="6" />
                    <line x1="12" y1="18" x2="12" y2="22" />
                    <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
                    <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
                    <line x1="2" y1="12" x2="6" y2="12" />
                    <line x1="18" y1="12" x2="22" y2="12" />
                    <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
                    <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
                  </svg>
                  <span>正在克隆…</span>
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 3v12" />
                    <path d="m8 11 4 4 4-4" />
                    <path d="M5 19h14" />
                  </svg>
                  <span>开始克隆 (Clone)</span>
                </>
              )}
            </button>
          </div>
        </div>
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}
