import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { GitBranchInfo } from '@deepseek-ide/shared';
import { useModalResize, ModalResizeHandle, createSafeOverlayHandlers } from '../hooks/useModalResize';
import { useI18n, translateSegments } from '../i18n';

interface Props {
  open: boolean;
  currentBranch?: string | null;
  onClose: () => void;
  onSwitched: () => void;
}

export function BranchSwitchModal({ open, currentBranch, onClose, onSwitched }: Props) {
  const { t, locale } = useI18n();
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_branch_switch_modal_size',
    defaultWidth: 500,
    defaultHeight: 560,
    minWidth: 420,
    minHeight: 380,
  });
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'local' | 'remote' | 'tags'>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [unsavedWarning, setUnsavedWarning] = useState<{
    target: string;
    changedCount: number;
    stagedCount: number;
    unstagedCount: number;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setQuery('');
    void window.ide.gitBranches().then((res) => {
      setLoading(false);
      if (res.ok) {
        const branchList = res.branches || [];
        const tagList = res.tags || [];
        setBranches(branchList);
        setTags(tagList);
        const curIdx = branchList.findIndex((b) => b.current || b.name === currentBranch);
        setSelectedIndex(curIdx >= 0 ? curIdx : 0);
      } else {
        setError(res.detail || t('git.loadBranchesFailed'));
      }
    });
  }, [open, currentBranch]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open, activeTab]);

  const q = query.trim().toLowerCase();
  const localBranches = branches.filter((b) => !b.remote);
  const remoteBranches = branches.filter((b) => b.remote);

  const filteredLocal = q ? localBranches.filter((b) => b.name.toLowerCase().includes(q)) : localBranches;
  const filteredRemote = q ? remoteBranches.filter((b) => b.name.toLowerCase().includes(q)) : remoteBranches;
  const filteredTags = q ? tags.filter((tag) => tag.toLowerCase().includes(q)) : tags;

  const visibleBranches =
    activeTab === 'local'
      ? filteredLocal
      : activeTab === 'remote'
        ? filteredRemote
        : [...filteredLocal, ...filteredRemote];

  const currentListLength =
    activeTab === 'tags' ? filteredTags.length : visibleBranches.length;

  useEffect(() => {
    if (activeTab === 'tags') {
      const curIdx = filteredTags.findIndex((tag) => tag === currentBranch);
      setSelectedIndex(curIdx >= 0 ? curIdx : 0);
    } else {
      const curIdx = visibleBranches.findIndex((b) => b.current || b.name === currentBranch);
      setSelectedIndex(curIdx >= 0 ? curIdx : 0);
    }
  }, [query, activeTab]);

  // Keep selected item visible
  useEffect(() => {
    if (!listRef.current) return;
    const activeItem = listRef.current.querySelector<HTMLElement>(
      `[data-index="${selectedIndex}"]`,
    );
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  async function handleCheckout(target: string) {
    if (target === currentBranch) {
      onClose();
      return;
    }

    setLoading(true);
    setError(null);
    try {
      // 检查本地工作区是否有未提交/未暂存的修改
      const st = await window.ide.gitStatus();
      if (st.ok && st.entries && st.entries.length > 0) {
        setLoading(false);
        const stagedCount = st.entries.filter((e) => e.staged).length;
        const unstagedCount = st.entries.filter((e) => !e.staged).length;
        setUnsavedWarning({
          target,
          changedCount: st.entries.length,
          stagedCount,
          unstagedCount,
        });
        return;
      }
    } catch {
      // 状态检查异常时不阻断签出流程
    }

    await executeCheckout(target);
  }

  async function executeCheckout(target: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await window.ide.gitCheckout(target);
      if (res.ok) {
        onSwitched();
        onClose();
      } else {
        setError(res.detail || t('git.switchFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleStashAndCheckout() {
    if (!unsavedWarning) return;
    const target = unsavedWarning.target;
    setLoading(true);
    setError(null);
    try {
      const stashRes = await window.ide.gitStash(
        'push',
        t('git.autoStashMessage', { target }),
      );
      if (!stashRes.ok) {
        setError(stashRes.detail || t('git.autoStashFailed'));
        setLoading(false);
        return;
      }
      setUnsavedWarning(null);
      await executeCheckout(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (currentListLength > 0) {
        setSelectedIndex((prev) => (prev + 1) % currentListLength);
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (currentListLength > 0) {
        setSelectedIndex((prev) => (prev - 1 + currentListLength) % currentListLength);
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeTab === 'tags') {
        if (filteredTags[selectedIndex]) {
          void handleCheckout(filteredTags[selectedIndex]);
        }
      } else {
        if (visibleBranches[selectedIndex]) {
          void handleCheckout(visibleBranches[selectedIndex].name);
        }
      }
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      const tabs: ('all' | 'local' | 'remote' | 'tags')[] = ['all', 'local', 'remote', 'tags'];
      const curIdx = tabs.indexOf(activeTab);
      if (e.shiftKey) {
        const prevIdx = (curIdx - 1 + tabs.length) % tabs.length;
        setActiveTab(tabs[prevIdx]);
      } else {
        const nextIdx = (curIdx + 1) % tabs.length;
        setActiveTab(tabs[nextIdx]);
      }
      return;
    }
  }

  if (typeof document === 'undefined') return null;

  const safeOverlay = createSafeOverlayHandlers(onClose);

  return createPortal(
    <div
      className="settings-overlay"
      {...safeOverlay}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(4px)',
        zIndex: 9999,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: '10vh',
      }}
    >
      <div
        className="branch-switch-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
          background: 'var(--bg-modal, #141414)',
          border: '1px solid var(--border, rgba(255, 255, 255, 0.12))',
          borderRadius: 10,
          boxShadow: '0 24px 64px -8px rgba(0, 0, 0, 0.8), 0 4px 16px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.08)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          animation: 'scaleIn 0.15s ease-out',
        }}
      >
        {/* Top Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))',
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="currentColor"
              style={{ color: 'var(--accent, #4c8dff)' }}
            >
              <path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0z" />
            </svg>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text, #fff)' }}>
              {t('git.switchTitle')}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Tabs */}
            <div
              style={{
                display: 'flex',
                background: 'rgba(0, 0, 0, 0.28)',
                padding: 2,
                borderRadius: 6,
                border: '1px solid var(--border, rgba(255,255,255,0.06))',
                flexShrink: 0,
              }}
            >
              <button
                type="button"
                onClick={() => setActiveTab('all')}
                style={{
                  border: 'none',
                  background: activeTab === 'all' ? 'rgba(255, 255, 255, 0.14)' : 'transparent',
                  color: activeTab === 'all' ? '#fff' : 'var(--muted, #888)',
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '3px 8px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('git.tabAll', { n: branches.length })}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('local')}
                style={{
                  border: 'none',
                  background: activeTab === 'local' ? 'rgba(255, 255, 255, 0.14)' : 'transparent',
                  color: activeTab === 'local' ? '#fff' : 'var(--muted, #888)',
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '3px 8px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('git.tabLocal', { n: localBranches.length })}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('remote')}
                style={{
                  border: 'none',
                  background: activeTab === 'remote' ? 'rgba(255, 255, 255, 0.14)' : 'transparent',
                  color: activeTab === 'remote' ? '#fff' : 'var(--muted, #888)',
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '3px 8px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('git.tabRemote', { n: remoteBranches.length })}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('tags')}
                style={{
                  border: 'none',
                  background: activeTab === 'tags' ? 'rgba(255, 255, 255, 0.14)' : 'transparent',
                  color: activeTab === 'tags' ? '#fff' : 'var(--muted, #888)',
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '3px 8px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  whiteSpace: 'nowrap',
                }}
              >
                {t('git.tabTagsCount', { n: tags.length })}
              </button>
            </div>

            <button
              type="button"
              className="panel-action-btn"
              onClick={onClose}
              title={t('git.closeEsc')}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Search Input Box */}
        <div
          style={{
            padding: '10px 14px',
            borderBottom: '1px solid var(--border, rgba(255,255,255,0.06))',
            background: 'var(--bg-input, rgba(0, 0, 0, 0.2))',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            style={{ color: 'var(--accent, #4c8dff)', flexShrink: 0, opacity: 0.9 }}
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder={
              activeTab === 'all'
                ? t('git.phAll')
                : activeTab === 'local'
                  ? t('git.phLocal')
                  : activeTab === 'remote'
                    ? t('git.phRemote')
                    : t('git.phTags')
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              width: '100%',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text, #fff)',
              fontSize: 13,
              fontFamily: 'inherit',
            }}
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: 'none',
                color: 'var(--muted, #888)',
                cursor: 'pointer',
                fontSize: 11,
                width: 18,
                height: 18,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                flexShrink: 0,
              }}
              title={t('git.clear')}
            >
              ✕
            </button>
          ) : (
            <span
              style={{
                fontSize: 10,
                padding: '2px 5px',
                borderRadius: 4,
                background: 'rgba(255, 255, 255, 0.06)',
                color: 'var(--muted, #888)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                fontFamily: 'monospace',
                flexShrink: 0,
              }}
            >
              {t('git.tabSwitchHint')}
            </span>
          )}
        </div>

        {/* Error Alert */}
        {error && (
          <div
            style={{
              padding: '8px 14px',
              background: 'rgba(244, 67, 54, 0.12)',
              borderBottom: '1px solid rgba(244, 67, 54, 0.25)',
              color: 'var(--danger, #f44336)',
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* List Section */}
        <div
          ref={listRef}
          style={{
            flex: 1,
            minHeight: 220,
            overflowY: 'auto',
            padding: '6px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {loading && (
            <div
              style={{
                padding: '36px 0',
                textAlign: 'center',
                color: 'var(--muted, #888)',
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ animation: 'spin 1s linear infinite', color: 'var(--accent, #4c8dff)' }}
              >
                <line x1="12" y1="2" x2="12" y2="6" />
                <line x1="12" y1="18" x2="12" y2="22" />
                <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
                <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
                <line x1="2" y1="12" x2="6" y2="12" />
                <line x1="18" y1="12" x2="22" y2="12" />
                <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
                <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
              </svg>
              <span>{t('git.loadingRefs')}</span>
            </div>
          )}

          {!loading && activeTab !== 'tags' && visibleBranches.length === 0 && (
            <div
              style={{
                padding: '36px 0',
                textAlign: 'center',
                color: 'var(--muted, #888)',
                fontSize: 12,
              }}
            >
              {query
                ? activeTab === 'local'
                  ? t('git.noLocalMatch', { query })
                  : activeTab === 'remote'
                    ? t('git.noRemoteMatch', { query })
                    : t('git.noBranchMatch', { query })
                : activeTab === 'local'
                  ? t('git.noLocalBranches')
                  : activeTab === 'remote'
                    ? t('git.noRemoteBranches')
                    : t('git.noBranches')}
            </div>
          )}

          {!loading && activeTab === 'tags' && filteredTags.length === 0 && (
            <div
              style={{
                padding: '36px 0',
                textAlign: 'center',
                color: 'var(--muted, #888)',
                fontSize: 12,
              }}
            >
              {query ? t('git.noTagMatch', { query }) : t('git.noTags')}
            </div>
          )}

          {/* 分支单项渲染器 */}
          {!loading &&
            activeTab !== 'tags' &&
            (() => {
              const renderBranchItem = (b: GitBranchInfo, index: number) => {
                const isCurrent = b.current || b.name === currentBranch;
                const isSelected = index === selectedIndex;

                return (
                  <div
                    key={b.name}
                    data-index={index}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => void handleCheckout(b.name)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      padding: '8px 12px',
                      borderRadius: 7,
                      cursor: 'pointer',
                      background: isSelected ? '#242424' : 'transparent',
                      border: isSelected
                        ? '1px solid rgba(255, 255, 255, 0.18)'
                        : '1px solid transparent',
                      color: isCurrent
                        ? '#ffffff'
                        : isSelected
                          ? 'var(--text-bright, #fff)'
                          : 'var(--fg, #ddd)',
                      fontSize: 12,
                      transition: 'all 0.12s ease',
                      userSelect: 'none',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        width: '100%',
                      }}
                    >
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 9, overflow: 'hidden' }}
                      >
                        {isCurrent ? (
                          <span
                            className="branch-pulse-dot"
                            title={t('git.currentBranchTip')}
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: '50%',
                              backgroundColor: '#ffffff',
                              boxShadow: 'none',
                              flexShrink: 0,
                            }}
                          />
                        ) : b.remote ? (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            style={{ color: '#0ea5e9', flexShrink: 0 }}
                          >
                            <circle cx="12" cy="12" r="10" />
                            <line x1="2" y1="12" x2="22" y2="12" />
                            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                          </svg>
                        ) : (
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            style={{ color: '#f59e0b', flexShrink: 0 }}
                          >
                            <path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0z" />
                          </svg>
                        )}
                        {b.remote && b.name.includes('/') ? (
                          <span
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              fontSize: 12.5,
                            }}
                          >
                            <span style={{ opacity: 0.55, color: 'inherit' }}>
                              {b.name.slice(0, b.name.indexOf('/') + 1)}
                            </span>
                            <span
                              style={{
                                fontWeight: isCurrent ? 650 : isSelected ? 550 : 450,
                                color: isCurrent ? '#34d399' : isSelected ? '#fff' : 'inherit',
                              }}
                            >
                              {b.name.slice(b.name.indexOf('/') + 1)}
                            </span>
                          </span>
                        ) : (
                          <span
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              fontWeight: isCurrent ? 650 : isSelected ? 500 : 400,
                              color: isCurrent ? '#34d399' : 'inherit',
                              fontSize: 12.5,
                            }}
                          >
                            {b.name}
                          </span>
                        )}
                        {b.remote ? (
                          <span
                            style={{
                              fontSize: 10,
                              color: '#38bdf8',
                              background: 'rgba(56, 189, 248, 0.12)',
                              padding: '1px 6px',
                              borderRadius: 4,
                              border: '1px solid rgba(56, 189, 248, 0.22)',
                              flexShrink: 0,
                              fontWeight: 500,
                            }}
                          >
                            {t('git.remoteTag')}
                          </span>
                        ) : (
                          <span
                            style={{
                              fontSize: 10,
                              color: 'var(--muted, #94a3b8)',
                              background: 'rgba(255, 255, 255, 0.06)',
                              padding: '1px 5px',
                              borderRadius: 3,
                              flexShrink: 0,
                            }}
                          >
                            {t('git.localTag')}
                          </span>
                        )}
                      </div>

                      {isCurrent ? (
                        <span
                          style={{
                            fontSize: 10.5,
                            fontWeight: 700,
                            background: 'rgba(255, 255, 255, 0.08)',
                            color: '#ffffff',
                            padding: '2px 8px',
                            borderRadius: 999,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            flexShrink: 0,
                            border: '1px solid rgba(255, 255, 255, 0.15)',
                            letterSpacing: '0.04em',
                          }}
                        >
                          CURRENT
                        </span>
                      ) : isSelected ? (
                        <span
                          style={{
                            fontSize: 10.5,
                            color: b.remote ? '#38bdf8' : 'var(--muted, #888)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            flexShrink: 0,
                          }}
                        >
                          <span style={{ fontSize: 10, opacity: 0.85 }}>
                            {b.remote ? t('git.checkoutAction') : t('git.switchAction')}
                          </span>
                          <kbd className="cmd-mini-kbd" style={{ fontSize: 9 }}>↵</kbd>
                        </span>
                      ) : null}
                    </div>

                    {/* 最新提交历史记录 */}
                    {b.lastCommit && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontSize: 11,
                          color: isSelected ? 'rgba(255, 255, 255, 0.72)' : 'var(--muted, #888)',
                          paddingLeft: 23,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                            background: isSelected ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255, 255, 255, 0.07)',
                            color: isSelected ? '#7dd3fc' : 'var(--muted, #aaa)',
                            padding: '1px 5px',
                            borderRadius: 3,
                            fontSize: 10.5,
                            flexShrink: 0,
                          }}
                        >
                          {b.lastCommit.hash}
                        </span>
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            flex: 1,
                          }}
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
              };

              const renderSectionHeader = (
                type: 'local' | 'remote',
                count: number,
                isFirst = false,
              ) => {
                const isLocal = type === 'local';
                return (
                  <div
                    key={`header-${type}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 8px 3px 8px',
                      marginTop: isFirst ? 0 : 8,
                      marginBottom: 2,
                      borderTop: isFirst ? 'none' : '1px solid rgba(255, 255, 255, 0.08)',
                      userSelect: 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {isLocal ? (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          style={{ color: '#f59e0b', opacity: 0.9 }}
                        >
                          <path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0z" />
                        </svg>
                      ) : (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          style={{ color: '#0ea5e9', opacity: 0.9 }}
                        >
                          <circle cx="12" cy="12" r="10" />
                          <line x1="2" y1="12" x2="22" y2="12" />
                          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                        </svg>
                      )}
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          letterSpacing: '0.04em',
                          color: 'var(--muted, #94a3b8)',
                        }}
                      >
                        {isLocal ? t('git.sectionLocalBranches') : t('git.sectionRemoteBranches')}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          padding: '0 5px',
                          borderRadius: 999,
                          background: isLocal
                            ? 'rgba(255, 255, 255, 0.08)'
                            : 'rgba(14, 165, 233, 0.16)',
                          color: isLocal ? 'var(--muted, #aaa)' : '#38bdf8',
                          lineHeight: '16px',
                        }}
                      >
                        {count}
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 10,
                        color: 'var(--muted, #71717a)',
                        letterSpacing: '0.02em',
                      }}
                    >
                      {isLocal ? 'Local' : 'Remote'}
                    </span>
                  </div>
                );
              };

              if (activeTab === 'all') {
                return (
                  <>
                    {filteredLocal.length > 0 && (
                      <>
                        {renderSectionHeader('local', filteredLocal.length, true)}
                        {filteredLocal.map((b, i) => renderBranchItem(b, i))}
                      </>
                    )}
                    {filteredRemote.length > 0 && (
                      <>
                        {renderSectionHeader(
                          'remote',
                          filteredRemote.length,
                          filteredLocal.length === 0,
                        )}
                        {filteredRemote.map((b, i) =>
                          renderBranchItem(b, filteredLocal.length + i),
                        )}
                      </>
                    )}
                  </>
                );
              }

              if (activeTab === 'local' && filteredLocal.length > 0) {
                return (
                  <>
                    {renderSectionHeader('local', filteredLocal.length, true)}
                    {filteredLocal.map((b, i) => renderBranchItem(b, i))}
                  </>
                );
              }

              if (activeTab === 'remote' && filteredRemote.length > 0) {
                return (
                  <>
                    {renderSectionHeader('remote', filteredRemote.length, true)}
                    {filteredRemote.map((b, i) => renderBranchItem(b, i))}
                  </>
                );
              }

              return null;
            })()}

          {!loading &&
            activeTab === 'tags' &&
            filteredTags.map((tag, index) => {
              const isCurrent = tag === currentBranch;
              const isSelected = index === selectedIndex;

              return (
                <div
                  key={tag}
                  data-index={index}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => void handleCheckout(tag)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderRadius: 7,
                    cursor: 'pointer',
                    background: isSelected
                      ? '#242424'
                      : 'transparent',
                    border: isSelected
                      ? '1px solid rgba(255, 255, 255, 0.18)'
                      : '1px solid transparent',
                    color: isCurrent
                      ? '#ffffff'
                      : isSelected
                        ? 'var(--text-bright, #fff)'
                        : 'var(--fg, #ddd)',
                    fontSize: 12,
                    transition: 'all 0.12s ease',
                    userSelect: 'none',
                  }}
                >
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: 9, overflow: 'hidden' }}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      style={{ color: '#ab47bc', flexShrink: 0 }}
                    >
                      <path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25v5.025zM6 4.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
                    </svg>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: isCurrent ? 650 : isSelected ? 500 : 400,
                      }}
                    >
                      {tag}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        color: '#c084fc',
                        background: 'rgba(192, 132, 252, 0.12)',
                        padding: '1px 5px',
                        borderRadius: 3,
                        border: '1px solid rgba(192, 132, 252, 0.2)',
                        flexShrink: 0,
                      }}
                    >
                      Tag
                    </span>
                  </div>

                  {isCurrent ? (
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        background: 'rgba(168, 85, 247, 0.18)',
                        color: '#c084fc',
                        padding: '2px 8px',
                        borderRadius: 999,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        flexShrink: 0,
                        border: '1px solid rgba(168, 85, 247, 0.3)',
                      }}
                    >
                      CURRENT
                    </span>
                  ) : isSelected ? (
                    <span
                      style={{
                        fontSize: 10.5,
                        color: 'var(--muted, #888)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 3,
                        flexShrink: 0,
                      }}
                    >
                      <kbd className="cmd-mini-kbd" style={{ fontSize: 9 }}>↵</kbd>
                    </span>
                  ) : null}
                </div>
              );
            })}
        </div>

        {/* Footer Shortcut Hints */}
        <div
          style={{
            padding: '7px 14px',
            borderTop: '1px solid var(--border, rgba(255,255,255,0.06))',
            background: 'rgba(0, 0, 0, 0.18)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 11,
            color: 'var(--muted, #888)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <kbd className="cmd-mini-kbd">↑↓</kbd> {t('git.keyMove')}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <kbd className="cmd-mini-kbd">Enter</kbd> {t('git.keySwitch')}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <kbd className="cmd-mini-kbd">Tab</kbd> {t('git.keyTab')}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <kbd className="cmd-mini-kbd">Esc</kbd> {t('git.keyExit')}
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--muted, #888)',
              fontSize: 11,
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            {t('common.close')}
          </button>
        </div>

        {/* 未暂存或未提交修改警示弹窗 */}
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
            }}
          >
            <div
              style={{
                width: '100%',
                maxWidth: 420,
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
                    <Fragment key={i}>{seg.text}</Fragment>
                  ),
                )}
                {unsavedWarning.stagedCount > 0 && t('git.unsavedWarningStaged', { n: unsavedWarning.stagedCount })}
                {unsavedWarning.unstagedCount > 0 && t('git.unsavedWarningUnstaged', { n: unsavedWarning.unstagedCount })}
                {translateSegments('git.unsavedWarningTail', locale, { target: unsavedWarning.target }).map((seg, i) =>
                  seg.emphasis ? (
                    <b key={i}>{seg.text}</b>
                  ) : (
                    <Fragment key={i}>{seg.text}</Fragment>
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
                    void executeCheckout(target);
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

        {/* 右下角全向拖拽手柄 */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}
