import { useEffect, useRef, useState } from 'react';
import type { ChatSessionMessage } from '@deepseek-ide/shared';
import { useI18n, type Translate } from '../i18n';

/**
 * 工具 id → 字典 key。
 *
 * 这里存的是 **key 而不是中文**：工具 id（`read_file` 等）是模型的契约，
 * 永远不能翻；能翻的只有给人看的标签，所以两者要分开存放。
 */
const TOOL_LABEL_KEYS: Record<string, string> = {
  run_terminal: 'chat.toolRunTerminal',
  read_file: 'chat.toolReadFile',
  write_file: 'chat.toolWriteFile',
  apply_patch: 'chat.toolApplyPatch',
  list_dir: 'chat.toolListDir',
  search_code: 'chat.toolSearchCode',
  glob_files: 'chat.toolGlobFiles',
  ask_user: 'chat.toolAskUser',
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

function toolLabel(t: Translate, name?: string): string {
  if (!name) return t('chat.toolGeneric');
  const key = TOOL_LABEL_KEYS[name];
  // 未知工具（含 MCP 注入的）原样显示 id：它比任何兜底文案都更有信息量
  return key ? t(key) : name;
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
    for (const key of keys.slice(0, 3)) {
      // 最多显示3个参数
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
        : (JSON.stringify(val)?.slice(0, 60) ?? '');
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

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const resolved = label ?? t('chat.copy');
  return (
    <button
      type="button"
      className="tool-card-copy"
      title={resolved}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? t('editor.copied') : resolved}
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
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const preRef = useRef<HTMLPreElement | null>(null);
  const total = lineCount(text);
  const needsCollapse = total > maxLines || text.length > 900;
  const { shown, hidden } = collapseText(text, maxLines, live && !expanded ? 'tail' : 'head');
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
            ? t('editor.collapseShort')
            : live
              ? t('chat.expandAllTail', { n: total })
              : t('chat.expandAllMore', { n: hidden })}
        </button>
      )}
    </div>
  );
}

export function stripAnsi(text: string): string {
  if (!text) return '';
  return text.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    '',
  );
}

export function parseTerminalResult(content: string): {
  exitCode: number | null;
  cleanOutput: string;
} {
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
  const { t } = useI18n();
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
          <span className="terminal-exec-title">{t('chat.cmdConsole')}</span>
        </div>
        <div className="terminal-exec-status">
          {status === 'running' ? (
            <span className="terminal-badge running">
              <span className="tool-call-spinner" />
              {t('chat.runningWithSec', { s: elapsedSec })}
            </span>
          ) : status === 'error' ? (
            <span className="terminal-badge error">
              {t('chat.execFailed')} {exitCode !== null ? `(exit ${exitCode})` : ''}
            </span>
          ) : (
            <span className="terminal-badge done">
              {t('chat.execDone')} {exitCode !== null ? `(exit ${exitCode})` : ''}
            </span>
          )}
        </div>
        <div className="terminal-exec-actions">
          {needsCollapse && (
            <button
              type="button"
              className="term-btn"
              onClick={() => setExpanded(!expanded)}
              title={expanded ? t('chat.collapseCompactTip') : t('chat.expandAllOutputTip')}
            >
              {expanded ? t('editor.collapseShort') : t('chat.expandAllLines', { n: totalLines })}
            </button>
          )}
          {status === 'running' && (
            <button
              type="button"
              className={`term-btn${autoScroll ? ' active' : ''}`}
              onClick={() => setAutoScroll(!autoScroll)}
              title={t('chat.toggleAutoScroll')}
            >
              {autoScroll ? t('chat.scrollOn') : t('chat.scrollOff')}
            </button>
          )}
          <CopyBtn text={outputText || command} label={t('chat.copyOutput')} />
        </div>
      </div>

      {/* 执行命令行 */}
      <div className="terminal-exec-cmd-line">
        <span className="term-prompt">$</span>
        <span className="term-cmd-text">{command}</span>
        <CopyBtn text={command} label={t('chat.copyCmd')} />
      </div>

      {/* 终端实时/历史输出区域 */}
      <div className={`terminal-exec-body${expanded ? ' expanded' : ''}`}>
        {status === 'running' && !outputText ? (
          <div className="terminal-live-waiting">
            <span className="tool-call-spinner" />
            <span>{t('chat.procStarted', { s: elapsedSec })}</span>
            <span className="terminal-cursor">▋</span>
          </div>
        ) : (
          <div className="terminal-pre-wrap">
            <pre ref={preRef} className="terminal-exec-pre">
              {outputText}
              {status === 'running' && <span className="terminal-cursor">▋</span>}
            </pre>
            {status !== 'running' && !outputText && (
              <div className="terminal-empty-text">{t('chat.stdoutEmpty')}</div>
            )}
          </div>
        )}

        {status !== 'running' && exitCode !== null && (
          <div className={`terminal-exit-banner ${exitCode === 0 ? 'success' : 'error'}`}>
            <span>{exitCode === 0 ? t('chat.exitOk') : t('chat.exitBad', { code: exitCode })}</span>
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
              ? t('chat.collapseOutputProcess')
              : t('chat.expandOutputProcess', { n: totalLines })}
          </button>
        </div>
      )}
    </div>
  );
}

export function ToolCallCard({ message }: { message: ChatSessionMessage }) {
  const { t } = useI18n();
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

  const statusClass = status === 'running' ? ' running' : status === 'error' ? ' error' : ' done';
  const statusText =
    status === 'running'
      ? elapsedSec > 0
        ? t('chat.runningWithSec', { s: elapsedSec })
        : t('chat.runningEllipsis')
      : status === 'error'
        ? t('chat.statusFailed')
        : t('chat.statusDone');

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
        title={open ? t('chat.collapseProcessTip') : t('chat.expandProcessTip')}
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
          <span className="tool-call-name">{toolLabel(t, message.toolName)}</span>
          <span className="tool-call-status-text">{statusText}</span>
        </span>
        {summary && (
          <span className="tool-call-summary" title={summary}>
            {isTerminal ? `$ ${summary}` : summary}
          </span>
        )}
        <span className="tool-call-chevron">
          {open ? t('chat.collapseProcess') : t('chat.expandProcess')}
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
                    <span>{t('chat.args')}</span>
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
                    <span>{t('chat.result')}</span>
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
                  {t('chat.runningSecEllipsis', { s: elapsedSec })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
