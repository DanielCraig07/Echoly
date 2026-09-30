/**
 * 表数据视图左上角的「完整 SQL」展示。
 *
 * 无 React / electron 依赖，便于 vitest 直接单测 —— 与 `dbIdentifiers.ts` / `dbTableQuery.ts` 同款风格。
 *
 * ## 为什么要有这个模块
 *
 * 筛选 / 排序条件栏原来只有几枚 chip（「筛选：name 包含 "张"」），用户看得到**意图**却看不到
 * **语句**：想核对「到底发的什么 SQL」、想把它复制到别处复用，都做不到。
 * 这里把「当前这一屏查的是什么」还原成一条可直接复制的完整语句。
 *
 * ## 与主进程分页的关系（重要）
 *
 * `dbTableQuery.buildTableQuerySql` 刻意**不带 LIMIT**，分页由主进程的 `applyPagination` 统一补
 * （见 `databaseService.ts`：仅对 `select` 开头且无 `limit` 的语句追加）。
 * 本模块为了展示补出同样的 `LIMIT n OFFSET m`，**这只是给人看的完整形态**，
 * 真正下发时 LIMIT 仍由主进程补 —— 两处规则必须一致，改动其一时这里要跟着改。
 */

import { buildTableQuerySql, type DbTableViewState } from './dbTableQuery';
import type { DbDriverType } from './dbIdentifiers';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';

/**
 * 当前视图对应的完整查询语句（含分页），用于展示与复制。
 *
 * `page` / `pageSize` 缺省时不补 LIMIT（与 `applyPagination` 的「没传就不分页」口径一致）。
 */
export function buildFullTableSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  columns: DatabaseColumnMeta[],
  view: DbTableViewState | undefined,
  page?: number,
  pageSize?: number,
): string {
  const base = buildTableQuerySql(driver, schema, table, columns, view);
  if (!page || !pageSize) return base;
  // 与主进程 applyPagination 同样的前置条件：只给 select 补、已有 limit 就不动
  if (!/^\s*select/i.test(base)) return base;
  if (/limit\s+\d+/i.test(base)) return base;
  const offset = (page - 1) * pageSize;
  return `${base.replace(/;+\s*$/, '')} LIMIT ${pageSize} OFFSET ${offset};`;
}

/**
 * 把单行 SQL 折成多行，贴近手写 SQL 的观感（图1 里那种多行展示）。
 *
 * 刻意不引第三方格式化器：只需要在几个关键字前断行并缩进，纯字符串处理便于用单测钉死，
 * 也免得为一处展示引入一个格式化依赖（它还得跟着各驱动方言走）。
 *
 * 断行点：`FROM` / `WHERE` / `GROUP BY` / `HAVING` / `ORDER BY` / `LIMIT` / `OFFSET` 之前，
 * 以及连接词 `AND` 之前。缩进用两个空格。
 */
export function prettyPrintSql(sql: string, indent: string = '  '): string {
  const trimmed = sql.trim();
  if (!trimmed) return '';
  // 先在这些「子句开头」前插入断行；顺序长的在前，避免 `GROUP BY` 被 `BY` 之类先切开
  const withBreaks = trimmed.replace(
    /\s+(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|AND|OR)\s+/gi,
    (_m, kw: string) => `\n${kw.toUpperCase()} `,
  );
  const lines = withBreaks.split('\n').map((l) => l.trim());
  const [first, ...rest] = lines;
  return [first, ...rest.map((l) => `${indent}${l}`)].join('\n');
}

/** MySQL `SHOW CREATE TABLE` 尾部解析出来的建表选项 */
export interface DbTableOptions {
  engine?: string;
  charset?: string;
  collation?: string;
}

/**
 * 从建表语句文本里解析 `ENGINE` / `DEFAULT CHARSET` / `COLLATE`。
 *
 * 只有 MySQL 的 `SHOW CREATE TABLE` 会带这些选项（PG / SQLite 的文本里没有），
 * **解析不到就返回 null**，让调用方整块不显示 —— 硬凑一个空表格比不显示更糟。
 */
export function parseTableOptions(ddl: string | undefined): DbTableOptions | null {
  if (!ddl) return null;
  const engine = /\bENGINE\s*=\s*([A-Za-z0-9_]+)/i.exec(ddl)?.[1];
  // `DEFAULT CHARSET=utf8mb4` 与 `DEFAULT CHARACTER SET=utf8mb4` 两种写法都要认
  const charset =
    /\b(?:DEFAULT\s+)?(?:CHARSET|CHARACTER\s+SET)\s*=\s*([A-Za-z0-9_]+)/i.exec(ddl)?.[1];
  const collation = /\bCOLLATE\s*=?\s*([A-Za-z0-9_]+)/i.exec(ddl)?.[1];
  if (!engine && !charset && !collation) return null;
  return { engine, charset, collation };
}
