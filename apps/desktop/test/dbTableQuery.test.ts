import { describe, expect, it } from 'vitest';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import {
  buildFilterClause,
  buildOrderByClause,
  buildTableQuerySql,
  buildWhereClause,
  describeFilter,
  describeSort,
  EMPTY_VIEW_STATE,
  escapeLikeValue,
  isEmptyViewState,
  likeEscapeClause,
  nextSortState,
  operatorNeedsValue,
  sortDirectionOf,
} from '../src/renderer/src/services/dbTableQuery';

function col(name: string, type: string, extra: Partial<DatabaseColumnMeta> = {}): DatabaseColumnMeta {
  return { cid: 0, name, type, notnull: false, dflt_value: null, pk: false, ...extra };
}

const columns: DatabaseColumnMeta[] = [
  col('id', 'INTEGER', { cid: 0, pk: true, notnull: true }),
  col('name', 'VARCHAR(50)', { cid: 1 }),
  col('age', 'INT', { cid: 2 }),
  col('note', 'TEXT', { cid: 3 }),
];

describe('escapeLikeValue / likeEscapeClause', () => {
  it('转义 LIKE 元字符，用户搜「100%」才不会被当成通配符', () => {
    expect(escapeLikeValue('100%')).toBe('100\\%');
    expect(escapeLikeValue('a_b')).toBe('a\\_b');
    expect(escapeLikeValue('c\\d')).toBe('c\\\\d');
  });

  it('ESCAPE 子句按驱动分流（MySQL 的字面量要写两个反斜杠）', () => {
    expect(likeEscapeClause('mysql')).toBe("ESCAPE '\\\\'");
    expect(likeEscapeClause('sqlite')).toBe("ESCAPE '\\'");
    expect(likeEscapeClause('postgres')).toBe("ESCAPE '\\'");
  });
});

describe('buildFilterClause · 单条件', () => {
  it('列名为空视为未完成的条件，返回 null', () => {
    expect(buildFilterClause('sqlite', columns, { column: '', operator: 'eq', value: 1 })).toBeNull();
  });

  it('等值：数值列裸写数字，文本列加引号', () => {
    expect(buildFilterClause('sqlite', columns, { column: 'age', operator: 'eq', value: 18 })).toBe(
      '"age" = 18',
    );
    expect(buildFilterClause('sqlite', columns, { column: 'name', operator: 'eq', value: 'alice' })).toBe(
      "\"name\" = 'alice'",
    );
  });

  it('等值到 NULL 会退化成 IS NULL（`= NULL` 永远不成立）', () => {
    expect(buildFilterClause('sqlite', columns, { column: 'age', operator: 'eq', value: null })).toBe(
      '"age" IS NULL',
    );
    expect(buildFilterClause('sqlite', columns, { column: 'age', operator: 'ne', value: null })).toBe(
      '"age" IS NOT NULL',
    );
  });

  it('不等用 <>，比较运算符按序映射', () => {
    expect(buildFilterClause('sqlite', columns, { column: 'age', operator: 'ne', value: 1 })).toContain('<> 1');
    expect(buildFilterClause('sqlite', columns, { column: 'age', operator: 'gt', value: 1 })).toContain('> 1');
    expect(buildFilterClause('sqlite', columns, { column: 'age', operator: 'gte', value: 1 })).toContain('>= 1');
    expect(buildFilterClause('sqlite', columns, { column: 'age', operator: 'lt', value: 1 })).toContain('< 1');
    expect(buildFilterClause('sqlite', columns, { column: 'age', operator: 'lte', value: 1 })).toContain('<= 1');
  });

  it('isNull / isNotNull 不取值，也不需要 value', () => {
    expect(buildFilterClause('sqlite', columns, { column: 'note', operator: 'isNull' })).toBe(
      '"note" IS NULL',
    );
    expect(buildFilterClause('sqlite', columns, { column: 'note', operator: 'isNotNull' })).toBe(
      '"note" IS NOT NULL',
    );
    expect(operatorNeedsValue('isNull')).toBe(false);
    expect(operatorNeedsValue('contains')).toBe(true);
  });

  it('LIKE 系列：三种模式串形态 + 元字符转义', () => {
    expect(buildFilterClause('sqlite', columns, { column: 'name', operator: 'contains', value: 'li' })).toBe(
      "\"name\" LIKE '%li%' ESCAPE '\\'",
    );
    expect(buildFilterClause('sqlite', columns, { column: 'name', operator: 'startsWith', value: 'li' })).toBe(
      "\"name\" LIKE 'li%' ESCAPE '\\'",
    );
    expect(buildFilterClause('sqlite', columns, { column: 'name', operator: 'endsWith', value: 'li' })).toBe(
      "\"name\" LIKE '%li' ESCAPE '\\'",
    );
    expect(buildFilterClause('sqlite', columns, { column: 'name', operator: 'notContains', value: 'li' })).toBe(
      "\"name\" NOT LIKE '%li%' ESCAPE '\\'",
    );
    expect(buildFilterClause('sqlite', columns, { column: 'name', operator: 'contains', value: '100%' })).toBe(
      "\"name\" LIKE '%100\\%%' ESCAPE '\\'",
    );
  });

  it('MySQL 的 LIKE 用驱动专属 ESCAPE 写法，且字符串按字面量转义', () => {
    expect(buildFilterClause('mysql', columns, { column: 'name', operator: 'contains', value: "O'B" })).toBe(
      "`name` LIKE '%O''B%' ESCAPE '\\\\'",
    );
  });

  it('value 为 undefined（还没填）时返回 null，不生成残缺条件', () => {
    expect(buildFilterClause('sqlite', columns, { column: 'name', operator: 'contains' })).toBeNull();
  });
});

describe('buildWhereClause / buildOrderByClause', () => {
  it('多条件用 AND 连接；全部无效时返回空串（调用方据此不加 WHERE）', () => {
    const where = buildWhereClause('sqlite', columns, [
      { column: 'age', operator: 'gt', value: 18 },
      { column: 'name', operator: 'contains', value: 'a' },
    ]);
    expect(where).toBe('WHERE "age" > 18 AND "name" LIKE \'%a%\' ESCAPE \'\\\'');
    expect(buildWhereClause('sqlite', columns, [])).toBe('');
    expect(buildWhereClause('sqlite', columns, [{ column: '', operator: 'eq', value: 1 }])).toBe('');
  });

  it('ORDER BY 按排序栈生成，末尾自动补主键升序做 tiebreak', () => {
    expect(buildOrderByClause('sqlite', [{ column: 'age', direction: 'desc' }], [columns[0]])).toBe(
      'ORDER BY "age" DESC, "id" ASC',
    );
  });

  it('排序列就是主键时不重复追加', () => {
    expect(buildOrderByClause('sqlite', [{ column: 'id', direction: 'desc' }], [columns[0]])).toBe(
      'ORDER BY "id" DESC',
    );
  });

  it('没有排序也没有主键时返回空串', () => {
    expect(buildOrderByClause('sqlite', [], [])).toBe('');
  });
});

describe('buildTableQuerySql', () => {
  it('不带筛选排序时仍补主键升序（翻页要靠稳定顺序），且**不带 LIMIT**（分页留给主进程）', () => {
    const sql = buildTableQuerySql('mysql', 'shop', 'users', columns, EMPTY_VIEW_STATE);
    expect(sql).toBe('SELECT * FROM `shop`.`users` ORDER BY `id` ASC;');
    expect(sql.toUpperCase()).not.toContain('LIMIT');
  });

  it('无 schema 时用不带前缀的限定名', () => {
    const noPk = [col('name', 'TEXT')];
    expect(buildTableQuerySql('sqlite', undefined, 'users', noPk, undefined)).toBe(
      'SELECT * FROM "users";',
    );
  });

  it('无主键且无排序时不产生 ORDER BY（没有可 tiebreak 的列）', () => {
    const noPk = [col('name', 'TEXT')];
    const sql = buildTableQuerySql('sqlite', undefined, 'users', noPk, EMPTY_VIEW_STATE);
    expect(sql).toBe('SELECT * FROM "users";');
    expect(sql.toUpperCase()).not.toContain('ORDER BY');
  });

  it('筛选条件全部无效时不会留下空 WHERE', () => {
    const noPk = [col('name', 'TEXT')];
    const sql = buildTableQuerySql('sqlite', undefined, 'users', noPk, {
      filters: [{ column: '', operator: 'eq', value: '' }],
      sorts: [],
    });
    expect(sql).toBe('SELECT * FROM "users";');
  });

  it('WHERE 与 ORDER BY 同时存在时顺序正确，且仍不含 LIMIT', () => {
    const sql = buildTableQuerySql('postgres', 'public', 'users', columns, {
      filters: [{ column: 'age', operator: 'gte', value: 18 }],
      sorts: [{ column: 'name', direction: 'asc' }],
    });
    expect(sql).toBe(
      'SELECT * FROM "public"."users" WHERE "age" >= 18 ORDER BY "name" ASC, "id" ASC;',
    );
    expect(sql.toUpperCase()).not.toContain('LIMIT');
  });

  it('筛选条件全部无效时不会留下空 WHERE（只保留 tiebreak 的 ORDER BY）', () => {
    const sql = buildTableQuerySql('sqlite', undefined, 'users', columns, {
      filters: [{ column: '', operator: 'eq', value: '' }],
      sorts: [],
    });
    expect(sql).toBe('SELECT * FROM "users" ORDER BY "id" ASC;');
    expect(sql).not.toContain('WHERE');
  });
});

describe('isEmptyViewState · 判断是否还是「未筛选」状态', () => {
  it('undefined / 空条件视为空状态；有排序列名才算非空', () => {
    expect(isEmptyViewState(undefined)).toBe(true);
    expect(isEmptyViewState(EMPTY_VIEW_STATE)).toBe(true);
    expect(isEmptyViewState({ filters: [{ column: '', operator: 'eq' }], sorts: [] })).toBe(true);
    expect(isEmptyViewState({ filters: [{ column: 'age', operator: 'eq', value: 1 }], sorts: [] })).toBe(
      false,
    );
    expect(isEmptyViewState({ filters: [], sorts: [{ column: 'age', direction: 'asc' }] })).toBe(false);
  });
});

describe('排序推进与描述文案', () => {
  it('点击列头循环：升序 → 降序 → 取消', () => {
    let sorts = nextSortState([], 'age', false);
    expect(sorts).toEqual([{ column: 'age', direction: 'asc' }]);
    sorts = nextSortState(sorts, 'age', false);
    expect(sorts).toEqual([{ column: 'age', direction: 'desc' }]);
    sorts = nextSortState(sorts, 'age', false);
    expect(sorts).toEqual([]);
  });

  it('不追加时切换列会清空原有排序栈', () => {
    const sorts = nextSortState([{ column: 'age', direction: 'asc' }], 'name', false);
    expect(sorts).toEqual([{ column: 'name', direction: 'asc' }]);
  });

  it('append（Cmd/Ctrl+点击）时保留其他列，作为次级排序追加在后面', () => {
    const sorts = nextSortState([{ column: 'age', direction: 'asc' }], 'name', true);
    expect(sorts).toEqual([
      { column: 'age', direction: 'asc' },
      { column: 'name', direction: 'asc' },
    ]);
  });

  it('append 下取消某列只摘掉它，其他列的排序不受影响', () => {
    const sorts = nextSortState(
      [
        { column: 'age', direction: 'desc' },
        { column: 'name', direction: 'asc' },
      ],
      'age',
      true,
    );
    expect(sorts).toEqual([{ column: 'name', direction: 'asc' }]);
  });

  it('sortDirectionOf / describeSort', () => {
    const sorts = [{ column: 'age', direction: 'desc' as const }];
    expect(sortDirectionOf(sorts, 'age')).toBe('desc');
    expect(sortDirectionOf(sorts, 'name')).toBeNull();
    expect(describeSort(sorts[0])).toBe('age 降序');
    expect(describeSort({ column: 'age', direction: 'asc' })).toBe('age 升序');
  });

  it('菜单里显式指定方向：不经过中间的「升序」阶段', () => {
    expect(nextSortState([], 'age', false, 'desc')).toEqual([{ column: 'age', direction: 'desc' }]);
  });

  it('菜单里再选一次同样的方向 = 取消排序（菜单项没有「无方向」这一项）', () => {
    const sorts = [{ column: 'age', direction: 'asc' as const }];
    expect(nextSortState(sorts, 'age', false, 'asc')).toEqual([]);
    // 换一个方向则是正常切换，不是取消
    expect(nextSortState(sorts, 'age', false, 'desc')).toEqual([{ column: 'age', direction: 'desc' }]);
  });

  it('显式方向下取消某列时，其他列的排序保留（多列排序靠菜单逐列取消）', () => {
    const sorts = [
      { column: 'age', direction: 'asc' as const },
      { column: 'name', direction: 'desc' as const },
    ];
    // append 为真（列头 Cmd/Ctrl+点击的语义）时，只摘掉 age，name 的排序不受影响
    expect(nextSortState(sorts, 'age', true, 'asc')).toEqual([{ column: 'name', direction: 'desc' }]);
  });
});

describe('describeFilter · chip 文案', () => {
  it('无值运算符只显示列名与运算符', () => {
    expect(describeFilter({ column: 'note', operator: 'isNull' })).toBe('note 为空');
  });

  it('数值列的数字不加引号，文本值加引号', () => {
    expect(describeFilter({ column: 'age', operator: 'gt', value: 18 }, 'INT')).toBe('age 大于 18');
    expect(describeFilter({ column: 'name', operator: 'contains', value: '张' }, 'VARCHAR(10)')).toBe(
      'name 包含 "张"',
    );
  });

  it('值为 NULL 时文案里明确写 NULL，不显示成空', () => {
    expect(describeFilter({ column: 'age', operator: 'eq', value: null })).toBe('age 等于 NULL');
  });
});
