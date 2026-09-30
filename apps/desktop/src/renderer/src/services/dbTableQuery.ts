/**
 * 表数据的 SQL 级筛选与排序（列头点击排序 / 漏斗筛选、树上字段节点右键快捷操作）。
 *
 * 无 React / electron 依赖，便于 vitest 直接单测 —— 与 `dbIdentifiers.ts` 同款风格。
 *
 * 与视图里原有的「页内搜索」是**两层**：那层是前端对当前页内存过滤（`filterText`），
 * 本模块生成真正的 `WHERE` / `ORDER BY` 下发到数据库，因此能跨页命中。
 * 文案上必须把两者区分开，否则用户会以为筛选没生效（其实是筛了、但只筛了当前页）。
 */

import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import { qualifyIdent, quoteIdent, type DbDriverType } from './dbIdentifiers';
import { formatSqlLiteral, isNumericColumnType, pkColumnsOf, type DbCellValue } from './dbMutations';

/** 支持的条件运算符 */
export type DbTableFilterOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'isNull'
  | 'isNotNull';

export interface DbTableFilterCondition {
  column: string;
  operator: DbTableFilterOperator;
  /** `isNull` / `isNotNull` 不参与取值 */
  value?: DbCellValue;
}

export interface DbTableSort {
  column: string;
  direction: 'asc' | 'desc';
}

export interface DbTableViewState {
  filters: DbTableFilterCondition[];
  sorts: DbTableSort[];
}

export const EMPTY_VIEW_STATE: DbTableViewState = { filters: [], sorts: [] };

export function isEmptyViewState(view: DbTableViewState | undefined): boolean {
  if (!view) return true;
  const hasFilter = view.filters.some((f) => f.column);
  return !hasFilter && view.sorts.length === 0;
}

/** 运算符的中文名（下拉选项与 chip 文案共用） */
export const FILTER_OPERATOR_LABELS: Record<DbTableFilterOperator, string> = {
  eq: '等于',
  ne: '不等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  contains: '包含',
  notContains: '不包含',
  startsWith: '以…开头',
  endsWith: '以…结尾',
  isNull: '为空',
  isNotNull: '非空',
};

/**
 * 运算符的图标（列菜单里摆在文案左边）。
 *
 * 必须**一个运算符一个图标**：曾经这里是 `operatorNeedsValue(op) ? '=' : '∅'`，
 * 一个布尔量盖住了 12 个运算符 —— 「包含」「等于」「不等于」全渲染成 `=`，
 * 「为空」「非空」全渲染成 `∅`，图标和文字对不上，等于给了个假提示。
 * 现在按运算符直查，`contains` 与 `eq` 是签名的差异，`isNull` 与 `isNotNull` 差一道斜杠。
 *
 * 刻意选 ASCII 集合（`⊃` / `⊅` 除外，它们形状最贴 LIKE 语义）而不是 emoji：
 * 菜单图标宽 12px、字号 11px，emoji 在这个尺寸下会糊成一团色块。
 */
export const FILTER_OPERATOR_ICONS: Record<DbTableFilterOperator, string> = {
  eq: '=',
  ne: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: '⊃',
  notContains: '⊅',
  startsWith: 'a…',
  endsWith: '…z',
  isNull: '∅',
  isNotNull: '∅̸',
};

/** 该运算符是否需要用户填值 */
export function operatorNeedsValue(op: DbTableFilterOperator): boolean {
  return op !== 'isNull' && op !== 'isNotNull';
}

/**
 * 列头下拉里直接摆出来的常用条件。
 *
 * 这些是「看一眼就想点」的动作，放在第一层；其余（比较运算符、NOT LIKE 系列）
 * 收进「更多筛选」二级菜单，避免第一层变成 12 项的清单。
 *
 * 刻意**不按列类型过滤**：同样的运算符在不同表上可用性不一样，但决定权应该在用户手里，
 * 而不是让菜单项在某些表里凭空消失（用户会以为功能坏了）。真选了不适用的组合，
 * 数据库自己会报错，那比静默缺项好解释。
 */
export const COMMON_FILTER_OPERATORS: readonly DbTableFilterOperator[] = [
  'contains',
  'eq',
  'ne',
  'isNull',
  'isNotNull',
];

/** 「更多筛选」里的运算符：从全量里减去常用项，保证两边不重不漏 */
export const MORE_FILTER_OPERATORS: readonly DbTableFilterOperator[] = (
  Object.keys(FILTER_OPERATOR_LABELS) as DbTableFilterOperator[]
).filter((op) => !COMMON_FILTER_OPERATORS.includes(op));

/**
 * LIKE 模式串的转义。
 *
 * `%` / `_` 是 LIKE 的元字符，用户想搜「100%」时必须把它们转义成字面量，
 * 否则 `%100%%` 会变成「以 100 开头」这种完全不同的条件。
 * 转义符统一用反斜杠；SQLite 需要显式写 `ESCAPE '\'`（它默认没有转义符），
 * PostgreSQL 默认就是 `\`，MySQL 的 `\` 在字符串字面量里已被 `formatSqlLiteral` 处理过一次，
 * 所以 MySQL 侧要写 `ESCAPE '\\'`（字面量里两个反斜杠 = 一个反斜杠字符）。
 */
export function escapeLikeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** 该驱动下 `ESCAPE` 子句的字面量写法 */
export function likeEscapeClause(driver: DbDriverType): string {
  // MySQL 的字符串字面量里 `\\` 表示一个反斜杠；SQLite / PG 直接写 `\`
  return driver === 'mysql' ? "ESCAPE '\\\\'" : "ESCAPE '\\'";
}

/**
 * 生成单个条件的 SQL 片段；`column` 为空则返回 null（视为未完成的条件，跳过）。
 */
export function buildFilterClause(
  driver: DbDriverType,
  columns: DatabaseColumnMeta[],
  condition: DbTableFilterCondition,
): string | null {
  if (!condition.column) return null;
  const meta = columns.find((c) => c.name === condition.column);
  const ident = quoteIdent(driver, condition.column);
  const op = condition.operator;

  if (op === 'isNull') return `${ident} IS NULL`;
  if (op === 'isNotNull') return `${ident} IS NOT NULL`;

  const value = condition.value;
  if (value === undefined) return null;

  if (op === 'eq' || op === 'ne') {
    // NULL 的比较必须用 IS [NOT] NULL：`= NULL` 永远不成立
    if (value === null) return op === 'eq' ? `${ident} IS NULL` : `${ident} IS NOT NULL`;
    const cmp = op === 'eq' ? '=' : '<>';
    return `${ident} ${cmp} ${formatSqlLiteral(driver, value, meta?.type)}`;
  }

  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    const cmp = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
    return `${ident} ${cmp} ${formatSqlLiteral(driver, value, meta?.type)}`;
  }

  // LIKE 系列
  const text = String(value ?? '');
  const escaped = escapeLikeValue(text);
  const pattern =
    op === 'contains' || op === 'notContains'
      ? `%${escaped}%`
      : op === 'startsWith'
        ? `${escaped}%`
        : `%${escaped}`;
  const not = op === 'notContains' ? 'NOT ' : '';
  // 模式串本身仍需按驱动转义引号
  const literal = formatSqlLiteral(driver, pattern);
  return `${ident} ${not}LIKE ${literal} ${likeEscapeClause(driver)}`;
}

/** 多个条件用 AND 连接；没有有效条件时返回空串 */
export function buildWhereClause(
  driver: DbDriverType,
  columns: DatabaseColumnMeta[],
  filters: DbTableFilterCondition[],
): string {
  const parts = filters
    .map((f) => buildFilterClause(driver, columns, f))
    .filter((p): p is string => Boolean(p));
  return parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
}

/**
 * ORDER BY：按排序栈生成，末尾**自动补主键升序**做 tiebreak。
 *
 * 没有 tiebreak 时，排序值相同的行在两次查询间顺序不保证一致，
 * 翻页就会出现「第 2 页又看到第 1 页的行」这种经典错乱。
 */
export function buildOrderByClause(
  driver: DbDriverType,
  sorts: DbTableSort[],
  pkColumns: DatabaseColumnMeta[],
): string {
  const parts = sorts
    .filter((s) => s.column)
    .map((s) => `${quoteIdent(driver, s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`);

  for (const pk of pkColumns) {
    if (parts.some((p) => p.startsWith(quoteIdent(driver, pk.name)))) continue;
    parts.push(`${quoteIdent(driver, pk.name)} ASC`);
  }

  return parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : '';
}

/**
 * 数据视图的完整查询语句。
 *
 * **刻意不带 LIMIT**：分页由主进程 `applyPagination` 统一补（它只在「select 开头且没有 limit」
 * 时才追加），这样页大小、页码的唯一权威在主进程一侧，渲染层不必与它对齐两套逻辑。
 */
export function buildTableQuerySql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  columns: DatabaseColumnMeta[],
  view: DbTableViewState | undefined,
): string {
  const segments = [`SELECT * FROM ${qualifyIdent(driver, schema, table)}`];
  if (view) {
    const where = buildWhereClause(driver, columns, view.filters);
    if (where) segments.push(where);
  }
  // 即使没有任何排序也补上主键升序：顺序不确定时翻页会出现「第 2 页又见到第 1 页的行」，
  // 而这里的启发式翻页（本页满则视为有下一页）比总数分页更依赖一个稳定顺序
  const orderBy = buildOrderByClause(driver, view?.sorts ?? [], pkColumnsOf(columns));
  if (orderBy) segments.push(orderBy);
  return `${segments.join(' ')};`;
}

/** 条件的可读文案（chip 上显示），例如 `age 大于 18`、`name 包含 "张"` */
export function describeFilter(
  condition: DbTableFilterCondition,
  columnType?: string,
): string {
  const label = FILTER_OPERATOR_LABELS[condition.operator] ?? condition.operator;
  if (!operatorNeedsValue(condition.operator)) return `${condition.column} ${label}`;
  const value = condition.value;
  if (value === null || value === undefined) return `${condition.column} ${label} NULL`;
  if (typeof value === 'number' || (isNumericColumnType(columnType) && /^-?\d+(\.\d+)?$/.test(String(value)))) {
    return `${condition.column} ${label} ${value}`;
  }
  return `${condition.column} ${label} "${String(value)}"`;
}

/** 排序的可读文案，例如 `age 降序` */
export function describeSort(sort: DbTableSort): string {
  return `${sort.column} ${sort.direction === 'desc' ? '降序' : '升序'}`;
}

/**
 * 排序状态的推进。
 *
 * - 不带 `explicit`：列头点击的循环 **升序 → 降序 → 取消**。
 * - 带 `explicit`：下拉菜单里直接指定方向（升序 / 降序各是一个菜单项）。
 *   此时**再选一次同样的方向 = 取消排序** —— 菜单项没有「无方向」这一项，
 *   不给一条退路的话用户就只能靠「清除全部」把这一列摘掉。
 *
 * `append`（Cmd/Ctrl+点击列头）为真时在现有排序栈上追加 / 替换该列，而不是清空重来。
 */
export function nextSortState(
  sorts: DbTableSort[],
  column: string,
  append: boolean,
  explicit?: 'asc' | 'desc',
): DbTableSort[] {
  const current = sorts.find((s) => s.column === column);
  const advanced: DbTableSort | null = explicit
    ? current?.direction === explicit
      ? null
      : { column, direction: explicit }
    : !current
      ? { column, direction: 'asc' }
      : current.direction === 'asc'
        ? { column, direction: 'desc' }
        : null;

  if (!append) return advanced ? [advanced] : [];
  const rest = sorts.filter((s) => s.column !== column);
  return advanced ? [...rest, advanced] : rest;
}

/** 该列当前的排序方向（列头箭头用） */
export function sortDirectionOf(sorts: DbTableSort[], column: string): 'asc' | 'desc' | null {
  return sorts.find((s) => s.column === column)?.direction ?? null;
}
