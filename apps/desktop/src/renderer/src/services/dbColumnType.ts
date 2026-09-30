/**
 * 字段的大类归属（数值 / 日期时间 / 文本）与表头角标。
 *
 * 无 React / electron 依赖，便于 vitest 直接单测 —— 与 `dbIdentifiers.ts` 同款风格。
 *
 * 用途有两个，且必须共用同一份判定：
 * 1. 表头列名前的小角标（DataGrip 式的 `123` / `A-Z` / 🕐），一眼看出这列能不能比大小；
 * 2. 筛选浮层挑默认运算符（数值列给「等于」，文本列给「包含」）。
 *
 * 数值判定直接复用 `isNumericColumnType`：它已经处理了「MySQL 带长度/无符号后缀、
 * PostgreSQL 的 double precision、SQLite 的亲和性」这些口径差异，
 * 这里再写一遍正则迟早会和 DML 那一侧走偏。
 */

import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import { isNumericColumnType, type DbDriverType } from './dbMutations';

export type DbColumnCategory = 'number' | 'datetime' | 'text';

/** 表头角标：用符号而不是「数值/文本」两个字，窄列下才放得下 */
export const COLUMN_CATEGORY_BADGES: Record<DbColumnCategory, string> = {
  number: '123',
  datetime: '🕐',
  text: 'A-Z',
};

/**
 * 日期时间类列的类型名（剥掉长度/精度后的整词比对，大小写不敏感）。
 *
 * 刻意**按整词比对、不做 include**：`DATE` 是子串大户 —— `CANDIDATE`、`UPDATE_TIME`（列名不算，
 * 但类型里确实可能出现自定义域）都会误命中。只有 SQLite 这种声明类型千奇百怪的场景才放宽，
 * 见下面的 `isSqliteDateish`。
 */
const DATETIME_TYPE_TOKENS = new Set([
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'TIME',
  'TIMETZ',
  'YEAR',
]);

/** SQLite 声明类型里出现这些片段就按日期处理（它的列类型基本是自由文本） */
const SQLITE_DATETIME_HINTS = ['DATE', 'TIME'];

function baseTypeName(type: string): string {
  return type.replace(/\(.*$/, '').trim().toUpperCase();
}

/**
 * 该列是不是日期时间列。判定顺序是「数值优先」——`TIMESTAMP` 这类不会和数值撞，
 * 但调用方（表头）只能显示一个角标，先定数值再定日期能保证和 DML 的判定一致。
 */
export function isDateTimeColumnType(type: string | undefined, driver?: DbDriverType): boolean {
  if (!type) return false;
  const base = baseTypeName(type);
  if (!base) return false;
  // SQLite 的类型是自由文本，`DATETIME` / `TIMESTAMP` 都能整词命中；
  // 只有 `VARCHAR(32) -- date` 这种带前缀的才需要退化到片段比对
  if (driver === 'sqlite') {
    return SQLITE_DATETIME_HINTS.some((hint) => base.includes(hint));
  }
  return base.split(/\s+/).some((token) => DATETIME_TYPE_TOKENS.has(token));
}

/** 字段大类：数值 > 日期时间 > 文本（三者互斥，调用方不必处理「既是又是」） */
export function columnCategory(
  meta: DatabaseColumnMeta | undefined,
  driver?: DbDriverType,
): DbColumnCategory {
  const type = meta?.type;
  if (isNumericColumnType(type, driver)) return 'number';
  if (isDateTimeColumnType(type, driver)) return 'datetime';
  return 'text';
}

/** 表头角标文本；调用方负责在 `meta` 缺失时跳过渲染 */
export function columnCategoryBadge(
  meta: DatabaseColumnMeta | undefined,
  driver?: DbDriverType,
): string {
  return COLUMN_CATEGORY_BADGES[columnCategory(meta, driver)];
}
