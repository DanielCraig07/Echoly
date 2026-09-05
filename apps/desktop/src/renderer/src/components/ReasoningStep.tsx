import { useState } from 'react';

/**
 * Cursor-style reasoning display: a subtle inline indicator line, no card/bubble.
 */
export function ReasoningStep({
  content,
  isStreaming = false,
}: {
  content: string;
  isStreaming?: boolean;
}) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled !== null ? userToggled : isStreaming;

  const firstLine = content.split('\n').find((l) => l.trim()) ?? 'thinking…';
  const preview = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;

  return (
    <div className={`reasoning-step${open ? ' open' : ''}`}>
      <div className="reasoning-step-header">
        <button
          type="button"
          className="reasoning-step-toggle"
          onClick={() => setUserToggled(!open)}
        >
          <span className="reasoning-step-dot">●</span>
          <span className="reasoning-step-label">思考过程</span>
          <span className="reasoning-step-preview">{!open ? preview : ''}</span>
          <span className="reasoning-step-chevron">{open ? '▲' : '▼'}</span>
        </button>
        {isStreaming && open && (
          <span className="reasoning-step-ellipsis">
            <span className="ellipsis-dot" />
            <span className="ellipsis-dot" />
            <span className="ellipsis-dot" />
          </span>
        )}
      </div>
      {open && (
        <div className="reasoning-step-body">
          <pre>{content}</pre>
        </div>
      )}
    </div>
  );
}
