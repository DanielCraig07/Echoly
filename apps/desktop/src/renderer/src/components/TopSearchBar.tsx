import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { SearchCodeHit, SearchFileHit } from '@deepseek-ide/shared';

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
}

export const TopSearchBar = forwardRef<TopSearchBarHandle, Props>(function TopSearchBar(
  { enabled, actions = [], onOpenFile },
  ref,
) {
  const [mode, setMode] = useState<SearchMode>('files');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fileHits, setFileHits] = useState<SearchFileHit[]>([]);
  const [codeHits, setCodeHits] = useState<SearchCodeHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useImperativeHandle(ref, () => ({
    focus: (nextMode?: SearchMode) => {
      if (nextMode) setMode(nextMode);
      setOpen(true);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
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

  const hitsCount =
    mode === 'files' ? fileHits.length : mode === 'actions' ? actionHits.length : codeHits.length;

  useEffect(() => {
    if (!enabled) {
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

    if (!query.trim() || query.startsWith('>')) {
      setFileHits([]);
      setCodeHits([]);
      setLoading(false);
      return;
    }

    const id = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (mode === 'files') {
            const hits = await window.ide.searchFiles(query, 40);
            if (id !== seq.current) return;
            setFileHits(hits);
            setCodeHits([]);
            setActiveIndex(0);
          } else {
            const hits = await window.ide.searchCode({
              query,
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
    }, 180);
    return () => clearTimeout(timer);
  }, [query, mode, enabled]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

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
      if (mode === 'files' && fileHits[activeIndex]) {
        selectFile(fileHits[activeIndex].path);
      } else if (mode === 'actions' && actionHits[activeIndex]) {
        executeAction(actionHits[activeIndex]);
      } else if (mode === 'code' && codeHits[activeIndex]) {
        const h = codeHits[activeIndex];
        selectFile(h.path, h.line);
      }
    }
  };

  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  const cmdKey = isMac ? '⌘' : 'Ctrl+';

  const handleTabSwitch = () => {
    if (mode === 'actions') setMode('files');
    else if (mode === 'files') setMode('code');
    else setMode('actions');
  };

  return (
    <>
      {open && (
        <div
          className="cmd-palette-backdrop"
          onClick={() => {
            setOpen(false);
            setQuery('');
          }}
        >
          <div className="cmd-palette-modal" ref={rootRef} onClick={(e) => e.stopPropagation()}>
            {/* 顶部搜索输入与模式切换 */}
            <div className="cmd-palette-header">
              <div className="cmd-palette-icon">
                {mode === 'actions' ? (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                ) : mode === 'files' ? (
                  <svg
                    width="18"
                    height="18"
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
                    width="18"
                    height="18"
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
                type="search"
                disabled={!enabled && mode !== 'actions'}
                placeholder={
                  mode === 'actions'
                    ? '输入关键词搜索全局动作与命令…'
                    : mode === 'files'
                      ? '搜索项目文件… (按 Tab 切换到命令模式)'
                      : '搜索全文代码片段…'
                }
                value={query}
                onChange={(e) => {
                  const val = e.target.value;
                  setQuery(val);
                  if (val.startsWith('>') && mode !== 'actions') {
                    setMode('actions');
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
              <div className="cmd-palette-tabs">
                <button
                  type="button"
                  className={`cmd-tab ${mode === 'actions' ? 'active' : ''}`}
                  onClick={() => {
                    setMode('actions');
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
            <div className="cmd-palette-body">
              {loading && (
                <div className="cmd-palette-state">
                  <div className="cmd-spinner" />
                  <span>正在全力搜索中…</span>
                </div>
              )}

              {!loading && !query.trim() && mode !== 'actions' && (
                <div className="cmd-palette-state">
                  <span className="cmd-state-hint">键入文件名或路径片段快速定位文件</span>
                </div>
              )}

              {!loading && hitsCount === 0 && (
                <div className="cmd-palette-state">
                  <span className="cmd-state-hint">未找到匹配的结果</span>
                </div>
              )}

              {!loading && mode === 'actions' && (
                <div className="cmd-palette-list">
                  {actionHits.map((act, i) => {
                    const isSelected = i === activeIndex;
                    return (
                      <div
                        key={act.id}
                        className={`cmd-item ${isSelected ? 'active' : ''}`}
                        onMouseEnter={() => setActiveIndex(i)}
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
                            <kbd className="cmd-kbd">{act.shortcut}</kbd>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {!loading && mode === 'files' && (
                <div className="cmd-palette-list">
                  {fileHits.map((h, i) => {
                    const isSelected = i === activeIndex;
                    const fileName = h.path.split('/').pop() || h.path;
                    const dirName = h.path.substring(0, h.path.lastIndexOf('/')) || '';
                    return (
                      <div
                        key={h.path}
                        className={`cmd-item ${isSelected ? 'active' : ''}`}
                        onMouseEnter={() => setActiveIndex(i)}
                        onClick={() => selectFile(h.path)}
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

              {!loading && mode === 'code' && (
                <div className="cmd-palette-list">
                  {codeHits.map((h, i) => {
                    const isSelected = i === activeIndex;
                    return (
                      <div
                        key={`${h.path}:${h.line}:${i}`}
                        className={`cmd-item cmd-code-item ${isSelected ? 'active' : ''}`}
                        onMouseEnter={() => setActiveIndex(i)}
                        onClick={() => selectFile(h.path, h.line)}
                      >
                        <div className="cmd-code-header">
                          <span className="cmd-item-title">{h.path}</span>
                          <span className="cmd-code-line">:{h.line}</span>
                        </div>
                        <div className="cmd-code-preview">{h.preview.trim()}</div>
                      </div>
                    );
                  })}
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
                <span className="cmd-shortcut-tip">
                  <kbd className="cmd-mini-kbd">Esc</kbd> 退出
                </span>
              </div>
              <div className="cmd-footer-count">
                {mode === 'actions'
                  ? `${actionHits.length} 个动作指令`
                  : mode === 'files'
                    ? `${fileHits.length} 个文件匹配`
                    : `${codeHits.length} 处匹配代码`}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
