import { describe, expect, it } from 'vitest';
import { buildTableSelectSql, quoteIdent } from '../src/renderer/src/services/dbIdentifiers';
import {
  isDbPath,
  isUntitledPath,
  isVirtualPath,
  requiresExactPathMatch,
} from '../src/renderer/src/utils';
/**
 * db:// 虚拟标签路径的约定与引号规则回归。
 *
 * 背景：在编辑区查看表数据 / 表结构时曾经「新开了标签却影响了已打开的代码文件」。
 * 根因是标签路径没有走统一的虚拟前缀判定，导致虚拟路径与磁盘路径在同一套
 * `endsWith('/' + path)` 宽松匹配里互相串味。这里把约定钉死，防止回归。
 */

/** 与 App.tsx / EditorPane.tsx 中构造 tab 路径的代码保持一致的拼法 */
function dataTabPath(connId: string, schema: string | undefined, table: string): string {
  const schemaSeg = schema ? `${encodeURIComponent(schema)}/` : '';
  return `db://data/${connId}/${schemaSeg}${encodeURIComponent(table)}`;
}

function ddlTabPath(connId: string, schema: string | undefined, table: string): string {
  const schemaSeg = schema ? `${encodeURIComponent(schema)}/` : '';
  return `db://ddl/${connId}/${schemaSeg}${encodeURIComponent(table)}.sql`;
}

function consoleTabPath(connId: string, schema: string | undefined, id: string): string {
  const schemaSeg = schema ? `${encodeURIComponent(schema)}/` : '';
  return `db://console/${connId}/${schemaSeg}${id}.sql`;
}

/** 复刻 EditorPane 里 db://data 分支的反解析逻辑 */
function parseDataTabPath(path: string): { connId: string; schema: string; table: string } {
  const parts = path.replace('db://data/', '').split('/');
  const connId = parts[0] || '';
  const schemaName = parts.length > 2 ? decodeURIComponent(parts[1]) : '';
  const tableName =
    parts.length > 2 ? decodeURIComponent(parts[2]) : decodeURIComponent(parts[1] || '');
  return { connId, schema: schemaName, table: tableName };
}

describe('db:// 虚拟标签路径', () => {
  it('三种虚拟标签都被识别为虚拟路径，且不被误判为草稿', () => {
    const paths = [
      dataTabPath('conn-1', 'cvm', 'users'),
      ddlTabPath('conn-1', 'cvm', 'users'),
      consoleTabPath('conn-1', 'cvm', 'ab12c'),
    ];
    for (const p of paths) {
      expect(isDbPath(p)).toBe(true);
      expect(isVirtualPath(p)).toBe(true);
      // db:// 不是 untitled:，两者是并列的虚拟类型，不能互相冒充
      expect(isUntitledPath(p)).toBe(false);
    }
  });

  it('磁盘文件不会被判定为虚拟路径', () => {
    for (const p of ['src/main/index.ts', '/abs/path/App.tsx', 'untitled:Untitled-1']) {
      if (!p.startsWith('untitled:')) {
        expect(isDbPath(p)).toBe(false);
        expect(isVirtualPath(p)).toBe(false);
      }
    }
  });

  it('编码后的路径可被无损反解析（中文库名 / 表名 / 特殊字符）', () => {
    const parsed = parseDataTabPath(dataTabPath('conn-1', '订单库', '用户 表'));
    expect(parsed).toEqual({ connId: 'conn-1', schema: '订单库', table: '用户 表' });
  });

  it('无 schema 时退化为两段式，反解析出空 schema', () => {
    const parsed = parseDataTabPath(dataTabPath('conn-1', undefined, 'users'));
    expect(parsed).toEqual({ connId: 'conn-1', schema: '', table: 'users' });
  });

  it('同一张表在同一连接下路径稳定：重复打开不会新开第二个标签', () => {
    const a = dataTabPath('conn-1', 'cvm', 'users');
    const b = dataTabPath('conn-1', 'cvm', 'users');
    expect(a).toBe(b);
    // 但不同库的同名表必须是两个独立标签
    expect(dataTabPath('conn-1', 'cvm', 'users')).not.toBe(
      dataTabPath('conn-1', 'other', 'users'),
    );
  });

  it('虚拟路径绝不与磁盘路径互为前后缀（宽松匹配不再串味）', () => {
    const vtab = dataTabPath('conn-1', 'cvm', 'users');
    const fileTab = 'src/renderer/src/components/users.tsx';
    // 旧实现用 `tp.endsWith('/' + normPath)` 双向追赶；只要任一侧命中就会写错标签页
    const loose = (a: string, b: string) =>
      a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
    // db:// 带协议头、且被 encodeURIComponent 编码过，天然不可能命中磁盘相对路径
    expect(loose(vtab, fileTab)).toBe(false);
    expect(loose(fileTab, vtab)).toBe(false);
  });

  it('requiresExactPathMatch 覆盖全部虚拟前缀，磁盘路径照旧允许追赶', () => {
    // 所有不对应磁盘文件的标签路径都必须走精确比较
    for (const p of [
      dataTabPath('conn-1', 'cvm', 'users'),
      ddlTabPath('conn-1', 'cvm', 'users'),
      consoleTabPath('conn-1', 'cvm', 'ab12c'),
      'untitled:Untitled-1',
      'git-head:/abs/src/App.tsx',
    ]) {
      expect(requiresExactPathMatch(p)).toBe(true);
    }
    // 真实磁盘路径不受影响，仍保留「绝对路径 / 工作区相对路径」的追赶兜底
    for (const p of ['src/App.tsx', '/abs/src/App.tsx', 'C:\\proj\\src\\App.tsx']) {
      expect(requiresExactPathMatch(p)).toBe(false);
    }
  });

  it('onChangeContent 的匹配器：虚拟路径只认自己，绝不回写到代码文件', () => {
    // 复刻 App.tsx onChangeContent 里的 matches 闭包
    const matches = (target: string, candidate: string): boolean => {
      const t = target.replace(/\\/g, '/').replace(/^\/+/, '');
      const c = candidate.replace(/\\/g, '/').replace(/^\/+/, '');
      if (t === c) return true;
      if (requiresExactPathMatch(t) || requiresExactPathMatch(c)) return false;
      return c.endsWith('/' + t) || t.endsWith('/' + c);
    };

    const ddl = ddlTabPath('conn-1', 'cvm', 'users');
    const fileTab = 'src/renderer/src/components/users.tsx';

    // 自身命中（重新打开同一张表只会切前台）
    expect(matches(ddl, ddl)).toBe(true);
    // 任一方向都不得落到代码文件标签上
    expect(matches(ddl, fileTab)).toBe(false);
    expect(matches(fileTab, ddl)).toBe(false);
    // 控制台里的 SQL 编辑同样不得外溢
    expect(matches(consoleTabPath('conn-1', 'cvm', 'x1'), fileTab)).toBe(false);
    // 磁盘文件之间的旧兜底行为必须保持（绝对路径 vs 工作区相对路径）
    expect(matches('src/App.tsx', '/abs/proj/src/App.tsx')).toBe(true);
  });
});

describe('表数据视图生成的 SQL', () => {
  it('MySQL 按库限定并加回引号，PostgreSQL 按 schema 限定', () => {
    // DbTableDataView 真正下发的是「去掉结尾分号 + 追加 LIMIT」，这里复刻同一拼法
    const strip = (sql: string) => sql.replace(/;$/, '');
    expect(`${strip(buildTableSelectSql('mysql', 'cvm', 'users'))} LIMIT 100;`).toBe(
      'SELECT * FROM `cvm`.`users` LIMIT 100;',
    );
    expect(`${strip(buildTableSelectSql('postgres', 'public', 'users'))} LIMIT 100;`).toBe(
      'SELECT * FROM "public"."users" LIMIT 100;',
    );
  });

  it('表名中的引号被双写转义，不会拼出可注入的 SQL', () => {
    expect(quoteIdent('mysql', 'we`ird')).toBe('`we``ird`');
    expect(buildTableSelectSql('mysql', 'cvm', 'we`ird')).toContain('`we``ird`');
  });
});
