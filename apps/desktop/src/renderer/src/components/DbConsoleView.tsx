import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import Editor from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import type { DatabaseQueryResult, DbConnectionView } from '@deepseek-ide/shared';
import { resolveExecutableSql, splitSqlStatements } from '../services/sqlStatements';
import { formatCellValue } from '../services/dbCellDisplay';
import { PanelSelect } from './PanelSelect';
import { useI18n } from '../i18n';
import { useDbConfirm } from '../hooks/useDbConfirm';
import { buildSqlConfirmMarkdown } from '../services/dbConfirmContent';
import {
  provideSqlCompletions,
  getOrFetchTables,
  getOrFetchSchemas,
  type SqlMetadataProvider,
} from '../services/sqlCompletionService';

export interface DbConsoleViewProps {
  connectionId: string;
  /** MySQL 库名 / PostgreSQL schema 名 / SQLite 的 main；由左侧树当前节点决定 */
  schemaName?: string;
  initialSql?: string;
  theme?: string;
  /** 项目里保存的连接列表；用于在控制台内直接切换连接的库 */
  connections?: DbConnectionView[];
  /** 编辑内容回写（markDirty=false），保证切换标签页不丢失 SQL */
  onChangeContent?: (sql: string) => void;
  /**
   * 连接 / 库被切换时上报新的**执行目标**。
   *
   * 这里只上报「打到哪里去」，不改标签路径：
   * - 换库只是换个执行目标，脚本还是同一段脚本，不该因此换一页（早期版本会按「连接 × 库」另开标签，
   *   结果是用户在同一个脚本上试两个库，却得到两页内容各自演化的副本）；
   * - 换连接会连带标签路径里的连接段变化，由上层负责搬迁（脚本也一起挪到新连接目录下）。
   *
   * 标签路径与脚本文件名的拼接都在 App 里（`dbQueryScripts`），组件不猜路径格式。
   */
  onRetarget?: (
    target: { connectionId: string; schemaName?: string },
    kind: 'connection' | 'schema',
  ) => void;
  onShowToast?: (
    title: string,
    detail?: string,
    type?: 'success' | 'error' | 'info' | 'warn',
  ) => void;
}

interface StatementRun {
  index: number;
  sql: string;
  result: DatabaseQueryResult;
}

export interface SqlHistoryItem {
  id: string;
  sql: string;
  time: number;
  connectionId: string;
  ok: boolean;
}

export interface SqlFavoriteItem {
  id: string;
  title: string;
  sql: string;
  time: number;
}

/** 语句摘要：取第一行非空文本，过长则截断 */
function summarizeSql(sql: string, max = 60): string {
  const firstLine = sql
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('--') && !l.startsWith('/*'));
  const text = (firstLine || sql.trim().split('\n')[0] || '').replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function DbConsoleView({
  connectionId,
  schemaName,
  initialSql = 'SELECT 1;',
  theme = 'vs-dark',
  connections = [],
  onChangeContent,
  onRetarget,
  onShowToast,
}: DbConsoleViewProps) {
  const { t } = useI18n();
  // 收藏命名需要弹窗收集一个字符串，所以这里也要有自己的一个确认框实例
  const confirm = useDbConfirm();
  const [sql, setSql] = useState<string>(initialSql);
  const [runs, setRuns] = useState<StatementRun[]>([]);
  const [activeRunIndex, setActiveRunIndex] = useState<number>(0);
  const [executing, setExecuting] = useState<boolean>(false);
  const [splitRatio, setSplitRatio] = useState<number>(0.45); // 上部编辑器占比 45%

  // ── SQL 执行历史与常用收藏 ──
  const [showHistoryModal, setShowHistoryModal] = useState<boolean>(false);
  const [showFavoriteModal, setShowFavoriteModal] = useState<boolean>(false);
  const [historySearch, setHistorySearch] = useState<string>('');
  const [favoriteSearch, setFavoriteSearch] = useState<string>('');
  const [historyList, setHistoryList] = useState<SqlHistoryItem[]>(() => {
    try {
      const raw = localStorage.getItem('echoly:db_sql_history');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [favoritesList, setFavoritesList] = useState<SqlFavoriteItem[]>(() => {
    try {
      const raw = localStorage.getItem('echoly:db_sql_favorites');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });

  // ── 连接 / 库切换 ──
  //
  // 会话参数与 props 分开存本地：连接树的节点只决定控制台**打开时**用哪个库，
  // 打开之后用户在这里切换，就以此处为准，不受树上之后展开 / 点击的影响。
  const [activeConnId, setActiveConnId] = useState<string>(connectionId);
  const [activeSchema, setActiveSchema] = useState<string | undefined>(schemaName);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [loadingSchemas, setLoadingSchemas] = useState<boolean>(false);
  /** 当前打开的哪个下拉：连接、库，或都没开 */
  const [openSelect, setOpenSelect] = useState<'conn' | 'schema' | null>(null);
  /**
   * 最近一次由本组件**自己**回写出去的会话参数。
   *
   * 回写路径会让 `connectionId` / `schemaName` 这两个 prop 也跟着变，触发下面的同步 effect ——
   * 若不加区分，它会把刚打开待选的「库」下拉（`openSelect`）顺手关掉，
   * 于是「选完连接接着选库」这一步根本开不出来。值是自己写的就跳过同步。
   */
  const selfRetargetRef = useRef<{ connectionId: string; schemaName?: string } | null>(null);

  // 切换到别的控制台标签（本组件实例被复用）时，本地会话参数要跟着换过来
  useEffect(() => {
    const mine = selfRetargetRef.current;
    if (mine && mine.connectionId === connectionId && mine.schemaName === schemaName) return;
    setActiveConnId(connectionId);
    setActiveSchema(schemaName);
    setOpenSelect(null);
  }, [connectionId, schemaName]);

  // 拉取当前连接下的库 / schema 列表
  useEffect(() => {
    if (!activeConnId || !window.ide?.dbListSchemas) {
      setSchemas([]);
      return;
    }
    let cancelled = false;
    setLoadingSchemas(true);
    void window.ide
      .dbListSchemas(activeConnId)
      .then((res) => {
        if (cancelled) return;
        setSchemas(res.ok ? res.schemas.map((s) => s.name) : []);
      })
      .catch(() => {
        if (!cancelled) setSchemas([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingSchemas(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeConnId]);

  const activeConnIdRef = useRef(activeConnId);
  activeConnIdRef.current = activeConnId;
  const activeSchemaRef = useRef(activeSchema);
  activeSchemaRef.current = activeSchema;

  const metadataProviderRef = useRef<SqlMetadataProvider>({
    getConnectionId: () => activeConnIdRef.current,
    getSchemaName: () => activeSchemaRef.current,
  });

  // 当连接或库改变时，后台静默预热库表清单，使用户输入时 0ms 秒出提示
  useEffect(() => {
    if (activeConnId) {
      void getOrFetchSchemas(activeConnId);
      void getOrFetchTables(activeConnId, activeSchema);
    }
  }, [activeConnId, activeSchema]);

  /**
   * 注册 Monaco SQL 智能补全器（库、表、字段、别名、关键字）。
   *
   * 这里用 ref 取 `t` 而不是直接闭包：注册是**挂载期一次性的**，
   * 依赖数组为空，直接引用 `t` 会让全部补全说明锁死在首次语言上。
   */
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const disposable = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' '],
      provideCompletionItems(model, position) {
        return provideSqlCompletions(model, position, metadataProviderRef.current, tRef.current);
      },
    });
    return () => {
      disposable.dispose();
    };
  }, []);

  const connOptions = useMemo(
    () =>
      connections.map((c) => ({
        value: c.id,
        // 未连接的连接也列出来：选它的那一下会顺手连上，比先回树上连一次再回来选短
        label: `${c.connected ? '' : '○ '}${c.name}`,
      })),
    [connections],
  );

  const schemaOptions = useMemo(() => {
    const names = [...schemas];
    // 当前库不在列表里（列表还没回来，或树给的是个附加库）也要能显示出来
    if (activeSchema && !names.includes(activeSchema)) names.unshift(activeSchema);
    return names.map((name) => ({ value: name, label: name }));
  }, [schemas, activeSchema]);

  /**
   * 选连接。
   *
   * 分两步走：先把标签的**连接**换掉并复用原路径（这一步不能让「库」把路径叉成两个标签，
   * 否则用户只是想换个连接，却平白多出一个空控制台），连接就绪后接着换**库** ——
   * 那一步才另开标签，于是「连接 × 库」打开过的组合各自安家。
   */
  const handlePickConnection = useCallback(
    async (nextId: string) => {
      setOpenSelect(null);
      if (nextId === activeConnId) return;

      const prevConnId = activeConnId;
      const prevSchema = activeSchema;
      // 先把本地的连接换掉、库清空：接下来要先连、再拉库列表，都是异步的，
      // 中间这段空窗期界面上不该还写着上一个连接的库名（那是个已经失效的库）
      setActiveConnId(nextId);
      setActiveSchema(undefined);
      setSchemas([]);

      const target = connections.find((c) => c.id === nextId);
      const fail = (detail?: string) => {
        onShowToast?.(
          t('db.sqlConnectFailedTo', { name: target?.name ?? nextId }),
          detail,
          'error',
        );
        // 切不过去就退回原样，别把一个连不上的连接挂在控制台上
        setActiveConnId(prevConnId);
        setActiveSchema(prevSchema);
      };

      // 未连接的先连上：直接切过去的话，紧接着的 dbListSchemas 只会拿到一个「未连接」错误
      if (target && !target.connected && window.ide?.dbConnectSaved) {
        try {
          const res = await window.ide.dbConnectSaved(nextId);
          if (!res?.ok) {
            fail(res?.error);
            return;
          }
        } catch (err: any) {
          fail(err?.message || String(err));
          return;
        }
      }

      let names: string[] = [];
      try {
        const res = await window.ide?.dbListSchemas?.(nextId);
        names = res?.ok ? res.schemas.map((s) => s.name) : [];
      } catch {
        names = [];
      }

      setActiveConnId(nextId);
      setSchemas(names);
      // MySQL 一个连接下有多个库、PG 有多个 schema，所以选完连接必须再选一次库；
      // SQLite 只有 main，没得选就不打扰用户
      const nextSchema =
        names.length > 1 ? undefined : (names[0] ?? target?.database ?? prevSchema);
      setActiveSchema(nextSchema);
      selfRetargetRef.current = { connectionId: nextId, schemaName: nextSchema };
      onRetarget?.({ connectionId: nextId, schemaName: nextSchema }, 'connection');
      setOpenSelect(names.length > 1 ? 'schema' : null);
    },
    [activeConnId, connections, activeSchema, onRetarget, onShowToast, t],
  );

  /** 选库：只换执行目标，不动标签路径 —— 脚本是同一段，换库不该换一页 */
  const handlePickSchema = useCallback(
    (nextSchema: string) => {
      setOpenSelect(null);
      setActiveSchema(nextSchema);
      selfRetargetRef.current = { connectionId: activeConnId, schemaName: nextSchema };
      onRetarget?.({ connectionId: activeConnId, schemaName: nextSchema }, 'schema');
    },
    [activeConnId, onRetarget],
  );

  const isDragging = useRef<boolean>(false);
  const editorRef = useRef<any>(null);
  /** 最近一次由本组件回写出去的文本，避免外部 props 回流造成光标跳动 */
  const lastEmittedRef = useRef<string>(initialSql);

  // 仅当外部传入的内容既不是本组件刚回写的、也与当前本地内容不同步时才覆盖（切换标签页 / 重新打开时生效）
  useEffect(() => {
    if (initialSql === lastEmittedRef.current) return;
    lastEmittedRef.current = initialSql;
    setSql(initialSql);
  }, [initialSql, connectionId]);

  const handleEditorChange = useCallback(
    (value: string) => {
      lastEmittedRef.current = value;
      setSql(value);
      onChangeContent?.(value);
    },
    [onChangeContent],
  );

  /**
   * 执行 SQL。
   * - `mode = 'auto'`：有选区跑选中内容，否则跑光标所在语句
   * - `mode = 'all'`：整篇按 `;` 切分后顺序执行（脚本里的 `use xxx;` 会影响后续语句）
   */
  const execute = useCallback(
    async (mode: 'auto' | 'all') => {
      if (!window.ide?.dbQuery || !activeConnId) return;

      const editor = editorRef.current;
      let targetSql: string;

      if (mode === 'all') {
        targetSql = sql;
      } else if (editor) {
        const model = editor.getModel();
        const selection = editor.getSelection();
        const hasSelection = selection && model && !selection.isEmpty();
        targetSql = resolveExecutableSql(
          sql,
          hasSelection
            ? {
                start: model.getOffsetAt(selection.getStartPosition()),
                end: model.getOffsetAt(selection.getEndPosition()),
                text: model.getValueInRange(selection),
              }
            : null,
          selection && model ? model.getOffsetAt(selection.getPosition()) : 0,
        );
      } else {
        targetSql = sql;
      }

      if (!targetSql.trim()) {
        onShowToast?.(t('db.sqlNeedSql'), undefined, 'error');
        return;
      }

      // 多语句脚本逐条执行，单条失败不阻断后续语句（便于 `show databases; use x; show tables;` 这类脚本）
      const statements = splitSqlStatements(targetSql);
      if (statements.length === 0) {
        onShowToast?.(t('db.sqlNoExecutable'), undefined, 'error');
        return;
      }

      try {
        setExecuting(true);
        const collected: StatementRun[] = [];
        // 脚本里出现 `use xxx;` 之后不再下发控制台自身的 schemaName，
        // 否则主进程会在下一条语句前把会话切回原库，脚本里显式的切库会「失效一次」。
        let schemaOverride: string | undefined = activeSchema;
        for (let i = 0; i < statements.length; i += 1) {
          const text = statements[i].text;
          const res = await window.ide.dbQuery(activeConnId, text, 1, 200, schemaOverride);
          collected.push({ index: i + 1, sql: text, result: res });
          if (/^\s*use\s/i.test(text)) schemaOverride = undefined;
        }
        setRuns(collected);
        // 默认展示最后一个有结果集的语句
        const withRows = collected.filter((r) => r.result.columns.length > 0);
        setActiveRunIndex(
          (withRows.length > 0 ? withRows[withRows.length - 1] : collected[collected.length - 1])
            .index,
        );

        const failed = collected.filter((r) => !r.result.ok);
        const totalMs = collected.reduce((sum, r) => sum + (r.result.executionTimeMs || 0), 0);

        // 自动存入 SQL 执行历史记录 (最多保留 50 条)
        const historyItem: SqlHistoryItem = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          sql: targetSql.trim(),
          time: Date.now(),
          connectionId: activeConnId,
          ok: failed.length === 0,
        };
        setHistoryList((prev) => {
          const filtered = prev.filter((item) => item.sql !== historyItem.sql);
          const next = [historyItem, ...filtered].slice(0, 50);
          try {
            localStorage.setItem('echoly:db_sql_history', JSON.stringify(next));
          } catch {}
          return next;
        });

        if (failed.length === 0) {
          onShowToast?.(
            statements.length > 1
              ? t('db.sqlDoneStatements', {
                  n: statements.length,
                  ms: Math.round(totalMs),
                })
              : t('db.sqlDonePlain', { ms: Math.round(totalMs) }),
            undefined,
            'success',
          );
        } else {
          onShowToast?.(
            t('db.sqlDoneMixed', {
              ok: statements.length - failed.length,
              fail: failed.length,
            }),
            failed[0].result.error,
            'error',
          );
        }
      } catch (err: any) {
        onShowToast?.(t('db.sqlExecException'), err?.message || String(err), 'error');
      } finally {
        setExecuting(false);
      }
    },
    [sql, activeConnId, activeSchema, onShowToast, t],
  );

  const handleSaveFavorite = useCallback(async () => {
    if (!sql.trim()) {
      onShowToast?.(t('db.sqlEmptyCannotFavorite'), undefined, 'warn');
      return;
    }
    const defaultTitle = summarizeSql(sql, 28);
    // 收藏名的输入走应用内弹窗，不用 `window.prompt`：Electron 里 `window.prompt`
    // 是被禁用的，项目在 `main.tsx` 里塞了个 polyfill —— 它**直接返回默认值**，
    // 等于用户从来没有机会改这个名字。收藏保存下来全叫「SELECT * FROM …」，
    // 而界面上一切正常，只有用户自己发现"我明明改过名字"。
    const title = await confirm.confirm({
      title: t('db.sqlFavoritePrompt'),
      content: buildSqlConfirmMarkdown({
        t,
        intro: t('db.sqlFavoriteIntro'),
        statements: [sql.trim()],
        notes: [],
      }),
      input: {
        label: t('db.sqlFavoriteNameLabel'),
        defaultValue: defaultTitle,
        placeholder: defaultTitle,
      },
      confirmLabel: t('db.sqlFavoriteSave'),
    });
    if (title === null) return;
    const item: SqlFavoriteItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: (title.trim() || defaultTitle).trim(),
      sql: sql.trim(),
      time: Date.now(),
    };
    setFavoritesList((prev) => {
      const filtered = prev.filter((fav) => fav.sql !== item.sql);
      const next = [item, ...filtered].slice(0, 50);
      try {
        localStorage.setItem('echoly:db_sql_favorites', JSON.stringify(next));
      } catch {}
      return next;
    });
    onShowToast?.(t('db.sqlFavorited'), item.title, 'success');
  }, [sql, onShowToast, t, confirm]);

  const handleDeleteFavorite = useCallback((id: string) => {
    setFavoritesList((prev) => {
      const next = prev.filter((fav) => fav.id !== id);
      try {
        localStorage.setItem('echoly:db_sql_favorites', JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const handleClearHistory = useCallback(() => {
    setHistoryList([]);
    try {
      localStorage.removeItem('echoly:db_sql_history');
    } catch {}
    onShowToast?.(t('db.sqlHistoryCleared'), undefined, 'info');
  }, [onShowToast, t]);

  const handleApplySqlToEditor = useCallback(
    (targetSqlText: string, append = false) => {
      if (append) {
        const next = sql.trim() ? `${sql.trim()}\n\n${targetSqlText}` : targetSqlText;
        handleEditorChange(next);
      } else {
        handleEditorChange(targetSqlText);
      }
      setShowHistoryModal(false);
      setShowFavoriteModal(false);
      onShowToast?.(t('db.sqlFilledEditor'), undefined, 'success');
    },
    [sql, handleEditorChange, onShowToast, t],
  );

  const formatSql = () => {
    if (!sql.trim()) return;
    try {
      const keywords = [
        'SELECT',
        'FROM',
        'WHERE',
        'LEFT JOIN',
        'RIGHT JOIN',
        'INNER JOIN',
        'JOIN',
        'GROUP BY',
        'ORDER BY',
        'HAVING',
        'LIMIT',
        'OFFSET',
        'INSERT INTO',
        'VALUES',
        'UPDATE',
        'SET',
        'DELETE FROM',
        'UNION ALL',
        'UNION',
        'CREATE TABLE',
        'ALTER TABLE',
        'DROP TABLE',
      ];
      let formatted = sql;
      keywords.forEach((kw) => {
        const regex = new RegExp(`\\b${kw}\\b`, 'gi');
        formatted = formatted.replace(regex, kw);
      });
      [
        'FROM',
        'WHERE',
        'LEFT JOIN',
        'RIGHT JOIN',
        'INNER JOIN',
        'JOIN',
        'GROUP BY',
        'ORDER BY',
        'HAVING',
        'LIMIT',
        'SET',
        'VALUES',
      ].forEach((clause) => {
        const regex = new RegExp(`\\s+(${clause})\\b`, 'g');
        formatted = formatted.replace(regex, `\n$1`);
      });
      setSql(formatted);
      onChangeContent?.(formatted);
      onShowToast?.(t('db.sqlFormatted'), undefined, 'success');
    } catch {
      onShowToast?.(t('db.sqlFormatFailed'), undefined, 'error');
    }
  };

  const activeRun = runs.find((r) => r.index === activeRunIndex) || runs[runs.length - 1] || null;
  const result = activeRun?.result ?? null;

  // 分栏拖拽
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDragging.current) return;
      const container = document.getElementById('db-console-container');
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const newRatio = (moveEvent.clientY - rect.top) / rect.height;
      setSplitRatio(Math.max(0.15, Math.min(0.85, newRatio)));
    };

    const onMouseUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  return (
    <div
      id="db-console-container"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        background: 'var(--bg-editor, #141414)',
        color: 'var(--text)',
        fontSize: 12,
        overflow: 'hidden',
      }}
    >
      {/* ── 顶部快捷操作栏 ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 30,
          padding: '0 10px',
          borderBottom: '1px solid var(--border)',
          background: 'rgba(255, 255, 255, 0.02)',
          flexShrink: 0,
          gap: 10,
        }}
      >
        {/* 左：执行按钮群 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={() => void execute('auto')}
            disabled={executing}
            title={t('db.sqlRunSelectionTitle')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: 22,
              padding: '0 8px',
              fontSize: 12,
              borderRadius: 4,
              background: '#10b981',
              color: '#fff',
              border: 'none',
              cursor: executing ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            <span>{executing ? t('db.sqlRunning') : t('db.sqlRun')}</span>
          </button>

          <button
            type="button"
            onClick={() => void execute('all')}
            disabled={executing}
            title={t('db.sqlRunAllTitle')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              height: 22,
              padding: '0 8px',
              fontSize: 12,
              borderRadius: 4,
              background: 'rgba(255, 255, 255, 0.08)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              cursor: executing ? 'not-allowed' : 'pointer',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="5 3 19 12 5 21 5 3" />
              <line x1="22" y1="5" x2="22" y2="19" />
            </svg>
            <span>{t('db.sqlAll')}</span>
          </button>

          <button
            type="button"
            className="panel-action-btn"
            title={t('db.sqlFormatTitle')}
            onClick={formatSql}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="21" y1="10" x2="7" y2="10" />
              <line x1="21" y1="6" x2="3" y2="6" />
              <line x1="21" y1="14" x2="3" y2="14" />
              <line x1="21" y1="18" x2="7" y2="18" />
            </svg>
          </button>

          <button
            type="button"
            className="panel-action-btn"
            title={t('db.sqlFavoriteTitle')}
            onClick={handleSaveFavorite}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>

          <button
            type="button"
            className={`panel-action-btn${showFavoriteModal ? ' active' : ''}`}
            title={t('db.sqlFavoritesDrawerTitle', { n: favoritesList.length })}
            onClick={() => {
              setShowFavoriteModal((v) => !v);
              setShowHistoryModal(false);
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>

          <button
            type="button"
            className={`panel-action-btn${showHistoryModal ? ' active' : ''}`}
            title={t('db.sqlHistoryDrawerTitle', { n: historyList.length })}
            onClick={() => {
              setShowHistoryModal((v) => !v);
              setShowFavoriteModal(false);
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </button>
        </div>

        {/* 中：会话目标（连接 / 库选择器），带最小宽度保障，永不挤压 */}
        <div className="db-console-target" style={{ flexShrink: 0 }}>
          <PanelSelect<string>
            className="db-console-target-select"
            value={activeConnId}
            disabled={connections.length === 0}
            title={t('db.sqlSwitchConnTitle')}
            options={connOptions}
            open={openSelect === 'conn'}
            onOpenChange={(next) => setOpenSelect(next ? 'conn' : null)}
            onChange={(next) => void handlePickConnection(next)}
          />
          <span className="db-console-target-sep">/</span>
          <PanelSelect<string>
            className="db-console-target-select"
            value={activeSchema ?? ''}
            disabled={loadingSchemas || schemaOptions.length === 0}
            title={t('db.sqlSwitchSchemaTitle')}
            options={schemaOptions}
            open={openSelect === 'schema'}
            onOpenChange={(next) => setOpenSelect(next ? 'schema' : null)}
            onChange={handlePickSchema}
          />
        </div>

        {/* 右：执行状态 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flex: '1 1 auto',
            minWidth: 0,
            justifyContent: 'flex-end',
            overflow: 'hidden',
          }}
        >
          {result && (
            <span
              style={{
                fontSize: 11,
                color: result.ok ? '#34d399' : '#f87171',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {result.ok
                ? t('db.sqlSuccessStatus', {
                    ms: result.executionTimeMs,
                    detail:
                      result.affectedRows !== undefined
                        ? t('db.sqlRowsAffected', { n: result.affectedRows })
                        : t('db.sqlRecordCount', { n: result.rows.length }),
                  })
                : t('db.sqlErrorStatus', { error: result.error ?? '' })}
            </span>
          )}
        </div>
      </div>

      {/* ── SQL 执行历史抽屉浮层 ── */}
      {showHistoryModal && (
        <div
          style={{
            position: 'absolute',
            top: 31,
            left: 10,
            zIndex: 100,
            width: 440,
            maxHeight: 380,
            background: 'var(--bg-secondary, #1e1e1e)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '8px 12px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'rgba(255, 255, 255, 0.03)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontWeight: 600,
                fontSize: 12,
              }}
            >
              <span>{t('db.sqlHistoryPanelTitle')}</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                ({historyList.length})
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {historyList.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearHistory}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: '#f87171',
                    fontSize: 11,
                    cursor: 'pointer',
                    padding: '2px 6px',
                  }}
                >
                  {t('db.sqlClearHistory')}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowHistoryModal(false)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--text-muted)',
                  fontSize: 14,
                  cursor: 'pointer',
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
          </div>

          <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
            <input
              type="text"
              placeholder={t('db.sqlHistorySearchPlaceholder')}
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              style={{
                width: '100%',
                padding: '4px 8px',
                fontSize: 11,
                borderRadius: 4,
                border: '1px solid var(--border)',
                background: 'var(--bg-tertiary, #141414)',
                color: 'var(--text)',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0', maxHeight: 280 }}>
            {historyList.filter((item) =>
              historySearch ? item.sql.toLowerCase().includes(historySearch.toLowerCase()) : true,
            ).length === 0 ? (
              <div
                style={{
                  padding: '24px 0',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: 11,
                }}
              >
                {t('db.sqlNoHistory')}
              </div>
            ) : (
              historyList
                .filter((item) =>
                  historySearch
                    ? item.sql.toLowerCase().includes(historySearch.toLowerCase())
                    : true,
                )
                .map((item) => (
                  <div
                    key={item.id}
                    style={{
                      padding: '8px 12px',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span style={{ fontSize: 10, color: item.ok ? '#34d399' : '#f87171' }}>
                        {item.ok ? t('db.sqlRunOk') : t('db.sqlRunFail')} ·{' '}
                        {new Date(item.time).toLocaleTimeString()}
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => handleApplySqlToEditor(item.sql, false)}
                          style={{
                            border: '1px solid var(--border)',
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: 'var(--text)',
                            borderRadius: 3,
                            fontSize: 10,
                            padding: '2px 6px',
                            cursor: 'pointer',
                          }}
                        >
                          {t('db.sqlFill')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleApplySqlToEditor(item.sql, true)}
                          style={{
                            border: '1px solid var(--border)',
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: 'var(--text)',
                            borderRadius: 3,
                            fontSize: 10,
                            padding: '2px 6px',
                            cursor: 'pointer',
                          }}
                        >
                          {t('db.sqlAppend')}
                        </button>
                      </div>
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: 'var(--text)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        maxHeight: 60,
                        overflow: 'hidden',
                        opacity: 0.85,
                      }}
                    >
                      {item.sql}
                    </pre>
                  </div>
                ))
            )}
          </div>
        </div>
      )}

      {/* ── 常用 SQL 收藏夹抽屉浮层 ── */}
      {showFavoriteModal && (
        <div
          style={{
            position: 'absolute',
            top: 31,
            left: 10,
            zIndex: 100,
            width: 440,
            maxHeight: 380,
            background: 'var(--bg-secondary, #1e1e1e)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '8px 12px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'rgba(255, 255, 255, 0.03)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontWeight: 600,
                fontSize: 12,
              }}
            >
              <span>{t('db.sqlFavoritesPanelTitle')}</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                ({favoritesList.length})
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowFavoriteModal(false)}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--text-muted)',
                fontSize: 14,
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>

          <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
            <input
              type="text"
              placeholder={t('db.sqlFavoritesSearchPlaceholder')}
              value={favoriteSearch}
              onChange={(e) => setFavoriteSearch(e.target.value)}
              style={{
                width: '100%',
                padding: '4px 8px',
                fontSize: 11,
                borderRadius: 4,
                border: '1px solid var(--border)',
                background: 'var(--bg-tertiary, #141414)',
                color: 'var(--text)',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0', maxHeight: 280 }}>
            {favoritesList.filter(
              (item) =>
                !favoriteSearch ||
                item.title.toLowerCase().includes(favoriteSearch.toLowerCase()) ||
                item.sql.toLowerCase().includes(favoriteSearch.toLowerCase()),
            ).length === 0 ? (
              <div
                style={{
                  padding: '24px 0',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: 11,
                }}
              >
                {t('db.sqlNoFavorites')}
              </div>
            ) : (
              favoritesList
                .filter(
                  (item) =>
                    !favoriteSearch ||
                    item.title.toLowerCase().includes(favoriteSearch.toLowerCase()) ||
                    item.sql.toLowerCase().includes(favoriteSearch.toLowerCase()),
                )
                .map((item) => (
                  <div
                    key={item.id}
                    style={{
                      padding: '8px 12px',
                      borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                        {item.title}
                      </span>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <button
                          type="button"
                          onClick={() => handleApplySqlToEditor(item.sql, false)}
                          style={{
                            border: '1px solid var(--border)',
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: 'var(--text)',
                            borderRadius: 3,
                            fontSize: 10,
                            padding: '2px 6px',
                            cursor: 'pointer',
                          }}
                        >
                          {t('db.sqlFill')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleApplySqlToEditor(item.sql, true)}
                          style={{
                            border: '1px solid var(--border)',
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: 'var(--text)',
                            borderRadius: 3,
                            fontSize: 10,
                            padding: '2px 6px',
                            cursor: 'pointer',
                          }}
                        >
                          {t('db.sqlAppend')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteFavorite(item.id)}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            color: '#f87171',
                            fontSize: 11,
                            cursor: 'pointer',
                            padding: '0 2px',
                          }}
                          title={t('db.sqlDeleteFavorite')}
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: 'var(--text-muted)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                        maxHeight: 50,
                        overflow: 'hidden',
                      }}
                    >
                      {item.sql}
                    </pre>
                  </div>
                ))
            )}
          </div>
        </div>
      )}

      {/* ── 多语句执行日志条 ── */}
      {runs.length > 1 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 12px',
            borderBottom: '1px solid var(--border)',
            background: 'rgba(255, 255, 255, 0.015)',
            overflowX: 'auto',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {t('db.sqlRunLog', { n: runs.length })}
          </span>
          {runs.map((run) => (
            <button
              key={run.index}
              type="button"
              onClick={() => setActiveRunIndex(run.index)}
              title={`${run.sql}\n\n${
                run.result.ok
                  ? t('db.sqlRunLogOk', { ms: run.result.executionTimeMs })
                  : t('db.sqlRunLogFail', { error: run.result.error ?? '' })
              }`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '2px 8px',
                fontSize: 11,
                borderRadius: 4,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                border: `1px solid ${run.index === activeRunIndex ? 'var(--accent, #3b82f6)' : 'var(--border)'}`,
                background:
                  run.index === activeRunIndex ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                color: run.result.ok ? 'var(--text)' : '#f87171',
              }}
            >
              <span style={{ opacity: 0.7 }}>{run.index}.</span>
              <span>{summarizeSql(run.sql, 34)}</span>
              <span style={{ fontSize: 10, opacity: 0.75 }}>
                {run.result.ok ? `${Math.round(run.result.executionTimeMs)}ms` : '✕'}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* ── 上半区: Monaco SQL 编辑器 ── */}
      <div style={{ height: `${splitRatio * 100}%`, minHeight: 80, overflow: 'hidden' }}>
        <Editor
          value={sql}
          language="sql"
          theme={theme === 'light' ? 'vs' : 'vs-dark'}
          onChange={(v) => handleEditorChange(v || '')}
          options={{
            fontSize: 13,
            lineNumbers: 'on',
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            renderLineHighlight: 'all',
            suggestOnTriggerCharacters: true,
            acceptSuggestionOnEnter: 'on',
            tabCompletion: 'on',
            quickSuggestions: { other: true, comments: false, strings: false },
            suggest: {
              showClasses: true,
              showFields: true,
              showModules: true,
              showKeywords: true,
              insertMode: 'replace',
            },
          }}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            // Cmd/Ctrl+Enter：有选区执行选区，否则执行光标所在语句
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
              void execute('auto');
            });
            // Cmd/Ctrl+Shift+Enter：全部语句顺序执行
            editor.addCommand(
              monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter,
              () => {
                void execute('all');
              },
            );
          }}
        />
      </div>

      {/* ── 拖拽分栏条 ── */}
      <div
        onMouseDown={startDrag}
        style={{
          height: 6,
          background: 'rgba(255, 255, 255, 0.05)',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
          cursor: 'row-resize',
          flexShrink: 0,
        }}
      />

      {/* ── 下半区: 查询结果表格 ── */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          minHeight: 80,
          background: 'var(--bg-editor, #141414)',
          position: 'relative',
        }}
      >
        {result?.rows && result.rows.length > 0 ? (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 12,
              textAlign: 'left',
              fontFamily: 'var(--font-mono, monospace)',
            }}
          >
            <thead>
              <tr
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  position: 'sticky',
                  top: 0,
                  zIndex: 2,
                }}
              >
                <th
                  style={{
                    padding: '6px 8px',
                    borderBottom: '1px solid var(--border)',
                    borderRight: '1px solid rgba(255, 255, 255, 0.05)',
                    color: 'var(--text-muted)',
                    width: 36,
                    textAlign: 'center',
                    background: 'var(--bg-editor, #141414)',
                  }}
                >
                  #
                </th>
                {result.columns.map((col) => (
                  <th
                    key={col}
                    style={{
                      padding: '6px 12px',
                      borderBottom: '1px solid var(--border)',
                      borderRight: '1px solid rgba(255, 255, 255, 0.05)',
                      color: 'var(--text)',
                      whiteSpace: 'nowrap',
                      background: 'var(--bg-editor, #141414)',
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  style={{
                    borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                    background: rowIdx % 2 === 1 ? 'rgba(255, 255, 255, 0.015)' : 'transparent',
                  }}
                >
                  <td
                    style={{
                      padding: '5px 8px',
                      textAlign: 'center',
                      color: 'var(--text-muted)',
                      borderRight: '1px solid rgba(255, 255, 255, 0.04)',
                    }}
                  >
                    {rowIdx + 1}
                  </td>
                  {result.columns.map((col) => {
                    const val = row[col];
                    const isNull = val === null || val === undefined;
                    return (
                      <td
                        key={col}
                        style={{
                          padding: '5px 12px',
                          color: isNull ? 'rgba(255, 255, 255, 0.3)' : 'var(--text)',
                          borderRight: '1px solid rgba(255, 255, 255, 0.04)',
                          whiteSpace: 'nowrap',
                          maxWidth: 320,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {isNull ? 'NULL' : formatCellValue(val)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : result ? (
          <div
            style={{
              padding: '32px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 12,
            }}
          >
            {result.ok
              ? result.columns.length > 0
                ? t('db.sqlOkNoRows')
                : t('db.sqlOkNoResultSet')
              : t('db.sqlExecError', { error: result.error ?? '' })}
          </div>
        ) : (
          <div
            style={{
              padding: '32px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 12,
            }}
          >
            {t('db.sqlWriteAndRun')}
          </div>
        )}
      </div>

      {confirm.modal}
    </div>
  );
}
