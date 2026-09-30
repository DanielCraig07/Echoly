import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import {
  COMMON_FILTER_OPERATORS,
  FILTER_OPERATOR_ICONS,
  FILTER_OPERATOR_LABELS,
  MORE_FILTER_OPERATORS,
  operatorNeedsValue,
  type DbTableFilterOperator,
} from '../services/dbTableQuery';

export interface DbColumnMenuProps {
  column: string;
  meta?: DatabaseColumnMeta;
  /** 该列当前的排序方向；未排序为 null */
  sortDirection: 'asc' | 'desc' | null;
  /** 该列是否已有筛选条件 */
  hasFilter: boolean;
  /** 当前筛选条件的中文描述（有筛选时显示在菜单里，便于确认改的是哪一条） */
  filterSummary?: string;
  /** 浮层锚点（视口坐标） */
  anchor: { x: number; y: number };
  onSort: (direction: 'asc' | 'desc' | null) => void;
  /** 打开筛选浮层；带上运算符则是「直接按这个条件筛」，不带则是「让我自己选」 */
  onFilter: (operator?: DbTableFilterOperator) => void;
  /** 移除该列已有的筛选条件 */
  onClearFilter: () => void;
  /** 把这一列从表格里隐藏（走右上角「显示字段」再放回来） */
  onHide: () => void;
  onClose: () => void;
}

/**
 * 列头的「排序 / 筛选」下拉菜单。
 *
 * 取代原来分开的「点列名循环排序」+「漏斗按钮」两个热区：一个下拉里同时给出
 * 升序 / 降序 / 清除排序与筛选入口，命中区域更大、也不用让用户去猜列名是可点的。
 *
 * 定位沿用 `DatabasePanel` 右键菜单的套路：先按锚点摆好，再用 `useLayoutEffect`
 * 量一次真实尺寸做贴边翻转，避免被窗口右 / 下边缘裁掉。
 */
export function DbColumnMenu({
  column,
  meta,
  sortDirection,
  hasFilter,
  filterSummary,
  anchor,
  onSort,
  onFilter,
  onClearFilter,
  onHide,
  onClose,
}: DbColumnMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  /** 「更多筛选」二级是否展开（行内展开，不是悬浮飞出） */
  const [moreOpen, setMoreOpen] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = anchor.x;
    let y = anchor.y;
    if (x + rect.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - rect.width - 8);
    if (y + rect.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - rect.height - 8);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    // 展开「更多筛选」会把菜单撑高，这里必须跟着重量一次，否则底部项目会掉到窗口外
  }, [anchor, moreOpen]);

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

  return (
    <div
      ref={ref}
      className="tab-context-menu db-column-menu"
      style={{ position: 'fixed', left: anchor.x, top: anchor.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="db-column-menu-title">
        <span className="db-column-menu-name">{column}</span>
        {meta?.type ? <span className="db-column-menu-type">{meta.type}</span> : null}
      </div>
      <div className="menu-divider" />

      <div
        className={`menu-item${sortDirection === 'asc' ? ' menu-item-checked' : ''}`}
        role="menuitem"
        onClick={() => onSort('asc')}
      >
        <div className="menu-item-left">
          <span className="menu-item-icon">↑</span>
          <span>升序排序</span>
        </div>
        {sortDirection === 'asc' && <span className="db-column-menu-hint">当前</span>}
      </div>
      <div
        className={`menu-item${sortDirection === 'desc' ? ' menu-item-checked' : ''}`}
        role="menuitem"
        onClick={() => onSort('desc')}
      >
        <div className="menu-item-left">
          <span className="menu-item-icon">↓</span>
          <span>降序排序</span>
        </div>
        {sortDirection === 'desc' && <span className="db-column-menu-hint">当前</span>}
      </div>
      <div
        className="menu-item"
        role="menuitem"
        style={{ opacity: sortDirection ? 1 : 0.45, pointerEvents: sortDirection ? 'auto' : 'none' }}
        onClick={() => onSort(null)}
      >
        <div className="menu-item-left">
          <span className="menu-item-icon">✕</span>
          <span>清除排序</span>
        </div>
      </div>

      <div className="menu-divider" />

      <div className="menu-item" role="menuitem" onClick={() => onFilter()}>
        <div className="menu-item-left">
          <span className="menu-item-icon">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
            </svg>
          </span>
          <span>{hasFilter ? '修改筛选条件…' : '筛选…'}</span>
        </div>
        {hasFilter && <span className="db-column-menu-hint">已筛选</span>}
      </div>

      {/* 常用的几个条件直接摆出来：这条路径上（看一眼列就想筛掉空值 / 找包含某串的行）
          占绝大多数，让用户每次都点进浮层再选一次运算符是白费功夫 */}
      {COMMON_FILTER_OPERATORS.map((op) => (
        <div
          key={op}
          className="menu-item db-column-menu-sub-item"
          role="menuitem"
          title={
            operatorNeedsValue(op)
              ? `${FILTER_OPERATOR_LABELS[op]}：打开后输入要比较的值`
              : `${FILTER_OPERATOR_LABELS[op]}：无需填值，直接筛选`
          }
          onClick={() => onFilter(op)}
        >
          <div className="menu-item-left">
            <span className="menu-item-icon">{FILTER_OPERATOR_ICONS[op]}</span>
            <span>{FILTER_OPERATOR_LABELS[op]}{operatorNeedsValue(op) ? '…' : ''}</span>
          </div>
        </div>
      ))}

      {/* 其余运算符收进二级。用行内展开而不是悬浮飞出：本菜单是 fixed 定位，
          飞出层要么被窗口边缘裁掉，要么得再算一次贴边翻转，收益不抵复杂度 */}
      <div
        className={`menu-item db-column-menu-sub-item${moreOpen ? ' open' : ''}`}
        role="menuitem"
        title="其余比较与匹配条件"
        onClick={() => setMoreOpen((v) => !v)}
      >
        <div className="menu-item-left">
          <span className="menu-item-icon">{moreOpen ? '⌄' : '›'}</span>
          <span>更多筛选</span>
        </div>
        <span className="db-column-menu-hint">{MORE_FILTER_OPERATORS.length}</span>
      </div>
      {moreOpen &&
        MORE_FILTER_OPERATORS.map((op) => (
          <div
            key={op}
            className="menu-item db-column-menu-sub-item db-column-menu-sub-item-deep"
            role="menuitem"
            onClick={() => onFilter(op)}
          >
            <div className="menu-item-left">
              <span className="menu-item-icon">{FILTER_OPERATOR_ICONS[op]}</span>
              <span>{FILTER_OPERATOR_LABELS[op]}{operatorNeedsValue(op) ? '…' : ''}</span>
            </div>
          </div>
        ))}

      {hasFilter && (
        <>
          {filterSummary && <div className="db-column-menu-summary">{filterSummary}</div>}
          <div
            className="menu-item menu-item-danger"
            role="menuitem"
            onClick={onClearFilter}
          >
            <div className="menu-item-left">
              <span className="menu-item-icon">✕</span>
              <span>清除筛选</span>
            </div>
          </div>
        </>
      )}

      <div className="menu-divider" />

      {/* 隐藏列：字段多的表里「把这一列收起来」比来回横滚顺手，
          放回来后走右上角的「显示字段」—— 在菜单里只留单向入口，避免两个方向各写一套 */}
      <div className="menu-item" role="menuitem" title="隐藏这一列（用右上角「显示字段」可放回来）" onClick={onHide}>
        <div className="menu-item-left">
          <span className="menu-item-icon">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          </span>
          <span>隐藏这一列</span>
        </div>
      </div>
    </div>
  );
}
