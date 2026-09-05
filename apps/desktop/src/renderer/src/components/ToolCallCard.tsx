import { useEffect, useRef, useState } from 'react';
import type { ChatSessionMessage } from '@deepseek-ide/shared';

const TOOL_LABELS: Record<string, string> = {
  run_terminal: '终端',
  read_file: '读取文件',
  write_file: '写入文件',
  apply_patch: '应用补丁',
  list_dir: '列出目录',
  search_code: '搜索代码',
  glob_files: '匹配文件',
  ask_user: '询问用户',
};

const CMD_COLLAPSE_LINES = 6;
const OUT_COLLAPSE_LINES = 12;

function parseArgs(args?: string): Record<string, unknown> | null {
  if (!args?.trim()) return null;
  try {
    const obj = JSON.parse(args) as Record<string, unknown>;
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function toolLabel(name?: string): string {
  if (!name) return '工具';
  return TOOL_LABELS[name] ?? name;
}

export function commandFromArgs(args?: string): string | null {
  const obj = parseArgs(args);
  if (!obj) return null;
  if (typeof obj.command === 'string' && obj.command.trim()) return obj.command;
  return null;
}

function pathFromArgs(args?: string): string | null {
  const obj = parseArgs(args);
  if (!obj) return null;
  for (const key of ['path', 'file', 'glob', 'pattern', 'query']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

function summarizeArgs(args?: string): string {
  const cmd = commandFromArgs(args);
  if (cmd) return cmd.length > 72 ? `${cmd.slice(0, 72)}…` : cmd;
  const path = pathFromArgs(args);
  if (path) return path.length > 72 ? `${path.slice(0, 72)}…` : path;
  if (!args) return '';
  try {
    const obj = JSON.parse(args) as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (!keys.length) return '';
    
    // 尝试构建更有意义的摘要
    const parts: string[] = [];
    for (const key of keys.slice(0, 3)) { // 最多显示3个参数
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0) {
        const short = val.length > 40 ? `${val.slice(0, 40)}…` : val;
        parts.push(`${key}=${short}`);
      } else if (typeof val === 'number' || typeof val === 'boolean') {
        parts.push(`${key}=${val}`);
      }
    }
    
    if (parts.length > 0) {
      const summary = parts.join(', ');
      return summary.length > 80 ? `${summary.slice(0, 80)}…` : summary;
    }
    
    // 回退到旧逻辑
    const first = keys[0];
    const val = obj[first];
    const short =
      typeof val === 'string'
        ? val.length > 60
          ? `${val.slice(0, 60)}…`
          : val
        : JSON.stringify(val)?.slice(0, 60) ?? '';
    return `${first}: ${short}`;
  } catch {
    return args.length > 80 ? `${args.slice(0, 80)}…` : args;
  }
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

function collapseText(
  text: string,
  maxLines: number,
  mode: 'head' | 'tail',
): { shown: string; hidden: number; total: number } {
  const lines = text.split('\n');
  const total = lines.length;
  if (total <= maxLines) return { shown: text, hidden: 0, total };
  if (mode === 'tail') {
    return {
      shown: lines.slice(-maxLines).join('\n'),
      hidden: total - maxLines,
      total,
    };
  }
  return {
    shown: `${lines.slice(0, maxLines).join('\n')}\n…`,
    hidden: total - maxLines,
    total,
  };
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyBtn({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="tool-card-copy"
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? '已复制' : label}
    </button>
  );
}

/** Collapsible pre block for long command / output. Live mode shows a tail while streaming. */
function CollapsibleBlock({
  text,
  maxLines,
  live = false,
  className,
  emptyLabel,
}: {
  text: string;
  maxLines: number;
  live?: boolean;
  className?: string;
  emptyLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const preRef = useRef<HTMLPreElement | null>(null);
  const total = lineCount(text);
  const needsCollapse = total > maxLines || text.length > 900;
  const { shown, hidden } = collapseText(
    text,
    maxLines,
    live && !expanded ? 'tail' : 'head',
  );
  const display = !needsCollapse || expanded ? text : shown;

  useEffect(() => {
    if (!live || !preRef.current) return;
    preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [live, display]);

  if (!text) {
    return emptyLabel ? <div className="tool-terminal-running muted">{emptyLabel}</div> : null;
  }

  return (
    <div className="tool-collapse-block">
      <pre ref={preRef} className={className}>
        {display}
      </pre>
      {needsCollapse && (
        <button
          type="button"
          className="tool-collapse-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded
            ? '收起'
            : live
              ? `展开全部（共 ${total} 行，当前显示末尾）`
              : `展开全部（还有 ${hidden} 行）`}
        </button>
      )}
    </div>
  );
}

export function stripAnsi(text: string): string {
  if (!text) return '';
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

export function parseTerminalResult(content: string): { exitCode: number | null; cleanOutput: string } {
  if (!content) return { exitCode: null, cleanOutput: '' };
  const match = content.match(/^exit=(\d+)\n?([\s\S]*)$/);
  if (match) {
    return { exitCode: parseInt(match[1], 10), cleanOutput: stripAnsi(match[2]) };
  }
  return { exitCode: null, cleanOutput: stripAnsi(content) };
}

export function TerminalExecutionView({
  command,
  status,
  liveOutput,
  finalOutput,
  createdAt,
}: {
  command: string;
  status: 'running' | 'done' | 'error';
  liveOutput: string;
  finalOutput: string;
  createdAt?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [elapsedSec, setElapsedSec] = useState(0);
  const preRef = useRef<HTMLPreElement | null>(null);

  // 实时执行计时器
  useEffect(() => {
    if (status !== 'running') return;
    const start = createdAt || Date.now();
    setElapsedSec(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    const interval = setInterval(() => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    }, 500);
    return () => clearInterval(interval);
  }, [status, createdAt]);

  const rawOutput = status === 'running' ? liveOutput : finalOutput;
  const { exitCode, cleanOutput } = parseTerminalResult(rawOutput);
  const outputText = cleanOutput || '';
  const lines = outputText.split('\n');
  const totalLines = outputText ? lines.length : 0;
  const needsCollapse = totalLines > 14 || outputText.length > 1200;

  // 实时输出自动滚动到底部
  useEffect(() => {
    if (status === 'running' && autoScroll && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [outputText, status, autoScroll]);

  return (
    <div className="terminal-exec-container">
      {/* 终端顶部标题栏 */}
      <div className="terminal-exec-header">
        <div className="terminal-exec-dots">
          <span className="dot dot-red" />
          <span className="dot dot-yellow" />
          <span className="dot dot-green" />
          <span className="terminal-exec-title">终端控制台 (bash)</span>
        </div>
        <div className="terminal-exec-status">
          {status === 'running' ? (
            <span className="terminal-badge running">
              <span className="tool-call-spinner" />
              正在执行 ({elapsedSec}s)
            </span>
          ) : status === 'error' ? (
            <span className="terminal-badge error">
              ✕ 执行失败 {exitCode !== null ? `(exit ${exitCode})` : ''}
            </span>
          ) : (
            <span className="terminal-badge done">
              ✓ 执行完成 {exitCode !== null ? `(exit ${exitCode})` : ''}
            </span>
          )}
        </div>
        <div className="terminal-exec-actions">
          {needsCollapse && (
            <button
              type="button"
              className="term-btn"
              onClick={() => setExpanded(!expanded)}
              title={expanded ? '收起为紧凑模式' : '展开全部输出'}
            >
              {expanded ? '收起' : `展开全部 (${totalLines} 行)`}
            </button>
          )}
          {status === 'running' && (
            <button
              type="button"
              className={`term-btn${autoScroll ? ' active' : ''}`}
              onClick={() => setAutoScroll(!autoScroll)}
              title="切换实时自动滚屏"
            >
              {autoScroll ? '滚屏: 开' : '滚屏: 关'}
            </button>
          )}
          <CopyBtn text={outputText || command} label="复制输出" />
        </div>
      </div>

      {/* 执行命令行 */}
      <div className="terminal-exec-cmd-line">
        <span className="term-prompt">$</span>
        <span className="term-cmd-text">{command}</span>
        <CopyBtn text={command} label="复制命令" />
      </div>

      {/* 终端实时/历史输出区域 */}
      <div className={`terminal-exec-body${expanded ? ' expanded' : ''}`}>
        {status === 'running' && !outputText ? (
          <div className="terminal-live-waiting">
            <span className="tool-call-spinner" />
            <span>进程已启动，正在执行并监听输出 (已执行 {elapsedSec}s)...</span>
            <span className="terminal-cursor">▋</span>
          </div>
        ) : (
          <div className="terminal-pre-wrap">
            <pre ref={preRef} className="terminal-exec-pre">
              {outputText}
              {status === 'running' && <span className="terminal-cursor">▋</span>}
            </pre>
            {status !== 'running' && !outputText && (
              <div className="terminal-empty-text">（命令执行完成，标准输出为空）</div>
            )}
          </div>
        )}

        {status !== 'running' && exitCode !== null && (
          <div className={`terminal-exit-banner ${exitCode === 0 ? 'success' : 'error'}`}>
            <span>{exitCode === 0 ? '✔ 进程正常退出 (exit code 0)' : `✘ 进程异常退出 (exit code ${exitCode})`}</span>
          </div>
        )}
      </div>

      {/* 底部展开切换条 */}
      {needsCollapse && (
        <div className="terminal-exec-footer">
          <button
            type="button"
            className="terminal-expand-bottom-btn"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded
              ? '▴ 收起输出过程'
              : `▾ 展开查看全部执行过程（共 ${totalLines} 行输出）`}
          </button>
        </div>
      )}
    </div>
  );
}

export function ToolCallCard({ message }: { message: ChatSessionMessage }) {
  const status = message.toolStatus ?? 'done';
  const isTerminal = message.toolName === 'run_terminal';
  const command = isTerminal ? commandFromArgs(message.toolArgs) : null;
  const summary = summarizeArgs(message.toolArgs);
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open =
    userToggled !== null
      ? userToggled
      : status === 'running' || 
        status === 'error' || // 失败或正在执行的工具调用默认展开具体过程
        (isTerminal && !!message.content);

  const [elapsedSec, setElapsedSec] = useState(0);

  // 运行耗时计时
  useEffect(() => {
    if (status !== 'running') return;
    const start = message.createdAt || Date.now();
    setElapsedSec(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    const interval = setInterval(() => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    }, 500);
    return () => clearInterval(interval);
  }, [status, message.createdAt]);

  const statusClass =
    status === 'running' ? ' running' : status === 'error' ? ' error' : ' done';
  const statusText =
    status === 'running'
      ? `正在执行${elapsedSec > 0 ? ` (${elapsedSec}s)` : '…'}`
      : status === 'error'
        ? '失败'
        : '完成';

  // While streaming, content is raw chunks; after done, content includes exit=… header.
  const liveOutput = status === 'running' ? message.content || '' : '';
  const finalOutput = status !== 'running' ? message.content || '' : '';

  return (
    <div
      className={`tool-call-card${open ? ' open' : ''}${statusClass}${isTerminal ? ' is-terminal' : ''}`}
    >
      <button
        type="button"
        className="tool-call-header"
        onClick={() => setUserToggled(!open)}
        title={open ? '点击收起具体执行过程' : '点击展开查看具体执行过程'}
      >
        <span className={`tool-call-status-dot${statusClass}`} aria-hidden>
          {status === 'running' ? (
            <span className="tool-call-spinner" />
          ) : status === 'error' ? (
            '!'
          ) : (
            '✓'
          )}
        </span>
        <span className="tool-call-title">
          <span className="tool-call-name">{toolLabel(message.toolName)}</span>
          <span className="tool-call-status-text">{statusText}</span>
        </span>
        {summary && (
          <span className="tool-call-summary" title={summary}>
            {isTerminal ? `$ ${summary}` : summary}
          </span>
        )}
        <span className="tool-call-chevron">
          {open ? '▴ 收起过程' : '▾ 展开查看具体过程'}
        </span>
      </button>

      {open && (
        <div className="tool-call-body">
          {isTerminal && command ? (
            <TerminalExecutionView
              command={command}
              status={status}
              liveOutput={liveOutput}
              finalOutput={finalOutput}
              createdAt={message.createdAt}
            />
          ) : (
            <>
              {message.toolArgs && (
                <div className="tool-call-section">
                  <div className="tool-call-section-head">
                    <span>参数</span>
                    <CopyBtn text={message.toolArgs} />
                  </div>
                  <CollapsibleBlock
                    text={message.toolArgs}
                    maxLines={CMD_COLLAPSE_LINES}
                    className="tool-call-pre"
                  />
                </div>
              )}
              {status !== 'running' && message.content && (
                <div className="tool-call-section">
                  <div className="tool-call-section-head">
                    <span>结果</span>
                    <CopyBtn text={message.content} />
                  </div>
                  <CollapsibleBlock
                    text={message.content}
                    maxLines={OUT_COLLAPSE_LINES}
                    className="tool-call-pre"
                  />
                </div>
              )}
              {status === 'running' && (
                <div className="tool-terminal-running">
                  <span className="tool-call-spinner" />
                  正在执行 ({elapsedSec}s)…
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

