import React, { useEffect, useState, useMemo } from 'react';
import type { ChatSessionMessage } from '@deepseek-ide/shared';
import { ToolCallCard, commandFromArgs } from '../ToolCallCard';
import { RenderFileTreeIcon } from '../FileIcons';

interface WorkedForGroupProps {
  messages: ChatSessionMessage[];
  isStreaming: boolean;
  onOpenFile?: (path: string) => void;
}

interface ExploreSubItem {
  id: string;
  action: string;
  filePath?: string;
  fileName?: string;
  rangeStr?: string;
  query?: string;
  rawMessage: ChatSessionMessage;
}

interface ExploreItem {
  id: string;
  type: 'explore';
  tools: ChatSessionMessage[];
  filesCount: number;
  searchesCount: number;
  isRunning: boolean;
  subItems: ExploreSubItem[];
}

interface TerminalItem {
  id: string;
  type: 'terminal';
  tool: ChatSessionMessage;
  command: string;
  isRunning: boolean;
}

interface EditItem {
  id: string;
  type: 'edit';
  tool: ChatSessionMessage;
  filePath: string;
  fileName: string;
  added: number;
  deleted: number;
  isRunning: boolean;
}

interface ReasoningItem {
  id: string;
  type: 'reasoning';
  message: ChatSessionMessage;
  content: string;
  durationSeconds: number;
  isRunning: boolean;
}

interface GenericToolItem {
  id: string;
  type: 'generic';
  tool: ChatSessionMessage;
  label: string;
  isRunning: boolean;
}

type TimelineItem = ExploreItem | TerminalItem | EditItem | ReasoningItem | GenericToolItem;

function parseJson(str?: string): any {
  if (!str?.trim()) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function buildExploreSubItem(tool: ChatSessionMessage): ExploreSubItem {
  const args = parseJson(tool.toolArgs) || {};
  const toolName = tool.toolName || '';

  if (toolName === 'read_file') {
    const filePath = (args.path || args.file || '').replace(/\\/g, '/');
    const fileName = filePath.split('/').filter(Boolean).pop() || filePath || 'file';
    let rangeStr = '';
    if (typeof args.start_line === 'number') {
      rangeStr =
        typeof args.end_line === 'number' && args.end_line !== args.start_line
          ? `#L${args.start_line}-${args.end_line}`
          : `#L${args.start_line}`;
    } else if (typeof args.offset === 'number') {
      const limit = typeof args.limit === 'number' ? args.limit : 0;
      rangeStr = limit > 0 ? `#L${args.offset}-${args.offset + limit}` : `#L${args.offset}`;
    }
    return {
      id: tool.id,
      action: '已分析',
      filePath,
      fileName,
      rangeStr,
      rawMessage: tool,
    };
  }

  if (toolName === 'search_code') {
    return {
      id: tool.id,
      action: '搜索代码',
      query: args.pattern || args.query || '',
      rawMessage: tool,
    };
  }

  if (toolName === 'glob_files') {
    return {
      id: tool.id,
      action: '匹配文件',
      query: args.pattern || args.glob || '',
      rawMessage: tool,
    };
  }

  if (toolName === 'list_dir') {
    return {
      id: tool.id,
      action: '列出目录',
      filePath: args.path || '.',
      rawMessage: tool,
    };
  }

  return {
    id: tool.id,
    action: '探索文件',
    rawMessage: tool,
  };
}

function formatWorkedDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.max(1, seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (remSec === 0 || minutes >= 3) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remSec}s`;
}

export function WorkedForGroup({ messages, isStreaming, onOpenFile }: WorkedForGroupProps) {
  const [toggledMap, setToggledMap] = useState<Record<string, boolean>>({});
  const [isExpanded, setIsExpanded] = useState<boolean>(isStreaming);
  const prevStreamingRef = React.useRef(isStreaming);
  const [liveDuration, setLiveDuration] = useState(0);

  // Live timer tick during streaming
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

  // When agent finishes (isStreaming becomes false), automatically collapse thinking process to match Figure 2
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      setIsExpanded(false);
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const timelineItems = useMemo(() => {
    const items: TimelineItem[] = [];
    let currentExplore: ChatSessionMessage[] = [];

    const flushExplore = () => {
      if (currentExplore.length === 0) return;
      const tools = [...currentExplore];
      currentExplore = [];

      const filePaths = new Set<string>();
      let searchesCount = 0;
      const subItems: ExploreSubItem[] = [];

      for (const t of tools) {
        const name = t.toolName || '';
        if (name === 'read_file') {
          const args = parseJson(t.toolArgs) || {};
          const p = (args.path || args.file || '').trim();
          if (p) filePaths.add(p);
        } else if (['search_code', 'glob_files', 'list_dir'].includes(name)) {
          searchesCount++;
        }
        subItems.push(buildExploreSubItem(t));
      }

      const filesCount = filePaths.size || tools.filter((t) => t.toolName === 'read_file').length;
      const isRunning = tools.some((t) => t.toolStatus === 'running');

      items.push({
        id: tools[0].id || `explore-${Date.now()}`,
        type: 'explore',
        tools,
        filesCount,
        searchesCount,
        isRunning,
        subItems,
      });
    };

    messages.forEach((m, idx) => {
      if (m.role === 'tool') {
        const name = m.toolName || '';
        if (['read_file', 'search_code', 'glob_files', 'list_dir'].includes(name)) {
          currentExplore.push(m);
        } else if (name === 'run_terminal') {
          flushExplore();
          const args = parseJson(m.toolArgs) || {};
          const command = (args.command || commandFromArgs(m.toolArgs) || 'command').trim();
          items.push({
            id: m.id,
            type: 'terminal',
            tool: m,
            command,
            isRunning: m.toolStatus === 'running',
          });
        } else if (['write_file', 'apply_patch'].includes(name)) {
          flushExplore();
          const args = parseJson(m.toolArgs) || {};
          const filePath = (args.path || args.file || '').replace(/\\/g, '/');
          const fileName = filePath.split('/').filter(Boolean).pop() || filePath || 'file';
          let added = 0;
          let deleted = 0;
          if (typeof args.old_text === 'string' || typeof args.new_text === 'string') {
            added = args.new_text ? args.new_text.split('\n').length : 0;
            deleted = args.old_text ? args.old_text.split('\n').length : 0;
          } else if (typeof args.content === 'string') {
            added = args.content.split('\n').length;
            deleted = 0;
          }
          items.push({
            id: m.id,
            type: 'edit',
            tool: m,
            filePath,
            fileName,
            added,
            deleted,
            isRunning: m.toolStatus === 'running',
          });
        } else {
          flushExplore();
          items.push({
            id: m.id,
            type: 'generic',
            tool: m,
            label: m.toolName || '工具调用',
            isRunning: m.toolStatus === 'running',
          });
        }
      } else if (m.role === 'assistant' && m.isIntermediate) {
        flushExplore();
        const prevMsg = idx > 0 ? messages[idx - 1] : null;
        const prevTime = prevMsg?.createdAt || m.createdAt || Date.now();
        const nextMsg = idx < messages.length - 1 ? messages[idx + 1] : null;
        const nextTime = nextMsg?.createdAt || Date.now();
        const durationSeconds = Math.max(1, Math.round((nextTime - prevTime) / 1000));
        items.push({
          id: m.id,
          type: 'reasoning',
          message: m,
          content: m.content || '',
          durationSeconds,
          isRunning: isStreaming && idx === messages.length - 1,
        });
      }
    });

    flushExplore();
    return items;
  }, [messages, isStreaming]);

  const totalDurationSeconds = useMemo(() => {
    if (!messages.length) return 1;
    let sumReasoning = 0;
    for (const item of timelineItems) {
      if (item.type === 'reasoning') {
        sumReasoning += item.durationSeconds || 0;
      }
    }
    const firstTime = messages[0]?.createdAt || 0;
    const lastTime = messages[messages.length - 1]?.createdAt || 0;
    const spanSeconds =
      firstTime && lastTime >= firstTime ? Math.round((lastTime - firstTime) / 1000) : 0;
    return Math.max(1, Math.max(spanSeconds, sumReasoning));
  }, [messages, timelineItems]);

  const displayDuration = isStreaming
    ? liveDuration || totalDurationSeconds
    : Math.max(totalDurationSeconds, liveDuration || 1);

  if (timelineItems.length === 0 && !isStreaming) return null;

  const isItemOpen = (item: TimelineItem, isLast: boolean) => {
    if (toggledMap[item.id] !== undefined) {
      return toggledMap[item.id];
    }
    // Auto-expand live in-progress actions
    if (item.isRunning) return true;
    if (isStreaming && isLast) return true;
    // Completed past items remain collapsed by default
    return false;
  };

  const toggleItem = (id: string, currentlyOpen: boolean) => {
    setToggledMap((prev) => ({
      ...prev,
      [id]: !currentlyOpen,
    }));
  };

  return (
    <div className="worked-for-group-container">
      <button
        type="button"
        className={`worked-for-summary-header${isStreaming ? ' is-streaming' : ''}${isExpanded ? ' is-open' : ''}`}
        onClick={() => setIsExpanded((prev) => !prev)}
        title={isExpanded ? '点击折叠思考过程' : '点击展开查看思考与工具调用详情'}
      >
        <span className="worked-for-label">
          {isStreaming
            ? `Working for ${formatWorkedDuration(displayDuration)}`
            : `Worked for ${formatWorkedDuration(displayDuration)}`}
        </span>
        <span className={`worked-for-chevron${isExpanded ? ' open' : ''}`}>›</span>
      </button>

      {isExpanded && (
        <div className="agent-timeline">
          {timelineItems.map((item, index) => {
            const isLast = index === timelineItems.length - 1;
            const open = isItemOpen(item, isLast);

            if (item.type === 'explore') {
              let label = '';
              if (item.isRunning) {
                if (item.filesCount > 0 && item.searchesCount > 0) {
                  label = `正在探索 ${item.filesCount} 个文件，${item.searchesCount} 次搜索`;
                } else if (item.filesCount > 0) {
                  label = `正在探索 ${item.filesCount} 个文件`;
                } else if (item.searchesCount > 0) {
                  label = `正在搜索代码`;
                } else {
                  label = '正在探索文件';
                }
              } else {
                if (item.filesCount > 0 && item.searchesCount > 0) {
                  label = `已探索 ${item.filesCount} 个文件，${item.searchesCount} 次搜索`;
                } else if (item.filesCount > 0) {
                  label = `已探索 ${item.filesCount} 个文件`;
                } else if (item.searchesCount > 0) {
                  label = `已执行 ${item.searchesCount} 次搜索`;
                } else {
                  label = '已探索完成';
                }
              }

              return (
                <div key={item.id} className="agent-timeline-item">
                  <button
                    type="button"
                    className={`agent-timeline-header${item.isRunning ? ' is-running' : ''}`}
                    onClick={() => toggleItem(item.id, open)}
                  >
                    <span className="agent-timeline-action">{label}</span>
                    <span className={`agent-timeline-chevron${open ? ' open' : ''}`}>›</span>
                  </button>

                  {open && (
                    <div className="agent-timeline-details">
                      {item.subItems.map((sub, sIdx) => (
                        <div key={`${sub.id}-${sIdx}`} className="agent-timeline-sub-row">
                          <span className="agent-timeline-sub-action">{sub.action}</span>
                          {sub.fileName && (
                            <>
                              <RenderFileTreeIcon name={sub.fileName} isDirectory={false} />
                              <strong
                                className="agent-timeline-filename clickable"
                                onClick={() => sub.filePath && onOpenFile?.(sub.filePath)}
                                title={sub.filePath}
                              >
                                {sub.fileName}
                              </strong>
                            </>
                          )}
                          {sub.rangeStr && (
                            <span className="agent-timeline-sub-range">{sub.rangeStr}</span>
                          )}
                          {sub.query && (
                            <code className="agent-timeline-cmd">"{sub.query}"</code>
                          )}
                          {sub.filePath && !sub.fileName && (
                            <span className="agent-timeline-sub-range">{sub.filePath}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }

            if (item.type === 'terminal') {
              return (
                <div key={item.id} className="agent-timeline-item">
                  <button
                    type="button"
                    className={`agent-timeline-header${item.isRunning ? ' is-running' : ''}`}
                    onClick={() => toggleItem(item.id, open)}
                  >
                    <span className="agent-timeline-action">
                      {item.isRunning ? '正在运行' : '已运行'}
                    </span>
                    <code className="agent-timeline-cmd">{item.command}</code>
                    <span className={`agent-timeline-chevron${open ? ' open' : ''}`}>›</span>
                  </button>

                  {open && (
                    <div className="agent-timeline-card-wrapper">
                      <ToolCallCard message={item.tool} />
                    </div>
                  )}
                </div>
              );
            }

            if (item.type === 'edit') {
              return (
                <div key={item.id} className="agent-timeline-item">
                  <button
                    type="button"
                    className={`agent-timeline-header${item.isRunning ? ' is-running' : ''}`}
                    onClick={() => toggleItem(item.id, open)}
                  >
                    <span className="agent-timeline-action">
                      {item.isRunning ? '正在编辑' : '已编辑'}
                    </span>
                    <RenderFileTreeIcon name={item.fileName} isDirectory={false} />
                    <strong
                      className="agent-timeline-filename clickable"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (item.filePath) onOpenFile?.(item.filePath);
                      }}
                      title={item.filePath}
                    >
                      {item.fileName}
                    </strong>
                    {item.added > 0 && (
                      <span className="agent-timeline-diff-add">+{item.added}</span>
                    )}
                    {item.deleted > 0 && (
                      <span className="agent-timeline-diff-del">-{item.deleted}</span>
                    )}
                    <span className={`agent-timeline-chevron${open ? ' open' : ''}`}>›</span>
                  </button>

                  {open && (
                    <div className="agent-timeline-card-wrapper">
                      <ToolCallCard message={item.tool} />
                    </div>
                  )}
                </div>
              );
            }

            if (item.type === 'reasoning') {
              return (
                <div key={item.id} className="agent-timeline-item">
                  <button
                    type="button"
                    className={`agent-timeline-header${item.isRunning ? ' is-running' : ''}`}
                    onClick={() => toggleItem(item.id, open)}
                  >
                    <span className="agent-timeline-action">
                      {item.isRunning
                        ? '深度思考中...'
                        : `深度思考 (${item.durationSeconds}s)`}
                    </span>
                    <span className={`agent-timeline-chevron${open ? ' open' : ''}`}>›</span>
                  </button>

                  {open && (
                    <div className="agent-timeline-thinking-box">
                      {item.content}
                    </div>
                  )}
                </div>
              );
            }

            if (item.type === 'generic') {
              return (
                <div key={item.id} className="agent-timeline-item">
                  <button
                    type="button"
                    className={`agent-timeline-header${item.isRunning ? ' is-running' : ''}`}
                    onClick={() => toggleItem(item.id, open)}
                  >
                    <span className="agent-timeline-action">
                      {item.isRunning ? `正在调用 ${item.label}` : `已调用 ${item.label}`}
                    </span>
                    <span className={`agent-timeline-chevron${open ? ' open' : ''}`}>›</span>
                  </button>

                  {open && (
                    <div className="agent-timeline-card-wrapper">
                      <ToolCallCard message={item.tool} />
                    </div>
                  )}
                </div>
              );
            }

            return null;
          })}

          {/* Live Working status indicator matching screenshot */}
          {isStreaming && (
            <div className="agent-timeline-working">
              <span className="agent-timeline-working-dot" />
              <span>处理中...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
