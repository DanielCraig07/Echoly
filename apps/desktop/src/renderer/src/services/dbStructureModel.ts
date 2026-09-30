/**
 * 表结构编辑的**行模型**：把数据库的列元数据与界面上的可编辑行互相转换。
 *
 * 无 React / electron 依赖，便于 vitest 直接单测 —— 与 `dbDdl.ts` 同款风格。
 *
 * 这套模型原本长在 `TableStructureModal` 里（只服务「新建表 / 设计表」弹窗）。
 * 编辑区的「查看表结构 → 列」视图要的是完全相同的一套东西，于是抽到这里共用：
 * 弹窗与列视图各画各的界面，但「一行怎么变成一条 `DbColumnChange`」只此一份，
 * 否则两处的改名 / 改类型判定迟早走偏（比如一处认 `dflt_value` 为 `''` 是空、另一处不认）。
 */

import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import {
  COLUMN_TYPES,
  type DbColumnChange,
  type DbColumnSpec,
} from './dbDdl';
import type { DbDriverType } from './dbIdentifiers';

/** 界面上的列行（新建表与编辑表结构共用） */
export interface EditableColumn {
  key: string;
  name: string;
  type: string;
  length: string;
  notnull: boolean;
  pk: boolean;
  autoIncrement: boolean;
  defaultValue: string;
  /** 数据库里的原列名；为空表示这是**新增列** */
  originalName?: string;
  /** 是否删除该列 */
  drop?: boolean;
}

let seq = 0;
/** 行 key：只用于 React 列表与「改到哪一行」的定位，与列名解耦（列名本身可改） */
export function nextColumnKey(): string {
  seq += 1;
  return `col_${seq}`;
}

/**
 * 由列元数据造一行。
 *
 * 类型里的长度要**剥出来单独放**：`type` 直接留着 `VARCHAR(50)` 的话，
 * 用户改长度会改出 `VARCHAR(50)(100)` 这种废串。
 */
export function fromMeta(meta: DatabaseColumnMeta): EditableColumn {
  const match = /^([^(]+)(?:\(([^)]*)\))?/.exec(meta.type || '') ?? [];
  return {
    key: nextColumnKey(),
    name: meta.name,
    type: (match[1] || 'TEXT').trim().toUpperCase(),
    length: (match[2] || '').trim(),
    notnull: Boolean(meta.notnull),
    pk: Boolean(meta.pk),
    // 自增只能从 EXTRA 读出来（MySQL）。第一版没读它，结果设计表时把 AUTO_INCREMENT 抹掉了
    autoIncrement: /auto_increment/i.test(String(meta.extra || '')),
    defaultValue:
      meta.dflt_value === null || meta.dflt_value === undefined ? '' : String(meta.dflt_value),
    originalName: meta.name,
  };
}

/** 一行空白列（新增字段 / 新建表的初始行） */
export function emptyColumn(driver: DbDriverType): EditableColumn {
  return {
    key: nextColumnKey(),
    name: '',
    type: COLUMN_TYPES[driver][0],
    length: '',
    notnull: false,
    pk: false,
    autoIncrement: false,
    defaultValue: '',
  };
}

/** 行 → CREATE TABLE 的列定义 */
export function toColumnSpec(row: EditableColumn): DbColumnSpec {
  return {
    name: row.name.trim(),
    type: row.type,
    length: row.length,
    notnull: row.notnull,
    pk: row.pk,
    autoIncrement: row.autoIncrement,
    defaultValue: row.defaultValue,
  };
}

/**
 * 行 → ALTER 的变更描述。
 *
 * 三条约定，都来自 `buildAlterTableStatements` 的语义：
 * - `name` 对已有列传**原列名**，纯改名时新名字走 `newName`（MySQL 的 `CHANGE COLUMN` 需要原+新）；
 * - `newName` 只在确实变了的时候给，否则会把「没改名」也生成一条 RENAME；
 * - `drop` 的行同样带上 `name`（原列名），生成 `DROP COLUMN` 要用它。
 */
export function buildAlterChange(row: EditableColumn): DbColumnChange {
  const trimmed = row.name.trim();
  const newName = row.originalName && trimmed !== row.originalName ? trimmed : undefined;
  return {
    ...toColumnSpec(row),
    name: row.originalName ? row.originalName : trimmed,
    originalName: row.originalName,
    newName,
    drop: row.drop,
  };
}

/** 该行是否被改动过（决定「应用」按钮是否可用、以及要不要画标记） */
export function isColumnDirty(row: EditableColumn, original: DatabaseColumnMeta | undefined): boolean {
  if (row.drop) return true;
  if (!row.originalName) return true; // 新增列一定是改动
  if (!original) return true; // 找不到原元数据时说不上「没变」，按改动处理更安全
  const base = fromMetaShape(original);
  return (
    row.name.trim() !== base.name ||
    row.type.trim().toUpperCase() !== base.type ||
    row.length.trim() !== base.length ||
    row.notnull !== base.notnull ||
    row.pk !== base.pk ||
    row.autoIncrement !== base.autoIncrement ||
    row.defaultValue !== base.defaultValue
  );
}

/** 只比较字段、不消耗 key 序号（`fromMeta` 每次调用都会自增 key，批量比较时不能拿它当纯函数用） */
function fromMetaShape(meta: DatabaseColumnMeta): Omit<EditableColumn, 'key'> {
  const match = /^([^(]+)(?:\(([^)]*)\))?/.exec(meta.type || '') ?? [];
  return {
    name: meta.name,
    type: (match[1] || 'TEXT').trim().toUpperCase(),
    length: (match[2] || '').trim(),
    notnull: Boolean(meta.notnull),
    pk: Boolean(meta.pk),
    autoIncrement: /auto_increment/i.test(String(meta.extra || '')),
    defaultValue:
      meta.dflt_value === null || meta.dflt_value === undefined ? '' : String(meta.dflt_value),
    originalName: meta.name,
  };
}
