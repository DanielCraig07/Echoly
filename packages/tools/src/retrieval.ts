/**
 * 检索融合的纯逻辑层：向量相似度与 RRF 排序融合。
 *
 * 背景：`codebase_search` 目前只有 BM25 词法检索，问「在哪里刷新 token」这类语义问题
 * 答不了。补语义召回的做法是**双路召回**：向量粗排拿语义相近的块，再用现有 BM25 精排
 * 把字面匹配的块提上来，最后按 RRF 融合两边的名次。
 *
 * 为什么把这一层单独拆出来：它不依赖模型、不依赖文件系统，却决定了最终结果好不好。
 * 而它最容易出的错是**静默退化**——见 `cosineSimilarity` 的维度校验。
 */

/**
 * 余弦相似度。
 *
 * **维度不一致时抛错，而不是返回 0 或按短的截断。** 这是这一层最重要的一条约束：
 * 换 embedding 模型、模型文件下载不完整、缓存里残留旧模型的向量，都会造成维度不匹配。
 * 此时若静默返回 0，所有块的相似度就都一样，排序退化成文件顺序——搜索「看起来在工作」，
 * 结果全是无关的，而且没有任何报错可查。宁可让调用方拿到异常去回落到 BM25。
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`向量维度不一致：${a.length} vs ${b.length}（可能混用了不同模型的向量）`);
  }
  if (a.length === 0) throw new Error('空向量无法计算相似度');

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface ScoredChunk {
  id: string;
  score: number;
}

/**
 * 向量粗排：返回相似度最高的前 k 个。
 *
 * 维度不一致时**整体返回空数组**而不是抛错——粗排只是召回的一路，
 * 它失效时上层应当静默回落到 BM25，不该让整个搜索报错。
 */
export function topKBySimilarity(
  query: readonly number[],
  chunks: readonly { id: string; vector: readonly number[] }[],
  k: number,
): ScoredChunk[] {
  if (k <= 0) return [];

  const scored: ScoredChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.vector.length !== query.length) return [];
    scored.push({ id: chunk.id, score: cosineSimilarity(query, chunk.vector) });
  }

  return scored.sort((x, y) => y.score - x.score).slice(0, k);
}

/** RRF 的标准常数，出自原论文；60 是经验值，对名次差异的惩罚比较平缓。 */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion：把多路召回的**名次**融合成一个排序。
 *
 * 用名次而不是分数，是因为向量相似度（-1..1）与 BM25 分数（无量纲、随语料变化）
 * 根本不在同一个尺度上，直接加权求和需要先做归一化，而归一化本身又会随语料漂移。
 * RRF 绕开了这个问题：只看「排第几」。
 *
 * 单路命中记为 1/(k + rank)，多路命中自然叠加——所以同时被两路召回的块会排到前面，
 * 这正是融合想要的：字面匹配 + 语义相近的块，比只在其中一路靠前的更可信。
 */
export function rrfFuse(
  rankings: readonly (readonly string[])[],
  k: number = RRF_K,
): ScoredChunk[] {
  const scores = new Map<string, number>();

  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      // 名次从 1 开始；同一条排名里重复出现的 id 只计首次，避免自造权重
      if (ranking.indexOf(id) !== index) return;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }

  return Array.from(scores, ([id, score]) => ({ id, score })).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : 1; // 分数相同时按 id 稳定排序，保证结果可复现
  });
}
