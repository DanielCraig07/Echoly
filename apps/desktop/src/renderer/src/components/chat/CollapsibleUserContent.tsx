import { useEffect, useMemo, useRef, useState } from 'react';
import { parseContentWithCodeRefs, CodeRefPill } from './CodeRefPill';

const USER_BUBBLE_COLLAPSED_MAX_PX = 120;

/**
 * 用户消息气泡：过高的粘贴内容做 clamp + 展开/收起，避免撑爆消息列表。
 * 并将代码文件/行号引用渲染为图1所示的交互胶囊（点击跳转至指定行）。
 */
export function CollapsibleUserContent({
  content,
  onOpenFile,
}: {
  content: string;
  onOpenFile?: (path: string, line?: number, endLine?: number) => void;
}) {
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

  const segments = useMemo(() => parseContentWithCodeRefs(content), [content]);

  return (
    <div
      className={`msg-user-collapse${expanded ? ' expanded' : ''}${overflows ? ' overflows' : ''}`}
    >
      <div
        ref={bodyRef}
        className="msg-content-user"
        style={!expanded && overflows ? { maxHeight: USER_BUBBLE_COLLAPSED_MAX_PX } : undefined}
      >
        {segments.map((seg, idx) => {
          if (seg.type === 'ref' && seg.ref) {
            return <CodeRefPill key={idx} codeRef={seg.ref} onOpenFile={onOpenFile} />;
          }
          return <span key={idx}>{seg.value}</span>;
        })}
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
