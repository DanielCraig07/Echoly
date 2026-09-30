import { describe, expect, it } from 'vitest';
import {
  buildTableSelectSql,
  qualifyIdent,
  quoteIdent,
} from '../src/renderer/src/services/dbIdentifiers';

describe('quoteIdent', () => {
  it('MySQL 用反引号，其余驱动用双引号', () => {
    expect(quoteIdent('mysql', 'users')).toBe('`users`');
    expect(quoteIdent('postgres', 'users')).toBe('"users"');
    expect(quoteIdent('sqlite', 'users')).toBe('"users"');
  });

  it('名字里同类引号按 SQL 规范双写转义', () => {
    expect(quoteIdent('mysql', 'we`ird')).toBe('`we``ird`');
    expect(quoteIdent('postgres', 'we"ird')).toBe('"we""ird"');
  });
});

describe('qualifyIdent', () => {
  it('schema 缺省时退化为单段', () => {
    expect(qualifyIdent('mysql', undefined, 'users')).toBe('`users`');
    expect(qualifyIdent('postgres', '', 'users')).toBe('"users"');
  });

  it('按驱动拼全限定名', () => {
    expect(qualifyIdent('mysql', 'cvm', 'users')).toBe('`cvm`.`users`');
    expect(qualifyIdent('postgres', 'public', 'users')).toBe('"public"."users"');
  });
});

describe('buildTableSelectSql', () => {
  it('MySQL 需要库名限定，否则多库连接下会报 No database selected', () => {
    expect(buildTableSelectSql('mysql', 'cvm', 'users')).toBe('SELECT * FROM `cvm`.`users`;');
  });

  it('PostgreSQL / SQLite 输出双引号形式', () => {
    expect(buildTableSelectSql('postgres', 'public', 'users')).toBe(
      'SELECT * FROM "public"."users";',
    );
    expect(buildTableSelectSql('sqlite', 'main', 'users')).toBe('SELECT * FROM "main"."users";');
  });

  it('limit 为正整数时追加 LIMIT，非正数则忽略', () => {
    expect(buildTableSelectSql('mysql', 'cvm', 'users', 50)).toBe(
      'SELECT * FROM `cvm`.`users` LIMIT 50;',
    );
    expect(buildTableSelectSql('mysql', undefined, 'users', 0)).toBe('SELECT * FROM `users`;');
  });
});
