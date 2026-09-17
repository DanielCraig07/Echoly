import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { GitCommitEntry } from '@deepseek-ide/shared';
import { useModalResize, ModalResizeHandle } from '../hooks/useModalResize';

interface Props {
  filePath: string | null;
  onClose: () => void;
  onPreviewDiff: (diff: {
    id: string;
    path: string;
    original: string;
    modified: string;
    description: string;
  }) => void;
}

export function FileHistoryModal({ filePath, onClose, onPreviewDiff }: Props) {
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_file_history_modal_size',
    defaultWidth: 760,
    defaultHeight: 580,
    minWidth: 540,
    minHeight: 400,
  });
  const [commits, setCommits] = useState<GitCommitEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewingHash, setPreviewingHash] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filePath) {
      setCommits([]);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    setQuery('');
    setSelectedIndex(0);

    void window.ide.gitFileHistory(filePath, 100).then((res) => {
      setLoading(false);
      if (res.ok) {
        setCommits(res.commits || []);
        if (res.commits.length === 0) {
          setError('该文件暂无已提交的 Git 历史记录');
        }
      } else {
        setError(res.detail || '获取文件历史失败');
        setCommits([]);
      }
    });
  }, [filePath]);

  useEffect(() => {
    if (filePath) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [filePath]);

  useEffect(() => {
    if (!filePath) return;
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [filePath, onClose]);

  const q = query.trim().toLowerCase();
  const filteredCommits = q
    ? commits.filter(
        (c) =>
          c.message.toLowerCase().includes(q) ||
          c.author.toLowerCase().includes(q) ||
          c.hash.toLowerCase().includes(q) ||
          c.shortHash.toLowerCase().includes(q),
      )
    : commits;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

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

  const handleSelectCommit = async (commit: GitCommitEntry) => {
    if (!filePath) return;
    setPreviewingHash(commit.hash);
    try {
      const res = await window.ide.gitShowCommitDiff(commit.hash, filePath);
      if (res.ok) {
        onPreviewDiff({
          id: `git:commit:${commit.hash}:${filePath}`,
          path: res.path,
          original: res.original,
          modified: res.modified,
          description: `提交 ${commit.shortHash} - ${filePath}`,
        });
        onClose();
      } else {
        alert(res.detail || '无法加载该提交的代码差异');
      }
    } catch (e: any) {
      alert(e?.message || '获取提交差异发生异常');
    } finally {
      setPreviewingHash(null);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((idx) => (idx + 1 < filteredCommits.length ? idx + 1 : idx));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((idx) => (idx > 0 ? idx - 1 : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filteredCommits[selectedIndex];
      if (target) {
        void handleSelectCommit(target);
      }
    }
  };

  if (!filePath) return null;

  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(3px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '80px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: modalSize.width,
          height: modalSize.height,
          maxWidth: '96vw',
          maxHeight: '94vh',
          position: 'relative',
          background: 'var(--bg-elevated, #252526)',
          border: '1px solid var(--border, #3c3c3c)',
          borderRadius: 10,
          boxShadow: '0 20px 48px rgba(0, 0, 0, 0.6)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--border, #3c3c3c)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 16 }}>📜</span>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--text)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>文件提交历史 (Git File History)</span>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--muted)',
                  fontFamily: 'var(--font-mono)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  marginTop: 2,
                }}
                title={filePath}
              >
                {filePath}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="panel-action-btn"
            onClick={onClose}
            title="关闭 (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Search / Filter Input */}
        <div
          style={{
            padding: '10px 16px',
            borderBottom: '1px solid var(--border, #3c3c3c)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <input
            ref={inputRef}
            type="text"
            placeholder="搜索提交信息、作者或哈希 (支持 ↑↓ 选择，回车查看差异)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              flex: 1,
              background: 'var(--bg-main, #1e1e1e)',
              border: '1px solid var(--border, #3c3c3c)',
              borderRadius: 4,
              padding: '6px 10px',
              fontSize: 12,
              color: 'var(--text)',
              outline: 'none',
            }}
          />
          <span style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
            共 {filteredCommits.length} 次变更
          </span>
        </div>

        {/* Content list */}
        <div
          ref={listRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '6px 0',
            minHeight: '180px',
          }}
        >
          {loading ? (
            <div
              style={{
                padding: '32px 16px',
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 12,
              }}
            >
              正在获取文件历史记录...
            </div>
          ) : filteredCommits.length === 0 ? (
            <div
              style={{
                padding: '36px 20px',
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 12,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 24 }}>🍃</span>
              <div>{error || (query ? '未找到匹配的提交记录' : '暂无提交历史')}</div>
              <div style={{ fontSize: 11, opacity: 0.7 }}>
                若此文件为新添加尚未 commit，或者刚执行 git init，则不会产生文件历史。
              </div>
            </div>
          ) : (
            filteredCommits.map((c, idx) => {
              const isSelected = idx === selectedIndex;
              const isPreviewing = previewingHash === c.hash;
              const authorInitial = (c.author || 'U').slice(0, 1).toUpperCase();

              return (
                <div
                  key={c.hash}
                  data-index={idx}
                  onClick={() => void handleSelectCommit(c)}
                  style={{
                    position: 'relative',
                    padding: '10px 16px 10px 36px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    cursor: 'pointer',
                    background: isSelected ? 'var(--bg-hover, rgba(255,255,255,0.06))' : 'transparent',
                    borderLeft: isSelected ? '3px solid var(--accent, #38bdf8)' : '3px solid transparent',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  {/* 时间轴连线与节点圆圈 */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 18,
                      top: 0,
                      bottom: 0,
                      width: 2,
                      background: 'rgba(255, 255, 255, 0.08)',
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      left: 15,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: isSelected ? 'var(--accent, #38bdf8)' : 'var(--border)',
                      boxShadow: isSelected ? '0 0 6px var(--accent)' : 'none',
                      transition: 'all 0.15s ease',
                      zIndex: 2,
                    }}
                  />

                  {/* Commit Hash 胶囊 */}
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--accent, #38bdf8)',
                      background: 'rgba(56, 189, 248, 0.12)',
                      border: '1px solid rgba(56, 189, 248, 0.25)',
                      padding: '2px 7px',
                      borderRadius: 4,
                      fontWeight: 650,
                      letterSpacing: '0.03em',
                      flexShrink: 0,
                    }}
                  >
                    {c.shortHash}
                  </span>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        color: 'var(--text-bright)',
                        fontWeight: 600,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={c.message}
                    >
                      {c.message}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--muted)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        marginTop: 3,
                      }}
                    >
                      {/* 作者单字圆形头像徽章 */}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: '50%',
                            background: 'rgba(56, 189, 248, 0.2)',
                            color: '#38bdf8',
                            fontSize: 9.5,
                            fontWeight: 700,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {authorInitial}
                        </span>
                        <span>{c.author}</span>
                      </span>
                      {c.relativeDate && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span>🕒</span>
                          <span>{c.relativeDate}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isPreviewing}
                    style={{
                      padding: '5px 12px',
                      fontSize: 11.5,
                      fontWeight: 600,
                      background: isSelected ? 'var(--accent, #38bdf8)' : 'rgba(255,255,255,0.05)',
                      color: isSelected ? '#fff' : 'var(--text)',
                      border: isSelected ? '1px solid var(--accent)' : '1px solid var(--border)',
                      borderRadius: 6,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      transition: 'all 0.15s ease',
                      boxShadow: isSelected ? '0 2px 8px rgba(56, 189, 248, 0.3)' : 'none',
                    }}
                  >
                    {isPreviewing ? '加载中…' : '比对差异 (Diff)'}
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '8px 16px',
            borderTop: '1px solid var(--border, #3c3c3c)',
            background: 'rgba(255, 255, 255, 0.02)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 11,
            color: 'var(--muted)',
          }}
        >
          <span>提示：点击任意提交或按 Enter 可直接对比当前版本与该提交的文件 Diff</span>
          <span>Esc 关闭</span>
        </div>
        {/* 右下角全向拖拽调整大小手柄 */}
        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>
    </div>
  );
}
