import React, { useEffect, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { GitBranchInfo, GitStatusResult } from '@deepseek-ide/shared';
import { useModalResize, ModalResizeHandle, createSafeOverlayHandlers } from '../hooks/useModalResize';
import { useI18n, translateSegments } from '../i18n';

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
  const { t, locale } = useI18n();
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

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onClose, submitting]);

  if (!open || typeof document === 'undefined') return null;

  const trimmed = branchName.trim();
  const alreadyExists = branches.some((b) => b.name === trimmed);
  const hasInvalidChars = /[[\s~^:?*\\]/.test(trimmed);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!trimmed) {
      setError(t('git.branchNameRequired'));
      return;
    }
    if (hasInvalidChars) {
      setError(t('git.branchNameInvalid'));
      return;
    }
    if (alreadyExists) {
      setError(t('git.branchNameExists', { name: trimmed }));
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const res = await onCreate(trimmed, checkout);
      if (res.ok) {
        onClose();
      } else {
        setError(res.detail || t('git.createBranchFailed'));
      }
    } catch (err: any) {
      setError(err?.message || t('git.createBranchError'));
    } finally {
      setSubmitting(false);
    }
  };

  const safeOverlay = createSafeOverlayHandlers(submitting ? undefined : onClose);

  return createPortal(
    <div className="git-modal-overlay" {...safeOverlay}>
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
            <span style={{ fontWeight: 600, fontSize: 14 }}>{t('git.createBranchTitle')}</span>
          </div>
          <button type="button" className="panel-action-btn" title={t('common.close')} onClick={onClose} disabled={submitting}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {translateSegments('git.createBranchDesc', locale, { branch: currentBranch || 'HEAD' }).map(
              (seg, i) =>
                seg.emphasis ? (
                  <strong key={i} style={{ color: 'var(--text)' }}>
                    {seg.text}
                  </strong>
                ) : (
                  <React.Fragment key={i}>{seg.text}</React.Fragment>
                ),
            )}
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 6, color: 'var(--text)' }}>
              {t('git.branchNameLabel')}
            </label>
            <input
              ref={inputRef}
              type="text"
              className="git-modal-input"
              placeholder={t('git.branchNamePlaceholder')}
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
            <span>{t('git.checkoutAfterCreate')}</span>
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 'auto', paddingTop: 8 }}>
            <button type="button" className="git-modal-btn secondary" onClick={onClose} disabled={submitting}>
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="git-modal-btn primary"
              disabled={!trimmed || alreadyExists || hasInvalidChars || submitting}
            >
              {submitting ? t('git.creating') : checkout ? t('git.createAndSwitch') : t('git.createOnly')}
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
  const { t, locale } = useI18n();
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

  // 支持按 Esc 键安全退出签出/切换分支弹窗
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !switching) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, switching, onClose]);

  const safeOverlay = createSafeOverlayHandlers(switching ? undefined : onClose);

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
        setError(res.detail || t('git.switchBranchFailed', { name }));
      }
    } catch (err: any) {
      setError(err?.message || t('git.switchBranchError'));
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
      const stashRes = await window.ide.gitStash(
        'push',
        t('git.autoStashMessage', { target }),
      );
      if (!stashRes.ok) {
        setError(stashRes.detail || t('git.autoStashFailed'));
        setSwitching(null);
        return;
      }
      setUnsavedWarning(null);
      await performCheckout(target);
    } catch (err: any) {
      setError(err?.message || t('git.autoStashError'));
      setSwitching(null);
    }
  };

  return createPortal(
    <div className="git-modal-overlay" {...safeOverlay}>
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
            <span style={{ fontWeight: 600, fontSize: 14 }}>{t('git.checkoutTitle')}</span>
          </div>
          <button type="button" className="panel-action-btn" title={t('git.closeEsc')} onClick={onClose} disabled={!!switching}>
            ✕
          </button>
        </div>

        <div style={{ position: 'relative', marginBottom: 10 }}>
          <input
            ref={inputRef}
            type="text"
            className="git-modal-input"
            placeholder={t('git.searchBranchesPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        {error && <div style={{ color: '#f87171', fontSize: 12, marginBottom: 8 }}>{error}</div>}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
              {t('git.noMatchingBranches')}
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
                    background: isCurrent ? '#242424' : 'transparent',
                    border: isCurrent ? '1px solid rgba(255, 255, 255, 0.2)' : '1px solid transparent',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke={isCurrent ? '#ffffff' : b.remote ? 'var(--muted)' : 'currentColor'}
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
                          color: isCurrent ? '#ffffff' : 'var(--text)',
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
                        <span style={{ fontSize: 10.5, color: '#ffffff', fontWeight: 600, background: 'rgba(255, 255, 255, 0.15)', padding: '1px 6px', borderRadius: 4 }}>
                          {t('git.currentTag')}
                        </span>
                      )}
                      {b.remote && (
                        <span style={{ fontSize: 10.5, color: 'var(--muted)', background: 'rgba(255, 255, 255, 0.08)', padding: '1px 6px', borderRadius: 4 }}>
                          {t('git.remoteTag')}
                        </span>
                      )}
                      {isTarget && (
                        <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('git.switchingTo')}</span>
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
                          color: 'var(--accent-light, #3794ff)',
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
                        {b.lastCommit.message || t('git.noCommitMessage')}
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
            {t('git.branchCountHint', { n: branches.length })}
          </span>
          <button type="button" className="git-modal-btn secondary" onClick={onClose} disabled={!!switching}>
            {t('common.close')}
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
                background: 'var(--bg-modal, #141414)',
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
                  {t('git.unsavedWarningTitle')}
                </span>
              </div>

              <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text, #ddd)' }}>
                {translateSegments('git.unsavedWarningLead', locale, { changed: unsavedWarning.changedCount }).map((seg, i) =>
                  seg.emphasis ? (
                    <b key={i}>{seg.text}</b>
                  ) : (
                    <React.Fragment key={i}>{seg.text}</React.Fragment>
                  ),
                )}
                {unsavedWarning.stagedCount > 0 && t('git.unsavedWarningStaged', { n: unsavedWarning.stagedCount })}
                {unsavedWarning.unstagedCount > 0 && t('git.unsavedWarningUnstaged', { n: unsavedWarning.unstagedCount })}
                {translateSegments('git.unsavedWarningTail', locale, { target: unsavedWarning.target }).map((seg, i) =>
                  seg.emphasis ? (
                    <b key={i}>{seg.text}</b>
                  ) : (
                    <React.Fragment key={i}>{seg.text}</React.Fragment>
                  ),
                )}
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
                  {t('common.cancel')}
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
                  title={t('git.directCheckoutTip')}
                >
                  {t('git.directCheckout')}
                </button>
                <button
                  type="button"
                  className="git-modal-btn primary"
                  onClick={() => void handleStashAndCheckout()}
                  title={t('git.autoStashCheckoutTip')}
                >
                  {t('git.autoStashCheckout')}
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
  const { t } = useI18n();
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

  if (!open || typeof document === 'undefined') return null;

  const handleCopy = (name: string, url: string) => {
    navigator.clipboard.writeText(url);
    setCopiedName(name);
    setTimeout(() => setCopiedName(null), 1500);
    onShowToast?.(t('git.remotesUrlCopied'), url, 'success');
  };

  const handleFetch = async () => {
    onShowToast?.(t('git.fetching'), undefined, 'info');
    try {
      const res = await window.ide.gitFetch();
      if (res.ok) {
        onShowToast?.(t('git.fetchOk'), res.detail || t('git.fetchOkDetail'), 'success');
        onRefreshBranches?.();
      } else {
        onShowToast?.(t('git.fetchFailed'), res.detail, 'error');
      }
    } catch (err: any) {
      onShowToast?.(t('git.fetchError'), err?.message, 'error');
    }
  };

  const safeOverlay = createSafeOverlayHandlers(onClose);

  return createPortal(
    <div className="git-modal-overlay" {...safeOverlay}>
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
            <span style={{ fontWeight: 600, fontSize: 14 }}>{t('git.remotesTitle')}</span>
          </div>
          <button type="button" className="panel-action-btn" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {loading ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)' }}>{t('git.loadingRemotes')}</div>
          ) : remotes.length === 0 ? (
            <div style={{ padding: '24px 16px', background: 'rgba(255,255,255,0.02)', borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{t('git.noRemotes')}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                {t('git.noRemotesHint')}
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
                    {copiedName === r.name ? t('git.copiedOk') : t('git.copyUrl')}
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
              <span>{t('git.fetchNow')}</span>
            </button>

            <button type="button" className="git-modal-btn primary" onClick={onClose}>
              {t('git.done')}
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
  const { t, locale } = useI18n();
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

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onClose, submitting]);

  if (!open || typeof document === 'undefined') return null;

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const name = tagName.trim();
    if (!name) {
      setError(t('git.tagNameRequired'));
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const res = await onCreateTag(name, tagMsg.trim() || undefined);
      if (res.ok) {
        onClose();
      } else {
        setError(res.detail || t('git.createTagFailed'));
      }
    } catch (err: any) {
      setError(err?.message || t('git.createTagError'));
    } finally {
      setSubmitting(false);
    }
  };

  const safeOverlay = createSafeOverlayHandlers(submitting ? undefined : onClose);

  return createPortal(
    <div className="git-modal-overlay" {...safeOverlay}>
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
            <span style={{ fontWeight: 600, fontSize: 14 }}>{t('git.createTagTitle')}</span>
          </div>
          <button type="button" className="panel-action-btn" title={t('common.close')} onClick={onClose} disabled={submitting}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {translateSegments('git.createTagDesc', locale, { branch: currentBranch || 'HEAD' }).map((seg, i) =>
              seg.emphasis ? (
                <strong key={i} style={{ color: 'var(--text)' }}>{seg.text}</strong>
              ) : (
                <React.Fragment key={i}>{seg.text}</React.Fragment>
              ),
            )}
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 5, color: 'var(--text)' }}>
              {t('git.tagNameLabel')}
            </label>
            <input
              ref={inputRef}
              type="text"
              className="git-modal-input"
              placeholder={t('git.tagNamePlaceholder')}
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
              {t('git.tagMessageLabel')}
            </label>
            <input
              type="text"
              className="git-modal-input"
              placeholder={t('git.tagMessagePlaceholder')}
              value={tagMsg}
              onChange={(e) => setTagMsg(e.target.value)}
              disabled={submitting}
            />
          </div>

          {error && <div style={{ color: '#f87171', fontSize: 12 }}>{error}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 'auto', paddingTop: 6 }}>
            <button type="button" className="git-modal-btn secondary" onClick={onClose} disabled={submitting}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="git-modal-btn primary" disabled={!tagName.trim() || submitting}>
              {submitting ? t('git.creating') : t('git.createTagBtn')}
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
  const { t } = useI18n();
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_git_status_modal_size',
    defaultWidth: 580,
    defaultHeight: 520,
    minWidth: 440,
    minHeight: 360,
  });
  const [refreshing, setRefreshing] = useState(false);

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

  const safeOverlay = createSafeOverlayHandlers(onClose);

  return createPortal(
    <div className="git-modal-overlay" {...safeOverlay}>
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
            <span style={{ fontWeight: 600, fontSize: 14 }}>{t('git.statusTitle')}</span>
          </div>
          <button type="button" className="panel-action-btn" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 顶部概览卡片 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 }}>
          <div style={{ padding: '8px 10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)', borderRadius: 6 }}>
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t('git.statusBranch')}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#38bdf8', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {status?.branch || 'main'}
            </div>
          </div>
          <div style={{ padding: '8px 10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)', borderRadius: 6 }}>
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t('git.statusStaged')}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#22c55e', marginTop: 2 }}>{t('git.filesCount', { n: stagedCount })}</div>
          </div>
          <div style={{ padding: '8px 10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)', borderRadius: 6 }}>
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t('git.statusUnstaged')}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#facc15', marginTop: 2 }}>{t('git.filesCount', { n: unstagedCount })}</div>
          </div>
          <div style={{ padding: '8px 10px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--border)', borderRadius: 6 }}>
            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t('git.statusUntracked')}</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#a855f7', marginTop: 2 }}>{t('git.filesCount', { n: untrackedCount })}</div>
          </div>
        </div>

        {/* 变动文件列表 */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, background: 'rgba(0,0,0,0.2)' }}>
          {entries.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
              {t('git.statusClean')}
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
                  {e.untracked ? t('git.badgeUntracked') : e.staged ? t('git.badgeStaged') : t('git.badgeModified')}
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
            <span>{refreshing ? t('git.refreshing') : t('git.refreshStatus')}</span>
          </button>

          <button type="button" className="git-modal-btn primary" onClick={onClose}>
            {t('common.close')}
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
  const { t } = useI18n();
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

  if (!open || typeof document === 'undefined') return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const safeOverlay = createSafeOverlayHandlers(onClose);

  return createPortal(
    <div className="git-modal-overlay" {...safeOverlay}>
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
            <span style={{ fontWeight: 600, fontSize: 14 }}>{t('git.outputTitle')}</span>
          </div>
          <button type="button" className="panel-action-btn" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            background: 'var(--bg-input, #141414)',
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
            <div style={{ color: 'var(--muted)' }}>{t('git.loadingOutput')}</div>
          ) : lines.length === 0 ? (
            <div style={{ color: 'var(--muted)' }}>{t('git.noOutput')}</div>
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
              {t('git.refreshLog')}
            </button>
            <button type="button" className="git-modal-btn secondary" onClick={handleCopy} disabled={lines.length === 0}>
              {copied ? t('git.copyAll') : t('git.copyLog')}
            </button>
          </div>

          <button type="button" className="git-modal-btn primary" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}
