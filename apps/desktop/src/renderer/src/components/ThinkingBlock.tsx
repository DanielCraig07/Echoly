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
        <span className="thinking-icon">💭</span>
        <span className="thinking-title">Extended Thinking</span>
        <span className="thinking-badge">{thinking.length} step{thinking.length > 1 ? 's' : ''}</span>
        {hasMore && (
          <button className="thinking-toggle">
            {expanded ? '折叠' : '展开'}
          </button>
        )}
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
          <div className="thinking-preview">{preview}{hasMore && '...'}</div>
        )}
      </div>
    </div>
  );
}
