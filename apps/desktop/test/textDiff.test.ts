import { describe, expect, it } from 'vitest';
import {
  computeLineDiffs,
  computeInlineHunks,
  computeLineSimilarity,
  computeLineTokenDiff,
} from '../src/renderer/src/services/textDiff';

/**
 * 从 `EditorPane.tsx` 拆出来的差异算法，终于能直接被测。
 *
 * 这组用例的存在理由是**行号**：gutter 上那个小色条、diff 视图里每一块的定位
 * 全靠 `startLine` / `endLine`。行号差一不会抛错，只是标记画在隔壁行 ——
 * 对着屏幕盯很久也未必发现，所以每条都用绝对行号断言。
 */

describe('computeLineDiffs', () => {
  const text = (...lines: string[]) => lines.join('\n');

  it('无改动时返回空', () => {
    expect(computeLineDiffs(text('a', 'b'), text('a', 'b'))).toEqual([]);
  });

  it('中间改一行报 modified 且行号从 1 起算', () => {
    expect(computeLineDiffs(text('a', 'b', 'c'), text('a', 'B', 'c'))).toEqual([
      { type: 'modified', startLine: 2, endLine: 2 },
    ]);
  });

  it('末尾追加报 added，覆盖新增的每一行', () => {
    expect(computeLineDiffs(text('a'), text('a', 'b', 'c'))).toEqual([
      { type: 'added', startLine: 2, endLine: 3 },
    ]);
  });

  it('整段删除报 deleted，且行号不小于 1', () => {
    const diffs = computeLineDiffs(text('a', 'b', 'c'), text('a'));
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe('deleted');
    expect(diffs[0].startLine).toBeGreaterThanOrEqual(1);
  });

  it('空文件变成有内容算纯新增', () => {
    expect(computeLineDiffs('', text('a', 'b'))).toEqual([
      { type: 'added', startLine: 1, endLine: 2 },
    ]);
  });

  it('清空文件算纯删除，而不是「第 1 行被修改」', () => {
    // 空文本必须切成**零行**：`''.split('\n')` 会给出 `['']`（一行空行），
    // 于是「纯删除」分支永远进不去，清空一个文件会被报成改了一行。
    expect(computeLineDiffs(text('a', 'b'), '')).toEqual([
      { type: 'deleted', startLine: 1, endLine: 1 },
    ]);
  });

  it('忽略 CRLF 与 LF 的差异', () => {
    // Windows 上检出、macOS 上编辑会让整个文件看起来「全改了」，
    // gutter 上一片黄条其实什么都没改。
    expect(computeLineDiffs('a\r\nb\r\n', 'a\nb\n')).toEqual([]);
  });

  it('不相邻的两处改动各报一块', () => {
    const diffs = computeLineDiffs(text('a', 'b', 'c', 'd', 'e'), text('A', 'b', 'c', 'd', 'E'));
    expect(diffs).toHaveLength(2);
    expect(diffs[0].startLine).toBe(1);
    expect(diffs[1].startLine).toBe(5);
  });
});

describe('computeInlineHunks', () => {
  it('把改动切成 hunk，并给出两侧行号范围', () => {
    const { hunks } = computeInlineHunks('a\nb\nc\nd', 'a\nB\nc\nd');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].id).toBe(1);
    expect(hunks[0].dels.map((d) => d.text)).toEqual(['b']);
    expect(hunks[0].adds.map((d) => d.text)).toEqual(['B']);
    expect(hunks[0].startOrigLine).toBe(2);
    expect(hunks[0].endOrigLine).toBe(2);
  });

  it('ops 覆盖两侧全部行，且 same 行两侧行号都有', () => {
    const { ops } = computeInlineHunks('a\nb', 'a\nb\nc');
    expect(ops.map((o) => o.type)).toEqual(['same', 'same', 'add']);
    expect(ops[0]).toMatchObject({ origNum: 1, modNum: 1 });
    expect(ops[2]).toMatchObject({ modNum: 3 });
    expect(ops[2].origNum).toBeUndefined();
  });

  it('插入与删除混在一起时算同一个 hunk', () => {
    const { hunks } = computeInlineHunks('a\nb\nc', 'a\nx\nc');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].startModLine).toBe(2);
    expect(hunks[0].endModLine).toBe(2);
  });

  it('无改动时没有 hunk，但 ops 仍列出所有行', () => {
    const { ops, hunks } = computeInlineHunks('a\nb', 'a\nb');
    expect(hunks).toEqual([]);
    expect(ops).toHaveLength(2);
  });
});

describe('computeLineSimilarity', () => {
  it('完全相同为 1，其中一侧为空为 0', () => {
    expect(computeLineSimilarity('abc', 'abc')).toBe(1);
    expect(computeLineSimilarity('', 'abc')).toBe(0);
  });

  it('仅首尾空白不同给高分但不给满分', () => {
    // 给 1 会让「只是缩进变了」被当成没变，行内 diff 就不标了。
    expect(computeLineSimilarity('  abc', 'abc')).toBeGreaterThan(0.9);
    expect(computeLineSimilarity('  abc', 'abc')).toBeLessThan(1);
  });

  it('公共前缀越长越相似', () => {
    expect(computeLineSimilarity('const a = 1', 'const a = 2')).toBeGreaterThan(
      computeLineSimilarity('const a = 1', 'let b = 2'),
    );
  });
});

describe('computeLineTokenDiff', () => {
  it('只把变化的 token 标成 isDiff', () => {
    const { partsOld, partsNew } = computeLineTokenDiff('const a = 1;', 'const a = 2;');
    expect(partsOld.map((p) => p.text).join('')).toBe('const a = 1;');
    expect(partsNew.map((p) => p.text).join('')).toBe('const a = 2;');
    // 拼接必须无损：这些片段要原样回填到 diff 视图里
    expect(partsOld.filter((p) => p.isDiff).map((p) => p.text)).toEqual(['1']);
    expect(partsNew.filter((p) => p.isDiff).map((p) => p.text)).toEqual(['2']);
  });

  it('相邻同类片段会合并，避免 React 反复重建节点', () => {
    const { partsNew } = computeLineTokenDiff('a', 'a b c');
    const diffs = partsNew.filter((p) => p.isDiff);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].text).toBe(' b c');
  });

  it('一侧为空时整体标为 diff', () => {
    expect(computeLineTokenDiff('', 'abc')).toEqual({
      partsOld: [],
      partsNew: [{ text: 'abc', isDiff: true }],
    });
  });

  it('两侧都为空时返回空数组而不是一个空片段', () => {
    expect(computeLineTokenDiff('', '')).toEqual({ partsOld: [], partsNew: [] });
  });
});
