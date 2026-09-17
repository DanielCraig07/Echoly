import { useState } from 'react';
import type { ThinkingBlock as ThinkingBlockType } from '@deepseek-ide/shared';

interface Props {
  thinking: ThinkingBlockType[];
}

export function ThinkingBlock({ thinking }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!thinking?.length) return null;

  const totalText = thinking.map((t) => t.thinking).join('\n\n');
  const preview = totalText.substring(0, 150);
  const hasMore = totalText.length > 150;

  return (
    <div className="thinking-container">
      <div className="thinking-header" onClick={() => setExpanded(!expanded)}>
        <span className="thinking-icon">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04z" />
            <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04z" />
          </svg>
        </span>
        <span className="thinking-title">深度思考过程 (Thinking)</span>
        <span className="thinking-badge">
          {thinking.length} 步
        </span>
        {hasMore && <button type="button" className="thinking-toggle">{expanded ? '收起' : '展开详情'}</button>}
      </div>

      <div className={`thinking-content ${expanded ? 'expanded' : 'collapsed'}`}>
        {expanded ? (
          thinking.map((step, i) => (
            <div key={i} className="thinking-step">
              <div className="thinking-step-header">Step {i + 1}</div>
              <div className="thinking-step-content">{step.thinking}</div>
            </div>
          ))
        ) : (
          <div className="thinking-preview">
            {preview}
            {hasMore && '...'}
          </div>
        )}
      </div>
    </div>
  );
}
