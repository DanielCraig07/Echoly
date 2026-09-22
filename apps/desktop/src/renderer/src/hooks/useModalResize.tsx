import React, { useState, useRef, useCallback } from 'react';

export interface ModalResizeOptions {
  /** 本地存储 key，用于持久化弹窗宽高 */
  storageKey?: string;
  /** 默认宽度 (px) */
  defaultWidth: number;
  /** 默认高度 (px) */
  defaultHeight: number;
  /** 最小宽度 (px) */
  minWidth?: number;
  /** 最小高度 (px) */
  minHeight?: number;
  /** 最大宽度 (px) */
  maxWidth?: number;
  /** 最大高度 (px) */
  maxHeight?: number;
  /**
   * 是否采用居中定位的 2x delta 计算（默认 true）。
   * 居中定位弹窗中，鼠标在右下角向右/下移动 dx/dy 时，左右/上下对称扩张，
   * 尺寸需要变化 dx*2 / dy*2 才能使右下角角标 1:1 紧密跟随鼠标指针。
   */
  isCentered?: boolean;
}

export interface ModalSize {
  width: number;
  height: number;
}

/**
 * 纯函数计算拖动后的弹窗尺寸，支持上下左右双向计算并实施安全边界限制
 */
export function calculateModalResize({
  startX,
  startY,
  startW,
  startH,
  currentX,
  currentY,
  isCentered = true,
  minWidth = 360,
  minHeight = 240,
  maxWidth = 1800,
  maxHeight = 1400,
}: {
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  currentX: number;
  currentY: number;
  isCentered?: boolean;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
}): ModalSize {
  const dx = currentX - startX;
  const dy = currentY - startY;
  const factor = isCentered ? 2 : 1;

  // dx > 0 向右扩宽，dx < 0 向左收窄
  // dy > 0 向下拉高，dy < 0 向上缩短
  const newW = Math.round(Math.max(minWidth, Math.min(maxWidth, startW + dx * factor)));
  const newH = Math.round(Math.max(minHeight, Math.min(maxHeight, startH + dy * factor)));
  return { width: newW, height: newH };
}

export function loadModalSize(
  storageKey: string | undefined,
  defaultWidth: number,
  defaultHeight: number,
  minWidth = 360,
  minHeight = 240,
  maxWidth = 1800,
  maxHeight = 1400,
): ModalSize {
  if (typeof window !== 'undefined' && storageKey) {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (typeof parsed?.width === 'number' && typeof parsed?.height === 'number') {
          const w = Math.round(Math.max(minWidth, Math.min(maxWidth, parsed.width)));
          const h = Math.round(Math.max(minHeight, Math.min(maxHeight, parsed.height)));
          return { width: w, height: h };
        }
      }
    } catch {
      /* ignore */
    }
  }

  const initW = Math.round(Math.max(minWidth, Math.min(maxWidth, defaultWidth)));
  const initH = Math.round(Math.max(minHeight, Math.min(maxHeight, defaultHeight)));
  return { width: initW, height: initH };
}

export function useModalResize({
  storageKey,
  defaultWidth,
  defaultHeight,
  minWidth = 360,
  minHeight = 240,
  maxWidth,
  maxHeight,
  isCentered = true,
}: ModalResizeOptions) {
  const getWindowMaxW = () =>
    typeof window !== 'undefined' ? Math.round(Math.min(1800, window.innerWidth - 32)) : 1600;
  const getWindowMaxH = () =>
    typeof window !== 'undefined' ? Math.round(Math.min(1400, window.innerHeight - 32)) : 1000;

  const [modalSize, setModalSize] = useState<ModalSize>(() => {
    const effectiveMaxW = maxWidth || getWindowMaxW();
    const effectiveMaxH = maxHeight || getWindowMaxH();
    return loadModalSize(
      storageKey,
      defaultWidth,
      defaultHeight,
      minWidth,
      minHeight,
      effectiveMaxW,
      effectiveMaxH,
    );
  });

  const modalSizeRef = useRef(modalSize);
  modalSizeRef.current = modalSize;

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startY = e.clientY;
      const startW = modalSizeRef.current.width;
      const startH = modalSizeRef.current.height;

      setModalResizing(true);

      const onMouseMove = (moveEvent: MouseEvent) => {
        const effectiveMaxW = maxWidth || getWindowMaxW();
        const effectiveMaxH = maxHeight || getWindowMaxH();

        const newSize = calculateModalResize({
          startX,
          startY,
          startW,
          startH,
          currentX: moveEvent.clientX,
          currentY: moveEvent.clientY,
          isCentered,
          minWidth,
          minHeight,
          maxWidth: effectiveMaxW,
          maxHeight: effectiveMaxH,
        });

        modalSizeRef.current = newSize;
        setModalSize(newSize);
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';

        // 核心修复：拖动尺寸在外部松手时，拦截并吞掉紧随其后的任何 click 事件，防止误触发关闭遮罩
        const preventGhostClick = (clickEvent: MouseEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
          clickEvent.stopImmediatePropagation();
        };
        window.addEventListener('click', preventGhostClick, { capture: true, once: true });

        // 350ms 冷却保护期，保证拖拽完毕后鼠标在外面失焦或点击不会误关闭弹窗
        setTimeout(() => {
          setModalResizing(false);
          window.removeEventListener('click', preventGhostClick, { capture: true });
        }, 350);

        if (storageKey) {
          try {
            localStorage.setItem(storageKey, JSON.stringify(modalSizeRef.current));
          } catch {
            /* ignore */
          }
        }
      };

      document.body.style.cursor = 'nwse-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [isCentered, storageKey, minWidth, minHeight, maxWidth, maxHeight],
  );

  const resetSize = useCallback(() => {
    const effectiveMaxW = maxWidth || getWindowMaxW();
    const effectiveMaxH = maxHeight || getWindowMaxH();
    const size = {
      width: Math.round(Math.max(minWidth, Math.min(effectiveMaxW, defaultWidth))),
      height: Math.round(Math.max(minHeight, Math.min(effectiveMaxH, defaultHeight))),
    };
    setModalSize(size);
    modalSizeRef.current = size;
    if (storageKey) {
      try {
        localStorage.removeItem(storageKey);
      } catch {}
    }
  }, [defaultWidth, defaultHeight, minWidth, minHeight, maxWidth, maxHeight, storageKey]);

  return {
    modalSize,
    setModalSize,
    handleResizeStart,
    resetSize,
  };
}

/** 全局检查当前是否有弹窗正在拖拽调整大小 */
export function isModalResizing(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).__echoly_is_resizing_modal);
}

export function setModalResizing(val: boolean): void {
  if (typeof window !== 'undefined') {
    (window as any).__echoly_is_resizing_modal = val;
  }
}

/**
 * 为弹窗遮罩层 (Overlay) 提供安全关闭事件处理器：
 * 1. 拖拽调整窗口尺寸（Resize）期间及冷却时间内彻底拦截关闭；
 * 2. 严格双端校验：只有 mousedown 与 mouseup 均直接发生在遮罩层自身时才允许关闭，
 *    彻底解决在弹窗内按住鼠标（如拖选文字、点击控件）滑到外面松手导致弹窗直接关闭的恶劣交互！
 */
export function createSafeOverlayHandlers(onClose?: () => void) {
  let mouseDownOnOverlay = false;

  return {
    onMouseDown: (e: React.MouseEvent) => {
      mouseDownOnOverlay = e.target === e.currentTarget;
    },
    onMouseUp: (e: React.MouseEvent) => {
      if (isModalResizing()) {
        mouseDownOnOverlay = false;
        return;
      }
      if (mouseDownOnOverlay && e.target === e.currentTarget && onClose) {
        onClose();
      }
      mouseDownOnOverlay = false;
    },
    onClick: (e: React.MouseEvent) => {
      if (isModalResizing()) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}

export function ModalResizeHandle({
  onMouseDown,
  className = '',
  title = '拖动右下角调整大小 (支持上下左右)',
  style,
}: {
  onMouseDown: (e: React.MouseEvent) => void;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`ide-modal-resize-handle ${className}`.trim()}
      onMouseDown={onMouseDown}
      title={title}
      role="separator"
      aria-orientation="horizontal"
      style={style}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path
          d="M8.5 1.5L1.5 8.5M8.5 5L5 8.5M8.5 8.5L8.5 8.51"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
