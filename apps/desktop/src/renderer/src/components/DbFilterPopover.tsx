import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import { PanelSelect } from './PanelSelect';
import {
  FILTER_OPERATOR_LABELS,
  operatorNeedsValue,
  type DbTableFilterCondition,
  type DbTableFilterOperator,
} from '../services/dbTableQuery';

export interface DbFilterPopoverProps {
  /** 要筛选的列名 */
  column: string;
  /** 该列的元数据（决定默认运算符与提示文案） */
  meta?: DatabaseColumnMeta;
  /** 打开时的初始条件（编辑已有筛选时传入） */
  initial?: DbTableFilterCondition;
  /** 只指定初始运算符（列头菜单直接点了「包含」这类条件时传入），不预填值 */
  initialOperator?: DbTableFilterOperator;
  /** 浮层锚点（视口坐标） */
  anchor: { x: number; y: number };
  onApply: (condition: DbTableFilterCondition) => void;
  onCancel: () => void;
}

/** 数值列优先给比较运算符，文本列优先给 LIKE 系列 —— 少一次手动切换 */
function defaultOperator(meta?: DatabaseColumnMeta): DbTableFilterOperator {
  const type = (meta?.type || '').toUpperCase();
  return /INT|DEC|NUM|REAL|FLOAT|DOUBLE|MONEY|SERIAL/.test(type) ? 'eq' : 'contains';
}

/**
 * 列筛选条件编辑浮层（列头漏斗 / 树上「按此列筛选…」共用）。
 *
 * 定位沿用 `DatabasePanel` 里右键菜单的套路：先按锚点摆好，再用 `useLayoutEffect`
 * 量一次真实尺寸做贴边翻转，避免被窗口右 / 下边缘裁掉。
 */
export function DbFilterPopover({
  column,
  meta,
  initial,
  initialOperator,
  anchor,
  onApply,
  onCancel,
}: DbFilterPopoverProps) {
  const [operator, setOperator] = useState<DbTableFilterOperator>(
    // 编辑已有条件 > 列头菜单点的那一项 > 按列类型给的默认值
    initial?.operator ?? initialOperator ?? defaultOperator(meta),
  );
  const [value, setValue] = useState<string>(
    initial?.value === null || initial?.value === undefined ? '' : String(initial.value),
  );
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 贴边翻转
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
  }, [anchor]);

  useEffect(() => {
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  const needsValue = operatorNeedsValue(operator);

  const submit = () => {
    // 「为空 / 非空」不带值；其余运算符留空视为未填完，不生成一个永远匹配不到的条件
    if (needsValue && !value.trim()) return;
    const numeric = /INT|DEC|NUM|REAL|FLOAT|DOUBLE|MONEY|SERIAL/.test((meta?.type || '').toUpperCase());
    const raw = numeric && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : value;
    onApply({ column, operator, value: needsValue ? raw : undefined });
  };

  return (
    <div
      ref={ref}
      className="tab-context-menu db-filter-popover"
      style={{ position: 'fixed', left: anchor.x, top: anchor.y, minWidth: 268 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="db-filter-popover-title">
        筛选「{column}」
        {meta?.type ? <span className="db-filter-popover-type">{meta.type}</span> : null}
      </div>

      <div className="db-filter-popover-row">
        {/* 用应用主题色的下拉而不是原生 <select>：macOS 的原生弹出层走系统 NSMenu，
            不受 CSS color-scheme 影响，暗色主题下会弹出一个浅灰的系统菜单 */}
        <PanelSelect<DbTableFilterOperator>
          className="db-filter-popover-select"
          value={operator}
          onChange={setOperator}
          title="选择比较运算符"
          options={(Object.keys(FILTER_OPERATOR_LABELS) as DbTableFilterOperator[]).map((op) => ({
            value: op,
            label: FILTER_OPERATOR_LABELS[op],
          }))}
        />
      </div>

      {needsValue && (
        <div className="db-filter-popover-row">
          <input
            ref={inputRef}
            type="text"
            className="db-filter-popover-control"
            placeholder="输入要比较的值，回车确定"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
      )}

      <div className="db-filter-popover-actions">
        <button type="button" className="panel-action-btn db-filter-popover-btn" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="panel-action-btn db-filter-popover-btn primary"
          onClick={submit}
          disabled={needsValue && !value.trim()}
        >
          应用
        </button>
      </div>
    </div>
  );
}
