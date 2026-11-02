import { describe, expect, it } from 'vitest';
import type { PendingDiff } from '@deepseek-ide/shared';
import { groupDiffsByFile, isNewFile } from '../src/renderer/src/services/reviewGrouping';

const diff = (id: string, path: string, original = 'a', modified = 'b'): PendingDiff => ({
  id,
  path,
  original,
  modified,
});

describe('groupDiffsByFile', () => {
  it('把同一文件的多条改动聚成一组', () => {
    const groups = groupDiffsByFile([
      diff('1', 'src/a.ts'),
      diff('2', 'src/b.ts'),
      diff('3', 'src/a.ts'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ path: 'src/a.ts', diffIds: ['1', '3'], hasNewFile: false });
    expect(groups[1].diffIds).toEqual(['2']);
  });

  it('顺序取首次出现的次序，而不是字母序', () => {
    const groups = groupDiffsByFile([diff('1', 'z.ts'), diff('2', 'a.ts')]);
    expect(groups.map((g) => g.path)).toEqual(['z.ts', 'a.ts']);
  });

  it('路径大小写与斜杠方向不同仍归为一组', () => {
    const groups = groupDiffsByFile([diff('1', 'src/A.ts'), diff('2', 'src\\a.ts')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].diffIds).toEqual(['1', '2']);
    // 展示用的路径保留首次出现的原始写法
    expect(groups[0].path).toBe('src/A.ts');
  });

  it('组内只要有一条是新建文件，整组标记为含新建', () => {
    const groups = groupDiffsByFile([
      diff('1', 'src/new.ts', '', '内容'),
      diff('2', 'src/new.ts', '旧', '新'),
    ]);
    expect(groups[0].hasNewFile).toBe(true);
  });

  it('空输入返回空数组', () => {
    expect(groupDiffsByFile([])).toEqual([]);
  });
});

describe('isNewFile', () => {
  it('original 为空且 modified 非空算新建', () => {
    expect(isNewFile(diff('1', 'a.ts', '', 'x'))).toBe(true);
  });

  it('清空文件内容不算新建', () => {
    expect(isNewFile(diff('1', 'a.ts', 'x', ''))).toBe(false);
  });

  it('普通修改不算新建', () => {
    expect(isNewFile(diff('1', 'a.ts', 'x', 'y'))).toBe(false);
  });
});
