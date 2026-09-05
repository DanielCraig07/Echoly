import { useEffect, useRef, useState } from 'react';

const USER_BUBBLE_COLLAPSED_MAX_PX = 120;

/**
 * 用户消息气泡：过高的粘贴内容做 clamp + 展开/收起，避免撑爆消息列表。
 */
export function CollapsibleUserContent({ content }: { content: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [content]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    const measure = () => {
      // Measure unconstrained height so a collapsed max-height does not hide overflow.
      const prevMax = el.style.maxHeight;
      el.style.maxHeight = 'none';
      const full = el.scrollHeight;
      el.style.maxHeight = prevMax;
      setOverflows(full > USER_BUBBLE_COLLAPSED_MAX_PX + 4);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [content]);

  return (
    <div
      className={`msg-user-collapse${expanded ? ' expanded' : ''}${overflows ? ' overflows' : ''}`}
    >
      <div
        ref={bodyRef}
        className="msg-content-user"
        style={!expanded && overflows ? { maxHeight: USER_BUBBLE_COLLAPSED_MAX_PX } : undefined}
      >
        {content}
      </div>
      {overflows && (
        <button
          type="button"
          className="msg-user-expand-btn"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  );
}
