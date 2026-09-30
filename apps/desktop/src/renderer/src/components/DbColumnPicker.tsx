import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import { isOnlyOneColumnVisible } from '../services/dbColumnLayout';

export interface DbColumnPickerProps {
  /** 结果集里的列（顺序即表头顺序） */
  columns: readonly string[];
  /** 列元数据（类型 / 主键），用于在条目上标出来 */
  metaOf: (column: string) => DatabaseColumnMeta | undefined;
  /** 当前被隐藏的列名 */
  hidden: readonly string[];
  /** 浮层锚点（视口坐标）；`align: 'right'` 表示把浮层右边缘贴在这个 x 上 */
  anchor: { x: number; y: number; align?: 'left' | 'right' };
  onToggle: (column: string, hidden: boolean) => void;
  onSetAll: (hidden: boolean) => void;
  onResetWidths: () => void;
  onClose: () => void;
}

/**
 * 列头右上角的「显示字段」按钮打开的列选择器。
 *
 * 63 列的表在表格里横向划很久才能找到目标列，这里一次性列出全部字段、可搜可勾。
 * 定位沿用 `DbColumnMenu` 的套路：先按锚点摆好，再用 `useLayoutEffect` 量真实尺寸做贴边翻转。
 */
export function DbColumnPicker({
  columns,
  metaOf,
  hidden,
  anchor,
  onToggle,
  onSetAll,
  onResetWidths,
  onClose,
}: DbColumnPickerProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [keyword, setKeyword] = useState<string>('');

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 锚点即浮层边缘，宽度由 CSS 决定、量出来多少就贴多少 ——
    // 不猜宽度，否则改了浮层样式（字号 / 内边距）锚点就偏了
    let x = anchor.align === 'right' ? anchor.x - rect.width : anchor.x;
    let y = anchor.y;
    if (x + rect.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - rect.width - 8);
    if (x < 8) x = 8;
    if (y + rect.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - rect.height - 8);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visibleCount = columns.filter((c) => !hiddenSet.has(c)).length;

  // 搜索只是过滤显示，不改变勾选状态 —— 勾选是「哪些列要显示」，与这里找不找得到无关
  const shown = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return [...columns];
    return columns.filter((c) => c.toLowerCase().includes(kw));
  }, [columns, keyword]);

  return (
    <div
      ref={ref}
      className="tab-context-menu db-column-menu db-column-picker"
      style={{ position: 'fixed', left: anchor.x, top: anchor.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="db-column-picker-head">
        <span className="db-column-picker-title">显示的字段</span>
        <span className="db-column-menu-hint">
          {visibleCount} / {columns.length}
        </span>
      </div>
      <input
        type="text"
        className="db-column-picker-search"
        placeholder="搜索字段名…"
        value={keyword}
        autoFocus
        onChange={(e) => setKeyword(e.target.value)}
      />
      <div className="db-column-picker-actions">
        <button type="button" className="db-column-picker-link" onClick={() => onSetAll(false)}>
          全选
        </button>
        <button
          type="button"
          className="db-column-picker-link"
          // 「全不选」按约定会留下一列，所以只剩最后一列时这个按钮已经没有意义了
          disabled={isOnlyOneColumnVisible(columns, hidden)}
          onClick={() => onSetAll(true)}
        >
          全不选
        </button>
        <button type="button" className="db-column-picker-link" onClick={onResetWidths}>
          重置列宽
        </button>
      </div>
      <div className="menu-divider" />
      <div className="db-column-picker-list">
        {shown.length === 0 && <div className="db-column-picker-empty">没有匹配的字段</div>}
        {shown.map((col) => {
          const meta = metaOf(col);
          const checked = !hiddenSet.has(col);
          return (
            <label key={col} className="db-column-picker-item">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onToggle(col, !e.target.checked)}
              />
              <span className="db-column-picker-name">{col}</span>
              {meta?.type && (
                <span className={`db-col-type${meta.pk ? ' pk' : ''}`}>
                  {meta.type}
                  {meta.pk ? ' (PK)' : ''}
                </span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}
