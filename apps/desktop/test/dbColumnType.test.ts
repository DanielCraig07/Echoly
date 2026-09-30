import { describe, expect, it } from 'vitest';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import {
  COLUMN_CATEGORY_BADGES,
  columnCategory,
  columnCategoryBadge,
  isDateTimeColumnType,
} from '../src/renderer/src/services/dbColumnType';
import {
  COMMON_FILTER_OPERATORS,
  FILTER_OPERATOR_ICONS,
  FILTER_OPERATOR_LABELS,
  MORE_FILTER_OPERATORS,
  operatorNeedsValue,
  type DbTableFilterOperator,
} from '../src/renderer/src/services/dbTableQuery';
import { defaultPortFor, resolvePort } from '../src/renderer/src/services/dbConnectionForm';

function col(name: string, type: string, extra: Partial<DatabaseColumnMeta> = {}): DatabaseColumnMeta {
  return { cid: 0, name, type, notnull: false, dflt_value: null, pk: false, ...extra };
}

describe('columnCategory 字段大类', () => {
  it('整数与浮点都归到数值', () => {
    expect(columnCategory(col('id', 'INT'), 'mysql')).toBe('number');
    expect(columnCategory(col('qty', 'BIGINT(20) UNSIGNED'), 'mysql')).toBe('number');
    expect(columnCategory(col('price', 'DECIMAL(10,2)'), 'mysql')).toBe('number');
    expect(columnCategory(col('ratio', 'double precision'), 'postgres')).toBe('number');
  });

  it('日期时间类归到 datetime', () => {
    expect(columnCategory(col('created_at', 'DATETIME'), 'mysql')).toBe('datetime');
    expect(columnCategory(col('created_at', 'TIMESTAMP WITH TIME ZONE'), 'postgres')).toBe('datetime');
    expect(columnCategory(col('d', 'DATE'), 'mysql')).toBe('datetime');
  });

  it('其余（含未知类型、空类型）一律落到 text', () => {
    expect(columnCategory(col('name', 'VARCHAR(50)'), 'mysql')).toBe('text');
    expect(columnCategory(col('note', 'TEXT'), 'sqlite')).toBe('text');
    expect(columnCategory(col('blob', 'BLOB'), 'sqlite')).toBe('text');
    expect(columnCategory(col('weird', 'GEOMETRY'), 'mysql')).toBe('text');
  });

  it('meta 为空或类型为空时不抛错，按文本处理', () => {
    expect(columnCategory(undefined, 'mysql')).toBe('text');
    expect(columnCategory(col('x', ''), 'mysql')).toBe('text');
  });

  it('数值优先：数值判定先于日期判定，保证角标与 DML 口径一致', () => {
    // 三个大类互斥，调用方不必处理「既是数值又是日期」
    const meta = col('n', 'INT');
    expect(columnCategory(meta, 'sqlite')).toBe('number');
  });
});

describe('isDateTimeColumnType 整词比对', () => {
  it('剥掉长度/精度后仍能命中整词', () => {
    expect(isDateTimeColumnType('DATETIME(6)', 'mysql')).toBe(true);
    expect(isDateTimeColumnType('timestamp(3)', 'postgres')).toBe(true);
  });

  it('大小写不敏感', () => {
    expect(isDateTimeColumnType('datetime', 'mysql')).toBe(true);
    expect(isDateTimeColumnType('TimeStamp', 'mysql')).toBe(true);
  });

  it('不做子串匹配：CANDIDATE 这类含 DATE 的自定义类型不该误判', () => {
    // DATE 是子串大户，`includes` 会把 CANDIDATE / CUSTOMDATE 全吃进来
    expect(isDateTimeColumnType('CANDIDATE', 'mysql')).toBe(false);
    expect(isDateTimeColumnType('CUSTOMDATE', 'mysql')).toBe(false);
    expect(isDateTimeColumnType('VARCHAR(20)')).toBe(false);
  });

  it('SQLite 的类型是自由文本，退化为片段比对', () => {
    expect(isDateTimeColumnType('DATETIME', 'sqlite')).toBe(true);
    expect(isDateTimeColumnType('TIMESTAMP', 'sqlite')).toBe(true);
    // 同样一串在 SQLite 下按片段命中、在 MySQL 下按整词落空——差异本身就是设计意图
    expect(isDateTimeColumnType('CUSTOMDATE', 'sqlite')).toBe(true);
    expect(isDateTimeColumnType('CUSTOMDATE', 'mysql')).toBe(false);
  });

  it('空类型返回 false 而不是抛错', () => {
    expect(isDateTimeColumnType(undefined)).toBe(false);
    expect(isDateTimeColumnType('')).toBe(false);
    expect(isDateTimeColumnType('(11)')).toBe(false);
  });
});

describe('columnCategoryBadge 表头角标', () => {
  it('数值 123 / 日期 🕐 / 文本 A-Z', () => {
    expect(columnCategoryBadge(col('id', 'INT'), 'mysql')).toBe('123');
    expect(columnCategoryBadge(col('created_at', 'DATETIME'), 'mysql')).toBe('🕐');
    expect(columnCategoryBadge(col('name', 'VARCHAR(50)'), 'mysql')).toBe('A-Z');
  });

  it('角标表与三个大类一一对应，没有漏项', () => {
    expect(Object.keys(COLUMN_CATEGORY_BADGES).sort()).toEqual(['datetime', 'number', 'text']);
    expect(COLUMN_CATEGORY_BADGES.number).toBe('123');
    expect(COLUMN_CATEGORY_BADGES.datetime).toBe('🕐');
    expect(COLUMN_CATEGORY_BADGES.text).toBe('A-Z');
  });
});

describe('FILTER_OPERATOR_ICONS 运算符图标', () => {
  const OPERATORS = Object.keys(FILTER_OPERATOR_LABELS) as DbTableFilterOperator[];

  it('每个运算符都有图标，没有漏项', () => {
    for (const op of OPERATORS) {
      expect(FILTER_OPERATOR_ICONS[op], `运算符 ${op} 缺图标`).toBeTruthy();
    }
  });

  it('图标两两不同——曾经用 operatorNeedsValue 当图标，12 个运算符只剩 2 个符号', () => {
    const icons = OPERATORS.map((op) => FILTER_OPERATOR_ICONS[op]);
    expect(new Set(icons).size).toBe(OPERATORS.length);
  });

  it('「包含」与「等于」不再共用同一个 icon', () => {
    expect(FILTER_OPERATOR_ICONS.contains).not.toBe(FILTER_OPERATOR_ICONS.eq);
  });

  it('「为空」/「非空」只差一道斜杠，不会渲染成一模一样', () => {
    expect(FILTER_OPERATOR_ICONS.isNull).not.toBe(FILTER_OPERATOR_ICONS.isNotNull);
    expect(FILTER_OPERATOR_ICONS.isNull).toBe('∅');
    expect(FILTER_OPERATOR_ICONS.isNotNull).toBe('∅̸');
  });

  it('「以…开头」与「以…结尾」方向相反', () => {
    expect(FILTER_OPERATOR_ICONS.startsWith).toBe('a…');
    expect(FILTER_OPERATOR_ICONS.endsWith).toBe('…z');
  });

  it('常用项与更多项不重不漏，合起来正好是全量', () => {
    const both = [...COMMON_FILTER_OPERATORS, ...MORE_FILTER_OPERATORS].sort();
    expect(both).toEqual([...OPERATORS].sort());
    expect(new Set(COMMON_FILTER_OPERATORS).size).toBe(COMMON_FILTER_OPERATORS.length);
  });

  it('operatorNeedsValue：只有 isNull / isNotNull 不需要填值', () => {
    const noValue = OPERATORS.filter((op) => !operatorNeedsValue(op));
    expect(noValue.sort()).toEqual(['isNotNull', 'isNull']);
  });
});

describe('defaultPortFor / resolvePort 端口默认值', () => {
  it('MySQL 与 PostgreSQL 预填各自默认端口（是值不是占位符）', () => {
    expect(defaultPortFor('mysql')).toBe('3306');
    expect(defaultPortFor('postgres')).toBe('5432');
  });

  it('SQLite 没有端口概念，返回空串', () => {
    expect(defaultPortFor('sqlite')).toBe('');
  });

  it('resolvePort 在留空时兜底到驱动默认端口', () => {
    expect(resolvePort('mysql', '')).toBe(3306);
    expect(resolvePort('postgres', '   ')).toBe(5432);
    expect(resolvePort('mysql', '13306')).toBe(13306);
  });
});
