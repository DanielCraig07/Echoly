import { useCallback, useEffect, useMemo, useState } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-sql';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import { prettyPrintSql } from '../services/dbSqlPreview';
import { loadSqlBarExpanded, saveSqlBarExpanded } from '../services/sqlBarCollapsed';
import { describeFilter, describeSort, type DbTableViewState } from '../services/dbTableQuery';

export interface DbFilterSqlBarProps {
  /** 当前视图对应的完整语句（已含分页），由调用方用 `buildFullTableSql` 算好 */
  sql: string;
  view: DbTableViewState;
  columns: DatabaseColumnMeta[];
  /** 点击某条筛选 chip：打开浮层修改它 */
  onEditFilter: (column: string, anchor: { x: number; y: number }) => void;
  onRemoveFilter: (index: number) => void;
  onRemoveSort: (column: string) => void;
  onClearAll: () => void;
  onShowToast?: (title: string, detail?: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
}

/**
 * 左上角的「完整 SQL + 条件 chip」栏（图1）。
 *
 * 展示的永远是**当前这一屏真正要查的语句**（含 LIMIT/OFFSET），可整条复制 ——
 * 这是用户核对「筛选到底生效没有」「换到别的客户端跑一遍」的入口。
 * 下方保留可逐条删除的条件 chip：看语句是「知道查的是什么」，删条件是「改」，
 * 两者都需要，不能因为有了 SQL 展示就把 chip 收掉。
 *
 * 语法高亮用 Prism（`prism-sql` 已是既有依赖）。这里直接 import，不经 `MarkdownMessage` ——
 * 那个模块会连带拉起 31 个语法定义 + mermaid + katex，为一个 SQL 块付这个代价不值。
 *
 * 语句块**默认收起**（图3）：展开时它要占十来行，数据表会被压得只剩几行可看，
 * 而多数时候用户并不核对语句。展开态跨会话记忆，点标题条即可切换；标题条右侧的复制
 * 按钮与展开态无关，收起时也能一键把完整 SQL 拿走。
 */
export function DbFilterSqlBar({
  sql,
  view,
  columns,
  onEditFilter,
  onRemoveFilter,
  onRemoveSort,
  onClearAll,
  onShowToast,
}: DbFilterSqlBarProps) {
  const [copied, setCopied] = useState(false);
  /**
   * 语句块的展开态：默认收起，点标题条展开。
   *
   * 偏好跨会话记忆（见 `services/sqlBarCollapsed.ts`）—— 用户展开过一次，
   * 说明这个视图里他确实在核对语句，下次进来还该是展开的；
   * 但**首次**必须是收起的，否则「SQL 占掉半屏、数据看不见」就是所有新用户的默认体验。
   */
  const [expanded, setExpanded] = useState<boolean>(() => loadSqlBarExpanded());

  const toggleExpanded = useCallback(() => {
    setExpanded((v) => {
      const next = !v;
      saveSqlBarExpanded(next);
      return next;
    });
  }, []);

  // 收起时不跑格式化与高亮：语句每次筛选 / 翻页都会变，为一块看不见的文本做
  // Prism 词法分析是白白丢掉的主线程时间。展开的那一刻再算，useMemo 会把结果留住。
  const pretty = useMemo(() => (expanded ? prettyPrintSql(sql) : ''), [sql, expanded]);

  const html = useMemo(() => {
    if (!expanded) return null;
    try {
      return Prism.highlight(pretty, Prism.languages.sql, 'sql');
    } catch {
      // 语法定义缺失 / 高亮异常时退回纯文本：展示比高亮重要
      return null;
    }
  }, [pretty, expanded]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      onShowToast?.('已复制完整 SQL', sql, 'success');
    } catch {
      onShowToast?.('复制失败', undefined, 'error');
    }
  };

  const hasChips = view.filters.length > 0 || view.sorts.length > 0;

  return (
    <div className="db-sql-bar" data-expanded={expanded ? 'true' : 'false'}>
      <div className="db-sql-bar-head">
        {/* 标题条整条可点：折叠后它是唯一能把语句放出来的入口，
            把热区限制在箭头那一小块上，用户得对准了才点得开。 */}
        <button
          type="button"
          className="db-sql-bar-toggle"
          title={expanded ? '收起完整 SQL' : '展开完整 SQL'}
          aria-expanded={expanded}
          onClick={toggleExpanded}
        >
          <span className="db-sql-bar-chevron" aria-hidden="true">
            {expanded ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            )}
          </span>
          <span className="db-sql-bar-label">当前查询</span>
        </button>
        <button
          type="button"
          className="panel-action-btn"
          title={copied ? '已复制' : '复制完整 SQL'}
          onClick={() => void handleCopy()}
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="14" height="14" x="8" y="8" rx="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
          )}
        </button>
      </div>

      {/* 高亮后的 HTML 来自 Prism，内容是我们自己拼的 SQL（标识符已按驱动加引号），
          没有用户可控的 HTML 注入面 */}
      {expanded &&
        (html ? (
          <pre className="db-sql-block" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="db-sql-block">{pretty}</pre>
        ))}

      {hasChips && (
        <div className="db-view-chips">
          {view.filters.map((f, i) => (
            <span
              key={`f-${i}`}
              className="db-view-chip filter"
              title={`${f.column} — 点击可修改该筛选条件`}
              onClick={(e) =>
                onEditFilter(f.column, { x: e.clientX, y: e.clientY })
              }
            >
              筛选：{describeFilter(f, columns.find((c) => c.name === f.column)?.type)}
              <button
                type="button"
                className="db-chip-close"
                title="移除该筛选条件"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveFilter(i);
                }}
              >
                ✕
              </button>
            </span>
          ))}
          {view.sorts.map((s) => (
            <span key={`s-${s.column}`} className="db-view-chip sort" title="点击移除该排序">
              排序：{describeSort(s)}
              <button
                type="button"
                className="db-chip-close"
                title="移除该排序"
                onClick={() => onRemoveSort(s.column)}
              >
                ✕
              </button>
            </span>
          ))}
          <button type="button" className="db-chip-clear" onClick={onClearAll}>
            全部清空
          </button>
        </div>
      )}
    </div>
  );
}
