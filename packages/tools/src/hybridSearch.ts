/**
 * 双路召回的编排层：向量粗排 → BM25 精排 → RRF 融合。
 *
 * 这是 B1 的最后一块拼图：`retrieval.ts` 给的是纯数学（相似度 / RRF），
 * `embeddingSource.ts` / `embedding.ts` 给的是「怎么把文本变成向量」，
 * 而这里决定的是**两路怎么合、以及任何一路失效时怎么办**。
 *
 * 单独拆成纯函数（不碰文件系统、不碰模型）的理由和 `retrieval.ts` 一样：
 * 融合策略错的时候，搜索结果**看起来仍然合理**——只是排序悄悄变差，
 * 靠手动试用发现不了。把它抽出来才测得住。
 *
 * 一条贯穿始终的设计原则：**任何单路失败都降级到另一路，绝不整体失败。**
 * 语义检索是增强项，向量不可用时检索应当照常返回 BM25 结果，
 * 只是带上 `reason` 说明为什么没走语义——否则「为什么搜得不准」无从查起。
 */

import { RRF_K, rrfFuse, topKBySimilarity } from './retrieval.js';

/** 参与融合的块。没有向量的块只可能出现在 BM25 一路。 */
export interface HybridChunk {
  id: string;
  vector?: readonly number[] | null;
}

export interface HybridRetrieveInput {
  /** 查询向量；缺失或为空时直接走纯 BM25 */
  queryVector?: readonly number[] | null;
  /** 索引里的全部候选块（含向量，若已建好） */
  chunks: readonly HybridChunk[];
  /** BM25 一路的名次（已按相关性从高到低排序，只用名次不用分数） */
  bm25Ranking: readonly string[];
  /** 最终返回条数 */
  limit?: number;
  /** 向量一路的召回条数；比最终条数大得多，给 BM25 精排留出融合空间 */
  vectorTopK?: number;
  /** 自定义 RRF 常数（仅测试用，正常走 RRF_K） */
  rrfK?: number;
}

export interface HybridRetrieveResult {
  /** 融合后的 id 列表，按相关性从高到低 */
  ids: string[];
  /** 是否真的用上了向量一路。false 表示已降级为纯 BM25 */
  usedVector: boolean;
  /** 降级原因（usedVector 为 false 时给出），用于日志与排查 */
  reason?: string;
}

/** 向量粗排默认召回的条数。50 是「足够宽」与「计算量可控」之间的经验折中。 */
export const DEFAULT_VECTOR_TOPK = 50;

/**
 * 融合两路召回，返回最终排序。
 *
 * 走向量的条件是「有查询向量 + 索引里至少有一块带向量 + 维度能对上」。
 * 三者缺一就回落到纯 BM25，并给出可读原因。注意向量一路的召回为空时
 * **不能**把空名次列表喂给 RRF——那样两路都会因为「只在 BM25 出现」而
 * 分数一致，等于白算一遍。
 */
export function hybridRetrieve(input: HybridRetrieveInput): HybridRetrieveResult {
  const limit = input.limit ?? 20;
  if (limit <= 0) {
    return { ids: [], usedVector: false, reason: 'limit 为 0，无需求' };
  }

  const bm25Only = (reason: string): HybridRetrieveResult => ({
    ids: input.bm25Ranking.slice(0, limit),
    usedVector: false,
    reason,
  });

  const queryVector = input.queryVector;
  if (!queryVector || queryVector.length === 0) {
    return bm25Only('无查询向量，使用 BM25 词法检索');
  }

  // 只把带向量的块送进粗排。缺向量的块仍可经 BM25 一路进入结果。
  const vectorChunks = input.chunks.filter(
    (c): c is HybridChunk & { vector: readonly number[] } =>
      Array.isArray(c.vector) && c.vector.length > 0,
  );
  if (vectorChunks.length === 0) {
    return bm25Only('索引中暂无向量，使用 BM25 词法检索');
  }

  const topK = input.vectorTopK ?? DEFAULT_VECTOR_TOPK;
  const scored = topKBySimilarity(queryVector, vectorChunks, topK);
  // topKBySimilarity 在维度不一致时整体返回空——这是唯一能落在这里的异常路径。
  if (scored.length === 0) {
    return bm25Only('向量维度不一致（可能混用了不同模型的向量），已回落到 BM25');
  }

  const vectorIds = scored.map((s) => s.id);
  const fused = rrfFuse([vectorIds, input.bm25Ranking], input.rrfK ?? RRF_K);
  return { ids: fused.slice(0, limit).map((s) => s.id), usedVector: true };
}
