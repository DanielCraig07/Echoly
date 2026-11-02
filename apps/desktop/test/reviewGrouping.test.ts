import { describe, expect, it } from 'vitest';
import type { PendingDiff } from '@deepseek-ide/shared';
import {
  groupDiffsByBatch,
  groupDiffsByFile,
  isNewFile,
  moveReviewFocus,
} from '../src/renderer/src/services/reviewGrouping';

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

/**
 * 批次分组与键盘导航。
 *
 * 批次的价值在于「连问三轮之后，还能只接受刚跑完那轮」—— 分组错了不会报错，
 * 只会让人以为自己接受了 A 轮而实际把 B 轮一起接受进去。
 */
describe('groupDiffsByBatch', () => {
  const withRun = (id: string, path: string, runId?: string): PendingDiff => ({
    id,
    path,
    original: 'a',
    modified: 'b',
    runId,
  });

  it('按轮次分批，**最新的排在最前**', () => {
    // 用户是在一轮跑完之后打开面板的，想看的首先是刚改完的东西
    const batches = groupDiffsByBatch([
      withRun('1', 'a.ts', 'run-1'),
      withRun('2', 'b.ts', 'run-2'),
      withRun('3', 'a.ts', 'run-2'),
    ]);
    expect(batches).toHaveLength(2);
    expect(batches[0].runId).toBe('run-2');
    expect(batches[1].runId).toBe('run-1');
  });

  it('标签按位置给（本轮 / 上一轮 / 更早），不暴露 runId', () => {
    const batches = groupDiffsByBatch([
      withRun('1', 'a.ts', 'r1'),
      withRun('2', 'b.ts', 'r2'),
      withRun('3', 'c.ts', 'r3'),
      withRun('4', 'd.ts', 'r4'),
    ]);
    expect(batches.map((b) => b.label)).toEqual(['latest', 'previous', 'older', 'older']);
  });

  it('没有轮次标记的旧数据归到一个 null 批次', () => {
    const batches = groupDiffsByBatch([withRun('1', 'a.ts'), withRun('2', 'b.ts', 'r2')]);
    expect(batches.map((b) => b.runId)).toEqual(['r2', null]);
    expect(batches[1].diffIds).toEqual(['1']);
  });

  it('批次内仍按文件分组，且带齐 diffIds', () => {
    const batches = groupDiffsByBatch([
      withRun('1', 'a.ts', 'r1'),
      withRun('2', 'a.ts', 'r1'),
      withRun('3', 'b.ts', 'r1'),
    ]);
    expect(batches[0].groups.map((g) => g.path)).toEqual(['a.ts', 'b.ts']);
    expect(batches[0].diffIds).toEqual(['1', '2', '3']);
  });

  it('空输入得到空数组', () => {
    expect(groupDiffsByBatch([])).toEqual([]);
  });
});

describe('moveReviewFocus', () => {
  it('J/K 逐项移动', () => {
    expect(moveReviewFocus(0, 1, 3)).toBe(1);
    expect(moveReviewFocus(1, -1, 3)).toBe(0);
  });

  it('两端截断，不循环（从末尾跳回开头会让人以为还有没看的）', () => {
    expect(moveReviewFocus(2, 1, 3)).toBe(2);
    expect(moveReviewFocus(0, -1, 3)).toBe(0);
  });

  it('还没选过时，J 从第一个开始、K 从最后一个开始', () => {
    expect(moveReviewFocus(-1, 1, 3)).toBe(0);
    expect(moveReviewFocus(-1, -1, 3)).toBe(2);
  });

  it('空列表返回 -1，调用方据此不做任何高亮', () => {
    expect(moveReviewFocus(-1, 1, 0)).toBe(-1);
    expect(moveReviewFocus(0, 1, 0)).toBe(-1);
  });
});
