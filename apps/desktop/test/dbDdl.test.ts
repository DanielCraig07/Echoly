import { describe, expect, it } from 'vitest';
import {
  COLUMN_TYPES,
  buildAddColumnSql,
  buildAlterTableStatements,
  buildCreateDatabaseSql,
  buildCreateTableSql,
  buildDropDatabaseSql,
  buildDropTableSql,
  buildRenameColumnSql,
  buildRenameDatabaseScript,
  buildRenameTableSql,
  buildRenameTableStatement,
  buildTableOptionsSql,
  buildTruncateTableSql,
  databaseLevelNoun,
  supportsDatabaseLevel,
  typeAcceptsLength,
  validateIdentifier,
  validateLength,
} from '../src/renderer/src/services/dbDdl';

describe('validateIdentifier / validateLength', () => {
  it('列名 / 表名：非空、不以数字开头、不含引号与空白', () => {
    expect(validateIdentifier('user_name')).toBeNull();
    expect(validateIdentifier('用户表')).toBeNull();
    expect(validateIdentifier('a$b')).toBeNull();
    expect(validateIdentifier('')).toContain('不能为空');
    expect(validateIdentifier('1abc')).toContain('不能以数字开头');
    expect(validateIdentifier('a b')).not.toBeNull();
    expect(validateIdentifier('a`b')).not.toBeNull();
    expect(validateIdentifier('a"b')).not.toBeNull();
  });

  it('长度 / 精度：留空合法，`255` 与 `10,2` 合法，其余报错', () => {
    expect(validateLength('')).toBeNull();
    expect(validateLength('255')).toBeNull();
    expect(validateLength('10,2')).toBeNull();
    expect(validateLength('10, 2')).toBeNull();
    expect(validateLength('abc')).toContain('数字');
    expect(validateLength('10,2,3')).not.toBeNull();
  });
});

describe('typeAcceptsLength · 哪些类型能用长度', () => {
  it('VARCHAR / CHAR / DECIMAL / NUMERIC 支持长度，TEXT / INT 不支持', () => {
    expect(typeAcceptsLength('VARCHAR')).toBe(true);
    expect(typeAcceptsLength('decimal')).toBe(true);
    expect(typeAcceptsLength('TEXT')).toBe(false);
    expect(typeAcceptsLength('INT')).toBe(false);
  });
});

describe('buildCreateTableSql', () => {
  it('单列主键写在列内（SQLite 的自增依赖这个形态）', () => {
    const sql = buildCreateTableSql('sqlite', 'main', 'users', [
      { name: 'id', type: 'INTEGER', pk: true, notnull: true, autoIncrement: true },
      { name: 'name', type: 'TEXT', notnull: true },
    ]);
    expect(sql).toContain('CREATE TABLE "main"."users"');
    expect(sql).toContain('"id" INTEGER AUTOINCREMENT NOT NULL PRIMARY KEY');
    expect(sql).toContain('"name" TEXT NOT NULL');
  });

  it('复合主键写成表级约束', () => {
    const sql = buildCreateTableSql('postgres', 'public', 'pair', [
      { name: 'a', type: 'INTEGER', pk: true, notnull: true },
      { name: 'b', type: 'INTEGER', pk: true, notnull: true },
    ]);
    expect(sql).toContain('PRIMARY KEY ("a", "b")');
    // 两个列本身都不该再带列内 PRIMARY KEY
    expect(sql.match(/PRIMARY KEY/g)).toHaveLength(1);
  });

  it('MySQL 的长度拼进类型；TEXT 这类不支持长度的类型忽略长度', () => {
    const withLen = buildCreateTableSql('mysql', 'shop', 't', [
      { name: 'name', type: 'VARCHAR', length: '255' },
    ]);
    expect(withLen).toContain('`name` VARCHAR(255)');
    const noLen = buildCreateTableSql('mysql', 'shop', 't', [
      { name: 'body', type: 'TEXT', length: '255' },
    ]);
    expect(noLen).toContain('`body` TEXT');
    expect(noLen).not.toContain('TEXT(255)');
  });

  it('默认值：关键字原样输出，字符串按字面量转义', () => {
    const sql = buildCreateTableSql('mysql', 'shop', 't', [
      { name: 'created', type: 'DATETIME', defaultValue: 'CURRENT_TIMESTAMP' },
      { name: 'status', type: 'VARCHAR', length: '20', defaultValue: 'active' },
    ]);
    expect(sql).toContain('DEFAULT CURRENT_TIMESTAMP');
    expect(sql).toContain("DEFAULT 'active'");
    expect(sql).not.toContain("DEFAULT 'CURRENT_TIMESTAMP'");
  });

  it('IF NOT EXISTS 开关', () => {
    const sql = buildCreateTableSql('sqlite', undefined, 't', [{ name: 'a', type: 'TEXT' }], {
      ifNotExists: true,
    });
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "t"');
  });
});

describe('DROP / RENAME / TRUNCATE TABLE', () => {
  it('DROP TABLE 用全限定名，可选 IF EXISTS', () => {
    expect(buildDropTableSql('mysql', 'shop', 'users')).toBe('DROP TABLE `shop`.`users`;');
    expect(buildDropTableSql('mysql', 'shop', 'users', { ifExists: true })).toBe(
      'DROP TABLE IF EXISTS `shop`.`users`;',
    );
  });

  it('RENAME TABLE：MySQL 目标名不帶库名前缀，其余驱动用 RENAME TO', () => {
    expect(buildRenameTableSql('mysql', 'shop', 'old', 'new')).toBe(
      'RENAME TABLE `shop`.`old` TO `new`;',
    );
    expect(buildRenameTableSql('postgres', 'public', 'old', 'new')).toBe(
      'ALTER TABLE "public"."old" RENAME TO "new";',
    );
  });

  it('TRUNCATE：SQLite 没有该语句，退化为 DELETE FROM', () => {
    expect(buildTruncateTableSql('mysql', 'shop', 'logs')).toBe('TRUNCATE TABLE `shop`.`logs`;');
    expect(buildTruncateTableSql('sqlite', 'main', 'logs')).toBe('DELETE FROM "main"."logs";');
  });
});

describe('buildAlterTableStatements · 三驱动分支', () => {
  it('MySQL：新增列 / 改名用 CHANGE / 改类型用 MODIFY / 删列', () => {
    const res = buildAlterTableStatements('mysql', 'shop', 'users', [
      { name: 'nick', type: 'VARCHAR', length: '50' },
      { name: 'name', originalName: 'username', type: 'VARCHAR', length: '80', newName: 'name' },
      { name: 'age', originalName: 'age', type: 'BIGINT' },
      { name: 'obsolete', originalName: 'obsolete', drop: true },
    ]);
    expect(res.ok).toBe(true);
    expect(res.statements.some((s) => s.startsWith('ALTER TABLE `shop`.`users` ADD COLUMN `nick`'))).toBe(true);
    expect(res.statements.some((s) => s.includes('CHANGE COLUMN `username` `name`'))).toBe(true);
    expect(res.statements.some((s) => s.includes('MODIFY COLUMN `age` BIGINT'))).toBe(true);
    expect(res.statements.some((s) => s.includes('DROP COLUMN `obsolete`'))).toBe(true);
  });

  it('PostgreSQL：改名用 RENAME COLUMN，改类型用 ALTER COLUMN ... TYPE', () => {
    const res = buildAlterTableStatements('postgres', 'public', 'users', [
      { name: 'username', originalName: 'username', type: 'VARCHAR', length: '80', newName: 'name' },
      { name: 'age', originalName: 'age', type: 'BIGINT' },
    ]);
    expect(res.statements).toContain(
      'ALTER TABLE "public"."users" RENAME COLUMN "username" TO "name";',
    );
    expect(res.statements).toContain(
      'ALTER TABLE "public"."users" ALTER COLUMN "age" TYPE BIGINT;',
    );
  });

  it('PostgreSQL：非空与默认值用 SET / DROP 分支', () => {
    const res = buildAlterTableStatements('postgres', 'public', 't', [
      { name: 'a', originalName: 'a', notnull: true },
      { name: 'b', originalName: 'b', notnull: false },
      { name: 'c', originalName: 'c', defaultValue: 'x' },
      { name: 'd', originalName: 'd', defaultValue: '' },
    ]);
    expect(res.statements).toContain('ALTER TABLE "public"."t" ALTER COLUMN "a" SET NOT NULL;');
    expect(res.statements).toContain('ALTER TABLE "public"."t" ALTER COLUMN "b" DROP NOT NULL;');
    expect(res.statements).toContain("ALTER TABLE \"public\".\"t\" ALTER COLUMN \"c\" SET DEFAULT 'x';");
    expect(res.statements).toContain('ALTER TABLE "public"."t" ALTER COLUMN "d" DROP DEFAULT;');
  });

  it('SQLite：改类型 / 改非空 / 改默认值一律跳过，并在 skipped 里说明原因', () => {
    const res = buildAlterTableStatements('sqlite', 'main', 'users', [
      { name: 'age', originalName: 'age', type: 'BIGINT' },
      { name: 'a', originalName: 'a', notnull: true },
      { name: 'b', originalName: 'b', defaultValue: 'x' },
    ]);
    expect(res.statements).toHaveLength(0);
    expect(res.skipped).toBeDefined();
    expect(res.skipped!.join(' ')).toContain('SQLite');
    expect(res.skipped!.join(' ')).toContain('整表重建');
  });

  it('SQLite：新增列、改名、删列仍然放行', () => {
    const res = buildAlterTableStatements('sqlite', 'main', 'users', [
      { name: 'nick', type: 'TEXT' },
      { name: 'name', originalName: 'username', newName: 'name' },
      { name: 'obsolete', originalName: 'obsolete', drop: true },
    ]);
    expect(res.statements).toContain('ALTER TABLE "main"."users" ADD COLUMN "nick" TEXT;');
    expect(res.statements).toContain(
      'ALTER TABLE "main"."users" RENAME COLUMN "username" TO "name";',
    );
    expect(res.statements).toContain('ALTER TABLE "main"."users" DROP COLUMN "obsolete";');
    expect(res.skipped).toBeUndefined();
  });

  it('SQLite：拒绝新增 NOT NULL 且无默认值的列（既有行没有值可填）', () => {
    const res = buildAlterTableStatements('sqlite', 'main', 'users', [
      { name: 'req', type: 'TEXT', notnull: true },
    ]);
    expect(res.statements).toHaveLength(0);
    expect(res.skipped![0]).toContain('NOT NULL');
  });

  it('MySQL：新增主键列拆成 ADD COLUMN + ADD PRIMARY KEY', () => {
    const res = buildAlterTableStatements('mysql', 'shop', 't', [
      { name: 'id', type: 'BIGINT', pk: true },
    ]);
    expect(res.statements).toHaveLength(2);
    expect(res.statements[0]).toContain('ADD COLUMN `id` BIGINT');
    expect(res.statements[0]).not.toContain('PRIMARY KEY');
    expect(res.statements[1]).toContain('ADD PRIMARY KEY (`id`)');
  });
});

describe('库 / schema 层级', () => {
  it('supportsDatabaseLevel：SQLite 没有库层级', () => {
    expect(supportsDatabaseLevel('mysql')).toBe(true);
    expect(supportsDatabaseLevel('postgres')).toBe(true);
    expect(supportsDatabaseLevel('sqlite')).toBe(false);
  });

  it('称呼：MySQL 叫数据库，PostgreSQL 叫 Schema', () => {
    expect(databaseLevelNoun('mysql')).toBe('数据库');
    expect(databaseLevelNoun('postgres')).toBe('Schema');
  });

  it('CREATE：MySQL 是 DATABASE（可选字符集），PG 是 SCHEMA，SQLite 返回 null', () => {
    expect(buildCreateDatabaseSql('mysql', 'shop')).toBe('CREATE DATABASE `shop`;');
    expect(buildCreateDatabaseSql('mysql', 'shop', { ifNotExists: true, charset: 'utf8mb4' })).toBe(
      'CREATE DATABASE IF NOT EXISTS `shop` DEFAULT CHARACTER SET utf8mb4;',
    );
    expect(buildCreateDatabaseSql('postgres', 'analytics')).toBe('CREATE SCHEMA "analytics";');
    expect(buildCreateDatabaseSql('sqlite', 'x')).toBeNull();
  });

  it('DROP：PG 带 CASCADE，避免因库内还有对象而失败', () => {
    expect(buildDropDatabaseSql('mysql', 'shop')).toBe('DROP DATABASE `shop`;');
    expect(buildDropDatabaseSql('postgres', 'analytics')).toBe('DROP SCHEMA "analytics" CASCADE;');
    expect(buildDropDatabaseSql('sqlite', 'x')).toBeNull();
  });

  it('重命名库：PG 用原生 ALTER SCHEMA RENAME', () => {
    expect(buildRenameDatabaseScript('postgres', 'a', 'b', [])).toBe(
      'ALTER SCHEMA "a" RENAME TO "b";',
    );
  });

  it('重命名库：MySQL 生成「建新库 + 逐表 RENAME + 注释掉的删旧库」脚本', () => {
    const script = buildRenameDatabaseScript('mysql', 'olddb', 'newdb', ['users', 'orders']);
    expect(script).toContain('CREATE DATABASE IF NOT EXISTS `newdb`;');
    expect(script).toContain('RENAME TABLE `olddb`.`users` TO `newdb`.`users`;');
    expect(script).toContain('RENAME TABLE `olddb`.`orders` TO `newdb`.`orders`;');
    // 删旧库必须是被注释掉的，不能自动执行
    expect(script).toContain('-- DROP DATABASE `olddb`;');
    expect(script).not.toMatch(/^DROP DATABASE/m);
  });

  it('重命名库：copy 模式生成 CREATE TABLE LIKE + INSERT SELECT', () => {
    const script = buildRenameDatabaseScript('mysql', 'a', 'b', ['t'], { copyMode: 'copy' });
    expect(script).toContain('CREATE TABLE `b`.`t` LIKE `a`.`t`;');
    expect(script).toContain('INSERT INTO `b`.`t` SELECT * FROM `a`.`t`;');
  });

  it('重命名库：没有表清单时给出提示而不是空脚本', () => {
    const script = buildRenameDatabaseScript('mysql', 'a', 'b', []);
    expect(script).toContain('未读取到表清单');
  });
});

describe('列级 DDL 快捷入口', () => {
  it('buildRenameColumnSql / buildAddColumnSql 用全限定名', () => {
    expect(buildRenameColumnSql('postgres', 'public', 't', 'a', 'b')).toBe(
      'ALTER TABLE "public"."t" RENAME COLUMN "a" TO "b";',
    );
    expect(buildAddColumnSql('mysql', 'shop', 't', { name: 'nick', type: 'VARCHAR', length: '50' })).toBe(
      'ALTER TABLE `shop`.`t` ADD COLUMN `nick` VARCHAR(50);',
    );
  });

  it('白名单覆盖三驱动的常用类型', () => {
    expect(COLUMN_TYPES.mysql).toContain('VARCHAR');
    expect(COLUMN_TYPES.postgres).toContain('JSONB');
    expect(COLUMN_TYPES.sqlite).toContain('INTEGER');
  });
});

describe('buildTableOptionsSql · 表级选项（注释 / 引擎 / 字符集 / 排序规则）', () => {
  it('MySQL 把多个表选项合并成一条 ALTER', () => {
    const sql = buildTableOptionsSql('mysql', 'shop', 'goods', {
      comment: '商品主表',
      engine: 'InnoDB',
      charset: 'utf8mb4',
      collation: 'utf8mb4_general_ci',
    });
    expect(sql).toEqual([
      "ALTER TABLE `shop`.`goods` COMMENT = '商品主表', ENGINE = InnoDB, DEFAULT CHARACTER SET = utf8mb4, COLLATE = utf8mb4_general_ci;",
    ]);
  });

  it('MySQL 只改注释时不带上任何表选项', () => {
    expect(buildTableOptionsSql('mysql', undefined, 'goods', { comment: '新注释' })).toEqual([
      "ALTER TABLE `goods` COMMENT = '新注释';",
    ]);
  });

  it('MySQL 注释里的单引号被转义，不会拼出跑不通的语句', () => {
    const sql = buildTableOptionsSql('mysql', undefined, 'goods', { comment: "it's ok" });
    expect(sql?.[0]).toContain("'it''s ok'");
  });

  it('MySQL 清空注释生成空串而不是漏掉这一项', () => {
    // 空串在 MySQL 里就是「没有注释」，与 PG 走 `IS NULL` 是同一件事的两种写法
    expect(buildTableOptionsSql('mysql', undefined, 'goods', { comment: '' })).toEqual([
      "ALTER TABLE `goods` COMMENT = '';",
    ]);
  });

  it('PostgreSQL 用 COMMENT ON TABLE，清空时走 IS NULL', () => {
    expect(buildTableOptionsSql('postgres', 'public', 'goods', { comment: '商品主表' })).toEqual([
      "COMMENT ON TABLE \"public\".\"goods\" IS '商品主表';",
    ]);
    expect(buildTableOptionsSql('postgres', 'public', 'goods', { comment: '' })).toEqual([
      'COMMENT ON TABLE "public"."goods" IS NULL;',
    ]);
  });

  it('PostgreSQL 的排序规则按标识符加引号，忽略引擎与字符集', () => {
    const sql = buildTableOptionsSql('postgres', undefined, 'goods', {
      collation: 'zh-x-icu',
      engine: 'InnoDB',
      charset: 'utf8mb4',
    });
    expect(sql).toEqual(['ALTER TABLE "goods" COLLATE "zh-x-icu";']);
  });

  it('SQLite 一律返回 null（没有表注释 / 引擎 / 字符集的概念）', () => {
    expect(buildTableOptionsSql('sqlite', undefined, 'goods', { comment: 'x' })).toBeNull();
    expect(buildTableOptionsSql('sqlite', undefined, 'goods', { engine: 'InnoDB' })).toBeNull();
  });

  it('空改动不生成任何语句', () => {
    expect(buildTableOptionsSql('mysql', undefined, 'goods', {})).toEqual([]);
  });
});

describe('buildRenameTableStatement · 表改名的校验 + 生成', () => {
  it('合法名字直接生成语句（MySQL 的目标名不带库前缀）', () => {
    const res = buildRenameTableStatement('mysql', 'shop', 'goods', 'goods_v2');
    expect(res.ok).toBe(true);
    expect(res.sql).toBe('RENAME TABLE `shop`.`goods` TO `goods_v2`;');
  });

  it('改名前后名字相同视为没改，不生成语句', () => {
    const res = buildRenameTableStatement('postgres', 'public', 'goods', '  goods  ');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('新表名与原表名相同');
  });

  it('非法名字被挡在生成之前（表名拼错等于把表改到一个谁都不认识的身份上）', () => {
    const res = buildRenameTableStatement('mysql', undefined, 'goods', 'a-b');
    expect(res.ok).toBe(false);
    expect(res.sql).toBeUndefined();
    expect(res.error).toContain('只能包含字母');
  });

  it('空名字被挡下', () => {
    const res = buildRenameTableStatement('sqlite', undefined, 'goods', '   ');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('名称不能为空');
  });
});
