/**
 * 表数据的增删改语句生成 + 「暂存改动」的纯逻辑。
 *
 * 无 React / electron 依赖，便于 vitest 直接单测 —— 与 `dbIdentifiers.ts` / `sqlStatements.ts` 同款风格。
 *
 * ## 为什么用字面量转义而不是参数绑定
 *
 * 数据视图有两条路径必须共用**同一份语句文本**：一条是 `dbExecuteBatch` 真正下发的语句，
 * 另一条是「生成 SQL」按钮展示给用户逐字复核的文本。若改用 `?` / `$1` 绑定，
 * 预览时还是得把参数渲染回字面量，等于要维护两套拼法。因此这里统一生成带字面量的 SQL，
 * 并把转义规则用单测钉死。
 *
 * ## 转义必须按驱动分开
 *
 * - MySQL 默认开启反斜杠转义（`NO_BACKSLASH_ESCAPES` 未设置时）：`\` 必须先变成 `\\`，
 *   否则一个以 `\` 结尾的值会把它后面的收尾引号「吃掉」，语句直接变成语法错误甚至注入。
 * - SQLite / PostgreSQL（`standard_conforming_strings = on`）：反斜杠是普通字符，
 *   只需把 `'` 双写成 `''`。
 */

import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import { qualifyIdent, quoteIdent, type DbDriverType } from './dbIdentifiers';

export type { DbDriverType };

/** 单元格的值：直接来自查询结果（任意类型）或用户在输入框里敲的字符串 */
export type DbCellValue = string | number | boolean | null | undefined;

// ── 字面量与类型判定 ────────────────────────────────────────────────────────

/** 这些是「按数字字面量写」的列类型（去掉长度/精度后再比对，大小写不敏感） */
const NUMERIC_TYPE_TOKENS = new Set([
  'INT',
  'INTEGER',
  'TINYINT',
  'SMALLINT',
  'MEDIUMINT',
  'BIGINT',
  'INT2',
  'INT4',
  'INT8',
  'SERIAL',
  'BIGSERIAL',
  'SMALLSERIAL',
  'DECIMAL',
  'NUMERIC',
  'DEC',
  'FIXED',
  'FLOAT',
  'FLOAT4',
  'FLOAT8',
  'DOUBLE',
  'REAL',
  'MONEY',
  'NUMBER',
  'BYTEINT',
]);

/**
 * 该列是不是数值列。
 *
 * 三驱动的 `DatabaseColumnMeta.type` 口径并不统一（MySQL `INT(11) UNSIGNED`、
 * PostgreSQL `double precision`、SQLite 声明类型原文），所以先把长度/精度剥掉再按词比对；
 * 另外 SQLite 自己的类型亲和性规则是「声明类型里含 INT 即整数亲和」，这里也照办。
 */
export function isNumericColumnType(type: string | undefined, driver?: DbDriverType): boolean {
  if (!type) return false;
  const base = type.replace(/\(.*$/, '').trim().toUpperCase();
  if (!base) return false;
  // SQLite 的亲和性规则：只要声明类型里含 "INT" 就按整数处理（含 POINT / INTERVAL 等边角情况）
  if (driver === 'sqlite' && base.includes('INT')) return true;
  return base.split(/\s+/).some((token) => NUMERIC_TYPE_TOKENS.has(token));
}

/** 数字字面量形态的字符串（用户在输入框里敲的数字都是字符串） */
function isNumericText(text: string): boolean {
  return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text.trim());
}

/** 转义字符串字面量内部（含收尾引号的处理），按驱动分流 */
function escapeStringLiteral(driver: DbDriverType, raw: string): string {
  if (driver === 'mysql') {
    // 顺序要紧：先把反斜杠自身转义掉，再处理引号；否则 `\'` 会被拆成「转义后的引号」而漏掉一层
    const withBackslashes = raw
      .replace(/\\/g, '\\\\')
      .replace(/\0/g, '\\0')
      // Ctrl-Z 在 Windows 上是文件结束符，MySQL 官方建议一并转义
      .replace(/\x1a/g, '\\Z');
    return `'${withBackslashes.replace(/'/g, "''")}'`;
  }
  return `'${raw.replace(/'/g, "''")}'`;
}

/**
 * 把 JS 值渲染成 SQL 字面量。
 *
 * `columnType` 传进来时，数值列上的「数字形态字符串」会按裸数字写（输入框的值天然是字符串，
 * 不给类型提示就会生成 `= '123'` 这种虽然能跑但很难看的语句）。
 */
export function formatSqlLiteral(
  driver: DbDriverType,
  value: DbCellValue,
  columnType?: string,
): string {
  if (value === null || value === undefined) return 'NULL';

  if (typeof value === 'number') {
    // Infinity / NaN 不是合法的 SQL 字面量，按 NULL 处理比生成一句语法错误更有用
    return Number.isFinite(value) ? String(value) : 'NULL';
  }

  if (typeof value === 'boolean') {
    if (driver === 'sqlite') return value ? '1' : '0';
    return value ? 'TRUE' : 'FALSE';
  }

  const text = String(value);
  if (isNumericColumnType(columnType, driver) && isNumericText(text)) {
    return text.trim();
  }
  return escapeStringLiteral(driver, text);
}

// ── 列默认值 ────────────────────────────────────────────────────────────────

/**
 * 该列在数据库里的默认值；没有默认值时返回 null。
 *
 * 「没有默认值」有几种形态，必须都认出来，否则新增行时会给用户显示一个假的默认值：
 * - `null` / `undefined`：SQLite 与 PostgreSQL 的「无默认值」；
 * - 空串：**MySQL 用空串表示「没有默认值」**（不是「默认值是空字符串」）；
 * - MySQL 8 的生成列会在默认值后面缀上 `DEFAULT_GENERATED`（如 `CURRENT_TIMESTAMP DEFAULT_GENERATED`），
 *   那是元数据标记、不是值的一部分，要剥掉。
 */
export function normalizeColumnDefault(
  meta: DatabaseColumnMeta | undefined,
  driver?: DbDriverType,
): string | null {
  const raw = meta?.dflt_value;
  if (raw === null || raw === undefined) return null;
  let text = String(raw);
  if (driver === 'mysql' || /DEFAULT_GENERATED/i.test(text)) {
    text = text.replace(/\s*DEFAULT_GENERATED\s*$/i, '');
  }
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 新增行里给有默认值的列显示的**灰色占位提示**（如 `1`、`''`、`CURRENT_TIMESTAMP`）。
 *
 * 注意：提示只是提示。**绝不能把它当作值写进新增行** ——
 * 用户不动这一格时，`buildInsertSql` 就该把该列排除在列清单之外，
 * 让数据库去算真正的默认值。否则 `CURRENT_TIMESTAMP` 这类会变成固定字符串字面量，
 * 自动默认值当场失效。调用方负责「只显示、不赋值」。
 */
export function defaultDisplayHint(
  meta: DatabaseColumnMeta | undefined,
  driver?: DbDriverType,
): string | null {
  const value = normalizeColumnDefault(meta, driver);
  if (value === null) return null;
  // 字符串型默认值补一层引号，和 SQL 里的观感一致（`''` 表示空串默认值）
  if (/^'.*'$/.test(value)) return value;
  return value;
}

// ── 主键与行标识 ────────────────────────────────────────────────────────────

/** 该表的主键列（复合主键按 cid 排序，保证 WHERE 里顺序稳定） */
export function pkColumnsOf(columns: DatabaseColumnMeta[]): DatabaseColumnMeta[] {
  return columns.filter((c) => c.pk).sort((a, b) => (a.cid ?? 0) - (b.cid ?? 0));
}

/**
 * 行的稳定标识（数据视图用它索引暂存改动）。
 *
 * 有主键时用主键值的 JSON 编码：`JSON.stringify` 能把「数字 1」「字符串 "1"」「null」
 * 三种情况区分开，而直接字符串拼接会把它们混成同一个 key。
 * 无主键时退回调用方给的序号 —— 这类表本来就不允许改 / 删，序号只在一次渲染内有效即可。
 */
export function buildRowKey(
  pkColumns: DatabaseColumnMeta[],
  row: Record<string, any>,
  fallbackIndex: number,
): string {
  if (pkColumns.length === 0) return `__idx_${fallbackIndex}`;
  const parts = pkColumns.map((c) => JSON.stringify(row[c.name] ?? null));
  return `pk:${parts.join('|')}`;
}

/** 只含主键条件的 WHERE 片段（不带 WHERE 关键字）；无主键时返回空串 */
export function buildRowWhereClause(
  driver: DbDriverType,
  pkColumns: DatabaseColumnMeta[],
  row: Record<string, any>,
): string {
  if (pkColumns.length === 0) return '';
  return pkColumns
    .map((col) => {
      const value = row[col.name];
      const ident = quoteIdent(driver, col.name);
      // 主键理论上非空，但视图元数据里主键列仍可能是 NULL（外连接结果、迁移中的表），
      // 用 `= NULL` 永远匹配不到任何行，必须写成 IS NULL
      if (value === null || value === undefined) return `${ident} IS NULL`;
      return `${ident} = ${formatSqlLiteral(driver, value, col.type)}`;
    })
    .join(' AND ');
}

// ── 单条 DML ────────────────────────────────────────────────────────────────

/**
 * INSERT。
 *
 * 值为 `undefined` 的列不进列清单；**空的非空主键列**也不进 —— 那是自增主键的典型形态，
 * 列进去反而会写成 `id = NULL` 或 `id = ''` 而报错 / 失去自增语义。
 */
export function buildInsertSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  columns: DatabaseColumnMeta[],
  values: Record<string, DbCellValue>,
): string {
  const target = qualifyIdent(driver, schema, table);
  const entries = columns.filter((col) => {
    const value = values[col.name];
    if (value === undefined) return false;
    if (col.pk && (value === null || value === '')) return false;
    return true;
  });

  if (entries.length === 0) {
    // 一行全用默认值：MySQL 走空列清单，其余驱动标准写法是 DEFAULT VALUES
    return driver === 'mysql'
      ? `INSERT INTO ${target} () VALUES ();`
      : `INSERT INTO ${target} DEFAULT VALUES;`;
  }

  const names = entries.map((col) => quoteIdent(driver, col.name)).join(', ');
  const literals = entries
    .map((col) => formatSqlLiteral(driver, values[col.name], col.type))
    .join(', ');
  return `INSERT INTO ${target} (${names}) VALUES (${literals});`;
}

/** UPDATE：SET 用新值，WHERE 用**原始**主键值（主键列不参与 SET） */
export function buildUpdateSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  changed: Record<string, DbCellValue>,
  columns: DatabaseColumnMeta[],
  originalRow: Record<string, any>,
): string | null {
  const pkColumns = pkColumnsOf(columns);
  const pkNames = new Set(pkColumns.map((c) => c.name));
  const sets = Object.keys(changed)
    .filter((name) => !pkNames.has(name))
    .map((name) => {
      const col = columns.find((c) => c.name === name);
      return `${quoteIdent(driver, name)} = ${formatSqlLiteral(driver, changed[name], col?.type)}`;
    });

  if (sets.length === 0) return null;
  const where = buildRowWhereClause(driver, pkColumns, originalRow);
  if (!where) return null;

  return `UPDATE ${qualifyIdent(driver, schema, table)} SET ${sets.join(', ')} WHERE ${where};`;
}

/** DELETE：WHERE 只用主键 */
export function buildDeleteSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  columns: DatabaseColumnMeta[],
  row: Record<string, any>,
): string | null {
  const where = buildRowWhereClause(driver, pkColumnsOf(columns), row);
  if (!where) return null;
  return `DELETE FROM ${qualifyIdent(driver, schema, table)} WHERE ${where};`;
}

/** 整行转 INSERT（树上「复制为 INSERT」用） */
export function buildRowInsertSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  columns: DatabaseColumnMeta[],
  row: Record<string, any>,
): string {
  return buildInsertSql(driver, schema, table, columns, row);
}

// ── 暂存改动（界面上的「未提交」状态）────────────────────────────────────────

/** 已有行上的单元格改动：`cells` 是 列名 → 新值 */
export interface DbStagedUpdate {
  rowKey: string;
  cells: Record<string, DbCellValue>;
}

/** 新增的行：提交前还没有数据库主键，用 `tempId` 在界面上标识 */
export interface DbStagedInsert {
  tempId: string;
  cells: Record<string, DbCellValue>;
}

export interface DbStagedChanges {
  updates: DbStagedUpdate[];
  inserts: DbStagedInsert[];
  /** 待删除行的 rowKey */
  deletes: string[];
}

export function emptyStagedChanges(): DbStagedChanges {
  return { updates: [], inserts: [], deletes: [] };
}

/** 值是否等价（用于「改回原值就撤销标记」）。null / undefined 视为同一回事 */
export function isSameCellValue(a: DbCellValue, b: DbCellValue): boolean {
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty && bEmpty) return true;
  if (aEmpty !== bEmpty) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

/** 改动总数（界面上的「提交 N 项」与按钮 disabled 判定用） */
export function countStagedChanges(changes: DbStagedChanges): number {
  return (
    changes.deletes.length +
    changes.updates.length +
    changes.inserts.length
  );
}

/** 某行是否有暂存改动 */
export function stagedUpdateOf(
  changes: DbStagedChanges,
  rowKey: string,
): DbStagedUpdate | undefined {
  return changes.updates.find((u) => u.rowKey === rowKey);
}

/**
 * 暂存一个单元格改动。
 * `originalValue` 是数据库里的原值：改回原值就把这条改动摘掉，避免提交一堆无意义的 UPDATE。
 */
export function stageCellEdit(
  changes: DbStagedChanges,
  rowKey: string,
  column: string,
  value: DbCellValue,
  originalValue: DbCellValue,
): DbStagedChanges {
  const existing = stagedUpdateOf(changes, rowKey);
  const nextCells = { ...(existing?.cells ?? {}) };

  if (isSameCellValue(value, originalValue)) delete nextCells[column];
  else nextCells[column] = value;

  const updates = changes.updates.filter((u) => u.rowKey !== rowKey);
  if (Object.keys(nextCells).length > 0) updates.push({ rowKey, cells: nextCells });
  return { ...changes, updates };
}

/** 暂存一个「新增行」里的单元格编辑 */
export function stageInsertCellEdit(
  changes: DbStagedChanges,
  tempId: string,
  column: string,
  value: DbCellValue,
): DbStagedChanges {
  return {
    ...changes,
    inserts: changes.inserts.map((ins) =>
      ins.tempId === tempId ? { ...ins, cells: { ...ins.cells, [column]: value } } : ins,
    ),
  };
}

/** 新增一个空行 */
export function stageInsertRow(changes: DbStagedChanges, tempId: string): DbStagedChanges {
  return { ...changes, inserts: [...changes.inserts, { tempId, cells: {} }] };
}

/** 撤销某个新增行 */
export function unstageInsertRow(changes: DbStagedChanges, tempId: string): DbStagedChanges {
  return { ...changes, inserts: changes.inserts.filter((ins) => ins.tempId !== tempId) };
}

/** 标记一行待删除（同时摘掉它的单元格改动 —— 都要删了，改它没意义） */
export function stageDeleteRow(changes: DbStagedChanges, rowKey: string): DbStagedChanges {
  return {
    updates: changes.updates.filter((u) => u.rowKey !== rowKey),
    inserts: changes.inserts,
    deletes: changes.deletes.includes(rowKey) ? changes.deletes : [...changes.deletes, rowKey],
  };
}

/** 取消「待删除」标记 */
export function unstageDeleteRow(changes: DbStagedChanges, rowKey: string): DbStagedChanges {
  return { ...changes, deletes: changes.deletes.filter((k) => k !== rowKey) };
}

// ── 提交前的校验与语句汇总 ───────────────────────────────────────────────────

/**
 * 校验新增行：非空且**没有默认值**的列必须填。
 * 返回中文缺项描述（空数组表示通过）。
 */
export function validateStagedInserts(
  columns: DatabaseColumnMeta[],
  inserts: DbStagedInsert[],
): string[] {
  const problems: string[] = [];
  for (const ins of inserts) {
    const missing = columns.filter((col) => {
      if (!col.notnull) return false;
      // 有默认值就不必填（注意 types 里 dflt_value 是 any，可能被后端解析成真正的 null）
      const hasDefault = col.dflt_value !== null && col.dflt_value !== undefined;
      if (hasDefault) return false;
      // 自增主键由数据库生成，不算缺项
      if (col.pk && isNumericColumnType(col.type)) return false;
      const value = ins.cells[col.name];
      return value === undefined || value === null || value === '';
    });
    if (missing.length > 0) {
      problems.push(
        `新增行缺少必填列：${missing.map((c) => c.name).join('、')}（这些列不允许为空且没有默认值）`,
      );
    }
  }
  return problems;
}

export type DbCommitBuildResult =
  | { ok: true; statements: string[] }
  | { ok: false; error: string };

/**
 * 把暂存改动汇总成一批语句。
 *
 * 顺序固定为 **DELETE → UPDATE → INSERT**：先删掉旧行，再改，最后插新行 ——
 * 若用户删了主键 5 又新增了主键 5 的行，这个顺序才不会撞唯一键。
 */
export function buildCommitStatements(
  changes: DbStagedChanges,
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  columns: DatabaseColumnMeta[],
  /** rowKey → 原始行（用于取主键值做 WHERE） */
  originalRows: Record<string, Record<string, any>>,
): DbCommitBuildResult {
  const pkColumns = pkColumnsOf(columns);
  const needsLocate = changes.deletes.length > 0 || changes.updates.length > 0;
  if (needsLocate && pkColumns.length === 0) {
    return {
      ok: false,
      error:
        '该表没有主键，无法唯一定位一行，因此不支持修改或删除已有数据。可新增行，或用 SQL 控制台手动操作。',
    };
  }

  const statements: string[] = [];

  for (const rowKey of changes.deletes) {
    const row = originalRows[rowKey];
    if (!row) {
      return { ok: false, error: `找不到待删除行的原始数据（${rowKey}），请刷新后重试` };
    }
    const sql = buildDeleteSql(driver, schema, table, columns, row);
    if (!sql) return { ok: false, error: '生成删除语句失败：无法构造主键条件' };
    statements.push(sql);
  }

  for (const update of changes.updates) {
    const row = originalRows[update.rowKey];
    if (!row) {
      return { ok: false, error: `找不到待修改行的原始数据（${update.rowKey}），请刷新后重试` };
    }
    const sql = buildUpdateSql(driver, schema, table, update.cells, columns, row);
    if (sql) statements.push(sql);
  }

  for (const ins of changes.inserts) {
    statements.push(buildInsertSql(driver, schema, table, columns, ins.cells));
  }

  if (statements.length === 0) return { ok: false, error: '没有可提交的改动' };
  return { ok: true, statements };
}
