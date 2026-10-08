import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useDbConfirm } from '../hooks/useDbConfirm';
import { buildSqlConfirmMarkdown } from '../services/dbConfirmContent';
import { PanelChevron } from './PanelChevron';

export interface AgentTaskStep {
  id: string;
  title: string;
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  command?: string;
  affectedFiles?: string[];
  output?: string;
  timestamp?: string;
}

export interface AgentTask {
  id: string;
  goal: string;
  status: 'planning' | 'running' | 'completed' | 'failed' | 'paused';
  createdAt: string;
  updatedAt: string;
  steps: AgentTaskStep[];
  totalFilesChanged?: number;
}

export interface AgentTaskPanelProps {
  workspaceRoot?: string | null;
  onOpenFile?: (filePath: string) => void;
  onShowToast?: (message: string, type?: 'info' | 'error' | 'success') => void;
  onSendToChat?: (prompt: string) => void;
}

// ── SVG 图标组件 ─────────────────────────────────────────────────────────────

function IconCheckCircle() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function IconSpinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
      <line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" />
      <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" /><line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
      <line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" /><line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
    </svg>
  );
}

function IconCircle() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}

function IconAlertCircle() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconReload({ spinning }: { spinning?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ animation: spinning ? 'spin 1s linear infinite' : undefined, display: 'block' }}>
      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function IconChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function IconFile() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function IconBot() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><path d="M12 7v4" />
      <line x1="8" y1="16" x2="8" y2="16" /><line x1="16" y1="16" x2="16" y2="16" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function IconCheckAll() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L7 17l-5-5" />
      <path d="m22 10-7.5 7.5L13 16" />
    </svg>
  );
}

// ── 格式化工具调用名称 ────────────────────────────────────────────────────────

function formatToolStepTitle(toolName: string, args?: any): { title: string; file?: string } {
  let file: string | undefined;
  if (args) {
    if (typeof args === 'object') {
      file = args.path || args.filePath || args.targetFile || args.TargetFile || args.AbsolutePath;
      if (!file && typeof args.CommandLine === 'string') {
        const cmd = args.CommandLine.trim();
        return { title: `执行命令: ${cmd.length > 32 ? cmd.slice(0, 32) + '…' : cmd}` };
      }
      if (!file && typeof args.query === 'string') {
        return { title: `检索代码: ${args.query}` };
      }
    }
  }

  const baseName = file ? file.split(/[/\\]/).pop() || file : '';

  switch (toolName) {
    case 'read_file':
    case 'view_file':
      return { title: baseName ? `读取代码: ${baseName}` : '读取工程文件', file };
    case 'write_to_file':
      return { title: baseName ? `新建/重写文件: ${baseName}` : '写入工程文件', file };
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return { title: baseName ? `修改代码实现: ${baseName}` : '编辑文件内容', file };
    case 'run_command':
    case 'run_terminal':
      return { title: '执行终端命令与环境构建' };
    case 'grep_search':
      return { title: '全局符号与关键词检索' };
    case 'list_dir':
      return { title: '扫描工程文件拓扑' };
    default:
      return { title: `执行工具: ${toolName}`, file };
  }
}

// ── 自定义主题风格下拉组件（对齐应用整体暗黑美学） ──────────────────────────────────

interface StyledSelectProps {
  tasks: AgentTask[];
  value: string;
  onChange: (val: string) => void;
  onNewTaskClick: () => void;
}

function StyledSelect({ tasks, value, onChange, onNewTaskClick }: StyledSelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const activeTask = tasks.find((t) => t.id === value) || tasks[0];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escHandler);
    };
  }, [open]);

  return (
    <div ref={containerRef} style={{ flex: 1, position: 'relative', minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          background: 'rgba(255, 255, 255, 0.04)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '4px 8px',
          fontSize: 12,
          outline: 'none',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          boxSizing: 'border-box',
          transition: 'all 0.15s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
            background: activeTask?.status === 'completed' ? '#10b981' : activeTask?.status === 'running' ? '#3b82f6' : 'rgba(255,255,255,0.3)',
            boxShadow: activeTask?.status === 'running' ? '0 0 6px rgba(59,130,246,0.6)' : undefined,
          }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, fontWeight: 500 }}>
            {activeTask?.goal || '选择任务目标...'}
          </span>
          {activeTask && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 4, flexShrink: 0 }}>
              {activeTask.steps.length} 步
            </span>
          )}
        </div>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
          style={{ flexShrink: 0, opacity: 0.7, transition: 'transform 0.15s ease', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          left: 0,
          right: 0,
          background: 'var(--bg-elevated, #1c2128)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
          zIndex: 99999,
          overflow: 'hidden',
          animation: 'tabMenuPop 0.12s cubic-bezier(0.16, 1, 0.3, 1)',
          maxHeight: 280,
          display: 'flex',
          flexDirection: 'column',
        }}>
          <div style={{ padding: '6px 10px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>任务历史 ({tasks.length})</span>
            <span style={{ fontSize: 10, opacity: 0.7 }}>点击切换</span>
          </div>

          <div style={{ overflowY: 'auto', flex: 1, padding: 4 }}>
            {tasks.map((task) => {
              const isSelected = task.id === value;
              const isDone = task.status === 'completed';
              const isRun = task.status === 'running';
              return (
                <div
                  key={task.id}
                  onClick={() => { onChange(task.id); setOpen(false); }}
                  style={{
                    padding: '7px 8px',
                    borderRadius: 6,
                    background: isSelected ? 'rgba(59,130,246,0.15)' : 'transparent',
                    color: isSelected ? '#60a5fa' : 'var(--text)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    transition: 'background 0.1s ease',
                  }}
                  onMouseEnter={(e) => { if (!isSelected) (e.currentTarget.style.background = 'rgba(255,255,255,0.05)'); }}
                  onMouseLeave={(e) => { if (!isSelected) (e.currentTarget.style.background = 'transparent'); }}
                >
                  <div style={{ flexShrink: 0 }}>
                    {isDone ? <IconCheckCircle /> : isRun ? <IconSpinner /> : <IconCircle />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isSelected ? 600 : 400 }}>
                      {task.goal}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', opacity: 0.7, marginTop: 1, display: 'flex', gap: 6 }}>
                      <span>{task.steps.length} 个步骤</span>
                      <span>•</span>
                      <span>{isDone ? '已完成' : isRun ? '执行中' : '规划中'}</span>
                      {task.updatedAt && (
                        <>
                          <span>•</span>
                          <span>{task.updatedAt}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ padding: '6px 8px', borderTop: '1px solid var(--border)', background: 'rgba(255,255,255,0.02)' }}>
            <button
              type="button"
              onClick={() => { setOpen(false); onNewTaskClick(); }}
              style={{
                width: '100%',
                background: 'rgba(59,130,246,0.08)',
                color: '#60a5fa',
                border: '1px dashed rgba(59,130,246,0.3)',
                borderRadius: 5,
                padding: '4px 8px',
                fontSize: 11,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
                fontWeight: 500,
              }}
            >
              <IconPlus /> 新建目标任务
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── AgentTaskPanel 组件 ────────────────────────────────────────────────────────

/** 任务状态的中文名（与左侧列表里那枚状态点用同一套说法） */
const TASK_STATUS_LABELS: Record<AgentTask['status'], string> = {
  planning: '规划中',
  running: '执行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
};

export function AgentTaskPanel({
  workspaceRoot,
  onOpenFile,
  onShowToast,
  onSendToChat,
}: AgentTaskPanelProps) {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const [newGoalInput, setNewGoalInput] = useState<string>('');
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<boolean>(false);
  const [addingStep, setAddingStep] = useState<boolean>(false);
  const [newStepTitle, setNewStepTitle] = useState<string>('');
  const tasksRef = useRef<AgentTask[]>([]);
  // 删除确认走应用内弹窗：系统 `window.confirm` 在 Electron 里不是应用主题色，
  // 也摆不出「删的是哪条任务、有多少步」这种可核对的键值行
  const confirm = useDbConfirm();

  const projectName = useMemo(() => {
    if (!workspaceRoot) return '默认工程';
    const norm = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    return norm.split('/').filter(Boolean).pop() || '当前工程';
  }, [workspaceRoot]);

  // 严格隔离各工程任务存储
  const storageKey = useMemo(() => {
    if (!workspaceRoot) return 'echoly_agent_tasks_global';
    const clean = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    return `echoly_agent_tasks_${encodeURIComponent(clean)}`;
  }, [workspaceRoot]);

  // 加载当前工程专属任务
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setTasks(parsed);
          tasksRef.current = parsed;
          setActiveTaskId(parsed[0].id);
          return;
        }
      }
    } catch { /* ignore */ }
    // 若当前工程未曾创建过任务，则置空，由用户开启专属规划
    setTasks([]);
    tasksRef.current = [];
    setActiveTaskId(null);
  }, [storageKey]);

  const saveTasks = useCallback(
    (updated: AgentTask[]) => {
      setTasks(updated);
      tasksRef.current = updated;
      try {
        localStorage.setItem(storageKey, JSON.stringify(updated));
      } catch { /* ignore */ }
    },
    [storageKey],
  );

  // ── 实时监听 AI Chat 任务生命周期与工具执行事件 ──────────────────────────
  useEffect(() => {
    // 1. 用户或 AI 开启新任务
    const handleTaskStart = (e: Event) => {
      const detail = (e as CustomEvent<{ prompt?: string; workspace?: string }>).detail;
      const prompt = detail?.prompt?.trim();
      if (!prompt) return;

      const cur = tasksRef.current;
      const nowStr = new Date().toLocaleTimeString();
      const ts = Date.now();

      // 若已有相同目标的任务且处于执行中，直接激活
      const existing = cur.find((t) => t.goal === prompt && t.status === 'running');
      if (existing) {
        setActiveTaskId(existing.id);
        return;
      }

      const newTask: AgentTask = {
        id: `task_${ts}`,
        goal: prompt.length > 50 ? prompt.slice(0, 50) + '…' : prompt,
        status: 'running',
        createdAt: nowStr,
        updatedAt: nowStr,
        steps: [
          {
            id: `step_${ts}_1`,
            title: '理解需求意图与工程上下文',
            status: 'completed',
            description: prompt,
            timestamp: nowStr,
          },
          {
            id: `step_${ts}_2`,
            title: '执行自主 Agent 规划与代码落地',
            status: 'running',
            timestamp: nowStr,
          },
        ],
      };

      const updated = [newTask, ...cur];
      saveTasks(updated);
      setActiveTaskId(newTask.id);
    };

    // 2. 工具开始执行（动态生成实时步骤）
    const handleStepStart = (e: Event) => {
      const detail = (e as CustomEvent<{ toolName?: string; toolArgs?: any; id?: string }>).detail;
      if (!detail?.toolName) return;

      const { title, file } = formatToolStepTitle(detail.toolName, detail.toolArgs);
      const cur = tasksRef.current;
      if (cur.length === 0) return;

      const runningIdx = cur.findIndex((t) => t.status === 'running');
      const targetIdx = runningIdx >= 0 ? runningIdx : 0;
      const targetTask = cur[targetIdx];

      // 将先前的 running 步骤置为 completed
      const updatedSteps = targetTask.steps.map((s) =>
        s.status === 'running' ? { ...s, status: 'completed' as const } : s,
      );

      const stepId = detail.id || `step_tool_${Date.now()}`;
      const newStep: AgentTaskStep = {
        id: stepId,
        title,
        status: 'running',
        affectedFiles: file ? [file] : undefined,
        timestamp: new Date().toLocaleTimeString(),
      };

      const nextTask: AgentTask = {
        ...targetTask,
        steps: [...updatedSteps, newStep],
        status: 'running',
        updatedAt: new Date().toLocaleTimeString(),
      };

      saveTasks(cur.map((t, i) => (i === targetIdx ? nextTask : t)));
    };

    // 3. 工具执行完成
    const handleStepDone = (e: Event) => {
      const detail = (e as CustomEvent<{
        toolName?: string;
        status?: AgentTaskStep['status'];
        result?: any;
        id?: string;
      }>).detail;
      const cur = tasksRef.current;
      if (cur.length === 0) return;

      const runningIdx = cur.findIndex((t) => t.status === 'running');
      const targetIdx = runningIdx >= 0 ? runningIdx : 0;
      const targetTask = cur[targetIdx];

      const outputSnippet =
        typeof detail?.result === 'string'
          ? detail.result.slice(0, 300)
          : detail?.result
            ? JSON.stringify(detail.result).slice(0, 300)
            : undefined;

      const updatedSteps = targetTask.steps.map((s) => {
        if (s.status === 'running') {
          return {
            ...s,
            status: (detail?.status || 'completed') as AgentTaskStep['status'],
            output: outputSnippet || s.output,
          };
        }
        return s;
      });

      const nextTask: AgentTask = {
        ...targetTask,
        steps: updatedSteps,
        updatedAt: new Date().toLocaleTimeString(),
      };

      saveTasks(cur.map((t, i) => (i === targetIdx ? nextTask : t)));
    };

    // 4. AI 整体执行完成（将所有运行中步骤与任务标记为完成）
    const handleTaskCompleted = (e: Event) => {
      const detail = (e as CustomEvent<{ summary?: string }>).detail;
      const cur = tasksRef.current;
      if (cur.length === 0) return;

      const runningIdx = cur.findIndex((t) => t.status === 'running');
      const targetIdx = runningIdx >= 0 ? runningIdx : 0;
      const targetTask = cur[targetIdx];

      let completedSteps = targetTask.steps.map((s) =>
        s.status === 'running' ? { ...s, status: 'completed' as const } : s,
      );

      // 若有阶段性总结，追加最后总结步骤
      if (detail?.summary && detail.summary !== '(cancelled)') {
        completedSteps = [
          ...completedSteps,
          {
            id: `step_done_${Date.now()}`,
            title: `任务执行完成`,
            description: detail.summary.length > 80 ? detail.summary.slice(0, 80) + '…' : detail.summary,
            status: 'completed' as const,
            timestamp: new Date().toLocaleTimeString(),
          },
        ];
      }

      const nextTask: AgentTask = {
        ...targetTask,
        steps: completedSteps,
        status: 'completed',
        updatedAt: new Date().toLocaleTimeString(),
      };

      saveTasks(cur.map((t, i) => (i === targetIdx ? nextTask : t)));
    };

    // 5. 任务失败处理
    const handleTaskFailed = () => {
      const cur = tasksRef.current;
      if (cur.length === 0) return;
      const runningIdx = cur.findIndex((t) => t.status === 'running');
      if (runningIdx < 0) return;
      const targetTask = cur[runningIdx];
      const updatedSteps = targetTask.steps.map((s) =>
        s.status === 'running' ? { ...s, status: 'failed' as const } : s,
      );
      const nextTask: AgentTask = {
        ...targetTask,
        steps: updatedSteps,
        status: 'failed',
        updatedAt: new Date().toLocaleTimeString(),
      };
      saveTasks(cur.map((t, i) => (i === runningIdx ? nextTask : t)));
    };

    window.addEventListener('echoly:agent-task-start', handleTaskStart);
    window.addEventListener('echoly:agent-step-start', handleStepStart);
    window.addEventListener('echoly:agent-step-done', handleStepDone);
    window.addEventListener('echoly:agent-task-completed', handleTaskCompleted);
    window.addEventListener('echoly:agent-task-failed', handleTaskFailed);

    return () => {
      window.removeEventListener('echoly:agent-task-start', handleTaskStart);
      window.removeEventListener('echoly:agent-step-start', handleStepStart);
      window.removeEventListener('echoly:agent-step-done', handleStepDone);
      window.removeEventListener('echoly:agent-task-completed', handleTaskCompleted);
      window.removeEventListener('echoly:agent-task-failed', handleTaskFailed);
    };
  }, [saveTasks]);

  const activeTask = useMemo(
    () => tasks.find((t) => t.id === activeTaskId) || tasks[0] || null,
    [tasks, activeTaskId],
  );

  // 手动一键将当前任务标记为完成（解决历史滞留问题）
  const handleMarkAllCompleted = () => {
    if (!activeTask) return;
    const nowStr = new Date().toLocaleTimeString();
    const updated = tasks.map((t) => {
      if (t.id !== activeTask.id) return t;
      return {
        ...t,
        status: 'completed' as const,
        updatedAt: nowStr,
        steps: t.steps.map((s) => ({ ...s, status: 'completed' as const })),
      };
    });
    saveTasks(updated);
    onShowToast?.('当前任务及所有步骤已标记为完成', 'success');
  };

  const handleCreateTask = () => {
    if (!newGoalInput.trim()) {
      onShowToast?.('请输入目标任务描述', 'error');
      return;
    }
    const ts = Date.now();
    const nowStr = new Date().toLocaleTimeString();
    const newTask: AgentTask = {
      id: `task_${ts}`,
      goal: newGoalInput.trim(),
      status: 'running',
      createdAt: nowStr,
      updatedAt: nowStr,
      steps: [
        {
          id: `step_${ts}_1`,
          title: `解析目标与工程「${projectName}」结构`,
          status: 'completed',
          description: '分析工程模块拓扑与调用链',
          timestamp: nowStr,
        },
        {
          id: `step_${ts}_2`,
          title: '拆解具体执行方案并执行代码实施',
          status: 'running',
          timestamp: nowStr,
        },
      ],
    };
    saveTasks([newTask, ...tasks]);
    setActiveTaskId(newTask.id);
    setNewGoalInput('');
    setIsCreating(false);
    onShowToast?.('已开启新 AI Agent 任务目标', 'success');
    onSendToChat?.(`目标任务：${newTask.goal}。请规划具体步骤并开始实施。`);
  };

  const handleDeleteTask = async (taskId: string) => {
    const target = tasks.find((t) => t.id === taskId);
    const ok = await confirm.confirm({
      title: '删除任务',
      content: buildSqlConfirmMarkdown({
        intro: '这条任务的**目标、全部步骤与执行记录**都会被删除，且无法撤销。',
        statements: [],
      }),
      details: [
        { label: '目标', value: target?.goal || '（无标题任务）' },
        { label: '状态', value: TASK_STATUS_LABELS[target?.status ?? 'planning'] ?? '' },
        { label: '步骤', value: `${target?.steps.length ?? 0} 步` },
      ],
      tone: 'danger',
      confirmLabel: '确认删除',
    });
    if (ok === null) return;
    const nextList = tasks.filter((t) => t.id !== taskId);
    saveTasks(nextList);
    if (activeTaskId === taskId) {
      setActiveTaskId(nextList.length > 0 ? nextList[0].id : null);
    }
    onShowToast?.('已移除该任务', 'info');
  };

  const cycleStepStatus = (taskId: string, stepId: string) => {
    const cycle: AgentTaskStep['status'][] = ['pending', 'running', 'completed', 'failed'];
    saveTasks(
      tasks.map((t) => {
        if (t.id !== taskId) return t;
        return {
          ...t,
          steps: t.steps.map((s) => {
            if (s.id !== stepId) return s;
            const idx = cycle.indexOf(s.status);
            return { ...s, status: cycle[(idx + 1) % cycle.length] };
          }),
          updatedAt: new Date().toLocaleTimeString(),
        };
      }),
    );
  };

  const handleAddStep = () => {
    if (!newStepTitle.trim() || !activeTask) return;
    const nextStep: AgentTaskStep = {
      id: `step_manual_${Date.now()}`,
      title: newStepTitle.trim(),
      status: 'pending',
      timestamp: new Date().toLocaleTimeString(),
    };
    saveTasks(
      tasks.map((t) =>
        t.id === activeTask.id
          ? {
              ...t,
              steps: [...t.steps, nextStep],
              updatedAt: new Date().toLocaleTimeString(),
            }
          : t,
      ),
    );
    setNewStepTitle('');
    setAddingStep(false);
  };

  const toggleStep = (stepId: string) => {
    setExpandedSteps((prev) => ({ ...prev, [stepId]: !prev[stepId] }));
  };

  return (
    <div
      className="agent-task-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        background: 'var(--bg-panel)',
        color: 'var(--text)',
        fontSize: 13,
        userSelect: 'none',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* ── 顶部栏（严格 30px、padding: 0 10px、.panel-action-btn） ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 30,
          padding: '0 10px',
          boxSizing: 'border-box',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div
          className="panel-header-title"
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--text)',
            letterSpacing: '0.05em',
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <PanelChevron expanded={true} size={12} />
          <span>AI 任务看板</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            type="button"
            className="panel-action-btn"
            title="刷新看板状态"
            onClick={() => {
              setLoading(true);
              setTimeout(() => setLoading(false), 300);
            }}
          >
            <IconReload spinning={loading} />
          </button>
          <button
            type="button"
            className="panel-action-btn"
            title="新建 AI 目标任务"
            onClick={() => setIsCreating((v) => !v)}
          >
            <IconPlus />
          </button>
          {activeTask && (
            <>
              {activeTask.status === 'running' && (
                <button
                  type="button"
                  className="panel-action-btn"
                  title="一键标记当前任务为已完成"
                  onClick={handleMarkAllCompleted}
                >
                  <IconCheckAll />
                </button>
              )}
              <button
                type="button"
                className="panel-action-btn"
                title="手动添加步骤"
                onClick={() => setAddingStep((v) => !v)}
              >
                <IconEdit />
              </button>
              <button
                type="button"
                className="panel-action-btn"
                title="删除当前任务"
                onClick={() => void handleDeleteTask(activeTask.id)}
              >
                <IconTrash />
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── 新建任务输入抽屉 ── */}
      {isCreating && (
        <div
          style={{
            padding: '8px 10px',
            borderBottom: '1px solid var(--border)',
            background: 'rgba(59,130,246,0.05)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>
            设定「{projectName}」AI 任务目标
          </div>
          <input
            type="text"
            value={newGoalInput}
            onChange={(e) => setNewGoalInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateTask();
              if (e.key === 'Escape') setIsCreating(false);
            }}
            placeholder="例如：重构用户登录模块并接入 JWT 验证..."
            style={{
              background: 'var(--bg-editor, #141414)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '5px 8px',
              fontSize: 12,
              outline: 'none',
            }}
            autoFocus
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button
              type="button"
              onClick={() => setIsCreating(false)}
              style={{
                background: 'transparent',
                border: '1px solid var(--border)',
                color: 'var(--text-muted)',
                borderRadius: 4,
                padding: '3px 8px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleCreateTask}
              style={{
                background: 'var(--accent, #3b82f6)',
                border: 'none',
                color: '#fff',
                borderRadius: 4,
                padding: '3px 10px',
                fontSize: 11,
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              开始规划
            </button>
          </div>
        </div>
      )}

      {/* ── 任务选择栏（自定义美化下拉组件）── */}
      {tasks.length > 0 && (
        <div
          style={{
            padding: '6px 10px',
            borderBottom: '1px solid var(--border)',
            background: 'rgba(255,255,255,0.02)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
          }}
        >
          <div style={{ color: 'var(--accent, #60a5fa)', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            <IconBot />
          </div>
          <StyledSelect
            tasks={tasks}
            value={activeTaskId || (tasks[0]?.id ?? '')}
            onChange={(val) => setActiveTaskId(val)}
            onNewTaskClick={() => setIsCreating(true)}
          />
        </div>
      )}

      {/* ── 主内容区 ── */}
      {!activeTask ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px 16px',
            textAlign: 'center',
            color: 'var(--text-muted)',
            gap: 12,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: 'rgba(59,130,246,0.12)',
              color: '#60a5fa',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <IconBot />
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            「{projectName}」任务看板
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.5, maxWidth: 260 }}>
            当前工程尚未创建 AI 规划任务。支持将复杂研发目标拆解为多步骤、可观测的自主 Agent 任务流。
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              onClick={() => setIsCreating(true)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '6px 14px',
                fontSize: 12,
                borderRadius: 6,
                background: 'var(--accent, #3b82f6)',
                color: '#fff',
                border: 'none',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              <IconPlus /> 新建目标任务
            </button>
            <button
              type="button"
              onClick={() => {
                const autoGoal = `为工程「${projectName}」优化代码架构并规划核心测试`;
                const ts = Date.now();
                const nowStr = new Date().toLocaleTimeString();
                const newTask: AgentTask = {
                  id: `task_${ts}`,
                  goal: autoGoal,
                  status: 'running',
                  createdAt: nowStr,
                  updatedAt: nowStr,
                  steps: [
                    {
                      id: `step_${ts}_1`,
                      title: `分析「${projectName}」工程依赖与核心调用链`,
                      status: 'completed',
                      description: '扫描工程结构、配置文件与技术栈拓扑',
                      timestamp: nowStr,
                    },
                    {
                      id: `step_${ts}_2`,
                      title: '制定模块优化方案与执行边界',
                      status: 'running',
                      description: '准备实施代码重构与逻辑增强',
                      timestamp: nowStr,
                    },
                  ],
                };
                saveTasks([newTask]);
                setActiveTaskId(newTask.id);
                onShowToast?.(`已为「${projectName}」开启专属 AI 目标规划`, 'success');
                onSendToChat?.(`目标任务：${autoGoal}。请结合「${projectName}」工程目录结构制定实施计划。`);
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '6px 12px',
                fontSize: 12,
                borderRadius: 6,
                background: 'rgba(255,255,255,0.06)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                cursor: 'pointer',
              }}
            >
              一键生成初始任务规划
            </button>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* 目标概览 */}
          <div
            style={{
              padding: '8px 12px',
              borderBottom: '1px solid var(--border)',
              background: 'rgba(255,255,255,0.02)',
              flexShrink: 0,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4 }}>
              {activeTask.goal}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 5,
                fontSize: 11,
                color: 'var(--text-muted)',
              }}
            >
              <span
                style={{
                  padding: '1px 6px',
                  borderRadius: 4,
                  fontWeight: 600,
                  background:
                    activeTask.status === 'completed'
                      ? 'rgba(16,185,129,0.15)'
                      : activeTask.status === 'running'
                        ? 'rgba(59,130,246,0.15)'
                        : 'rgba(255,255,255,0.08)',
                  color:
                    activeTask.status === 'completed'
                      ? '#34d399'
                      : activeTask.status === 'running'
                        ? '#60a5fa'
                        : 'var(--text-muted)',
                }}
              >
                {activeTask.status === 'completed'
                  ? '已完成'
                  : activeTask.status === 'running'
                    ? '执行中'
                    : '规划中'}
              </span>
              <span>{activeTask.steps.length} 个分解步骤</span>
              {activeTask.totalFilesChanged ? <span>• 变动 {activeTask.totalFilesChanged} 个文件</span> : null}
              <span style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 10 }}>
                更新 {activeTask.updatedAt}
              </span>
            </div>
          </div>

          {/* 手动添加步骤输入行 */}
          {addingStep && (
            <div
              style={{
                padding: '6px 10px',
                borderBottom: '1px solid var(--border)',
                background: 'rgba(59,130,246,0.04)',
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              <input
                type="text"
                value={newStepTitle}
                onChange={(e) => setNewStepTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddStep();
                  if (e.key === 'Escape') setAddingStep(false);
                }}
                placeholder="描述步骤内容..."
                style={{
                  flex: 1,
                  background: 'var(--bg-editor, #141414)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  padding: '4px 7px',
                  fontSize: 11,
                  outline: 'none',
                }}
                autoFocus
              />
              <button
                type="button"
                onClick={handleAddStep}
                style={{
                  background: 'var(--accent, #3b82f6)',
                  border: 'none',
                  color: '#fff',
                  borderRadius: 4,
                  padding: '3px 8px',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                添加
              </button>
              <button
                type="button"
                onClick={() => setAddingStep(false)}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  color: 'var(--text-muted)',
                  borderRadius: 4,
                  padding: '3px 6px',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                ×
              </button>
            </div>
          )}

          {/* 步骤时间轴 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-muted)',
                marginBottom: 6,
                paddingLeft: 4,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>步骤进展</span>
              <span style={{ opacity: 0.5, fontSize: 10, textTransform: 'none', letterSpacing: 0 }}>
                点击状态图标切换
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {activeTask.steps.map((step, idx) => {
                const isExpanded = !!expandedSteps[step.id];
                const borderColor =
                  step.status === 'running'
                    ? 'rgba(59,130,246,0.3)'
                    : step.status === 'completed'
                      ? 'rgba(16,185,129,0.15)'
                      : step.status === 'failed'
                        ? 'rgba(239,68,68,0.25)'
                        : 'var(--border)';
                const bg =
                  step.status === 'running'
                    ? 'rgba(59,130,246,0.06)'
                    : step.status === 'completed'
                      ? 'rgba(16,185,129,0.04)'
                      : step.status === 'failed'
                        ? 'rgba(239,68,68,0.05)'
                        : 'rgba(255,255,255,0.03)';
                const titleColor =
                  step.status === 'completed'
                    ? 'var(--text)'
                    : step.status === 'running'
                      ? '#93c5fd'
                      : step.status === 'failed'
                        ? '#f87171'
                        : 'var(--text-muted)';
                return (
                  <div
                    key={step.id}
                    style={{
                      borderRadius: 6,
                      background: bg,
                      border: `1px solid ${borderColor}`,
                      overflow: 'hidden',
                      transition: 'border-color 0.2s, background 0.2s',
                    }}
                  >
                    <div
                      style={{
                        padding: '6px 8px',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        cursor: 'pointer',
                      }}
                      onClick={() => toggleStep(step.id)}
                    >
                      <div
                        style={{ marginTop: 2, flexShrink: 0, cursor: 'pointer' }}
                        title="点击切换步骤状态"
                        onClick={(e) => {
                          e.stopPropagation();
                          cycleStepStatus(activeTask.id, step.id);
                        }}
                      >
                        {step.status === 'completed' && <IconCheckCircle />}
                        {step.status === 'running' && <IconSpinner />}
                        {step.status === 'pending' && <IconCircle />}
                        {step.status === 'failed' && <IconAlertCircle />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, color: titleColor, lineHeight: 1.3 }}>
                          {idx + 1}. {step.title}
                        </div>
                        {step.description && !isExpanded && (
                          <div
                            style={{
                              fontSize: 11,
                              color: 'var(--text-muted)',
                              marginTop: 2,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {step.description}
                          </div>
                        )}
                        {step.timestamp && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', opacity: 0.5, marginTop: 1 }}>
                            {step.timestamp}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="panel-action-btn"
                        title={isExpanded ? '折叠' : '展开'}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleStep(step.id);
                        }}
                      >
                        {isExpanded ? <IconChevronDown /> : <IconChevronRight />}
                      </button>
                    </div>
                    {isExpanded && (
                      <div
                        style={{
                          padding: '0 10px 8px 30px',
                          borderTop: '1px solid rgba(255,255,255,0.04)',
                          marginTop: 4,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          fontSize: 11,
                        }}
                      >
                        {step.description && (
                          <div style={{ color: 'var(--text-muted)', lineHeight: 1.4 }}>
                            {step.description}
                          </div>
                        )}
                        {step.output && (
                          <div
                            style={{
                              background: 'rgba(0,0,0,0.3)',
                              padding: '4px 6px',
                              borderRadius: 4,
                              fontFamily: 'var(--font-mono, monospace)',
                              color: '#a7f3d0',
                              fontSize: 10,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-all',
                            }}
                          >
                            {step.output}
                          </div>
                        )}
                        {step.affectedFiles && step.affectedFiles.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>
                              涉及文件：
                            </div>
                            {step.affectedFiles.map((f) => (
                              <div
                                key={f}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenFile?.(f);
                                }}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  color: '#60a5fa',
                                  cursor: 'pointer',
                                  textDecoration: 'underline',
                                }}
                              >
                                <IconFile />
                                <span>{f}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {/* 删除确认弹窗 */}
      {confirm.modal}
    </div>
  );
}
