import { describe, expect, it } from 'vitest';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import {
  buildCommitStatements,
  buildDeleteSql,
  buildInsertSql,
  buildRowKey,
  buildRowWhereClause,
  buildUpdateSql,
  countStagedChanges,
  defaultDisplayHint,
  emptyStagedChanges,
  formatSqlLiteral,
  isNumericColumnType,
  normalizeColumnDefault,
  pkColumnsOf,
  stageInsertCellEdit,
  stageCellEdit,
  stageDeleteRow,
  stageInsertRow,
  unstageDeleteRow,
  validateStagedInserts,
} from '../src/renderer/src/services/dbMutations';
import type { DbDriverType } from '../src/renderer/src/services/dbIdentifiers';

/** 造列元数据：只填测试关心的字段 */
function col(name: string, type: string, extra: Partial<DatabaseColumnMeta> = {}): DatabaseColumnMeta {
  return { cid: 0, name, type, notnull: false, dflt_value: null, pk: false, ...extra };
}

const usersColumns: DatabaseColumnMeta[] = [
  col('id', 'INTEGER', { cid: 0, pk: true, notnull: true }),
  col('username', 'VARCHAR(50)', { cid: 1, notnull: true }),
  col('age', 'INT', { cid: 2 }),
];

const usersRow = { id: 7, username: 'alice', age: 30 };

describe('formatSqlLiteral · 值字面量与转义', () => {
  it('null / undefined 一律写成 NULL', () => {
    for (const driver of ['sqlite', 'mysql', 'postgres'] as DbDriverType[]) {
      expect(formatSqlLiteral(driver, null)).toBe('NULL');
      expect(formatSqlLiteral(driver, undefined)).toBe('NULL');
    }
  });

  it('数字裸写；Infinity / NaN 退化为 NULL（不是合法 SQL 字面量）', () => {
    expect(formatSqlLiteral('sqlite', 42)).toBe('42');
    expect(formatSqlLiteral('sqlite', -1.5)).toBe('-1.5');
    expect(formatSqlLiteral('sqlite', Infinity)).toBe('NULL');
    expect(formatSqlLiteral('sqlite', NaN)).toBe('NULL');
  });

  it('布尔值：SQLite 写 1/0，MySQL 与 PG 写 TRUE/FALSE', () => {
    expect(formatSqlLiteral('sqlite', true)).toBe('1');
    expect(formatSqlLiteral('sqlite', false)).toBe('0');
    expect(formatSqlLiteral('mysql', true)).toBe('TRUE');
    expect(formatSqlLiteral('postgres', false)).toBe('FALSE');
  });

  it('字符串里的单引号双写转义', () => {
    expect(formatSqlLiteral('sqlite', "O'Brien")).toBe("'O''Brien'");
    expect(formatSqlLiteral('mysql', "O'Brien")).toBe("'O''Brien'");
    expect(formatSqlLiteral('postgres', "O'Brien")).toBe("'O''Brien'");
  });

  it('MySQL 额外转义反斜杠，SQLite / PostgreSQL 不转（standard_conforming_strings）', () => {
    expect(formatSqlLiteral('mysql', 'a\\b')).toBe("'a\\\\b'");
    expect(formatSqlLiteral('sqlite', 'a\\b')).toBe("'a\\b'");
    expect(formatSqlLiteral('postgres', 'a\\b')).toBe("'a\\b'");
  });

  it('回归：以反斜杠结尾的值在 MySQL 下必须仍然闭合（否则收尾引号被吃掉）', () => {
    // 用户输入 windows\ → 若不转义反斜杠，会生成 'windows\'，那个 \' 变成转义引号，
    // 字符串不闭合，后续拼接的内容就成了 SQL 的一部分（既是语法错误也是注入面）
    const literal = formatSqlLiteral('mysql', 'windows\\');
    expect(literal).toBe("'windows\\\\'");
    expect(literal.endsWith("'")).toBe(true);
    // 收尾的两个字符必须是「转义后的反斜杠 + 收尾引号」，否则那个 \' 会被当成转义引号
    expect(literal.slice(-2)).toBe('\\' + "'");
  });

  it('MySQL 一并转义 NUL 与 Ctrl-Z（官方建议）', () => {
    expect(formatSqlLiteral('mysql', 'a\0b')).toBe("'a\\0b'");
    expect(formatSqlLiteral('mysql', 'a\x1ab')).toBe("'a\\Zb'");
  });

  it('给了数值列类型时，数字形态的字符串按裸数字写', () => {
    expect(formatSqlLiteral('sqlite', '42', 'INT')).toBe('42');
    expect(formatSqlLiteral('sqlite', '42', 'VARCHAR(10)')).toBe("'42'");
    // 非数字形态的字符串即使在数值列上也仍按字面量转义，避免拼进任意文本
    expect(formatSqlLiteral('sqlite', '1 OR 1=1', 'INT')).toBe("'1 OR 1=1'");
  });
});

describe('isNumericColumnType · 三驱动的类型口径归一', () => {
  it('识别常见数值类型，且能剥掉长度与精度', () => {
    expect(isNumericColumnType('INT')).toBe(true);
    expect(isNumericColumnType('INT(11)')).toBe(true);
    expect(isNumericColumnType('decimal(10,2)')).toBe(true);
    expect(isNumericColumnType('double precision')).toBe(true);
    expect(isNumericColumnType('BIGINT UNSIGNED')).toBe(true);
  });

  it('文本 / 时间类型不算数值', () => {
    expect(isNumericColumnType('VARCHAR(50)')).toBe(false);
    expect(isNumericColumnType('TEXT')).toBe(false);
    expect(isNumericColumnType(undefined)).toBe(false);
  });

  it('SQLite 按亲和性规则：声明类型里含 INT 即为数值（如 BIGINT / MEDIUMINT）', () => {
    expect(isNumericColumnType('BIGINT', 'sqlite')).toBe(true);
    expect(isNumericColumnType('MEDIUMINT', 'sqlite')).toBe(true);
  });
});

describe('主键定位', () => {
  it('pkColumnsOf 只挑主键列并按 cid 排序（复合主键的 WHERE 顺序要稳定）', () => {
    const composite = [
      col('b', 'INT', { cid: 2, pk: true }),
      col('a', 'INT', { cid: 1, pk: true }),
      col('note', 'TEXT', { cid: 3 }),
    ];
    expect(pkColumnsOf(composite).map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('buildRowWhereClause 只含主键条件，无主键时返回空串', () => {
    expect(buildRowWhereClause('sqlite', pkColumnsOf(usersColumns), usersRow)).toBe('"id" = 7');
    expect(buildRowWhereClause('mysql', pkColumnsOf(usersColumns), usersRow)).toBe('`id` = 7');
    expect(buildRowWhereClause('sqlite', [], usersRow)).toBe('');
  });

  it('主键值为 NULL 时写成 IS NULL（= NULL 永远匹配不到任何行）', () => {
    const pk = pkColumnsOf(usersColumns);
    expect(buildRowWhereClause('sqlite', pk, { id: null })).toBe('"id" IS NULL');
  });

  it('buildRowKey 用 JSON 编码主键值，数字 1 与字符串 "1" 不会撞车', () => {
    const pk = pkColumnsOf(usersColumns);
    expect(buildRowKey(pk, { id: 1 }, 0)).not.toBe(buildRowKey(pk, { id: '1' }, 0));
    expect(buildRowKey(pk, { id: 1 }, 0)).toBe(buildRowKey(pk, { id: 1 }, 5));
  });

  it('无主键表退回序号做 rowKey', () => {
    expect(buildRowKey([], { a: 1 }, 3)).toBe('__idx_3');
  });
});

describe('buildInsertSql', () => {
  it('生成列清单 + 字面量，空值列不参与', () => {
    const sql = buildInsertSql('sqlite', 'main', 'users', usersColumns, {
      id: 9,
      username: 'bob',
      age: undefined,
    });
    expect(sql).toBe('INSERT INTO "main"."users" ("id", "username") VALUES (9, \'bob\');');
  });

  it('空的自增主键不进列清单（让数据库自己生成）', () => {
    const sql = buildInsertSql('mysql', 'shop', 'users', usersColumns, {
      id: '',
      username: 'carol',
    });
    expect(sql).toBe("INSERT INTO `shop`.`users` (`username`) VALUES ('carol');");
  });  it('一行全用默认值时按驱动给合法形态', () => {
    expect(buildInsertSql('mysql', undefined, 't', usersColumns, {})).toBe(
      'INSERT INTO `t` () VALUES ();',
    );
    expect(buildInsertSql('postgres', undefined, 't', usersColumns, {})).toBe(
      'INSERT INTO "t" DEFAULT VALUES;',
    );
  });

  it('NULL 显式写入时不当作「未填」', () => {
    const sql = buildInsertSql('sqlite', undefined, 'users', usersColumns, {
      id: 1,
      username: 'dave',
      age: null,
    });
    expect(sql).toContain('"age") VALUES (1, \'dave\', NULL)');
  });
});

describe('buildUpdateSql', () => {
  it('SET 用新值、WHERE 用原始主键值，主键列不参与 SET', () => {
    const sql = buildUpdateSql(
      'sqlite',
      'main',
      'users',
      { username: 'alice2', age: 31 },
      usersColumns,
      usersRow,
    );
    expect(sql).toBe('UPDATE "main"."users" SET "username" = \'alice2\', "age" = 31 WHERE "id" = 7;');
  });

  it('只有主键改动时返回 null（主键列不可改，等于没有可提交的内容）', () => {
    const sql = buildUpdateSql('sqlite', undefined, 'users', { id: 8 }, usersColumns, usersRow);
    expect(sql).toBeNull();
  });

  it('无主键表无法构造 WHERE，返回 null', () => {
    const noPk = [col('username', 'TEXT'), col('age', 'INT')];
    const sql = buildUpdateSql('sqlite', undefined, 't', { age: 1 }, noPk, { age: 0 });
    expect(sql).toBeNull();
  });

  it('数值列上的数字字符串按裸数字写（输入框给的永远是字符串）', () => {
    const sql = buildUpdateSql('sqlite', undefined, 'users', { age: '31' }, usersColumns, usersRow);
    expect(sql).toContain('"age" = 31');
  });
});

describe('buildDeleteSql', () => {
  it('WHERE 只用主键', () => {
    expect(buildDeleteSql('postgres', 'public', 'users', usersColumns, usersRow)).toBe(
      'DELETE FROM "public"."users" WHERE "id" = 7;',
    );
  });

  it('无主键表返回 null', () => {
    expect(buildDeleteSql('sqlite', undefined, 't', [col('a', 'TEXT')], { a: 'x' })).toBeNull();
  });
});

describe('暂存改动的推进', () => {
  it('stageCellEdit：改回原值就摘掉这条改动', () => {
    let changes = emptyStagedChanges();
    changes = stageCellEdit(changes, 'pk:7', 'age', 31, 30);
    expect(changes.updates).toHaveLength(1);
    changes = stageCellEdit(changes, 'pk:7', 'age', 30, 30);
    expect(changes.updates).toHaveLength(0);
  });

  it('stageCellEdit：null 与 undefined 视为同一回事', () => {
    let changes = emptyStagedChanges();
    changes = stageCellEdit(changes, 'pk:7', 'age', null, undefined);
    expect(changes.updates).toHaveLength(0);
  });

  it('stageCellEdit：同一行多次改动合并到一条 update', () => {
    let changes = emptyStagedChanges();
    changes = stageCellEdit(changes, 'pk:7', 'age', 31, 30);
    changes = stageCellEdit(changes, 'pk:7', 'username', 'alice2', 'alice');
    expect(changes.updates).toHaveLength(1);
    expect(changes.updates[0].cells).toEqual({ age: 31, username: 'alice2' });
  });

  it('stageDeleteRow：删行时顺带摘掉它的单元格改动', () => {
    let changes = emptyStagedChanges();
    changes = stageCellEdit(changes, 'pk:7', 'age', 31, 30);
    changes = stageDeleteRow(changes, 'pk:7');
    expect(changes.updates).toHaveLength(0);
    expect(changes.deletes).toEqual(['pk:7']);
  });

  it('stageDeleteRow 对同一行幂等；unstageDeleteRow 能撤销标记', () => {
    let changes = emptyStagedChanges();
    changes = stageDeleteRow(changes, 'pk:7');
    changes = stageDeleteRow(changes, 'pk:7');
    expect(changes.deletes).toHaveLength(1);
    changes = unstageDeleteRow(changes, 'pk:7');
    expect(changes.deletes).toHaveLength(0);
  });

  it('countStagedChanges 数的是「改动项数」而不是语句数', () => {
    let changes = stageInsertRow(emptyStagedChanges(), 't1');
    changes = stageCellEdit(changes, 'pk:7', 'age', 31, 30);
    changes = stageDeleteRow(changes, 'pk:8');
    expect(countStagedChanges(changes)).toBe(3);
  });
});

describe('validateStagedInserts · 提交前的必填校验', () => {
  it('非空且无默认值的列未填 → 报出缺项', () => {
    const problems = validateStagedInserts(usersColumns, [{ tempId: 't1', cells: { age: 20 } }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('username');
  });

  it('自增主键未填不算缺项', () => {
    const autoPk = [col('id', 'INTEGER', { pk: true, notnull: true }), col('name', 'TEXT', { notnull: true })];
    expect(validateStagedInserts(autoPk, [{ tempId: 't1', cells: { name: 'x' } }])).toHaveLength(0);
  });

  it('有默认值的非空列未填不算缺项', () => {
    const withDefault = [col('status', 'TEXT', { notnull: true, dflt_value: 'active' })];
    expect(validateStagedInserts(withDefault, [{ tempId: 't1', cells: {} }])).toHaveLength(0);
  });

  it('全部填齐时通过', () => {
    expect(
      validateStagedInserts(usersColumns, [{ tempId: 't1', cells: { id: 1, username: 'x' } }]),
    ).toHaveLength(0);
  });
});

describe('buildCommitStatements · 批次汇总', () => {
  const originalRows = { 'pk:7': usersRow };

  it('语句顺序为 DELETE → UPDATE → INSERT（先删旧行才不会撞唯一键）', () => {
    let changes = stageInsertRow(emptyStagedChanges(), 't1');
    changes = stageCellEdit(changes, 'pk:7', 'username', 'alice2', 'alice');
    changes = stageDeleteRow(changes, 'pk:8');
    const original = { ...originalRows, 'pk:8': { id: 8, username: 'zombie', age: 1 } };

    const res = buildCommitStatements(changes, 'sqlite', 'main', 'users', usersColumns, original);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.statements).toHaveLength(3);
    expect(res.statements[0]).toContain('DELETE FROM');
    expect(res.statements[1]).toContain('UPDATE');
    expect(res.statements[2]).toContain('INSERT INTO');
  });

  it('无主键表有改 / 删时直接拒绝，并给出可操作的中文说明', () => {
    const noPk = [col('username', 'TEXT'), col('age', 'INT')];
    const changes = { ...emptyStagedChanges(), deletes: ['__idx_0'] };
    const res = buildCommitStatements(changes, 'sqlite', undefined, 't', noPk, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('没有主键');
  });

  it('无主键表仅新增行时允许提交', () => {
    const noPk = [col('username', 'TEXT'), col('age', 'INT')];
    const changes = stageInsertRow(emptyStagedChanges(), 't1');
    const res = buildCommitStatements(changes, 'sqlite', undefined, 't', noPk, {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.statements).toHaveLength(1);
    expect(res.statements[0]).toContain('INSERT INTO');
  });

  it('找不到原始行时拒绝提交（提示刷新后重试），不生成半截语句', () => {
    const changes = { ...emptyStagedChanges(), deletes: ['pk:999'] };
    const res = buildCommitStatements(changes, 'sqlite', undefined, 'users', usersColumns, originalRows);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('刷新');
  });

  it('没有任何改动时拒绝提交', () => {
    const res = buildCommitStatements(
      emptyStagedChanges(),
      'sqlite',
      undefined,
      'users',
      usersColumns,
      originalRows,
    );
    expect(res.ok).toBe(false);
  });
});

describe('normalizeColumnDefault / defaultDisplayHint · 默认值判定', () => {
  it('null / undefined / 空串都视为「没有默认值」', () => {
    expect(normalizeColumnDefault(col('a', 'INT'))).toBeNull();
    expect(normalizeColumnDefault(col('a', 'INT', { dflt_value: '' }))).toBeNull();
    expect(normalizeColumnDefault(col('a', 'INT', { dflt_value: '   ' }))).toBeNull();
    expect(normalizeColumnDefault(undefined)).toBeNull();
  });

  it('0 与空串默认值是两回事：0 有默认值，空串没有', () => {
    expect(normalizeColumnDefault(col('a', 'INT', { dflt_value: 0 }))).toBe('0');
    expect(normalizeColumnDefault(col('a', 'INT', { dflt_value: '0' }))).toBe('0');
    expect(normalizeColumnDefault(col('a', 'INT', { dflt_value: "''" }))).toBe("''");
  });

  it('MySQL 剥掉 DEFAULT_GENERATED 后缀（那是元数据标记，不是默认值的一部分）', () => {
    expect(
      normalizeColumnDefault(col('ts', 'timestamp', { dflt_value: 'CURRENT_TIMESTAMP DEFAULT_GENERATED' }), 'mysql'),
    ).toBe('CURRENT_TIMESTAMP');
    expect(
      normalizeColumnDefault(col('a', 'int', { dflt_value: '1 DEFAULT_GENERATED' }), 'mysql'),
    ).toBe('1');
  });

  it('没有 DEFAULT_GENERATED 后缀时原样保留，并去掉前后空白', () => {
    expect(normalizeColumnDefault(col('a', 'int', { dflt_value: '  7  ' }))).toBe('7');
  });

  it('defaultDisplayHint 直接把默认值原文作为提示；没有默认值时为 null', () => {
    expect(defaultDisplayHint(col('a', 'int', { dflt_value: 18 }))).toBe('18');
    expect(defaultDisplayHint(col('ts', 'timestamp', { dflt_value: 'CURRENT_TIMESTAMP' }))).toBe(
      'CURRENT_TIMESTAMP',
    );
    expect(defaultDisplayHint(col('a', 'int'))).toBeNull();
  });
});

describe('新增行的默认值只提示、不写进 INSERT（关键回归）', () => {
  const cols: DatabaseColumnMeta[] = [
    col('id', 'INTEGER', { cid: 0, pk: true, notnull: true, extra: 'auto_increment' }),
    col('username', 'VARCHAR(50)', { cid: 1, notnull: true }),
    // 有默认值的列：用户不填时数据库该用它，而不是被写死成字符串
    col('role', 'VARCHAR(20)', { cid: 2, dflt_value: 'guest' }),
    col('created_at', 'timestamp', { cid: 3, dflt_value: 'CURRENT_TIMESTAMP' }),
  ];

  it('用户没填的带默认值列不出现在列清单里（交给数据库算真实默认值）', () => {
    // 界面上 role / created_at 显示着灰色的「默认 …」提示，但暂存里**没有**这两个 key
    const changes = stageInsertRow(emptyStagedChanges(), 't1');
    const ins = changes.inserts[0];
    expect(defaultDisplayHint(cols[2])).toBe('guest');
    expect(defaultDisplayHint(cols[3])).toBe('CURRENT_TIMESTAMP');
    expect(ins.cells.role).toBeUndefined();
    expect(ins.cells.created_at).toBeUndefined();

    const withName = stageInsertCellEdit(changes, 't1', 'username', 'alice');
    const sql = buildInsertSql('postgres', undefined, 'users', cols, withName.inserts[0].cells);
    expect(sql).toBe('INSERT INTO "users" ("username") VALUES (\'alice\');');
    expect(sql).not.toContain('role');
    expect(sql).not.toContain('guest');
    expect(sql).not.toContain('CURRENT_TIMESTAMP');
  });

  it('用户手动改过该格后，提示变成显式值进入列清单', () => {
    let changes = stageInsertRow(emptyStagedChanges(), 't1');
    changes = stageInsertCellEdit(changes, 't1', 'username', 'bob');
    changes = stageInsertCellEdit(changes, 't1', 'role', 'admin');
    const sql = buildInsertSql('postgres', undefined, 'users', cols, changes.inserts[0].cells);
    expect(sql).toContain('"role"');
    expect(sql).toContain("'admin'");
    // 没动过的 created_at 仍不在列清单里
    expect(sql).not.toContain('created_at');
  });

  it('一行全用默认值时走空列清单 / DEFAULT VALUES', () => {
    const changes = stageInsertRow(emptyStagedChanges(), 't1');
    expect(buildInsertSql('mysql', undefined, 'users', cols, changes.inserts[0].cells)).toBe(
      'INSERT INTO `users` () VALUES ();',
    );
    expect(buildInsertSql('postgres', undefined, 'users', cols, changes.inserts[0].cells)).toBe(
      'INSERT INTO "users" DEFAULT VALUES;',
    );
  });
});
