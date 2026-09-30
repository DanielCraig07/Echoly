/**
 * 悬浮字段时的富卡片内容（图2：字段名 / 类型约束 / 表全名 / 数据库里的列注释）。
 *
 * 无 React / electron 依赖，便于 vitest 直接单测 —— 与 `dbColumnType.ts` 同款风格。
 *
 * 只负责**产出一份结构化文本**，怎么画由 `DbHoverCard` 决定：卡片是展示层的事，
 * 判定「类型怎么写、表名怎么拼」才是需要单测钉死的部分。
 */

import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import { qualifyIdent, type DbDriverType } from './dbIdentifiers';

export interface DbColumnTooltip {
  /** 字段名 */
  title: string;
  /** 完整类型声明，已带 NOT NULL / 主键等约束，如 `decimal(9,6) NOT NULL` */
  typeLine: string;
  /** 全限定表名，如 `cvm.cvm_location` */
  tableLine: string;
  /** 数据库里的列注释；没有时为 null（卡片该行不渲染） */
  description: string | null;
}

/**
 * 字段的完整类型声明。
 *
 * 各驱动的类型口径不一样，但**都已经带在 `meta.type` 里**（MySQL 的 `decimal(9,6)`、
 * PostgreSQL 的 `numeric`、SQLite 的声明原文），所以这里只做「原样 + 大写规整」，
 * 不去重建类型串 —— 重建等于把驱动的类型系统在渲染层再实现一遍，必然走偏。
 *
 * 约束按 SQL 里出现的顺序追加：NOT NULL → PRIMARY KEY → DEFAULT。
 */
export function formatColumnType(meta: DatabaseColumnMeta | undefined): string {
  if (!meta) return '';
  const base = String(meta.type || '').trim();
  const parts: string[] = [];
  if (base) parts.push(base);
  if (meta.notnull) parts.push('NOT NULL');
  if (meta.pk) parts.push('PRIMARY KEY');
  // 自增标记：图2 的 `NOT NULL` 之后常跟着它。没有它，用户会以为这个主键要自己填
  if (meta.extra && /auto_increment/i.test(meta.extra)) parts.push('AUTO_INCREMENT');
  const def = meta.dflt_value;
  // 默认值原样带出来：它正是「不填会被写成什么」的答案，比在别处单独说一遍更直接
  if (def !== null && def !== undefined && String(def) !== '') parts.push(`DEFAULT ${String(def)}`);
  return parts.join(' ');
}

/** 组装卡片内容；`comment` 为空串 / 空白一律按「没有注释」处理（不显示一行空的「说明」） */
export function buildColumnTooltip(args: {
  meta?: DatabaseColumnMeta;
  table: string;
  schema?: string;
  driver: DbDriverType;
  /** 列注释，来自 `DatabaseColumnMeta.comment`（MySQL / PG 可取，SQLite 恒为 null） */
  comment?: string | null;
}): DbColumnTooltip | null {
  const { meta, table, schema, driver, comment } = args;
  if (!meta) return null;
  const trimmedComment = typeof comment === 'string' ? comment.trim() : '';
  return {
    title: meta.name,
    typeLine: formatColumnType(meta),
    // 全限定名的拼法复用标识符模块：MySQL 一个连接下多库必须带库名，PG / SQLite 带上也无害
    tableLine: qualifyIdent(driver, schema, table),
    description: trimmedComment ? trimmedComment : null,
  };
}
