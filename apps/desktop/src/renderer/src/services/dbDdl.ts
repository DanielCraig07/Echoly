/**
 * 表结构（DDL）与库 / schema 结构的语句生成。
 *
 * 无 React / electron 依赖，便于 vitest 直接单测 —— 与 `dbIdentifiers.ts` 同款风格。
 *
 * ## 三条硬约束
 *
 * 1. **DDL 不走事务**。MySQL 的 DDL 会隐式提交当前事务，SQLite / PG 的语法也各不相同，
 *    所以这些语句一律在渲染层**单条**下发（`dbQuery`），而不是塞进 `dbExecuteBatch`。
 * 2. **SQLite 的 ALTER 能力先天受限**：只支持 `ADD COLUMN` / `RENAME COLUMN` / `DROP COLUMN`，
 *    改列类型必须整表重建。本模块如实返回「不支持」而不是硬拼一条跑不通的语句，
 *    UI 据此把对应表单项置灰。
 * 3. **库层级没有统一语法**：MySQL 是 `DATABASE`、PostgreSQL 是 `SCHEMA`、SQLite 根本没有。
 *    返回 `null` 表示该驱动不支持，调用方据此隐藏菜单项。
 */

import { qualifyIdent, quoteIdent, type DbDriverType } from './dbIdentifiers';
import { formatSqlLiteral } from './dbMutations';

// ── 列类型白名单 ────────────────────────────────────────────────────────────

/**
 * 各驱动允许的列类型。
 *
 * 刻意用**固定白名单**而不是让用户自由输入：类型串无法参数化，只能拼进语句，
 * 放开输入等于把 DDL 注入的口子交给 UI。需要冷门类型时走 SQL 控制台。
 */
export const COLUMN_TYPES: Record<DbDriverType, string[]> = {
  mysql: [
    'INT',
    'BIGINT',
    'SMALLINT',
    'TINYINT',
    'DECIMAL',
    'FLOAT',
    'DOUBLE',
    'VARCHAR',
    'CHAR',
    'TEXT',
    'LONGTEXT',
    'DATE',
    'DATETIME',
    'TIMESTAMP',
    'TIME',
    'BOOLEAN',
    'JSON',
    'BLOB',
  ],
  postgres: [
    'INTEGER',
    'BIGINT',
    'SMALLINT',
    'NUMERIC',
    'REAL',
    'DOUBLE PRECISION',
    'VARCHAR',
    'CHAR',
    'TEXT',
    'DATE',
    'TIMESTAMP',
    'TIMESTAMPTZ',
    'TIME',
    'BOOLEAN',
    'JSONB',
    'BYTEA',
    'UUID',
  ],
  sqlite: [
    'INTEGER',
    'REAL',
    'TEXT',
    'BLOB',
    'NUMERIC',
    'BOOLEAN',
    'DATE',
    'DATETIME',
  ],
};

/** 需要（可选）指定长度的类型 —— UI 据此决定长度输入框是否可用 */
export function typeAcceptsLength(type: string): boolean {
  return /^(VARCHAR|CHAR|DECIMAL|NUMERIC|CHARACTER VARYING)$/i.test(type.trim());
}

// ── 列定义 ──────────────────────────────────────────────────────────────────

export interface DbColumnSpec {
  name: string;
  /** 从 {@link COLUMN_TYPES} 里选的基础类型 */
  type: string;
  /** 长度 / 精度，如 `255` 或 `10,2`；仅对 {@link typeAcceptsLength} 的类型有意义 */
  length?: string;
  notnull?: boolean;
  pk?: boolean;
  autoIncrement?: boolean;
  /** 默认值的**原文**；`defaultIsLiteral` 为真时会被转义成字符串字面量 */
  defaultValue?: string;
  defaultIsLiteral?: boolean;
}

/** 列定义里可加进语句的标识符：只放行常规名字，避免把任意文本拼进 DDL */
function safeColumnName(name: string): string {
  return name.trim();
}

/** 校验列名：非空、长度合理、不含反引号 / 双引号 / 空白等会破坏引号包裹的字符 */
export function validateIdentifier(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '名称不能为空';
  if (trimmed.length > 64) return '名称过长（最多 64 个字符）';
  if (!/^[A-Za-z_一-龥][A-Za-z0-9_$一-龥]*$/.test(trimmed)) {
    return '只能包含字母、数字、下划线、$ 与中文，且不能以数字开头';
  }
  return null;
}

/** 长度 / 精度的合法性：`255` 或 `10,2` */
export function validateLength(length: string): string | null {
  if (!length.trim()) return null;
  if (!/^\d+(\s*,\s*\d+)?$/.test(length.trim())) return '长度 / 精度必须是数字，或形如 10,2';
  return null;
}

/** 生成单列的定义片段（不含列名，供 CREATE TABLE 与 ALTER ADD COLUMN 共用） */
function columnDefinition(driver: DbDriverType, col: DbColumnSpec): string {
  let type = col.type.trim() || COLUMN_TYPES[driver][0];
  if (col.length?.trim() && typeAcceptsLength(type)) {
    type = `${type}(${col.length.trim().replace(/\s+/g, '')})`;
  }
  const parts = [quoteIdent(driver, safeColumnName(col.name)), type];

  // MySQL 的自增是列属性；PG 用 SERIAL 系列；SQLite 只有 INTEGER PRIMARY KEY 才有 rowid 自增语义
  if (col.autoIncrement) {
    if (driver === 'mysql') parts.push('AUTO_INCREMENT');
    else if (driver === 'sqlite') parts.push('AUTOINCREMENT');
  }

  if (col.notnull || col.pk) parts.push('NOT NULL');
  if (col.defaultValue !== undefined && col.defaultValue !== '') {
    parts.push(`DEFAULT ${formatDefault(driver, col)}`);
  }
  return parts.join(' ');
}

/**
 * 默认值的渲染。
 *
 * `CURRENT_TIMESTAMP` / `NULL` 这类是**关键字**，加引号就变成字面量字符串（列会存进
 * 字符串 "CURRENT_TIMESTAMP"），必须原样输出；其余值按字面量转义。
 */
function formatDefault(driver: DbDriverType, col: DbColumnSpec): string {
  const raw = String(col.defaultValue ?? '').trim();
  if (/^(NULL|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|TRUE|FALSE)$/i.test(raw)) {
    return raw.toUpperCase();
  }
  if (col.defaultIsLiteral === false) {
    // 明确声明「不是字面量」：只有当它通过数值校验时才放行，否则退回字面量，避免拼进任意文本
    if (/^-?\d+(\.\d+)?$/.test(raw)) return raw;
  }
  return formatSqlLiteral(driver, raw);
}

// ── CREATE / DROP TABLE ─────────────────────────────────────────────────────

/**
 * CREATE TABLE。
 * 单列主键写成列内 `PRIMARY KEY`，复合主键写成表级约束 —— 两者混用会让部分驱动报错。
 */
export function buildCreateTableSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  columns: DbColumnSpec[],
  options?: { ifNotExists?: boolean },
): string {
  const pkCols = columns.filter((c) => c.pk && safeColumnName(c.name));
  const compositePk = pkCols.length > 1;

  const defs = columns
    .filter((c) => safeColumnName(c.name) && c.type?.trim())
    .map((col) => {
      const def = columnDefinition(driver, col);
      // 单列主键：列内声明（SQLite 的自增依赖这个形态，不能改成表级约束）
      if (col.pk && !compositePk) return `${def} PRIMARY KEY`;
      return def;
    });

  if (compositePk) {
    defs.push(`PRIMARY KEY (${pkCols.map((c) => quoteIdent(driver, safeColumnName(c.name))).join(', ')})`);
  }

  const target = qualifyIdent(driver, schema, table);
  const ifNotExists = options?.ifNotExists ? 'IF NOT EXISTS ' : '';
  return `CREATE TABLE ${ifNotExists}${target} (\n  ${defs.join(',\n  ')}\n);`;
}

export function buildDropTableSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  options?: { ifExists?: boolean },
): string {
  const ifExists = options?.ifExists ? 'IF EXISTS ' : '';
  return `DROP TABLE ${ifExists}${qualifyIdent(driver, schema, table)};`;
}

export function buildRenameTableSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  newName: string,
): string {
  const target = qualifyIdent(driver, schema, table);
  // MySQL 的 RENAME TABLE 目标名不能带库名前缀（`RENAME TABLE a TO b`），其余驱动用 RENAME TO
  if (driver === 'mysql') return `RENAME TABLE ${target} TO ${quoteIdent(driver, newName)};`;
  return `ALTER TABLE ${target} RENAME TO ${quoteIdent(driver, newName)};`;
}

/**
 * 表重命名的**校验 + 生成**入口（表结构视图用）。
 *
 * 与 `buildRenameTableSql` 分开：那个是树上菜单直接调用的裸生成器，不校验名字。
 * 表名不比列名 —— 拼错一个字符就是把整张表改到一个谁都不认识的身份上，
 * 校验必须发生在生成语句之前，所以这里把「先校验、再生成」收成一个返回结果类型的函数，
 * 让调用方没有办法绕过校验拿到一句能跑的 SQL。
 */
export function buildRenameTableStatement(
  driver: DbDriverType,
  schema: string | undefined,
  from: string,
  to: string,
): { ok: boolean; sql?: string; error?: string } {
  const next = to.trim();
  const err = validateIdentifier(next);
  if (err) return { ok: false, error: err };
  if (next === from.trim()) return { ok: false, error: '新表名与原表名相同' };
  return { ok: true, sql: buildRenameTableSql(driver, schema, from, next) };
}

export function buildTruncateTableSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
): string {
  // SQLite 没有 TRUNCATE，标准做法是 DELETE FROM（保留表结构与 sqlite_sequence 之外的一切）
  if (driver === 'sqlite') return `DELETE FROM ${qualifyIdent(driver, schema, table)};`;
  return `TRUNCATE TABLE ${qualifyIdent(driver, schema, table)};`;
}

// ── ALTER TABLE ─────────────────────────────────────────────────────────────

/** 一列的改动意图：`originalName` 为空表示新增列，`drop` 为真表示删除该列 */
export interface DbColumnChange extends DbColumnSpec {
  /** 原列名；为空 = 新增列 */
  originalName?: string;
  /** 改名后的新名字；与 `originalName` 不同则生成改名动作 */
  newName?: string;
  drop?: boolean;
}

export interface DbAlterBuildResult {
  ok: boolean;
  statements: string[];
  /** 该驱动不支持、被跳过的改动（中文说明，UI 直接展示） */
  skipped?: string[];
  error?: string;
}

/**
 * 把「列改动清单」翻译成一批 ALTER TABLE 语句。
 *
 * 每个驱动都能做的事不一样，所以不是简单拼串：
 * - MySQL：一条语句里 `MODIFY` / `CHANGE` / `ADD` / `DROP COLUMN` 可以合并，这里仍逐项生成，便于定位失败项；
 * - PostgreSQL：`ALTER COLUMN ... TYPE` / `SET|DROP NOT NULL` / `SET|DROP DEFAULT`，改名用 `RENAME COLUMN`；
 * - SQLite：只保证 `ADD COLUMN` / `RENAME COLUMN` / `DROP COLUMN`（3.35+）；
 *   改类型 / 改非空 / 改默认值一律跳过并在 `skipped` 里说明原因。
 */
export function buildAlterTableStatements(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  changes: DbColumnChange[],
): DbAlterBuildResult {
  const target = qualifyIdent(driver, schema, table);
  const statements: string[] = [];
  const skipped: string[] = [];

  for (const change of changes) {
    const name = safeColumnName(change.name);
    const original = safeColumnName(change.originalName || '');
    const newName = safeColumnName(change.newName || '');

    // ── 新增列 ──
    if (!original) {
      if (!name || !change.type?.trim()) continue;
      if (driver === 'sqlite') {
        // SQLite 的 ADD COLUMN 不允许 NOT NULL 且无默认值（既有行没有值可填）
        const spec: DbColumnSpec = { ...change };
        if (spec.notnull && !spec.defaultValue?.trim()) {
          skipped.push(`SQLite 无法新增 NOT NULL 且无默认值的列「${name}」，已跳过（既有行无值可填）`);
          continue;
        }
        // SQLite 也不允许加主键列
        if (spec.pk) {
          skipped.push(`SQLite 无法通过 ALTER 新增主键列「${name}」，已跳过`);
          continue;
        }
        statements.push(`ALTER TABLE ${target} ADD COLUMN ${columnDefinition(driver, spec)};`);
        continue;
      }
      if (change.pk) {
        statements.push(
          `ALTER TABLE ${target} ADD COLUMN ${columnDefinition(driver, { ...change, pk: false })};`,
        );
        statements.push(
          `ALTER TABLE ${target} ADD PRIMARY KEY (${quoteIdent(driver, name)});`,
        );
        continue;
      }
      statements.push(`ALTER TABLE ${target} ADD COLUMN ${columnDefinition(driver, change)};`);
      continue;
    }

    // ── 删除列 ──
    if (change.drop) {
      statements.push(`ALTER TABLE ${target} DROP COLUMN ${quoteIdent(driver, original)};`);
      continue;
    }

    // ── 改名 ──
    if (newName && newName !== original) {
      if (driver === 'mysql') {
        // MySQL 的改名必须用 CHANGE，顺带要求重写完整类型
        statements.push(
          `ALTER TABLE ${target} CHANGE COLUMN ${quoteIdent(driver, original)} ${columnDefinition(driver, { ...change, name: newName })};`,
        );
        continue;
      }
      statements.push(
        `ALTER TABLE ${target} RENAME COLUMN ${quoteIdent(driver, original)} TO ${quoteIdent(driver, newName)};`,
      );
    }

    // 后面的类型 / 非空 / 默认值改动，作用对象是「改名后的名字」
    const effective = newName && newName !== original ? newName : original;

    // ── 改类型 ──
    if (change.type?.trim()) {
      if (driver === 'sqlite') {
        skipped.push(`SQLite 不支持修改列类型（「${effective}」需整表重建），已跳过`);
      } else if (driver === 'mysql') {
        statements.push(
          `ALTER TABLE ${target} MODIFY COLUMN ${columnDefinition(driver, { ...change, name: effective })};`,
        );
      } else {
        let type = change.type.trim();
        if (change.length?.trim() && typeAcceptsLength(type)) {
          type = `${type}(${change.length.trim().replace(/\s+/g, '')})`;
        }
        statements.push(
          `ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(driver, effective)} TYPE ${type};`,
        );
      }
    }

    // ── 非空 ──
    if (change.notnull !== undefined) {
      const action = change.notnull ? 'SET' : 'DROP';
      if (driver === 'sqlite') {
        skipped.push(`SQLite 不支持修改列的非空约束（「${effective}」需整表重建），已跳过`);
      } else if (driver === 'mysql') {
        statements.push(
          `ALTER TABLE ${target} MODIFY COLUMN ${columnDefinition(driver, { ...change, name: effective })};`,
        );
      } else {
        statements.push(
          `ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(driver, effective)} ${action} NOT NULL;`,
        );
      }
    }

    // ── 默认值 ──
    if (change.defaultValue !== undefined) {
      const hasDefault = String(change.defaultValue).trim() !== '';
      if (driver === 'sqlite') {
        skipped.push(`SQLite 不支持通过 ALTER 修改默认值（「${effective}」需整表重建），已跳过`);
      } else if (driver === 'mysql') {
        statements.push(
          `ALTER TABLE ${target} MODIFY COLUMN ${columnDefinition(driver, { ...change, name: effective })};`,
        );
      } else {
        statements.push(
          hasDefault
            ? `ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(driver, effective)} SET DEFAULT ${formatDefault(driver, change)};`
            : `ALTER TABLE ${target} ALTER COLUMN ${quoteIdent(driver, effective)} DROP DEFAULT;`,
        );
      }
    }
  }

  // 去重：MySQL 分支里「改类型 + 改非空 + 改默认值」会各自生成一条完整 MODIFY，内容常常一模一样
  const unique = Array.from(new Set(statements));
  return { ok: true, statements: unique, skipped: skipped.length > 0 ? skipped : undefined };
}

// ── 表级选项（注释 / 引擎 / 字符集 / 排序规则）────────────────────────────────

/**
 * 表级选项的改动意图。缺省（`undefined`）表示**不动这一项**，
 * 空字符串表示「清空」（清注释 / 去掉显式排序规则）。
 */
export interface DbTableOptionChange {
  /** 表注释；PG 需要先知道表有没有注释才能选 COMMENT ON / IS NULL 两句中的一句 */
  comment?: string;
  /** 引擎（仅 MySQL） */
  engine?: string;
  /** 默认字符集（仅 MySQL） */
  charset?: string;
  /** 排序规则：MySQL 与 PG 都支持；PG 上亦可作为「字符集」的等价物 */
  collation?: string;
}

/**
 * 表级选项 → 一批语句。
 *
 * 三个驱动各写各的：
 * - **MySQL**：一条 `ALTER TABLE ... COMMENT = ...` 即可，引擎 / 字符集 / 排序规则用
 *   表选项语法 `ENGINE = x, DEFAULT CHARSET = y, COLLATE = z`。注意 MySQL 的
 *   `CONVERT TO CHARACTER SET` 是**逐列改写**（会把列上的 charset 一并改掉），
 *   这里刻意用表选项语法，只动表的默认值，不悄悄改列。
 * - **PostgreSQL**：只有注释和排序规则有意义。注释走 `COMMENT ON TABLE`；
 *   PG 没有独立的字符集设置，`COLLATE` 只有 `ALTER TABLE ... COLLATE = "x"`，
 *   且要求该 collation 必须已在库里存在（`pg_collation`）—— 这里如实生成，
 *   失败原因由数据库返回。
 * - **SQLite**：三者都没有，返回 `null` 表示不支持，UI 据此整块只读了事。
 */
export function buildTableOptionsSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  change: DbTableOptionChange,
): string[] | null {
  const target = qualifyIdent(driver, schema, table);
  const statements: string[] = [];

  if (driver === 'sqlite') return null;

  if (driver === 'postgres') {
    if (change.comment !== undefined) {
      // 空值要走 `IS NULL` 而不是 `COMMENT ON ... IS ''`：后者会把注释存成空串，
      // `pg_description` 里就多出一条「有注释但内容为空」的记录，与「没有注释」不是一回事
      const trimmed = change.comment.trim();
      statements.push(
        trimmed
          ? `COMMENT ON TABLE ${target} IS ${formatSqlLiteral(driver, trimmed)};`
          : `COMMENT ON TABLE ${target} IS NULL;`,
      );
    }
    if (change.collation !== undefined) {
      const trimmed = change.collation.trim();
      // 排序规则名是标识符，不能当字符串字面量传
      if (trimmed) statements.push(`ALTER TABLE ${target} COLLATE ${quoteIdent(driver, trimmed)};`);
    }
    // PG 没有引擎 / 字符集这两个概念，传了就忽略（不生成跑不通的语句）
    return statements.length > 0 ? statements : [];
  }

  // MySQL：一条 ALTER 搞定全部表选项，多个选项用逗号连接
  const opts: string[] = [];
  if (change.comment !== undefined) {
    opts.push(`COMMENT = ${formatSqlLiteral(driver, change.comment.trim())}`);
  }
  if (change.engine !== undefined && change.engine.trim()) {
    opts.push(`ENGINE = ${change.engine.trim().replace(/[^A-Za-z0-9_]/g, '')}`);
  }
  if (change.charset !== undefined && change.charset.trim()) {
    opts.push(`DEFAULT CHARACTER SET = ${change.charset.trim().replace(/[^A-Za-z0-9_]/g, '')}`);
  }
  if (change.collation !== undefined && change.collation.trim()) {
    opts.push(`COLLATE = ${change.collation.trim().replace(/[^A-Za-z0-9_]/g, '')}`);
  }
  if (opts.length > 0) statements.push(`ALTER TABLE ${target} ${opts.join(', ')};`);
  return statements;
}

// ── 库 / schema 层级 ────────────────────────────────────────────────────────

/** 该驱动支持库 / schema 层级的增删吗（SQLite 没有这个概念） */
export function supportsDatabaseLevel(driver: DbDriverType): boolean {
  return driver === 'mysql' || driver === 'postgres';
}

/** 库层级在该驱动的称呼（拼中文提示用） */
export function databaseLevelNoun(driver: DbDriverType): string {
  return driver === 'postgres' ? 'Schema' : '数据库';
}

/** CREATE DATABASE / CREATE SCHEMA；SQLite 返回 null 表示不支持 */
export function buildCreateDatabaseSql(
  driver: DbDriverType,
  name: string,
  options?: { ifNotExists?: boolean; charset?: string },
): string | null {
  if (!supportsDatabaseLevel(driver)) return null;
  const ifNotExists = options?.ifNotExists ? 'IF NOT EXISTS ' : '';
  if (driver === 'postgres') {
    return `CREATE SCHEMA ${ifNotExists}${quoteIdent(driver, name)};`;
  }
  const charset = options?.charset?.trim()
    ? ` DEFAULT CHARACTER SET ${options.charset.trim().replace(/[^A-Za-z0-9_]/g, '')}`
    : '';
  return `CREATE DATABASE ${ifNotExists}${quoteIdent(driver, name)}${charset};`;
}

/** DROP DATABASE / DROP SCHEMA；SQLite 返回 null */
export function buildDropDatabaseSql(
  driver: DbDriverType,
  name: string,
  options?: { ifExists?: boolean },
): string | null {
  if (!supportsDatabaseLevel(driver)) return null;
  const ifExists = options?.ifExists ? 'IF EXISTS ' : '';
  const keyword = driver === 'postgres' ? 'SCHEMA' : 'DATABASE';
  // 一律带 CASCADE：MySQL 的 DROP DATABASE 本身就是级联的，PG 不加 CASCADE 会因存在对象而失败，
  // 用户体验上「删库」的预期就是删干净，这里对齐 MySQL 的语义
  const cascade = driver === 'postgres' ? ' CASCADE' : '';
  return `DROP ${keyword} ${ifExists}${quoteIdent(driver, name)}${cascade};`;
}

/**
 * 「重命名库」脚本。
 *
 * MySQL **没有** `RENAME DATABASE`（历史上出现过又被移除），只能「建新库 + 逐表迁移 + 删旧库」，
 * 所以这里只生成脚本文本供用户在控制台逐句确认，绝不自动执行。
 * PostgreSQL 有原生 `ALTER SCHEMA ... RENAME TO`，直接生成一条。
 */
export function buildRenameDatabaseScript(
  driver: DbDriverType,
  from: string,
  to: string,
  tables: string[],
  options?: { copyMode?: 'rename' | 'copy' },
): string | null {
  if (!supportsDatabaseLevel(driver)) return null;
  if (driver === 'postgres') {
    return `ALTER SCHEMA ${quoteIdent(driver, from)} RENAME TO ${quoteIdent(driver, to)};`;
  }

  const copyMode = options?.copyMode ?? 'rename';
  const lines: string[] = [
    `-- 重命名数据库 ${from} → ${to}`,
    '-- MySQL 没有 RENAME DATABASE，以下是「建新库 → 逐表迁移 → 删旧库」的等价脚本。',
    '-- 请逐条检查后执行；执行前务必备份。',
    '',
    `CREATE DATABASE IF NOT EXISTS ${quoteIdent(driver, to)};`,
    '',
  ];

  if (tables.length === 0) {
    lines.push('-- 未读取到表清单，请手动补充迁移语句。');
  } else {
    for (const table of tables) {
      const fromTable = qualifyIdent(driver, from, table);
      const toTable = qualifyIdent(driver, to, table);
      lines.push(`-- ${table}`);
      if (copyMode === 'rename') {
        lines.push(`RENAME TABLE ${fromTable} TO ${toTable};`);
      } else {
        lines.push(`CREATE TABLE ${toTable} LIKE ${fromTable};`);
        lines.push(`INSERT INTO ${toTable} SELECT * FROM ${fromTable};`);
      }
    }
  }

  lines.push('', `-- 确认数据无误后，再执行下面这条删除旧库：`, `-- DROP DATABASE ${quoteIdent(driver, from)};`);
  return lines.join('\n');
}

/** 表的重命名：库层级没有原生重命名时，也用于单表（PG 的 ALTER TABLE RENAME TO 已覆盖） */
export function buildRenameColumnSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  from: string,
  to: string,
): string {
  return `ALTER TABLE ${qualifyIdent(driver, schema, table)} RENAME COLUMN ${quoteIdent(driver, from)} TO ${quoteIdent(driver, to)};`;
}

/** 新增列（简化入口，供树上菜单直接调用） */
export function buildAddColumnSql(
  driver: DbDriverType,
  schema: string | undefined,
  table: string,
  col: DbColumnSpec,
): string {
  return `ALTER TABLE ${qualifyIdent(driver, schema, table)} ADD COLUMN ${columnDefinition(driver, col)};`;
}
