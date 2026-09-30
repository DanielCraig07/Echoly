import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import { PanelSelect } from './PanelSelect';
import { DbConfirmModal } from './DbConfirmModal';
import { buildSqlConfirmMarkdown } from '../services/dbConfirmContent';
import {
  COLUMN_TYPES,
  buildAlterTableStatements,
  buildRenameTableStatement,
  buildTableOptionsSql,
  typeAcceptsLength,
  validateIdentifier,
  validateLength,
  type DbColumnChange,
  type DbTableOptionChange,
} from '../services/dbDdl';
import {
  buildAlterChange,
  emptyColumn,
  fromMeta,
  isColumnDirty,
  type EditableColumn,
} from '../services/dbStructureModel';
import { parseTableOptions, type DbTableOptions } from '../services/dbSqlPreview';
import { columnCategoryBadge } from '../services/dbColumnType';
import { applyStatements, describeApplyResult } from '../services/dbStructureApply';
import type { DbDriverType } from '../services/dbIdentifiers';

export interface DbColumnsViewProps {
  connectionId: string;
  tableName: string;
  schemaName?: string;
  driver: DbDriverType;
  /** 列元数据（含 comment / extra） */
  columns: DatabaseColumnMeta[];
  /** 表注释（来自表元数据，可能没有） */
  tableComment?: string | null;
  /** MySQL 的 `SHOW CREATE TABLE` 原文：用来解析引擎 / 字符集 / 排序规则 */
  ddl?: string;
  /** 应用完成后通知外层重取列与 DDL */
  onApplied: () => void;
  /**
   * 表被改名了。
   *
   * 改名是这个视图里唯一**会改变标签身份**的改动：标签路径、标签标题、树上节点的
   * 后续刷新都还挂在旧名字上。所以它不能只当作「又一条 DDL」汇报，
   * 必须把新名字交给外层去收尾（见 `App.handleTableRenamed`）。
   */
  onRenamed?: (newTableName: string) => void;
  onShowToast?: (title: string, detail?: string, type?: 'success' | 'error' | 'info' | 'warn') => void;
}

/**
 * 元信息区的一行：左标签 + 右值。**纵向列表**而不是原来那种横向换行的一排 ——
 * 一排挤在一起时，标签与值要来回对位才看得懂哪一截属于哪一项。
 *
 * 值缺省时渲染成灰色的「—」而**不是整行消失**：原来 `return null` 的做法让
 * 没有注释的表少一行、SQLite 少三行，同一张表在两种驱动下长得完全不同，
 * 用户没法判断「是没有这一项，还是没读到」。缺什么就用「—」如实说。
 */
function MetaRow({
  label,
  value,
  title,
  children,
}: {
  label: string;
  value?: string | null;
  title?: string;
  /** 有 children 时用 children 取代纯文本值（可编辑的那些行） */
  children?: ReactNode;
}) {
  return (
    <div className="db-meta-row">
      <span className="db-meta-label">{label}</span>
      {children ?? (
        <span className={`db-meta-value${value ? '' : ' empty'}`} title={title ?? value ?? ''}>
          {value || '—'}
        </span>
      )}
    </div>
  );
}

/**
 * 表结构的「列清单」视图（图4）。
 *
 * 与「新建表 / 设计表」弹窗共用同一套行模型（`dbStructureModel`），区别在于：
 * - 这里是**编辑区里的一个整页视图**，不是弹窗，因此有地方摆表级元信息
 *   （引擎 / 字符集 / 排序规则 / 列数）—— 这些正是用户「看表结构」时想顺手核对的东西；
 * - 改动全部本地暂存，点「应用」才生成 ALTER，且**必须过一遍二次确认**：
 *   DDL 不进事务，这是唯一的复核机会。
 *
 * 元信息区里的表名 / 注释 / 引擎 / 字符集 / 排序规则是**可改的**，与列改动共用同一条
 * 「暂存 → 应用 → 二次确认 → 逐条执行」的通道：改注释和改列一样都是下单条 DDL，
 * 分开做两套按钮只会让人以为其中一个不危险。
 *
 * 表名是这批改动里唯一的例外：它按**换标签**处理（`onRenamed`），见 `runApply` 与 App 的
 * `handleTableRenamed`。区别在于表名是标签路径的一部分，改完必须把标签一起换掉，
 * 否则下次点开这张表会同时冒出两个标签。
 */
export function DbColumnsView({
  connectionId,
  tableName,
  schemaName,
  driver,
  columns,
  tableComment,
  ddl,
  onApplied,
  onRenamed,
  onShowToast,
}: DbColumnsViewProps) {
  /** 界面上的行；随 `columns` 重建（外层每次应用完都会重新拉一份元数据） */
  const [rows, setRows] = useState<EditableColumn[]>([]);
  const [executing, setExecuting] = useState(false);
  const [confirmContent, setConfirmContent] = useState<string | null>(null);

  /**
   * 表级选项的**草稿**。`null` 表示「还没动过」，此时显示的是从元数据 / DDL 解析出来的原值。
   *
   * 不把解析出来的值直接灌进 state：解析结果随 `ddl` / `tableComment` 变化，
   * 灌进去就得写一套同步逻辑，还得在用户改到一半时判断「该不该覆盖」。
   * 这里只存用户真正敲过的字段，原值每次渲染现算 —— 两者取谁，一目了然。
   */
  const [optDraft, setOptDraft] = useState<DbTableOptionChange | null>(null);
  /**
   * 表名草稿：`null` = 没改过，显示原表名。与表选项同理，只存用户真正敲过的值。
   *
   * 表名不走 `optDraft`：它不是表选项，而且它**会改变标签身份**，
   * 应用成功后要把新名字交回 App 去改路径与标题（见 `onRenamed`）。
   */
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  // 元数据换了就重建整份行：这是「应用成功 / 刷新」后的对齐点。
  // 依赖用内容串而不是数组引用 —— 外层每次 fetch 都给出新数组，按引用重建会把手正改到一半的行冲掉
  const columnsKey = useMemo(() => JSON.stringify(columns), [columns]);
  useEffect(() => {
    setRows(columns.map(fromMeta));
    // 结构刷新同时把表级草稿清掉，否则「应用」之后屏幕上还留着刚才那份改动
    setOptDraft(null);
    setNameDraft(null);
  }, [columnsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchRow = useCallback((key: string, patch: Partial<EditableColumn>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  const resetRows = useCallback(() => {
    setRows(columns.map(fromMeta));
    setOptDraft(null);
    setNameDraft(null);
  }, [columns]);

  // ── 表级选项：原值与草稿 ──────────────────────────────────────────────────

  const opts: DbTableOptions | null = driver === 'mysql' ? parseTableOptions(ddl) : null;

  /**
   * 数据库里的**原值**。注释走 `tableComment`（驱动无关），其余从 DDL 解析（只有 MySQL 有）。
   * PostgreSQL 的排序规则这里取不到（`SHOW CREATE TABLE` 是 MySQL 独有的），
   * 因此原值留空、输入框给一个「留空则不改」的占位 —— 与其猜一个可能错的默认值，不如让它空着。
   */
  const origOpts = useMemo(
    () => ({
      comment: tableComment ?? '',
      engine: opts?.engine ?? '',
      charset: opts?.charset ?? '',
      collation: opts?.collation ?? '',
    }),
    [tableComment, opts],
  );

  /** 表级选项的当前值（草稿优先） */
  const optValue = useCallback(
    (field: keyof DbTableOptionChange): string => optDraft?.[field] ?? origOpts[field],
    [optDraft, origOpts],
  );

  const patchOpt = useCallback((field: keyof DbTableOptionChange, value: string) => {
    setOptDraft((prev) => ({ ...(prev ?? {}), [field]: value }));
  }, []);

  /**
   * 只有**真正改过**的字段才交给语句生成器。
   *
   * 把没动过的字段也传下去，会生成一条把当前值重新写一遍的 ALTER ——
   * 对引擎 / 字符集这类选项，MySQL 会顺带重建表，代价与风险都是白挨的。
   */
  const optChange = useMemo<DbTableOptionChange>(() => {
    const out: DbTableOptionChange = {};
    if (!optDraft) return out;
    for (const field of ['comment', 'engine', 'charset', 'collation'] as const) {
      const draft = optDraft[field];
      if (draft === undefined) continue;
      if (draft.trim() === (origOpts[field] ?? '').trim()) continue;
      out[field] = draft;
    }
    return out;
  }, [optDraft, origOpts]);

  const optStatements = useMemo(() => {
    if (Object.keys(optChange).length === 0) return [] as string[];
    return buildTableOptionsSql(driver, schemaName, tableName, optChange) ?? [];
  }, [optChange, driver, schemaName, tableName]);

  const optDirtyCount = Object.keys(optChange).length;

  // ── 表改名 ────────────────────────────────────────────────────────────────

  /**
   * 表名草稿的校验与语句生成。
   *
   * 校验放在这里而不是「应用」按钮的 disabled 上：改名是**破坏性的身份变更**，
   * 用户必须看到「新名字哪里不合法」这句具体的话，而不是一个灰掉的按钮。
   */
  const rename = useMemo(() => {
    if (nameDraft === null || nameDraft.trim() === tableName) return { ok: true as const };
    return buildRenameTableStatement(driver, schemaName, tableName, nameDraft);
  }, [nameDraft, driver, schemaName, tableName]);

  const renamedTo = nameDraft !== null && nameDraft.trim() !== tableName ? nameDraft.trim() : '';

  // ── 生成待执行的 ALTER ────────────────────────────────────────────────────

  const built = useMemo(() => {
    const problems: string[] = [];
    for (const r of rows) {
      if (r.drop) continue;
      const err = validateIdentifier(r.name);
      if (err) problems.push(`列名「${r.name.trim() || '未命名'}」：${err}`);
      const lenErr = typeAcceptsLength(r.type) ? validateLength(r.length) : null;
      if (lenErr) problems.push(`列「${r.name.trim() || '未命名'}」长度：${lenErr}`);
    }

    const originalByName = new Map(columns.map((c) => [c.name, c]));
    // 只把**真正改过的行**交给语句生成器：没动过的列也生成一条 MODIFY，
    // 在 MySQL 上等于把整表重建一遍，代价和风险都是白挨的
    const changes: DbColumnChange[] = rows
      .filter((r) =>
        isColumnDirty(r, r.originalName ? originalByName.get(r.originalName) : undefined),
      )
      .map(buildAlterChange);

    const empty = { statements: [] as string[], problems, skipped: [] as string[] };
    if (changes.length === 0 || problems.length > 0) return empty;

    const res = buildAlterTableStatements(driver, schemaName, tableName, changes);
    return { statements: res.statements, problems, skipped: res.skipped ?? [] };
  }, [rows, columns, driver, schemaName, tableName]);

  const columnCount = built.statements.length;
  const renameStatements = renamedTo && rename.ok && rename.sql ? [rename.sql] : [];
  const dirtyCount = columnCount + optStatements.length + renameStatements.length;
  /**
   * 改名不合法时**整批都不放行**：DDL 是逐条下发的，
   * 允许「列改动先跑、改名后失败」只会留下一张结构已经变了、名字还没变的表。
   */
  const canApply =
    (columnCount > 0 || optStatements.length > 0 || renameStatements.length > 0) &&
    built.problems.length === 0 &&
    rename.ok &&
    !executing;

  /**
   * 待执行语句的顺序有讲究：
   * 1. **表选项最前** —— 改注释这类几乎不会失败，先跑能让「中途失败」的概率落在后面；
   * 2. **列改动居中**；
   * 3. **改名最后** —— 改名成功之后表就换了身份，此时任何**已经拼好旧表名的语句都会打空**
   *    （MySQL 甚至直接报「表不存在」）。把改名压到最后，前面的语句才始终指向正确的表。
   */
  const pendingStatements = useMemo(
    () => [...optStatements, ...built.statements, ...renameStatements],
    [optStatements, built.statements, renameStatements],
  );

  const handleApply = () => {
    if (!canApply) return;
    setConfirmContent(
      buildSqlConfirmMarkdown({
        intro: renamedTo
          ? `即将修改表「${tableName}」的结构，并把它**重命名为「${renamedTo}」**。`
          : `即将修改表「${tableName}」的结构。`,
        statements: pendingStatements,
        notes: [
          'DDL 逐条执行且**无法回滚**：若中途失败，前面的语句已经生效。',
          ...(renamedTo
            ? [`改名排在最后一条：它前面的语句仍打在旧表名「${tableName}」上。`]
            : []),
        ],
        tone: 'danger',
      }),
    );
  };

  const runApply = async () => {
    setExecuting(true);
    try {
      const outcome = await applyStatements(pendingStatements, (sql) =>
        window.ide.dbQuery(connectionId, sql, undefined, undefined, schemaName),
      );
      const msg = describeApplyResult(driver, tableName, outcome, pendingStatements.length);
      onShowToast?.(msg.title, msg.detail, msg.type);
      // 只有全部成功才重新拉元数据：部分生效时重拉会把「哪些已经改成了」这件事从屏幕上抹掉，
      // 而用户正需要它来决定怎么收拾残局
      if (outcome.ok) {
        /**
         * 改名成功要把新名字交回外层，**不能**在这里 `onApplied()` 重取：
         * 重取用的是本组件 props 里的旧表名，那会去查一张已经不存在的表。
         * 外层的 `handleTableRenamed` 会先换掉标签路径与标题，再由新视图自己加载。
         */
        if (renamedTo) onRenamed?.(renamedTo);
        else onApplied();
      }
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="db-columns-view">
      {/* ── 表级元信息：纵向列表，可改的四项直接编辑（图4）──
          只读项写死在这里，可改项统一走「暂存 → 应用」，改法与列改动一致。 */}
      <div className="db-meta-list">
        {/* 表名：可改的是**表名本身**，所属库不在这里（它在标签标题里）。
            把限定名塞进一个可编辑框里，用户很容易连着库名一起改掉。 */}
        <MetaRow label="表名">
          <input
            type="text"
            className="db-meta-input"
            value={nameDraft ?? tableName}
            title="点击可重命名这张表"
            spellCheck={false}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              // Esc 是「放弃这次改名」而不只是移开焦点 —— 否则草稿留在 state 里，
              // 界面上看着还是旧名字，点「应用」却把表改了
              if (e.key === 'Escape') {
                setNameDraft(null);
                e.currentTarget.blur();
              }
            }}
          />
        </MetaRow>
        {renamedTo && (
          <div className="db-meta-dirty">
            <span className={`db-meta-dirty-text${rename.ok ? '' : ' invalid'}`}>
              {rename.ok ? `表将重命名为「${renamedTo}」` : `表名不合法：${rename.error ?? ''}`}
            </span>
          </div>
        )}
        <MetaRow label="驱动" value={driver.toUpperCase()} />
        <MetaRow label="列数" value={String(columns.length)} />

        {/* 注释：MySQL / PG 可改；SQLite 根本没有这个概念，如实说明而不是给个改不动的框 */}
        <MetaRow label="注释">
          {driver === 'sqlite' ? (
            <span className="db-meta-value empty">SQLite 不支持表注释</span>
          ) : (
            <input
              type="text"
              className="db-meta-input"
              value={optValue('comment')}
              title="点击可修改表注释"
              placeholder="点击添加注释"
              spellCheck={false}
              onChange={(e) => patchOpt('comment', e.target.value)}
            />
          )}
        </MetaRow>

        {/* 引擎 / 字符集 / 排序规则：只有 MySQL 能读到也就能改。
            与表名 / 注释是**同一种输入框**（`.db-meta-input`）：
            同一列里几行长得不一样，会让人以为难改的那几项「不能随便动」。 */}
        {driver === 'mysql' ? (
          <>
            <MetaRow label="引擎">
              <input
                type="text"
                className="db-meta-input"
                value={optValue('engine')}
                placeholder="如 InnoDB"
                spellCheck={false}
                onChange={(e) => patchOpt('engine', e.target.value)}
              />
            </MetaRow>
            <MetaRow label="字符集">
              <input
                type="text"
                className="db-meta-input"
                value={optValue('charset')}
                placeholder="如 utf8mb4"
                spellCheck={false}
                onChange={(e) => patchOpt('charset', e.target.value)}
              />
            </MetaRow>
            <MetaRow label="排序规则">
              <input
                type="text"
                className="db-meta-input"
                value={optValue('collation')}
                placeholder="如 utf8mb4_general_ci"
                spellCheck={false}
                onChange={(e) => patchOpt('collation', e.target.value)}
              />
            </MetaRow>
          </>
        ) : driver === 'postgres' ? (
          // PG 没有字符集概念，也不像 MySQL 那样能直接从建表语句里读到排序规则
          // （要看 pg_collation）。因此这里只给「改」的入口、原值留空：
          // 留空 = 不生成语句，而不是把猜来的值写下去。
          <MetaRow label="排序规则">
            <input
              type="text"
              className="db-meta-input"
              value={optValue('collation')}
              placeholder="留空则不改，需填库中已存在的 collation"
              spellCheck={false}
              onChange={(e) => patchOpt('collation', e.target.value)}
            />
          </MetaRow>
        ) : null}

        {optDirtyCount > 0 && (
          <div className="db-meta-dirty">
            <span className="db-meta-dirty-text">表选项有 {optDirtyCount} 项改动待应用</span>
          </div>
        )}
      </div>

      {/* ── 列清单 ── */}
      <div className="db-columns-scroll">
        <table className="db-structure-table db-columns-table">
          <thead>
            <tr>
              <th style={{ width: 34 }} />
              <th style={{ width: 180 }}>列名</th>
              <th style={{ width: 132 }}>数据类型</th>
              <th style={{ width: 76 }}>长度</th>
              <th style={{ width: 42 }}>非空</th>
              <th style={{ width: 42 }}>自增</th>
              <th style={{ width: 42 }}>键</th>
              <th>默认值</th>
              <th style={{ width: 74 }}>额外</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const meta = r.originalName
                ? columns.find((c) => c.name === r.originalName)
                : undefined;
              const dirty = isColumnDirty(r, meta);
              return (
                <tr key={r.key} className={`db-column-row${dirty ? ' dirty' : ''}`}>
                  <td style={{ textAlign: 'center' }}>
                    {/* 角标与数据表表头同一套（123 / A-Z / 🕐），别处认得的记号这里也要认得 */}
                    <span className="db-col-type" title={r.type}>
                      {columnCategoryBadge(
                        { type: r.type, name: r.name } as DatabaseColumnMeta,
                        driver,
                      )}
                    </span>
                  </td>
                  <td>
                    <input
                      type="text"
                      className="db-structure-input"
                      value={r.name}
                      disabled={r.drop}
                      spellCheck={false}
                      onChange={(e) => patchRow(r.key, { name: e.target.value })}
                      style={r.drop ? { textDecoration: 'line-through' } : undefined}
                    />
                  </td>
                  <td>
                    {/* 与弹窗同款：原生 <select> 的弹出层在暗色主题下配色对不上 */}
                    <PanelSelect<string>
                      className="db-structure-select"
                      value={r.type}
                      disabled={r.drop}
                      title={r.drop ? '该列已标记删除' : '列类型'}
                      onChange={(next) => patchRow(r.key, { type: next })}
                      options={COLUMN_TYPES[driver].map((t) => ({ value: t, label: t }))}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      className="db-structure-input"
                      value={r.length}
                      disabled={r.drop || !typeAcceptsLength(r.type)}
                      placeholder={typeAcceptsLength(r.type) ? '如 255' : '—'}
                      onChange={(e) => patchRow(r.key, { length: e.target.value })}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={r.notnull}
                      disabled={r.drop}
                      onChange={(e) => patchRow(r.key, { notnull: e.target.checked })}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={r.autoIncrement}
                      /* 新增列不给改自增：`ALTER TABLE ... ADD COLUMN AUTO_INCREMENT` 在
                         MySQL 上要求该列同时是键，详见 `dbDdl.buildAlterTableStatements` 的 ADD 分支 */
                      disabled={r.drop || driver !== 'mysql' || !r.originalName}
                      title={
                        !r.originalName
                          ? '新增列的自增请在建表时指定'
                          : driver !== 'mysql'
                            ? '自增仅 MySQL 支持；PostgreSQL 请用 SERIAL 类型'
                            : '自增'
                      }
                      onChange={(e) => patchRow(r.key, { autoIncrement: e.target.checked })}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {r.pk || meta?.pk ? (
                      <span className="db-col-key" title="主键列">
                        🔑
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <input
                      type="text"
                      className="db-structure-input"
                      value={r.defaultValue}
                      disabled={r.drop}
                      placeholder="留空为无默认值"
                      onChange={(e) => patchRow(r.key, { defaultValue: e.target.value })}
                    />
                  </td>
                  <td>
                    {/* EXTRA 是数据库自己给的属性（on update CURRENT_TIMESTAMP 等），只读展示 —— 可编辑会让人以为能随手改 */}
                    <span className="db-column-extra" title={meta?.extra ?? ''}>
                      {meta?.extra || '—'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {r.originalName ? (
                      <button
                        type="button"
                        className="panel-action-btn"
                        title={r.drop ? '取消删除' : '标记删除此列'}
                        onClick={() => patchRow(r.key, { drop: !r.drop })}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={r.drop ? '#f59e0b' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
                        onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <button
          type="button"
          className="db-structure-add"
          onClick={() => setRows((prev) => [...prev, emptyColumn(driver)])}
        >
          ＋ 新增字段
        </button>
      </div>

      {/* 问题 / 跳过说明：沿用表结构弹窗那两块的配色，别处见过的红与黄这里也要认得 */}
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
      {built.problems.length === 0 && built.skipped.length === 0 && dirtyCount === 0 && (
        <div className="db-columns-idle">
          改动会先暂存在这里，点「应用」才生成 ALTER。表注释与表选项也在同一批里。
        </div>
      )}

      {/* 底部操作栏（Maven 二级栏规范） */}
      <div className="db-columns-foot">
        <span className="db-columns-foot-hint">
          {dirtyCount > 0
            ? `${dirtyCount} 条变更待应用`
            : `共 ${columns.length} 列`}
        </span>
        <div className="db-columns-foot-actions">
          <button
            type="button"
            className="panel-action-btn"
            title="放弃全部未应用的改动"
            disabled={dirtyCount === 0 || executing}
            onClick={resetRows}
          >
            <span className="db-columns-foot-label">撤销</span>
          </button>
          <button
            type="button"
            className="panel-action-btn"
            title={canApply ? '生成 ALTER，二次确认后逐条执行' : '没有可应用的改动'}
            disabled={!canApply}
            onClick={handleApply}
          >
            <span className="db-columns-foot-label primary">
              {executing ? '执行中…' : `应用${dirtyCount > 0 ? `（${dirtyCount}）` : ''}`}
            </span>
          </button>
        </div>
      </div>

      <DbConfirmModal
        isOpen={confirmContent !== null}
        title={`确认修改表结构 · ${tableName}`}
        content={confirmContent ?? ''}
        tone="danger"
        confirmLabel="确认执行"
        onConfirm={() => {
          setConfirmContent(null);
          void runApply();
        }}
        onCancel={() => setConfirmContent(null)}
      />
    </div>
  );
}
