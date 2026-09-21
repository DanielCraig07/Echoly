import React, { useEffect, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { GitBranchInfo, GitStatusResult } from '@deepseek-ide/shared';
import { useModalResize, ModalResizeHandle } from '../hooks/useModalResize';

// ── 1. 新建分支弹窗 (GitCreateBranchModal) ──
interface CreateBranchModalProps {
  open: boolean;
  currentBranch: string;
  branches: GitBranchInfo[];
  onClose: () => void;
  onCreate: (name: string, checkout: boolean) => Promise<{ ok: boolean; detail?: string }>;
}

export function GitCreateBranchModal({
  open,
  currentBranch,
  branches,
  onClose,
  onCreate,
}: CreateBranchModalProps) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_git_create_branch_modal_size',
    defaultWidth: 460,
    defaultHeight: 390,
    minWidth: 380,
    minHeight: 320,
  });
  const [branchName, setBranchName] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setBranchName('');
      setCheckout(true);
      setError('');
      setSubmitting(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const trimmed = branchName.trim();
  const alreadyExists = branches.some((b) => b.name === trimmed);
  const hasInvalidChars = /[[\s~^:?*\\]/.test(trimmed);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!trimmed) {
      setError('请输入有效的分支名称');
      return;
    }
    if (hasInvalidChars) {
      setError('分支名不能包含空格或 ~ ^ : ? * [ 等非法字符');
      return;
    }
    if (alreadyExists) {
      setError(`分支 "${trimmed}" 已存在，请使用其他名称`);
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const res = await onCreate(trimmed, checkout);
      if (res.ok) {
        onClose();
      } else {
        setError(res.detail || '创建分支失败');
      }
    } catch (err: any) {
      setError(err?.message || '创建分支异常');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="git-modal-overlay" onClick={submitting ? undefined : onClose}>
      <div
        className="git-modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="git-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ fontWeight: 600, fontSize: 14 }}>新建分支</span>
          </div>
          <button type="button" className="panel-action-btn" title="关闭" onClick={onClose} disabled={submitting}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            基于当前分支 <strong style={{ color: 'var(--text)' }}>{currentBranch || 'HEAD'}</strong> 创建新分支
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 6, color: 'var(--text)' }}>
              分支名称
            </label>
            <input
              ref={inputRef}
              type="text"
              className="git-modal-input"
              placeholder="例如: feature/awesome-feature 或 fix/bug-1"
              value={branchName}
              onChange={(e) => {
                setBranchName(e.target.value);
                setError('');
              }}
              disabled={submitting}
            />
            {error && <div style={{ color: '#f87171', fontSize: 11.5, marginTop: 5 }}>{error}</div>}
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={checkout}
              onChange={(e) => setCheckout(e.target.checked)}
              disabled={submitting}
            />
            <span>创建后立即签出 (切换) 到该分支</span>
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 'auto', paddingTop: 8 }}>
            <button type="button" className="git-modal-btn secondary" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button
              type="submit"
              className="git-modal-btn primary"
              disabled={!trimmed || alreadyExists || hasInvalidChars || submitting}
            >
              {submitting ? '创建中...' : checkout ? '创建并切换' : '仅创建'}
            </button>
          </div>
        </form>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}

// ── 2. 签出/切换分支弹窗 (GitCheckoutModal) ──
interface CheckoutModalProps {
  open: boolean;
  currentBranch: string;
  branches: GitBranchInfo[];
  onClose: () => void;
  onCheckout: (branchName: string) => Promise<{ ok: boolean; detail?: string }>;
}

export function GitCheckoutModal({
  open,
  currentBranch,
  branches,
  onClose,
  onCheckout,
}: CheckoutModalProps) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_git_checkout_modal_size',
    defaultWidth: 500,
    defaultHeight: 560,
    minWidth: 420,
    minHeight: 380,
  });
  const [filter, setFilter] = useState('');
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [unsavedWarning, setUnsavedWarning] = useState<{
    target: string;
    changedCount: number;
    stagedCount: number;
    unstagedCount: number;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setFilter('');
      setSwitching(null);
      setError('');
      setUnsavedWarning(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const filtered = branches.filter((b) =>
    b.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  const handleSelect = async (name: string) => {
    if (name === currentBranch || switching) return;
    setSwitching(name);
    setError('');
    try {
      const st = await window.ide.gitStatus();
      if (st.ok && st.entries && st.entries.length > 0) {
        setSwitching(null);
        setUnsavedWarning({
          target: name,
          changedCount: st.entries.length,
          stagedCount: st.entries.filter((e) => e.staged).length,
          unstagedCount: st.entries.filter((e) => !e.staged).length,
        });
        return;
      }
    } catch {}

    await performCheckout(name);
  };

  const performCheckout = async (name: string) => {
    setSwitching(name);
    setError('');
    try {
      const res = await onCheckout(name);
      if (res.ok) {
        onClose();
      } else {
        setError(res.detail || `切换分支到 ${name} 失败`);
      }
    } catch (err: any) {
      setError(err?.message || '切换分支遇到异常');
    } finally {
      setSwitching(null);
    }
  };

  const handleStashAndCheckout = async () => {
    if (!unsavedWarning) return;
    const target = unsavedWarning.target;
    setSwitching(target);
    setError('');
    try {
      const stashRes = await window.ide.gitStash('push', `Echoly 切换至 ${target} 前自动暂存修改`);
      if (!stashRes.ok) {
        setError(stashRes.detail || '自动暂存修改失败');
        setSwitching(null);
        return;
      }
      setUnsavedWarning(null);
      await performCheckout(target);
    } catch (err: any) {
      setError(err?.message || '自动暂存遇到异常');
      setSwitching(null);
    }
  };

  return createPortal(
    <div className="git-modal-overlay" onClick={switching ? undefined : onClose}>
      <div
        className="git-modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="git-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 3h5v5" />
              <path d="M4 20L21 3" />
              <path d="M21 16v5h-5" />
              <path d="M15 15l6 6" />
              <path d="M4 4l5 5" />
            </svg>
            <span style={{ fontWeight: 600, fontSize: 14 }}>签出 / 切换分支</span>
          </div>
          <button type="button" className="panel-action-btn" title="关闭" onClick={onClose} disabled={!!switching}>
            ✕
          </button>
        </div>

        <div style={{ position: 'relative', marginBottom: 10 }}>
          <input
            ref={inputRef}
            type="text"
            className="git-modal-input"
            placeholder="搜索本地或远程分支..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        {error && <div style={{ color: '#f87171', fontSize: 12, marginBottom: 8 }}>{error}</div>}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
              未匹配到相关分支
            </div>
          ) : (
            filtered.map((b) => {
              const isCurrent = b.name === currentBranch;
              const isTarget = switching === b.name;
              return (
                <div
                  key={b.name}
                  className={`git-branch-list-item ${isCurrent ? 'current' : ''}`}
                  onClick={() => void handleSelect(b.name)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    padding: '8px 10px',
                    borderRadius: 6,
                    cursor: isCurrent ? 'default' : 'pointer',
                    background: isCurrent ? 'rgba(56, 189, 248, 0.1)' : 'transparent',
                    border: isCurrent ? '1px solid rgba(56, 189, 248, 0.25)' : '1px solid transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke={isCurrent ? '#38bdf8' : b.remote ? '#a855f7' : 'currentColor'}
                        strokeWidth="2"
                      >
                        <line x1="6" y1="3" x2="6" y2="15" />
                        <circle cx="18" cy="6" r="3" />
                        <circle cx="6" cy="18" r="3" />
                        <path d="M18 9a9 9 0 0 1-9 9" />
                      </svg>
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: isCurrent ? 600 : 400,
                          color: isCurrent ? '#38bdf8' : 'var(--text)',
                          textOverflow: 'ellipsis',
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {b.name}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {isCurrent && (
                        <span style={{ fontSize: 10.5, color: '#38bdf8', fontWeight: 600, background: 'rgba(56, 189, 248, 0.15)', padding: '1px 6px', borderRadius: 4 }}>
                          当前
                        </span>
                      )}
                      {b.remote && (
                        <span style={{ fontSize: 10.5, color: '#a855f7', background: 'rgba(168, 85, 247, 0.15)', padding: '1px 6px', borderRadius: 4 }}>
                          远程
                        </span>
                      )}
                      {isTarget && (
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>切换中...</span>
                      )}
                    </div>
                  </div>

                  {/* 最新提交历史记录 */}
                  {b.lastCommit && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 11,
                        color: 'var(--muted)',
                        paddingLeft: 22,
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                          background: 'rgba(255, 255, 255, 0.08)',
                          color: '#7dd3fc',
                          padding: '1px 4px',
                          borderRadius: 3,
                          fontSize: 10.5,
                          flexShrink: 0,
                        }}
                      >
                        {b.lastCommit.hash}
                      </span>
                      <span
                        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
                        title={b.lastCommit.message}
                      >
                        {b.lastCommit.message || '无提交信息'}
                      </span>
                      {(b.lastCommit.relativeDate || b.lastCommit.author) && (
                        <span style={{ opacity: 0.7, flexShrink: 0, fontSize: 10.5 }}>
                          • {b.lastCommit.relativeDate || b.lastCommit.author}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            共 {branches.length} 个分支 (点击即可一键切换)
          </span>
          <button type="button" className="git-modal-btn secondary" onClick={onClose} disabled={!!switching}>
            关闭
          </button>
        </div>

        {/* 未暂存或未提交修改确认弹窗 */}
        {unsavedWarning && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 99,
              background: 'rgba(0, 0, 0, 0.76)',
              backdropFilter: 'blur(3px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 20,
              borderRadius: 10,
            }}
          >
            <div
              style={{
                width: '100%',
                background: 'var(--bg-elevated, #202026)',
                border: '1px solid rgba(234, 179, 8, 0.35)',
                borderRadius: 10,
                boxShadow: '0 20px 50px rgba(0,0,0,0.7)',
                padding: '18px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ fontSize: 18 }}>⚠️</span>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: '#facc15' }}>
                  检测到本地存在未暂存/未提交修改
                </span>
              </div>

              <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text, #ddd)' }}>
                当前工作区检测到 <b>{unsavedWarning.changedCount}</b> 个文件有变动
                {unsavedWarning.stagedCount > 0 && `（已暂存 ${unsavedWarning.stagedCount} 项）`}
                {unsavedWarning.unstagedCount > 0 && `（未暂存 ${unsavedWarning.unstagedCount} 项）`}。
                直接签出到目标分支 <b>"{unsavedWarning.target}"</b> 可能会导致本地修改发生冲突或被覆盖。
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 6,
                }}
              >
                <button
                  type="button"
                  className="git-modal-btn secondary"
                  onClick={() => setUnsavedWarning(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="git-modal-btn secondary"
                  style={{ color: '#f87171' }}
                  onClick={() => {
                    const target = unsavedWarning.target;
                    setUnsavedWarning(null);
                    void performCheckout(target);
                  }}
                  title="直接执行切换（若冲突 git 会拦截）"
                >
                  直接签出
                </button>
                <button
                  type="button"
                  className="git-modal-btn primary"
                  onClick={() => void handleStashAndCheckout()}
                  title="自动将当前修改存入 Git 暂存区后切换分支"
                >
                  自动暂存并签出 (推荐)
                </button>
              </div>
            </div>
          </div>
        )}

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}

// ── 3. 远程仓库管理弹窗 (GitRemotesModal) ──
interface RemotesModalProps {
  open: boolean;
  onClose: () => void;
  onRefreshBranches?: () => void;
  onShowToast?: (title: string, detail?: string, type?: any) => void;
}

export function GitRemotesModal({
  open,
  onClose,
  onRefreshBranches,
  onShowToast,
}: RemotesModalProps) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_git_remotes_modal_size',
    defaultWidth: 560,
    defaultHeight: 480,
    minWidth: 440,
    minHeight: 360,
  });
  const [remotes, setRemotes] = useState<Array<{ name: string; url: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('origin');
  const [newUrl, setNewUrl] = useState('');
  const [copiedName, setCopiedName] = useState<string | null>(null);

  const loadRemotes = async () => {
    setLoading(true);
    try {
      const res = await window.ide.gitRemotes();
      if (res.ok) {
        setRemotes(res.remotes || []);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      void loadRemotes();
      setAdding(false);
      setNewUrl('');
      setCopiedName(null);
    }
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const handleCopy = (name: string, url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedName(name);
    setTimeout(() => setCopiedName(null), 1500);
    onShowToast?.('✓ 已复制远程仓库地址', url, 'success');
  };

  const handleFetch = async () => {
    onShowToast?.('正在抓取远程分支...', undefined, 'info');
    try {
      const res = await window.ide.gitFetch();
      if (res.ok) {
        onShowToast?.('✓ 刷新远程分支成功', res.detail || '已更新所有远程分支引用', 'success');
        onRefreshBranches?.();
      } else {
        onShowToast?.('✕ 刷新远程分支失败', res.detail, 'error');
      }
    } catch (err: any) {
      onShowToast?.('✕ 抓取异常', err?.message, 'error');
    }
  };

  return createPortal(
    <div className="git-modal-overlay" onClick={onClose}>
      <div
        className="git-modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="git-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <span style={{ fontWeight: 600, fontSize: 14 }}>远程仓库配置 (Git Remotes)</span>
          </div>
          <button type="button" className="panel-action-btn" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}>加载远程信息中...</div>
          ) : remotes.length === 0 ? (
            <div style={{ padding: '24px 16px', background: 'rgba(255,255,255,0.02)', borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>当前项目尚未关联远程仓库</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                您可以通过下方添加远程仓库地址，或者使用终端关联 GitHub / GitLab 仓库。
              </div>
            </div>
          ) : (
            remotes.map((r) => (
              <div
                key={r.name}
                style={{
                  padding: '10px 12px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                }}
              >
                <div style={{ overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{r.name}</span>
                    <span style={{ fontSize: 10, color: '#38bdf8', background: 'rgba(56,189,248,0.12)', padding: '1px 5px', borderRadius: 4 }}>
                      fetch / push
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'var(--muted)',
                      marginTop: 3,
                      fontFamily: 'monospace',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={r.url}
                  >
                    {r.url}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <button
                    type="button"
                    className="git-modal-btn secondary"
                    style={{ padding: '3px 8px', fontSize: 11 }}
                    onClick={() => handleCopy(r.name, r.url)}
                  >
                    {copiedName === r.name ? '✓ 已复制' : '复制地址'}
                  </button>
                </div>
              </div>
            ))
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto', paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <button
              type="button"
              className="git-modal-btn secondary"
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              onClick={handleFetch}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              <span>立即抓取同步 (Fetch)</span>
            </button>

            <button type="button" className="git-modal-btn primary" onClick={onClose}>
              完成
            </button>
          </div>
        </div>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}

// ── 4. 创建标签弹窗 (GitCreateTagModal) ──
interface CreateTagModalProps {
  open: boolean;
  currentBranch: string;
  onClose: () => void;
  onCreateTag: (name: string, message?: string) => Promise<{ ok: boolean; detail?: string }>;
}

export function GitCreateTagModal({
  open,
  currentBranch,
  onClose,
  onCreateTag,
}: CreateTagModalProps) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_git_create_tag_modal_size',
    defaultWidth: 480,
    defaultHeight: 420,
    minWidth: 380,
    minHeight: 320,
  });
  const [tagName, setTagName] = useState('');
  const [tagMsg, setTagMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTagName('');
      setTagMsg('');
      setError('');
      setSubmitting(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const name = tagName.trim();
    if (!name) {
      setError('请输入标签名称');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const res = await onCreateTag(name, tagMsg.trim() || undefined);
      if (res.ok) {
        onClose();
      } else {
        setError(res.detail || '创建标签失败');
      }
    } catch (err: any) {
      setError(err?.message || '创建标签异常');
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="git-modal-overlay" onClick={submitting ? undefined : onClose}>
      <div
        className="git-modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="git-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
              <line x1="7" y1="7" x2="7.01" y2="7" />
            </svg>
            <span style={{ fontWeight: 600, fontSize: 14 }}>创建 Git 标签 (Tag)</span>
          </div>
          <button type="button" className="panel-action-btn" title="关闭" onClick={onClose} disabled={submitting}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            在当前分支 <strong style={{ color: 'var(--text)' }}>{currentBranch || 'HEAD'}</strong> 最新提交上打标签
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 5, color: 'var(--text)' }}>
              标签名称 (Tag Name) *
            </label>
            <input
              ref={inputRef}
              type="text"
              className="git-modal-input"
              placeholder="例如: v1.0.0 或 release-202609"
              value={tagName}
              onChange={(e) => {
                setTagName(e.target.value);
                setError('');
              }}
              disabled={submitting}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 5, color: 'var(--text)' }}>
              标签说明 (Message, 可选)
            </label>
            <input
              type="text"
              className="git-modal-input"
              placeholder="输入简短版本说明（可选）"
              value={tagMsg}
              onChange={(e) => setTagMsg(e.target.value)}
              disabled={submitting}
            />
          </div>

          {error && <div style={{ color: '#f87171', fontSize: 12 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 'auto', paddingTop: 6 }}>
            <button type="button" className="git-modal-btn secondary" onClick={onClose} disabled={submitting}>
              取消
            </button>
            <button type="submit" className="git-modal-btn primary" disabled={!tagName.trim() || submitting}>
              {submitting ? '创建中...' : '创建 Tag'}
            </button>
          </div>
        </form>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}

// ── 5. 工作树状态弹窗 (GitStatusModal) ──
interface StatusModalProps {
  open: boolean;
  status: GitStatusResult | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

export function GitStatusModal({
  open,
  status,
  onClose,
  onRefresh,
}: StatusModalProps) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_git_status_modal_size',
    defaultWidth: 580,
    defaultHeight: 520,
    minWidth: 440,
    minHeight: 360,
  });
  const [refreshing, setRefreshing] = useState(false);

  if (!open || typeof document === 'undefined') return null;

  const entries = status?.entries || [];
  const stagedCount = entries.filter((e) => e.staged).length;
  const unstagedCount = entries.filter((e) => !e.staged && !e.untracked).length;
  const untrackedCount = entries.filter((e) => e.untracked).length;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return createPortal(
    <div className="git-modal-overlay" onClick={onClose}>
      <div
        className="git-modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="git-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span style={{ fontWeight: 600, fontSize: 14 }}>工作树状态 (Working Tree Status)</span>
          </div>
          <button type="button" className="panel-action-btn" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 顶部概览卡片 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
          <div style={{ padding: '8px 10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)', borderRadius: 6 }}>
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>当前分支</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#38bdf8', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {status?.branch || 'main'}
            </div>
          </div>
          <div style={{ padding: '8px 10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)', borderRadius: 6 }}>
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>暂存区</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#22c55e', marginTop: 2 }}>{stagedCount} 个文件</div>
          </div>
          <div style={{ padding: '8px 10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)', borderRadius: 6 }}>
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>未暂存修改</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#facc15', marginTop: 2 }}>{unstagedCount} 个文件</div>
          </div>
          <div style={{ padding: '8px 10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)', borderRadius: 6 }}>
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>未跟踪 (新增)</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#a855f7', marginTop: 2 }}>{untrackedCount} 个文件</div>
          </div>
        </div>

        {/* 变动文件列表 */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, background: 'rgba(0,0,0,0.2)' }}>
          {entries.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
              ✓ 工作树干净，没有未提交的本地修改 (Working Tree Clean)
            </div>
          ) : (
            entries.map((e) => (
              <div
                key={e.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 10px',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                  fontSize: 12,
                }}
              >
                <span style={{ fontFamily: 'monospace', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.path}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '1px 5px',
                    borderRadius: 3,
                    background: e.untracked ? 'rgba(168, 85, 247, 0.15)' : e.staged ? 'rgba(34, 197, 94, 0.15)' : 'rgba(250, 204, 21, 0.15)',
                    color: e.untracked ? '#c084fc' : e.staged ? '#4ade80' : '#fde047',
                  }}
                >
                  {e.untracked ? 'U (新增)' : e.staged ? 'S (已暂存)' : 'M (修改)'}
                </span>
              </div>
            ))
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
          <button
            type="button"
            className="git-modal-btn secondary"
            onClick={handleRefresh}
            disabled={refreshing}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            <span>{refreshing ? '刷新中...' : '刷新状态'}</span>
          </button>

          <button type="button" className="git-modal-btn primary" onClick={onClose}>
            关闭
          </button>
        </div>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}

// ── 6. Git 执行输出日志弹窗 (GitOutputModal) ──
interface OutputModalProps {
  open: boolean;
  onClose: () => void;
}

export function GitOutputModal({ open, onClose }: OutputModalProps) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_git_output_modal_size',
    defaultWidth: 640,
    defaultHeight: 520,
    minWidth: 460,
    minHeight: 360,
  });
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const loadOutput = async () => {
    setLoading(true);
    try {
      const res = await window.ide.gitOutput(120);
      if (res.ok) {
        setLines(res.lines || []);
        setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      void loadOutput();
      setCopied(false);
    }
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return createPortal(
    <div className="git-modal-overlay" onClick={onClose}>
      <div
        className="git-modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div className="git-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Git 执行日志 (Git Output Console)</span>
          </div>
          <button type="button" className="panel-action-btn" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            background: '#0d1117',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 12,
            fontFamily: 'monospace',
            fontSize: 11.5,
            lineHeight: 1.5,
            color: '#e6edf3',
          }}
        >
          {loading ? (
            <div style={{ color: 'var(--muted)' }}>读取日志中...</div>
          ) : lines.length === 0 ? (
            <div style={{ color: 'var(--muted)' }}>暂无 Git 命令执行日志记录</div>
          ) : (
            lines.map((l, i) => (
              <div key={i} style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                {l.startsWith('>') ? (
                  <span style={{ color: '#58a6ff', fontWeight: 600 }}>{l}</span>
                ) : l.toLowerCase().includes('error') || l.toLowerCase().includes('fatal') ? (
                  <span style={{ color: '#f85149' }}>{l}</span>
                ) : (
                  l
                )}
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="git-modal-btn secondary" onClick={loadOutput} disabled={loading}>
              刷新日志
            </button>
            <button type="button" className="git-modal-btn secondary" onClick={handleCopy} disabled={lines.length === 0}>
              {copied ? '✓ 已复制全部' : '复制日志'}
            </button>
          </div>

          <button type="button" className="git-modal-btn primary" onClick={onClose}>
            关闭
          </button>
        </div>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}
