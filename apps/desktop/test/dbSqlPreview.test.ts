import { describe, expect, it } from 'vitest';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import {
  buildFullTableSql,
  parseTableOptions,
  prettyPrintSql,
} from '../src/renderer/src/services/dbSqlPreview';

function col(name: string, type: string, extra: Partial<DatabaseColumnMeta> = {}): DatabaseColumnMeta {
  return { cid: 0, name, type, notnull: false, dflt_value: null, pk: false, ...extra };
}

const columns: DatabaseColumnMeta[] = [
  col('id', 'INTEGER', { cid: 0, pk: true, notnull: true }),
  col('name', 'VARCHAR(50)', { cid: 1 }),
  col('age', 'INT', { cid: 2 }),
];

describe('buildFullTableSql · 完整语句还原', () => {
  it('无筛选无排序时仍是完整语句（带主键 tiebreak 的 ORDER BY）', () => {
    const sql = buildFullTableSql('sqlite', undefined, 'users', columns, undefined);
    expect(sql).toBe('SELECT * FROM "users" ORDER BY "id" ASC;');
  });

  it('筛选与排序都体现在语句里', () => {
    const sql = buildFullTableSql('sqlite', undefined, 'users', columns, {
      filters: [{ column: 'name', operator: 'contains', value: 'ali' }],
      sorts: [{ column: 'age', direction: 'desc' }],
    });
    expect(sql).toContain('WHERE');
    expect(sql).toContain('"name" LIKE');
    expect(sql).toContain('ORDER BY "age" DESC');
    // 排序栈之后仍要补主键做 tiebreak，否则翻页会重复行
    expect(sql).toContain('"id" ASC');
  });

  it('给了页大小就补出与主进程一致的 LIMIT / OFFSET', () => {
    const sql = buildFullTableSql('sqlite', undefined, 'users', columns, undefined, 3, 50);
    expect(sql).toBe('SELECT * FROM "users" ORDER BY "id" ASC LIMIT 50 OFFSET 100;');
  });

  it('只给页码或只给页大小时不补分页（与 applyPagination「没传就不分页」一致）', () => {
    expect(buildFullTableSql('sqlite', undefined, 'users', columns, undefined, 3)).not.toContain('LIMIT');
    expect(buildFullTableSql('sqlite', undefined, 'users', columns, undefined, undefined, 50)).not.toContain(
      'LIMIT',
    );
  });

  it('MySQL 带库名限定', () => {
    const sql = buildFullTableSql('mysql', 'cvm', 'cvm_location', columns, undefined);
    expect(sql).toContain('FROM `cvm`.`cvm_location`');
  });
});

describe('prettyPrintSql · 多行格式化', () => {
  it('在 FROM / WHERE / ORDER BY 前断行并缩进两格', () => {
    const out = prettyPrintSql('SELECT * FROM "users" WHERE "age" > 18 ORDER BY "age" ASC;');
    expect(out.split('\n')).toEqual([
      'SELECT *',
      '  FROM "users"',
      '  WHERE "age" > 18',
      '  ORDER BY "age" ASC;',
    ]);
  });

  it('AND / OR 连接词也各占一行', () => {
    const out = prettyPrintSql('SELECT * FROM t WHERE a = 1 AND b = 2 OR c = 3;');
    expect(out.split('\n')).toEqual([
      'SELECT *',
      '  FROM t',
      '  WHERE a = 1',
      '  AND b = 2',
      '  OR c = 3;',
    ]);
  });

  it('GROUP BY 不被拆成 GROUP 与 BY 两行', () => {
    const out = prettyPrintSql('SELECT count(*) FROM t GROUP BY a LIMIT 10;');
    expect(out.split('\n')).toEqual([
      'SELECT count(*)',
      '  FROM t',
      '  GROUP BY a',
      '  LIMIT 10;',
    ]);
  });

  it('空串返回空串，不产出只有缩进的行', () => {
    expect(prettyPrintSql('')).toBe('');
    expect(prettyPrintSql('   ')).toBe('');
  });

  it('缩进可定制', () => {
    expect(prettyPrintSql('SELECT 1 FROM t;', '\t')).toBe('SELECT 1\n\tFROM t;');
  });
});

describe('parseTableOptions · MySQL 建表选项', () => {
  const mysqlDdl =
    'CREATE TABLE `t` (\n  `id` int NOT NULL\n) ENGINE=MyISAM AUTO_INCREMENT=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

  it('解析 ENGINE / CHARSET / COLLATE', () => {
    expect(parseTableOptions(mysqlDdl)).toEqual({
      engine: 'MyISAM',
      charset: 'utf8mb4',
      collation: 'utf8mb4_unicode_ci',
    });
  });

  it('认得 `CHARACTER SET=` 这种写法', () => {
    const opts = parseTableOptions('CREATE TABLE t (id int) ENGINE=InnoDB DEFAULT CHARACTER SET=latin1');
    expect(opts?.charset).toBe('latin1');
  });

  it('PG / SQLite 文本里没有这些选项，返回 null 而不是空对象', () => {
    expect(parseTableOptions('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);')).toBeNull();
    expect(parseTableOptions(undefined)).toBeNull();
    expect(parseTableOptions('')).toBeNull();
  });

  it('只解析到一项也算成功（另一项不编造）', () => {
    expect(parseTableOptions('CREATE TABLE t (id int) ENGINE=InnoDB')).toEqual({
      engine: 'InnoDB',
      charset: undefined,
      collation: undefined,
    });
  });
});
