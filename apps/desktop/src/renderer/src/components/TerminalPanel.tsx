import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { UiTheme } from '@deepseek-ide/shared';
import { uid } from '../utils';

interface Props {
  terminalKind: 'local' | 'ssh';
  uiTheme: UiTheme;
  /** When nonce changes, open a new terminal tab with the given cwd and optional initial command. */
  openRequest?: { cwd: string; nonce: number; initialCommand?: string } | null;
  visible?: boolean;
  onCollapse?: () => void;
}

interface TermTab {
  clientId: string;
  index: number;
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

function makeTab(index: number, cwd?: string, initialCommand?: string): TermTab {
  return { clientId: uid(), index, cwd, initialCommand };
}

function tabLabel(kind: 'local' | 'ssh', index: number): string {
  return kind === 'ssh' ? `SSH ${index}` : `本地 ${index}`;
}

interface SessionProps {
  active: boolean;
  visible?: boolean;
  terminalKind: 'local' | 'ssh';
  uiTheme: UiTheme;
  cwd?: string;
  initialCommand?: string;
}

function TerminalSession({
  active,
  visible = true,
  terminalKind,
  uiTheme,
  cwd,
  initialCommand,
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

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: '"Cascadia Code", Consolas, "Microsoft YaHei Mono", "Microsoft YaHei", monospace',
      theme: terminalTheme(uiTheme),
      cols: 80,
      rows: 24,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    idRef.current = null;

    const syncSize = (id: string) => {
      if (!termRef.current || !fitRef.current || !hostRef.current) return;
      if (hostRef.current.clientWidth < 200 || hostRef.current.clientHeight < 50) return;
      try {
        fitRef.current.fit();
        const cols = termRef.current.cols;
        const rows = termRef.current.rows;
        if (cols >= 20 && rows >= 3) {
          void window.ide.resizeTerminal(id, cols, rows);
        }
      } catch (e) {
        // ignore
      }
    };

    let sessionId: string | null = null;
    const unsubData = window.ide.onTerminalData(({ id, data }) => {
      if ((sessionId ?? idRef.current) === id) term.write(data);
    });
    const unsubExit = window.ide.onTerminalExit(({ id, exitCode }) => {
      if ((sessionId ?? idRef.current) === id) {
        term.writeln(`\r\n[process exited ${exitCode}]`);
      }
    });

    void window.ide.createTerminal({ kind: terminalKind, cwd }).then((res) => {
      if (disposed) return;
      const { id } = res;
      if (!id) {
        term.write('\r\n\x1b[31mFailed to launch terminal process.\x1b[0m\r\n');
        return;
      }
      sessionId = id;
      idRef.current = id;

      if (initialCommand?.trim()) {
        setTimeout(() => {
          if (!disposed) {
            void window.ide.writeTerminal(id, initialCommand.trim() + '\r\n');
          }
        }, 400);
      }

      term.onData((data) => {
        // 使用 node-pty 后，shell 会自行回显输入（PTY 原生 echo）并处理退格/光标，
        // 因此不再手动 echoLocalInput，否则会与 PTY 双重回显，退格还会把已显示的
        // 提示符/输入删掉。
        void window.ide.writeTerminal(id, data);
      });

      const resizeObserver: ResizeObserver | null = new ResizeObserver(() => {
        if (activeRef.current && visibleRef.current) {
          syncSize(id);
        }
      });
      if (hostRef.current) {
        resizeObserver.observe(hostRef.current);
      }

      // Perform multiple staged fit retries to ensure initial layout settlement
      syncSize(id);
      requestAnimationFrame(() => syncSize(id));
      const t1 = setTimeout(() => syncSize(id), 50);
      const t2 = setTimeout(() => syncSize(id), 150);
      const t3 = setTimeout(() => syncSize(id), 400);

      if (activeRef.current) term.focus();
      observerRef.current = resizeObserver;
    });

    return () => {
      disposed = true;
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

  useEffect(() => {
    if (!active || !visible) return;
    const doFit = () => {
      const term = termRef.current;
      const fit = fitRef.current;
      const id = idRef.current;
      if (term && fit && id && hostRef.current) {
        if (hostRef.current.clientWidth < 200 || hostRef.current.clientHeight < 50) return;
        try {
          fit.fit();
          term.scrollToBottom();
          const cols = term.cols;
          const rows = term.rows;
          if (cols >= 20 && rows >= 3) {
            void window.ide.resizeTerminal(id, cols, rows);
          }
          if (active) term.focus();
        } catch (e) {
          // ignore
        }
      }
    };

    doFit();
    const timer1 = setTimeout(doFit, 50);
    const timer2 = setTimeout(doFit, 150);
    const timer3 = setTimeout(doFit, 400);
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
      clearTimeout(timer3);
    };
  }, [active, visible]);

  return (
    <div
      className={`terminal-session${active ? ' active' : ''}`}
      aria-hidden={!active}
      onMouseDown={() => {
        if (active) termRef.current?.focus();
      }}
    >
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}

export function TerminalPanel({
  terminalKind,
  uiTheme,
  openRequest,
  visible = true,
  onCollapse,
}: Props) {
  const seqRef = useRef(1);
  const bootRef = useRef<TermTab | null>(null);
  if (!bootRef.current) bootRef.current = makeTab(1);

  const [tabs, setTabs] = useState<TermTab[]>([bootRef.current]);
  const [activeId, setActiveId] = useState(bootRef.current.clientId);
  const lastNonce = useRef(0);

  const addTerminal = useCallback((cwd?: string, initialCommand?: string) => {
    seqRef.current += 1;
    const tab = makeTab(seqRef.current, cwd, initialCommand);
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.clientId);
  }, []);

  useEffect(() => {
    if (!openRequest) return;
    if (openRequest.nonce === lastNonce.current) return;
    lastNonce.current = openRequest.nonce;
    addTerminal(openRequest.cwd, openRequest.initialCommand);
  }, [openRequest, addTerminal]);

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
              return (
                <button
                  key={tab.clientId}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`terminal-tab${active ? ' active' : ''}`}
                  onClick={() => setActiveId(tab.clientId)}
                >
                  <span className="terminal-tab-label">{tabLabel(terminalKind, tab.index)}</span>
                  <span
                    className="terminal-tab-close"
                    title="关闭终端"
                    role="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminal(tab.clientId);
                    }}
                  >
                    ×
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
            <svg
              width="12"
              height="12"
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
            active={tab.clientId === activeId}
            visible={visible}
            terminalKind={terminalKind}
            uiTheme={uiTheme}
            cwd={tab.cwd}
            initialCommand={tab.initialCommand}
          />
        ))}
      </div>
    </div>
  );
}
