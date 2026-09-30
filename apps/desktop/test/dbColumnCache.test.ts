import { describe, expect, it } from 'vitest';
import { columnCacheKey, isColumnCacheHit } from '../src/renderer/src/services/dbColumnCache';

describe('columnCacheKey · 表身份键', () => {
  it('三段拼接，能区分连接 / 库 / 表任一维度的变化', () => {
    const base = columnCacheKey('db_mysql_1', 'shop', 'users');
    expect(columnCacheKey('db_mysql_1', 'shop', 'orders')).not.toBe(base);
    expect(columnCacheKey('db_mysql_1', 'crm', 'users')).not.toBe(base);
    expect(columnCacheKey('db_mysql_2', 'shop', 'users')).not.toBe(base);
    expect(columnCacheKey('db_mysql_1', 'shop', 'users')).toBe(base);
  });

  it('schema 为 undefined / 空串视为同一件事（树上传下来的都是空串）', () => {
    expect(columnCacheKey('c', undefined, 't')).toBe(columnCacheKey('c', '', 't'));
  });

  it('名字里带分隔符不会造成碰撞：`a/b` + `c` 与 `a` + `b/c` 必须不同', () => {
    // 用 `/` 之类的裸分隔符拼就会被这两条撞成同一个键，进而把 A 表的列用到 B 表上
    expect(columnCacheKey('c', 'a/b', 'c')).not.toBe(columnCacheKey('c', 'a', 'b/c'));
    // 带长度前缀后，连分隔符字符本身出现在名字里也是可逆的
    expect(columnCacheKey('c', 'a|b', 'c')).not.toBe(columnCacheKey('c', 'a', 'b|c'));
  });
});

describe('isColumnCacheHit · 缓存命中判定', () => {
  it('键相同且缓存里有列才算命中', () => {
    const key = columnCacheKey('c', 'main', 't');
    expect(isColumnCacheHit(key, key, 3)).toBe(true);
  });

  it('键不同一律不命中（切表的回归点：旧代码只看「columns 非空」）', () => {
    const cached = columnCacheKey('c', 'main', 'users');
    const current = columnCacheKey('c', 'main', 'cvm_location_server');
    // 缓存里明明有 63 列，但那是上一张表的 —— 必须重新取
    expect(isColumnCacheHit(cached, current, 63)).toBe(false);
  });

  it('空缓存不算命中：上次查不到（表不存在 / 权限不足）不该一直短路', () => {
    const key = columnCacheKey('c', 'main', 't');
    expect(isColumnCacheHit(key, key, 0)).toBe(false);
  });

  it('从未取过（键为空串）不命中', () => {
    expect(isColumnCacheHit('', columnCacheKey('c', undefined, 't'), 5)).toBe(false);
  });
});
