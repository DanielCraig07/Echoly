import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY_ENTRIES,
  canGoBack,
  canGoForward,
  createHistory,
  currentEntry,
  goBack,
  goForward,
  pushEntry,
} from '../src/renderer/src/services/navigationHistory';

const build = (...paths: string[]) =>
  paths.reduce((h, p) => pushEntry(h, p), createHistory<string>());

describe('navigationHistory', () => {
  it('空历史不能前进也不能后退', () => {
    const h = createHistory<string>();
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
    expect(currentEntry(h)).toBeUndefined();
  });

  it('连续跳转后可以逐级后退', () => {
    let h = build('a.ts', 'b.ts', 'c.ts');
    expect(currentEntry(h)).toBe('c.ts');
    h = goBack(h);
    expect(currentEntry(h)).toBe('b.ts');
    h = goBack(h);
    expect(currentEntry(h)).toBe('a.ts');
    expect(canGoBack(h)).toBe(false);
  });

  it('后退之后可以再前进回去', () => {
    let h = goBack(build('a.ts', 'b.ts'));
    expect(currentEntry(h)).toBe('a.ts');
    h = goForward(h);
    expect(currentEntry(h)).toBe('b.ts');
    expect(canGoForward(h)).toBe(false);
  });

  it('在历史中间打开新文件会截断后面的分支', () => {
    let h = goBack(build('a.ts', 'b.ts', 'c.ts'));
    expect(currentEntry(h)).toBe('b.ts');
    h = pushEntry(h, 'd.ts');
    expect(h.entries).toEqual(['a.ts', 'b.ts', 'd.ts']);
    expect(canGoForward(h)).toBe(false);
  });

  it('重复打开同一文件不堆记录', () => {
    const once = build('a.ts', 'b.ts');
    const twice = pushEntry(once, 'b.ts');
    // 同一对象引用：调用方可以直接用它做 setState 前的相等性判断
    expect(twice).toBe(once);
    expect(twice.entries).toEqual(['a.ts', 'b.ts']);
  });

  it('超出上限时从最旧的一端丢弃', () => {
    const many = Array.from({ length: MAX_HISTORY_ENTRIES + 10 }, (_, i) => `f${i}.ts`);
    const h = build(...many);
    expect(h.entries).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(h.entries[0]).toBe('f10.ts');
    expect(currentEntry(h)).toBe(`f${MAX_HISTORY_ENTRIES + 9}.ts`);
  });

  it('到达两端时后退/前进是空操作', () => {
    const atStart = build('a.ts');
    expect(goBack(atStart)).toBe(atStart);
    const atEnd = build('a.ts', 'b.ts');
    expect(goForward(atEnd)).toBe(atEnd);
  });
});
