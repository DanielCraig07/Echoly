/**
 * 数据库标识符拼接的纯逻辑（无 React / electron 依赖，便于 vitest 直接单测）。
 *
 * 渲染层只有 `DatabaseConnectionInfo.type` 可用，拿不到 `DatabaseService` 里的私有函数，
 * 所以这里独立实现一份同语义的拼接口径，避免组件里散落 `driver === 'mysql' ? '`' : '"'` 之类的判断。
 */

export type DbDriverType = 'sqlite' | 'mysql' | 'postgres';

/** MySQL 用反引号，SQLite / PostgreSQL 用双引号；名字里的同类引号按 SQL 规范双写转义 */
export function quoteIdent(driver: DbDriverType, name: string): string {
  if (driver === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
  return '"' + name.replace(/"/g, '""') + '"';
}

/** 全限定名：`db`.`table` / "schema"."table"；schema 为空时退化为单段 */
export function qualifyIdent(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
): string {
  const quotedTable = quoteIdent(driver, table);
  return schema ? `${quoteIdent(driver, schema)}.${quotedTable}` : quotedTable;
}

/** 生成「查询此表」用的 SELECT；MySQL 的库名必须限定（一个连接下有多个库），PG / SQLite 可省略 */
export function buildTableSelectSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  limit?: number,
): string {
  const suffix = limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '';
  return `SELECT * FROM ${qualifyIdent(driver, schema, table)}${suffix};`;
}
