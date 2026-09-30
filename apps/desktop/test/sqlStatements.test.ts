import { describe, expect, it } from 'vitest';
import {
  splitSqlStatements,
  statementAtOffset,
  resolveExecutableSql,
} from '../src/renderer/src/services/sqlStatements';

describe('sqlStatements 语句切分', () => {
  it('按分号切分截图中的多语句脚本', () => {
    const sql = 'show databases;\nuse cvm;\nshow tables;';
    const stmts = splitSqlStatements(sql);
    expect(stmts.map((s) => s.text)).toEqual(['show databases', 'use cvm', 'show tables']);
  });

  it('保留末尾没有分号的语句', () => {
    const stmts = splitSqlStatements('select 1;\nselect 2');
    expect(stmts.map((s) => s.text)).toEqual(['select 1', 'select 2']);
  });

  it('忽略空片段与纯注释片段', () => {
    const stmts = splitSqlStatements(';;  ;\n-- 只是注释\n;\n/* 块注释 */\n;');
    expect(stmts).toEqual([]);
  });

  it('语句内保留前置注释，但注释后仍有真实 SQL 时不算空片段', () => {
    const stmts = splitSqlStatements('/* 块注释 */\nselect 1;');
    expect(stmts).toHaveLength(1);
    expect(stmts[0].text).toContain('select 1');
  });

  it('不切分单引号字符串里的分号，并处理 "" 与 \\\\\' 转义', () => {
    const stmts = splitSqlStatements("select 'a;b', '' as e, 'it\\'s;ok' from t; select 2;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0].text).toBe("select 'a;b', '' as e, 'it\\'s;ok' from t");
  });

  it('不切分标识符引用（双引号 / 反引号）里的分号', () => {
    const stmts = splitSqlStatements('select `we;ird`, "al;so" from t; select 2;');
    expect(stmts).toHaveLength(2);
    expect(stmts[0].text).toBe('select `we;ird`, "al;so" from t');
  });

  it('不切分行注释（-- 与 #）里的分号', () => {
    const stmts = splitSqlStatements('select 1 -- a; b\n; select 2 # c; d\n;');
    expect(stmts.map((s) => s.text.replace(/\s+/g, ' '))).toEqual([
      'select 1 -- a; b',
      'select 2 # c; d',
    ]);
  });

  it('不切分块注释里的分号，并支持 PostgreSQL 嵌套块注释', () => {
    const stmts = splitSqlStatements('select /* a; b /* nested; */ still; */ 1; select 2;');
    expect(stmts).toHaveLength(2);
    expect(stmts[0].text).toContain('nested;');
  });

  it('不切分 dollar-quoted 块里的分号', () => {
    const sql = 'create function f() returns int as $fn$ begin; return 1; end; $fn$ language plpgsql; select 2;';
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0].text).toContain('$fn$');
    expect(stmts[0].text).toContain('return 1;');
  });

  it('未闭合的块注释不抛异常', () => {
    const stmts = splitSqlStatements('select 1; /* 未闭合 ; ; ;');
    expect(stmts.map((s) => s.text)).toEqual(['select 1']);
  });

  it('空输入与纯空白输入返回空数组', () => {
    expect(splitSqlStatements('')).toEqual([]);
    expect(splitSqlStatements('   \n\t ')).toEqual([]);
  });
});

describe('sqlStatements 光标定位', () => {
  const sql = 'show databases;\nuse cvm;\nshow tables;';

  it('光标位于某条语句内时命中该条', () => {
    const third = sql.indexOf('show tables');
    expect(statementAtOffset(sql, third + 3)?.text).toBe('show tables');
  });

  it('光标落在语句之间的空白处时归属下一条', () => {
    const between = sql.indexOf(';') + 1; // 第一条分号之后
    expect(statementAtOffset(sql, between)?.text).toBe('use cvm');
  });

  it('光标位于末尾时命中最后一条', () => {
    expect(statementAtOffset(sql, sql.length)?.text).toBe('show tables');
  });

  it('无有效语句时返回 null', () => {
    expect(statementAtOffset('   ', 1)).toBeNull();
  });
});

describe('sqlStatements 执行内容解析', () => {
  const sql = 'show databases;\nuse cvm;\nshow tables;';

  it('有选区时优先只执行选中内容', () => {
    const start = sql.indexOf('cvm');
    const text = 'cvm;';
    expect(
      resolveExecutableSql(sql, { start, end: start + text.length, text }, start),
    ).toBe('cvm;');
  });

  it('选区是空白时不当作选中内容', () => {
    const start = sql.indexOf('\n') + 1;
    const text = '   ';
    expect(resolveExecutableSql(sql, { start, end: start + 3, text }, start)).toBe('use cvm');
  });

  it('无选区时执行光标所在语句', () => {
    const third = sql.indexOf('show tables');
    expect(resolveExecutableSql(sql, null, third)).toBe('show tables');
  });

  it('无选区且无光标时回退整篇', () => {
    expect(resolveExecutableSql('select 1', null)).toBe('select 1');
  });
});
