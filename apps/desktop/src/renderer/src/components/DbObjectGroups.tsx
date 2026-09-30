import React from 'react';
import type { DbObjectGroup, DbSchemaObjects } from '@deepseek-ide/shared';

/**
 * 库节点展开后的六个分组（表 / 视图 / 索引 / 存储过程 / 触发器 / 事件）。
 *
 * 为什么不把对象都平铺在库下面：一个正经的库里表、视图、索引加起来动辄上百，
 * 平铺之后「这库里有没有视图」要靠肉眼扫。分组之后一眼就能看出每类的数量，
 * 空分组也如实显示 0 —— 那是「查过了，确实没有」，与「还没查」是两回事。
 *
 * 这里只管展示：数据来自 `dbListObjects`，展开状态与懒加载由面板自己管。
 */

/** 分组的展示顺序与中文名。顺序固定，不随数据变化，用户才能形成位置记忆 */
export const OBJECT_GROUPS: Array<{ key: DbObjectGroup; label: string }> = [
  { key: 'tables', label: 'Tables' },
  { key: 'views', label: 'Views' },
  { key: 'indexes', label: 'Indexes' },
  { key: 'procedures', label: 'Procedures' },
  { key: 'triggers', label: 'Triggers' },
  { key: 'events', label: 'Events' },
];

/** 分组展开后为空时的文案。空分组不能只留一片空白，那会被读成「还没加载」 */
export const EMPTY_GROUP_HINT: Record<DbObjectGroup, string> = {
  tables: '没有数据表',
  views: '没有视图',
  indexes: '没有索引',
  procedures: '没有存储过程',
  triggers: '没有触发器',
  events: '没有事件',
};

/** 分组的小图标，与表 / 库节点的视觉语言保持一致（都是 13×13 的线性图标） */
export function GroupIcon({ group }: { group: DbObjectGroup }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 24 24',
    fill: 'none',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (group) {
    case 'tables':
      return (
        <svg {...common} stroke="#60a5fa">
          <path d="M12 3v18" />
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M3 9h18" />
          <path d="M3 15h18" />
        </svg>
      );
    case 'views':
      // 眼睛：视图就是「看出去的一扇窗」
      return (
        <svg {...common} stroke="#34d399">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case 'indexes':
      return (
        <svg {...common} stroke="#fbbf24">
          <path d="M4 20h16" />
          <path d="M6 16h12" />
          <path d="M8 12h8" />
          <path d="M10 8h4" />
        </svg>
      );
    case 'procedures':
      // 大括号：一段可调用的代码块
      return (
        <svg {...common} stroke="#c084fc">
          <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" />
          <path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />
        </svg>
      );
    case 'triggers':
      return (
        <svg {...common} stroke="#f472b6">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case 'events':
      return (
        <svg {...common} stroke="#38bdf8">
          <circle cx="12" cy="13" r="8" />
          <path d="M12 9v4l2.5 2.5" />
          <path d="M9 2h6" />
        </svg>
      );
    default:
      return null;
  }
}

export interface DbGroupRowProps {
  group: DbObjectGroup;
  label: string;
  /** 该组下的对象个数。展开后渲染什么由调用方决定，这里只需要数字 */
  count: number;
  /** 驱动是否支持这一类；不支持时显示「不支持」并禁用展开 */
  supported: boolean;
  /** 该组单独的加载错误（某类查询失败只影响这一组） */
  error?: string;
  expanded: boolean;
  loading?: boolean;
  onToggle: () => void;
  /** 展开后的对象行 */
  children: React.ReactNode;
}

/** 一个分组的标题行 + 展开内容 */
export function DbGroupRow({
  group,
  label,
  count,
  supported,
  error,
  expanded,
  loading,
  onToggle,
  children,
}: DbGroupRowProps) {
  const disabled = !supported;
  return (
    <div>
      <div
        className={`db-tree-row${disabled ? ' disabled' : ''}`}
        style={{ padding: '3px 6px' }}
        onClick={() => {
          if (!disabled) onToggle();
        }}
        title={
          disabled
            ? `${label}：当前数据库类型不支持这一类对象`
            : `${label}（${count}）${expanded ? ' · 点击折叠' : ' · 点击展开'}`
        }
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          <span style={{ color: 'var(--text-muted)', display: 'flex', opacity: disabled ? 0.4 : 1 }}>
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </span>
          <span style={{ display: 'flex', opacity: disabled ? 0.4 : 1 }}>
            <GroupIcon group={group} />
          </span>
          <span
            style={{
              fontSize: 12,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: disabled ? 'var(--text-muted)' : undefined,
            }}
          >
            {label}
          </span>
          {!loading && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
              ({count})
            </span>
          )}
          {loading && (
            <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>…</span>
          )}
        </div>
        {/* 「不支持」与「0 个」必须能分开看：前者是驱动没这个能力，后者是确实没有 */}
        {disabled && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0, opacity: 0.75 }}>
            不支持
          </span>
        )}
      </div>
      {expanded && !disabled && (
        <div style={{ paddingLeft: 22, paddingBottom: 2 }}>
          {error && (
            <div style={{ fontSize: 10, color: '#f87171', padding: '2px 0' }} title={error}>
              加载失败：{error}
            </div>
          )}
          {!error && children}
        </div>
      )}
    </div>
  );
}

function ChevronRight() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** 一组对象行的通用外观（索引 / 存储过程 / 触发器 / 事件这些「只有名字」的组用） */
export function DbObjectRow({
  name,
  title,
  icon,
  trailing,
  onClick,
  onContextMenu,
}: {
  name: string;
  title?: string;
  icon: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="db-tree-row"
      style={{ fontSize: 11, padding: '2px 4px' }}
      title={title ?? name}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        <span style={{ display: 'flex', color: 'var(--text-muted)' }}>{icon}</span>
        <span
          style={{
            color: 'var(--text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {name}
        </span>
      </div>
      {trailing}
    </div>
  );
}

/** 从对象清单里安全取某一组（清单还没回来时给空数组，避免调用方到处写 `?.`） */
export function groupNames(objects: DbSchemaObjects | undefined, group: DbObjectGroup): string[] {
  if (!objects) return [];
  const list = objects[group];
  return Array.isArray(list) ? list : [];
}
