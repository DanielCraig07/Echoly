import React, { useEffect, useState, useRef, useMemo } from 'react';
import type * as monaco from 'monaco-editor';
import type { GitBlameEntry } from '@deepseek-ide/shared';

interface Props {
  filePath: string;
  editor: monaco.editor.IStandaloneCodeEditor | null;
  onClose: () => void;
  onPreviewDiff?: (diff: {
    id: string;
    path: string;
    original: string;
    modified: string;
    description: string;
  }) => void;
}

export function GitBlameAnnotationGutter({
  filePath,
  editor,
  onClose,
  onPreviewDiff,
}: Props) {
  const [entries, setEntries] = useState<GitBlameEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [hoveredHash, setHoveredHash] = useState<string | null>(null);
  const [lineHeight, setLineHeight] = useState(19);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: GitBlameEntry } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 加载全文件 Git Blame 数据
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    void window.ide.gitBlameFile(filePath).then((res) => {
      if (!active) return;
      setLoading(false);
      if (res.ok && res.entries) {
        setEntries(res.entries);
      } else {
        setError(res.detail || '暂无 Git 追溯信息');
      }
    });

    return () => {
      active = false;
    };
  }, [filePath]);

  // 同步 Monaco 编辑器行高与滚动位置
  useEffect(() => {
    if (!editor) return;

    try {
      const lh = editor.getOption(66 /* EditorOption.lineHeight */);
      if (typeof lh === 'number' && lh > 0) {
        setLineHeight(lh);
      }
    } catch {
      // fallback
    }

    setScrollTop(editor.getScrollTop());

    const scrollDisposable = editor.onDidScrollChange((e) => {
      setScrollTop(e.scrollTop);
    });

    const modelDisposable = editor.onDidChangeModelContent(() => {
      // 当文件内容变更时，延迟刷新 blame
      void window.ide.gitBlameFile(filePath).then((res) => {
        if (res.ok && res.entries) setEntries(res.entries);
      });
    });

    return () => {
      scrollDisposable.dispose();
      modelDisposable.dispose();
    };
  }, [editor, filePath]);

  // 创建快速行号查找 map
  const lineToEntryMap = useMemo(() => {
    const map = new Map<number, GitBlameEntry>();
    for (const e of entries) {
      map.set(e.line, e);
    }
    return map;
  }, [entries]);

  const totalLines = editor?.getModel()?.getLineCount() || Math.max(entries.length, 1);

  // 处理点击单行提交
  const handleLineClick = async (entry: GitBlameEntry) => {
    if (!entry.hash || /^0+$/.test(entry.hash) || !onPreviewDiff) return;
    try {
      const res = await window.ide.gitShowCommitDiff(entry.hash, filePath);
      if (res.ok) {
        onPreviewDiff({
          id: `git:commit:${entry.hash}:${filePath}`,
          path: filePath,
          original: res.original,
          modified: res.modified,
          description: `提交 ${entry.shortHash} (${entry.author}) - ${filePath}`,
        });
      }
    } catch {
      // ignore
    }
  };

  return (
    <div
      ref={containerRef}
      style={{
        width: 220,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-editor, #141414)',
        borderRight: '1px solid var(--border)',
        flexShrink: 0,
        userSelect: 'none',
        overflow: 'hidden',
        position: 'relative',
        zIndex: 4,
      }}
      onClick={() => setContextMenu(null)}
    >
      {/* 顶部工具栏（严格遵守 30px 高度规范） */}
      <div
        style={{
          height: 30,
          boxSizing: 'border-box',
          padding: '0 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
          background: 'rgba(255, 255, 255, 0.02)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#38bdf8' }}>
            <circle cx="12" cy="12" r="4" />
            <line x1="1.05" y1="12" x2="7" y2="12" />
            <line x1="17.01" y1="12" x2="22.96" y2="12" />
          </svg>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', color: 'var(--text)' }}>
            Git 追溯 (Blame)
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="panel-action-btn"
            title="关闭追溯标注"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      {/* 滚动同步的主体标注行区域 */}
      <div
        ref={listRef}
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {loading && (
          <div style={{ padding: 16, fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
            正在分析提交历史...
          </div>
        )}
        {!loading && error && (
          <div style={{ padding: 16, fontSize: 11, color: '#f87171', textAlign: 'center' }}>
            {error}
          </div>
        )}
        {!loading && !error && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(-${scrollTop}px)`,
              willChange: 'transform',
            }}
          >
            {Array.from({ length: totalLines }, (_, idx) => {
              const lineNum = idx + 1;
              const entry = lineToEntryMap.get(lineNum);
              const prevEntry = lineToEntryMap.get(lineNum - 1);
              const isSameCommitAsPrev = prevEntry && entry && prevEntry.hash === entry.hash;
              const isUncommitted = !entry || !entry.hash || /^0+$/.test(entry.hash);
              const isHovered = entry && hoveredHash && entry.hash === hoveredHash;

              return (
                <div
                  key={lineNum}
                  style={{
                    height: lineHeight,
                    lineHeight: `${lineHeight}px`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0 8px',
                    boxSizing: 'border-box',
                    fontSize: 11,
                    cursor: isUncommitted ? 'default' : 'pointer',
                    background: isHovered
                      ? 'rgba(56, 189, 248, 0.16)'
                      : isSameCommitAsPrev
                        ? 'transparent'
                        : 'rgba(255, 255, 255, 0.01)',
                    borderTop: !isSameCommitAsPrev && lineNum > 1 ? '1px solid rgba(255, 255, 255, 0.04)' : 'none',
                    color: isUncommitted ? 'var(--muted)' : 'var(--text)',
                    transition: 'background 0.08s ease',
                  }}
                  onMouseEnter={() => {
                    if (entry?.hash && !isUncommitted) setHoveredHash(entry.hash);
                  }}
                  onMouseLeave={() => setHoveredHash(null)}
                  onClick={() => entry && handleLineClick(entry)}
                  onContextMenu={(e) => {
                    if (!entry) return;
                    e.preventDefault();
                    setContextMenu({ x: e.clientX, y: e.clientY, entry });
                  }}
                  title={
                    entry
                      ? `第 ${lineNum} 行:\n提交: ${entry.shortHash} (${entry.author})\n日期: ${entry.date || entry.relativeDate}\n信息: ${entry.message}\n${isUncommitted ? '' : '点击在主编辑器中对比此提交差异'}`
                      : `第 ${lineNum} 行: 未提交修改`
                  }
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>
                    {!isSameCommitAsPrev ? (
                      <>
                        <span
                          style={{
                            color: isUncommitted ? 'var(--muted)' : '#94a3b8',
                            fontSize: 10.5,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {entry?.relativeDate || '未提交'}
                        </span>
                        <span
                          style={{
                            color: isUncommitted ? 'var(--muted)' : 'var(--text)',
                            fontWeight: isUncommitted ? 400 : 500,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: 70,
                          }}
                        >
                          {entry?.author || 'You'}
                        </span>
                      </>
                    ) : (
                      <span style={{ color: 'rgba(255, 255, 255, 0.15)', fontSize: 10 }}>·</span>
                    )}
                  </div>

                  {!isSameCommitAsPrev && entry && !isUncommitted && (
                    <span
                      style={{
                        fontFamily: 'monospace',
                        fontSize: 10,
                        color: isHovered ? '#38bdf8' : '#64748b',
                        flexShrink: 0,
                      }}
                    >
                      {entry.shortHash}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="ctx-menu"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 10001,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.entry.hash && !/^0+$/.test(contextMenu.entry.hash) && (
            <>
              <button
                type="button"
                className="ctx-item"
                onClick={() => {
                  void handleLineClick(contextMenu.entry);
                  setContextMenu(null);
                }}
              >
                查看此提交差异 ({contextMenu.entry.shortHash})
              </button>
              <button
                type="button"
                className="ctx-item"
                onClick={() => {
                  void navigator.clipboard.writeText(contextMenu.entry.hash);
                  setContextMenu(null);
                }}
              >
                复制 Commit Hash
              </button>
              <div className="ctx-sep" />
            </>
          )}
          <button
            type="button"
            className="ctx-item"
            onClick={() => {
              onClose();
              setContextMenu(null);
            }}
          >
            关闭追溯标注
          </button>
        </div>
      )}
    </div>
  );
}
