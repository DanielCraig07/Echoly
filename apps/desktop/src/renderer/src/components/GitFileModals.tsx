import React, { useEffect, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { GitBranchInfo, GitCommitEntry, GitDiffResult, PendingDiff } from '@deepseek-ide/shared';
import { useModalResize, ModalResizeHandle, createSafeOverlayHandlers } from '../hooks/useModalResize';

// ── 1. 与历史版本对比弹窗 (CompareWithRevisionModal) ──
interface CompareWithRevisionModalProps {
  open: boolean;
  filePath: string | null;
  onClose: () => void;
  onPreviewDiff: (diff: PendingDiff) => void;
}

export function CompareWithRevisionModal({
  open,
  filePath,
  onClose,
  onPreviewDiff,
}: CompareWithRevisionModalProps) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_git_compare_revision_modal_size',
    defaultWidth: 840,
    defaultHeight: 560,
    minWidth: 620,
    minHeight: 400,
  });

  const [commits, setCommits] = useState<GitCommitEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !filePath) {
      setCommits([]);
      setError(null);
      setDiffResult(null);
      return;
    }

    setLoading(true);
    setError(null);
    setQuery('');
    setSelectedIndex(0);
    setDiffResult(null);

    void window.ide.gitFileHistory(filePath, 100).then((res) => {
      setLoading(false);
      if (res.ok) {
        setCommits(res.commits || []);
        if (!res.commits || res.commits.length === 0) {
          setError('该文件暂无已提交的 Git 历史版本');
        }
      } else {
        setError(res.detail || '获取提交历史失败');
        setCommits([]);
      }
    });

    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [open, filePath]);

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

  const q = query.trim().toLowerCase();
  const filteredCommits = useMemo(() => {
    if (!q) return commits;
    return commits.filter(
      (c) =>
        c.message.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.hash.toLowerCase().includes(q) ||
        c.shortHash.toLowerCase().includes(q),
    );
  }, [commits, q]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const selectedCommit = filteredCommits[selectedIndex] ?? null;

  // 确保选中的提交项自动滚动进入可视区域
  useEffect(() => {
    if (!listRef.current) return;
    const activeItem = listRef.current.querySelector<HTMLElement>(
      `[data-index="${selectedIndex}"]`,
    );
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // 当选中的提交改变时，防抖加载与当前文件的差异对比
  useEffect(() => {
    if (!open || !filePath || !selectedCommit) {
      setDiffResult(null);
      return;
    }

    let active = true;
    setDiffLoading(true);

    const timer = setTimeout(() => {
      void window.ide.gitDiffWithRef(selectedCommit.hash, filePath).then((res) => {
        if (!active) return;
        setDiffLoading(false);
        if (res.ok) {
          setDiffResult(res);
        } else {
          setDiffResult(null);
        }
      });
    }, 70);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, filePath, selectedCommit?.hash]);

  const handleOpenInEditor = async (commit: GitCommitEntry) => {
    if (!filePath) return;
    let modified = diffResult?.modified ?? '';
    if (!modified) {
      try {
        modified = await window.ide.readFile(filePath);
      } catch {}
    }
    onPreviewDiff({
      id: `git:rev:${commit.hash}:${filePath}`,
      path: filePath,
      original: diffResult?.original ?? '',
      modified,
      description: `提交 ${commit.shortHash} (${commit.author}) ↔ 本地当前版本`,
      originalTitle: `历史提交: ${commit.shortHash}`,
      modifiedTitle: '当前工作区 (本地版本)',
    });
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((idx) => (idx < filteredCommits.length - 1 ? idx + 1 : idx));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((idx) => (idx > 0 ? idx - 1 : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedCommit) {
        handleOpenInEditor(selectedCommit);
      }
    }
  };

  if (!open || typeof document === 'undefined' || !filePath) return null;

  const fileName = filePath.split(/[/\\]/).pop() || filePath;
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
          padding: 0,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            height: 38,
            boxSizing: 'border-box',
            padding: '0 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border)',
            background: 'rgba(255, 255, 255, 0.02)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {/* Git Diff Dual Sheets Icon */}
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, color: 'var(--accent, #007acc)' }}>
              <rect x="2" y="2" width="5.5" height="12" rx="1.5" stroke="#f87171" strokeWidth="1.5" />
              <rect x="8.5" y="2" width="5.5" height="12" rx="1.5" stroke="var(--accent, #007acc)" strokeWidth="1.5" />
            </svg>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              与历史版本对比 (Compare with Revision)
            </span>
            <span
              style={{
                fontSize: 12,
                color: 'var(--muted)',
                background: 'rgba(255, 255, 255, 0.06)',
                padding: '2px 8px',
                borderRadius: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 260,
              }}
              title={filePath}
            >
              {fileName}
            </span>
          </div>
          <button type="button" className="panel-action-btn" title="关闭 (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Search bar */}
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', background: 'rgba(0, 0, 0, 0.15)' }}>
          <input
            ref={searchInputRef}
            type="text"
            className="git-modal-input"
            value={query}
            placeholder="搜索提交信息、作者或 Commit Hash..."
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        {/* Content body: Split list + diff summary */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
          {/* Commit list */}
          <div
            ref={listRef}
            style={{
              width: 320,
              borderRight: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              overflowY: 'auto',
              background: 'rgba(0, 0, 0, 0.1)',
              padding: '6px 4px',
            }}
          >
            {loading && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                正在加载提交历史...
              </div>
            )}
            {!loading && error && (
              <div style={{ padding: 24, textAlign: 'center', color: '#f87171', fontSize: 12 }}>
                {error}
              </div>
            )}
            {!loading && !error && filteredCommits.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                无匹配的历史提交
              </div>
            )}
            {!loading &&
              filteredCommits.map((c, idx) => {
                const isSelected = idx === selectedIndex;
                return (
                  <div
                    key={c.hash}
                    data-index={idx}
                    className={`git-modal-list-item ${isSelected ? 'selected' : ''}`}
                    onClick={() => setSelectedIndex(idx)}
                    onDoubleClick={() => void handleOpenInEditor(c)}
                    style={{
                      padding: '8px 12px',
                      margin: '2px 4px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <span
                        className="git-item-badge-hash"
                        style={{
                          fontSize: 11,
                          fontFamily: 'monospace',
                          color: 'var(--accent-light, #3794ff)',
                          background: 'color-mix(in srgb, var(--accent, #007acc) 16%, transparent)',
                          border: '1px solid color-mix(in srgb, var(--accent, #007acc) 30%, transparent)',
                          padding: '1px 5px',
                          borderRadius: 4,
                        }}
                      >
                        {c.shortHash}
                      </span>
                      <span className="git-item-muted" style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {c.relativeDate || c.date}
                      </span>
                    </div>
                    <div
                      className="git-item-title"
                      style={{
                        fontSize: 12.5,
                        color: 'var(--text)',
                        margin: '4px 0 2px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={c.message}
                    >
                      {c.message}
                    </div>
                    <div className="git-item-muted" style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {c.author}
                    </div>
                  </div>
                );
              })}
          </div>

          {/* Diff Preview / Comparison Details */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-editor, #1e1e1e)' }}>
            {selectedCommit ? (
              <>
                <div
                  style={{
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--border)',
                    background: 'rgba(255, 255, 255, 0.02)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                      对比: 提交 <span style={{ color: 'var(--accent-light, #3794ff)', fontFamily: 'monospace' }}>{selectedCommit.shortHash}</span> ↔ 本地工作区版本
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      {selectedCommit.author} • {selectedCommit.relativeDate || selectedCommit.date} • {selectedCommit.message}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="git-modal-btn primary"
                    onClick={() => handleOpenInEditor(selectedCommit)}
                    disabled={diffLoading || !diffResult}
                    style={{ flexShrink: 0 }}
                  >
                    在主编辑器中对比 (Enter)
                  </button>
                </div>

                <div style={{ flex: 1, minHeight: 0, padding: 14, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
                  {diffLoading ? (
                    <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>正在生成差异对比...</div>
                  ) : diffResult ? (
                    diffResult.original === diffResult.modified ? (
                      <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>
                        ✓ 当前本地文件与选中的历史版本内容完全一致，无差异。
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                          左侧: 提交 {selectedCommit.shortHash} 历史代码 ({diffResult.original.split('\n').length} 行)
                          <br />
                          右侧: 当前工作区本地代码 ({diffResult.modified.split('\n').length} 行)
                        </div>
                        <div
                          style={{
                            padding: 12,
                            borderRadius: 6,
                            background: 'rgba(0, 0, 0, 0.25)',
                            border: '1px solid var(--border)',
                            color: 'var(--text)',
                            maxHeight: 280,
                            overflow: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                          }}
                        >
                          {diffResult.original.slice(0, 1000)}
                          {diffResult.original.length > 1000 ? '\n... (更多内容可在主编辑器查看)' : ''}
                        </div>
                      </div>
                    )
                  ) : (
                    <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>
                      未能加载差异对比
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ padding: 48, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                请在左侧选择一个历史提交以查看对比
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            height: 38,
            boxSizing: 'border-box',
            padding: '0 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '1px solid var(--border)',
            background: 'rgba(255, 255, 255, 0.02)',
            fontSize: 11,
            color: 'var(--muted)',
          }}
        >
          <span>按 ↑ ↓ 切换选中提交，双击或回车即可在主编辑器中全屏对比</span>
          <button type="button" className="git-modal-btn secondary" onClick={onClose}>
            关闭
          </button>
        </div>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}

// ── 2. 与分支或标签对比弹窗 (CompareWithBranchOrTagModal) ──
interface CompareWithBranchOrTagModalProps {
  open: boolean;
  filePath: string | null;
  onClose: () => void;
  onPreviewDiff: (diff: PendingDiff) => void;
}

export function CompareWithBranchOrTagModal({
  open,
  filePath,
  onClose,
  onPreviewDiff,
}: CompareWithBranchOrTagModalProps) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_git_compare_branch_tag_modal_size',
    defaultWidth: 720,
    defaultHeight: 520,
    minWidth: 540,
    minHeight: 380,
  });

  const [tab, setTab] = useState<'branches' | 'tags'>('branches');
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !filePath) {
      setBranches([]);
      setTags([]);
      setSelectedRef(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    setQuery('');

    Promise.all([window.ide.gitBranches(), window.ide.gitTags()])
      .then(([bRes, tRes]) => {
        setLoading(false);
        if (bRes.ok) {
          setBranches(bRes.branches || []);
          const cur = bRes.branches?.find((b) => b.current);
          if (cur) setSelectedRef(cur.name);
          else if (bRes.branches?.length) setSelectedRef(bRes.branches[0].name);
        }
        if (tRes.ok) {
          setTags(tRes.tags || []);
        }
      })
      .catch((err) => {
        setLoading(false);
        setError(err instanceof Error ? err.message : String(err));
      });

    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [open, filePath]);

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

  const q = query.trim().toLowerCase();
  const filteredBranches = useMemo(() => {
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, q]);

  const filteredTags = useMemo(() => {
    if (!q) return tags;
    return tags.filter((t) => t.toLowerCase().includes(q));
  }, [tags, q]);

  // 搜索或选项卡切换时，如当前选中项不在列表中，自动聚焦第一项
  useEffect(() => {
    const list = tab === 'branches' ? filteredBranches.map((b) => b.name) : filteredTags;
    if (list.length > 0 && (!selectedRef || !list.includes(selectedRef))) {
      setSelectedRef(list[0]);
    }
  }, [query, tab, filteredBranches, filteredTags]);

  // 自动将选中的分支或标签项滚动到视口中
  useEffect(() => {
    if (!listRef.current || !selectedRef) return;
    const activeItem = listRef.current.querySelector<HTMLElement>(
      `[data-ref="${CSS.escape(selectedRef)}"]`,
    );
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedRef]);

  const handleCompare = async (targetRef: string) => {
    if (!filePath || !targetRef) return;
    setComparing(true);
    setError(null);
    try {
      const res = await window.ide.gitDiffWithRef(targetRef, filePath);
      if (res.ok) {
        let modified = res.modified;
        if (!modified) {
          try {
            modified = await window.ide.readFile(filePath);
          } catch {}
        }
        const isRemote = targetRef.startsWith('origin/') || targetRef.includes('/');
        onPreviewDiff({
          id: `git:ref:${targetRef}:${filePath}`,
          path: filePath,
          original: res.original,
          modified,
          description: `「${targetRef}」↔ 本地当前版本 (${filePath})`,
          originalTitle: isRemote ? `远程: ${targetRef}` : `分支: ${targetRef}`,
          modifiedTitle: '当前工作区 (本地版本)',
        });
        onClose();
      } else {
        setError(res.detail || `在「${targetRef}」中无法获取该文件差异`);
      }
    } catch (err: any) {
      setError(err?.message || '对比失败');
    } finally {
      setComparing(false);
    }
  };

  if (!open || typeof document === 'undefined' || !filePath) return null;

  const fileName = filePath.split(/[/\\]/).pop() || filePath;
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
          padding: 0,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            height: 38,
            boxSizing: 'border-box',
            padding: '0 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border)',
            background: 'rgba(255, 255, 255, 0.02)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {/* Git Branch Icon */}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--accent, #007acc)' }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              与分支或标签对比 (Compare with Branch or Tag)
            </span>
            <span
              style={{
                fontSize: 12,
                color: 'var(--muted)',
                background: 'rgba(255, 255, 255, 0.06)',
                padding: '2px 8px',
                borderRadius: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 240,
              }}
              title={filePath}
            >
              {fileName}
            </span>
          </div>
          <button type="button" className="panel-action-btn" title="关闭 (Esc)" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Tab switch & Search bar */}
        <div
          style={{
            padding: '8px 14px',
            borderBottom: '1px solid var(--border)',
            background: 'rgba(0, 0, 0, 0.15)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', gap: 4, background: 'rgba(255, 255, 255, 0.05)', padding: 2, borderRadius: 6 }}>
            <button
              type="button"
              className={`git-tab-btn ${tab === 'branches' ? 'active' : ''}`}
              onClick={() => {
                setTab('branches');
                if (filteredBranches.length > 0 && !filteredBranches.some((b) => b.name === selectedRef)) {
                  setSelectedRef(filteredBranches[0].name);
                }
              }}
            >
              分支 ({branches.length})
            </button>
            <button
              type="button"
              className={`git-tab-btn ${tab === 'tags' ? 'active' : ''}`}
              onClick={() => {
                setTab('tags');
                if (filteredTags.length > 0 && !filteredTags.includes(selectedRef || '')) {
                  setSelectedRef(filteredTags[0]);
                }
              }}
            >
              标签 ({tags.length})
            </button>
          </div>

          <div style={{ flex: 1 }}>
            <input
              ref={searchInputRef}
              type="text"
              className="git-modal-input"
              value={query}
              placeholder={tab === 'branches' ? '搜索分支名称 (支持 ↑↓ 选择)...' : '搜索标签名称 (支持 ↑↓ 选择)...'}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                const list = tab === 'branches' ? filteredBranches.map((b) => b.name) : filteredTags;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  if (list.length > 0) {
                    const idx = list.indexOf(selectedRef || '');
                    const next = idx < list.length - 1 ? list[idx + 1] : list[0];
                    setSelectedRef(next);
                  }
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  if (list.length > 0) {
                    const idx = list.indexOf(selectedRef || '');
                    const prev = idx > 0 ? list[idx - 1] : list[list.length - 1];
                    setSelectedRef(prev);
                  }
                } else if (e.key === 'Enter' && selectedRef) {
                  e.preventDefault();
                  void handleCompare(selectedRef);
                }
              }}
            />
          </div>
        </div>

        {/* List of branches or tags */}
        <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 }}>
          {loading && (
            <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
              正在加载分支与标签...
            </div>
          )}
          {!loading && error && (
            <div style={{ padding: 16, margin: 8, background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 6, color: '#f87171', fontSize: 12 }}>
              {error}
            </div>
          )}

          {tab === 'branches' && !loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {filteredBranches.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                  无匹配的分支
                </div>
              ) : (
                filteredBranches.map((b) => {
                  const isSelected = selectedRef === b.name;
                  return (
                    <div
                      key={b.name}
                      data-ref={b.name}
                      className={`git-modal-list-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedRef(b.name)}
                      onDoubleClick={() => void handleCompare(b.name)}
                      style={{
                        padding: '8px 12px',
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <svg
                          className="git-item-icon"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          style={{ color: b.remote ? '#a78bfa' : 'var(--accent, #007acc)' }}
                        >
                          <line x1="6" y1="3" x2="6" y2="15" />
                          <circle cx="18" cy="6" r="3" />
                          <circle cx="6" cy="18" r="3" />
                          <path d="M18 9a9 9 0 0 1-9 9" />
                        </svg>
                        <span
                          className="git-item-title"
                          style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: b.current ? 600 : 400 }}
                        >
                          {b.name}
                        </span>
                        {b.current && (
                          <span
                            className="git-item-tag"
                            style={{
                              fontSize: 10,
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: 'rgba(34, 197, 94, 0.18)',
                              color: '#4ade80',
                            }}
                          >
                            当前 HEAD
                          </span>
                        )}
                        {b.remote && (
                          <span
                            className="git-item-tag"
                            style={{
                              fontSize: 10,
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: 'rgba(167, 139, 250, 0.18)',
                              color: '#c084fc',
                            }}
                          >
                            远程
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          {tab === 'tags' && !loading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {filteredTags.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                  无匹配的标签
                </div>
              ) : (
                filteredTags.map((t) => {
                  const isSelected = selectedRef === t;
                  return (
                    <div
                      key={t}
                      data-ref={t}
                      className={`git-modal-list-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedRef(t)}
                      onDoubleClick={() => void handleCompare(t)}
                      style={{
                        padding: '8px 12px',
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <svg
                          className="git-item-icon"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          style={{ color: '#fbbf24' }}
                        >
                          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                          <line x1="7" y1="7" x2="7.01" y2="7" />
                        </svg>
                        <span className="git-item-title" style={{ fontSize: 12.5, color: 'var(--text)' }}>
                          {t}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            height: 44,
            boxSizing: 'border-box',
            padding: '0 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '1px solid var(--border)',
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {selectedRef ? `已选中: ${selectedRef}` : '请选择分支或标签'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="git-modal-btn secondary" onClick={onClose} disabled={comparing}>
              取消
            </button>
            <button
              type="button"
              className="git-modal-btn primary"
              onClick={() => selectedRef && void handleCompare(selectedRef)}
              disabled={comparing || !selectedRef}
            >
              {comparing ? '正在加载对比...' : '在主编辑器中对比 (Enter)'}
            </button>
          </div>
        </div>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>,
    document.body,
  );
}

// ── 3. 回滚修改确认弹窗 (RollbackFileModal) ──
interface RollbackFileModalProps {
  open: boolean;
  filePath: string | null;
  onClose: () => void;
  onConfirm: (path: string) => Promise<void>;
}

export function RollbackFileModal({
  open,
  filePath,
  onClose,
  onConfirm,
}: RollbackFileModalProps) {
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [open, onClose, submitting]);

  if (!open || typeof document === 'undefined' || !filePath) return null;

  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const safeOverlay = createSafeOverlayHandlers(submitting ? undefined : onClose);

  const handleRollback = async () => {
    setSubmitting(true);
    try {
      await onConfirm(filePath);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="git-modal-overlay" {...safeOverlay}>
      <div
        className="git-modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 480,
          maxWidth: '92vw',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          padding: '20px 24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 8,
              background: 'rgba(239, 68, 68, 0.15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#ef4444',
              flexShrink: 0,
            }}
          >
            {/* Rollback counter-clockwise arrow icon */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
              回滚文件修改 (Rollback Changes)
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              放弃本地工作区改动并恢复至 Git 最新提交 (HEAD)
            </div>
          </div>
        </div>

        <div
          style={{
            padding: '12px 14px',
            borderRadius: 8,
            background: 'rgba(0, 0, 0, 0.25)',
            border: '1px solid var(--border)',
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>目标文件:</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', wordBreak: 'break-all' }}>
            {fileName}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, wordBreak: 'break-all' }}>
            {filePath}
          </div>
        </div>

        <div style={{ fontSize: 12, color: '#f87171', lineHeight: 1.5, marginBottom: 20 }}>
          ⚠️ 警告：此操作将丢弃该文件所有未暂存和未提交的修改，文件内容将不可逆地恢复至版本库状态。
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button type="button" className="git-modal-btn secondary" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="git-modal-btn"
            onClick={handleRollback}
            disabled={submitting}
            style={{
              background: '#ef4444',
              color: '#ffffff',
              fontWeight: 600,
            }}
          >
            {submitting ? '正在回滚...' : '确认回滚 (Rollback)'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
