import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import { useModalResize, ModalResizeHandle, createSafeOverlayHandlers } from '../hooks/useModalResize';
import { PanelSelect } from './PanelSelect';
import { DbConfirmModal } from './DbConfirmModal';
import { buildSqlConfirmMarkdown } from '../services/dbConfirmContent';
import {
  COLUMN_TYPES,
  buildAlterTableStatements,
  buildCreateTableSql,
  typeAcceptsLength,
  validateIdentifier,
  validateLength,
  type DbColumnSpec,
} from '../services/dbDdl';
import {
  buildAlterChange,
  emptyColumn,
  fromMeta,
  toColumnSpec,
  type EditableColumn,
} from '../services/dbStructureModel';
import type { DbDriverType } from '../services/dbIdentifiers';

export interface TableStructureModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 新建表 / 设计表 */
  mode: 'create' | 'alter';
  driver: DbDriverType;
  schemaName?: string;
  /** 新建模式下的初始表名（一般留空，由用户填） */
  initialTableName?: string;
  /** 设计模式下的现有列（来自 getTableSchema） */
  existingColumns?: DatabaseColumnMeta[];
  /** 设计模式下的表名（不可改） */
  tableName?: string;
  /**
   * 执行回调。DDL 不走事务，因此这里是**逐条**下发：
   * 调用方按顺序执行，遇到第一条失败即停止并把错误抛回来。
   */
  onExecute: (statements: string[]) => Promise<{ ok: boolean; error?: string }>;
  onShowToast?: (title: string, detail?: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
}

/**
 * 表结构弹窗（新建表 / 设计表）。
 *
 * 两者共用同一套「列清单编辑器」，区别只在最终生成 CREATE TABLE 还是 ALTER TABLE，
 * 以及设计模式下多一个「删除此列」标记。**左侧实时预览即将执行的 SQL**，这是唯一的复核点 ——
 * DDL 无法回滚，用户按下确定前必须能逐字看到要跑什么。
 */
export function TableStructureModal({
  isOpen,
  onClose,
  mode,
  driver,
  schemaName,
  initialTableName,
  existingColumns,
  tableName,
  onExecute,
  onShowToast,
}: TableStructureModalProps) {
  const [createTableName, setCreateTableName] = useState<string>('');
  const [columns, setColumns] = useState<EditableColumn[]>([]);
  const [executing, setExecuting] = useState<boolean>(false);

  const { modalSize, handleResizeStart } = useModalResize({
    storageKey: 'echoly:table_structure_modal_size',
    defaultWidth: 900,
    defaultHeight: 620,
    minWidth: 640,
    minHeight: 420,
  });
  const overlayHandlers = createSafeOverlayHandlers(onClose);

  // 每次打开重置为初始状态：设计模式读入现有列，新建模式给一行空列
  useEffect(() => {
    if (!isOpen) return;
    setExecuting(false);
    if (mode === 'alter') {
      setCreateTableName(tableName || '');
      setColumns((existingColumns ?? []).map(fromMeta));
    } else {
      setCreateTableName(initialTableName || '');
      setColumns([emptyColumn(driver)]);
    }
  }, [isOpen, mode, tableName, initialTableName, existingColumns, driver]);

  const patchColumn = (key: string, patch: Partial<EditableColumn>) => {
    setColumns((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  };

  // ── 生成待执行语句 ────────────────────────────────────────────────────────

  const built = useMemo(() => {
    if (mode === 'create') {
      const nameError = validateIdentifier(createTableName);
      const invalid = columns
        .map((c) => ({ c, err: c.drop ? null : validateIdentifier(c.name) }))
        .filter((x) => x.err);
      const lengthErrors = columns
        .filter((c) => !c.drop && typeAcceptsLength(c.type))
        .map((c) => ({ c, err: validateLength(c.length) }))
        .filter((x) => x.err);
      const problems: string[] = [];
      if (nameError) problems.push(`表名：${nameError}`);
      for (const { c, err } of invalid) problems.push(`列名「${c.name || '未命名'}」：${err}`);
      for (const { c, err } of lengthErrors) problems.push(`列「${c.name}」长度：${err}`);
      if (columns.filter((c) => !c.drop).length === 0) problems.push('至少需要一列');

      const specs: DbColumnSpec[] = columns.filter((c) => !c.drop).map(toColumnSpec);

      const sql =
        problems.length > 0
          ? ''
          : buildCreateTableSql(driver, schemaName, createTableName.trim(), specs);
      return { statements: sql ? [sql] : [], problems, skipped: [] as string[] };
    }

    // ── 设计表（ALTER）──
    const changes = columns.map(buildAlterChange);

    const problems: string[] = [];
    for (const c of columns) {
      if (c.drop) continue;
      const err = validateIdentifier(c.name);
      if (err) problems.push(`列名「${c.name || '未命名'}」：${err}`);
      const lenErr = typeAcceptsLength(c.type) ? validateLength(c.length) : null;
      if (lenErr) problems.push(`列「${c.name}」长度：${lenErr}`);
    }

    const res = buildAlterTableStatements(driver, schemaName, tableName || '', changes);
    return { statements: problems.length > 0 ? [] : res.statements, problems, skipped: res.skipped ?? [] };
  }, [mode, driver, schemaName, createTableName, columns, tableName]);

  if (!isOpen) return null;

  const previewSql = built.statements.join('\n');
  const canExecute = built.problems.length === 0 && built.statements.length > 0 && !executing;

  /** 确认框打开时才非空；真正执行挂在弹窗 onConfirm 上 */
  const [confirmContent, setConfirmContent] = useState<string | null>(null);

  const handleExecute = () => {
    if (!canExecute) return;
    setConfirmContent(
      buildSqlConfirmMarkdown({
        intro:
          mode === 'create'
            ? `即将创建表「${createTableName.trim()}」。`
            : `即将修改表「${tableName}」的结构，共 **${built.statements.length}** 条语句。`,
        statements: built.statements,
        notes: ['DDL 逐条执行且**无法回滚**：若中途失败，前面的语句已经生效。'],
        tone: 'danger',
      }),
    );
  };

  const runExecute = async () => {
    setExecuting(true);
    try {
      const res = await onExecute(built.statements);
      if (res.ok) {
        onShowToast?.(
          mode === 'create' ? `已创建表 ${createTableName.trim()}` : `已更新表 ${tableName} 的结构`,
          undefined,
          'success',
        );
        onClose();
      } else {
        // 逐条执行时可能前面几条已经生效，这里如实告知「部分生效」，不要让用户以为整体失败
        onShowToast?.('表结构变更失败', res.error || '未知原因', 'error');
      }
    } finally {
      setExecuting(false);
    }
  };

  const types = COLUMN_TYPES[driver];

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="modal-overlay"
      {...overlayHandlers}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
      }}
    >
      <div
        className="modal-container"
        style={{
          width: modalSize.width,
          height: modalSize.height,
          position: 'relative',
          background: 'var(--bg-panel, #1e1e1e)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* 标题栏 */}
        <div
          style={{
            height: 30,
            padding: '0 10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.05em' }}>
            {mode === 'create'
              ? '新建表'
              : `设计表 · ${tableName}`}
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
              {driver.toUpperCase()}
              {schemaName ? ` · ${schemaName}` : ''}
            </span>
          </div>
          <button type="button" className="panel-action-btn" title="关闭" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* 表名 */}
        {mode === 'create' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', flexShrink: 0 }}>
            <span style={{ fontSize: 12, width: 56 }}>表名</span>
            <input
              type="text"
              className="db-structure-input"
              style={{ flex: 1, maxWidth: 320 }}
              value={createTableName}
              onChange={(e) => setCreateTableName(e.target.value)}
              placeholder="例如 users"
            />
            {schemaName && (
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                将创建在 {schemaName} 下
              </span>
            )}
          </div>
        )}

        {/* 主体：左列清单 / 右 SQL 预览 */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }}>
            <div style={{ flex: 1, overflow: 'auto', padding: '0 12px 12px' }}>
              <table className="db-structure-table">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>列名</th>
                    <th style={{ width: 130 }}>类型</th>
                    <th style={{ width: 80 }}>长度</th>
                    <th style={{ width: 46 }}>非空</th>
                    <th style={{ width: 46 }}>主键</th>
                    <th style={{ width: 62 }}>自增</th>
                    <th>默认值</th>
                    <th style={{ width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {columns.map((c) => (
                    <tr key={c.key} style={{ opacity: c.drop ? 0.45 : 1 }}>
                      <td>
                        <input
                          type="text"
                          className="db-structure-input"
                          value={c.name}
                          disabled={c.drop}
                          onChange={(e) => patchColumn(c.key, { name: e.target.value })}
                          style={c.drop ? { textDecoration: 'line-through' } : undefined}
                        />
                      </td>
                      <td>
                        {/* 同样避开原生 <select>：列编辑器本身在 overflow 容器里，
                            原生弹出层在暗色主题下配色对不上且长列表不好翻 */}
                        <PanelSelect<string>
                          className="db-structure-select"
                          value={c.type}
                          disabled={c.drop}
                          title={c.drop ? '该列已标记删除' : '列类型'}
                          onChange={(next) => patchColumn(c.key, { type: next })}
                          options={types.map((t) => ({ value: t, label: t }))}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          className="db-structure-input"
                          value={c.length}
                          disabled={c.drop || !typeAcceptsLength(c.type)}
                          placeholder={typeAcceptsLength(c.type) ? '如 255' : '—'}
                          onChange={(e) => patchColumn(c.key, { length: e.target.value })}
                        />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={c.notnull}
                          disabled={c.drop}
                          onChange={(e) => patchColumn(c.key, { notnull: e.target.checked })}
                        />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={c.pk}
                          disabled={c.drop}
                          onChange={(e) => patchColumn(c.key, { pk: e.target.checked })}
                        />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={c.autoIncrement}
                          disabled={c.drop || driver === 'postgres'}
                          title={driver === 'postgres' ? 'PostgreSQL 请使用 SERIAL 类型' : '自增'}
                          onChange={(e) => patchColumn(c.key, { autoIncrement: e.target.checked })}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          className="db-structure-input"
                          value={c.defaultValue}
                          disabled={c.drop}
                          placeholder="留空为无默认值"
                          onChange={(e) => patchColumn(c.key, { defaultValue: e.target.value })}
                        />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {mode === 'alter' && c.originalName ? (
                          <button
                            type="button"
                            className="panel-action-btn"
                            title={c.drop ? '取消删除' : '标记删除此列'}
                            onClick={() => patchColumn(c.key, { drop: !c.drop })}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={c.drop ? '#f59e0b' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M3 6h18" />
                              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                            </svg>
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="panel-action-btn"
                            title="移除这一行"
                            onClick={() => setColumns((prev) => prev.filter((x) => x.key !== c.key))}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                              <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <button
                type="button"
                className="db-structure-add"
                onClick={() => setColumns((prev) => [...prev, emptyColumn(driver)])}
              >
                ＋ 添加列
              </button>
            </div>
          </div>

          {/* SQL 预览 */}
          <div style={{ width: '42%', minWidth: 300, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                height: 30,
                padding: '0 10px',
                display: 'flex',
                alignItems: 'center',
                borderBottom: '1px solid var(--border)',
                fontSize: 11,
                color: 'var(--text-muted)',
                flexShrink: 0,
              }}
            >
              即将执行的 SQL{built.statements.length > 1 ? `（${built.statements.length} 条）` : ''}
            </div>
            <pre className="db-structure-preview">
              {previewSql || '-- 填写完整后这里会显示生成的 SQL'}
            </pre>
            {built.problems.length > 0 && (
              <div className="db-structure-problems">
                {built.problems.map((p, i) => (
                  <div key={i}>⚠ {p}</div>
                ))}
              </div>
            )}
            {built.problems.length === 0 && built.skipped.length > 0 && (
              <div className="db-structure-skipped">
                {built.skipped.map((s, i) => (
                  <div key={i}>ⓘ {s}</div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 底部操作栏 */}
        <div
          style={{
            height: 30,
            padding: '0 10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 6,
            borderTop: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          <button type="button" className="panel-action-btn" onClick={onClose} disabled={executing}>
            <span style={{ fontSize: 12, padding: '0 4px' }}>取消</span>
          </button>
          <button
            type="button"
            className="panel-action-btn"
            onClick={() => void handleExecute()}
            disabled={!canExecute}
            title={canExecute ? '执行 DDL（会二次确认）' : '请先补全必填项'}
          >
            <span style={{ fontSize: 12, padding: '0 4px', color: canExecute ? '#4ade80' : undefined }}>
              {executing ? '执行中…' : mode === 'create' ? '创建表' : '应用变更'}
            </span>
          </button>
        </div>

        <ModalResizeHandle onMouseDown={handleResizeStart} />
      </div>

      {/* DDL 确认：Markdown 渲染，每条语句可单独复制（DDL 无法回滚，值得让用户逐条过目） */}
      <DbConfirmModal
        isOpen={confirmContent !== null}
        title={mode === 'create' ? '确认创建表' : '确认修改表结构'}
        content={confirmContent ?? ''}
        tone="danger"
        confirmLabel={mode === 'create' ? '确认创建' : '确认执行'}
        onConfirm={() => {
          setConfirmContent(null);
          void runExecute();
        }}
        onCancel={() => setConfirmContent(null)}
      />
    </div>,
    document.body,
  );
}
