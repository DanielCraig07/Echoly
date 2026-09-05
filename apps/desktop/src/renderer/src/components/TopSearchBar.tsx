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
    const cleanQ = query.startsWith('>') ? query.slice(1).trim().toLowerCase() : query.trim().toLowerCase();
    if (!cleanQ) return true;
    return (
      act.title.toLowerCase().includes(cleanQ) ||
      act.category.toLowerCase().includes(cleanQ)
    );
  });

  const hitsCount =
    mode === 'files'
      ? fileHits.length
      : mode === 'actions'
        ? actionHits.length
        : codeHits.length;

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

  return (
    <div className={`top-search ${open ? 'open' : ''}`} ref={rootRef}>
      <div className="top-search-modes" role="tablist" aria-label="搜索模式">
        <button
          type="button"
          role="tab"
          className={mode === 'files' ? 'active' : ''}
          aria-selected={mode === 'files'}
          onClick={() => {
            setMode('files');
            setOpen(true);
            inputRef.current?.focus();
          }}
          disabled={!enabled}
          title={`搜索文件 (${cmdKey}P)`}
        >
          文件
        </button>
        <button
          type="button"
          role="tab"
          className={mode === 'actions' ? 'active' : ''}
          aria-selected={mode === 'actions'}
          onClick={() => {
            setMode('actions');
            setOpen(true);
            inputRef.current?.focus();
          }}
          title={`全局命令 (${cmdKey}Shift+P)`}
        >
          动作
        </button>
        <button
          type="button"
          role="tab"
          className={mode === 'code' ? 'active' : ''}
          aria-selected={mode === 'code'}
          onClick={() => {
            setMode('code');
            setOpen(true);
            inputRef.current?.focus();
          }}
          disabled={!enabled}
          title={`搜索代码 (${cmdKey}Shift+F)`}
        >
          代码
        </button>
      </div>
      <input
        ref={inputRef}
        className="top-search-input"
        type="search"
        disabled={!enabled && mode !== 'actions'}
        placeholder={
          mode === 'actions'
            ? `搜索 IDE 动作指令… (或输入 >)`
            : mode === 'files'
              ? `搜索文件… (${cmdKey}P)`
              : `搜索代码… (${cmdKey}Shift+F)`
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
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className="top-search-dropdown" role="listbox">
          {loading && <div className="top-search-empty">搜索中…</div>}
          {!loading && !query.trim() && mode !== 'actions' && (
            <div className="top-search-empty">输入关键字开始搜索</div>
          )}
          {!loading && hitsCount === 0 && (
            <div className="top-search-empty">无匹配结果</div>
          )}
          {!loading &&
            mode === 'files' &&
            fileHits.map((h, i) => (
              <button
                key={h.path}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`top-search-item ${i === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => selectFile(h.path)}
              >
                <span className="top-search-name">{h.path.split('/').pop()}</span>
                <span className="top-search-path">{h.path}</span>
              </button>
            ))}
          {!loading &&
            mode === 'actions' &&
            actionHits.map((act, i) => (
              <button
                key={act.id}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`top-search-item top-search-action-item ${i === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => executeAction(act)}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontSize: 10,
                      padding: '2px 6px',
                      borderRadius: 4,
                      background: 'var(--bg-card, rgba(255,255,255,0.06))',
                      color: 'var(--accent, #6a4da2)',
                      fontWeight: 600,
                      border: '1px solid var(--border)',
                    }}
                  >
                    {act.category}
                  </span>
                  <span className="top-search-name" style={{ fontSize: 12 }}>{act.title}</span>
                </div>
                {act.shortcut && (
                  <kbd
                    style={{
                      fontSize: 10,
                      color: 'var(--muted)',
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      padding: '1px 5px',
                      borderRadius: 3,
                    }}
                  >
                    {act.shortcut}
                  </kbd>
                )}
              </button>
            ))}
          {!loading &&
            mode === 'code' &&
            codeHits.map((h, i) => (
              <button
                key={`${h.path}:${h.line}:${i}`}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`top-search-item ${i === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => selectFile(h.path, h.line)}
              >
                <span className="top-search-name">
                  {h.path}
                  <span className="top-search-line">:{h.line}</span>
                </span>
                <span className="top-search-path">{h.preview.trim()}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
});
