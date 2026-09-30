import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import Editor from '@monaco-editor/react';
import type { DatabaseQueryResult, DbConnectionView } from '@deepseek-ide/shared';
import { resolveExecutableSql, splitSqlStatements } from '../services/sqlStatements';
import { formatCellValue } from '../services/dbCellDisplay';
import { PanelSelect } from './PanelSelect';

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
  const [sql, setSql] = useState<string>(initialSql);
  const [runs, setRuns] = useState<StatementRun[]>([]);
  const [activeRunIndex, setActiveRunIndex] = useState<number>(0);
  const [executing, setExecuting] = useState<boolean>(false);
  const [splitRatio, setSplitRatio] = useState<number>(0.45); // 上部编辑器占比 45%

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
        onShowToast?.(`连接「${target?.name ?? nextId}」失败`, detail, 'error');
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
        names.length > 1 ? undefined : names[0] ?? target?.database ?? prevSchema;
      setActiveSchema(nextSchema);
      selfRetargetRef.current = { connectionId: nextId, schemaName: nextSchema };
      onRetarget?.({ connectionId: nextId, schemaName: nextSchema }, 'connection');
      setOpenSelect(names.length > 1 ? 'schema' : null);
    },
    [activeConnId, connections, activeSchema, onRetarget, onShowToast],
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
        onShowToast?.('请输入要执行的 SQL 语句', undefined, 'error');
        return;
      }

      // 多语句脚本逐条执行，单条失败不阻断后续语句（便于 `show databases; use x; show tables;` 这类脚本）
      const statements = splitSqlStatements(targetSql);
      if (statements.length === 0) {
        onShowToast?.('没有可执行的 SQL 语句', undefined, 'error');
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
        setActiveRunIndex((withRows.length > 0 ? withRows[withRows.length - 1] : collected[collected.length - 1]).index);

        const failed = collected.filter((r) => !r.result.ok);
        const totalMs = collected.reduce((sum, r) => sum + (r.result.executionTimeMs || 0), 0);
        if (failed.length === 0) {
          onShowToast?.(
            statements.length > 1
              ? `执行完成：${statements.length} 条语句 · ${Math.round(totalMs)}ms`
              : `执行完成 (${Math.round(totalMs)}ms)`,
            undefined,
            'success',
          );
        } else {
          onShowToast?.(
            `执行完成：${statements.length - failed.length} 条成功 / ${failed.length} 条失败`,
            failed[0].result.error,
            'error',
          );
        }
      } catch (err: any) {
        onShowToast?.('执行异常', err?.message || String(err), 'error');
      } finally {
        setExecuting(false);
      }
    },
    [sql, activeConnId, activeSchema, onShowToast],
  );

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
        {/* 左：执行按钮 + 快捷键提示。
            与右侧状态区同为 `flex: 1 1 0`，两侧各自吃掉一半空白，
            正中间的「连接 / 库」才真正落在容器中线上，而不是被左侧按钮群挤偏 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flex: '1 1 0',
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          <button
            type="button"
            onClick={() => void execute('auto')}
            disabled={executing}
            title="有选中内容则只执行选中，否则执行光标所在语句 (Cmd+Enter)"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 12px',
              fontSize: 12,
              borderRadius: 4,
              background: '#10b981',
              color: '#fff',
              border: 'none',
              cursor: executing ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            {executing ? '执行中...' : '运行 (Cmd+Enter)'}
          </button>

          <button
            type="button"
            onClick={() => void execute('all')}
            disabled={executing}
            title="按分号切分后顺序执行编辑器中的全部语句 (Cmd+Shift+Enter)"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              fontSize: 12,
              borderRadius: 4,
              background: 'rgba(255, 255, 255, 0.08)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              cursor: executing ? 'not-allowed' : 'pointer',
              fontWeight: 500,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" />
              <line x1="22" y1="5" x2="22" y2="19" />
            </svg>
            运行全部
          </button>

          {/* 快捷键提示随左区一起被挤掉，而不是把中间的目标选择器顶偏 */}
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            }}
          >
            选中行执行 · <kbd style={{ padding: '1px 4px', background: 'rgba(255,255,255,0.08)', borderRadius: 3 }}>Cmd</kbd>
            +<kbd style={{ padding: '1px 4px', background: 'rgba(255,255,255,0.08)', borderRadius: 3 }}>Enter</kbd>
            ，全部执行 <kbd style={{ padding: '1px 4px', background: 'rgba(255,255,255,0.08)', borderRadius: 3 }}>Cmd</kbd>
            +<kbd style={{ padding: '1px 4px', background: 'rgba(255,255,255,0.08)', borderRadius: 3 }}>Shift</kbd>
            +<kbd style={{ padding: '1px 4px', background: 'rgba(255,255,255,0.08)', borderRadius: 3 }}>Enter</kbd>
          </span>
        </div>

        {/* 中：会话目标。连的是哪个连接、打在哪个库上，都在这里换 ——
            不必回左侧树重新点开一个控制台。
            放在正中间是刻意为之：它是本页最需要随时确认的信息（执行错库的代价很高），
            钉在正中比跟着左侧按钮群随窗口宽度漂移更容易一眼看到。 */}
        <div className="db-console-target">
          <PanelSelect<string>
            className="db-console-target-select"
            value={activeConnId}
            disabled={connections.length === 0}
            title="切换执行本控制台的连接（未连接的会在选中的同时自动连上）"
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
            title="切换本控制台执行时打在哪个库 / Schema（只改执行目标，不影响这个标签里的 SQL）"
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
            gap: 8,
            flex: '1 1 0',
            minWidth: 0,
            justifyContent: 'flex-end',
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
                ? `✓ 成功 (${result.executionTimeMs}ms) · ${result.affectedRows !== undefined ? `${result.affectedRows} 行受影响` : `${result.rows.length} 条记录`}`
                : `✕ 错误: ${result.error}`}
            </span>
          )}
        </div>
      </div>

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
            语句执行日志 ({runs.length})：
          </span>
          {runs.map((run) => (
            <button
              key={run.index}
              type="button"
              onClick={() => setActiveRunIndex(run.index)}
              title={`${run.sql}\n\n${run.result.ok ? `成功 · ${run.result.executionTimeMs}ms` : `失败 · ${run.result.error}`}`}
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
                background: run.index === activeRunIndex ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
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
          <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            {result.ok
              ? result.columns.length > 0
                ? '语句执行成功，本页无数据行'
                : '语句执行成功，无返回行数据集'
              : `执行错误: ${result.error}`}
          </div>
        ) : (
          <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            编写 SQL 并点击「运行」或按下 Cmd+Enter 执行查询
          </div>
        )}
      </div>
    </div>
  );
}
