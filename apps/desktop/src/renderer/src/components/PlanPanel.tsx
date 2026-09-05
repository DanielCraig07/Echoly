import { useEffect, useRef } from 'react';
import type { PlanProposal, PlanTodo } from '@deepseek-ide/shared';

interface Props {
  plan: PlanProposal;
  onChange: (plan: PlanProposal) => void;
  onExecute: () => void;
  onDismiss: () => void;
  busy?: boolean;
}

function autosizeTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.max(el.scrollHeight, 36)}px`;
}

export function PlanPanel({ plan, onChange, onExecute, onDismiss, busy }: Props) {
  const summaryRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    autosizeTextarea(summaryRef.current);
  }, [plan.summary]);

  function updateTodo(id: string, patch: Partial<PlanTodo>): void {
    onChange({
      ...plan,
      todos: plan.todos.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  }

  function addTodo(): void {
    const id = `t${plan.todos.length + 1}`;
    onChange({
      ...plan,
      todos: [...plan.todos, { id, content: '', status: 'pending' }],
    });
  }

  function removeTodo(id: string): void {
    onChange({
      ...plan,
      todos: plan.todos.filter((t) => t.id !== id),
    });
  }

  return (
    <div className="plan-panel">
      <div className="plan-panel-header">
        <strong>Plan</strong>
        <div className="actions">
          <button className="primary" disabled={busy || !plan.todos.length} onClick={onExecute}>
            开始执行
          </button>
          <button disabled={busy} onClick={onDismiss}>
            关闭
          </button>
        </div>
      </div>
      <input
        className="plan-title-input"
        value={plan.title}
        onChange={(e) => onChange({ ...plan, title: e.target.value })}
        placeholder="计划标题"
      />
      <textarea
        ref={summaryRef}
        className="plan-summary-input"
        value={plan.summary}
        onChange={(e) => {
          onChange({ ...plan, summary: e.target.value });
          autosizeTextarea(e.target);
        }}
        placeholder="计划摘要"
        rows={1}
      />
      <div className="plan-todos">
        {plan.todos.map((todo) => (
          <div key={todo.id} className="plan-todo">
            <input
              type="checkbox"
              checked={todo.status === 'completed'}
              onChange={(e) =>
                updateTodo(todo.id, { status: e.target.checked ? 'completed' : 'pending' })
              }
            />
            <input
              value={todo.content}
              onChange={(e) => updateTodo(todo.id, { content: e.target.value })}
              placeholder="待办步骤"
              title={todo.content}
            />
            <button onClick={() => removeTodo(todo.id)} title="删除">
              ×
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="plan-add-todo" onClick={addTodo}>
        + 添加步骤
      </button>
    </div>
  );
}
