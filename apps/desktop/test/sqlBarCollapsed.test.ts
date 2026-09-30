import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_SQL_BAR_EXPANDED,
  loadSqlBarExpanded,
  saveSqlBarExpanded,
} from '../src/renderer/src/services/sqlBarCollapsed';

describe('「当前查询」SQL 栏的折叠偏好', () => {
  beforeEach(() => {
    let store: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        store = {};
      },
    };
  });

  it('默认是收起的（数据优先，语句按需展开）', () => {
    expect(DEFAULT_SQL_BAR_EXPANDED).toBe(false);
    expect(loadSqlBarExpanded()).toBe(false);
  });

  it('展开一次后被记住，下次读回来仍是展开', () => {
    saveSqlBarExpanded(true);
    expect(loadSqlBarExpanded()).toBe(true);
  });

  it('收起一次后同样被记住（不会因为「只记展开」而永远弹开）', () => {
    saveSqlBarExpanded(true);
    saveSqlBarExpanded(false);
    expect(loadSqlBarExpanded()).toBe(false);
  });

  it('无关的残留值退回默认，而不是被当成真值', () => {
    (globalThis.localStorage as any).setItem('echoly:db_sql_bar_expanded', 'true');
    expect(loadSqlBarExpanded()).toBe(false);
  });

  it('localStorage 抛错时读回默认、写入不抛出（隐私模式不该让视图打不开）', () => {
    (globalThis as any).localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadSqlBarExpanded()).toBe(false);
    expect(() => saveSqlBarExpanded(true)).not.toThrow();
  });
});
