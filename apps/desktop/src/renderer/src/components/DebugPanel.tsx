import React, { useState, useEffect, useRef, useCallback } from 'react';
import type {
  DapBreakpoint,
  DapScope,
  DapStackFrame,
  DapVariable,
} from '@deepseek-ide/shared';

interface DebugPanelProps {
  workspace?: string | null;
  breakpoints: DapBreakpoint[];
  onToggleBreakpoint: (path: string, line: number) => void;
  onClearBreakpoints: () => void;
  onOpenFile: (path: string, line?: number, column?: number) => void;
  isDebugging: boolean;
  debugState: 'running' | 'paused' | 'stopped';
  onContinue: () => void;
  onPause: () => void;
  onStepOver: () => void;
  onStepInto: () => void;
  onStepOut: () => void;
  onStop: () => void;
}

export function DebugPanel({
  workspace,
  breakpoints,
  onToggleBreakpoint,
  onClearBreakpoints,
  onOpenFile,
  isDebugging,
  debugState,
  onContinue,
  onPause,
  onStepOver,
  onStepInto,
  onStepOut,
  onStop,
}: DebugPanelProps) {
  // ── 折叠状态 ──
  const [collapsed, setCollapsed] = useState<{ [key: string]: boolean }>({
    variables: false,
    callStack: false,
    breakpoints: false,
    watch: false,
    console: false,
  });

  // ── 堆栈与变量数据 ──
  const [frames, setFrames] = useState<DapStackFrame[]>([]);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);
  const [_scopes, setScopes] = useState<DapScope[]>([]);
  const [variables, setVariables] = useState<{ [scopeName: string]: DapVariable[] }>({});

  // ── 监视表达式 ──
  const [watchExpressions, setWatchExpressions] = useState<
    Array<{ expression: string; value: string; type?: string }>
  >([]);
  const [newWatchInput, setNewWatchInput] = useState('');
  const [isAddingWatch, setIsAddingWatch] = useState(false);

  // ── 左右分栏拖动宽度调节 (持久化记录) ──
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('echoly.debugPanel.leftWidth');
      if (saved) {
        const val = parseInt(saved, 10);
        if (!isNaN(val) && val >= 200 && val <= 1200) return val;
      }
    } catch {}
    return 360;
  });
  const isResizingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const startResizeLeft = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = leftWidth;
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      const delta = ev.clientX - startX;
      const clientW = containerRef.current?.clientWidth || 800;
      const maxW = Math.max(240, clientW - 240);
      const next = Math.max(200, Math.min(maxW, startWidth + delta));
      setLeftWidth(next);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      try {
        setLeftWidth((current) => {
          localStorage.setItem('echoly.debugPanel.leftWidth', String(current));
          return current;
        });
      } catch {}
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [leftWidth]);

  // ── 调试控制台输出与输入 ──
  const [consoleLogs, setConsoleLogs] = useState<Array<{ category: string; text: string }>>([]);
  const [replInput, setReplInput] = useState('');
  const logContainerRef = useRef<HTMLDivElement>(null);

  // ── 当前多语言调试会话元数据 (Java, Python, Node, Go, C++ 等) ──
  const [debugSessionInfo, setDebugSessionInfo] = useState<{
    language?: string;
    port?: number;
    name?: string;
  } | null>(null);

  useEffect(() => {
    const handleStart = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (detail) {
        setDebugSessionInfo(detail);
        const portInfo = detail.port ? ` (监听端口: ${detail.port})` : '';
        setConsoleLogs((prev) => [
          ...prev,
          {
            category: 'status',
            text: `🚀 [Debug] 已启动 ${detail.language ? detail.language.toUpperCase() : ''} 调试会话: ${detail.name || ''}${portInfo}`,
          },
        ]);
      }
    };
    window.addEventListener('echoly:startDebug', handleStart);
    return () => window.removeEventListener('echoly:startDebug', handleStart);
  }, []);

  useEffect(() => {
    if (!isDebugging) {
      setDebugSessionInfo(null);
    }
  }, [isDebugging]);

  // 监听 DAP 全局事件
  useEffect(() => {
    if (!window.ide?.onDapEvent) return;

    const unlisten = window.ide.onDapEvent(async (ev) => {
      if (ev.type === 'output' && ev.output) {
        setConsoleLogs((prev) => [...prev, { category: ev.category || 'console', text: ev.output! }]);
        setTimeout(() => {
          if (logContainerRef.current) {
            logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
          }
        }, 30);
      } else if (ev.type === 'stopped') {
        setConsoleLogs((prev) => [
          ...prev,
          { category: 'status', text: `⏸ 程序停顿在断点 (线程 ID: ${ev.threadId || 1})` },
        ]);
        // 自动拉取调用堆栈
        try {
          const st = (await window.ide.dapGetStackTrace?.(ev.threadId || 1)) || [];
          setFrames(st);
          if (st.length > 0) {
            const topFrame = st[0];
            setSelectedFrameId(topFrame.id);
            if (topFrame.source?.path) {
              onOpenFile(topFrame.source.path, topFrame.line, topFrame.column);
            }
            // 拉取变量作用域
            const sc = (await window.ide.dapGetScopes?.(topFrame.id)) || [];
            setScopes(sc);
            const varsMap: { [name: string]: DapVariable[] } = {};
            for (const s of sc) {
              if (s.variablesReference > 0) {
                const vars = (await window.ide.dapGetVariables?.(s.variablesReference)) || [];
                varsMap[s.name] = vars;
              }
            }
            setVariables(varsMap);
          }
        } catch {
          /* ignore */
        }
      } else if (ev.type === 'terminated' || ev.type === 'exited') {
        setConsoleLogs((prev) => [
          ...prev,
          { category: 'status', text: `⏹ 调试会话结束 (退出代码: ${ev.exitCode ?? 0})` },
        ]);
        setFrames([]);
        setScopes([]);
        setVariables({});
      }
    });

    return () => unlisten();
  }, [onOpenFile]);

  // 添加监视表达式
  const handleAddWatch = async () => {
    const expr = newWatchInput.trim();
    if (!expr) {
      setIsAddingWatch(false);
      return;
    }

    let val = '未运行';
    let type: string | undefined;
    if (isDebugging && window.ide?.dapEvaluate) {
      try {
        const res = await window.ide.dapEvaluate(expr, selectedFrameId ?? undefined);
        val = res.result;
        type = res.type;
      } catch (err: any) {
        val = `错误: ${err?.message || String(err)}`;
      }
    }

    setWatchExpressions((prev) => [...prev, { expression: expr, value: val, type }]);
    setNewWatchInput('');
    setIsAddingWatch(false);
  };

  // REPL 输入提交
  const handleReplSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = replInput.trim();
    if (!cmd) return;

    setConsoleLogs((prev) => [...prev, { category: 'input', text: `> ${cmd}` }]);
    setReplInput('');

    if (isDebugging && window.ide?.dapEvaluate) {
      try {
        const res = await window.ide.dapEvaluate(cmd, selectedFrameId ?? undefined);
        setConsoleLogs((prev) => [
          ...prev,
          { category: 'result', text: res.result },
        ]);
      } catch (err: any) {
        setConsoleLogs((prev) => [
          ...prev,
          { category: 'stderr', text: `错误: ${err?.message || String(err)}` },
        ]);
      }
    } else {
      setConsoleLogs((prev) => [
        ...prev,
        { category: 'stderr', text: '当前无正在运行的调试会话' },
      ]);
    }
  };

  const toggleSection = (sec: string) => {
    setCollapsed((prev) => ({ ...prev, [sec]: !prev[sec] }));
  };

  return (
    <div className="debug-panel">
      {/* ── 顶部二级工具栏 (规范对齐 Maven 高度 30px) ── */}
      <div
        style={{
          height: 30,
          boxSizing: 'border-box',
          padding: '0 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.05em' }}>
            DEBUG CONSOLE & VARIABLES
          </span>
          <span
            style={{
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 4,
              background: isDebugging
                ? debugState === 'paused'
                  ? 'rgba(234, 179, 8, 0.2)'
                  : 'rgba(34, 197, 94, 0.2)'
                : 'rgba(255, 255, 255, 0.08)',
              color: isDebugging
                ? debugState === 'paused'
                  ? '#facc15'
                  : '#4ade80'
                : 'var(--muted)',
            }}
          >
            {isDebugging ? (debugState === 'paused' ? 'PAUSED' : 'RUNNING') : 'IDLE'}
          </span>
          {debugSessionInfo && (
            <span
              style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 4,
                background: 'rgba(56, 189, 248, 0.15)',
                color: '#38bdf8',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontWeight: 600,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="8" y="9" width="8" height="10" rx="4" />
                <line x1="6" y1="4" x2="8" y2="7" />
                <line x1="18" y1="4" x2="16" y2="7" />
              </svg>
              {debugSessionInfo.language?.toUpperCase() || 'DEBUG'}{debugSessionInfo.port ? ` :${debugSessionInfo.port}` : ''}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {isDebugging && (
            <>
              {debugState === 'paused' ? (
                <button
                  type="button"
                  className="panel-action-btn"
                  onClick={onContinue}
                  title="继续执行 (F5)"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3" />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  className="panel-action-btn"
                  onClick={onPause}
                  title="暂停执行 (F6)"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" />
                    <rect x="14" y="4" width="4" height="16" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                className="panel-action-btn"
                onClick={onStepOver}
                title="单步跳过 (F10)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <polyline points="19 12 12 19 5 12" />
                </svg>
              </button>
              <button
                type="button"
                className="panel-action-btn"
                onClick={onStepInto}
                title="单步步入 (F11)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="7 13 12 18 17 13" />
                  <polyline points="7 6 12 11 17 6" />
                </svg>
              </button>
              <button
                type="button"
                className="panel-action-btn"
                onClick={onStepOut}
                title="单步步出 (Shift+F11)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="7 11 12 6 17 11" />
                  <polyline points="7 18 12 13 17 18" />
                </svg>
              </button>
              <button
                type="button"
                className="panel-action-btn"
                onClick={onStop}
                title="停止调试 (Shift+F5)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="#ef4444">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
              </button>
            </>
          )}
          <button
            type="button"
            className="panel-action-btn"
            onClick={() => setConsoleLogs([])}
            title="清空调试控制台日志"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>

      <div ref={containerRef} style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {/* 左半侧: 变量、堆栈、断点与监视 */}
        <div
          style={{
            width: leftWidth,
            minWidth: 220,
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'auto',
            flexShrink: 0,
          }}
        >
          {/* 1. 变量 (Variables) */}
          <div className="debug-section">
            <div className="debug-section-header" onClick={() => toggleSection('variables')}>
              <span>{collapsed.variables ? '▸' : '▾'} 变量 (VARIABLES)</span>
            </div>
            {!collapsed.variables && (
              <div className="debug-section-content">
                {Object.keys(variables).length === 0 ? (
                  <div style={{ padding: '8px 12px', color: 'var(--muted)' }}>
                    {isDebugging ? '暂无可用变量或未命中断点' : '启动调试后显示局部与全局变量'}
                  </div>
                ) : (
                  Object.entries(variables).map(([scope, vars]) => (
                    <div key={scope} style={{ marginBottom: 4 }}>
                      <div
                        style={{
                          padding: '2px 10px',
                          fontSize: 10.5,
                          fontWeight: 600,
                          color: 'var(--muted)',
                          background: 'rgba(255, 255, 255, 0.02)',
                        }}
                      >
                        {scope}
                      </div>
                      {vars.map((v) => (
                        <div key={v.name} className="debug-item-row">
                          <span className="debug-var-name">{v.name}:</span>
                          <span className="debug-var-value">{v.value}</span>
                          {v.type && <span className="debug-var-type">({v.type})</span>}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 2. 调用堆栈 (Call Stack) */}
          <div className="debug-section">
            <div className="debug-section-header" onClick={() => toggleSection('callStack')}>
              <span>{collapsed.callStack ? '▸' : '▾'} 调用堆栈 (CALL STACK)</span>
            </div>
            {!collapsed.callStack && (
              <div className="debug-section-content">
                {frames.length === 0 ? (
                  <div style={{ padding: '8px 12px', color: 'var(--muted)' }}>
                    {isDebugging ? '未暂停' : '调试未运行'}
                  </div>
                ) : (
                  frames.map((f) => (
                    <div
                      key={f.id}
                      className="debug-item-row"
                      style={{
                        background:
                          selectedFrameId === f.id ? 'rgba(59, 130, 246, 0.15)' : undefined,
                      }}
                      onClick={() => {
                        setSelectedFrameId(f.id);
                        if (f.source?.path) {
                          onOpenFile(f.source.path, f.line, f.column);
                        }
                      }}
                    >
                      <span style={{ fontWeight: 600, color: '#f3f4f6' }}>{f.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {f.source?.name || f.source?.path?.split('/').pop() || 'unknown'}:{f.line}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 3. 监视 (Watch) */}
          <div className="debug-section">
            <div
              className="debug-section-header"
              style={{ display: 'flex', justifyContent: 'space-between' }}
            >
              <span onClick={() => toggleSection('watch')}>
                {collapsed.watch ? '▸' : '▾'} 监视表达式 (WATCH)
              </span>
              <button
                type="button"
                className="panel-action-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsAddingWatch(true);
                }}
                title="添加监视表达式"
              >
                +
              </button>
            </div>
            {!collapsed.watch && (
              <div className="debug-section-content">
                {isAddingWatch && (
                  <div style={{ padding: '4px 8px' }}>
                    <input
                      type="text"
                      autoFocus
                      placeholder="输入变量或表达式并回车..."
                      value={newWatchInput}
                      onChange={(e) => setNewWatchInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleAddWatch();
                        if (e.key === 'Escape') setIsAddingWatch(false);
                      }}
                      style={{
                        width: '100%',
                        background: 'rgba(0,0,0,0.3)',
                        border: '1px solid var(--accent)',
                        borderRadius: 4,
                        padding: '3px 6px',
                        color: '#fff',
                        fontSize: 12,
                      }}
                    />
                  </div>
                )}
                {watchExpressions.length === 0 && !isAddingWatch ? (
                  <div style={{ padding: '8px 12px', color: 'var(--muted)' }}>点击 + 添加表达式</div>
                ) : (
                  watchExpressions.map((w, idx) => (
                    <div
                      key={idx}
                      className="debug-item-row"
                      style={{ justifyContent: 'space-between' }}
                    >
                      <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                        <span className="debug-var-name">{w.expression}:</span>
                        <span className="debug-var-value">{w.value}</span>
                      </div>
                      <button
                        type="button"
                        className="panel-action-btn"
                        onClick={() =>
                          setWatchExpressions((prev) => prev.filter((_, i) => i !== idx))
                        }
                        title="删除表达式"
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* 4. 断点 (Breakpoints) */}
          <div className="debug-section" style={{ borderBottom: 'none' }}>
            <div
              className="debug-section-header"
              style={{ display: 'flex', justifyContent: 'space-between' }}
            >
              <span onClick={() => toggleSection('breakpoints')}>
                {collapsed.breakpoints ? '▸' : '▾'} 断点列表 (BREAKPOINTS - {breakpoints.length})
              </span>
              {breakpoints.length > 0 && (
                <button
                  type="button"
                  className="panel-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearBreakpoints();
                  }}
                  title="清除全部断点"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  </svg>
                </button>
              )}
            </div>
            {!collapsed.breakpoints && (
              <div className="debug-section-content">
                {breakpoints.length === 0 ? (
                  <div style={{ padding: '8px 12px', color: 'var(--muted)' }}>
                    点击代码行号左侧区域即可添加断点
                  </div>
                ) : (
                  breakpoints.map((bp) => (
                    <div
                      key={`${bp.path}:${bp.line}`}
                      className="debug-item-row"
                      onClick={() => onOpenFile(bp.path, bp.line)}
                      style={{ justifyContent: 'space-between' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: '#ef4444',
                            boxShadow: '0 0 4px #ef4444',
                            display: 'inline-block',
                            flexShrink: 0,
                          }}
                        />
                        {(() => {
                          let display = bp.path;
                          if (workspace) {
                            const normWs = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
                            const normPath = bp.path.replace(/\\/g, '/');
                            if (normPath.startsWith(normWs + '/')) {
                              display = normPath.slice(normWs.length + 1);
                            }
                          }
                          return (
                            <span
                              style={{
                                color: '#fff',
                                maxWidth: 160,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={bp.path}
                            >
                              {display}
                            </span>
                          );
                        })()}
                        <span style={{ color: 'var(--muted)', flexShrink: 0 }}>:{bp.line}</span>
                      </div>
                      <button
                        type="button"
                        className="panel-action-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleBreakpoint(bp.path, bp.line);
                        }}
                        title="删除断点"
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
        </div>
      </div>

      {/* 中间可左右拖动划线 */}
      <div
        className="splitter splitter-v"
        onMouseDown={startResizeLeft}
        title="左右拖拽调整调试工作台面板宽度"
        style={{
          width: 5,
          cursor: 'col-resize',
          background: 'transparent',
          borderLeft: '1px solid var(--border)',
          flexShrink: 0,
          zIndex: 10,
          userSelect: 'none',
        }}
      />

      {/* 右半侧: 调试控制台输出与 REPL */}
      <div style={{ flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', background: '#121214' }}>
          <div
            ref={logContainerRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '8px 12px',
              fontFamily: 'Menlo, Monaco, Consolas, monospace',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            {consoleLogs.length === 0 ? (
              <div style={{ color: 'var(--muted)', marginTop: 8 }}>
                调试控制台就绪。启动调试后，此处将输出 LLDB 引擎日志、程序 stdout/stderr，并支持在下方输入表达式求值。
              </div>
            ) : (
              consoleLogs.map((l, i) => (
                <div
                  key={i}
                  style={{
                    color:
                      l.category === 'stderr'
                        ? '#f87171'
                        : l.category === 'status'
                          ? '#facc15'
                          : l.category === 'input'
                            ? '#60a5fa'
                            : l.category === 'result'
                              ? '#34d399'
                              : '#d1d5db',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {l.text}
                </div>
              ))
            )}
          </div>

          {/* REPL 命令交互输入框 */}
          <form
            onSubmit={handleReplSubmit}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '6px 10px',
              borderTop: '1px solid var(--border)',
              background: 'rgba(0, 0, 0, 0.25)',
              gap: 8,
            }}
          >
            <span style={{ color: 'var(--accent)', fontWeight: 'bold' }}>&gt;</span>
            <input
              type="text"
              value={replInput}
              onChange={(e) => setReplInput(e.target.value)}
              placeholder="对变量求值或执行 LLDB 表达式 (例如: myVar, p 1+1, frame var)..."
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#fff',
                fontSize: 12,
                fontFamily: 'monospace',
              }}
            />
            <button
              type="submit"
              className="panel-action-btn"
              title="执行表达式"
            >
              ↵
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
