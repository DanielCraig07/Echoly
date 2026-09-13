import React, { useEffect, useState, useMemo } from 'react';
import type { ChatSessionMessage } from '@deepseek-ide/shared';
import { commandFromArgs, parseTerminalResult } from '../ToolCallCard';

interface WorkedForGroupProps {
  messages: ChatSessionMessage[];
  isStreaming: boolean;
  onOpenFile?: (path: string, line?: number) => void;
}

interface StepItem {
  id: string;
  type: 'tool' | 'thought';
  badge: string;
  title: string;
  filePath?: string;
  line?: number;
  inContent?: string;
  outContent?: string;
  thoughtContent?: string;
  isRunning?: boolean;
  isError?: boolean;
  defaultThoughtOpen?: boolean;
}

function parseJson(str?: string): any {
  if (!str?.trim()) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/** 智能提炼 Bash 命令的业务意图作为标题后缀 */
function extractBashTitle(command: string, argsObj?: Record<string, any>): string {
  if (argsObj?.description && typeof argsObj.description === 'string') {
    return argsObj.description.trim();
  }
  if (argsObj?.thought && typeof argsObj.thought === 'string') {
    return argsObj.thought.trim();
  }
  const trimmed = command.trim();
  // 匹配注释: `command ... # 检查 EOL 情况`
  const commentMatch = trimmed.match(/#\s*([^\r\n]+)$/);
  if (commentMatch && commentMatch[1]) {
    return commentMatch[1].trim();
  }
  // 匹配 grep 命令
  if (trimmed.startsWith('grep') || trimmed.includes(' grep ')) {
    const qMatch = trimmed.match(/grep(?:\s+-[a-zA-Z0-9]+)*\s+["']([^"']+)["']/);
    if (qMatch && qMatch[1]) return `搜索 "${qMatch[1]}"`;
    return '搜索代码或文件';
  }
  if (trimmed.startsWith('sed ')) {
    return '查看指定代码行';
  }
  if (trimmed.startsWith('find ')) {
    return '查找文件路径';
  }
  if (trimmed.startsWith('git status')) return '检查仓库 Git 状态';
  if (trimmed.startsWith('git diff')) return '查看 Git 改动差异';
  if (trimmed.startsWith('git log')) return '查看 Git 提交历史';
  if (trimmed.startsWith('git checkout') || trimmed.startsWith('git restore')) return '还原 Git 文件改动';
  if (trimmed.startsWith('git ')) return `Git 操作: ${trimmed.slice(4, 32)}`;
  if (trimmed.startsWith('npm ') || trimmed.startsWith('pnpm ') || trimmed.startsWith('yarn ')) {
    return `执行脚本: ${trimmed.slice(0, 36)}`;
  }
  const firstLine = trimmed.split('\n')[0] || trimmed;
  return firstLine.length > 56 ? `${firstLine.slice(0, 56)}…` : firstLine;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * 独立的 IN / OUT 卡片组件
 * 严格按照截图还原：IN 与 OUT 两栏完全独立，均支持点击整行或按钮展开/折叠
 */
function InOutExecutionBox({
  inContent,
  outContent,
  isRunning = false,
  emptyOutText = '(Bash completed with no output)',
}: {
  inContent?: string;
  outContent?: string;
  isRunning?: boolean;
  emptyOutText?: string;
}) {
  const [inExpanded, setInExpanded] = useState(false);
  const [outExpanded, setOutExpanded] = useState(false);
  const [copiedIn, setCopiedIn] = useState(false);
  const [copiedOut, setCopiedOut] = useState(false);

  const inTrimmed = (inContent || '').trim();
  const outTrimmed = (outContent || '').trim();

  const inLines = inTrimmed ? inTrimmed.split('\n') : [];
  const outLines = outTrimmed ? outTrimmed.split('\n') : [];

  // 判断是否具备折叠/展开价值（单行过长或多行）
  const inCanToggle = inLines.length > 1 || inTrimmed.length > 120;
  const outCanToggle = outLines.length > 3 || outTrimmed.length > 180;

  const handleCopyIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!inTrimmed) return;
    void navigator.clipboard.writeText(inTrimmed).then(() => {
      setCopiedIn(true);
      setTimeout(() => setCopiedIn(false), 1200);
    });
  };

  const handleCopyOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!outTrimmed) return;
    void navigator.clipboard.writeText(outTrimmed).then(() => {
      setCopiedOut(true);
      setTimeout(() => setCopiedOut(false), 1200);
    });
  };

  return (
    <div className="tool-inout-box">
      {/* ─── IN 区域（对标 OUT 结构：展开后独占完整全宽代码块铺满卡片，按钮靠至最右侧） ─── */}
      {inTrimmed && (
        <div className="tool-inout-section has-border">
          <div
            className={`tool-inout-header${inCanToggle ? ' is-clickable' : ''}`}
            onClick={() => {
              if (inCanToggle) setInExpanded((prev) => !prev);
            }}
            title={
              inCanToggle
                ? inExpanded
                  ? '点击收起输入参数'
                  : '点击展开查看完整输入参数'
                : undefined
            }
          >
            <div className="tool-inout-header-left">
              <span className="tool-inout-tag">IN</span>
              {inExpanded ? (
                <span className="tool-inout-meta">
                  {inLines.length > 1 ? `${inLines.length} 行输入` : '完整输入'}
                </span>
              ) : (
                <div
                  className={`tool-inout-content${
                    inCanToggle ? ' collapsed-single' : ''
                  }`}
                >
                  {inTrimmed}
                </div>
              )}
            </div>
          </div>

          {/* 浮动操作按钮组（纯图标，鼠标悬浮时显现，不挤占排版，悬浮于上方） */}
          <div className="tool-inout-actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="tool-inout-btn tool-inout-copy-btn"
              onClick={handleCopyIn}
              title={copiedIn ? '已复制' : '复制输入'}
            >
              {copiedIn ? (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="#38bdf8">
                  <path
                    fillRule="evenodd"
                    d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"
                  />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5z"
                  />
                  <path
                    fillRule="evenodd"
                    d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"
                  />
                </svg>
              )}
            </button>
            {inCanToggle && (
              <button
                type="button"
                className="tool-inout-btn tool-inout-toggle-btn"
                onClick={() => setInExpanded((prev) => !prev)}
                title={inExpanded ? '收起输入' : '展开输入'}
              >
                {inExpanded ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M7.646 4.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1-.708.708L8 5.707l-5.646 5.647a.5.5 0 0 1-.708-.708l6-6z"
                    />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"
                    />
                  </svg>
                )}
              </button>
            )}
          </div>

          {/* 展开后作为独立的全宽代码块撑满整张卡片，避免挤在单行狭窄区域 */}
          {inExpanded && inCanToggle && (
            <div className="tool-inout-body tool-inout-in-body expanded-scroll">
              {inTrimmed}
            </div>
          )}
        </div>
      )}

      {/* ─── OUT 区域（优化结构：头部状态/操作栏 + 独立代码输出块，展开按钮靠到最右侧） ─── */}
      <div className="tool-inout-section">
        <div
          className={`tool-inout-header${outCanToggle ? ' is-clickable' : ''}`}
          onClick={() => {
            if (outCanToggle) setOutExpanded((prev) => !prev);
          }}
          title={
            outCanToggle
              ? outExpanded
                ? '点击收起输出结果'
                : '点击展开查看全部输出结果'
              : undefined
          }
        >
          <div className="tool-inout-header-left">
            <span className="tool-inout-tag">OUT</span>
            {outLines.length > 0 && (
              <span className="tool-inout-meta">
                {outLines.length} 行输出
              </span>
            )}
          </div>
        </div>

        {/* 浮动操作按钮组（纯图标，鼠标悬浮时显现，不挤占排版，悬浮于上方） */}
        <div className="tool-inout-actions" onClick={(e) => e.stopPropagation()}>
          {outTrimmed && (
            <button
              type="button"
              className="tool-inout-btn tool-inout-copy-btn"
              onClick={handleCopyOut}
              title={copiedOut ? '已复制' : '复制输出'}
            >
              {copiedOut ? (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="#38bdf8">
                  <path
                    fillRule="evenodd"
                    d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"
                  />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5z"
                  />
                  <path
                    fillRule="evenodd"
                    d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z"
                  />
                </svg>
              )}
            </button>
          )}
          {outCanToggle && (
            <button
              type="button"
              className="tool-inout-btn tool-inout-toggle-btn"
              onClick={() => setOutExpanded((prev) => !prev)}
              title={outExpanded ? '收起输出' : '展开输出'}
            >
              {outExpanded ? (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M7.646 4.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1-.708.708L8 5.707l-5.646 5.647a.5.5 0 0 1-.708-.708l6-6z"
                  />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z"
                  />
                </svg>
              )}
            </button>
          )}
        </div>

        {/* 独立的输出内容块，撑满整宽卡片 */}
        <div
          className={`tool-inout-body${
            !outExpanded && outCanToggle
              ? ' collapsed-multi'
              : outExpanded
                ? ' expanded-scroll'
                : ''
          }${!outExpanded && outCanToggle ? ' is-clickable' : ''}`}
          onClick={() => {
            if (!outExpanded && outCanToggle) setOutExpanded(true);
          }}
        >
          {isRunning ? (
            <span className="tool-inout-running">
              <span
                className="agent-timeline-working-dot"
                style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }}
              />
              {outTrimmed || '正在执行并等待输出...'}
              <span className="terminal-cursor">▋</span>
            </span>
          ) : outTrimmed ? (
            outTrimmed
          ) : (
            <span className="tool-inout-empty">{emptyOutText}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkedForGroup({ messages, isStreaming, onOpenFile }: WorkedForGroupProps) {
  // 初始状态：流式执行中默认展开，已完成的消息默认折叠
  const [isExpanded, setIsExpanded] = useState<boolean>(() => Boolean(isStreaming));
  const [thoughtToggles, setThoughtToggles] = useState<Record<string, boolean>>({});
  const [liveDuration, setLiveDuration] = useState(0);
  const prevStreamingRef = React.useRef(isStreaming);

  // 当从流式运行切换为完成（AI回复最终结果之后），自动折叠思考与执行过程
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      setIsExpanded(false);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // 流式实时计时器
  useEffect(() => {
    if (!isStreaming) return;
    const start = messages[0]?.createdAt || Date.now();
    const update = () => {
      setLiveDuration(Math.max(1, Math.round((Date.now() - start) / 1000)));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [isStreaming, messages]);

  // 将 messages 解析为对标截图的扁平执行步骤流
  const stepItems = useMemo<StepItem[]>(() => {
    const items: StepItem[] = [];

    messages.forEach((m, idx) => {
      if (m.role === 'tool') {
        const name = m.toolName || '';
        const args = parseJson(m.toolArgs) || {};
        const isRunning = m.toolStatus === 'running';
        const isError = m.toolStatus === 'error';

        if (name === 'run_terminal') {
          const command = (args.command || commandFromArgs(m.toolArgs) || 'bash').trim();
          const { cleanOutput } = parseTerminalResult(m.content || '');
          items.push({
            id: m.id || `bash-${idx}`,
            type: 'tool',
            badge: 'Bash',
            title: extractBashTitle(command, args),
            inContent: command,
            outContent: cleanOutput,
            isRunning,
            isError,
          });
        } else if (name === 'read_file') {
          const filePath = (args.path || args.file || '').replace(/\\/g, '/');
          const fileName = filePath.split('/').filter(Boolean).pop() || filePath || 'file';
          const targetLine =
            typeof args.start_line === 'number'
              ? args.start_line
              : typeof args.offset === 'number'
                ? args.offset
                : undefined;
          let rangeStr = '';
          if (typeof args.start_line === 'number') {
            rangeStr =
              typeof args.end_line === 'number' && args.end_line !== args.start_line
                ? `lines ${args.start_line}-${args.end_line}`
                : `line ${args.start_line}`;
          } else if (typeof args.offset === 'number') {
            const limit = typeof args.limit === 'number' ? args.limit : 0;
            rangeStr = limit > 0 ? `lines ${args.offset}-${args.offset + limit}` : `line ${args.offset}`;
          }

          items.push({
            id: m.id || `read-${idx}`,
            type: 'tool',
            badge: 'Read',
            title: `${fileName}${rangeStr ? ` (${rangeStr})` : ''}`,
            filePath,
            line: targetLine,
            inContent: rangeStr ? `${filePath} (${rangeStr})` : filePath,
            outContent: m.content || '(读取完成，内容为空)',
            isRunning,
            isError,
          });
        } else if (name === 'write_file' || name === 'apply_patch') {
          const filePath = (args.path || args.file || '').replace(/\\/g, '/');
          const fileName = filePath.split('/').filter(Boolean).pop() || filePath || 'file';
          let diffStr = '';
          if (args.old_text || args.new_text) {
            const add = args.new_text ? args.new_text.split('\n').length : 0;
            const del = args.old_text ? args.old_text.split('\n').length : 0;
            diffStr = `+${add} -${del}`;
          }
          items.push({
            id: m.id || `write-${idx}`,
            type: 'tool',
            badge: name === 'apply_patch' ? 'Patch' : 'Write',
            title: `${fileName}${diffStr ? ` (${diffStr})` : ''}`,
            filePath,
            inContent: args.content || args.new_text || args.patch || m.toolArgs || '',
            outContent: m.content || '(已写入并保存成功)',
            isRunning,
            isError,
          });
        } else if (name === 'search_code') {
          const query = args.pattern || args.query || '';
          items.push({
            id: m.id || `search-${idx}`,
            type: 'tool',
            badge: 'Search',
            title: query ? `"${query}"` : '搜索代码',
            inContent: args.path ? `query: "${query}"  path: ${args.path}` : `query: "${query}"`,
            outContent: m.content || '(搜索完成，无匹配结果)',
            isRunning,
            isError,
          });
        } else if (name === 'glob_files') {
          const pattern = args.pattern || args.glob || '';
          items.push({
            id: m.id || `glob-${idx}`,
            type: 'tool',
            badge: 'Glob',
            title: `匹配文件 "${pattern}"`,
            inContent: `pattern: "${pattern}"`,
            outContent: m.content || '(未匹配到文件)',
            isRunning,
            isError,
          });
        } else if (name === 'list_dir') {
          const path = args.path || '.';
          items.push({
            id: m.id || `list-${idx}`,
            type: 'tool',
            badge: 'List',
            title: `列出目录 ${path}`,
            inContent: `path: ${path}`,
            outContent: m.content || '(空目录)',
            isRunning,
            isError,
          });
        } else {
          // 通用工具调用
          items.push({
            id: m.id || `tool-${idx}`,
            type: 'tool',
            badge: name || 'Tool',
            title: m.toolName || '工具执行',
            inContent: m.toolArgs || '',
            outContent: m.content || '(无返回输出)',
            isRunning,
            isError,
          });
        }
      } else if (m.role === 'assistant' && m.isIntermediate) {
        // 深度思考节点
        const prevMsg = idx > 0 ? messages[idx - 1] : null;
        const prevTime = prevMsg?.createdAt || m.createdAt || Date.now();
        const nextMsg = idx < messages.length - 1 ? messages[idx + 1] : null;
        const nextTime = nextMsg?.createdAt || Date.now();
        const dur = Math.max(1, Math.round((nextTime - prevTime) / 1000));
        items.push({
          id: m.id || `thought-${idx}`,
          type: 'thought',
          badge: 'Thought',
          title: `Thought for ${dur}s`,
          thoughtContent: m.content || '',
          isRunning: isStreaming && idx === messages.length - 1,
        });
      }
    });

    return items;
  }, [messages, isStreaming]);

  // 总耗时计算
  const totalDurationSeconds = useMemo(() => {
    if (!messages.length) return 1;
    const firstTime = messages[0]?.createdAt || 0;
    const lastTime = messages[messages.length - 1]?.createdAt || 0;
    const span = firstTime && lastTime >= firstTime ? Math.round((lastTime - firstTime) / 1000) : 0;
    return Math.max(1, span);
  }, [messages]);

  const displayDuration = isStreaming
    ? liveDuration || totalDurationSeconds
    : Math.max(totalDurationSeconds, liveDuration || 1);

  if (stepItems.length === 0 && !isStreaming) return null;

  const toggleThought = (id: string) => {
    setThoughtToggles((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  return (
    <div className="worked-for-group-container">
      {/* 顶部总折叠条 */}
      <button
        type="button"
        className={`worked-for-summary-header${isStreaming ? ' is-streaming' : ''}${isExpanded ? ' is-open' : ''}`}
        onClick={() => setIsExpanded((prev) => !prev)}
        title={isExpanded ? '点击折叠执行过程' : '点击展开查看完整执行过程'}
      >
        <span className="worked-for-label">
          {isStreaming
            ? `Working for ${formatDuration(displayDuration)}`
            : `Worked for ${formatDuration(displayDuration)}`}
        </span>
        <span className={`worked-for-chevron${isExpanded ? ' open' : ''}`}>›</span>
      </button>

      {/* 完整对标用户截图的单线流式执行过程 */}
      {isExpanded && (
        <div className="agent-timeline-stream">
          {stepItems.map((step) => {
            const isRunning = step.isRunning;
            const isError = step.isError;
            const dotClass = isRunning
              ? 'is-running'
              : isError
                ? 'is-error'
                : step.type === 'thought'
                  ? 'is-thought'
                  : '';

            if (step.type === 'thought') {
              const isThoughtOpen = thoughtToggles[step.id] ?? false;
              return (
                <div key={step.id} className="agent-timeline-node">
                  <span className={`agent-timeline-dot ${dotClass}`} />
                  <div className="agent-timeline-row">
                    <button
                      type="button"
                      className="agent-timeline-header-btn"
                      onClick={() => toggleThought(step.id)}
                    >
                      <span className="agent-timeline-title">{step.title}</span>
                      <span className={`agent-timeline-chevron${isThoughtOpen ? ' open' : ''}`}>
                        ›
                      </span>
                    </button>
                  </div>
                  {isThoughtOpen && (
                    <div className="agent-timeline-thinking-box">{step.thoughtContent}</div>
                  )}
                </div>
              );
            }

            // 普通工具调用节点（含 IN 与 OUT 独立展开卡片）
            return (
              <div key={step.id} className="agent-timeline-node">
                <span className={`agent-timeline-dot ${dotClass}`} />
                <div className="agent-timeline-row">
                  <span className="agent-timeline-header-text">
                    <strong className="agent-timeline-badge">{step.badge}</strong>
                    <span
                      className={`agent-timeline-title${step.filePath ? ' clickable' : ''}`}
                      onClick={() => {
                        if (step.filePath) onOpenFile?.(step.filePath, step.line);
                      }}
                      title={step.filePath || step.title}
                    >
                      {step.title}
                    </span>
                  </span>
                </div>

                {/* 独立可分别展开的 IN / OUT 执行过程卡片 */}
                <InOutExecutionBox
                  inContent={step.inContent}
                  outContent={step.outContent}
                  isRunning={step.isRunning}
                />
              </div>
            );
          })}

          {/* 实时处理中状态提示 */}
          {isStreaming && (
            <div className="agent-timeline-node" style={{ marginBottom: 0 }}>
              <span className="agent-timeline-dot is-running" />
              <div className="agent-timeline-row">
                <span className="agent-timeline-title" style={{ color: 'var(--muted, #888888)' }}>
                  处理中...
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
