import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import type { UiTheme } from '@deepseek-ide/shared';
import { uid } from '../utils';
import { TerminalAiKBar } from './TerminalAiKBar';

interface Props {
  terminalKind: 'local' | 'ssh';
  uiTheme: UiTheme;
  /** When nonce changes, open or switch terminal tab with the given cwd and optional initial command. */
  openRequest?: {
    cwd: string;
    nonce: number;
    initialCommand?: string;
    terminalType?: string;
    terminalTitle?: string;
  } | null;
  visible?: boolean;
  scrollback?: number;
  maximized?: boolean;
  onCollapse?: () => void;
}

interface TermTab {
  clientId: string;
  index: number;
  terminalType?: string;
  customTitle?: string;
  cwd?: string;
  initialCommand?: string;
}

function terminalTheme(uiTheme: UiTheme) {
  if (uiTheme === 'light') {
    return {
      background: '#f4effa',
      foreground: '#2a1b3d',
      cursor: '#82318e',
      selectionBackground: 'rgba(130, 49, 142, 0.25)',
    };
  }
  return {
    background: '#141414',
    foreground: '#cccccc',
    cursor: '#aeafad',
    selectionBackground: 'rgba(255, 255, 255, 0.15)',
  };
}

/** 已废弃：PTY（node-pty）会原生回显输入，无需再手动镜像。保留签名以防外部引用。 */
function echoLocalInput(_term: Terminal, _data: string): void {}

function makeTab(
  index: number,
  cwd?: string,
  initialCommand?: string,
  terminalType?: string,
  customTitle?: string,
): TermTab {
  return { clientId: uid(), index, cwd, initialCommand, terminalType, customTitle };
}

function tabLabel(kind: 'local' | 'ssh', index: number): string {
  return kind === 'ssh' ? `SSH ${index}` : `本地 ${index}`;
}

function renderTabIcon(tab: TermTab, terminalKind: 'local' | 'ssh') {
  const type = (tab.terminalType || '').toLowerCase();
  const title = (tab.customTitle || '').toLowerCase();

  if (type === 'mvn' || title.includes('mvn') || title.includes('maven')) {
    return (
      <span className="terminal-tab-icon maven" title="Maven 构建">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z" />
          <line x1="16" y1="8" x2="2" y2="22" />
          <line x1="17.5" y1="15" x2="9" y2="15" />
        </svg>
      </span>
    );
  }
  if (type === 'java' || title.includes('java')) {
    return (
      <span className="terminal-tab-icon java" title="Java 运行环境">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8h1a4 4 0 0 1 0 8h-1" />
          <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z" />
          <line x1="6" y1="1" x2="6" y2="4" />
          <line x1="10" y1="1" x2="10" y2="4" />
        </svg>
      </span>
    );
  }
  if (terminalKind === 'ssh' || type === 'ssh') {
    return (
      <span className="terminal-tab-icon ssh" title="SSH 远程主机">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#3ecf8e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="7" rx="2" />
          <rect x="2" y="14" width="20" height="7" rx="2" />
          <line x1="6" y1="6.5" x2="6.01" y2="6.5" />
          <line x1="6" y1="17.5" x2="6.01" y2="17.5" />
        </svg>
      </span>
    );
  }
  return (
    <span className="terminal-tab-icon shell" title="终端会话">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    </span>
  );
}

function IconPlus({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconClear({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="5.7" y1="5.7" x2="18.3" y2="18.3" />
    </svg>
  );
}

function IconTrash({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function IconWordWrap({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M3 12h13a3 3 0 0 1 3 3v0a3 3 0 0 1-3 3H10" />
      <polyline points="13 15 10 18 13 21" />
    </svg>
  );
}

function IconClose({ size = 9 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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
  );
}

function IconScrollToTop({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="4" y1="4" x2="20" y2="4" />
      <polyline points="18 13 12 7 6 13" />
      <line x1="12" y1="7" x2="12" y2="20" />
    </svg>
  );
}

function IconScrollToBottom({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="4" x2="12" y2="17" />
      <polyline points="6 11 12 17 18 11" />
      <line x1="4" y1="20" x2="20" y2="20" />
    </svg>
  );
}

function IconSearch({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

interface TerminalSearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  caseSensitive: boolean;
  onToggleCaseSensitive: () => void;
  wholeWord: boolean;
  onToggleWholeWord: () => void;
  regex: boolean;
  onToggleRegex: () => void;
  resultIndex: number;
  resultCount: number;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onClose: () => void;
  focusNonce?: number;
}

function TerminalSearchBar({
  query,
  onQueryChange,
  caseSensitive,
  onToggleCaseSensitive,
  wholeWord,
  onToggleWholeWord,
  regex,
  onToggleRegex,
  resultIndex,
  resultCount,
  onFindNext,
  onFindPrevious,
  onClose,
  focusNonce,
}: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = () => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    };
    focus();
    const rafId = requestAnimationFrame(focus);
    const timerId = setTimeout(focus, 30);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timerId);
    };
  }, [focusNonce]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.select();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        onFindPrevious();
      } else {
        onFindNext();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="terminal-search-bar" onClick={(e) => e.stopPropagation()}>
      <div className="terminal-search-input-container">
        <input
          ref={inputRef}
          type="text"
          className="terminal-search-input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="在终端中查找..."
        />
        <div style={{ position: 'absolute', right: 4, display: 'flex', gap: 2, alignItems: 'center' }}>
          <button
            type="button"
            className={`input-toggle-btn${caseSensitive ? ' active' : ''}`}
            title="区分大小写 (Alt+C)"
            onClick={onToggleCaseSensitive}
            style={{ fontFamily: 'monospace' }}
          >
            Aa
          </button>
          <button
            type="button"
            className={`input-toggle-btn${wholeWord ? ' active' : ''}`}
            title="全字匹配 (Alt+W)"
            onClick={onToggleWholeWord}
            style={{
              fontFamily: 'monospace',
              textDecoration: wholeWord ? 'underline' : 'none',
            }}
          >
            ab
          </button>
          <button
            type="button"
            className={`input-toggle-btn${regex ? ' active' : ''}`}
            title="使用正则表达式 (Alt+R)"
            onClick={onToggleRegex}
            style={{ fontFamily: 'monospace' }}
          >
            .*
          </button>
        </div>
      </div>

      {query && (
        <span className={`terminal-search-badge${resultCount === 0 ? ' no-results' : ''}`}>
          {resultCount === 0
            ? '无结果'
            : resultIndex >= 0
              ? `${resultIndex + 1}/${resultCount}`
              : `${resultCount} 项`}
        </span>
      )}

      <div className="terminal-search-actions">
        <button
          type="button"
          className="panel-action-btn"
          title="上一个匹配项 (Shift+Enter)"
          onClick={onFindPrevious}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
        <button
          type="button"
          className="panel-action-btn"
          title="下一个匹配项 (Enter)"
          onClick={onFindNext}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <button
          type="button"
          className="panel-action-btn"
          title="关闭搜索 (Esc)"
          onClick={onClose}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function wrapCommand(cmd: string): string {
  const trimmed = cmd.trim();
  if (!trimmed || trimmed.includes('__ECHOLY_')) return trimmed;
  const isWin =
    typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent);
  if (isWin) {
    return `(${trimmed}) & echo. & echo [Process finished with exit code %ERRORLEVEL%] & echo __ECHOLY_^FIN__:%ERRORLEVEL%`;
  }
  // 使用 printf 拼接标识符，确保在 shell 原生回显输入行时绝不包含完整的 "__ECHOLY_FIN__:" 字样，
  // 彻底避免在命令刚输入时就被误识别为结束（杜绝运行按钮刚点击就闪退回播放状态）
  return `(${trimmed}); __ret=$?; echo ""; echo "[Process finished with exit code $__ret]"; printf "__ECHOLY_%s:%d\\n" "FIN__" $__ret`;
}

import { colorizeTerminalLogs } from '../utils/terminalLogColorizer';
import { measureContentColumns } from '../utils/terminalWidth';
export { colorizeTerminalLogs };

interface SessionProps {
  clientId: string;
  active: boolean;
  visible?: boolean;
  terminalKind: 'local' | 'ssh';
  uiTheme: UiTheme;
  cwd?: string;
  initialCommand?: string;
  wordWrap?: boolean;
  scrollback?: number;
  maximized?: boolean;
  searchOpen?: boolean;
  searchFocusNonce?: number;
  onOpenSearch?: () => void;
  onCloseSearch?: () => void;
  onRegisterSession?: (clientId: string, sendCmd: (cmd: string) => void) => () => void;
  onRegisterRawSession?: (clientId: string, sendRaw: (raw: string) => void) => () => void;
  onRegisterExtractLog?: (clientId: string, getLog: (lines?: number) => string) => () => void;
  onRegisterFocus?: (clientId: string, focusFn: () => void) => () => void;
  onTriggerAiK?: () => void;
}


function TerminalSession({
  clientId,
  active,
  visible = true,
  terminalKind,
  uiTheme,
  cwd,
  initialCommand,
  wordWrap = true,
  scrollback,
  maximized,
  searchOpen,
  searchFocusNonce,
  onOpenSearch,
  onCloseSearch,
  onRegisterSession,
  onRegisterRawSession,
  onRegisterExtractLog,
  onRegisterFocus,
  onTriggerAiK,
}: SessionProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const idRef = useRef<string | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const wordWrapRef = useRef(wordWrap);
  wordWrapRef.current = wordWrap;

  // 搜索状态管理
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchResultIndex, setSearchResultIndex] = useState(-1);
  const [searchResultCount, setSearchResultCount] = useState(0);

  // 不换行模式下横向滚动区宽度的唯一来源：
  // measureContentColumns 会把折行行拼回逻辑行后取最宽者，宽度只取决于「内容」，
  // 与列数调整本身无关，不会出现「改一次列数宽度就变一次」的反馈循环。
  const maxLineLenRef = useRef<number>(0);
  // 列数调整去抖：不换行模式下最长行是动态变化的，每来一帧输出就 resize 会抖动
  const colFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 最近一次已应用的列数，用于跳过重复 resize
  const lastWideColsRef = useRef<number>(0);

  // no-wrap 模式自定义纵向滚动条（固定在 host 右边缘）
  const vScrollBarRef = useRef<HTMLDivElement | null>(null);
  const vScrollThumbRef = useRef<HTMLDivElement | null>(null);
  const isDraggingVScroll = useRef(false);
  const vScrollDragStartY = useRef(0);
  const vScrollDragStartScrollTop = useRef(0);

  const getXtermViewport = () =>
    hostRef.current?.querySelector<HTMLElement>('.xterm-viewport') ?? null;

  const updateVScrollThumb = useCallback(() => {
    const viewport = getXtermViewport();
    const scrollbar = vScrollBarRef.current;
    const thumb = vScrollThumbRef.current;
    if (!viewport || !scrollbar || !thumb) return;

    const scrollHeight = viewport.scrollHeight;
    const clientHeight = viewport.clientHeight;
    const scrollTop = viewport.scrollTop;

    if (scrollHeight <= clientHeight + 2) {
      scrollbar.style.opacity = '0';
      scrollbar.style.pointerEvents = 'none';
      return;
    }

    scrollbar.style.opacity = '1';
    scrollbar.style.pointerEvents = 'auto';

    const thumbRatio = clientHeight / scrollHeight;
    const thumbHeight = Math.max(24, thumbRatio * scrollbar.clientHeight);
    const maxTop = scrollbar.clientHeight - thumbHeight;
    const thumbTop = maxTop > 0 ? (scrollTop / (scrollHeight - clientHeight)) * maxTop : 0;

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }, []);

  const handleVScrollTrackClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== vScrollBarRef.current) return; // 点击轨道而非滑块
    const viewport = getXtermViewport();
    const scrollbar = vScrollBarRef.current;
    if (!viewport || !scrollbar) return;
    const rect = scrollbar.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;
    viewport.scrollTop = ratio * (viewport.scrollHeight - viewport.clientHeight);
  }, []);

  const handleVScrollThumbMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const viewport = getXtermViewport();
    if (!viewport) return;
    isDraggingVScroll.current = true;
    vScrollDragStartY.current = e.clientY;
    vScrollDragStartScrollTop.current = viewport.scrollTop;

    const onMouseMove = (me: MouseEvent) => {
      if (!isDraggingVScroll.current) return;
      const vp = getXtermViewport();
      const scrollbar = vScrollBarRef.current;
      const thumb = vScrollThumbRef.current;
      if (!vp || !scrollbar || !thumb) return;
      const deltaY = me.clientY - vScrollDragStartY.current;
      const maxThumbTop = scrollbar.clientHeight - thumb.clientHeight;
      if (maxThumbTop <= 0) return;
      const scrollRange = vp.scrollHeight - vp.clientHeight;
      vp.scrollTop = Math.max(0, Math.min(scrollRange,
        vScrollDragStartScrollTop.current + (deltaY / maxThumbTop) * scrollRange,
      ));
      updateVScrollThumb();
    };

    const onMouseUp = () => {
      isDraggingVScroll.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [updateVScrollThumb]);

  const handleVScrollOverlayWheel = useCallback((e: React.WheelEvent) => {
    const viewport = getXtermViewport();
    if (!viewport) return;
    viewport.scrollTop += e.deltaY * 0.6;
    updateVScrollThumb();
  }, [updateVScrollThumb]);

  /** 统一将终端视口滚动到底部并保证光标所在行处于可视区（全屏备用缓冲区模式下跳过） */
  const scrollToBottomAndCursor = useCallback(() => {
    const term = termRef.current;
    if (!term || term.buffer.active.type === 'alternate') return;
    try {
      term.scrollToBottom();
      const vp = getXtermViewport();
      if (vp) {
        vp.scrollTop = vp.scrollHeight;
      }
      if (hostRef.current && !wordWrapRef.current && hostRef.current.scrollLeft > 0) {
        hostRef.current.scrollLeft = 0;
      }
      updateVScrollThumb();
    } catch {
      // ignore
    }
  }, [updateVScrollThumb]);



  /**
   * 扫描 xterm buffer，返回内容真实占用的最大列数（按单元格宽度计，CJK/emoji 记 2 列）。
   * 具体口径与边界说明见 utils/terminalWidth.ts。
   */
  const measureBufferWidth = (term: Terminal): number => {
    try {
      return measureContentColumns(term.buffer.active, term.cols);
    } catch {
      return maxLineLenRef.current;
    }
  };

  /** 上一次向 backend PTY 报告的列数与行数，防止尺寸相同时重复向 vim 发送 SIGWINCH */
  const lastResizedColsRef = useRef(0);
  const lastResizedRowsRef = useRef(0);

  const applyTerminalSize = (id: string) => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return;
    if (host.clientWidth < 100 || host.clientHeight < 40) return;

    try {
      const isWrap = wordWrapRef.current;
      const isAlternate = term.buffer.active.type === 'alternate';

      // 全屏终端程序（vim / nano / htop / less）使用备用缓冲区时，
      // 必须严格与物理视口宽高对齐铺满，绝不能缩减行数或展开超宽列，防止下方大片留白或光标错位
      if (isAlternate) {
        host.style.overflowX = 'hidden';
        if (term.element) {
          term.element.style.width = '100%';
          term.element.style.minWidth = '100%';
        }
        selfResizingRef.current = true;
        fit.fit();
        selfResizingRef.current = false;
        const cols = term.cols;
        const rows = term.rows;
        if (cols >= 20 && rows >= 3) {
          if (lastResizedColsRef.current !== cols || lastResizedRowsRef.current !== rows) {
            lastResizedColsRef.current = cols;
            lastResizedRowsRef.current = rows;
            void window.ide.resizeTerminal(id, cols, rows);
          }
        }
        term.refresh(0, Math.max(0, term.rows - 1));
        return;
      }

      if (isWrap) {
        host.style.overflowX = 'hidden';
        if (term.element) {
          term.element.style.width = '100%';
          term.element.style.minWidth = '100%';
        }
        selfResizingRef.current = true;
        fit.fit();
        selfResizingRef.current = false;
        term.refresh(0, Math.max(0, term.rows - 1));
        term.scrollToBottom();
        const cols = term.cols;
        const rows = term.rows;
        if (cols >= 20 && rows >= 3) {
          if (lastResizedColsRef.current !== cols || lastResizedRowsRef.current !== rows) {
            lastResizedColsRef.current = cols;
            lastResizedRowsRef.current = rows;
            void window.ide.resizeTerminal(id, cols, rows);
          }
        }
      } else {
        // 单行/不换行模式：列数 = max(视口宽度, 内容真实最宽行 + 1)，不预展开、不留固定余量。
        // 内容不超过视口时列数就是视口宽度，横向滚动区间为 0，只有出现超长行才按需扩容。
        const dims = fit.proposeDimensions();
        // 行数必须始终使用物理视口能容纳的真实行数，绝不能被 buffer.length 限制
        const rows = dims?.rows && dims.rows >= 3 ? dims.rows : term.rows || 24;
        const viewCols = dims?.cols && dims.cols >= 20 ? dims.cols : 80;
        const longest = measureBufferWidth(term);
        // 若当前处于首屏且无回滚历史（例如刚启动或执行了 clear 清屏），
        // 最长行完全取决于当前屏幕实际存在的内容，允许从历史高位回落到视口宽度；
        // 仅在已有滚动历史累积输出时，保持单调高水位，避免 Windows ConPTY 等在输出短行时发生宽度振荡跳动。
        if (term.buffer.active.length <= term.rows && term.buffer.active.baseY === 0) {
          maxLineLenRef.current = longest;
        } else {
          maxLineLenRef.current = Math.max(maxLineLenRef.current, longest);
        }
        const wideCols = Math.min(4000, Math.max(80, viewCols, maxLineLenRef.current + 1));

        const isOverflow = wideCols > viewCols;
        host.style.overflowX = isOverflow ? 'auto' : 'hidden';
        if (!isOverflow && host.scrollLeft > 0) {
          host.scrollLeft = 0;
        }

        if (wideCols !== term.cols || rows !== term.rows) {
          lastWideColsRef.current = wideCols;
          selfResizingRef.current = true;
          term.resize(wideCols, rows);
          selfResizingRef.current = false;
          if (lastResizedColsRef.current !== wideCols || lastResizedRowsRef.current !== rows) {
            lastResizedColsRef.current = wideCols;
            lastResizedRowsRef.current = rows;
            void window.ide.resizeTerminal(id, wideCols, rows);
          }
        }
        if (term.element) {
          term.element.style.width = isOverflow ? 'max-content' : '100%';
          term.element.style.minWidth = '100%';
        }
        term.refresh(0, Math.max(0, term.rows - 1));
      }

      // 无论是换行还是不换行模式，均确保尺寸调整后将视口准确对齐到最底端及当前光标行
      scrollToBottomAndCursor();
    } catch (e) {
      // ignore
    }
  };

  /** 内容变化后的列数对齐：去抖后按真实最宽行重算，宽度只随内容伸缩，不再单调变窄。 */
  const scheduleColumnFit = (id: string) => {
    if (termRef.current?.buffer.active.type === 'alternate') return;
    if (colFitTimerRef.current) clearTimeout(colFitTimerRef.current);
    colFitTimerRef.current = setTimeout(() => {
      colFitTimerRef.current = null;
      applyTerminalSize(id);
    }, 150);
  };

  /** 终端自身的尺寸变化（外部 resize 或 xterm 内部重排）也要重新对齐列数。 */
  const scheduleColumnFitRef = useRef<(id: string) => void>(() => {});
  scheduleColumnFitRef.current = scheduleColumnFit;
  /** 正在由本组件主动 resize 时置位，避免 onResize 回调自触发。 */
  const selfResizingRef = useRef(false);

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    let unreg: (() => void) | undefined = undefined;
    let unregRaw: (() => void) | undefined = undefined;
    let unregExtract: (() => void) | undefined = undefined;
    let unregFocus: (() => void) | undefined = undefined;
    // 初始列数固定 80：两种模式都会在挂载后由 applyTerminalSize 校准到视口宽度，
    // 不换行模式不再预展开超宽列，避免刚打开就出现巨大的横向滚动区间。
    const initialCols = 80;
    // 新建会话意味着终端内容重新开始，最长行统计与已应用的列数随之清零，
    // 否则上一个会话的长行会把新终端的列数一起撑宽。
    maxLineLenRef.current = 0;
    lastWideColsRef.current = 0;
    lastResizedColsRef.current = 0;
    lastResizedRowsRef.current = 0;
    const term = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: '"Cascadia Code", Consolas, "Microsoft YaHei Mono", "Microsoft YaHei", monospace',
      theme: terminalTheme(uiTheme),
      cols: initialCols,
      rows: 24,
      scrollback: scrollback ?? 10000,
      smoothScrollDuration: 0,
      scrollSensitivity: 0.6,
      fastScrollSensitivity: 4,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    const searchAddon = new SearchAddon({ highlightLimit: 1000 });
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;

    const searchChangeDisposable = searchAddon.onDidChangeResults((e: { resultIndex: number; resultCount: number }) => {
      setSearchResultIndex(e.resultIndex);
      setSearchResultCount(e.resultCount);
    });

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;

      // 终端面板展开/折叠快捷键（Cmd+J, Alt+F12, Ctrl+`）
      if (
        (ctrl && (e.key.toLowerCase() === 'j' || e.code === 'KeyJ')) ||
        (e.altKey && e.key === 'F12') ||
        (ctrl && (e.key === '`' || e.key === '~'))
      ) {
        if (e.type === 'keydown') {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('echoly:toggleTerminal'));
        }
        return false;
      }

      // AI 对话窗口展开/折叠快捷键（Cmd+B / Ctrl+B）
      if (ctrl && (e.key.toLowerCase() === 'b' || e.code === 'KeyB')) {
        if (e.type === 'keydown') {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('echoly:toggleAi'));
        }
        return false;
      }

      // AI 对话提问/聚焦快捷键（Cmd+L / Ctrl+L：始终打开并聚焦）
      if (ctrl && (e.key.toLowerCase() === 'l' || e.code === 'KeyL')) {
        if (e.type === 'keydown') {
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('echoly:focusAi'));
        }
        return false;
      }

      // 允许其它全局快捷键穿透终端（Cmd+P 等）
      if (ctrl && (e.key.toLowerCase() === 'p' || e.code === 'KeyP')) {
        return false;
      }

      // AI 生成并执行命令快捷键（Cmd+K / Ctrl+K）
      if (ctrl && (e.key.toLowerCase() === 'k' || e.code === 'KeyK') && !e.shiftKey && !e.altKey) {
        if (e.type === 'keydown') {
          e.preventDefault();
          e.stopPropagation();
          onTriggerAiK?.();
        }
        return false;
      }

      if (ctrl && e.key.toLowerCase() === 'f' && !e.shiftKey && e.type === 'keydown') {
        e.preventDefault();
        e.stopPropagation();
        onOpenSearch?.();
        return false;
      }
      return true;
    });

    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    idRef.current = null;

    let sessionId: string | null = null;
    let outputBuffer = '';
    let writeParsedDisposable: { dispose: () => void } | null = null;
    let initialCmdSent = false;
    let initialCmdTimer: ReturnType<typeof setTimeout> | null = null;

    const dispatchInitialCommand = () => {
      if (initialCmdSent || disposed) return;
      const targetId = sessionId ?? idRef.current;
      if (!targetId || !initialCommand?.trim()) return;
      initialCmdSent = true;
      if (initialCmdTimer) {
        clearTimeout(initialCmdTimer);
        initialCmdTimer = null;
      }
      void window.ide.writeTerminal(targetId, wrapCommand(initialCommand) + '\r\n');
    };

    const unsubData = window.ide.onTerminalData(({ id, data }) => {
      if ((sessionId ?? idRef.current) === id) {
        // 过滤掉内部哨兵信号行，避免在终端视口中向用户显示冗余内部标记
        const cleanData = data.replace(/(?:\r?\n|^)__ECHOLY_FIN__:\d+(?:\r?\n|$)/g, '\r\n');

        // 终端全屏交互程序（vim / nano / htop / less / man 等）或大数据倾泻保护：
        // 1. 若当前终端处于备用缓冲区（term.buffer.active.type === 'alternate'）；
        // 2. 或当前批次数据包含进入/退出备用缓冲区的转义码（\x1b[?1049, \x1b[?47 等）；
        // 3. 或当前单包数据超过 2KB；
        // 坚决直接原样写入 term.write，绝不进行日志背景色正则替换！
        // 彻底杜绝破坏 vim TUI 语法高亮与光标控制符，并消除长文本正则灾难性回溯卡死。
        const isAlternate = term.buffer.active.type === 'alternate';
        const isTuiOrLarge =
          isAlternate ||
          cleanData.length > 2048 ||
          cleanData.includes('\x1b[?1049') ||
          cleanData.includes('\x1b[?47') ||
          cleanData.includes('\x1b[?1047');

        term.write(isTuiOrLarge ? cleanData : colorizeTerminalLogs(cleanData));

        // 捕获终端清屏信号（用户执行 clear 命令或按快捷键 Ctrl+L 触发的清屏控制码）
        // 包含 \x1b[2J (清屏), \x1b[3J (清除滚动历史), \x1bc (重置终端)
        const isClearSignal =
          cleanData.includes('\x1b[2J') ||
          cleanData.includes('\x1b[3J') ||
          cleanData.includes('\x1bc');

        if (isClearSignal) {
          maxLineLenRef.current = 0;
          if (hostRef.current) {
            hostRef.current.scrollLeft = 0;
          }
          const targetId = sessionId ?? idRef.current;
          if (targetId) {
            scheduleColumnFit(targetId);
          }
        }

        // 若有 initialCommand 尚未发送：等待终端 Shell 真正就绪并输出 Prompt 提示符后再写入，
        // 彻底杜绝在 Shell 启动完成前由操作系统底层 PTY 提前回显导致的「第一行是孤立纯命令，第二行才是终端提示符与命令」
        if (!initialCmdSent && initialCommand?.trim()) {
          // 检测常见的终端 Shell 提示符特征：
          // 1. \x1b[?2004h: Bracketed Paste 模式开启（现代 zsh / bash 提示符就绪的标准特征）
          // 2. 包含 % 、 $ 、 # 或 > 并且位于提示符末尾
          const isPromptReady =
            data.includes('\x1b[?2004h') ||
            /[$%#>]\s*(?:\x1b\[[0-9;]*[a-zA-Z])?$/.test(data) ||
            /(?:%|\$|#|>)\s*$/.test(data.trimEnd());

          if (isPromptReady) {
            if (initialCmdTimer) clearTimeout(initialCmdTimer);
            initialCmdTimer = setTimeout(() => {
              dispatchInitialCommand();
            }, 60);
          } else if (!initialCmdTimer) {
            // 收到首批输出但暂未精确匹配特征，缓冲 150ms 确保 prompt 完成输出
            initialCmdTimer = setTimeout(() => {
              dispatchInitialCommand();
            }, 150);
          }
        }

        if (data.includes('No module named debugpy')) {
          term.writeln('\r\n\x1b[1;33m⚠️  [Echoly 调试诊断] 当前 Python 环境未安装 debugpy 调试模块。\x1b[0m');
          term.writeln('\x1b[36m💡 提示: 请在下方终端执行命令安装依赖后重试: pip3 install debugpy (或 python3 -m pip install debugpy)\x1b[0m\r\n');
          window.dispatchEvent(
            new CustomEvent('echoly:debugError', {
              detail: {
                language: 'python',
                message: '当前 Python 环境缺少 debugpy 模块。请在终端执行: pip3 install debugpy',
              },
            }),
          );
        }

        outputBuffer = (outputBuffer + data).slice(-300);
        // 严格匹配实际执行后由 printf 真实输出的数字退出码，绝不在 shell 输入回显阶段提前触发
        const match = outputBuffer.match(/(?:\r?\n|^)__ECHOLY_FIN__:(\d+)(?:\r?\n|$)/);
        if (match) {
          const exitCode = parseInt(match[1], 10);
          outputBuffer = '';
          window.dispatchEvent(
            new CustomEvent('echoly:runFinished', {
              detail: { terminalId: id, exitCode },
            }),
          );
        }
      }
    });
    const unsubExit = window.ide.onTerminalExit(({ id, exitCode }) => {
      if ((sessionId ?? idRef.current) === id) {
        term.writeln(`\r\n[process exited ${exitCode}]`);
        window.dispatchEvent(
          new CustomEvent('echoly:runFinished', {
            detail: { terminalId: id, exitCode: exitCode ?? 0 },
          }),
        );
      }
    });

    // 不换行模式：每帧内容解析完成后按 buffer 真实最宽行对齐列数（去抖）。
    // 单行日志不会被折行，横向滚动条长度也始终与屏幕上真正显示的字符数一致。
    writeParsedDisposable = term.onWriteParsed(() => {
      if (term.buffer.active.type === 'alternate') return;
      if (!wordWrapRef.current && idRef.current) {
        scheduleColumnFit(idRef.current);
      }
    });

    // 终端尺寸/列数被外部改写（xterm 内部重排、窗口或面板变化等）时重新对齐列数，
    // 避免列数被单向改小后再也回不去。自身发起的 resize 通过 selfResizingRef 排除，
    // 防止 resize → 重排 → 再 resize 的循环。
    const onResizeDisposable = term.onResize(() => {
      const id = idRef.current;
      if (!id || selfResizingRef.current || wordWrapRef.current) return;
      scheduleColumnFit(id);
    });

    // 监听缓冲区切换（例如进入或退出 vim / nano / less 等全屏交互程序）
    // 切换时立即以对应模式（全屏/日志）对齐尺寸，避免视口留白或尺寸错位
    const bufferChangeDisposable = term.buffer.onBufferChange(() => {
      const id = idRef.current;
      if (id) {
        applyTerminalSize(id);
      }
    });

    const initDims = fit.proposeDimensions();
    const startCols = initDims?.cols && initDims.cols >= 20 ? initDims.cols : initialCols;
    const startRows = initDims?.rows && initDims.rows >= 3 ? initDims.rows : 24;

    void window.ide.createTerminal({ kind: terminalKind, cwd, cols: startCols, rows: startRows }).then((res) => {
      if (disposed) return;
      const { id } = res;
      if (!id) {
        term.write('\r\n\x1b[31mFailed to launch terminal process.\x1b[0m\r\n');
        return;
      }
      sessionId = id;
      idRef.current = id;

      const sendCmd = (cmd: string) => {
        if (idRef.current) {
          void window.ide.writeTerminal(idRef.current, wrapCommand(cmd) + '\r\n');
        }
      };
      unreg = onRegisterSession?.(clientId, sendCmd);

      const sendRaw = (raw: string) => {
        if (idRef.current) {
          void window.ide.writeTerminal(idRef.current, raw);
        }
      };
      unregRaw = onRegisterRawSession?.(clientId, sendRaw);

      const getRecentLines = (lines = 50): string => {
        const term = termRef.current;
        if (!term) return '';
        const sel = term.getSelection();
        if (sel && sel.trim().length > 0) return sel;
        const buffer = term.buffer.active;
        const total = buffer.length;
        const start = Math.max(0, total - lines);
        const result: string[] = [];
        for (let i = start; i < total; i++) {
          const line = buffer.getLine(i);
          if (line) {
            result.push(line.translateToString(true));
          }
        }
        return result.join('\n').trim();
      };
      unregExtract = onRegisterExtractLog?.(clientId, getRecentLines);

      const focusTerm = () => {
        termRef.current?.focus();
      };
      unregFocus = onRegisterFocus?.(clientId, focusTerm);

      // 设置兜底定时器（1500ms）：若 Shell 极端静默未触发输出数据，确保命令仍正常发出
      if (initialCommand?.trim() && !initialCmdSent && !initialCmdTimer) {
        initialCmdTimer = setTimeout(() => {
          dispatchInitialCommand();
        }, 1500);
      }

      term.onData((data) => {
        // 使用 node-pty 后，shell 会自行回显输入（PTY 原生 echo）并处理退格/光标
        void window.ide.writeTerminal(id, data);
      });

      const resizeObserver: ResizeObserver | null = new ResizeObserver(() => {
        if (activeRef.current && visibleRef.current && idRef.current) {
          applyTerminalSize(idRef.current);
          scrollToBottomAndCursor();
          requestAnimationFrame(() => scrollToBottomAndCursor());
          setTimeout(() => scrollToBottomAndCursor(), 40);
          setTimeout(() => scrollToBottomAndCursor(), 120);
        }
      });
      if (hostRef.current) {
        resizeObserver.observe(hostRef.current);
      }

      // Perform multiple staged fit retries to ensure initial layout settlement
      applyTerminalSize(id);
      scrollToBottomAndCursor();
      requestAnimationFrame(() => {
        applyTerminalSize(id);
        scrollToBottomAndCursor();
      });
      const t1 = setTimeout(() => {
        applyTerminalSize(id);
        scrollToBottomAndCursor();
      }, 50);
      const t2 = setTimeout(() => {
        applyTerminalSize(id);
        scrollToBottomAndCursor();
      }, 150);
      const t3 = setTimeout(() => {
        applyTerminalSize(id);
        scrollToBottomAndCursor();
      }, 400);

      observerRef.current = resizeObserver;
    });

    return () => {
      disposed = true;
      if (initialCmdTimer) {
        clearTimeout(initialCmdTimer);
        initialCmdTimer = null;
      }
      unreg?.();
      unregRaw?.();
      unregExtract?.();
      unregFocus?.();
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      unsubData();
      unsubExit();
      searchChangeDisposable.dispose();
      searchAddon.dispose();
      searchAddonRef.current = null;
      writeParsedDisposable?.dispose();
      writeParsedDisposable = null;
      onResizeDisposable.dispose();
      bufferChangeDisposable.dispose();
      if (colFitTimerRef.current) {
        clearTimeout(colFitTimerRef.current);
        colFitTimerRef.current = null;
      }
      if (idRef.current) void window.ide.disposeTerminal(idRef.current);
      idRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // Session is recreated when terminalKind / cwd changes or this tab remounts.
  }, [terminalKind, cwd]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = terminalTheme(uiTheme);
    }
  }, [uiTheme]);

  // 当换行状态动态变化时，立即重算尺寸与重排终端文字
  useEffect(() => {
    // 从换行模式切回单行模式时，已折行的长行需要重新展开：
    // applyTerminalSize 会扫描 buffer 求出真实最宽行（折行行数是列数的整数倍，因此结果就是原行长），
    // 再据此一次性把列数撑到位。
    if (idRef.current) {
      applyTerminalSize(idRef.current);
    }
  }, [wordWrap]);

  // 同步 xterm-viewport 滚动事件到自定义滚动条（只在 no-wrap 模式下激活）
  useEffect(() => {
    if (wordWrap) return;
    let viewport: HTMLElement | null = null;
    const handler = () => updateVScrollThumb();

    const bind = () => {
      viewport = getXtermViewport();
      if (viewport) {
        viewport.addEventListener('scroll', handler);
        updateVScrollThumb();
      }
    };

    const t1 = setTimeout(bind, 300);
    const t2 = setTimeout(updateVScrollThumb, 600);
    const t3 = setTimeout(updateVScrollThumb, 1200);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      viewport?.removeEventListener('scroll', handler);
    };
  }, [wordWrap, updateVScrollThumb]);

  // 当终端缓存上限配置发生变化时，实时同步更新 xterm.js 缓冲区配置
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.scrollback = scrollback ?? 10000;
    }
  }, [scrollback]);

  useEffect(() => {
    const handleClear = (e: Event) => {
      const detail = (e as CustomEvent<{ clientId: string }>).detail;
      if (detail?.clientId === clientId && termRef.current) {
        maxLineLenRef.current = 0;
        if (hostRef.current) {
          hostRef.current.scrollLeft = 0;
          hostRef.current.style.overflowX = 'hidden';
        }
        termRef.current.clear();
        termRef.current.write('\x1b[2J\x1b[3J\x1b[H');
        const id = idRef.current;
        if (id) {
          applyTerminalSize(id);
          requestAnimationFrame(() => applyTerminalSize(id));
          setTimeout(() => applyTerminalSize(id), 60);
        }
      }
    };
    const handleTop = (e: Event) => {
      const detail = (e as CustomEvent<{ clientId: string }>).detail;
      if (detail?.clientId === clientId && termRef.current) {
        termRef.current.scrollToTop();
      }
    };
    const handleBottom = (e: Event) => {
      const detail = (e as CustomEvent<{ clientId?: string }>).detail;
      if ((!detail?.clientId || detail?.clientId === clientId) && termRef.current) {
        scrollToBottomAndCursor();
      }
    };
    window.addEventListener('echoly:clearTerminalInstance', handleClear);
    window.addEventListener('echoly:scrollTerminalTop', handleTop);
    window.addEventListener('echoly:scrollTerminalBottom', handleBottom);
    return () => {
      window.removeEventListener('echoly:clearTerminalInstance', handleClear);
      window.removeEventListener('echoly:scrollTerminalTop', handleTop);
      window.removeEventListener('echoly:scrollTerminalBottom', handleBottom);
    };
  }, [clientId]);

  useEffect(() => {
    if (!active || !visible) return;
    const doResize = () => {
      const id = idRef.current;
      if (id) {
        applyTerminalSize(id);
      }
      scrollToBottomAndCursor();
    };

    doResize();
    const timer1 = setTimeout(doResize, 40);
    const timer2 = setTimeout(doResize, 120);
    const timer3 = setTimeout(doResize, 300);
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
    };
  }, [active, visible, wordWrap, maximized, scrollToBottomAndCursor]);

  // 最大化/还原面板高度变化时，自动将焦点保持在当前活跃终端并定位光标
  useEffect(() => {
    if (!active || !visible) return;
    if (termRef.current) {
      try {
        termRef.current.focus();
        scrollToBottomAndCursor();
      } catch {
        // ignore
      }
    }
  }, [maximized, active, visible, scrollToBottomAndCursor]);

  // 稳健执行搜索逻辑，内置正则合法性校验与双模式容错保护
  const performSearch = useCallback(
    (forward: boolean, incremental: boolean = false) => {
      const addon = searchAddonRef.current;
      if (!addon) return;
      if (!searchQuery) {
        try {
          addon.clearDecorations();
        } catch {
          // ignore
        }
        setSearchResultIndex(-1);
        setSearchResultCount(0);
        return;
      }

      // 如果启用了正则模式，先校验语法合法性，避免输入如 `(` 或 `[` 导致内部语法异常抛出
      if (searchRegex) {
        try {
          new RegExp(searchQuery);
        } catch {
          setSearchResultIndex(-1);
          setSearchResultCount(0);
          return;
        }
      }

      // 优先带装饰项高亮搜索（要求标准 7 位 #RRGGBB 颜色编码）
      try {
        const searchOpts = {
          caseSensitive: searchCaseSensitive,
          wholeWord: searchWholeWord,
          regex: searchRegex,
          incremental,
          decorations: {
            matchBackground: '#3b82f6',
            matchBorder: '#60a5fa',
            matchOverviewRuler: '#3b82f6',
            activeMatchBackground: '#f59e0b',
            activeMatchBorder: '#fbbf24',
            activeMatchColorOverviewRuler: '#f59e0b',
          },
        };
        if (forward) {
          addon.findNext(searchQuery, searchOpts);
        } else {
          addon.findPrevious(searchQuery, searchOpts);
        }
      } catch (err) {
        // 若由于终端未完全 mount 或特定环境导致 decorations 失败，降级为原生选区模式继续正常检索
        try {
          const fallbackOpts = {
            caseSensitive: searchCaseSensitive,
            wholeWord: searchWholeWord,
            regex: searchRegex,
            incremental,
          };
          if (forward) {
            addon.findNext(searchQuery, fallbackOpts);
          } else {
            addon.findPrevious(searchQuery, fallbackOpts);
          }
        } catch (err2) {
          console.warn('Terminal search error:', err, err2);
        }
      }
    },
    [searchQuery, searchCaseSensitive, searchWholeWord, searchRegex],
  );

  // 搜索关键词或选项变动时执行检索与高亮
  useEffect(() => {
    if (!searchOpen) {
      try {
        searchAddonRef.current?.clearDecorations();
      } catch {
        // ignore
      }
      setSearchResultIndex(-1);
      setSearchResultCount(0);
      return;
    }
    performSearch(true, true);
  }, [searchOpen, searchQuery, searchCaseSensitive, searchWholeWord, searchRegex, performSearch]);

  const handleFindNext = () => {
    performSearch(true, false);
  };

  const handleFindPrevious = () => {
    performSearch(false, false);
  };

  const handleCloseSearch = () => {
    try {
      searchAddonRef.current?.clearDecorations();
    } catch {
      // ignore
    }
    onCloseSearch?.();
    termRef.current?.focus();
  };

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const handleOutside = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    window.addEventListener('mousedown', handleOutside);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('keydown', handleKey);
    };
  }, [ctxMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const sel = termRef.current?.getSelection();
    // 点击右键时将菜单边界限制在视口内
    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 160);
    setCtxMenu({ x, y });
  };

  const handleCopy = () => {
    const sel = termRef.current?.getSelection();
    if (sel) {
      void navigator.clipboard.writeText(sel);
    }
    setCtxMenu(null);
    termRef.current?.focus();
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const id = idRef.current;
      if (text && id) {
        void window.ide.writeTerminal(id, text);
      }
    } catch {
      // ignore
    }
    setCtxMenu(null);
    termRef.current?.focus();
  };

  const handleSelectAll = () => {
    termRef.current?.selectAll();
    setCtxMenu(null);
    termRef.current?.focus();
  };

  const handleClearFromMenu = () => {
    maxLineLenRef.current = 0;
    if (hostRef.current) {
      hostRef.current.scrollLeft = 0;
      hostRef.current.style.overflowX = 'hidden';
    }
    termRef.current?.clear();
    termRef.current?.write('\x1b[2J\x1b[3J\x1b[H');
    const id = idRef.current;
    if (id) {
      applyTerminalSize(id);
      setTimeout(() => applyTerminalSize(id), 60);
    }
    setCtxMenu(null);
    termRef.current?.focus();
  };

  const hasSelection = Boolean(termRef.current?.hasSelection());
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

  return (
    <div
      className={`terminal-session${active ? ' active' : ''}${!wordWrap ? ' no-wrap' : ''}`}
      aria-hidden={!active}
      onMouseDown={() => {
        if (active) termRef.current?.focus();
      }}
    >
      <div
        className={`terminal-host${!wordWrap ? ' no-wrap' : ''}`}
        ref={hostRef}
        onContextMenu={handleContextMenu}
      />
      {/* 终端右键上下文菜单 */}
      {ctxMenu && (
        <div
          className="ctx-menu"
          ref={ctxMenuRef}
          role="menu"
          style={{ position: 'fixed', top: ctxMenu.y, left: ctxMenu.x, zIndex: 10000, minWidth: 170 }}
        >
          <button
            type="button"
            className="ctx-item"
            onClick={handleCopy}
            disabled={!hasSelection}
            style={{ opacity: hasSelection ? 1 : 0.45, cursor: hasSelection ? 'pointer' : 'default' }}
          >
            <span>复制</span>
            <kbd className="shortcut-badge" style={{ fontSize: 11, opacity: 0.7 }}>{isMac ? '⌘C' : 'Ctrl+Shift+C'}</kbd>
          </button>
          <button type="button" className="ctx-item" onClick={() => void handlePaste()}>
            <span>粘贴</span>
            <kbd className="shortcut-badge" style={{ fontSize: 11, opacity: 0.7 }}>{isMac ? '⌘V' : 'Ctrl+Shift+V'}</kbd>
          </button>
          <div className="ctx-sep" />
          <button type="button" className="ctx-item" onClick={handleSelectAll}>
            <span>全选</span>
            <kbd className="shortcut-badge" style={{ fontSize: 11, opacity: 0.7 }}>{isMac ? '⌘A' : 'Ctrl+A'}</kbd>
          </button>
          <button type="button" className="ctx-item" onClick={handleClearFromMenu}>
            <span>清空屏幕 (Clear)</span>
            <kbd className="shortcut-badge" style={{ fontSize: 11, opacity: 0.7 }}>{isMac ? '⌘K' : 'Ctrl+L'}</kbd>
          </button>
        </div>
      )}
      {/* 终端浮动搜索栏 */}
      {active && searchOpen && (
        <TerminalSearchBar
          query={searchQuery}
          onQueryChange={setSearchQuery}
          caseSensitive={searchCaseSensitive}
          onToggleCaseSensitive={() => setSearchCaseSensitive((v) => !v)}
          wholeWord={searchWholeWord}
          onToggleWholeWord={() => setSearchWholeWord((v) => !v)}
          regex={searchRegex}
          onToggleRegex={() => setSearchRegex((v) => !v)}
          resultIndex={searchResultIndex}
          resultCount={searchResultCount}
          onFindNext={handleFindNext}
          onFindPrevious={handleFindPrevious}
          onClose={handleCloseSearch}
          focusNonce={searchFocusNonce}
        />
      )}
      {/* no-wrap 模式下：自定义纵向滚动条，固定在 host 可视區右侧，避免原生滑动条随内容宽度跑到右边看不到 */}
      {!wordWrap && (
        <div
          className="terminal-vscroll-overlay"
          ref={vScrollBarRef}
          onClick={handleVScrollTrackClick}
          onWheel={handleVScrollOverlayWheel}
        >
          <div
            className="terminal-vscroll-thumb"
            ref={vScrollThumbRef}
            onMouseDown={handleVScrollThumbMouseDown}
          />
        </div>
      )}
    </div>
  );
}

export function TerminalPanel({
  terminalKind,
  uiTheme,
  openRequest,
  visible = true,
  scrollback,
  maximized,
  onCollapse,
}: Props) {
  const seqRef = useRef(1);
  const bootRef = useRef<TermTab | null>(null);
  if (!bootRef.current) bootRef.current = makeTab(1);

  const [tabs, setTabs] = useState<TermTab[]>([bootRef.current]);
  const [activeId, setActiveId] = useState(bootRef.current.clientId);
  const lastNonce = useRef(0);
  const sessionSendCmdRef = useRef<Map<string, (cmd: string) => void>>(new Map());
  const sessionSendRawRef = useRef<Map<string, (raw: string) => void>>(new Map());

  // 终端自动换行 (Word Wrap) 状态与持久化配置
  const [wordWrap, setWordWrap] = useState<boolean>(() => {
    try {
      return localStorage.getItem('echoly.terminal.wordWrap') !== 'false';
    } catch {
      return true;
    }
  });

  // 终端搜索栏显隐状态与聚焦触发计数器
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchFocusNonce, setSearchFocusNonce] = useState(0);

  const handleOpenSearch = useCallback(() => {
    setIsSearchOpen(true);
    setSearchFocusNonce((n) => n + 1);
  }, []);

  // 监听全局聚焦终端搜索指令 (如 App 层发出的 Cmd+F)
  useEffect(() => {
    const onGlobalFocus = () => {
      handleOpenSearch();
    };
    window.addEventListener('echoly:focusTerminalSearch', onGlobalFocus);
    return () => window.removeEventListener('echoly:focusTerminalSearch', onGlobalFocus);
  }, [handleOpenSearch]);

  // 终端 AI 命令生成浮条 (Cmd+K)
  const [showAiK, setShowAiK] = useState(false);
  const sessionFocusRef = useRef<Map<string, () => void>>(new Map());

  const handleRegisterFocus = useCallback(
    (clientId: string, focusFn: () => void) => {
      sessionFocusRef.current.set(clientId, focusFn);
      return () => {
        sessionFocusRef.current.delete(clientId);
      };
    },
    [],
  );

  const focusActiveTerminal = useCallback(() => {
    // 延迟一帧，确保 AI 浮条关闭后焦点准确转移到 xterm 实例并唤醒光标
    requestAnimationFrame(() => {
      const focusFn = sessionFocusRef.current.get(activeId);
      focusFn?.();
    });
  }, [activeId]);

  const handleAiKExecute = useCallback((command: string) => {
    if (!activeId) return;
    const sendCmd = sessionSendCmdRef.current.get(activeId);
    if (sendCmd) {
      sendCmd(command);
    } else {
      void window.ide.writeTerminal(activeId, command + '\r\n');
    }
    focusActiveTerminal();
  }, [activeId, focusActiveTerminal]);

  const handleAiKInsert = useCallback((command: string) => {
    if (!activeId) return;
    const sendRaw = sessionSendRawRef.current.get(activeId);
    if (sendRaw) {
      sendRaw(command);
    } else {
      void window.ide.writeTerminal(activeId, command);
    }
    focusActiveTerminal();
  }, [activeId, focusActiveTerminal]);

  const toggleWordWrap = useCallback(() => {
    setWordWrap((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('echoly.terminal.wordWrap', String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const handleRegisterSession = useCallback(
    (clientId: string, sendCmd: (cmd: string) => void) => {
      sessionSendCmdRef.current.set(clientId, sendCmd);
      return () => {
        sessionSendCmdRef.current.delete(clientId);
      };
    },
    [],
  );

  const handleRegisterRawSession = useCallback(
    (clientId: string, sendRaw: (raw: string) => void) => {
      sessionSendRawRef.current.set(clientId, sendRaw);
      return () => {
        sessionSendRawRef.current.delete(clientId);
      };
    },
    [],
  );

  const sessionExtractLogRef = useRef<Map<string, (lines?: number) => string>>(new Map());
  const handleRegisterExtractLog = useCallback(
    (clientId: string, getLog: (lines?: number) => string) => {
      sessionExtractLogRef.current.set(clientId, getLog);
      return () => {
        sessionExtractLogRef.current.delete(clientId);
      };
    },
    [],
  );

  // 跟踪各终端标签的最新错误状态 (exitCode !== 0)
  const [tabErrors, setTabErrors] = useState<Record<string, { exitCode: number; time: number }>>({});

  useEffect(() => {
    const handleRunFinished = (e: Event) => {
      const detail = (e as CustomEvent<{ terminalId: string; exitCode: number }>).detail;
      if (detail && detail.terminalId) {
        if (detail.exitCode !== 0) {
          setTabErrors((prev) => ({
            ...prev,
            [detail.terminalId]: { exitCode: detail.exitCode, time: Date.now() },
          }));
        } else {
          setTabErrors((prev) => {
            if (!prev[detail.terminalId]) return prev;
            const next = { ...prev };
            delete next[detail.terminalId];
            return next;
          });
        }
      }
    };
    window.addEventListener('echoly:runFinished', handleRunFinished);
    return () => window.removeEventListener('echoly:runFinished', handleRunFinished);
  }, []);

  const activeTab = tabs.find((t) => t.clientId === activeId) || null;
  const activeTabError = tabErrors[activeId];

  const handleDiagnoseActiveError = useCallback(() => {
    const extractFn = sessionExtractLogRef.current.get(activeId);
    const rawLog = extractFn?.(40) || '';
    const cleanLog = rawLog.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').trim();
    const exitCode = activeTabError?.exitCode ?? 1;
    const prompt = cleanLog
      ? `终端执行命令遇到错误（退出码 ${exitCode}），请帮我分析以下日志并给出修复方案：\n\`\`\`log\n${cleanLog}\n\`\`\``
      : `终端执行命令遇到错误（退出码 ${exitCode}），请帮我排查可能的原因与修复步骤。`;
    window.dispatchEvent(
      new CustomEvent('echoly:askAi', {
        detail: { prompt, autoSubmit: false },
      }),
    );
  }, [activeId, activeTabError]);

  const handleAskAiGeneral = useCallback(() => {
    const extractFn = sessionExtractLogRef.current.get(activeId);
    const rawLog = extractFn?.(40) || '';
    const cleanLog = rawLog.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').trim();
    const prompt = cleanLog
      ? `关于终端日志的分析需求：\n\`\`\`log\n${cleanLog}\n\`\`\`\n请帮我解释上述输出或给出下一步操作建议。`
      : `请帮我编写或解释终端相关的命令与操作。`;
    window.dispatchEvent(
      new CustomEvent('echoly:askAi', {
        detail: { prompt, autoSubmit: false },
      }),
    );
  }, [activeId]);

  // 监听全局停止命令事件，向对应的专属终端（如 Java 或 Maven）或当前活动终端发送 SIGINT (\x03)
  useEffect(() => {
    const handleStop = (e: Event) => {
      const detail = (e as CustomEvent<{ terminalType?: string }>).detail;
      const targetType = detail?.terminalType;
      let targetTab = targetType ? tabs.find((t) => t.terminalType === targetType) : null;
      if (!targetTab) {
        targetTab = tabs.find((t) => t.clientId === activeId) || tabs[0] || null;
      }
      if (targetTab) {
        const sendRaw = sessionSendRawRef.current.get(targetTab.clientId);
        if (sendRaw) {
          sendRaw('\x03'); // 发送 SIGINT 中断执行
        }
      }
    };
    window.addEventListener('echoly:stopTerminalCommand', handleStop);
    return () => window.removeEventListener('echoly:stopTerminalCommand', handleStop);
  }, [tabs, activeId]);

  const handleScrollToTop = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('echoly:scrollTerminalTop', {
        detail: { clientId: activeId },
      }),
    );
  }, [activeId]);

  const handleScrollToBottom = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('echoly:scrollTerminalBottom', {
        detail: { clientId: activeId },
      }),
    );
  }, [activeId]);

  const handleClearTerminal = useCallback(() => {
    const sendRaw = sessionSendRawRef.current.get(activeId);
    if (sendRaw) {
      const isWin =
        typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent);
      if (isWin) {
        sendRaw('cls\r\n');
      } else {
        // 在 Unix (macOS / Linux) 发送 \x0c (Ctrl+L)，通知 shell 重绘当前单行提示符到首行，不发送换行回车，彻底消除多余空行与双行提示符
        sendRaw('\x0c');
      }
    }
    window.dispatchEvent(
      new CustomEvent('echoly:clearTerminalInstance', {
        detail: { clientId: activeId },
      }),
    );
  }, [activeId]);

  const addTerminal = useCallback(
    (cwd?: string, initialCommand?: string, terminalType?: string, customTitle?: string) => {
      seqRef.current += 1;
      const tab = makeTab(seqRef.current, cwd, initialCommand, terminalType, customTitle);
      setTabs((prev) => [...prev, tab]);
      setActiveId(tab.clientId);
    },
    [],
  );

  useEffect(() => {
    if (!openRequest) return;
    if (openRequest.nonce === lastNonce.current) return;
    lastNonce.current = openRequest.nonce;

    const { terminalType, terminalTitle, cwd, initialCommand } = openRequest;

    // 如果指定了终端类型（例如 'mvn' 或 'java'），检查是否已有同类型终端
    if (terminalType) {
      const existing = tabs.find((t) => t.terminalType === terminalType);
      if (existing) {
        // 切换到已存在的专属终端，并在其中直接执行命令
        setActiveId(existing.clientId);
        if (initialCommand) {
          const send = sessionSendCmdRef.current.get(existing.clientId);
          if (send) {
            send(initialCommand);
          } else {
            setTimeout(() => {
              sessionSendCmdRef.current.get(existing.clientId)?.(initialCommand);
            }, 300);
          }
        }
        return;
      }
    }

    // 没有找到同类型已有终端，或未指定类型：新建一个专属或普通终端
    seqRef.current += 1;
    const tab = makeTab(
      seqRef.current,
      cwd,
      initialCommand,
      terminalType,
      terminalTitle || (terminalType === 'mvn' ? 'Maven' : terminalType === 'java' ? 'Java' : undefined),
    );
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.clientId);
  }, [openRequest, tabs]);

  const closeTerminal = useCallback((clientId: string) => {
    setTabs((prev) => {
      if (prev.length <= 1) {
        seqRef.current += 1;
        const fresh = makeTab(seqRef.current);
        setActiveId(fresh.clientId);
        return [fresh];
      }
      const next = prev.filter((t) => t.clientId !== clientId);
      setActiveId((current) => {
        if (current !== clientId) return current;
        const idx = prev.findIndex((t) => t.clientId === clientId);
        const fallback = next[Math.max(0, idx - 1)] ?? next[0];
        return fallback!.clientId;
      });
      return next;
    });
  }, []);

  const kindLabel = terminalKind === 'ssh' ? 'SSH 远程' : '本地';

  return (
    <div
      className="bottom-section terminal-panel"
      style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      onKeyDownCapture={(e) => {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
          e.preventDefault();
          e.stopPropagation();
          handleOpenSearch();
        }
      }}
    >
      <div className="terminal-toolbar">
        <div className="terminal-toolbar-left">
          <div className="terminal-brand">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="terminal-brand-icon"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span className="terminal-brand-text">终端</span>
          </div>

          <span className={`terminal-kind-pill ${terminalKind === 'ssh' ? 'ssh' : 'local'}`}>
            {terminalKind === 'ssh' && <span className="terminal-kind-dot" />}
            {kindLabel}
          </span>

          <span className="terminal-header-divider" />

          <div className="terminal-tabs" role="tablist">
            {tabs.map((tab) => {
              const active = tab.clientId === activeId;
              const label = tab.customTitle || tabLabel(terminalKind, tab.index);
              return (
                <button
                  key={tab.clientId}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`terminal-tab${active ? ' active' : ''}`}
                  onClick={() => setActiveId(tab.clientId)}
                >
                  {renderTabIcon(tab, terminalKind)}
                  <span className="terminal-tab-label">{label}</span>
                  <span
                    className="terminal-tab-close"
                    title="删除终端标签"
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminal(tab.clientId);
                    }}
                  >
                    <IconClose size={9} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="terminal-toolbar-right">
          {activeTabError && (
            <button
              type="button"
              className="terminal-ai-diagnose-btn"
              title={`终端命令执行失败 (退出码 ${activeTabError.exitCode})，点击向 AI 求助诊断错误`}
              onClick={handleDiagnoseActiveError}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
              <span>⚡️ AI 诊断报错</span>
            </button>
          )}
          <button
            type="button"
            className="panel-action-btn"
            title="向 AI 咨询终端输出 / 诊断 (Ask AI)"
            onClick={handleAskAiGeneral}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </button>
          <button
            type="button"
            className={`panel-action-btn${showAiK ? ' active' : ''}`}
            title="AI 生成并执行命令 (⌘K)"
            onClick={() => setShowAiK((v) => !v)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          </button>
          <button
            type="button"
            className="panel-action-btn"
            title="新建终端"
            onClick={() => addTerminal()}
          >
            <IconPlus size={16} />
          </button>
          <button
            type="button"
            className={`panel-action-btn${wordWrap ? ' active' : ''}`}
            title={
              wordWrap
                ? '自动换行: 已启用 (点击切换为单行横向滚动模式)'
                : '自动换行: 已禁用 (点击启用自适应视口换行)'
            }
            onClick={toggleWordWrap}
          >
            <IconWordWrap size={16} />
          </button>
          <button
            type="button"
            className={`panel-action-btn${isSearchOpen ? ' active' : ''}`}
            title="在终端中搜索 (Ctrl+F / ⌘F)"
            onClick={() => {
              if (isSearchOpen) {
                setSearchFocusNonce((n) => n + 1);
              } else {
                handleOpenSearch();
              }
            }}
          >
            <IconSearch size={16} />
          </button>
          <button
            type="button"
            className="panel-action-btn"
            title="滚动到最上方 (Scroll to Top)"
            onClick={handleScrollToTop}
          >
            <IconScrollToTop size={16} />
          </button>
          <button
            type="button"
            className="panel-action-btn"
            title="滚动到最下方 (Scroll to Bottom)"
            onClick={handleScrollToBottom}
          >
            <IconScrollToBottom size={16} />
          </button>
          <button
            type="button"
            className="panel-action-btn"
            title="清空终端内容 (Clear)"
            onClick={handleClearTerminal}
          >
            <IconClear size={16} />
          </button>
          <button
            type="button"
            className="panel-action-btn"
            title="删除当前终端标签 (Kill)"
            onClick={() => closeTerminal(activeId)}
          >
            <IconTrash size={16} />
          </button>
          {onCollapse && (
            <button
              type="button"
              className="panel-action-btn"
              onClick={onCollapse}
              title="折叠终端"
            >
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
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="terminal-sessions" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <TerminalAiKBar
          open={showAiK}
          onClose={() => {
            setShowAiK(false);
            focusActiveTerminal();
          }}
          activeClientId={activeId}
          cwd={activeTab?.cwd}
          uiTheme={uiTheme}
          onExecute={handleAiKExecute}
          onInsert={handleAiKInsert}
        />
        {tabs.map((tab) => (
          <TerminalSession
            key={tab.clientId}
            clientId={tab.clientId}
            active={tab.clientId === activeId}
            visible={visible}
            terminalKind={terminalKind}
            uiTheme={uiTheme}
            cwd={tab.cwd}
            initialCommand={tab.initialCommand}
            wordWrap={wordWrap}
            scrollback={scrollback}
            maximized={maximized}
            searchOpen={tab.clientId === activeId && isSearchOpen}
            searchFocusNonce={searchFocusNonce}
            onOpenSearch={handleOpenSearch}
            onCloseSearch={() => setIsSearchOpen(false)}
            onRegisterSession={handleRegisterSession}
            onRegisterRawSession={handleRegisterRawSession}
            onRegisterExtractLog={handleRegisterExtractLog}
            onRegisterFocus={handleRegisterFocus}
            onTriggerAiK={() => setShowAiK(true)}
          />
        ))}
      </div>
    </div>
  );
}

