import { useEffect, useRef, useState } from 'react';
import type { ChatSessionMessage } from '@deepseek-ide/shared';
import { ToolCallCard, commandFromArgs } from '../ToolCallCard';
import { ReasoningStep } from '../ReasoningStep';

const STICK_THRESHOLD_PX = 80;

/**
 * 「处理过程 / 终端执行」折叠组：显示一段 agent 执行过程的时长、是否在运行，
 * 可展开查看内部 tool 调用与推理链。终端运行中或流式输出时自动展开。
 */
export function WorkedForGroup({
  messages,
  isStreaming,
}: {
  messages: ChatSessionMessage[];
  isStreaming: boolean;
}) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const [, setTick] = useState(0);

  // Live timer tick when streaming
  useEffect(() => {
    if (!isStreaming) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [isStreaming]);

  if (messages.length === 0) return null;

  const runningTerminal = messages.find(
    (m) => m.role === 'tool' && m.toolName === 'run_terminal' && m.toolStatus === 'running',
  );
  const runningCmd = runningTerminal ? commandFromArgs(runningTerminal.toolArgs) : null;
  const hasTerminal = messages.some((m) => m.role === 'tool' && m.toolName === 'run_terminal');

  // Auto-expand if a terminal is running or live streaming unless explicitly collapsed
  const open = userToggled !== null ? userToggled : isStreaming || Boolean(runningTerminal);

  const firstTime = messages[0].createdAt || Date.now();
  const lastTime = messages[messages.length - 1].createdAt || Date.now();
  const elapsedMs = isStreaming
    ? Math.max(1000, Date.now() - firstTime)
    : Math.max(1000, lastTime - firstTime);

  const formatDuration = (ms: number) => {
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  };

  const durationLabel = formatDuration(elapsedMs);

  return (
    <div className={`worked-for-group${open ? ' open' : ''}`}>
      <button
        type="button"
        className="worked-for-toggle"
        onClick={() => setUserToggled(!open)}
        title={open ? '点击收起执行过程' : '点击展开查看具体执行过程'}
      >
        <span className={`worked-for-icon${isStreaming ? ' spinning' : ''}`}>
          {isStreaming ? '◐' : '✓'}
        </span>
        <span>
          {isStreaming ? (
            runningCmd ? (
              <>
                <span className="worked-for-running-title">正在执行终端命令:</span>
                <code className="worked-for-cmd-inline" title={runningCmd}>
                  $ {runningCmd.length > 36 ? `${runningCmd.slice(0, 36)}…` : runningCmd}
                </code>
                <span className="worked-for-timer">({durationLabel})</span>
              </>
            ) : (
              `正在处理 (${durationLabel})`
            )
          ) : hasTerminal ? (
            `终端执行与过程 (${messages.length} 步，耗时 ${durationLabel})`
          ) : (
            `处理过程 (${messages.length} 步，耗时 ${durationLabel})`
          )}
        </span>
        <span className="worked-for-chevron">{open ? '▼ 收起过程' : '› 展开查看具体过程'}</span>
      </button>

      {open && (
        <div className="worked-for-body">
          {messages.map((m) =>
            m.role === 'tool' ? (
              <ToolCallCard key={m.id} message={m} />
            ) : (
              <ReasoningStep key={m.id} content={m.content} isStreaming={isStreaming} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
