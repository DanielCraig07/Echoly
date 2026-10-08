import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { SearchCodeHit, SearchFileHit } from '@deepseek-ide/shared';
import { useModalResize, ModalResizeHandle, isModalResizing } from '../hooks/useModalResize';

export type SearchMode = 'files' | 'actions' | 'code';

export interface CommandAction {
  id: string;
  title: string;
  category: string;
  shortcut?: string;
  handler: () => void;
}

export interface TopSearchBarHandle {
  focus: (mode?: SearchMode) => void;
}

interface Props {
  enabled: boolean;
  actions?: CommandAction[];
  onOpenFile: (path: string, line?: number) => void;
  activePath?: string;
}

function formatShortcut(shortcut?: string, isMac?: boolean) {
  if (!shortcut) return '';
  if (!isMac) return shortcut;
  return shortcut
    .replace(/Cmd\+/g, '⌘')
    .replace(/Command\+/g, '⌘')
    .replace(/Shift\+/g, '⇧')
    .replace(/Alt\+/g, '⌥')
    .replace(/Option\+/g, '⌥')
    .replace(/Ctrl\+/g, '⌃');
}

export const TopSearchBar = forwardRef<TopSearchBarHandle, Props>(function TopSearchBar(
  { enabled, actions = [], onOpenFile, activePath },
  ref,
) {
  const [mode, setMode] = useState<SearchMode>('files');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fileHits, setFileHits] = useState<SearchFileHit[]>([]);
  const [codeHits, setCodeHits] = useState<SearchCodeHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly_cmd_palette_size',
    defaultWidth: 640,
    defaultHeight: 440,
    minWidth: 460,
    minHeight: 240,
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastMousePosRef = useRef({ x: -1, y: -1 });
  const seq = useRef(0);

  const isLineJump = query.startsWith(':');
  const lineMatch = query.match(/^:\s*(\d*)/);
  const jumpLine = lineMatch && lineMatch[1] ? parseInt(lineMatch[1], 10) : undefined;

  useImperativeHandle(ref, () => ({
    focus: (nextMode?: SearchMode) => {
      if (nextMode) setMode(nextMode);
      setOpen(true);
      setActiveIndex(0);
      if (enabled) {
        void window.ide.searchFiles('', 1);
      }
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
        bodyRef.current?.scrollTo({ top: 0, behavior: 'auto' });
      });
    },
  }));

  // 过滤 actions 动作列表
  const actionHits = actions.filter((act) => {
    if (!query.trim() || query === '>') return true;
    const cleanQ = query.startsWith('>')
      ? query.slice(1).trim().toLowerCase()
      : query.trim().toLowerCase();
    if (!cleanQ) return true;
    return act.title.toLowerCase().includes(cleanQ) || act.category.toLowerCase().includes(cleanQ);
  });

  const hitsCount = isLineJump
    ? (activePath ? 1 : 0)
    : mode === 'files'
      ? fileHits.length
      : mode === 'actions'
        ? actionHits.length
        : codeHits.length;

  interface CodeGroup {
    path: string;
    fileName: string;
    dirName: string;
    items: Array<{ hit: SearchCodeHit; flatIndex: number }>;
  }

  // 同一文件下的代码搜索结果自动合并到该文件下展示
  const groupedCodeHits = useMemo<CodeGroup[]>(() => {
    if (mode !== 'code' || codeHits.length === 0) return [];
    const groups: CodeGroup[] = [];
    const map = new Map<string, CodeGroup>();

    codeHits.forEach((hit, flatIndex) => {
      let group = map.get(hit.path);
      if (!group) {
        const fileName = hit.path.split('/').pop() || hit.path;
        const lastSlash = hit.path.lastIndexOf('/');
        const dirName = lastSlash > 0 ? hit.path.substring(0, lastSlash) : '';
        group = {
          path: hit.path,
          fileName,
          dirName,
          items: [],
        };
        map.set(hit.path, group);
        groups.push(group);
      }
      group.items.push({ hit, flatIndex });
    });

    return groups;
  }, [mode, codeHits]);

  const renderMatchPreview = (text: string, q: string) => {
    const trimmed = text.trim();
    const cleanQ = q.trim();
    if (!cleanQ) return trimmed;
    const lowerText = trimmed.toLowerCase();
    const lowerQ = cleanQ.toLowerCase();
    const idx = lowerText.indexOf(lowerQ);
    if (idx === -1) return trimmed;
    return (
      <>
        {trimmed.slice(0, idx)}
        <span className="cmd-match-highlight">{trimmed.slice(idx, idx + cleanQ.length)}</span>
        {trimmed.slice(idx + cleanQ.length)}
      </>
    );
  };

  useEffect(() => {
    if (!enabled) {
      setFileHits([]);
      setCodeHits([]);
      setLoading(false);
      return;
    }

    if (query.startsWith(':')) {
      setFileHits([]);
      setCodeHits([]);
      setLoading(false);
      return;
    }

    if (mode === 'actions') {
      setActiveIndex(0);
      setLoading(false);
      return;
    }

    let effectiveQuery = query.trim();
    if (mode === 'files') {
      const fileWithLine = effectiveQuery.match(/^(.*?):(\d+)$/);
      if (fileWithLine) {
        effectiveQuery = fileWithLine[1].trim();
      }
    } else if (mode === 'code') {
      if (effectiveQuery.startsWith('@')) {
        effectiveQuery = effectiveQuery.slice(1).trim();
      }
    }

    if (!effectiveQuery || effectiveQuery.startsWith('>')) {
      setFileHits([]);
      setCodeHits([]);
      setLoading(false);
      return;
    }

    const id = ++seq.current;
    setLoading(true);
    const delay = mode === 'files' ? 40 : 120;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (mode === 'files') {
            const hits = await window.ide.searchFiles(effectiveQuery, 40);
            if (id !== seq.current) return;
            setFileHits(hits);
            setCodeHits([]);
            setActiveIndex(0);
          } else {
            const hits = await window.ide.searchCode({
              query: effectiveQuery,
              caseInsensitive: true,
              max: 60,
            });
            if (id !== seq.current) return;
            setCodeHits(hits);
            setFileHits([]);
            setActiveIndex(0);
          }
        } catch {
          if (id !== seq.current) return;
          setFileHits([]);
          setCodeHits([]);
        } finally {
          if (id === seq.current) setLoading(false);
        }
      })();
    }, delay);
    return () => clearTimeout(timer);
  }, [query, mode, enabled]);

  // Scroll active item smoothly with breathing room padding to eliminate edge jump
  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;

    if (activeIndex === 0) {
      container.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    const el = container.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (!el) return;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const buffer = 14; // breathing room

    if (elRect.bottom + buffer > containerRect.bottom) {
      const scrollAmount = elRect.bottom + buffer - containerRect.bottom;
      container.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    } else if (elRect.top - buffer < containerRect.top) {
      const scrollAmount = elRect.top - buffer - containerRect.top;
      container.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    }
  }, [activeIndex]);

  const handleItemMouseMove = (i: number, e: React.MouseEvent) => {
    if (
      Math.abs(e.clientX - lastMousePosRef.current.x) > 1 ||
      Math.abs(e.clientY - lastMousePosRef.current.y) > 1
    ) {
      lastMousePosRef.current = { x: e.clientX, y: e.clientY };
      if (activeIndex !== i) {
        setActiveIndex(i);
      }
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (isModalResizing()) return;
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const selectFile = useCallback(
    (path: string, line?: number) => {
      setOpen(false);
      onOpenFile(path, line);
    },
    [onOpenFile],
  );

  const executeAction = useCallback((act: CommandAction) => {
    setOpen(false);
    setQuery('');
    act.handler();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, Math.max(hitsCount - 1, 0)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isLineJump) {
        if (activePath && jumpLine && jumpLine > 0) {
          selectFile(activePath, jumpLine);
        }
        return;
      }
      if (mode === 'files' && fileHits[activeIndex]) {
        const fileWithLine = query.match(/:(\d+)$/);
        const targetLine = fileWithLine ? parseInt(fileWithLine[1], 10) : undefined;
        selectFile(fileHits[activeIndex].path, targetLine);
      } else if (mode === 'actions' && actionHits[activeIndex]) {
        executeAction(actionHits[activeIndex]);
      } else if (mode === 'code' && codeHits[activeIndex]) {
        const h = codeHits[activeIndex];
        selectFile(h.path, h.line);
      }
    }
  };

  const isMac =
    typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
  const cmdKey = isMac ? '⌘' : 'Ctrl+';

  const handleTabSwitch = () => {
    setActiveIndex(0);
    if (mode === 'actions') setMode('files');
    else if (mode === 'files') setMode('code');
    else setMode('actions');
  };

  const placeholderText = useMemo(() => {
    if (isLineJump) {
      return activePath ? `输入行号快速跳转… (当前文件: ${activePath})` : '输入行号以跳转… (当前未打开活动文件)';
    }
    if (mode === 'actions') {
      return '输入关键字搜索全局动作与命令…';
    }
    if (mode === 'code') {
      return '搜索全文代码片段与符号…';
    }
    return '搜索文件… (输入 > 搜命令，@ 搜代码，: 跳行，Tab 切换)';
  }, [isLineJump, activePath, mode]);

  return (
    <>
      {open && (
        <div
          className="cmd-palette-modal"
          ref={rootRef}
          style={{
            width: `${modalSize.width}px`,
            height: `${modalSize.height}px`,
          }}
        >
          {/* 顶部搜索输入与模式切换 */}
          <div className="cmd-palette-header">
              <div className="cmd-input-box">
                <div className="cmd-palette-icon">
                  {loading ? (
                    <div className="cmd-mini-spinner" />
                  ) : isLineJump ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="7 13 12 18 17 13" />
                      <polyline points="7 6 12 11 17 6" />
                    </svg>
                  ) : mode === 'actions' ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  ) : mode === 'files' ? (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  ) : (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                  )}
                </div>
                <input
                  ref={inputRef}
                  className="cmd-palette-input"
                  type="text"
                  disabled={!enabled && mode !== 'actions'}
                  placeholder={placeholderText}
                  value={query}
                  onChange={(e) => {
                    const val = e.target.value;
                    setQuery(val);
                    if (val.startsWith('>') && mode !== 'actions') {
                      setMode('actions');
                    } else if (val.startsWith('@') && mode !== 'code') {
                      setMode('code');
                    }
                    setOpen(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Tab') {
                      e.preventDefault();
                      handleTabSwitch();
                      return;
                    }
                    onKeyDown(e);
                  }}
                />
                {query.length > 0 && (
                  <button
                    type="button"
                    className="cmd-input-clear-btn"
                    title="清空搜索"
                    onClick={() => {
                      setQuery('');
                      setActiveIndex(0);
                      inputRef.current?.focus();
                    }}
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="cmd-palette-tabs">
                <button
                  type="button"
                  className={`cmd-tab ${mode === 'actions' ? 'active' : ''}`}
                  onClick={() => {
                    setMode('actions');
                    setActiveIndex(0);
                    inputRef.current?.focus();
                  }}
                >
                  动作
                </button>
                <button
                  type="button"
                  className={`cmd-tab ${mode === 'files' ? 'active' : ''}`}
                  onClick={() => {
                    setMode('files');
                    setActiveIndex(0);
                    inputRef.current?.focus();
                  }}
                  disabled={!enabled}
                >
                  文件
                </button>
                <button
                  type="button"
                  className={`cmd-tab ${mode === 'code' ? 'active' : ''}`}
                  onClick={() => {
                    setMode('code');
                    setActiveIndex(0);
                    inputRef.current?.focus();
                  }}
                  disabled={!enabled}
                >
                  代码
                </button>
              </div>
              <button
                type="button"
                className="cmd-palette-close-btn"
                title="关闭 (Esc)"
                onClick={() => {
                  setOpen(false);
                  setQuery('');
                }}
              >
                Esc
              </button>
            </div>

            {/* 结果列表区 */}
            <div className="cmd-palette-body" ref={bodyRef}>
              {loading && hitsCount === 0 && (
                <div className="cmd-palette-state">
                  <div className="cmd-spinner" />
                  <span>正在全力搜索中…</span>
                </div>
              )}

              {isLineJump && (
                <div className="cmd-palette-list">
                  {activePath ? (
                    <div
                      data-index={0}
                      className="cmd-item active"
                      onClick={() => {
                        if (jumpLine && jumpLine > 0) {
                          selectFile(activePath, jumpLine);
                        }
                      }}
                    >
                      <div className="cmd-item-left">
                        <span className="cmd-category-tag cat-navigation">
                          跳转
                        </span>
                        <span className="cmd-item-title">
                          {jumpLine ? `跳转至第 ${jumpLine} 行` : '输入目标行号并按回车… (例如 :42)'}
                        </span>
                        <span className="cmd-item-path" style={{ marginLeft: 8, opacity: 0.65, fontSize: 12 }}>
                          {activePath}
                        </span>
                      </div>
                      <div className="cmd-item-right">
                        <kbd className="cmd-kbd">↵ 跳转</kbd>
                      </div>
                    </div>
                  ) : (
                    <div className="cmd-palette-state">
                      <span className="cmd-state-hint">当前未打开任何编辑文件，无法按行跳转</span>
                    </div>
                  )}
                </div>
              )}

              {!isLineJump && !loading && !query.trim() && mode !== 'actions' && (
                <div className="cmd-palette-state">
                  <span className="cmd-state-hint">键入文件名或路径片段快速定位文件</span>
                </div>
              )}

              {!isLineJump && !loading && hitsCount === 0 && query.trim() && (
                <div className="cmd-palette-state">
                  <span className="cmd-state-hint">未找到匹配的结果</span>
                </div>
              )}

              {!isLineJump && mode === 'actions' && actionHits.length > 0 && (
                <div className="cmd-palette-list">
                  {actionHits.map((act, i) => {
                    const isSelected = i === activeIndex;
                    return (
                      <div
                        key={act.id}
                        data-index={i}
                        className={`cmd-item ${isSelected ? 'active' : ''}`}
                        onMouseMove={(e) => handleItemMouseMove(i, e)}
                        onClick={() => executeAction(act)}
                      >
                        <div className="cmd-item-left">
                          <span className={`cmd-category-tag cat-${act.category}`}>
                            {act.category}
                          </span>
                          <span className="cmd-item-title">{act.title}</span>
                        </div>
                        {act.shortcut && (
                          <div className="cmd-item-right">
                            <kbd className="cmd-kbd">{formatShortcut(act.shortcut, isMac)}</kbd>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {!isLineJump && mode === 'files' && fileHits.length > 0 && (
                <div className="cmd-palette-list">
                  {fileHits.map((h, i) => {
                    const isSelected = i === activeIndex;
                    const fileName = h.path.split('/').pop() || h.path;
                    const dirName = h.path.substring(0, h.path.lastIndexOf('/')) || '';
                    return (
                      <div
                        key={h.path}
                        data-index={i}
                        className={`cmd-item ${isSelected ? 'active' : ''}`}
                        onMouseMove={(e) => handleItemMouseMove(i, e)}
                        onClick={() => {
                          const fileWithLine = query.match(/:(\d+)$/);
                          const targetLine = fileWithLine ? parseInt(fileWithLine[1], 10) : undefined;
                          selectFile(h.path, targetLine);
                        }}
                      >
                        <div className="cmd-item-left">
                          <svg
                            className="cmd-file-icon"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                          >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          <span className="cmd-item-title">{fileName}</span>
                          {dirName && <span className="cmd-item-subpath">{dirName}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {mode === 'code' && codeHits.length > 0 && (
                <div className="cmd-code-groups">
                  {groupedCodeHits.map((group) => (
                    <div key={group.path} className="cmd-code-group">
                      <div
                        className="cmd-code-group-header"
                        onClick={() => selectFile(group.path, group.items[0]?.hit.line)}
                        title={`打开文件 ${group.path}`}
                      >
                        <div className="cmd-code-group-info">
                          <svg
                            className="cmd-file-icon"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                          >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          <span className="cmd-code-group-filename">{group.fileName}</span>
                          {group.dirName && <span className="cmd-code-group-dir">{group.dirName}</span>}
                        </div>
                        <span className="cmd-code-group-badge">{group.items.length} 处匹配</span>
                      </div>
                      <div className="cmd-code-group-items">
                        {group.items.map(({ hit, flatIndex }) => {
                          const isSelected = flatIndex === activeIndex;
                          return (
                            <div
                              key={`${hit.path}:${hit.line}:${flatIndex}`}
                              data-index={flatIndex}
                              className={`cmd-item cmd-code-match-item ${isSelected ? 'active' : ''}`}
                              onMouseMove={(e) => handleItemMouseMove(flatIndex, e)}
                              onClick={() => selectFile(hit.path, hit.line)}
                            >
                              <span className="cmd-code-line-badge">:{hit.line}</span>
                              <span className="cmd-code-preview-text">
                                {renderMatchPreview(hit.preview, query)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 底部极客状态栏 */}
            <div className="cmd-palette-footer">
              <div className="cmd-footer-shortcuts">
                <span className="cmd-shortcut-tip">
                  <kbd className="cmd-mini-kbd">↑</kbd>
                  <kbd className="cmd-mini-kbd">↓</kbd> 选择
                </span>
                <span className="cmd-shortcut-tip">
                  <kbd className="cmd-mini-kbd">↵</kbd> 执行
                </span>
                <span className="cmd-shortcut-tip">
                  <kbd className="cmd-mini-kbd">Tab</kbd> 模式切换
                </span>
                <span className="cmd-shortcut-tip" title="输入 > 搜索全局命令">
                  <kbd className="cmd-mini-kbd">&gt;</kbd> 命令
                </span>
                <span className="cmd-shortcut-tip" title="输入 @ 搜索代码符号">
                  <kbd className="cmd-mini-kbd">@</kbd> 代码
                </span>
                <span className="cmd-shortcut-tip" title="输入 : 行号跳转">
                  <kbd className="cmd-mini-kbd">:</kbd> 跳行
                </span>
                <span className="cmd-shortcut-tip">
                  <kbd className="cmd-mini-kbd">Esc</kbd> 退出
                </span>
              </div>
              <div className="cmd-footer-count">
                {isLineJump
                  ? '行号直达模式'
                  : mode === 'actions'
                    ? `${actionHits.length} 个动作指令`
                    : mode === 'files'
                      ? `${fileHits.length} 个文件匹配`
                      : `${groupedCodeHits.length} 个文件 · ${codeHits.length} 处匹配代码`}
              </div>
              <ModalResizeHandle
                onMouseDown={handleResizeStart}
                className="cmd-resize-handle"
                title="拖动右下角调整大小 (支持上下左右)"
              />
            </div>
          </div>
        )}
      </>
  );
});
