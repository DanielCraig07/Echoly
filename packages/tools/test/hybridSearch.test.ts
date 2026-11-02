import { describe, expect, it } from 'vitest';
import { DEFAULT_VECTOR_TOPK, hybridRetrieve } from '../src/hybridSearch.js';

/**
 * 双路召回编排。要紧的是**降级行为**：向量一路失效时必须静默回落到 BM25，
 * 而不是整体返回空——否则语义索引没建好时，搜索会直接从「搜得不准」变成「搜不出来」。
 */

/** 三个块，向量维度 2，便于手算相似度。 */
const chunks = [
  { id: 'a', vector: [1, 0] },
  { id: 'b', vector: [0, 1] },
  { id: 'c', vector: [1, 1] },
];

describe('hybridRetrieve', () => {
  it('无查询向量时回落到纯 BM25，并给出原因', () => {
    const out = hybridRetrieve({
      queryVector: null,
      chunks,
      bm25Ranking: ['c', 'a', 'b'],
      limit: 2,
    });
    expect(out.usedVector).toBe(false);
    expect(out.ids).toEqual(['c', 'a']);
    expect(out.reason).toMatch(/无查询向量/);
  });

  it('索引里没有任何向量时回落到 BM25', () => {
    const out = hybridRetrieve({
      queryVector: [1, 0],
      chunks: [{ id: 'a' }, { id: 'b' }],
      bm25Ranking: ['b', 'a'],
    });
    expect(out.usedVector).toBe(false);
    expect(out.ids).toEqual(['b', 'a']);
    expect(out.reason).toMatch(/暂无向量/);
  });

  it('维度不一致时回落到 BM25，而不是返回空', () => {
    // 混用不同模型的向量是最容易发生的静默故障；这里必须整批放弃向量一路。
    const out = hybridRetrieve({
      queryVector: [1, 0, 0],
      chunks,
      bm25Ranking: ['a', 'b', 'c'],
    });
    expect(out.usedVector).toBe(false);
    expect(out.ids).toEqual(['a', 'b', 'c']);
    expect(out.reason).toMatch(/维度不一致/);
  });

  it('两路都命中时融合排序，两路共有的块排最前', () => {
    // 查询 [1,1] 与 c 完全同向 → 向量路名次 c,a,b；BM25 路名次 c,b,a。
    // c 在两路都排第一，融合后必然最前 —— 这正是 RRF 想要的：两路共识优先。
    const out = hybridRetrieve({
      queryVector: [1, 1],
      chunks,
      bm25Ranking: ['c', 'b', 'a'],
    });
    expect(out.usedVector).toBe(true);
    expect(out.ids[0]).toBe('c');
    expect(out.ids).toHaveLength(3);
    expect(new Set(out.ids)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('limit 截断最终结果，但不影响融合过程', () => {
    const out = hybridRetrieve({
      queryVector: [1, 0],
      chunks,
      bm25Ranking: ['c', 'b', 'a'],
      limit: 1,
    });
    expect(out.ids).toHaveLength(1);
    expect(out.ids[0]).toBe('c');
  });

  it('limit 为 0 时返回空且不走任何一路', () => {
    const out = hybridRetrieve({
      queryVector: [1, 0],
      chunks,
      bm25Ranking: ['a'],
      limit: 0,
    });
    expect(out.ids).toEqual([]);
    expect(out.usedVector).toBe(false);
  });

  it('只有向量、BM25 无结果时仍能返回语义召回', () => {
    const out = hybridRetrieve({
      queryVector: [0, 1],
      chunks,
      bm25Ranking: [],
      limit: 2,
    });
    expect(out.usedVector).toBe(true);
    // 查询 [0,1] 与 b 完全同向 → b 应排第一
    expect(out.ids[0]).toBe('b');
  });

  it('没有向量的块仍可经 BM25 一路进入结果', () => {
    const withMissing = [
      { id: 'a', vector: [1, 0] },
      { id: 'x' }, // 无向量
    ];
    const out = hybridRetrieve({
      queryVector: [1, 0],
      chunks: withMissing,
      bm25Ranking: ['x', 'a'],
    });
    expect(out.usedVector).toBe(true);
    expect(out.ids).toContain('x');
  });

  it('默认向量召回宽度是 50', () => {
    expect(DEFAULT_VECTOR_TOPK).toBe(50);
  });
});
