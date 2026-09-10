import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface TargetRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface TooltipState {
  visible: boolean;
  text: string;
  targetRect: TargetRect | null;
  mouseY?: number;
}

interface GlobalTooltipProps {
  delay?: number;
}

export const GlobalTooltip: React.FC<GlobalTooltipProps> = ({ delay = 500 }) => {
  const [state, setState] = useState<TooltipState>({
    visible: false,
    text: '',
    targetRect: null,
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentTargetRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const delayRef = useRef(delay);

  useEffect(() => {
    delayRef.current = Math.max(500, delay ?? 500);
  }, [delay]);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const hide = () => {
      clearTimer();
      currentTargetRef.current = null;
      setState((prev) => (prev.visible ? { visible: false, text: '', targetRect: null } : prev));
    };

    const handleMouseOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.(
        '[title], [data-tooltip], [data-app-tooltip]',
      ) as HTMLElement | null;

      if (!el) {
        if (currentTargetRef.current) {
          hide();
        }
        return;
      }

      // 忽略 Monaco Editor 内部自带的代码 hover 提示
      if (el.closest('.monaco-editor') || el.closest('.monaco-hover')) {
        hide();
        return;
      }

      // 提取提示文字并移除原生 title 属性，防止触发系统丑陋的浅灰底原生弹框
      const nativeTitle = el.getAttribute('title');
      if (nativeTitle) {
        el.setAttribute('data-app-tooltip', nativeTitle);
        el.removeAttribute('title');
      }

      const text = el.getAttribute('data-app-tooltip') || el.getAttribute('data-tooltip');
      if (!text || !text.trim()) {
        hide();
        return;
      }

      if (currentTargetRef.current === el) {
        return;
      }

      clearTimer();
      currentTargetRef.current = el;

      const clientY = e.clientY;
      const waitMs = Math.max(500, delayRef.current ?? 500);
      timerRef.current = setTimeout(() => {
        if (currentTargetRef.current !== el || !document.body.contains(el)) return;

        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        setState({
          visible: true,
          text: text.trim(),
          targetRect: {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
          mouseY: clientY,
        });
      }, waitMs);
    };

    const handleMouseOut = (e: MouseEvent) => {
      const toEl = e.relatedTarget as HTMLElement | null;
      if (currentTargetRef.current && (!toEl || !currentTargetRef.current.contains(toEl))) {
        hide();
      }
    };

    const handleHideEvents = () => {
      hide();
    };

    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('mouseout', handleMouseOut, true);
    document.addEventListener('mousedown', handleHideEvents, true);
    window.addEventListener('scroll', handleHideEvents, true);
    window.addEventListener('resize', handleHideEvents, true);
    window.addEventListener('keydown', handleHideEvents, true);

    return () => {
      clearTimer();
      document.removeEventListener('mouseover', handleMouseOver, true);
      document.removeEventListener('mouseout', handleMouseOut, true);
      document.removeEventListener('mousedown', handleHideEvents, true);
      window.removeEventListener('scroll', handleHideEvents, true);
      window.removeEventListener('resize', handleHideEvents, true);
      window.removeEventListener('keydown', handleHideEvents, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!state.visible || !state.targetRect || !tooltipRef.current) return;

    const el = tooltipRef.current;
    const rect = state.targetRect;
    const tooltipW = el.offsetWidth;
    const tooltipH = el.offsetHeight;
    const padding = 10;
    const centerX = rect.left + rect.width / 2;

    // 水平位置：依据自身实际内容宽度在屏幕边界内自适应居中，避免贴近边缘时被挤压成纵向长条
    const left = Math.round(
      Math.max(padding, Math.min(window.innerWidth - padding - tooltipW, centerX - tooltipW / 2)),
    );
    // 小箭头始终指向触发按钮的水平中心
    const arrowLeft = Math.round(Math.max(8, Math.min(tooltipW - 8, centerX - left)));

    // 垂直位置：
    // 若目标高度较大（如纵向分割条等高度 > 60px 的纵向通栏组件），依据鼠标光标 Y 轴附近定位，防止落入视口底界外
    const isTall = rect.height > 60;
    let top: number;
    let placement: 'top' | 'bottom';

    if (isTall) {
      const anchorY = state.mouseY != null ? state.mouseY : (rect.top + rect.height / 2);
      if (anchorY > tooltipH + 20) {
        top = anchorY - tooltipH - 10;
        placement = 'top';
      } else {
        top = anchorY + 16;
        placement = 'bottom';
      }
    } else {
      const spaceBelow = window.innerHeight - rect.bottom;
      const preferTop = spaceBelow < tooltipH + 10 && rect.top > tooltipH + 10;
      placement = preferTop ? 'top' : 'bottom';
      top = preferTop ? rect.top - tooltipH - 6 : rect.bottom + 6;
    }

    // 严防溢出屏幕上下边界
    top = Math.round(Math.max(padding, Math.min(window.innerHeight - padding - tooltipH, top)));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.setProperty('--arrow-left', `${arrowLeft}px`);
    el.className = `global-app-tooltip placement-${placement}`;
    el.style.opacity = '1';
  }, [state.visible, state.targetRect, state.text, state.mouseY]);

  if (!state.visible || !state.text) return null;

  return (
    <div ref={tooltipRef} className="global-app-tooltip">
      {state.text}
    </div>
  );
};
