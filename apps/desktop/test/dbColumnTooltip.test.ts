import { describe, expect, it } from 'vitest';
import type { DatabaseColumnMeta } from '@deepseek-ide/shared';
import {
  buildColumnTooltip,
  formatColumnType,
} from '../src/renderer/src/services/dbColumnTooltip';

function col(name: string, type: string, extra: Partial<DatabaseColumnMeta> = {}): DatabaseColumnMeta {
  return { cid: 0, name, type, notnull: false, dflt_value: null, pk: false, ...extra };
}

describe('formatColumnType · 完整类型声明', () => {
  it('类型原样保留，约束按 NOT NULL → PRIMARY KEY → AUTO_INCREMENT → DEFAULT 追加', () => {
    const meta = col('location_id', 'int', {
      notnull: true,
      pk: true,
      extra: 'auto_increment',
      dflt_value: null,
    });
    expect(formatColumnType(meta)).toBe('int NOT NULL PRIMARY KEY AUTO_INCREMENT');
  });

  it('decimal(9,6) NOT NULL 这种带精度的类型原样带出（不在渲染层重建类型串）', () => {
    const meta = col('longitude', 'decimal(9,6)', { notnull: true, comment: '经度' });
    expect(formatColumnType(meta)).toBe('decimal(9,6) NOT NULL');
  });

  it('有默认值时追加 DEFAULT', () => {
    expect(formatColumnType(col('age', 'INT', { dflt_value: 18 }))).toBe('INT DEFAULT 18');
  });

  it('默认值为空串时不追加（MySQL 用空串表示「没有默认值」）', () => {
    expect(formatColumnType(col('age', 'INT', { dflt_value: '' }))).toBe('INT');
  });

  it('SQLite 的自由类型原样展示', () => {
    expect(formatColumnType(col('payload', 'VARCHAR(255)', { notnull: true }))).toBe(
      'VARCHAR(255) NOT NULL',
    );
  });

  it('meta 缺失时返回空串（卡片由调用方决定不渲染类型行）', () => {
    expect(formatColumnType(undefined)).toBe('');
  });

  it('非自增的 extra 不会误判成 AUTO_INCREMENT', () => {
    expect(
      formatColumnType(col('updated_at', 'timestamp', { extra: 'on update CURRENT_TIMESTAMP' })),
    ).toBe('timestamp');
  });
});

describe('buildColumnTooltip · 卡片内容取舍', () => {
  const meta = col('longitude', 'decimal(9,6)', { notnull: true });

  it('有注释时给出表全名与注释', () => {
    const card = buildColumnTooltip({
      meta,
      table: 'cvm_location',
      schema: 'cvm',
      driver: 'mysql',
      comment: '经度（火星坐标系）',
    });
    expect(card).not.toBeNull();
    expect(card!.title).toBe('longitude');
    expect(card!.typeLine).toBe('decimal(9,6) NOT NULL');
    expect(card!.tableLine).toBe('`cvm`.`cvm_location`');
    expect(card!.description).toBe('经度（火星坐标系）');
  });

  it('注释为空串 / 全空白 / null 时 description 为 null（不渲染空行）', () => {
    for (const comment of [null, undefined, '', '   ']) {
      const card = buildColumnTooltip({ meta, table: 't', driver: 'sqlite', comment });
      expect(card!.description).toBeNull();
    }
  });

  it('SQLite 没有列注释概念，卡片照常给出类型与表名', () => {
    const card = buildColumnTooltip({
      meta,
      table: 'users',
      driver: 'sqlite',
      comment: null,
    });
    expect(card!.typeLine).toBe('decimal(9,6) NOT NULL');
    expect(card!.tableLine).toBe('"users"');
    expect(card!.description).toBeNull();
  });

  it('meta 缺失时返回 null，调用方据此不弹卡片', () => {
    expect(
      buildColumnTooltip({ meta: undefined, table: 't', driver: 'sqlite', comment: 'x' }),
    ).toBeNull();
  });

  it('注释前后的空白会被剥掉', () => {
    const card = buildColumnTooltip({
      meta,
      table: 't',
      driver: 'sqlite',
      comment: '  经度  ',
    });
    expect(card!.description).toBe('经度');
  });
});
