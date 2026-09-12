import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { UiTheme } from '@deepseek-ide/shared';
import { uid } from '../utils';

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
    background: '#181818',
    foreground: '#e6e8ec',
    cursor: '#4c8dff',
    selectionBackground: 'rgba(76, 141, 255, 0.25)',
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

function IconPlus({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconClear({ size = 12 }: { size?: number }) {
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

function IconTrash({ size = 12 }: { size?: number }) {
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

function IconWordWrap({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
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

function IconScrollToTop({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="4" y1="4" x2="20" y2="4" />
      <polyline points="18 13 12 7 6 13" />
      <line x1="12" y1="7" x2="12" y2="20" />
    </svg>
  );
}

function IconScrollToBottom({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="4" x2="12" y2="17" />
      <polyline points="6 11 12 17 18 11" />
      <line x1="4" y1="20" x2="20" y2="20" />
    </svg>
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
  onRegisterSession?: (clientId: string, sendCmd: (cmd: string) => void) => () => void;
  onRegisterRawSession?: (clientId: string, sendRaw: (raw: string) => void) => () => void;
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
  onRegisterSession,
  onRegisterRawSession,
}: SessionProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const wordWrapRef = useRef(wordWrap);
  wordWrapRef.current = wordWrap;
  const maxLineLenRef = useRef<number>(0);
  const currentLineLenRef = useRef<number>(0);

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
    viewport.scrollTop += e.deltaY;
    updateVScrollThumb();
  }, [updateVScrollThumb]);


  const applyTerminalSize = (id: string) => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return;
    if (host.clientWidth < 100 || host.clientHeight < 40) return;

    try {
      const isWrap = wordWrapRef.current;
      if (isWrap) {
        host.style.overflowX = 'hidden';
        if (term.element) {
          term.element.style.width = '100%';
          term.element.style.minWidth = '100%';
        }
        fit.fit();
        term.refresh(0, Math.max(0, term.rows - 1));
        term.scrollToBottom();
        const cols = term.cols;
        const rows = term.rows;
        if (cols >= 20 && rows >= 3) {
          void window.ide.resizeTerminal(id, cols, rows);
        }
      } else {
        // 单行/不换行模式：展开超宽列（默认 20000 列，可根据超长日志动态扩至 60000 列）
        // 彻底杜绝长日志换行，实现“单行不管多长都一行显示”，并提供丝滑横向滚动
        const dims = fit.proposeDimensions();
        const rows = dims?.rows && dims.rows >= 3 ? dims.rows : term.rows || 24;
        const wideCols = Math.min(60000, Math.max(20000, maxLineLenRef.current + 500));

        host.style.overflowX = 'auto';
        term.resize(wideCols, rows);
        if (term.element) {
          term.element.style.width = 'max-content';
          term.element.style.minWidth = '100%';
        }
        term.refresh(0, Math.max(0, term.rows - 1));
        void window.ide.resizeTerminal(id, wideCols, rows);
      }
      if (activeRef.current) term.focus();
    } catch (e) {
      // ignore
    }
  };

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    let unreg: (() => void) | undefined = undefined;
    let unregRaw: (() => void) | undefined = undefined;
    const initialCols = wordWrapRef.current ? 80 : 20000;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: '"Cascadia Code", Consolas, "Microsoft YaHei Mono", "Microsoft YaHei", monospace',
      theme: terminalTheme(uiTheme),
      cols: initialCols,
      rows: 24,
      scrollback: scrollback ?? 10000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    idRef.current = null;

    let sessionId: string | null = null;
    let outputBuffer = '';
    const unsubData = window.ide.onTerminalData(({ id, data }) => {
      if ((sessionId ?? idRef.current) === id) {
        // 动态追踪最长单行长度，若单行超长（如上万字符的大日志），自动拓展终端列宽，确保单行模式下永不换行
        for (let i = 0; i < data.length; i++) {
          const ch = data[i];
          if (ch === '\n' || ch === '\r') {
            currentLineLenRef.current = 0;
          } else {
            currentLineLenRef.current++;
            if (currentLineLenRef.current > maxLineLenRef.current) {
              maxLineLenRef.current = currentLineLenRef.current;
            }
          }
        }

        if (!wordWrapRef.current && termRef.current && idRef.current) {
          const currentTermCols = termRef.current.cols;
          if (maxLineLenRef.current + 200 > currentTermCols && currentTermCols < 60000) {
            const newCols = Math.min(60000, Math.max(currentTermCols * 2, maxLineLenRef.current + 1000));
            termRef.current.resize(newCols, termRef.current.rows);
            void window.ide.resizeTerminal(idRef.current, newCols, termRef.current.rows);
          }
        }

        // 过滤掉内部哨兵信号行，避免在终端视口中向用户显示冗余内部标记
        const cleanData = data.replace(/(?:\r?\n|^)__ECHOLY_FIN__:\d+(?:\r?\n|$)/g, '\r\n');
        term.write(colorizeTerminalLogs(cleanData));

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

    void window.ide.createTerminal({ kind: terminalKind, cwd, cols: initialCols, rows: 24 }).then((res) => {
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

      if (initialCommand?.trim()) {
        setTimeout(() => {
          if (!disposed) {
            void window.ide.writeTerminal(id, wrapCommand(initialCommand) + '\r\n');
          }
        }, 400);
      }

      term.onData((data) => {
        // 使用 node-pty 后，shell 会自行回显输入（PTY 原生 echo）并处理退格/光标
        void window.ide.writeTerminal(id, data);
      });

      const resizeObserver: ResizeObserver | null = new ResizeObserver(() => {
        if (activeRef.current && visibleRef.current && idRef.current) {
          applyTerminalSize(idRef.current);
        }
      });
      if (hostRef.current) {
        resizeObserver.observe(hostRef.current);
      }

      // Perform multiple staged fit retries to ensure initial layout settlement
      applyTerminalSize(id);
      requestAnimationFrame(() => applyTerminalSize(id));
      const t1 = setTimeout(() => applyTerminalSize(id), 50);
      const t2 = setTimeout(() => applyTerminalSize(id), 150);
      const t3 = setTimeout(() => applyTerminalSize(id), 400);

      if (activeRef.current) term.focus();
      observerRef.current = resizeObserver;
    });

    return () => {
      disposed = true;
      unreg?.();
      unregRaw?.();
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      unsubData();
      unsubExit();
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
        termRef.current.clear();
        termRef.current.write('\x1b[2J\x1b[3J\x1b[H');
      }
    };
    const handleTop = (e: Event) => {
      const detail = (e as CustomEvent<{ clientId: string }>).detail;
      if (detail?.clientId === clientId && termRef.current) {
        termRef.current.scrollToTop();
      }
    };
    const handleBottom = (e: Event) => {
      const detail = (e as CustomEvent<{ clientId: string }>).detail;
      if (detail?.clientId === clientId && termRef.current) {
        termRef.current.scrollToBottom();
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
    };

    doResize();
    const timer1 = setTimeout(doResize, 50);
    const timer2 = setTimeout(doResize, 150);
    const timer3 = setTimeout(doResize, 400);
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
    };
  }, [active, visible, wordWrap]);

  return (
    <div
      className={`terminal-session${active ? ' active' : ''}${!wordWrap ? ' no-wrap' : ''}`}
      aria-hidden={!active}
      onMouseDown={() => {
        if (active) termRef.current?.focus();
      }}
    >
      <div className={`terminal-host${!wordWrap ? ' no-wrap' : ''}`} ref={hostRef} />
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

          <button
            type="button"
            className="terminal-add-btn"
            title="新建终端"
            onClick={() => addTerminal()}
          >
            <IconPlus size={12} />
          </button>
          <button
            type="button"
            className={`terminal-add-btn${wordWrap ? ' active' : ''}`}
            title={
              wordWrap
                ? '自动换行: 已启用 (点击切换为单行横向滚动模式)'
                : '自动换行: 已禁用 (点击启用自适应视口换行)'
            }
            onClick={toggleWordWrap}
            style={{ marginLeft: 3 }}
          >
            <IconWordWrap size={12} />
          </button>
          <button
            type="button"
            className="terminal-add-btn"
            title="滚动到最上方 (Scroll to Top)"
            onClick={handleScrollToTop}
            style={{ marginLeft: 3 }}
          >
            <IconScrollToTop size={12} />
          </button>
          <button
            type="button"
            className="terminal-add-btn"
            title="滚动到最下方 (Scroll to Bottom)"
            onClick={handleScrollToBottom}
            style={{ marginLeft: 3 }}
          >
            <IconScrollToBottom size={12} />
          </button>
          <button
            type="button"
            className="terminal-add-btn"
            title="清空终端内容 (Clear)"
            onClick={handleClearTerminal}
            style={{ marginLeft: 3 }}
          >
            <IconClear size={12} />
          </button>
          <button
            type="button"
            className="terminal-add-btn"
            title="删除当前终端标签 (Kill)"
            onClick={() => closeTerminal(activeId)}
            style={{ marginLeft: 3 }}
          >
            <IconTrash size={12} />
          </button>
        </div>

        <div className="terminal-toolbar-right">
          {onCollapse && (
            <button
              type="button"
              className="terminal-action-btn terminal-collapse-btn"
              onClick={onCollapse}
              title="折叠终端"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
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
            onRegisterSession={handleRegisterSession}
            onRegisterRawSession={handleRegisterRawSession}
          />
        ))}
      </div>
    </div>
  );
}
