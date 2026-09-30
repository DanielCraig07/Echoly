import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DatabaseColumnMeta, DbConnectionView } from '@deepseek-ide/shared';
import { DbDdlView } from './DbDdlView';
import { DbColumnsView } from './DbColumnsView';
import { loadStructureViewMode, saveStructureViewMode, type StructureViewMode } from '../services/structureViewMode';
import type { DbDriverType } from '../services/dbIdentifiers';

export interface DbStructureViewProps {
  connectionId: string;
  tableName: string;
  schemaName?: string;
  theme?: string;
  /** 项目里保存的连接列表：驱动类型决定可用的列类型白名单与标识符引号 */
  connections?: DbConnectionView[];
  /**
   * 表被改名了。
   *
   * 往上传而不是在本组件里消化：改名要换标签路径与标签标题，那是 App 的事
   * （`App.handleTableRenamed`）。这一层只负责把名字原样递上去。
   */
  onRenamed?: (newTableName: string) => void;
  onShowToast?: (title: string, detail?: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
}

/** 驱动兜底：连接列表还没拉回来时按标签里的库名猜，与 `DbTableDataView` 同一口径 */
function resolveDriver(connId: string, schemaName: string | undefined, connections: DbConnectionView[]): DbDriverType {
  return connections.find((c) => c.id === connId)?.type ?? (schemaName === 'main' ? 'sqlite' : 'mysql');
}

/**
 * 「查看表结构」标签（`db://structure/*`）。
 *
 * 一个容器管三件事：
 * 1. 取数（列元数据 + DDL 原文 + 表注释）—— 两种视图共用同一份，切换形态不必重取；
 * 2. 工具条（DDL / 列 切换、刷新）—— 放在这一层而不是各自视图里，
 *    否则两种形态会各带一条工具条，切一次换一排按钮；
 * 3. 视图形态的记忆 —— 用户选过一次「列」，下次打开别的表也该是「列」。
 *
 * DDL 用 `dbGetTableDdl`（`SHOW CREATE TABLE` 原文），列用 `dbGetTableSchema`；
 * 两者**并行**取：串行会让先出来的那一半白等一次往返。
 */
export function DbStructureView({
  connectionId,
  tableName,
  schemaName,
  theme = 'vs-dark',
  connections = [],
  onRenamed,
  onShowToast,
}: DbStructureViewProps) {
  const [mode, setMode] = useState<StructureViewMode>(() => loadStructureViewMode());
  const [columns, setColumns] = useState<DatabaseColumnMeta[]>([]);
  const [ddl, setDdl] = useState<string>('');
  const [tableComment, setTableComment] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  /** 刷新计数：列视图的本地暂存要跟着重取后的元数据重建 */
  const [nonce, setNonce] = useState<number>(0);

  const driver = useMemo(
    () => resolveDriver(connectionId, schemaName, connections),
    [connectionId, schemaName, connections],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 表注释只在 `dbListTables` 的条目里。**SQLite 不发这个请求**：
      // 它的实现要对每张表跑一次 COUNT(*)（见 databaseService.listTables），
      // 只为拿一个「SQLite 根本没有的表注释」去数遍全库，代价完全不成比例。
      const wantComment = driver !== 'sqlite';
      const [schemaRes, ddlRes, tablesRes] = await Promise.all([
        window.ide.dbGetTableSchema(connectionId, tableName, schemaName),
        window.ide.dbGetTableDdl(connectionId, tableName, schemaName),
        wantComment
          ? window.ide.dbListTables(connectionId, schemaName)
          : Promise.resolve({ ok: false, tables: [], error: undefined }),
      ]);
      setColumns(schemaRes.ok ? schemaRes.columns || [] : []);
      setDdl(ddlRes.ok ? ddlRes.ddl || '' : '');
      const entry = tablesRes.ok
        ? (tablesRes.tables || []).find((t) => t.name === tableName)
        : undefined;
      setTableComment(entry?.comment ?? null);
      // DDL 拿不到不算致命（权限受限的库很常见）：列视图照常可用，只在 DDL 视图里说明
      const errs = [schemaRes.ok ? null : schemaRes.error, ddlRes.ok ? null : ddlRes.error].filter(Boolean);
      if (errs.length > 0) setError(errs.join('；'));
      setNonce((n) => n + 1);
    } catch (err: any) {
      setError(err?.message || String(err));
      setColumns([]);
      setDdl('');
      setTableComment(null);
    } finally {
      setLoading(false);
    }
  }, [connectionId, tableName, schemaName, driver]);

  useEffect(() => {
    void load();
  }, [load]);

  const switchMode = useCallback((next: StructureViewMode) => {
    setMode(next);
    saveStructureViewMode(next);
  }, []);

  const columnCount = useMemo(
    () => (loading ? undefined : String(columns.length)),
    [loading, columns.length],
  );

  return (
    <div className="db-structure-view">
      {/* 工具条：对齐 Maven 二级栏规范（height 30 / padding 0 10px / 下边框） */}
      <div className="db-structure-toolbar">
        <div className="db-structure-toolbar-left">
          <span className="db-structure-title" title={`${schemaName ? `${schemaName}.` : ''}${tableName}`}>
            {tableName}
          </span>
          {/* 分段切换：DDL 原文 / 可编辑列清单 */}
          <div className="db-segmented" role="group" aria-label="表结构展示形态">
            <button
              type="button"
              className={`db-segmented-btn${mode === 'columns' ? ' active' : ''}`}
              title="以列清单展示，可直接修改并应用"
              onClick={() => switchMode('columns')}
            >
              列
            </button>
            <button
              type="button"
              className={`db-segmented-btn${mode === 'ddl' ? ' active' : ''}`}
              title="查看建表语句原文"
              onClick={() => switchMode('ddl')}
            >
              DDL
            </button>
          </div>
          {columnCount !== undefined && <span className="db-structure-count">{columnCount} 列</span>}
        </div>
        <button
          type="button"
          className="panel-action-btn"
          title="重新读取表结构"
          disabled={loading}
          onClick={() => void load()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
        </button>
      </div>

      {loading ? (
        <div className="db-structure-placeholder">正在读取表结构…</div>
      ) : mode === 'ddl' ? (
        ddl ? (
          <DbDdlView key={`ddl-${nonce}`} ddl={ddl} theme={theme} />
        ) : (
          <div className="db-structure-placeholder">
            {error ? `无法读取建表语句：${error}` : '这张表没有可展示的建表语句。'}
          </div>
        )
      ) : (
        <DbColumnsView
          // 刷新后强制重建行：`columnsKey` 相同（结构没变）时组件内部不会重建，但 nonce 变了就该重置暂存
          key={`cols-${nonce}`}
          connectionId={connectionId}
          tableName={tableName}
          schemaName={schemaName}
          driver={driver}
          columns={columns}
          tableComment={tableComment}
          ddl={ddl}
          onApplied={() => void load()}
          onRenamed={onRenamed}
          onShowToast={onShowToast}
        />
      )}
    </div>
  );
}
