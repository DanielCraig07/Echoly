import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { GitBranchInfo } from '@deepseek-ide/shared';

interface Props {
  open: boolean;
  currentBranch?: string | null;
  onClose: () => void;
  onSwitched: () => void;
}

export function BranchSwitchModal({ open, currentBranch, onClose, onSwitched }: Props) {
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'branches' | 'tags'>('branches');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setQuery('');
    setSelectedIndex(0);
    void window.ide.gitBranches().then((res) => {
      setLoading(false);
      if (res.ok) {
        setBranches(res.branches || []);
        setTags(res.tags || []);
      } else {
        setError(res.detail || '无法获取 Git 分支/标签');
      }
    });
  }, [open]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open, activeTab]);

  const q = query.trim().toLowerCase();
  const filteredBranches = q
    ? branches.filter((b) => b.name.toLowerCase().includes(q))
    : branches;
  const filteredTags = q
    ? tags.filter((t) => t.toLowerCase().includes(q))
    : tags;

  const currentListLength = activeTab === 'branches' ? filteredBranches.length : filteredTags.length;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, activeTab]);

  // Keep selected item visible
  useEffect(() => {
    if (!listRef.current) return;
    const activeItem = listRef.current.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!open) return null;

  async function handleCheckout(target: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await window.ide.gitCheckout(target);
      if (res.ok) {
        onSwitched();
        onClose();
      } else {
        setError(res.detail || '切换失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
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
      if (activeTab === 'branches' && filteredBranches[selectedIndex]) {
        void handleCheckout(filteredBranches[selectedIndex].name);
      } else if (activeTab === 'tags' && filteredTags[selectedIndex]) {
        void handleCheckout(filteredTags[selectedIndex]);
      }
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      setActiveTab((prev) => (prev === 'branches' ? 'tags' : 'branches'));
      return;
    }
  }

  return (
    <div
      className="settings-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.55)',
        backdropFilter: 'blur(3px)',
        zIndex: 9999,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: '8vh',
      }}
    >
      <div
        className="branch-switch-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 540,
          maxWidth: '92vw',
          background: 'var(--bg-modal, #1f2026)',
          border: '1px solid var(--border, #333)',
          borderRadius: 8,
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.05)',
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
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style={{ color: 'var(--accent, #4c8dff)' }}>
              <path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0z" />
            </svg>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text, #fff)' }}>切换 Git 分支 / Tag 标签</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Tabs */}
            <div
              style={{
                display: 'flex',
                background: 'rgba(0, 0, 0, 0.25)',
                padding: 2,
                borderRadius: 6,
                border: '1px solid var(--border, rgba(255,255,255,0.06))',
              }}
            >
              <button
                type="button"
                onClick={() => setActiveTab('branches')}
                style={{
                  border: 'none',
                  background: activeTab === 'branches' ? 'var(--accent, #4c8dff)' : 'transparent',
                  color: activeTab === 'branches' ? '#fff' : 'var(--muted, #888)',
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '3px 9px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                分支 ({branches.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('tags')}
                style={{
                  border: 'none',
                  background: activeTab === 'tags' ? 'var(--accent, #4c8dff)' : 'transparent',
                  color: activeTab === 'tags' ? '#fff' : 'var(--muted, #888)',
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '3px 9px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                Tag 标签 ({tags.length})
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--muted, #888)',
                cursor: 'pointer',
                padding: '4px 6px',
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                lineHeight: 1,
              }}
              title="关闭 (Esc)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            background: 'var(--bg-input, #16171b)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--muted, #888)', flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder={activeTab === 'branches' ? "搜索或切换分支… (支持 ↑↓ 键选择，Enter 确认)" : "搜索或切换 Tag 标签…"}
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
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--muted, #888)',
                cursor: 'pointer',
                fontSize: 12,
                padding: '0 4px',
              }}
            >
              ✕
            </button>
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            maxHeight: 340,
            overflowY: 'auto',
            padding: '4px',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          {loading && (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--muted, #888)', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                <line x1="12" y1="2" x2="12" y2="6" />
                <line x1="12" y1="18" x2="12" y2="22" />
                <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
                <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
                <line x1="2" y1="12" x2="6" y2="12" />
                <line x1="18" y1="12" x2="22" y2="12" />
                <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
                <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
              </svg>
              <span>正在获取分支及标签列表…</span>
            </div>
          )}

          {!loading && activeTab === 'branches' && filteredBranches.length === 0 && (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--muted, #888)', fontSize: 12 }}>
              未找到与 "{query}" 匹配的分支
            </div>
          )}

          {!loading && activeTab === 'tags' && filteredTags.length === 0 && (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--muted, #888)', fontSize: 12 }}>
              未找到与 "{query}" 匹配的 Tag 标签
            </div>
          )}

          {!loading && activeTab === 'branches' && filteredBranches.map((b, index) => {
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
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '7px 10px',
                  borderRadius: 5,
                  cursor: 'pointer',
                  background: isSelected
                    ? 'var(--accent-soft, rgba(76, 141, 255, 0.16))'
                    : 'transparent',
                  color: isCurrent
                    ? 'var(--accent, #4c8dff)'
                    : isSelected
                    ? 'var(--text, #fff)'
                    : 'var(--fg, #ddd)',
                  fontSize: 12,
                  transition: 'background 0.1s ease',
                  userSelect: 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                  {b.remote ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" style={{ color: '#00bcd4', flexShrink: 0 }}>
                      <circle cx="12" cy="12" r="10" />
                      <line x1="2" y1="12" x2="22" y2="12" />
                      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ color: '#f57c00', flexShrink: 0 }}>
                      <path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0z" />
                    </svg>
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isCurrent ? 600 : 400 }}>
                    {b.name}
                  </span>
                  {b.remote && (
                    <span style={{ fontSize: 10, color: 'var(--muted, #888)', background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 3 }}>
                      远程
                    </span>
                  )}
                </div>

                {isCurrent && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      background: 'rgba(76, 141, 255, 0.18)',
                      color: 'var(--accent, #4c8dff)',
                      padding: '2px 8px',
                      borderRadius: 10,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      flexShrink: 0,
                    }}
                  >
                    ✓ 当前分支
                  </span>
                )}
              </div>
            );
          })}

          {!loading && activeTab === 'tags' && filteredTags.map((t, index) => {
            const isCurrent = t === currentBranch;
            const isSelected = index === selectedIndex;

            return (
              <div
                key={t}
                data-index={index}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => void handleCheckout(t)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '7px 10px',
                  borderRadius: 5,
                  cursor: 'pointer',
                  background: isSelected
                    ? 'var(--accent-soft, rgba(76, 141, 255, 0.16))'
                    : 'transparent',
                  color: isCurrent
                    ? 'var(--accent, #4c8dff)'
                    : isSelected
                    ? 'var(--text, #fff)'
                    : 'var(--fg, #ddd)',
                  fontSize: 12,
                  transition: 'background 0.1s ease',
                  userSelect: 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ color: '#ab47bc', flexShrink: 0 }}>
                    <path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25v5.025zM6 4.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
                  </svg>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isCurrent ? 600 : 400 }}>
                    {t}
                  </span>
                </div>

                {isCurrent && (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      background: 'rgba(76, 141, 255, 0.18)',
                      color: 'var(--accent, #4c8dff)',
                      padding: '2px 8px',
                      borderRadius: 10,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      flexShrink: 0,
                    }}
                  >
                    ✓ 当前标签
                  </span>
                )}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span><kbd style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3, fontFamily: 'monospace' }}>↑↓</kbd> 移动</span>
            <span><kbd style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3, fontFamily: 'monospace' }}>Enter</kbd> 切换</span>
            <span><kbd style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3, fontFamily: 'monospace' }}>Tab</kbd> 换页</span>
            <span><kbd style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3, fontFamily: 'monospace' }}>Esc</kbd> 退出</span>
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
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

