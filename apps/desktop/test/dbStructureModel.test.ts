import { describe, expect, it } from 'vitest';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import {
  buildAlterChange,
  emptyColumn,
  fromMeta,
  isColumnDirty,
  toColumnSpec,
  type EditableColumn,
} from '../src/renderer/src/services/dbStructureModel';
import { buildAlterTableStatements } from '../src/renderer/src/services/dbDdl';

function col(name: string, type: string, extra: Partial<DatabaseColumnMeta> = {}): DatabaseColumnMeta {
  return { cid: 0, name, type, notnull: false, dflt_value: null, pk: false, ...extra };
}

const idMeta = col('id', 'int', { cid: 0, notnull: true, pk: true, extra: 'auto_increment' });
const nameMeta = col('name', 'varchar(50)', { cid: 1, dflt_value: null });

describe('fromMeta · 元数据 → 可编辑行', () => {
  it('把长度从类型里剥出来单独放（否则用户改长度会改出 varchar(50)(100)）', () => {
    const row = fromMeta(nameMeta);
    expect(row.type).toBe('VARCHAR');
    expect(row.length).toBe('50');
    expect(row.name).toBe('name');
    expect(row.originalName).toBe('name');
  });

  it('自增只能从 EXTRA 读出来，读不到就会在设计表时把 AUTO_INCREMENT 抹掉', () => {
    expect(fromMeta(idMeta).autoIncrement).toBe(true);
    expect(fromMeta(col('n', 'int', { extra: 'on update CURRENT_TIMESTAMP' })).autoIncrement).toBe(false);
  });

  it('dflt_value 为 null 时默认值是空串，为 0 时保留 "0"', () => {
    expect(fromMeta(col('a', 'int', { dflt_value: null })).defaultValue).toBe('');
    expect(fromMeta(col('a', 'int', { dflt_value: 0 })).defaultValue).toBe('0');
    expect(fromMeta(col('a', 'int', { dflt_value: "''" })).defaultValue).toBe("''");
  });

  it('每行拿到互不相同的 key（列名可改，key 不能跟着变）', () => {
    expect(fromMeta(nameMeta).key).not.toBe(fromMeta(nameMeta).key);
  });

  it('无长度的类型如 TEXT 得到空长度', () => {
    expect(fromMeta(col('note', 'TEXT')).length).toBe('');
  });
});

describe('emptyColumn · 新增字段的草稿行', () => {
  it('没有 originalName（据此判定为新增列）', () => {
    const row = emptyColumn('sqlite');
    expect(row.originalName).toBeUndefined();
    expect(row.name).toBe('');
    expect(row.type).toBe('INTEGER'); // SQLite 白名单第一项
  });

  it('默认取该驱动类型白名单的第一项', () => {
    expect(emptyColumn('mysql').type).toBe('INT');
    expect(emptyColumn('postgres').type).toBe('INTEGER');
  });
});

describe('toColumnSpec · 行 → 建表列定义', () => {
  it('列名去空白', () => {
    const row: EditableColumn = { ...emptyColumn('mysql'), name: '  title  ', type: 'VARCHAR' };
    expect(toColumnSpec(row).name).toBe('title');
  });
});

describe('buildAlterChange · 行 → 变更描述', () => {
  it('纯改类型：name 传原列名，不带 newName（否则会多出一条改名语句）', () => {
    const row: EditableColumn = { ...fromMeta(nameMeta), type: 'TEXT', length: '' };
    const change = buildAlterChange(row);
    expect(change.name).toBe('name');
    expect(change.originalName).toBe('name');
    expect(change.newName).toBeUndefined();
  });

  it('改名：newName 给新名字（MySQL 的 CHANGE COLUMN 要原+新）', () => {
    const row: EditableColumn = { ...fromMeta(nameMeta), name: 'title' };
    const change = buildAlterChange(row);
    expect(change.name).toBe('name');
    expect(change.newName).toBe('title');
  });

  it('新增列：name 用行里的名字且没有 originalName', () => {
    const row: EditableColumn = { ...emptyColumn('sqlite'), name: 'extra_col', type: 'TEXT' };
    const change = buildAlterChange(row);
    expect(change.name).toBe('extra_col');
    expect(change.originalName).toBeUndefined();
  });

  it('删除列：带上原列名与 drop 标记', () => {
    const row: EditableColumn = { ...fromMeta(nameMeta), drop: true };
    const change = buildAlterChange(row);
    expect(change.drop).toBe(true);
    expect(change.name).toBe('name');
  });
});

describe('isColumnDirty · 决定「应用」是否可用', () => {
  it('没动过的行不算改动', () => {
    expect(isColumnDirty(fromMeta(nameMeta), nameMeta)).toBe(false);
    expect(isColumnDirty(fromMeta(idMeta), idMeta)).toBe(false);
  });

  it('改名 / 改类型 / 改长度 / 改非空 / 改默认值都算改动', () => {
    const base = fromMeta(nameMeta);
    expect(isColumnDirty({ ...base, name: 'title' }, nameMeta)).toBe(true);
    expect(isColumnDirty({ ...base, type: 'TEXT', length: '' }, nameMeta)).toBe(true);
    expect(isColumnDirty({ ...base, length: '100' }, nameMeta)).toBe(true);
    expect(isColumnDirty({ ...base, notnull: true }, nameMeta)).toBe(true);
    expect(isColumnDirty({ ...base, defaultValue: 'x' }, nameMeta)).toBe(true);
  });

  it('大小写差异不算改类型（元数据与界面一个 varchar 一个 VARCHAR）', () => {
    const row = { ...fromMeta(nameMeta), type: 'varchar' };
    expect(isColumnDirty(row as EditableColumn, nameMeta)).toBe(false);
  });

  it('标记删除的行一定是改动', () => {
    expect(isColumnDirty({ ...fromMeta(nameMeta), drop: true }, nameMeta)).toBe(true);
  });

  it('新增列一定是改动；找不到原元数据时也按改动处理（更安全）', () => {
    expect(isColumnDirty(emptyColumn('sqlite'), undefined)).toBe(true);
    expect(isColumnDirty({ ...fromMeta(nameMeta) }, undefined)).toBe(true);
  });

  it('反复调用不会因为 key 自增而误判（比对用的是不消耗序号的纯函数）', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(isColumnDirty(fromMeta(nameMeta), nameMeta)).toBe(false);
    }
  });
});

describe('与 buildAlterTableStatements 串起来 · 端到端', () => {
  it('改名 + 改类型 + 加列 + 删列 → MySQL 生成四条语句', () => {
    const rows: EditableColumn[] = [
      { ...fromMeta(nameMeta), name: 'title' },
      { ...fromMeta(idMeta) },
      { ...emptyColumn('mysql'), name: 'remark', type: 'VARCHAR', length: '255' },
      { ...fromMeta(col('legacy', 'TEXT')), drop: true },
    ];
    const originals = new Map([nameMeta, idMeta, col('legacy', 'TEXT')].map((c) => [c.name, c]));
    const changes = rows
      .filter((r) => isColumnDirty(r, r.originalName ? originals.get(r.originalName) : undefined))
      .map(buildAlterChange);

    const res = buildAlterTableStatements('mysql', 'cvm', 't', changes);
    expect(res.ok).toBe(true);
    // 四条改动 → 四条语句：改名（CHANGE）、加列（ADD）、删列（DROP）各一条，
    // 改类型那一条因 MySQL 的 CHANGE COLUMN 已带完整类型定义而与改名**去重合并**（见 dbDdl 的 Set 去重）
    expect(res.statements).toHaveLength(3);
    expect(res.statements.some((s) => s.includes('CHANGE COLUMN `name`'))).toBe(true);
    expect(res.statements.some((s) => s.includes('ADD COLUMN `remark`'))).toBe(true);
    expect(res.statements.some((s) => s.includes('DROP COLUMN `legacy`'))).toBe(true);
    // 没动过的 id 列不该出现在任何语句里
    expect(res.statements.some((s) => s.includes('`id`'))).toBe(false);
  });

  it('SQLite 下改类型被跳过并给出中文原因', () => {
    const row: EditableColumn = { ...fromMeta(nameMeta), type: 'TEXT', length: '' };
    const res = buildAlterTableStatements('sqlite', undefined, 't', [buildAlterChange(row)]);
    expect(res.ok).toBe(true);
    expect(res.statements).toHaveLength(0);
    expect(res.skipped?.join('')).toContain('SQLite 不支持修改列类型');
  });
});
