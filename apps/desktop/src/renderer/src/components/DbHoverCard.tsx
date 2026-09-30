import { useLayoutEffect, useRef } from 'react';
import type { DbColumnTooltip } from '../services/dbColumnTooltip';

export interface DbHoverCardProps {
  content: DbColumnTooltip;
  /** 目标元素的视口矩形：卡片挂在它下方，贴边时翻转 */
  anchor: { x: number; y: number; width: number; height: number };
}

/**
 * 字段悬浮卡片（图2）。
 *
 * ## 为什么不复用 `.tab-context-menu`
 *
 * 那套浮层样式把背景 / 边框写死成 `#141414 !important`，且**没有任何亮色覆写**，
 * 复用它等于把卡片钉死在暗色主题。这里用独立类名、颜色全部走主题变量。
 *
 * ## 为什么不写 `title`
 *
 * 全局 tooltip（`GlobalTooltip`）会**主动把元素的 `title` 摘走**改成纯文本提示，
 * 与本卡片是两套机制。所以挂载本卡片的元素上一律**不要写 `title`**，
 * 否则用户会看到两个提示（一个是纯文本的、一个是这张卡片）。
 *
 * 定位沿用仓库里统一的写法：`position: fixed` + `useLayoutEffect` 量真实尺寸后贴边翻转
 * （同 `DbColumnMenu` / `DbFilterPopover` / `DbColumnPicker`）。
 */
export function DbHoverCard({ content, anchor }: DbHoverCardProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = anchor.x;
    // 默认挂在目标下方；下面放不下就翻到上方
    let y = anchor.y + anchor.height + 6;
    if (y + rect.height > window.innerHeight - 8) {
      y = Math.max(8, anchor.y - rect.height - 6);
    }
    if (x + rect.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - rect.width - 8);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [anchor.x, anchor.y, anchor.width, anchor.height, content.title, content.typeLine]);

  return (
    <div
      ref={ref}
      className="db-hover-card"
      style={{ position: 'fixed', left: anchor.x, top: anchor.y }}
      role="tooltip"
    >
      <div className="db-hover-card-title">{content.title}</div>
      {content.typeLine && <div className="db-hover-card-type">{content.typeLine}</div>}
      <div className="db-hover-card-table">表：{content.tableLine}</div>
      {/* 注释来自数据库（MySQL / PG），SQLite 没有这个概念 —— 没有就整行不渲染，不显示一个空的「说明：」 */}
      {content.description && (
        <div className="db-hover-card-desc">说明：{content.description}</div>
      )}
    </div>
  );
}
