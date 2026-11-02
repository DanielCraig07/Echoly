import { describe, expect, it } from 'vitest';
import { RRF_K, cosineSimilarity, rrfFuse, topKBySimilarity } from '../src/retrieval.js';

describe('cosineSimilarity', () => {
  it('同向为 1，正交为 0，反向为 -1', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('与向量长度无关，只看方向', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  it('维度不一致时抛错，而不是静默返回 0', () => {
    // 这是本层最重要的一条：静默返回 0 会让所有块相似度相同、排序退化成文件顺序，
    // 搜索「看起来在工作」但结果全无关，且没有任何报错可查。
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(/维度不一致/);
  });

  it('空向量抛错', () => {
    expect(() => cosineSimilarity([], [])).toThrow(/空向量/);
  });

  it('零向量返回 0 而不是 NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('topKBySimilarity', () => {
  const chunks = [
    { id: 'a', vector: [1, 0] },
    { id: 'b', vector: [0.9, 0.1] },
    { id: 'c', vector: [0, 1] },
  ];

  it('按相似度取前 k 个', () => {
    const result = topKBySimilarity([1, 0], chunks, 2);
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it('k 小于等于 0 时返回空', () => {
    expect(topKBySimilarity([1, 0], chunks, 0)).toEqual([]);
  });

  it('任一块维度不符时整体返回空，交由上层回落到 BM25', () => {
    const mixed = [...chunks, { id: 'bad', vector: [1, 2, 3] }];
    expect(topKBySimilarity([1, 0], mixed, 3)).toEqual([]);
  });
});

describe('rrfFuse', () => {
  it('单路召回保持原有名次', () => {
    const fused = rrfFuse([['a', 'b', 'c']]);
    expect(fused.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(fused[0].score).toBeCloseTo(1 / (RRF_K + 1));
  });

  it('两路都命中的排到只在一路靠前的之前', () => {
    const fused = rrfFuse([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    // a 与 b 名次互换，得分相同，按 id 稳定排序
    expect(fused.map((f) => f.id)).toEqual(['a', 'b']);

    const boost = rrfFuse([
      ['x', 'y'],
      ['z', 'y'],
    ]);
    // y 出现在两路中（名次 2 与 2），x 与 z 各只出现一次且名次 1
    expect(boost.map((f) => f.id)).toEqual(['y', 'x', 'z']);
  });

  it('同一条排名里重复的 id 只计一次', () => {
    const fused = rrfFuse([['a', 'a', 'b']]);
    const a = fused.find((f) => f.id === 'a')!;
    expect(a.score).toBeCloseTo(1 / (RRF_K + 1));
  });

  it('空输入返回空数组', () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[]])).toEqual([]);
  });

  it('结果可复现：分数相同时按 id 排序', () => {
    const first = rrfFuse([['b'], ['a']]).map((f) => f.id);
    const second = rrfFuse([['a'], ['b']]).map((f) => f.id);
    expect(first).toEqual(second);
  });
});
