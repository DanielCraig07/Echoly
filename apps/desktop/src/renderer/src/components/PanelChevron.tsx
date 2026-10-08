import React from 'react';

export interface PanelChevronProps {
  /** 是否展开（true: 向下展开，false: 向右折叠，默认 true） */
  expanded?: boolean;
  /** 尺寸大小（默认 12px） */
  size?: number;
  /** 自定义 class 类名 */
  className?: string;
  /** 自定义样式 */
  style?: React.CSSProperties;
  /** 图标颜色，默认继承 currentColor */
  color?: string;
  /** 提示文本 */
  title?: string;
  /** 点击事件 */
  onClick?: (e: React.MouseEvent<SVGSVGElement>) => void;
}

/**
 * 现代 IDE 风格精致矢量折叠箭头（Chevron）
 * 支持平滑 90 度旋转动画与微交互，对齐 VS Code / JetBrains 视觉标准
 */
export const PanelChevron: React.FC<PanelChevronProps> = ({
  expanded = true,
  size = 12,
  className = '',
  style,
  color,
  title,
  onClick,
}) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`panel-chevron-icon ${expanded ? 'expanded' : 'collapsed'} ${className}`.trim()}
      aria-label={title}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        color: color || 'inherit',
        transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
        transition: 'transform 0.15s cubic-bezier(0.2, 0, 0, 1), color 0.15s ease',
        cursor: onClick ? 'pointer' : 'inherit',
        verticalAlign: 'middle',
        ...style,
      }}
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M3.75 5.75L8 10L12.25 5.75"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

export default PanelChevron;
